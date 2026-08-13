const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { loadDotEnv } = require('../shared/env');
const { encodeCompactBusinessCall } = require('../shared/xmsg');
const {
  addressToBytes32,
  bytes32FromText,
  chainIdToBytes32,
  hashJson,
  FeedbackType,
  AtomicityMode,
  CommitmentType,
} = require('../shared/hxmsg');
const { TARGET_EXECUTE_SELECTOR } = require('../hxmsg-builder/fabric-to-evm');
const { FABRIC_INVOKE_SELECTOR, buildFabricTargetObject } = require('../hxmsg-builder/evm-to-fabric');
const { getValidatorSetRef } = require('../automation/shared/adapters/avalanche/proof-builder');
const { connectFabric } = require('../automation/fabric-client');
const { chainProfile } = require('../automation/config');
const { publishSourceMaterial, getWorkflow } = require('../automation/client');

loadDotEnv();

const ROOT = path.join(__dirname, '..');
const PEER_NAME = String(process.env.AUTOMATION_FABRIC_EVM_PEER || 'ethereum').toLowerCase();
const AUTOMATION_URL = String(process.env.AUTOMATION_URL || 'http://127.0.0.1:9200').replace(/\/$/, '');
const FEEDBACK_DELAY_SECONDS = Number(process.env.ROLLBACK_FEEDBACK_DELAY_SECONDS || 15);
const CHALLENGE_WINDOW_SECONDS = Number(process.env.ROLLBACK_CHALLENGE_WINDOW_SECONDS || 5);
const EXECUTE_COMPACT_SELECTOR = ethers.id(
  'executeCompact(bytes32,(uint16,bytes32,bytes32,address,int256,bytes32,bool))'
).slice(0, 10);

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

async function waitForCompensation(requestID, heartbeat) {
  const deadline = Date.now() + 180_000;
  let lastState;
  while (Date.now() < deadline) {
    if (heartbeat) await heartbeat();
    const workflow = await getWorkflow(requestID);
    const state = workflow?.watcherState || 'DISCOVERING';
    if (state !== lastState) {
      console.log(`WATCH requestID=${requestID} state=${state}`);
      lastState = state;
    }
    if (state === 'COMPENSATED') return workflow;
    if (['FAILED', 'CANCELLED'].includes(state)) throw new Error(`watcher ended in ${state}`);
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

async function cancelWorkflow(requestID) {
  await axios.post(`${AUTOMATION_URL}/v1/workflows/${requestID}/cancel`, {
    reason: 'challenge rollback fault injection completed',
  }, { headers: authHeaders() });
}

function lifecyclePolicy({ failureActionHash, commitmentRefHash, successActionHash, feedbackTimeout }) {
  const feedback = {
    required: true,
    expectedMsgType: FeedbackType.RESPONSE,
    timeout: feedbackTimeout,
    callbackRefHash: ethers.ZeroHash,
  };
  const atomicity = {
    required: true,
    mode: AtomicityMode.COMMIT_OR_COMPENSATE,
    commitmentType: CommitmentType.TOKEN_ESCROW,
    commitmentRefHash,
    successActionHash,
    failureActionHash,
    challengeWindow: CHALLENGE_WINDOW_SECONDS,
  };
  const policy = [true, FeedbackType.RESPONSE, feedbackTimeout, ethers.ZeroHash, [
    true,
    AtomicityMode.COMMIT_OR_COMPENSATE,
    CommitmentType.TOKEN_ESCROW,
    commitmentRefHash,
    successActionHash,
    failureActionHash,
    CHALLENGE_WINDOW_SECONDS,
  ]];
  return { feedback, atomicity, policy };
}

async function runFabricToPeer() {
  const startedAt = Date.now();
  const fabricProfile = chainProfile('fabric');
  const peer = chainProfile(PEER_NAME);
  const provider = new ethers.JsonRpcProvider(peer.rpc);
  const target = new ethers.Contract(
    peer.deployment.targetContract,
    ['function executionCount() view returns (uint256)'],
    provider
  );
  const targetExecutionBefore = await target.executionCount();
  const runID = `rollback-fabric-${PEER_NAME}-${startedAt}`;
  const owner = `fabric.rollback.owner.${runID}`;
  const failureData = JSON.stringify({ action: 'refund', runID });
  const feedbackTimeout = Math.floor(Date.now() / 1000) + FEEDBACK_DELAY_SECONDS;
  const parts = lifecyclePolicy({
    failureActionHash: ethers.keccak256(ethers.toUtf8Bytes(failureData)),
    commitmentRefHash: ethers.keccak256(ethers.toUtf8Bytes(`escrow:${runID}`)),
    successActionHash: ethers.keccak256(ethers.toUtf8Bytes(`settle:${runID}`)),
    feedbackTimeout,
  });
  const businessPayload = {
    op: 'token_transfer',
    transferId: runID,
    assetType: 'XCST',
    owner,
    actor: owner,
    from: owner,
    to: peer.deployment.deployer,
    targetRecipient: peer.deployment.deployer,
    amount: '5',
    metadata: 'Fabric source timeout and real escrow refund',
    requireAck: true,
  };
  const encoded = encodeCompactBusinessCall(businessPayload);
  await publishSourceMaterial(encoded.compactCallHash, {
    targetProfile: PEER_NAME,
    businessPayload,
    feedback: parts.feedback,
    atomicity: parts.atomicity,
    failureData,
  });
  const fabric = await connectFabric(fabricProfile);
  let requestID;
  let transactionID;
  let balanceBefore;
  try {
    await fabric.contract.submitTransaction('InitAssetBalance', owner, 'XCST', '5');
    balanceBefore = BigInt(JSON.parse((await fabric.contract.evaluateTransaction(
      'QueryAssetBalance', owner, 'XCST'
    )).toString()).balanceUnits);
    const sourcePayload = {
      businessPayload,
      targetChainType: PEER_NAME === 'avalanche' ? 'AVALANCHE' : 'EVM',
      targetChainID: chainIdToBytes32(peer.deployment.chainId),
      targetObject: addressToBytes32(peer.deployment.targetContract),
      functionSelector: TARGET_EXECUTE_SELECTOR,
      callDataHash: encoded.compactCallHash,
      businessPayloadHash: hashJson(encoded.normalized),
      receiver: addressToBytes32(peer.deployment.targetContract),
      expireAt: Math.floor(Date.now() / 1000) + 3600,
      feedback: parts.feedback,
      atomicity: parts.atomicity,
    };
    const transaction = fabric.contract.createTransaction('LockAssetXCall');
    transactionID = transaction.getTransactionId();
    const response = JSON.parse((await transaction.submit(JSON.stringify(sourcePayload))).toString());
    requestID = response.requestID;
  } finally {
    fabric.gateway.disconnect();
  }
  console.log(`SOURCE fabric->${PEER_NAME} requestID=${requestID} tx=${transactionID}`);
  const workflow = await waitForCompensation(requestID);
  const tasks = await workflowTasks(requestID);
  const verify = await connectFabric(fabricProfile);
  let lifecycle;
  let escrow;
  let balanceAfter;
  try {
    lifecycle = JSON.parse((await verify.contract.evaluateTransaction('QueryResponseLifecycle', requestID)).toString());
    escrow = JSON.parse((await verify.contract.evaluateTransaction('QueryAssetEscrow', requestID)).toString());
    balanceAfter = BigInt(JSON.parse((await verify.contract.evaluateTransaction(
      'QueryAssetBalance', owner, 'XCST'
    )).toString()).balanceUnits);
  } finally {
    verify.gateway.disconnect();
  }
  const targetExecutionAfter = await target.executionCount();
  const relayerTask = tasks.find((task) => task.role === 'relayer-prepare');
  const pass = workflow.watcherState === 'COMPENSATED'
    && lifecycle.status === 'Compensated'
    && escrow.status === 'Refunded'
    && balanceAfter === balanceBefore
    && targetExecutionAfter === targetExecutionBefore
    && relayerTask?.status === 'pending'
    && Boolean(workflow.challengeResult)
    && Boolean(workflow.compensationResult);
  await cancelWorkflow(requestID);
  return {
    direction: `fabric-to-${PEER_NAME}`,
    requestID,
    sourceTransactionID: transactionID,
    challengeObserved: Boolean(workflow.challengeResult),
    timeoutRollbackObserved: Boolean(workflow.compensationResult),
    gas: { source: 0, challenge: 0, compensation: 0, protocolTotal: 0 },
    realRollback: {
      ownerBalanceBefore: balanceBefore.toString(),
      ownerBalanceAfter: balanceAfter.toString(),
      escrowStatus: escrow.status,
      targetExecutionBefore: targetExecutionBefore.toString(),
      targetExecutionAfter: targetExecutionAfter.toString(),
    },
    elapsedMs: Date.now() - startedAt,
    pass,
  };
}

async function runPeerToFabric() {
  const startedAt = Date.now();
  const peer = chainProfile(PEER_NAME);
  const fabricProfile = chainProfile('fabric');
  const provider = new ethers.JsonRpcProvider(peer.rpc);
  const wallet = new ethers.Wallet(peer.privateKey, provider);
  const signer = new ethers.NonceManager(wallet);
  const sourceArtifactName = PEER_NAME === 'avalanche' ? 'AvalancheWarpSourceContract' : 'EvmSourceContract';
  const sourceArtifact = fs.readJsonSync(path.join(
    ROOT,
    `artifacts/contracts/${sourceArtifactName}.sol/${sourceArtifactName}.json`
  ));
  const tokenArtifact = fs.readJsonSync(path.join(
    ROOT,
    'artifacts/contracts/CrossChainToken.sol/CrossChainToken.json'
  ));
  const sourceAddress = PEER_NAME === 'avalanche'
    ? peer.deployment.avalancheWarpSourceContract
    : peer.deployment.evmSourceContract;
  const source = new ethers.Contract(sourceAddress, sourceArtifact.abi, signer);
  const tokenFactory = new ethers.ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, signer);
  const token = await tokenFactory.deploy(`${PEER_NAME} Rollback Token`, 'XRT', 4, wallet.address);
  await token.waitForDeployment();
  const escrowAmount = 50000n;
  await (await token.mint(wallet.address, escrowAmount)).wait();
  await (await token.approve(sourceAddress, escrowAmount)).wait();
  const ownerBalanceBefore = await token.balanceOf(wallet.address);
  const escrowBalanceBefore = await token.balanceOf(sourceAddress);
  const runID = `rollback-${PEER_NAME}-fabric-${startedAt}`;
  const failureData = ethers.hexlify(ethers.toUtf8Bytes(`refund:${runID}`));
  const latest = await provider.getBlock('latest');
  const sourceNow = Math.max(Number(latest.timestamp), Math.floor(Date.now() / 1000));
  const feedbackTimeout = sourceNow + FEEDBACK_DELAY_SECONDS;
  const parts = lifecyclePolicy({
    failureActionHash: ethers.keccak256(failureData),
    commitmentRefHash: ethers.keccak256(ethers.toUtf8Bytes(`escrow:${runID}`)),
    successActionHash: ethers.keccak256(ethers.toUtf8Bytes(`settle:${runID}`)),
    feedbackTimeout,
  });
  const recipient = `fabric.rollback.recipient.${runID}`;
  const businessPayload = {
    op: 'token_transfer',
    transferId: runID,
    assetType: 'XCST',
    targetRecipient: recipient,
    amount: '5',
    metadata: `${PEER_NAME} source timeout and real escrow refund`,
    requireAck: true,
  };
  const encoded = encodeCompactBusinessCall(businessPayload);
  await publishSourceMaterial(encoded.compactCallHash, {
    targetProfile: 'fabric',
    businessPayload,
    feedback: parts.feedback,
    atomicity: parts.atomicity,
    failureData,
  });
  const targetObject = buildFabricTargetObject(fabricProfile.channel, fabricProfile.chaincode);
  const commonArgs = [
    bytes32FromText(`fabric-${fabricProfile.channel}`),
    bytes32FromText('fabric-local-domain'),
    targetObject,
    FABRIC_INVOKE_SELECTOR,
  ];
  const transaction = PEER_NAME === 'avalanche'
    ? await source.submitTokenEscrowWarpHXMsgRequest(
      ...commonArgs,
      encoded.payloadHex,
      hashJson(encoded.normalized),
      targetObject,
      sourceNow + 3600,
      await avalanchePolicyHash(),
      parts.policy,
      await token.getAddress(),
      escrowAmount
    )
    : await source.submitTokenEscrowHXMsgRequest(
      ...commonArgs,
      encoded.compactCallHash,
      hashJson(encoded.normalized),
      targetObject,
      sourceNow + 3600,
      parts.policy,
      await token.getAddress(),
      escrowAmount
    );
  const receipt = await transaction.wait();
  const eventName = PEER_NAME === 'avalanche' ? 'AvalancheHXMsgWarpRequested' : 'CrossChainCallRequested';
  const event = receipt.logs.map((log) => {
    try { return source.interface.parseLog(log); } catch (_error) { return null; }
  }).find((item) => item?.name === eventName);
  if (!event) throw new Error(`${eventName} event missing`);
  const requestID = event.args.requestID;
  console.log(`SOURCE ${PEER_NAME}->fabric requestID=${requestID} gas=${receipt.gasUsed}`);
  let heartbeatWallet;
  let nextHeartbeatAt = 0;
  if (PEER_NAME === 'avalanche') {
    heartbeatWallet = ethers.Wallet.createRandom().connect(provider);
    await (await signer.sendTransaction({ to: heartbeatWallet.address, value: ethers.parseEther('0.1') })).wait();
  }
  const workflow = await waitForCompensation(requestID, heartbeatWallet ? async () => {
    if (Date.now() < nextHeartbeatAt) return;
    await (await heartbeatWallet.sendTransaction({ to: heartbeatWallet.address, value: 0n })).wait();
    nextHeartbeatAt = Date.now() + 2000;
  } : null);
  const tasks = await workflowTasks(requestID);
  const [record, escrow, ownerBalanceAfter, escrowBalanceAfter] = await Promise.all([
    source.requests(requestID),
    source.tokenEscrows(requestID),
    token.balanceOf(wallet.address),
    token.balanceOf(sourceAddress),
  ]);
  const targetFabric = await connectFabric(fabricProfile);
  let inbound;
  try {
    inbound = (await targetFabric.contract.evaluateTransaction('GetInboundStatus', requestID)).toString();
  } finally {
    targetFabric.gateway.disconnect();
  }
  const challengeGas = Number(workflow.challengeResult?.gasUsed || 0);
  const compensationGas = Number(workflow.compensationResult?.gasUsed || 0);
  const relayerTask = tasks.find((task) => task.role === 'relayer-prepare');
  const pass = workflow.watcherState === 'COMPENSATED'
    && Number(record.status) === 4
    && escrow.refunded
    && !escrow.settled
    && ownerBalanceAfter === ownerBalanceBefore
    && escrowBalanceAfter === escrowBalanceBefore
    && !inbound
    && relayerTask?.status === 'pending'
    && Boolean(workflow.challengeResult)
    && Boolean(workflow.compensationResult);
  await cancelWorkflow(requestID);
  return {
    direction: `${PEER_NAME}-to-fabric`,
    requestID,
    sourceTransactionHash: receipt.hash,
    challengeObserved: Boolean(workflow.challengeResult),
    timeoutRollbackObserved: Boolean(workflow.compensationResult),
    gas: {
      source: Number(receipt.gasUsed),
      challenge: challengeGas,
      compensation: compensationGas,
      protocolTotal: Number(receipt.gasUsed) + challengeGas + compensationGas,
    },
    realRollback: {
      ownerBalanceBefore: ownerBalanceBefore.toString(),
      ownerBalanceAfter: ownerBalanceAfter.toString(),
      escrowBalanceBefore: escrowBalanceBefore.toString(),
      escrowBalanceAfter: escrowBalanceAfter.toString(),
      targetInboundCreated: Boolean(inbound),
    },
    elapsedMs: Date.now() - startedAt,
    pass,
  };
}

async function main() {
  if (!['ethereum', 'avalanche'].includes(PEER_NAME)) throw new Error(`unsupported peer: ${PEER_NAME}`);
  const health = (await axios.get(`${AUTOMATION_URL}/health`, { headers: authHeaders() })).data;
  if (health.roleMode !== 'watcher') throw new Error(`automation role must be watcher, got ${health.roleMode}`);
  for (const chain of ['fabric', PEER_NAME]) {
    if (!health.enabledChains?.includes(chain)) throw new Error(`automation chain is disabled: ${chain}`);
  }
  const experiments = [];
  console.log(`\n=== fabric->${PEER_NAME} challenge and timeout rollback ===`);
  experiments.push(await runFabricToPeer());
  console.log(`${experiments[0].pass ? 'PASS' : 'FAIL'} ${experiments[0].direction}`);
  console.log(`\n=== ${PEER_NAME}->fabric challenge and timeout rollback ===`);
  experiments.push(await runPeerToFabric());
  console.log(`${experiments[1].pass ? 'PASS' : 'FAIL'} ${experiments[1].direction}`);
  const result = {
    testType: `automation-fabric-${PEER_NAME}-challenge-timeout-real-rollback`,
    testedAt: new Date().toISOString(),
    feedbackDelaySeconds: FEEDBACK_DELAY_SECONDS,
    challengeWindowSeconds: CHALLENGE_WINDOW_SECONDS,
    faultInjection: 'automation watcher-only mode keeps relayer tasks pending before target delivery',
    experiments,
    pass: experiments.every((item) => item.pass),
  };
  const output = path.join(ROOT, `runtime/automation-fabric-${PEER_NAME}-challenge-rollback-result.json`);
  fs.writeJsonSync(output, result, { spaces: 2 });
  console.log(`Results: ${output}`);
  if (!result.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
