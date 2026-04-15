const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');
const axios = require('axios');
const { Gateway, Wallets } = require('fabric-network');
const { buildXmsgFromEvmEvent } = require('../proof-builder/evm-proof-builder');

const LISTENER_POLL_INTERVAL_MS = 20;
const LISTENER_WAIT_TIMEOUT_MS = Number(process.env.FABRIC_LISTENER_WAIT_TIMEOUT_MS || 60000);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.readJsonSync(filePath);
  } catch (error) {
    // The listener may still be flushing the file when we poll; retry on the next tick.
    return null;
  }
}

function extractJsonFromText(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;

  const candidates = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (_) {
      // keep scanning
    }
  }
  return null;
}

function extractInvokePayload(text) {
  const match = String(text).match(/payload:"(\{.*\})"/);
  if (!match) {
    return null;
  }
  const normalized = match[1].replace(/\\"/g, '"');
  return JSON.parse(normalized);
}

function runCommandWithOutput(command, args, cwd) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe'
  });

  const combined = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (result.status !== 0) {
    throw new Error(combined || `${command} exited with code ${result.status}`);
  }
  return {
    output: combined,
    durationMs: Date.now() - startedAt
  };
}

async function syncTeeStateWithChain(projectRoot) {
  const deployment = fs.readJsonSync(path.join(projectRoot, 'runtime', 'deployment.json'));
  const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
  const verifier = new ethers.Contract(deployment.verifierContract, [
    'function lastCtr() view returns (uint64)',
    'function lastDigest() view returns (bytes32)'
  ], provider);

  const ctr = Number(await verifier.lastCtr());
  const lastDigest = await verifier.lastDigest();
  await axios.post('http://127.0.0.1:9000/rollback', { ctr, lastDigest }, { timeout: 10000 });
  return { ctr, lastDigest };
}

async function waitForCapturedEvent(projectRoot, txId, timeoutMs = LISTENER_WAIT_TIMEOUT_MS) {
  const capturedPath = path.join(projectRoot, 'runtime', 'fabric-captured-event.json');
  const xmsgPath = path.join(projectRoot, 'runtime', 'latest-xmsg.json');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const captured = tryReadJson(capturedPath);
    const xmsg = tryReadJson(xmsgPath);
    if (captured && xmsg && captured.txId === txId && xmsg.txId === txId) {
      return { captured, xmsg };
    }
    await sleep(LISTENER_POLL_INTERVAL_MS);
  }

  throw new Error(`Timed out waiting for listener output for txId ${txId}`);
}

function resolveListenerTiming(listenerResult, fallbackStartedAt, fallbackResolvedAt) {
  const processingMs = listenerResult?.xmsg?.listenerTiming?.processingMs;
  if (typeof processingMs === 'number' && Number.isFinite(processingMs)) {
    return processingMs;
  }

  const receivedAtMs = listenerResult?.captured?.listenerTiming?.listenerReceivedAtMs;
  const writtenAtMs = listenerResult?.xmsg?.listenerTiming?.xmsgWrittenAtMs;
  if (
    typeof receivedAtMs === 'number' &&
    typeof writtenAtMs === 'number' &&
    Number.isFinite(receivedAtMs) &&
    Number.isFinite(writtenAtMs) &&
    writtenAtMs >= receivedAtMs
  ) {
    return writtenAtMs - receivedAtMs;
  }

  return fallbackResolvedAt - fallbackStartedAt;
}

async function readTargetState(projectRoot) {
  const deployment = fs.readJsonSync(path.join(projectRoot, 'runtime', 'deployment.json'));
  const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
  const target = new ethers.Contract(deployment.targetContract, [
    'function executionCount() view returns (uint256)',
    'function historyCount() view returns (uint256)',
    'function lastOp() view returns (string)',
    'function lastRecordId() view returns (string)',
    'function lastActor() view returns (string)',
    'function lastAmount() view returns (string)',
    'function lastRequestID() view returns (bytes32)',
    'function lastPayloadHash() view returns (bytes32)'
  ], provider);

  return {
    executionCount: (await target.executionCount()).toString(),
    historyCount: (await target.historyCount()).toString(),
    lastOp: await target.lastOp(),
    lastRecordId: await target.lastRecordId(),
    lastActor: await target.lastActor(),
    lastAmount: await target.lastAmount(),
    lastRequestID: await target.lastRequestID(),
    lastPayloadHash: await target.lastPayloadHash()
  };
}

async function getFabricContract(projectRoot) {
  const profile = process.env.FABRIC_CONNECTION_PROFILE || path.join(projectRoot, 'fabric-network', 'connection-org1.json');
  const walletPath = process.env.FABRIC_WALLET_PATH || path.join(projectRoot, 'fabric-network', 'wallet');
  const identity = process.env.FABRIC_IDENTITY || 'appUser';
  const channel = process.env.FABRIC_CHANNEL || 'mychannel';
  const chaincode = process.env.FABRIC_CHAINCODE || 'xcall';
  const asLocalhost = process.env.FABRIC_AS_LOCALHOST !== 'false';

  const ccp = fs.readJsonSync(profile);
  const wallet = await Wallets.newFileSystemWallet(walletPath);
  const gateway = new Gateway();
  await gateway.connect(ccp, {
    wallet,
    identity,
    discovery: { enabled: true, asLocalhost }
  });
  const network = await gateway.getNetwork(channel);
  return {
    gateway,
    contract: network.getContract(chaincode)
  };
}

async function buildAckArtifacts(projectRoot, relayTxHash) {
  const deployment = fs.readJsonSync(path.join(projectRoot, 'runtime', 'deployment.json'));
  const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
  const receipt = await provider.getTransactionReceipt(relayTxHash);
  if (!receipt) {
    throw new Error(`Could not find EVM receipt for ACK relay tx ${relayTxHash}`);
  }

  const targetInterface = new ethers.Interface([
    'event BusinessExecuted(bytes32 indexed requestID,address indexed caller,string op,string recordId,string actor,string amount,bool requireAck)'
  ]);

  const targetLog = receipt.logs.find((log) => {
    if (ethers.getAddress(log.address) !== ethers.getAddress(deployment.targetContract)) {
      return false;
    }
    try {
      targetInterface.parseLog(log);
      return true;
    } catch (_) {
      return false;
    }
  });

  if (!targetLog) {
    throw new Error(`BusinessExecuted log not found in relay receipt ${relayTxHash}`);
  }

  const parsed = targetInterface.parseLog(targetLog);
  if (!parsed.args.requireAck) {
    return null;
  }
  const listenerReceivedAtMs = Date.now();
  const captured = {
    networkName: 'evm-localhost',
    emitterAddress: deployment.targetContract,
    eventName: 'BusinessExecuted',
    rawPayload: {
      op: 'ack_confirm',
      originRequestID: parsed.args.requestID,
      status: 'success',
      relayTxHash,
      targetOp: parsed.args.op,
      targetRecordId: parsed.args.recordId,
      targetActor: parsed.args.actor,
      targetAmount: parsed.args.amount,
      requireAck: false
    },
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    logIndex: Number(targetLog.index),
    nonce: Number(targetLog.index),
    dstChainName: 'fabric-mychannel',
    dstContract: ethers.ZeroAddress,
    listenerTiming: {
      listenerReceivedAtMs,
      listenerReceivedAt: new Date(listenerReceivedAtMs).toISOString()
    }
  };

  fs.writeJsonSync(path.join(projectRoot, 'runtime', 'evm-ack-captured-event.json'), captured, { spaces: 2 });
  const xmsg = await buildXmsgFromEvmEvent({
    deployment,
    ...captured
  });
  const xmsgWrittenAtMs = Date.now();
  xmsg.listenerTiming = {
    ...captured.listenerTiming,
    xmsgWrittenAtMs,
    xmsgWrittenAt: new Date(xmsgWrittenAtMs).toISOString(),
    processingMs: xmsgWrittenAtMs - listenerReceivedAtMs
  };
  fs.writeJsonSync(path.join(projectRoot, 'runtime', 'latest-ack-xmsg.json'), xmsg, { spaces: 2 });
  return { captured, xmsg };
}

async function readAckState(projectRoot, originRequestID) {
  const { gateway, contract } = await getFabricContract(projectRoot);
  try {
    const data = await contract.evaluateTransaction('GetAckStatus', originRequestID);
    const text = data.toString();
    return text ? JSON.parse(text) : null;
  } finally {
    gateway.disconnect();
  }
}

function parseCliArgs(argv) {
  const options = {
    datasetArg: 'test-data/fabric-real-cases.json',
    caseId: null,
    mode: 'forward'
  };

  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') {
      options.mode = argv[i + 1] || options.mode;
      i += 1;
      continue;
    }
    positional.push(arg);
  }

  if (positional[0]) options.datasetArg = positional[0];
  if (positional[1]) options.caseId = positional[1];
  return options;
}

function compareExpected(actual, expected) {
  return {
    opMatch: actual.lastOp === expected.op,
    recordIdMatch: actual.lastRecordId === expected.recordId,
    actorMatch: actual.lastActor === expected.actor,
    amountMatch: actual.lastAmount === expected.amount
  };
}

async function runCase(projectRoot, datasetPath, testCase, options = {}) {
  const mode = options.mode || 'forward';
  const withAck = mode === 'full';
  const caseStartedAt = Date.now();
  const tempPath = path.join(projectRoot, 'runtime', `fabric-suite-${testCase.caseId}.json`);
  const latestXmsgPath = path.join(projectRoot, 'runtime', 'latest-xmsg.json');
  const runtimePayload = {
    ...testCase.payload,
    requireAck: withAck ? true : Boolean(testCase.payload.requireAck)
  };
  fs.writeFileSync(tempPath, JSON.stringify(runtimePayload), 'utf8');

  try {
    const invokeStep = runCommandWithOutput('docker', [
      'compose',
      '-f',
      'docker-compose.fabric.yml',
      'run',
      '--rm',
      'fabric-tools',
      'bash',
      '/fabric-network/fabric-network/scripts/invoke-xcall.sh',
      '--payload-file',
      `/fabric-network/runtime/${path.basename(tempPath)}`
    ], projectRoot);

    const invokePayload = extractInvokePayload(invokeStep.output);
    if (!invokePayload?.txId) {
      throw new Error(`Could not parse txId from invoke output for ${testCase.caseId}`);
    }

    const listenerStartedAt = Date.now();
    const listenerResult = await waitForCapturedEvent(projectRoot, invokePayload.txId);
    const listenerResolvedAt = Date.now();
    const listenerDurationMs = resolveListenerTiming(
      listenerResult,
      listenerStartedAt,
      listenerResolvedAt
    );
    // Pin the relayer input to the exact XMsg we just validated from the listener.
    fs.writeJsonSync(latestXmsgPath, listenerResult.xmsg, { spaces: 2 });

    const teeSyncStartedAt = Date.now();
    const teeSync = await syncTeeStateWithChain(projectRoot);
    const teeSyncDurationMs = Date.now() - teeSyncStartedAt;

    const relayStartedAt = Date.now();
    const relayStdout = execFileSync(process.execPath, [
      path.join(projectRoot, 'relayer', 'index.js'),
      'normal'
    ], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: 'pipe'
    });
    const relayDurationMs = Date.now() - relayStartedAt;
    const relayResult = extractJsonFromText(relayStdout) || fs.readJsonSync(path.join(projectRoot, 'runtime', 'last-relay-result.json'));
    const targetState = await readTargetState(projectRoot);
    const fieldCheck = compareExpected(targetState, testCase.expectedTargetFields);
    let ackArtifacts = null;
    let ackRelayResult = null;
    let ackState = null;
    let ackCheck = null;
    let ackBuildDurationMs = 0;
    let ackRelayDurationMs = 0;

    if (withAck) {
      const ackStartedAt = Date.now();
      ackArtifacts = await buildAckArtifacts(projectRoot, relayResult.txHash);
      ackBuildDurationMs = Date.now() - ackStartedAt;
      if (ackArtifacts) {
        const ackRelayStartedAt = Date.now();
        const ackRelayStdout = execFileSync(process.execPath, [
          path.join(projectRoot, 'relayer', 'ack-to-fabric.js')
        ], {
          cwd: projectRoot,
          encoding: 'utf8',
          stdio: 'pipe'
        });
        ackRelayDurationMs = Date.now() - ackRelayStartedAt;
        ackRelayResult = extractJsonFromText(ackRelayStdout) || fs.readJsonSync(path.join(projectRoot, 'runtime', 'last-ack-to-fabric-result.json'));
        ackState = await readAckState(projectRoot, listenerResult.xmsg.requestID);
        ackCheck = {
          ackCreated: ackArtifacts.xmsg.payloadDecoded.op === 'ack_confirm',
          ackOriginMatch: ackState?.originRequestID === listenerResult.xmsg.requestID,
          ackStatusMatch: ackState?.status === 'success'
        };
      } else {
        ackCheck = {
          ackCreated: false,
          ackOriginMatch: false,
          ackStatusMatch: false
        };
      }
    }

    const pass = Object.values(fieldCheck).every(Boolean)
      && targetState.lastRequestID === listenerResult.xmsg.requestID
      && (!withAck || Object.values(ackCheck).every(Boolean));
    const totalDurationMs = Date.now() - caseStartedAt;
    const proofBuildMs = Number(listenerResult.xmsg.proofMeta?.proofBuildMs || 0);

    return {
      caseId: testCase.caseId,
      description: testCase.description,
      dataset: path.relative(projectRoot, datasetPath),
      txId: invokePayload.txId,
      requestID: listenerResult.xmsg.requestID,
      srcHeight: listenerResult.captured.blockNumber,
      relayTxHash: relayResult.txHash,
      gasUsed: relayResult.gasUsed,
      timingMs: {
        invoke: invokeStep.durationMs,
        listener: listenerDurationMs,
        proofBuild: proofBuildMs,
        teeSync: teeSyncDurationMs,
        relay: relayDurationMs,
        ackBuild: ackBuildDurationMs,
        ackRelay: ackRelayDurationMs,
        total: totalDurationMs
      },
      proofMeta: listenerResult.xmsg.proofMeta || null,
      teeSync,
      relayVerificationMeta: relayResult.verificationMeta || null,
      ackProofMeta: ackArtifacts?.xmsg?.proofMeta || null,
      ackRelayVerificationMeta: ackRelayResult?.verificationMeta || null,
      expectedTargetFields: testCase.expectedTargetFields,
      actualTargetState: targetState,
      fieldCheck,
      ackState,
      ackCheck,
      pass
    };
  } finally {
    fs.removeSync(tempPath);
  }
}

async function main() {
  const projectRoot = path.join(__dirname, '..');
  const cli = parseCliArgs(process.argv.slice(2));
  const datasetArg = cli.datasetArg;
  const caseId = cli.caseId;
  const mode = cli.mode === 'full' ? 'full' : 'forward';
  const datasetPath = path.resolve(projectRoot, datasetArg);

  if (!fs.existsSync(datasetPath)) {
    throw new Error(`Dataset file not found: ${datasetPath}`);
  }

  const dataset = fs.readJsonSync(datasetPath);
  const cases = caseId
    ? (dataset.cases || []).filter((item) => item.caseId === caseId)
    : (dataset.cases || []);

  if (cases.length === 0) {
    throw new Error(caseId ? `Case not found: ${caseId}` : 'No cases found in dataset');
  }

  const results = [];
  for (const testCase of cases) {
    console.log(`Running Fabric real case ${testCase.caseId} (${mode})`);
    const result = await runCase(projectRoot, datasetPath, testCase, { mode });
    results.push(result);
  }

  const summary = {
    dataset: dataset.dataset,
    total: results.length,
    pass: results.filter((item) => item.pass).length,
    fail: results.filter((item) => !item.pass).length,
    caseIds: results.map((item) => item.caseId),
    averageTimingMs: results.length > 0 ? {
      invoke: Number((results.reduce((sum, item) => sum + item.timingMs.invoke, 0) / results.length).toFixed(2)),
      listener: Number((results.reduce((sum, item) => sum + item.timingMs.listener, 0) / results.length).toFixed(2)),
      proofBuild: Number((results.reduce((sum, item) => sum + item.timingMs.proofBuild, 0) / results.length).toFixed(2)),
      teeSync: Number((results.reduce((sum, item) => sum + item.timingMs.teeSync, 0) / results.length).toFixed(2)),
      relay: Number((results.reduce((sum, item) => sum + item.timingMs.relay, 0) / results.length).toFixed(2)),
      ackBuild: Number((results.reduce((sum, item) => sum + item.timingMs.ackBuild, 0) / results.length).toFixed(2)),
      ackRelay: Number((results.reduce((sum, item) => sum + item.timingMs.ackRelay, 0) / results.length).toFixed(2)),
      total: Number((results.reduce((sum, item) => sum + item.timingMs.total, 0) / results.length).toFixed(2))
    } : null
  };

  const resultPath = path.join(
    projectRoot,
    'runtime',
    mode === 'full' ? 'fabric-real-ack-results.json' : 'fabric-real-results.json'
  );
  const summaryPath = path.join(
    projectRoot,
    'runtime',
    mode === 'full' ? 'fabric-real-ack-summary.md' : 'fabric-real-summary.md'
  );

  fs.writeJsonSync(resultPath, { summary, results }, { spaces: 2 });

  const lines = [
    mode === 'full'
      ? '# Fabric Real Mode ACK Test Summary'
      : '# Fabric Real Mode Test Summary',
    '',
    `- Dataset: \`${dataset.dataset}\``,
    `- Mode: \`${mode}\``,
    `- Total: \`${summary.total}\``,
    `- Pass: \`${summary.pass}\``,
    `- Fail: \`${summary.fail}\``,
    `- Avg Invoke: \`${summary.averageTimingMs?.invoke ?? 0} ms\``,
    `- Avg Listener: \`${summary.averageTimingMs?.listener ?? 0} ms\``,
    `- Avg ProofBuild: \`${summary.averageTimingMs?.proofBuild ?? 0} ms\``,
    `- Avg TeeSync: \`${summary.averageTimingMs?.teeSync ?? 0} ms\``,
    `- Avg Relay: \`${summary.averageTimingMs?.relay ?? 0} ms\``,
    `- Avg AckBuild: \`${summary.averageTimingMs?.ackBuild ?? 0} ms\``,
    `- Avg AckRelay: \`${summary.averageTimingMs?.ackRelay ?? 0} ms\``,
    `- Avg E2E: \`${summary.averageTimingMs?.total ?? 0} ms\``,
    '',
    mode === 'full'
      ? '| Case | Result | Proof | Ack Proof | RequestID | Relay Tx | Gas | Invoke ms | Listener ms | ProofBuild ms | TeeSync ms | Relay ms | AckBuild ms | AckRelay ms | E2E ms |'
      : '| Case | Result | Proof | RequestID | Relay Tx | Gas | Invoke ms | Listener ms | ProofBuild ms | TeeSync ms | Relay ms | E2E ms |',
    mode === 'full'
      ? '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
      : '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ];

  for (const item of results) {
    if (mode === 'full') {
      lines.push(`| ${item.caseId} | ${item.pass ? 'PASS' : 'FAIL'} | ${item.proofMeta?.proofType || 'unknown'} | ${item.ackProofMeta?.proofType || 'unknown'} | ${item.requestID} | ${item.relayTxHash} | ${item.gasUsed} | ${item.timingMs.invoke} | ${item.timingMs.listener} | ${item.timingMs.proofBuild} | ${item.timingMs.teeSync} | ${item.timingMs.relay} | ${item.timingMs.ackBuild} | ${item.timingMs.ackRelay} | ${item.timingMs.total} |`);
    } else {
      lines.push(`| ${item.caseId} | ${item.pass ? 'PASS' : 'FAIL'} | ${item.proofMeta?.proofType || 'unknown'} | ${item.requestID} | ${item.relayTxHash} | ${item.gasUsed} | ${item.timingMs.invoke} | ${item.timingMs.listener} | ${item.timingMs.proofBuild} | ${item.timingMs.teeSync} | ${item.timingMs.relay} | ${item.timingMs.total} |`);
    }
  }

  fs.writeFileSync(summaryPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
