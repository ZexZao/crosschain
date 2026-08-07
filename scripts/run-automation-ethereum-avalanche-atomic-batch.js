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
  buildDeliveryMessage,
  FeedbackType,
  AtomicityMode,
  CommitmentType,
} = require('../shared/hxmsg');
const { buildReceiptProof } = require('../shared/evm/receipt-proof');
const { buildCommitteeHeaderUpdate } = require('../shared/evm/header-committee');
const { buildEvmExecutionProofRef, buildExecutedResponse } = require('../hxmsg-builder/response');
const { getValidatorSetRef } = require('../automation/shared/adapters/avalanche/proof-builder');
const { chainProfile } = require('../automation/config');
const { publishSourceMaterial, getMaterial, waitForWorkflow } = require('../automation/client');

loadDotEnv();

const ROOT = path.join(__dirname, '..');
const COUNT = Number(process.env.AUTOMATION_ATOMIC_BATCH_SIZE || 8);
const AUTOMATION_URL = String(process.env.AUTOMATION_URL || 'http://127.0.0.1:9200').replace(/\/$/, '');
const SOURCE_ABI = [
  'function submitTokenEscrowHXMsgRequest(bytes32,bytes32,bytes32,bytes4,bytes32,bytes32,bytes32,uint64,(bool,uint8,uint64,bytes32,(bool,uint8,uint8,bytes32,bytes32,bytes32,uint64)),address,uint256) external returns (bytes32)',
  'function requests(bytes32) view returns (bytes32 targetExecutionHash,bytes32 failureActionHash,uint64 feedbackTimeout,uint64 challengeWindow,uint64 challengeDeadline,uint8 commitmentType,uint8 status,bytes32 responseDigest)',
  'function tokenEscrows(bytes32) view returns (address token,address owner,uint256 amount,bool refunded,bool settled)',
  'event CrossChainCallRequested(bytes32 indexed requestID,address indexed sender,bytes32 indexed targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bool feedbackRequired,uint8 expectedFeedbackMsgType,uint64 feedbackTimeout,bytes32 callbackRefHash,bytes32 atomicityHash)',
];
const TOKEN_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
];
const TARGET_ABI = ['function executionCount() view returns (uint256)'];
const EXECUTE_COMPACT_SELECTOR = ethers.id(
  'executeCompact(bytes32,(uint16,bytes32,bytes32,address,int256,bytes32,bool))'
).slice(0, 10);

function authHeaders() {
  return process.env.AUTOMATION_API_KEY
    ? { authorization: `Bearer ${process.env.AUTOMATION_API_KEY}` }
    : {};
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTask(taskID, timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data: task } = await axios.get(`${AUTOMATION_URL}/v1/tasks/${taskID}`, { headers: authHeaders() });
    if (task.status === 'completed') return task;
    if (task.status === 'dead-letter' || task.status === 'cancelled') {
      throw new Error(`automation task ${taskID} ${task.status}: ${task.lastError || 'unknown error'}`);
    }
    await sleep(500);
  }
  throw new Error(`automation task timeout: ${taskID}`);
}

async function waitForWatcher(requestID, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data: workflow } = await axios.get(`${AUTOMATION_URL}/v1/workflows/${requestID}`, {
      headers: authHeaders(),
    });
    if (workflow.watcherState === 'COMPLETED') return workflow;
    if (['COMPENSATED', 'FAILED', 'CANCELLED'].includes(workflow.watcherState)) {
      throw new Error(`watcher ended in ${workflow.watcherState}: ${requestID}`);
    }
    await sleep(500);
  }
  throw new Error(`watcher completion timeout: ${requestID}`);
}

async function watcherRegistration(requestID) {
  const { data: tasks } = await axios.get(`${AUTOMATION_URL}/v1/tasks`, {
    params: { workflowID: requestID },
    headers: authHeaders(),
  });
  const registration = tasks.find((task) => task.role === 'watcher-register');
  const watch = tasks.find((task) => task.role === 'watch');
  return {
    registered: Boolean(registration?.status === 'completed' && registration.result?.registered === true),
    registrationTaskID: registration?.id,
    watchTaskID: watch?.id,
    watchStatus: watch?.status,
  };
}

async function avalanchePolicyHash() {
  const { ref } = await getValidatorSetRef();
  return hashJson({ validatorSetRef: ref, canonicalOrdering: ref.canonicalOrdering });
}

function targetTeeRpc(targetName) {
  return targetName === 'avalanche'
    ? 'http://avalanche-rpc-proxy:9650/node/9650/ext/bc/C/rpc'
    : 'http://evm-node:8545';
}

function payloadFor(runID, index, recipient) {
  return {
    op: 'token_transfer',
    transferId: `AUTOMATION_ATOMIC_BATCH_${runID}_${index}`,
    assetType: 'XCST',
    from: 'automation.atomic.batch.reserve',
    to: recipient,
    recipient,
    targetRecipient: recipient,
    amount: String(index + 1),
    metadata: `automation atomic batch transfer ${index}`,
    requireAck: true,
  };
}

async function runDirection(sourceName, targetName) {
  const startedAt = Date.now();
  const runID = `${sourceName}-${targetName}-${Date.now()}`;
  const sourceProfile = chainProfile(sourceName);
  const targetProfile = chainProfile(targetName);
  const sourceProvider = new ethers.JsonRpcProvider(sourceProfile.rpc);
  const targetProvider = new ethers.JsonRpcProvider(targetProfile.rpc);
  const sourceSigner = new ethers.NonceManager(new ethers.Wallet(sourceProfile.privateKey, sourceProvider));
  const sourceAddress = sourceName === 'avalanche'
    ? sourceProfile.deployment.avalancheWarpSourceContract
    : sourceProfile.deployment.evmSourceContract;
  const sourceArtifact = sourceName === 'avalanche'
    ? fs.readJsonSync(path.join(ROOT, 'artifacts/contracts/AvalancheWarpSourceContract.sol/AvalancheWarpSourceContract.json'))
    : { abi: SOURCE_ABI };
  const source = new ethers.Contract(sourceAddress, sourceArtifact.abi, sourceSigner);
  const targetToken = new ethers.Contract(targetProfile.deployment.settlementToken, TOKEN_ABI, targetProvider);
  const target = new ethers.Contract(targetProfile.deployment.targetContract, TARGET_ABI, targetProvider);
  const sourceOwner = await sourceSigner.getAddress();
  const targetRecipient = targetProfile.deployment.deployer;
  const targetObject = ethers.zeroPadValue(targetProfile.deployment.targetContract, 32);
  const sourceLatest = await sourceProvider.getBlock('latest');
  const sourceNow = Math.max(Number(sourceLatest.timestamp), Math.floor(Date.now() / 1000));
  const feedbackTimeout = sourceNow + 600;
  const challengeWindow = 60;
  const validatorPolicyHash = sourceName === 'avalanche' ? await avalanchePolicyHash() : null;
  const entries = Array.from({ length: COUNT }, (_, index) => {
    const businessPayload = payloadFor(runID, index, targetRecipient);
    const encoded = encodeCompactBusinessCall(businessPayload);
    const failureData = ethers.hexlify(ethers.toUtf8Bytes(`refund:${businessPayload.transferId}`));
    const atomicity = {
      required: true,
      mode: AtomicityMode.COMMIT_OR_COMPENSATE,
      commitmentType: CommitmentType.TOKEN_ESCROW,
      commitmentRefHash: ethers.keccak256(ethers.toUtf8Bytes(`escrow:${businessPayload.transferId}`)),
      successActionHash: ethers.keccak256(ethers.toUtf8Bytes(`settle:${businessPayload.transferId}`)),
      failureActionHash: ethers.keccak256(failureData),
      challengeWindow,
    };
    const feedback = {
      required: true,
      expectedMsgType: FeedbackType.RESPONSE,
      timeout: feedbackTimeout,
      callbackRefHash: ethers.ZeroHash,
    };
    const policy = [true, FeedbackType.RESPONSE, feedbackTimeout, ethers.ZeroHash, [
      true,
      AtomicityMode.COMMIT_OR_COMPENSATE,
      CommitmentType.TOKEN_ESCROW,
      atomicity.commitmentRefHash,
      atomicity.successActionHash,
      atomicity.failureActionHash,
      challengeWindow,
    ]];
    return { index, businessPayload, encoded, failureData, atomicity, feedback, policy };
  });
  const escrowTotal = entries.reduce((sum, entry) => sum + BigInt(entry.encoded.compact.amount), 0n);
  const escrowTokenArtifact = fs.readJsonSync(
    path.join(ROOT, 'artifacts/contracts/CrossChainToken.sol/CrossChainToken.json')
  );
  const escrowTokenFactory = new ethers.ContractFactory(
    escrowTokenArtifact.abi,
    escrowTokenArtifact.bytecode,
    sourceSigner
  );
  const sourceToken = await escrowTokenFactory.deploy(
    `Atomic Batch ${sourceName} Token`,
    sourceName === 'avalanche' ? 'ABAT' : 'ABET',
    4,
    sourceOwner
  );
  const tokenDeploymentReceipt = await sourceToken.deploymentTransaction().wait();
  await sourceToken.waitForDeployment();
  const mintReceipt = await (await sourceToken.mint(sourceOwner, escrowTotal)).wait();
  const sourceTokenAddress = await sourceToken.getAddress();
  const sourceOwnerBalanceBefore = await sourceToken.balanceOf(sourceOwner);
  const sourceEscrowBalanceBefore = await sourceToken.balanceOf(sourceAddress);
  const targetBalanceBefore = await targetToken.balanceOf(targetRecipient);
  const targetExecutionBefore = await target.executionCount();
  const approvalReceipt = await (await sourceToken.approve(sourceAddress, escrowTotal)).wait();
  const submissions = [];

  for (const entry of entries) {
    await publishSourceMaterial(entry.encoded.compactCallHash, {
      targetProfile: targetName,
      businessPayload: entry.businessPayload,
      feedback: entry.feedback,
      atomicity: entry.atomicity,
      failureData: entry.failureData,
      batchGroupID: runID,
      batchSize: COUNT,
      batchIndex: entry.index,
    });
    let transaction;
    if (sourceName === 'avalanche') {
      transaction = await source.submitTokenEscrowWarpHXMsgRequest(
        chainIdToBytes32(targetProfile.deployment.chainId),
        bytes32FromText(`evm-local-${targetProfile.deployment.chainId}`),
        targetObject,
        EXECUTE_COMPACT_SELECTOR,
        entry.encoded.payloadHex,
        hashJson(entry.encoded.normalized),
        targetObject,
        sourceNow + 3600,
        validatorPolicyHash,
        entry.policy,
        sourceTokenAddress,
        entry.encoded.compact.amount
      );
    } else {
      transaction = await source.submitTokenEscrowHXMsgRequest(
        chainIdToBytes32(targetProfile.deployment.chainId),
        bytes32FromText(`${targetName}-local-${targetProfile.deployment.chainId}`),
        targetObject,
        EXECUTE_COMPACT_SELECTOR,
        entry.encoded.compactCallHash,
        hashJson(entry.encoded.normalized),
        targetObject,
        sourceNow + 3600,
        entry.policy,
        sourceTokenAddress,
        entry.encoded.compact.amount
      );
    }
    const receipt = await transaction.wait();
    const eventName = sourceName === 'avalanche' ? 'AvalancheHXMsgWarpRequested' : 'CrossChainCallRequested';
    const event = receipt.logs.map((log) => {
      try { return source.interface.parseLog(log); } catch (_error) { return null; }
    }).find((item) => item?.name === eventName);
    if (!event) throw new Error(`${eventName} event missing`);
    submissions.push({
      requestID: event.args.requestID,
      transactionHash: receipt.hash,
      gasUsed: Number(receipt.gasUsed),
      entry,
    });
  }

  const awaitingResponse = await Promise.all(submissions.map((submission) => waitForWorkflow(submission.requestID, {
    timeoutMs: 10 * 60 * 1000,
  })));
  if (awaitingResponse.some((workflow) => workflow.relayerState !== 'WAITING_RESPONSE')) {
    throw new Error('batch did not reach WAITING_RESPONSE');
  }
  const targetHashes = [...new Set(awaitingResponse.map((workflow) => workflow.targetResult?.transactionHash))];
  if (targetHashes.length !== 1) throw new Error(`expected one target batch transaction, got ${targetHashes.length}`);
  const targetReceipt = await targetProvider.getTransactionReceipt(targetHashes[0]);
  if (!targetReceipt || targetReceipt.status !== 1) throw new Error('target batch transaction failed');
  const targetProof = await buildReceiptProof({
    provider: targetProvider,
    blockNumber: targetReceipt.blockNumber,
    txHash: targetReceipt.hash,
  });
  const targetChainID = `eip155:${targetProfile.deployment.chainId}`;
  const committeeHeaderUpdate = buildCommitteeHeaderUpdate({
    header: targetProof.blockHeader,
    chainID: targetChainID,
  });
  const responseTasks = [];

  for (let index = 0; index < awaitingResponse.length; index += 1) {
    const workflow = awaitingResponse[index];
    const evidence = await getMaterial(workflow.evidenceKey);
    if (!evidence?.hxmsg) throw new Error(`missing verified h-xmsg evidence: ${workflow.requestID}`);
    const delivery = evidence.hxmsg.deliveryMessage || buildDeliveryMessage(evidence.hxmsg);
    const response = buildExecutedResponse({
      originRequestID: workflow.requestID,
      originHmsgDigest: evidence.hxmsg.hmsgDigest,
      targetExecutionHash: delivery.targetExecutionHash,
      targetProofRefHash: buildEvmExecutionProofRef(targetReceipt),
      responsePayload: {
        targetTransactionHash: targetReceipt.hash,
        batchIndex: index,
        status: 'executed',
      },
    });
    const { data: task } = await axios.post(`${AUTOMATION_URL}/v1/jobs/response`, {
      requestID: workflow.requestID,
      sourceProfile: sourceName,
      sourceContract: sourceAddress,
      useWarpSource: sourceName === 'avalanche',
      targetChainType: targetProfile.chainType,
      response,
      helperData: {
        originHxmsg: evidence.hxmsg,
        evmExecutionReceipt: targetProof,
        committeeHeaderUpdate,
        evmChainID: targetChainID,
        evmRpc: targetTeeRpc(targetName),
      },
    }, {
      headers: { ...authHeaders(), 'idempotency-key': `atomic-batch-response:${workflow.requestID}` },
    });
    responseTasks.push(task);
  }

  const completedResponseTasks = [];
  for (const task of responseTasks) completedResponseTasks.push(await waitForTask(task.id));
  const completedWorkflows = await Promise.all(submissions.map((submission) => waitForWorkflow(submission.requestID, {
    timeoutMs: 120_000,
    terminalStates: ['COMPLETED', 'FAILED'],
  })));
  const watcherWorkflows = [];
  for (const submission of submissions) watcherWorkflows.push(await waitForWatcher(submission.requestID));
  const watcherRegistrations = [];
  for (const submission of submissions) watcherRegistrations.push(await watcherRegistration(submission.requestID));

  const lifecycle = [];
  for (const submission of submissions) {
    const [record, escrow] = await Promise.all([
      source.requests(submission.requestID),
      source.tokenEscrows(submission.requestID),
    ]);
    lifecycle.push({
      requestID: submission.requestID,
      status: Number(record.status),
      responseDigest: record.responseDigest,
      escrowAmount: escrow.amount.toString(),
      escrowRefunded: escrow.refunded,
      escrowSettled: escrow.settled,
    });
  }

  const sourceOwnerBalanceAfter = await sourceToken.balanceOf(sourceOwner);
  const sourceEscrowBalanceAfter = await sourceToken.balanceOf(sourceAddress);
  const targetBalanceAfter = await targetToken.balanceOf(targetRecipient);
  const targetExecutionAfter = await target.executionCount();
  const targetTransfers = targetReceipt.logs.map((log) => {
    try { return targetToken.interface.parseLog(log); } catch (_error) { return null; }
  }).filter((event) => event?.name === 'Transfer'
    && event.args.to.toLowerCase() === targetRecipient.toLowerCase());
  const sourceGasTotal = submissions.reduce((sum, item) => sum + item.gasUsed, 0);
  const targetGasTotal = Number(targetReceipt.gasUsed);
  const responseGasTotal = completedResponseTasks.reduce((sum, task) => sum + Number(task.result?.gasUsed || 0), 0);
  const protocolGasTotal = sourceGasTotal + targetGasTotal + responseGasTotal;
  const pass = completedWorkflows.every((workflow) => workflow.relayerState === 'COMPLETED')
    && completedWorkflows.every((workflow) => workflow.teeBatch?.batchSize === COUNT)
    && watcherWorkflows.every((workflow) => workflow.watcherState === 'COMPLETED')
    && watcherRegistrations.every((item) => item.registered && item.watchStatus === 'completed')
    && lifecycle.every((item) => item.status === 3 && item.escrowSettled && !item.escrowRefunded)
    && sourceOwnerBalanceBefore - sourceOwnerBalanceAfter === escrowTotal
    && sourceEscrowBalanceAfter - sourceEscrowBalanceBefore === escrowTotal
    && targetBalanceAfter - targetBalanceBefore === escrowTotal
    && targetTransfers.length === COUNT
    && targetExecutionAfter - targetExecutionBefore === BigInt(COUNT);

  return {
    direction: `${sourceName}-to-${targetName}`,
    count: COUNT,
    responseRequired: true,
    atomicityRequired: true,
    commitmentType: 'TOKEN_ESCROW',
    sourceTransactions: submissions.length,
    targetTransactions: 1,
    responseTransactions: completedResponseTasks.length,
    setupGasExcluded: {
      escrowTokenDeployment: Number(tokenDeploymentReceipt.gasUsed),
      escrowTokenMint: Number(mintReceipt.gasUsed),
      tokenApproval: Number(approvalReceipt.gasUsed),
    },
    gas: {
      sourceRequests: sourceGasTotal,
      targetBatchExecution: targetGasTotal,
      responseCompletion: responseGasTotal,
      protocolTotal: protocolGasTotal,
      averagePerMessage: Math.ceil(protocolGasTotal / COUNT),
    },
    elapsedMs: Date.now() - startedAt,
    teeBatch: completedWorkflows[0]?.teeBatch,
    relayerStates: completedWorkflows.map((workflow) => workflow.relayerState),
    watcherStates: watcherWorkflows.map((workflow) => workflow.watcherState),
    watcherRegistrations,
    realActions: {
      sourceEscrowToken: sourceTokenAddress,
      sourceEscrowLocked: (sourceEscrowBalanceAfter - sourceEscrowBalanceBefore).toString(),
      sourceOwnerDebited: (sourceOwnerBalanceBefore - sourceOwnerBalanceAfter).toString(),
      targetTransferred: (targetBalanceAfter - targetBalanceBefore).toString(),
      targetTransferEvents: targetTransfers.length,
      sourceEscrowsSettled: lifecycle.filter((item) => item.escrowSettled).length,
      sourceEscrowsRefunded: lifecycle.filter((item) => item.escrowRefunded).length,
    },
    lifecycle,
    requestIDs: submissions.map((item) => item.requestID),
    sourceTransactionHashes: submissions.map((item) => item.transactionHash),
    targetTransactionHash: targetReceipt.hash,
    responseTransactionHashes: completedResponseTasks.map((task) => task.result?.transactionHash),
    pass,
  };
}

async function main() {
  const health = await axios.get(`${AUTOMATION_URL}/health`, { headers: authHeaders() });
  for (const chain of ['ethereum', 'avalanche']) {
    if (!health.data?.enabledChains?.includes(chain)) throw new Error(`automation chain is disabled: ${chain}`);
  }
  const experiments = [];
  for (const [source, target] of [['ethereum', 'avalanche'], ['avalanche', 'ethereum']]) {
    console.log(`\n=== ${source}->${target} atomic TEE batch size=${COUNT} ===`);
    const result = await runDirection(source, target);
    experiments.push(result);
    console.log(`${result.pass ? 'PASS' : 'FAIL'} ${result.direction} totalGas=${result.gas.protocolTotal} avgGas=${result.gas.averagePerMessage} elapsedMs=${result.elapsedMs}`);
  }
  const result = {
    testType: 'automation-ethereum-avalanche-atomic-response-tee-batch',
    testedAt: new Date().toISOString(),
    batchSize: COUNT,
    gasAccounting: 'Mercury-style protocol gas: source requests + one target batch execution + source response completions; one-time approval is reported separately',
    experiments,
    pass: experiments.every((item) => item.pass),
  };
  const output = path.join(ROOT, 'runtime', 'automation-ethereum-avalanche-atomic-batch-result.json');
  fs.writeJsonSync(output, result, { spaces: 2 });
  console.log(`Results: ${output}`);
  if (!result.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
