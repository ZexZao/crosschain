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
  buildDeliveryMessage,
  FeedbackType,
  AtomicityMode,
  CommitmentType,
  findHXMsgAcceptedLog,
} = require('../shared/hxmsg');
const { TARGET_EXECUTE_SELECTOR } = require('../hxmsg-builder/fabric-to-evm');
const { FABRIC_INVOKE_SELECTOR, buildFabricTargetObject } = require('../hxmsg-builder/evm-to-fabric');
const {
  buildEvmExecutionProofRef,
  buildFabricExecutionProofRef,
  buildFabricExecutionViewRef,
  buildExecutedResponse,
  computeFabricExecutionResultHash,
} = require('../hxmsg-builder/response');
const { buildReceiptProof } = require('../shared/evm/receipt-proof');
const { buildCommitteeHeaderUpdate } = require('../shared/evm/header-committee');
const { getValidatorSetRef } = require('../automation/shared/adapters/avalanche/proof-builder');
const { connectFabric } = require('../automation/fabric-client');
const { chainProfile, executionDomainID } = require('../automation/config');
const { publishSourceMaterial, getMaterial, waitForWorkflow } = require('../automation/client');

loadDotEnv();
process.env.AUTOMATION_CLIENT_TIMEOUT_MS ||= '60000';

const ROOT = path.join(__dirname, '..');
const COUNT = Number(process.env.AUTOMATION_ATOMIC_BATCH_SIZE || 8);
const PEER_NAME = String(process.env.AUTOMATION_FABRIC_EVM_PEER || 'avalanche').toLowerCase();
const AUTOMATION_URL = String(process.env.AUTOMATION_URL || 'http://127.0.0.1:9200').replace(/\/$/, '');
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
    if (['dead-letter', 'cancelled'].includes(task.status)) {
      throw new Error(`automation task ${taskID} ${task.status}: ${task.lastError || 'unknown error'}`);
    }
    await sleep(500);
  }
  throw new Error(`automation task timeout: ${taskID}`);
}

async function waitForWatcher(requestID, timeoutMs = 180_000) {
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
    watchStatus: watch?.status,
  };
}

async function fabricBalance(contract, account) {
  const response = await contract.evaluateTransaction('QueryAssetBalance', account, 'XCST');
  return BigInt(JSON.parse(response.toString()).balanceUnits);
}

async function queryFabricJSON(contract, fn, ...args) {
  const response = await contract.evaluateTransaction(fn, ...args);
  return response.length ? JSON.parse(response.toString()) : null;
}

async function avalanchePolicyHash() {
  const { ref } = await getValidatorSetRef();
  return hashJson({ validatorSetRef: ref, canonicalOrdering: ref.canonicalOrdering });
}

function peerTeeRpc() {
  return PEER_NAME === 'avalanche'
    ? 'http://avalanche-rpc-proxy:9650/node/9650/ext/bc/C/rpc'
    : 'http://evm-node:8545';
}

function atomicParts(runID, index, feedbackTimeout, challengeWindow) {
  const failureData = ethers.hexlify(ethers.toUtf8Bytes(`refund:${runID}:${index}`));
  const atomicity = {
    required: true,
    mode: AtomicityMode.COMMIT_OR_COMPENSATE,
    commitmentType: CommitmentType.TOKEN_ESCROW,
    commitmentRefHash: ethers.keccak256(ethers.toUtf8Bytes(`escrow:${runID}:${index}`)),
    successActionHash: ethers.keccak256(ethers.toUtf8Bytes(`settle:${runID}:${index}`)),
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
  return { failureData, atomicity, feedback, policy };
}

function payloadFor(runID, index, recipient, sourceOwner) {
  return {
    op: 'token_transfer',
    transferId: `FABRIC_AVALANCHE_ATOMIC_${runID}_${index}`,
    assetType: 'XCST',
    owner: sourceOwner,
    actor: sourceOwner,
    from: 'fabric.atomic.batch.reserve',
    to: recipient,
    recipient,
    targetRecipient: recipient,
    amount: String(index + 1),
    metadata: `atomic response TEE batch transfer ${index}`,
    requireAck: true,
  };
}

async function enqueueResponses(jobs) {
  const tasks = [];
  for (const job of jobs) {
    const { data } = await axios.post(`${AUTOMATION_URL}/v1/jobs/response`, job, {
      headers: {
        ...authHeaders(),
        'idempotency-key': `fabric-avalanche-atomic-response:${job.requestID}`,
      },
    });
    tasks.push(data);
  }
  const completed = [];
  for (const task of tasks) completed.push(await waitForTask(task.id));
  return completed;
}

async function completeWorkflowChecks(requestIDs) {
  const workflows = await Promise.all(requestIDs.map((requestID) => waitForWorkflow(requestID, {
    timeoutMs: 180_000,
    terminalStates: ['COMPLETED', 'FAILED'],
  })));
  const watchers = [];
  const registrations = [];
  for (const requestID of requestIDs) {
    watchers.push(await waitForWatcher(requestID));
    registrations.push(await watcherRegistration(requestID));
  }
  return { workflows, watchers, registrations };
}

async function runFabricToAvalanche() {
  const startedAt = Date.now();
  const runID = `fabric-${PEER_NAME}-${startedAt}`;
  const fabricProfile = chainProfile('fabric');
  const avalanche = chainProfile(PEER_NAME);
  const provider = new ethers.JsonRpcProvider(avalanche.rpc);
  const targetToken = new ethers.Contract(
    avalanche.deployment.settlementToken,
    ['function balanceOf(address) view returns (uint256)', 'event Transfer(address indexed from,address indexed to,uint256 value)'],
    provider
  );
  const target = new ethers.Contract(
    avalanche.deployment.targetContract,
    ['function executionCount() view returns (uint256)'],
    provider
  );
  const sourceOwner = `fabric.atomic.owner.${runID}`;
  const targetRecipient = avalanche.deployment.deployer;
  const feedbackTimeout = Math.floor(Date.now() / 1000) + 600;
  const challengeWindow = 60;
  const expectedTotal = Array.from({ length: COUNT }, (_, index) => BigInt(index + 1) * 10000n)
    .reduce((sum, amount) => sum + amount, 0n);
  const fabric = await connectFabric(fabricProfile);
  const sourceBalanceBeforeInit = await fabricBalance(fabric.contract, sourceOwner);
  await fabric.contract.submitTransaction('InitAssetBalance', sourceOwner, 'XCST', String(expectedTotal / 10000n));
  const sourceBalanceBefore = await fabricBalance(fabric.contract, sourceOwner);
  const targetBalanceBefore = await targetToken.balanceOf(targetRecipient);
  const targetExecutionBefore = await target.executionCount();
  const submissions = [];
  try {
    for (let index = 0; index < COUNT; index += 1) {
      const businessPayload = payloadFor(runID, index, targetRecipient, sourceOwner);
      const encoded = encodeCompactBusinessCall(businessPayload);
      const parts = atomicParts(runID, index, feedbackTimeout, challengeWindow);
      await publishSourceMaterial(encoded.compactCallHash, {
        targetProfile: PEER_NAME,
        businessPayload,
        feedback: parts.feedback,
        atomicity: parts.atomicity,
        failureData: parts.failureData,
        batchGroupID: runID,
        batchSize: COUNT,
        batchIndex: index,
      });
      const sourcePayload = {
        businessPayload,
        targetChainType: avalanche.chainType,
        targetChainID: chainIdToBytes32(avalanche.deployment.chainId),
        targetDomainID: executionDomainID(avalanche),
        targetObject: addressToBytes32(avalanche.deployment.targetContract),
        functionSelector: TARGET_EXECUTE_SELECTOR,
        callDataHash: encoded.compactCallHash,
        businessPayloadHash: hashJson(encoded.normalized),
        receiver: addressToBytes32(avalanche.deployment.targetContract),
        expireAt: Math.floor(Date.now() / 1000) + 3600,
        feedback: parts.feedback,
        atomicity: parts.atomicity,
      };
      const transaction = fabric.contract.createTransaction('LockAssetXCall');
      const transactionID = transaction.getTransactionId();
      const response = JSON.parse((await transaction.submit(JSON.stringify(sourcePayload))).toString());
      submissions.push({ requestID: response.requestID, transactionID });
    }
  } finally {
    fabric.gateway.disconnect();
  }

  const awaiting = await Promise.all(submissions.map((item) => waitForWorkflow(item.requestID, {
    timeoutMs: 10 * 60 * 1000,
  })));
  if (awaiting.some((workflow) => workflow.relayerState !== 'WAITING_RESPONSE')) {
    throw new Error(`Fabric->${PEER_NAME} batch did not reach WAITING_RESPONSE`);
  }
  const targetHashes = [...new Set(awaiting.map((workflow) => workflow.targetResult?.transactionHash))];
  if (targetHashes.length !== 1) throw new Error(`expected one ${PEER_NAME} target transaction, got ${targetHashes.length}`);
  const targetReceipt = await provider.getTransactionReceipt(targetHashes[0]);
  const receiptProof = await buildReceiptProof({
    provider,
    blockNumber: targetReceipt.blockNumber,
    txHash: targetReceipt.hash,
  });
  const chainID = `eip155:${avalanche.deployment.chainId}`;
  const committeeHeaderUpdate = buildCommitteeHeaderUpdate({ header: receiptProof.blockHeader, chainID });
  const responseJobs = [];
  for (let index = 0; index < awaiting.length; index += 1) {
    const workflow = awaiting[index];
    const evidence = await getMaterial(workflow.evidenceKey);
    const delivery = evidence.hxmsg.deliveryMessage || buildDeliveryMessage(evidence.hxmsg);
    const { accepted } = findHXMsgAcceptedLog({
      receipt: targetReceipt,
      gatewayAddress: avalanche.deployment.hxmsgGateway,
      requestID: workflow.requestID,
    });
    const response = buildExecutedResponse({
      originRequestID: workflow.requestID,
      originHmsgDigest: evidence.hxmsg.hmsgDigest,
      targetExecutionHash: delivery.targetExecutionHash,
      targetProofRefHash: buildEvmExecutionProofRef(targetReceipt, {
        originHxmsg: evidence.hxmsg,
        gatewayAddress: avalanche.deployment.hxmsgGateway,
      }),
      responsePayloadHash: accepted.resultHash,
    });
    responseJobs.push({
      requestID: workflow.requestID,
      sourceProfile: 'fabric',
      targetChainType: avalanche.chainType,
      response,
      helperData: {
        originHxmsg: evidence.hxmsg,
        evmExecutionReceipt: receiptProof,
        targetGatewayAddress: avalanche.deployment.hxmsgGateway,
        committeeHeaderUpdate,
        evmRpc: peerTeeRpc(),
      },
    });
  }
  const responseTasks = await enqueueResponses(responseJobs);
  const requestIDs = submissions.map((item) => item.requestID);
  const completed = await completeWorkflowChecks(requestIDs);
  const sourceAfter = await connectFabric(fabricProfile);
  const lifecycle = [];
  let sourceBalanceAfter;
  try {
    sourceBalanceAfter = await fabricBalance(sourceAfter.contract, sourceOwner);
    for (const requestID of requestIDs) {
      lifecycle.push({
        requestID,
        record: await queryFabricJSON(sourceAfter.contract, 'QueryResponseLifecycle', requestID),
        escrow: await queryFabricJSON(sourceAfter.contract, 'QueryAssetEscrow', requestID),
      });
    }
  } finally {
    sourceAfter.gateway.disconnect();
  }
  const targetBalanceAfter = await targetToken.balanceOf(targetRecipient);
  const targetExecutionAfter = await target.executionCount();
  const transfers = targetReceipt.logs.map((log) => {
    try { return targetToken.interface.parseLog(log); } catch (_error) { return null; }
  }).filter((event) => event?.name === 'Transfer'
    && event.args.to.toLowerCase() === targetRecipient.toLowerCase());
  const targetGas = Number(targetReceipt.gasUsed);
  const pass = completed.workflows.every((workflow) => workflow.relayerState === 'COMPLETED')
    && completed.workflows.every((workflow) => workflow.teeBatch?.batchSize === COUNT)
    && completed.watchers.every((workflow) => workflow.watcherState === 'COMPLETED')
    && completed.registrations.every((item) => item.registered && item.watchStatus === 'completed')
    && lifecycle.every((item) => item.record.status === 'Completed' && item.escrow.status === 'Settled')
    && sourceBalanceBefore - sourceBalanceAfter === expectedTotal
    && targetBalanceAfter - targetBalanceBefore === expectedTotal
    && targetExecutionAfter - targetExecutionBefore === BigInt(COUNT)
    && transfers.length === COUNT;
  return {
    direction: `fabric-to-${PEER_NAME}`,
    count: COUNT,
    responseRequired: true,
    atomicityRequired: true,
    sourceTransactions: COUNT,
    targetTransactions: 1,
    responseTransactions: responseTasks.length,
    gas: {
      sourceRequests: 0,
      targetBatchExecution: targetGas,
      responseCompletion: 0,
      protocolTotal: targetGas,
      averagePerMessage: Math.ceil(targetGas / COUNT),
    },
    setupExcluded: { sourceBalanceBeforeInit: sourceBalanceBeforeInit.toString() },
    elapsedMs: Date.now() - startedAt,
    teeBatch: completed.workflows[0]?.teeBatch,
    realActions: {
      sourceOwnerDebited: (sourceBalanceBefore - sourceBalanceAfter).toString(),
      targetTransferred: (targetBalanceAfter - targetBalanceBefore).toString(),
      targetTransferEvents: transfers.length,
      sourceEscrowsSettled: lifecycle.filter((item) => item.escrow.status === 'Settled').length,
      sourceEscrowsRefunded: lifecycle.filter((item) => item.escrow.status === 'Refunded').length,
    },
    lifecycle,
    requestIDs,
    sourceTransactionIDs: submissions.map((item) => item.transactionID),
    targetTransactionHash: targetReceipt.hash,
    pass,
  };
}

async function runAvalancheToFabric() {
  const startedAt = Date.now();
  const runID = `${PEER_NAME}-fabric-${startedAt}`;
  const avalanche = chainProfile(PEER_NAME);
  const fabricProfile = chainProfile('fabric');
  const provider = new ethers.JsonRpcProvider(avalanche.rpc);
  const signer = new ethers.NonceManager(new ethers.Wallet(avalanche.privateKey, provider));
  const sourceArtifactName = PEER_NAME === 'avalanche' ? 'AvalancheWarpSourceContract' : 'EvmSourceContract';
  const sourceArtifact = fs.readJsonSync(path.join(
    ROOT,
    `artifacts/contracts/${sourceArtifactName}.sol/${sourceArtifactName}.json`
  ));
  const tokenArtifact = fs.readJsonSync(path.join(ROOT, 'artifacts/contracts/CrossChainToken.sol/CrossChainToken.json'));
  const sourceAddress = PEER_NAME === 'avalanche'
    ? avalanche.deployment.avalancheWarpSourceContract
    : avalanche.deployment.evmSourceContract;
  const source = new ethers.Contract(sourceAddress, sourceArtifact.abi, signer);
  const sourceOwner = await signer.getAddress();
  const recipients = Array.from({ length: COUNT }, (_, index) => `fabric.atomic.recipient.${runID}.${index}`);
  const expectedTotal = Array.from({ length: COUNT }, (_, index) => BigInt(index + 1) * 10000n)
    .reduce((sum, amount) => sum + amount, 0n);
  const fabric = await connectFabric(fabricProfile);
  const balancesBefore = [];
  try {
    await fabric.contract.submitTransaction(
      'InitAssetBalance',
      'fabric.atomic.batch.reserve',
      'XCST',
      String(expectedTotal / 10000n + 1000n)
    );
    for (const recipient of recipients) balancesBefore.push(await fabricBalance(fabric.contract, recipient));
  } finally {
    fabric.gateway.disconnect();
  }
  const tokenFactory = new ethers.ContractFactory(tokenArtifact.abi, tokenArtifact.bytecode, signer);
  const sourceToken = await tokenFactory.deploy(`${PEER_NAME} Atomic Batch Token`, 'XABT', 4, sourceOwner);
  const tokenDeploymentReceipt = await sourceToken.deploymentTransaction().wait();
  await sourceToken.waitForDeployment();
  const mintReceipt = await (await sourceToken.mint(sourceOwner, expectedTotal)).wait();
  const approvalReceipt = await (await sourceToken.approve(
    sourceAddress,
    expectedTotal
  )).wait();
  const sourceTokenAddress = await sourceToken.getAddress();
  const sourceOwnerBalanceBefore = await sourceToken.balanceOf(sourceOwner);
  const sourceEscrowBalanceBefore = await sourceToken.balanceOf(sourceAddress);
  const sourceBlock = await provider.getBlock('latest');
  const sourceNow = Math.max(Number(sourceBlock.timestamp), Math.floor(Date.now() / 1000));
  const feedbackTimeout = sourceNow + 600;
  const challengeWindow = 60;
  const policyHash = PEER_NAME === 'avalanche' ? await avalanchePolicyHash() : null;
  const targetObject = buildFabricTargetObject(fabricProfile.channel, fabricProfile.chaincode);
  const submissions = [];
  for (let index = 0; index < COUNT; index += 1) {
    const businessPayload = payloadFor(runID, index, recipients[index], sourceOwner);
    const encoded = encodeCompactBusinessCall(businessPayload);
    const parts = atomicParts(runID, index, feedbackTimeout, challengeWindow);
    await publishSourceMaterial(encoded.compactCallHash, {
      targetProfile: 'fabric',
      businessPayload,
      feedback: parts.feedback,
      atomicity: parts.atomicity,
      failureData: parts.failureData,
      batchGroupID: runID,
      batchSize: COUNT,
      batchIndex: index,
    });
    const commonArgs = [
      fabricProfile.chainType,
      bytes32FromText(`fabric-${fabricProfile.channel}`),
      executionDomainID(fabricProfile),
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
        policyHash,
        parts.policy,
        sourceTokenAddress,
        encoded.compact.amount
      )
      : await source.submitTokenEscrowHXMsgRequest(
        ...commonArgs,
        encoded.compactCallHash,
        hashJson(encoded.normalized),
        targetObject,
        sourceNow + 3600,
        parts.policy,
        sourceTokenAddress,
        encoded.compact.amount
      );
    const receipt = await transaction.wait();
    const event = receipt.logs.map((log) => {
      try { return source.interface.parseLog(log); } catch (_error) { return null; }
    }).find((item) => item?.name === (PEER_NAME === 'avalanche'
      ? 'AvalancheHXMsgWarpRequested'
      : 'CrossChainCallRequested'));
    if (!event) throw new Error(`${PEER_NAME} source event missing`);
    submissions.push({ requestID: event.args.requestID, transactionHash: receipt.hash, gasUsed: Number(receipt.gasUsed) });
  }
  const awaiting = await Promise.all(submissions.map((item) => waitForWorkflow(item.requestID, {
    timeoutMs: 10 * 60 * 1000,
  })));
  if (awaiting.some((workflow) => workflow.relayerState !== 'WAITING_RESPONSE')) {
    throw new Error(`${PEER_NAME}->Fabric batch did not reach WAITING_RESPONSE`);
  }
  const targetTransactionIDs = [...new Set(awaiting.map((workflow) => workflow.targetResult?.transactionID))];
  if (targetTransactionIDs.length !== 1) throw new Error(`expected one Fabric target transaction, got ${targetTransactionIDs.length}`);
  const responseJobs = [];
  const targetFabric = await connectFabric(fabricProfile);
  const inboundRecords = [];
  try {
    for (const workflow of awaiting) {
      const evidence = await getMaterial(workflow.evidenceKey);
      const inbound = await queryFabricJSON(targetFabric.contract, 'GetInboundStatus', workflow.requestID);
      inboundRecords.push(inbound);
      const delivery = evidence.hxmsg.deliveryMessage || buildDeliveryMessage(evidence.hxmsg);
      const response = buildExecutedResponse({
        originRequestID: workflow.requestID,
        originHmsgDigest: evidence.hxmsg.hmsgDigest,
        targetExecutionHash: delivery.targetExecutionHash,
        targetProofRefHash: buildFabricExecutionProofRef(inbound, {
          originHxmsg: evidence.hxmsg,
          channelID: fabricProfile.channel,
          chaincodeName: fabricProfile.chaincode,
        }),
        responsePayloadHash: computeFabricExecutionResultHash(inbound),
      });
      responseJobs.push({
        requestID: workflow.requestID,
        sourceProfile: PEER_NAME,
        sourceContract: sourceAddress,
        useWarpSource: PEER_NAME === 'avalanche',
        targetChainType: fabricProfile.chainType,
        response,
        helperData: {
          originHxmsg: evidence.hxmsg,
          fabricExecutionView: buildFabricExecutionViewRef({
            channelID: fabricProfile.channel,
            chaincodeName: fabricProfile.chaincode,
            requestID: workflow.requestID,
          }),
        },
      });
    }
  } finally {
    targetFabric.gateway.disconnect();
  }
  const responseTasks = await enqueueResponses(responseJobs);
  const requestIDs = submissions.map((item) => item.requestID);
  const completed = await completeWorkflowChecks(requestIDs);
  const balancesAfter = [];
  const verifyFabric = await connectFabric(fabricProfile);
  try {
    for (const recipient of recipients) balancesAfter.push(await fabricBalance(verifyFabric.contract, recipient));
  } finally {
    verifyFabric.gateway.disconnect();
  }
  const lifecycle = [];
  for (const requestID of requestIDs) {
    const [record, escrow] = await Promise.all([source.requests(requestID), source.tokenEscrows(requestID)]);
    lifecycle.push({
      requestID,
      status: Number(record.status),
      escrowAmount: escrow.amount.toString(),
      escrowSettled: escrow.settled,
      escrowRefunded: escrow.refunded,
    });
  }
  const sourceOwnerBalanceAfter = await sourceToken.balanceOf(sourceOwner);
  const sourceEscrowBalanceAfter = await sourceToken.balanceOf(sourceAddress);
  const transfersValid = balancesAfter.every((balance, index) => (
    balance - balancesBefore[index] === BigInt(index + 1) * 10000n
  ));
  const sourceGas = submissions.reduce((sum, item) => sum + item.gasUsed, 0);
  const responseGas = responseTasks.reduce((sum, task) => sum + Number(task.result?.gasUsed || 0), 0);
  const protocolGas = sourceGas + responseGas;
  const pass = completed.workflows.every((workflow) => workflow.relayerState === 'COMPLETED')
    && completed.workflows.every((workflow) => workflow.teeBatch?.batchSize === COUNT)
    && completed.watchers.every((workflow) => workflow.watcherState === 'COMPLETED')
    && completed.registrations.every((item) => item.registered && item.watchStatus === 'completed')
    && lifecycle.every((item) => item.status === 3 && item.escrowSettled && !item.escrowRefunded)
    && sourceOwnerBalanceBefore - sourceOwnerBalanceAfter === expectedTotal
    && sourceEscrowBalanceAfter - sourceEscrowBalanceBefore === expectedTotal
    && transfersValid
    && inboundRecords.every((record) => record.status === 'executed');
  return {
    direction: `${PEER_NAME}-to-fabric`,
    count: COUNT,
    responseRequired: true,
    atomicityRequired: true,
    sourceTransactions: COUNT,
    targetTransactions: 1,
    responseTransactions: responseTasks.length,
    gas: {
      sourceRequests: sourceGas,
      targetBatchExecution: 0,
      responseCompletion: responseGas,
      protocolTotal: protocolGas,
      averagePerMessage: Math.ceil(protocolGas / COUNT),
    },
    setupGasExcluded: {
      escrowTokenDeployment: Number(tokenDeploymentReceipt.gasUsed),
      escrowTokenMint: Number(mintReceipt.gasUsed),
      tokenApproval: Number(approvalReceipt.gasUsed),
    },
    elapsedMs: Date.now() - startedAt,
    teeBatch: completed.workflows[0]?.teeBatch,
    realActions: {
      sourceOwnerDebited: (sourceOwnerBalanceBefore - sourceOwnerBalanceAfter).toString(),
      sourceEscrowLocked: (sourceEscrowBalanceAfter - sourceEscrowBalanceBefore).toString(),
      fabricTransfersValid: transfersValid,
      sourceEscrowsSettled: lifecycle.filter((item) => item.escrowSettled).length,
      sourceEscrowsRefunded: lifecycle.filter((item) => item.escrowRefunded).length,
    },
    lifecycle,
    requestIDs,
    sourceTransactionHashes: submissions.map((item) => item.transactionHash),
    targetTransactionID: targetTransactionIDs[0],
    responseTransactionHashes: responseTasks.map((task) => task.result?.transactionHash),
    pass,
  };
}

async function main() {
  const health = await axios.get(`${AUTOMATION_URL}/health`, { headers: authHeaders() });
  if (health.data.roleMode !== 'all') throw new Error(`automation role must be all, got ${health.data.roleMode}`);
  if (!['ethereum', 'avalanche'].includes(PEER_NAME)) throw new Error(`unsupported Fabric EVM peer: ${PEER_NAME}`);
  for (const chain of ['fabric', PEER_NAME]) {
    if (!health.data.enabledChains?.includes(chain)) throw new Error(`automation chain is disabled: ${chain}`);
  }
  const experiments = [];
  console.log(`\n=== Fabric->${PEER_NAME} atomic RESPONSE TEE batch size=${COUNT} ===`);
  experiments.push(await runFabricToAvalanche());
  console.log(`${experiments[0].pass ? 'PASS' : 'FAIL'} fabric-to-${PEER_NAME} gas=${experiments[0].gas.protocolTotal} avg=${experiments[0].gas.averagePerMessage} elapsedMs=${experiments[0].elapsedMs}`);
  console.log(`\n=== ${PEER_NAME}->Fabric atomic RESPONSE TEE batch size=${COUNT} ===`);
  experiments.push(await runAvalancheToFabric());
  console.log(`${experiments[1].pass ? 'PASS' : 'FAIL'} ${PEER_NAME}-to-fabric gas=${experiments[1].gas.protocolTotal} avg=${experiments[1].gas.averagePerMessage} elapsedMs=${experiments[1].elapsedMs}`);
  const result = {
    testType: `automation-fabric-${PEER_NAME}-atomic-response-tee-batch`,
    testedAt: new Date().toISOString(),
    batchSize: COUNT,
    gasAccounting: 'Mercury-style EVM-compatible protocol gas; Fabric source/target/response transactions have no gas; setup excluded',
    experiments,
    pass: experiments.every((experiment) => experiment.pass),
  };
  const output = path.join(ROOT, `runtime/automation-fabric-${PEER_NAME}-atomic-batch-result.json`);
  fs.writeJsonSync(output, result, { spaces: 2 });
  console.log(`Results: ${output}`);
  if (!result.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
