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
} = require('../shared/hxmsg');
const { TARGET_EXECUTE_SELECTOR } = require('../hxmsg-builder/fabric-to-evm');
const { FABRIC_INVOKE_SELECTOR, buildFabricTargetObject } = require('../hxmsg-builder/evm-to-fabric');
const { connectFabric } = require('../automation/fabric-client');
const { chainProfile } = require('../automation/config');
const { publishSourceMaterial, waitForWorkflow } = require('../automation/client');

loadDotEnv();

const ROOT = path.join(__dirname, '..');
const COUNT = Number(process.env.AUTOMATION_BATCH_EXPERIMENT_SIZE || 8);
const AUTOMATION_URL = String(process.env.AUTOMATION_URL || 'http://127.0.0.1:9200').replace(/\/$/, '');
const LOCAL_KEY = process.env.LOCAL_EVM_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SOURCE_ABI = [
  'function submitHXMsgRequest(bytes32,bytes32,bytes32,bytes4,bytes32,bytes32,bytes32,uint64,(bool,uint8,uint64,bytes32,(bool,uint8,uint8,bytes32,bytes32,bytes32,uint64))) external returns (bytes32)',
  'event CrossChainCallRequested(bytes32 indexed requestID,address indexed sender,bytes32 indexed targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bool feedbackRequired,uint8 expectedFeedbackMsgType,uint64 feedbackTimeout,bytes32 callbackRefHash,bytes32 atomicityHash)',
];

function authHeaders() {
  return process.env.AUTOMATION_API_KEY ? { authorization: `Bearer ${process.env.AUTOMATION_API_KEY}` } : {};
}

function batchMetadata(groupID, index) {
  return { batchGroupID: groupID, batchSize: COUNT, batchIndex: index };
}

function transferPayload(runID, index, targetRecipient) {
  return {
    op: 'token_transfer',
    transferId: `AUTOMATION_TRANSFER_${runID}_${index}`,
    assetType: 'XCST',
    from: 'fabric.automation.batch.reserve',
    to: targetRecipient,
    recipient: targetRecipient,
    targetRecipient,
    amount: String(index + 1),
    metadata: `automation real batch transfer ${index}`,
    requireAck: false,
  };
}

async function watcherChecked(requestID) {
  const response = await axios.get(`${AUTOMATION_URL}/v1/tasks`, {
    params: { workflowID: requestID },
    headers: authHeaders(),
  });
  const task = response.data.find((item) => item.role === 'watcher-register');
  return Boolean(task && task.status === 'completed' && task.result?.reason === 'watch-not-required');
}

async function waitBatch(requestIDs) {
  const workflows = await Promise.all(requestIDs.map((requestID) => waitForWorkflow(requestID, {
    timeoutMs: Number(process.env.AUTOMATION_WORKFLOW_TIMEOUT_MS || 10 * 60 * 1000),
  })));
  const watchers = await Promise.all(requestIDs.map(watcherChecked));
  return { workflows, watchers };
}

async function fabricBalance(contract, account) {
  const response = await contract.evaluateTransaction('QueryAssetBalance', account, 'XCST');
  return BigInt(JSON.parse(response.toString()).balanceUnits);
}

async function runFabricToEthereum({ mode, payloadFactory }) {
  const runID = `${mode}-${Date.now()}`;
  const groupID = `fabric-ethereum-${runID}`;
  const deployment = fs.readJsonSync(path.join(ROOT, 'runtime', 'deployment.json'));
  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC || 'http://127.0.0.1:8545');
  const token = new ethers.Contract(deployment.settlementToken, ['function balanceOf(address) view returns (uint256)'], provider);
  const balanceBefore = await token.balanceOf(deployment.deployer);
  const fabric = await connectFabric(chainProfile('fabric'));
  const sources = [];
  try {
    for (let index = 0; index < COUNT; index += 1) {
      const payload = payloadFactory(runID, index, deployment.deployer);
      const encoded = encodeCompactBusinessCall(payload);
      if (Number(encoded.compact.opCode) !== 9) {
        throw new Error('batch experiments require the gas-optimized token_transfer path');
      }
      await publishSourceMaterial(encoded.compactCallHash, {
        targetProfile: 'ethereum',
        businessPayload: payload,
        atomicity: { required: false },
        ...batchMetadata(groupID, index),
      });
      const sourcePayload = {
        businessPayload: payload,
        targetChainType: 'EVM',
        targetChainID: chainIdToBytes32(deployment.chainId),
        targetObject: addressToBytes32(deployment.targetContract),
        functionSelector: TARGET_EXECUTE_SELECTOR,
        callDataHash: encoded.compactCallHash,
        businessPayloadHash: hashJson(encoded.normalized),
        receiver: addressToBytes32(deployment.targetContract),
        expireAt: Math.floor(Date.now() / 1000) + 3600,
      };
      const transaction = fabric.contract.createTransaction('EmitXCall');
      const transactionID = transaction.getTransactionId();
      const response = JSON.parse((await transaction.submit(JSON.stringify(sourcePayload))).toString());
      sources.push({ requestID: response.requestID, transactionID });
    }
  } finally {
    fabric.gateway.disconnect();
  }
  const { workflows, watchers } = await waitBatch(sources.map((source) => source.requestID));
  const targetHashes = [...new Set(workflows.map((workflow) => workflow.targetResult?.transactionHash))];
  const receipt = targetHashes.length === 1 ? await provider.getTransactionReceipt(targetHashes[0]) : null;
  const balanceAfter = await token.balanceOf(deployment.deployer);
  const expectedTransfer = Array.from({ length: COUNT }, (_, index) => BigInt(index + 1) * 10000n)
    .reduce((sum, value) => sum + value, 0n);
  const pass = workflows.every((workflow) => workflow.relayerState === 'COMPLETED')
    && watchers.every(Boolean)
    && workflows.every((workflow) => workflow.teeBatch?.batchSize === COUNT)
    && targetHashes.length === 1
    && receipt?.status === 1
    && balanceAfter - balanceBefore === expectedTransfer;
  return {
    mode,
    direction: 'fabric-to-ethereum',
    count: COUNT,
    sourceTransactions: sources.length,
    targetTransactions: targetHashes.length,
    targetGasTotal: receipt ? Number(receipt.gasUsed) : 0,
    averageGasPerMessage: receipt ? Math.ceil(Number(receipt.gasUsed) / COUNT) : 0,
    elapsedMs: Math.max(...workflows.map((workflow) => Number(workflow.completedAt || 0)))
      - Math.min(...workflows.map((workflow) => Number(workflow.discoveredAt || workflow.createdAt || 0))),
    batch: workflows[0]?.teeBatch,
    watcherChecked: watchers.every(Boolean),
    optimizedPath: 'executeAssetBatch',
    realTransfer: {
      balanceBefore: balanceBefore.toString(),
      balanceAfter: balanceAfter.toString(),
      transferred: (balanceAfter - balanceBefore).toString(),
      expected: expectedTransfer.toString(),
    },
    requestIDs: sources.map((source) => source.requestID),
    targetTransactionHash: targetHashes[0],
    pass,
  };
}

async function runEthereumToFabric({ mode, payloadFactory }) {
  const runID = `${mode}-${Date.now()}`;
  const groupID = `ethereum-fabric-${runID}`;
  const deployment = fs.readJsonSync(path.join(ROOT, 'runtime', 'deployment.json'));
  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC || 'http://127.0.0.1:8545');
  const signer = new ethers.NonceManager(new ethers.Wallet(LOCAL_KEY, provider));
  const source = new ethers.Contract(deployment.evmSourceContract, SOURCE_ABI, signer);
  const fabric = await connectFabric(chainProfile('fabric'));
  const recipients = Array.from({ length: COUNT }, (_, index) => `fabric.automation.batch.recipient.${runID}.${index}`);
  const balancesBefore = [];
  try {
    const total = Array.from({ length: COUNT }, (_, index) => index + 1).reduce((sum, value) => sum + value, 0);
    await fabric.contract.submitTransaction('InitAssetBalance', 'fabric.automation.batch.reserve', 'XCST', String(total + 1000));
    for (const recipient of recipients) balancesBefore.push(await fabricBalance(fabric.contract, recipient));
  } finally {
    fabric.gateway.disconnect();
  }
  const sources = [];
  const targetChainID = bytes32FromText('fabric-mychannel');
  const targetObject = buildFabricTargetObject('mychannel', 'xcall');
  const policy = [false, FeedbackType.NONE, 0, ethers.ZeroHash,
    [false, 0, 0, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 0]];
  for (let index = 0; index < COUNT; index += 1) {
    const payload = payloadFactory(runID, index, recipients[index]);
    const encoded = encodeCompactBusinessCall(payload);
    if (Number(encoded.compact.opCode) !== 9) {
      throw new Error('batch experiments require the gas-optimized token_transfer path');
    }
    await publishSourceMaterial(encoded.compactCallHash, {
      targetProfile: 'fabric',
      businessPayload: payload,
      atomicity: { required: false },
      ...batchMetadata(groupID, index),
    });
    const transaction = await source.submitHXMsgRequest(
      targetChainID,
      bytes32FromText('fabric-local-domain'),
      targetObject,
      FABRIC_INVOKE_SELECTOR,
      encoded.compactCallHash,
      hashJson(encoded.normalized),
      bytes32FromText(encoded.normalized.actor),
      Math.floor(Date.now() / 1000) + 3600,
      policy
    );
    const receipt = await transaction.wait();
    const event = receipt.logs.map((log) => {
      try { return source.interface.parseLog(log); } catch (_error) { return null; }
    }).find((item) => item?.name === 'CrossChainCallRequested');
    if (!event) throw new Error('CrossChainCallRequested event missing');
    sources.push({ requestID: event.args.requestID, transactionHash: receipt.hash, gasUsed: Number(receipt.gasUsed) });
  }
  const { workflows, watchers } = await waitBatch(sources.map((item) => item.requestID));
  const fabricTxIDs = [...new Set(workflows.map((workflow) => workflow.targetResult?.transactionID))];
  const balancesAfter = [];
  const targetFabric = await connectFabric(chainProfile('fabric'));
  try {
    for (const recipient of recipients) balancesAfter.push(await fabricBalance(targetFabric.contract, recipient));
  } finally {
    targetFabric.gateway.disconnect();
  }
  const transfersValid = balancesAfter.every((after, index) => (
    after - balancesBefore[index] === BigInt(index + 1) * 10000n
  ));
  const sourceGasTotal = sources.reduce((sum, item) => sum + item.gasUsed, 0);
  const pass = workflows.every((workflow) => workflow.relayerState === 'COMPLETED')
    && watchers.every(Boolean)
    && workflows.every((workflow) => workflow.teeBatch?.batchSize === COUNT)
    && fabricTxIDs.length === 1
    && transfersValid;
  return {
    mode,
    direction: 'ethereum-to-fabric',
    count: COUNT,
    sourceTransactions: sources.length,
    sourceGasTotal,
    averageGasPerMessage: Math.ceil(sourceGasTotal / COUNT),
    targetTransactions: fabricTxIDs.length,
    elapsedMs: Math.max(...workflows.map((workflow) => Number(workflow.completedAt || 0)))
      - Math.min(...workflows.map((workflow) => Number(workflow.discoveredAt || workflow.createdAt || 0))),
    batch: workflows[0]?.teeBatch,
    optimizedPath: 'ExecuteHXMsgCompactBatch/ApplyAssetTransferBatch',
    watcherChecked: watchers.every(Boolean),
    realTransfersValid: transfersValid,
    requestIDs: sources.map((item) => item.requestID),
    targetTransactionID: fabricTxIDs[0],
    pass,
  };
}

async function main() {
  const health = await axios.get(`${AUTOMATION_URL}/health`);
  if (!health.data?.ok) throw new Error('automation service is unhealthy');
  const experiments = [];
  experiments.push(await runFabricToEthereum({ mode: 'tee-batch-signing', payloadFactory: transferPayload }));
  experiments.push(await runEthereumToFabric({ mode: 'tee-batch-signing', payloadFactory: transferPayload }));
  experiments.push(await runFabricToEthereum({ mode: 'batch-transfer', payloadFactory: transferPayload }));
  experiments.push(await runEthereumToFabric({ mode: 'batch-transfer', payloadFactory: transferPayload }));
  const result = {
    testType: 'automation-ethereum-fabric-batch-experiments',
    testedAt: new Date().toISOString(),
    count: COUNT,
    executionPolicy: 'all batch experiments require token_transfer and the gas-optimized asset batch path',
    mercuryGasAccounting: 'EVM protocol transactions only; excludes deployment, registration, setup, proof construction, TEE, and Fabric execution',
    experiments,
    pass: experiments.every((experiment) => experiment.pass),
  };
  fs.writeJsonSync(path.join(ROOT, 'runtime', 'automation-ethereum-fabric-batch-experiments.json'), result, { spaces: 2 });
  for (const experiment of experiments) {
    console.log(`${experiment.pass ? 'PASS' : 'FAIL'} ${experiment.mode} ${experiment.direction} avgGas=${experiment.averageGasPerMessage} targetTxs=${experiment.targetTransactions}`);
  }
  if (!result.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
