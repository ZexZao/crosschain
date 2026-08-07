const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { loadDotEnv } = require('../shared/env');
const { encodeCompactBusinessCall } = require('../shared/xmsg');
const {
  bytes32FromText,
  chainIdToBytes32,
  hashJson,
  FeedbackType,
  AtomicityMode,
  CommitmentType,
} = require('../shared/hxmsg');
const { getValidatorSetRef } = require('../automation/shared/adapters/avalanche/proof-builder');
const { chainProfile } = require('../automation/config');
const { publishSourceMaterial, getWorkflow } = require('../automation/client');

loadDotEnv();

const ROOT = path.join(__dirname, '..');
const AUTOMATION_URL = String(process.env.AUTOMATION_URL || 'http://127.0.0.1:9200').replace(/\/$/, '');
const FEEDBACK_DELAY_SECONDS = Number(process.env.ROLLBACK_FEEDBACK_DELAY_SECONDS || 15);
const CHALLENGE_WINDOW_SECONDS = Number(process.env.ROLLBACK_CHALLENGE_WINDOW_SECONDS || 5);
const EXECUTE_COMPACT_SELECTOR = ethers.id(
  'executeCompact(bytes32,(uint16,bytes32,bytes32,address,int256,bytes32,bool))'
).slice(0, 10);
const TOKEN_ABI = [
  'function mint(address,uint256)',
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function authHeaders() {
  return process.env.AUTOMATION_API_KEY
    ? { authorization: `Bearer ${process.env.AUTOMATION_API_KEY}` }
    : {};
}

async function avalanchePolicyHash() {
  const { ref } = await getValidatorSetRef();
  return hashJson({ validatorSetRef: ref, canonicalOrdering: ref.canonicalOrdering });
}

async function waitForCompensation(requestID, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 120_000);
  const heartbeat = options.heartbeat;
  const deadline = Date.now() + timeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    if (heartbeat) await heartbeat();
    const workflow = await getWorkflow(requestID);
    const state = workflow?.watcherState || 'DISCOVERING';
    if (state !== lastState) {
      console.log(`WATCH requestID=${requestID} state=${state}`);
      lastState = state;
    }
    if (state === 'COMPENSATED') return workflow;
    if (['FAILED', 'CANCELLED'].includes(state)) throw new Error(`watcher ended in ${state}: ${requestID}`);
    await sleep(500);
  }
  throw new Error(`watcher compensation timeout: ${requestID}`);
}

async function workflowTasks(requestID) {
  const { data } = await axios.get(`${AUTOMATION_URL}/v1/tasks`, {
    params: { workflowID: requestID },
    headers: authHeaders(),
  });
  return data;
}

async function runDirection(sourceName, targetName) {
  const startedAt = Date.now();
  const sourceProfile = chainProfile(sourceName);
  const targetProfile = chainProfile(targetName);
  const sourceProvider = new ethers.JsonRpcProvider(sourceProfile.rpc);
  const targetProvider = new ethers.JsonRpcProvider(targetProfile.rpc);
  const sourceWallet = new ethers.Wallet(sourceProfile.privateKey, sourceProvider);
  const signer = new ethers.NonceManager(sourceWallet);
  const sourceAddress = sourceName === 'avalanche'
    ? sourceProfile.deployment.avalancheWarpSourceContract
    : sourceProfile.deployment.evmSourceContract;
  const sourceArtifactName = sourceName === 'avalanche'
    ? 'AvalancheWarpSourceContract'
    : 'EvmSourceContract';
  const sourceArtifact = fs.readJsonSync(path.join(
    ROOT,
    'artifacts',
    'contracts',
    `${sourceArtifactName}.sol`,
    `${sourceArtifactName}.json`
  ));
  const tokenArtifact = fs.readJsonSync(path.join(
    ROOT,
    'artifacts/contracts/CrossChainToken.sol/CrossChainToken.json'
  ));
  const source = new ethers.Contract(sourceAddress, sourceArtifact.abi, signer);
  const target = new ethers.Contract(
    targetProfile.deployment.targetContract,
    ['function executionCount() view returns (uint256)'],
    targetProvider
  );
  const tokenFactory = new ethers.ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, signer);
  const token = await tokenFactory.deploy(
    `Rollback ${sourceName} Token`,
    sourceName === 'avalanche' ? 'RAV' : 'RET',
    4,
    sourceWallet.address
  );
  const tokenDeploymentReceipt = await token.deploymentTransaction().wait();
  await token.waitForDeployment();
  const escrowAmount = 50000n;
  const mintReceipt = await (await token.mint(sourceWallet.address, escrowAmount)).wait();
  const targetExecutionBefore = await target.executionCount();
  const ownerBalanceBefore = await token.balanceOf(sourceWallet.address);
  const sourceEscrowBalanceBefore = await token.balanceOf(sourceAddress);
  const approvalReceipt = await (await token.approve(sourceAddress, escrowAmount)).wait();
  let heartbeatWallet = null;
  let heartbeatFundingReceipt = null;
  let heartbeatCount = 0;
  let heartbeatGas = 0;
  if (sourceName === 'avalanche') {
    heartbeatWallet = ethers.Wallet.createRandom().connect(sourceProvider);
    heartbeatFundingReceipt = await (await signer.sendTransaction({
      to: heartbeatWallet.address,
      value: ethers.parseEther('0.1'),
    })).wait();
  }
  const latest = await sourceProvider.getBlock('latest');
  const sourceNow = Math.max(Number(latest.timestamp), Math.floor(Date.now() / 1000));
  const feedbackTimeout = sourceNow + FEEDBACK_DELAY_SECONDS;
  const failureData = ethers.hexlify(ethers.toUtf8Bytes(`refund:${sourceName}:${targetName}:${Date.now()}`));
  const payload = {
    op: 'token_transfer',
    transferId: `ROLLBACK_${sourceName}_${targetName}_${Date.now()}`,
    assetType: 'XCST',
    targetRecipient: targetProfile.deployment.deployer,
    amount: '5',
    metadata: 'relayer outage challenge and real escrow rollback',
    requireAck: true,
  };
  const encoded = encodeCompactBusinessCall(payload);
  if (BigInt(encoded.compact.amount) !== escrowAmount) throw new Error('escrow amount encoding mismatch');
  const atomicity = {
    required: true,
    mode: AtomicityMode.COMMIT_OR_COMPENSATE,
    commitmentType: CommitmentType.TOKEN_ESCROW,
    commitmentRefHash: ethers.keccak256(ethers.toUtf8Bytes(`escrow:${payload.transferId}`)),
    successActionHash: ethers.keccak256(ethers.toUtf8Bytes(`settle:${payload.transferId}`)),
    failureActionHash: ethers.keccak256(failureData),
    challengeWindow: CHALLENGE_WINDOW_SECONDS,
  };
  const feedback = {
    required: true,
    expectedMsgType: FeedbackType.RESPONSE,
    timeout: feedbackTimeout,
    callbackRefHash: ethers.ZeroHash,
  };
  const policy = [
    true,
    FeedbackType.RESPONSE,
    feedbackTimeout,
    ethers.ZeroHash,
    [
      true,
      AtomicityMode.COMMIT_OR_COMPENSATE,
      CommitmentType.TOKEN_ESCROW,
      atomicity.commitmentRefHash,
      atomicity.successActionHash,
      atomicity.failureActionHash,
      CHALLENGE_WINDOW_SECONDS,
    ],
  ];
  await publishSourceMaterial(encoded.compactCallHash, {
    targetProfile: targetName,
    businessPayload: payload,
    feedback,
    atomicity,
    failureData,
  });
  const targetObject = ethers.zeroPadValue(targetProfile.deployment.targetContract, 32);
  let transaction;
  if (sourceName === 'avalanche') {
    transaction = await source.submitTokenEscrowWarpHXMsgRequest(
      chainIdToBytes32(targetProfile.deployment.chainId),
      bytes32FromText(`evm-local-${targetProfile.deployment.chainId}`),
      targetObject,
      EXECUTE_COMPACT_SELECTOR,
      encoded.payloadHex,
      hashJson(encoded.normalized),
      targetObject,
      sourceNow + 3600,
      await avalanchePolicyHash(),
      policy,
      await token.getAddress(),
      escrowAmount
    );
  } else {
    transaction = await source.submitTokenEscrowHXMsgRequest(
      chainIdToBytes32(targetProfile.deployment.chainId),
      bytes32FromText(`${targetName}-local-${targetProfile.deployment.chainId}`),
      targetObject,
      EXECUTE_COMPACT_SELECTOR,
      encoded.compactCallHash,
      hashJson(encoded.normalized),
      targetObject,
      sourceNow + 3600,
      policy,
      await token.getAddress(),
      escrowAmount
    );
  }
  const sourceReceipt = await transaction.wait();
  const eventName = sourceName === 'avalanche' ? 'AvalancheHXMsgWarpRequested' : 'CrossChainCallRequested';
  const event = sourceReceipt.logs.map((log) => {
    try { return source.interface.parseLog(log); } catch (_error) { return null; }
  }).find((item) => item?.name === eventName);
  if (!event) throw new Error(`${eventName} event missing`);
  const requestID = event.args.requestID;
  console.log(`SOURCE ${sourceName}->${targetName} requestID=${requestID} gas=${sourceReceipt.gasUsed}`);
  let nextHeartbeatAt = 0;
  const workflow = await waitForCompensation(requestID, {
    heartbeat: heartbeatWallet ? async () => {
      if (Date.now() < nextHeartbeatAt) return;
      const receipt = await (await heartbeatWallet.sendTransaction({
        to: heartbeatWallet.address,
        value: 0n,
      })).wait();
      heartbeatCount += 1;
      heartbeatGas += Number(receipt.gasUsed);
      nextHeartbeatAt = Date.now() + 2000;
    } : null,
  });
  const tasks = await workflowTasks(requestID);
  const watcherRegistration = tasks.find((task) => task.role === 'watcher-register');
  const watchTask = tasks.find((task) => task.role === 'watch');
  const relayerTask = tasks.find((task) => task.role === 'relayer-prepare');
  const [record, escrow, ownerBalanceAfter, sourceEscrowBalanceAfter, targetExecutionAfter] = await Promise.all([
    source.requests(requestID),
    source.tokenEscrows(requestID),
    token.balanceOf(sourceWallet.address),
    token.balanceOf(sourceAddress),
    target.executionCount(),
  ]);
  const challengeGas = Number(workflow.challengeResult?.gasUsed || 0);
  const compensationGas = Number(workflow.compensationResult?.gasUsed || 0);
  const protocolGasTotal = Number(sourceReceipt.gasUsed) + challengeGas + compensationGas;
  const pass = watcherRegistration?.status === 'completed'
    && watcherRegistration?.result?.registered === true
    && watchTask?.status === 'completed'
    && workflow.watcherState === 'COMPENSATED'
    && relayerTask?.status === 'pending'
    && Number(record.status) === 4
    && escrow.refunded === true
    && escrow.settled === false
    && ownerBalanceAfter === ownerBalanceBefore
    && sourceEscrowBalanceAfter === sourceEscrowBalanceBefore
    && targetExecutionAfter === targetExecutionBefore;
  return {
    direction: `${sourceName}-to-${targetName}`,
    faultInjection: 'relayer-worker-disabled-before-target-delivery',
    requestID,
    sourceTransactionHash: sourceReceipt.hash,
    challengeTransactionHash: workflow.challengeResult?.transactionHash,
    compensationTransactionHash: workflow.compensationResult?.transactionHash,
    states: {
      watcher: workflow.watcherState,
      lifecycleStatus: Number(record.status),
      relayerTask: relayerTask?.status,
    },
    gas: {
      sourceEscrowRequest: Number(sourceReceipt.gasUsed),
      challenge: challengeGas,
      compensationRefund: compensationGas,
      protocolTotal: protocolGasTotal,
    },
    setupGasExcluded: {
      tokenDeployment: Number(tokenDeploymentReceipt.gasUsed),
      tokenMint: Number(mintReceipt.gasUsed),
      tokenApproval: Number(approvalReceipt.gasUsed),
      avalancheHeartbeatFunding: Number(heartbeatFundingReceipt?.gasUsed || 0),
      avalancheBlockHeartbeats: heartbeatGas,
    },
    localBlockProduction: { heartbeatCount, heartbeatGas },
    realRollback: {
      token: await token.getAddress(),
      amount: escrowAmount.toString(),
      ownerBalanceBefore: ownerBalanceBefore.toString(),
      ownerBalanceAfter: ownerBalanceAfter.toString(),
      escrowContractBalanceBefore: sourceEscrowBalanceBefore.toString(),
      escrowContractBalanceAfter: sourceEscrowBalanceAfter.toString(),
      refunded: escrow.refunded,
      settled: escrow.settled,
      targetExecutionCountBefore: targetExecutionBefore.toString(),
      targetExecutionCountAfter: targetExecutionAfter.toString(),
    },
    elapsedMs: Date.now() - startedAt,
    pass,
  };
}

async function cancelUndeliveredRelayerTask(requestID) {
  await axios.post(`${AUTOMATION_URL}/v1/workflows/${requestID}/cancel`, {
    reason: 'rollback experiment fault injection completed',
  }, { headers: authHeaders() });
}

async function main() {
  const health = (await axios.get(`${AUTOMATION_URL}/health`, { headers: authHeaders() })).data;
  if (health.roleMode !== 'watcher') throw new Error(`automation role must be watcher, got ${health.roleMode}`);
  for (const chain of ['ethereum', 'avalanche']) {
    if (!health.enabledChains?.includes(chain)) throw new Error(`automation chain is disabled: ${chain}`);
  }
  const experiments = [];
  for (const [source, target] of [['ethereum', 'avalanche'], ['avalanche', 'ethereum']]) {
    console.log(`\n=== ${source}->${target} challenge rollback ===`);
    const result = await runDirection(source, target);
    experiments.push(result);
    await cancelUndeliveredRelayerTask(result.requestID);
    console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.direction} gas=${result.gas.protocolTotal} elapsedMs=${result.elapsedMs}`);
  }
  const result = {
    testType: 'automation-ethereum-avalanche-challenge-timeout-real-rollback',
    testedAt: new Date().toISOString(),
    feedbackDelaySeconds: FEEDBACK_DELAY_SECONDS,
    challengeWindowSeconds: CHALLENGE_WINDOW_SECONDS,
    safetyCondition: 'target delivery is withheld; rollback cannot coexist with an already executed target transfer',
    experiments,
    pass: experiments.every((item) => item.pass),
  };
  const output = path.join(ROOT, 'runtime', 'automation-ethereum-avalanche-challenge-rollback-result.json');
  fs.writeJsonSync(output, result, { spaces: 2 });
  console.log(`Results: ${output}`);
  if (!result.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
