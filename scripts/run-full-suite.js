// Full round-trip E2E test suite: Fabric → EVM → Fabric (ACK)
// Builds ACK xmsg directly from EVM receipt, no dependency on EVM listener.
// Usage: node scripts/run-full-suite.js

const { execSync } = require('child_process');
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { readJSON, writeJSON, ensureRuntime } = require('../shared/utils');
const { buildXmsgFromEvmEvent } = require('../proof-builder/evm-proof-builder');

ensureRuntime();

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const TEST_DATA = path.join(__dirname, '..', 'test-data', 'fabric-real-cases.json');
const PAYLOAD_PATH = path.join(RUNTIME_DIR, 'test-payload.json');

const TEE_URL = 'http://127.0.0.1:9000';
const EVM_RPC = 'http://127.0.0.1:8545';
const PRIV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEPLOYMENT = readJSON('deployment.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function invokeFabricChaincode(payloadObj) {
  fs.writeFileSync(PAYLOAD_PATH, JSON.stringify(payloadObj));
  const cmd = `docker exec fabric-tools bash /fabric-network/fabric-network/scripts/invoke-xcall.sh --payload-file /fabric-network/runtime/test-payload.json 2>&1`;
  let output;
  try {
    output = execSync(cmd, { encoding: 'utf8', timeout: 20000, maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    output = (e.stdout || '') + '\n' + (e.stderr || '');
  }
  const txMatch = output.match(/txId[^a-f0-9]*([a-f0-9]{64})/i);
  return txMatch ? txMatch[1] : null;
}

async function waitForXmsg(txId, timeoutMs = 30000) {
  const xmsgPath = path.join(RUNTIME_DIR, 'latest-xmsg.json');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(500);
    if (!fs.existsSync(xmsgPath)) continue;
    const xmsg = fs.readJsonSync(xmsgPath);
    if (xmsg.txId === txId && xmsg.blsProof) return xmsg;
  }
  throw new Error(`Timeout waiting for xmsg with txId ${txId}`);
}

async function teeAttest(xmsg) {
  const resp = await axios.post(`${TEE_URL}/attest`, { xmsg, blsProof: xmsg.blsProof }, { timeout: 15000 });
  return resp.data;
}

async function relayForwardToEvm(xmsg) {
  const attestation = await teeAttest(xmsg);
  if (!attestation.teeReport.blsValid) throw new Error('BLS verification failed');

  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet = new ethers.Wallet(PRIV_KEY, provider);
  const deployer = new ethers.NonceManager(wallet);
  const vsIdBytes32 = ethers.keccak256(ethers.toUtf8Bytes(attestation.validatorSetId));

  const verifierV2Abi = [
    'function registerTEE(address tee) external',
    'function teeWhitelist(address tee) view returns (bool)',
    'function submit((uint8,bytes32,bytes32,bytes32,bytes32,address,bytes,bytes32,uint64,bytes,bytes,uint64),bytes32,bytes,address,bytes32) external',
    'function registerValidatorSet(bytes32,uint16,bytes[]) external',
    'function validatorSetExists(bytes32) view returns (bool)',
  ];
  const verifier = new ethers.Contract(DEPLOYMENT.verifierContractV2, verifierV2Abi, deployer);

  if (!(await verifier.teeWhitelist(attestation.teePubKey))) {
    const tx = await verifier.registerTEE(attestation.teePubKey); await tx.wait();
  }
  if (!(await verifier.validatorSetExists(vsIdBytes32))) {
    const pubkeys = xmsg.blsProof.validatorBlsPubkeys || [];
    const tx = await verifier.registerValidatorSet(vsIdBytes32, xmsg.blsProof.threshold, pubkeys);
    await tx.wait();
  }

  const tx = await verifier.submit(
    [xmsg.version, xmsg.requestID, xmsg.srcChainID, xmsg.dstChainID, xmsg.srcEmitter,
     xmsg.dstContract, xmsg.payload, xmsg.payloadHash, xmsg.srcHeight,
     ethers.toUtf8Bytes(xmsg.eventProof), ethers.toUtf8Bytes(xmsg.finalityInfo), xmsg.nonce],
    attestation.reportHash, attestation.teeSig, attestation.teePubKey, vsIdBytes32
  );
  const receipt = await tx.wait();
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() };
}

async function buildAckArtifacts(relayTxHash) {
  // Build ACK xmsg directly from EVM receipt (no dependency on listener)
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const receipt = await provider.getTransactionReceipt(relayTxHash);
  if (!receipt) throw new Error(`Receipt not found for relay tx ${relayTxHash}`);

  const targetInterface = new ethers.Interface([
    'event BusinessExecuted(bytes32 indexed requestID,address indexed caller,string op,string recordId,string actor,string amount,bool requireAck)'
  ]);

  const targetLog = receipt.logs.find(log => {
    if (ethers.getAddress(log.address) !== ethers.getAddress(DEPLOYMENT.targetContract)) return false;
    try { targetInterface.parseLog(log); return true; } catch (_) { return false; }
  });

  if (!targetLog) throw new Error(`BusinessExecuted log not found in receipt ${relayTxHash}`);
  const parsed = targetInterface.parseLog(targetLog);
  if (!parsed.args.requireAck) return null; // No ACK needed

  const captured = {
    networkName: 'evm-localhost',
    emitterAddress: DEPLOYMENT.targetContract,
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
      listenerReceivedAtMs: Date.now(),
      listenerReceivedAt: new Date().toISOString()
    }
  };

  const xmsg = await buildXmsgFromEvmEvent({ deployment: DEPLOYMENT, ...captured });
  const ackPath = path.join(RUNTIME_DIR, 'latest-ack-xmsg.json');
  fs.writeJsonSync(ackPath, xmsg, { spaces: 2 });
  return { captured, xmsg };
}

async function relayAckToFabric() {
  const ackResultPath = path.join(RUNTIME_DIR, 'last-ack-to-fabric-result.json');
  try { fs.unlinkSync(ackResultPath); } catch (_) {}

  const cmd = `docker exec fabric-listener node //app/scripts/docker-ack-relay.js 2>&1`;

  try {
    const output = execSync(cmd, {
      encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, MSYS2_ARG_CONV_EXCL: '*' }
    });
    console.log('  ACK relay output:', output.slice(0, 300).replace(/\n/g, ' '));
  } catch (e) {
    console.log('  ACK relay stdout:', (e.stdout || '').slice(0, 500));
    if (e.stderr) console.log('  ACK relay stderr:', (e.stderr || '').slice(0, 500));
  }

  if (fs.existsSync(ackResultPath)) {
    return fs.readJsonSync(ackResultPath);
  }
  return null;
}

async function queryTargetState() {
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const targetAbi = [
    'function executionCount() view returns (uint256)', 'function historyCount() view returns (uint256)',
    'function lastRequestID() view returns (bytes32)', 'function lastOp() view returns (string)',
    'function lastRecordId() view returns (string)', 'function lastActor() view returns (string)',
    'function lastAmount() view returns (string)', 'function lastPayloadHash() view returns (bytes32)',
  ];
  const target = new ethers.Contract(DEPLOYMENT.targetContract, targetAbi, provider);
  return {
    executionCount: (await target.executionCount()).toString(),
    historyCount: (await target.historyCount()).toString(),
    lastRequestID: await target.lastRequestID(),
    lastOp: await target.lastOp(),
    lastRecordId: await target.lastRecordId(),
    lastActor: await target.lastActor(),
    lastAmount: await target.lastAmount(),
    lastPayloadHash: await target.lastPayloadHash(),
  };
}

function checkFields(expected, actual) {
  return {
    opMatch: actual.lastOp === expected.op,
    recordIdMatch: actual.lastRecordId === expected.recordId,
    actorMatch: actual.lastActor === expected.actor,
    amountMatch: actual.lastAmount === expected.amount,
  };
}

async function main() {
  console.log('=== Full Round-Trip E2E Test Suite (Fabric → EVM → Fabric) ===\n');
  console.log('Building ACK artifacts directly from EVM receipts (no listener dependency)\n');

  const testData = fs.readJsonSync(TEST_DATA);
  const cases = testData.cases;
  const results = [];
  let passCount = 0, failCount = 0;

  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i];
    const caseId = testCase.caseId;
    console.log(`[${i + 1}/${cases.length}] ${caseId}: ${testCase.description}`);
    console.log(`  Expected: op=${testCase.expectedTargetFields.op}, recordId=${testCase.expectedTargetFields.recordId}`);

    const caseResult = { caseId, description: testCase.description, expectedTargetFields: testCase.expectedTargetFields, pass: false };
    const caseStartedAt = Date.now();

    try {
      // [1] Invoke Fabric with requireAck=true
      console.log('  [1/6] Invoking chaincode (requireAck=true)...');
      const payload = { ...testCase.payload, requireAck: true };
      const txId = invokeFabricChaincode(payload);
      if (!txId) throw new Error('Failed to get txId');
      caseResult.txId = txId;
      console.log(`  txId: ${txId} (${Date.now() - caseStartedAt}ms)`);

      // [2] Wait for Fabric listener
      console.log('  [2/6] Waiting for Fabric→EVM xmsg...');
      const xmsg = await waitForXmsg(txId);
      caseResult.requestID = xmsg.requestID;
      caseResult.srcHeight = xmsg.srcHeight;
      caseResult.forwardProofMeta = xmsg.proofMeta;
      console.log(`  requestID: ${xmsg.requestID}, proofType: ${xmsg.proofMeta?.proofType}`);

      // [3] Relay Fabric → EVM
      console.log('  [3/6] Relaying Fabric → EVM...');
      const relayResult = await relayForwardToEvm(xmsg);
      caseResult.relayTxHash = relayResult.txHash;
      caseResult.forwardGasUsed = relayResult.gasUsed;
      console.log(`  relayTxHash: ${relayResult.txHash}, gas: ${relayResult.gasUsed}`);

      // [4] Build ACK artifacts from EVM receipt
      console.log('  [4/6] Building ACK artifacts from EVM receipt...');
      const ackArtifacts = await buildAckArtifacts(relayResult.txHash);
      if (!ackArtifacts) {
        caseResult.ackSkipped = true;
        console.log('  ACK skipped (requireAck=false in event)');
      } else {
        caseResult.ackRequestID = ackArtifacts.xmsg.requestID;
        caseResult.ackProofMeta = ackArtifacts.xmsg.proofMeta;
        console.log(`  ACK xmsg built, requestID: ${ackArtifacts.xmsg.requestID}, proofType: ${ackArtifacts.xmsg.proofMeta?.proofType}`);

        // [5] Relay ACK to Fabric
        console.log('  [5/6] Relaying ACK to Fabric...');
        const ackResult = await relayAckToFabric();
        caseResult.ackFabricResult = ackResult;
        console.log(`  Fabric ACK: ${ackResult?.fabricResult}`);
      }

      // [6] Verify EVM on-chain state
      console.log('  [6/6] Verifying on-chain state...');
      const targetState = await queryTargetState();
      caseResult.actualTargetState = targetState;
      caseResult.fieldCheck = checkFields(testCase.expectedTargetFields, targetState);

      const allFieldsMatch = Object.values(caseResult.fieldCheck).every(Boolean);
      const ackOk = caseResult.ackSkipped || (caseResult.ackFabricResult?.fabricResult?.includes('"ok":true'));
      caseResult.pass = allFieldsMatch && ackOk;

      caseResult.totalMs = Date.now() - caseStartedAt;

      console.log(`  EVM: op=${targetState.lastOp}, recordId=${targetState.lastRecordId}`);
      console.log(`  Fields: ${JSON.stringify(caseResult.fieldCheck)}, ACK: ${ackOk ? 'confirmed' : (caseResult.ackSkipped ? 'skipped' : 'FAILED')}`);
      console.log(`  Total: ${caseResult.totalMs}ms`);
      if (caseResult.pass) { console.log(`  ✅ ${caseId} PASSED\n`); passCount++; }
      else { console.log(`  ❌ ${caseId} FAILED\n`); failCount++; }

    } catch (error) {
      console.log(`  ❌ ${caseId} ERROR: ${error.message}\n`);
      caseResult.error = error.message;
      failCount++;
    }

    results.push(caseResult);

    const summary = {
      testType: 'full-roundtrip-e2e',
      dataset: 'test-data/fabric-real-cases.json',
      testedAt: new Date().toISOString(),
      total: cases.length, pass: passCount, fail: failCount,
      caseIds: cases.map(c => c.caseId),
      results,
    };
    writeJSON('fabric-full-roundtrip-results.json', summary);
    if (i < cases.length - 1) await sleep(2000);
  }

  console.log('='.repeat(60));
  console.log(`FINAL: ${passCount}/${cases.length} passed, ${failCount}/${cases.length} failed`);
  console.log('Results: runtime/fabric-full-roundtrip-results.json');
  for (const r of results) {
    const s = r.pass ? '✅' : '❌';
    const f = r.fieldCheck ? ` fields=${JSON.stringify(r.fieldCheck)}` : '';
    const e = r.error ? ` error=${r.error}` : '';
    console.log(`${s} ${r.caseId}${f}${e}`);
  }
}

main().catch(err => { console.error('Suite error:', err.message || err); process.exit(1); });
