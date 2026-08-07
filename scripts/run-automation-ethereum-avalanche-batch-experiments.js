const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { loadDotEnv } = require('../shared/env');
const { encodeCompactBusinessCall } = require('../shared/xmsg');
const { bytes32FromText, chainIdToBytes32, hashJson, FeedbackType } = require('../shared/hxmsg');
const { getValidatorSetRef } = require('../automation/shared/adapters/avalanche/proof-builder');
const { chainProfile } = require('../automation/config');
const { publishSourceMaterial, waitForWorkflow } = require('../automation/client');

loadDotEnv();

const ROOT = path.join(__dirname, '..');
const COUNT = Number(process.env.AUTOMATION_BATCH_EXPERIMENT_SIZE || 8);
const AUTOMATION_URL = String(process.env.AUTOMATION_URL || 'http://127.0.0.1:9200').replace(/\/$/, '');
const SOURCE_ABI = [
  'function submitHXMsgRequest(bytes32,bytes32,bytes32,bytes4,bytes32,bytes32,bytes32,uint64,(bool,uint8,uint64,bytes32,(bool,uint8,uint8,bytes32,bytes32,bytes32,uint64))) external returns (bytes32)',
  'event CrossChainCallRequested(bytes32 indexed requestID,address indexed sender,bytes32 indexed targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bool feedbackRequired,uint8 expectedFeedbackMsgType,uint64 feedbackTimeout,bytes32 callbackRefHash,bytes32 atomicityHash)',
];
const TARGET_ABI = [
  'function executionCount() view returns (uint256)',
  'event MessageExecuted(bytes32 indexed requestID,address indexed gateway,bytes32 payloadHash,uint256 executionCount)',
];
const TOKEN_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
];
const EXECUTE_COMPACT_SELECTOR = ethers.id(
  'executeCompact(bytes32,(uint16,bytes32,bytes32,address,int256,bytes32,bool))'
).slice(0, 10);
const POLICY = [false, FeedbackType.NONE, 0, ethers.ZeroHash,
  [false, 0, 0, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 0]];

function authHeaders() {
  return process.env.AUTOMATION_API_KEY ? { authorization: `Bearer ${process.env.AUTOMATION_API_KEY}` } : {};
}

function payloadFor(mode, runID, index, recipient) {
  return {
    op: 'token_transfer',
    transferId: `AUTOMATION_OPTIMIZED_${mode}_${runID}_${index}`,
    assetType: 'XCST',
    from: 'automation.batch.reserve',
    to: recipient,
    recipient,
    targetRecipient: recipient,
    amount: String(index + 1),
    metadata: `automation optimized ${mode} transfer ${index}`,
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

async function avalanchePolicyHash() {
  const { ref } = await getValidatorSetRef();
  return hashJson({ validatorSetRef: ref, canonicalOrdering: ref.canonicalOrdering });
}

async function submitEthereumSource({ source, encoded, targetProfile, targetObject }) {
  const transaction = await source.submitHXMsgRequest(
    chainIdToBytes32(targetProfile.deployment.chainId),
    bytes32FromText(`${targetProfile.name}-local-${targetProfile.deployment.chainId}`),
    targetObject,
    EXECUTE_COMPACT_SELECTOR,
    encoded.compactCallHash,
    hashJson(encoded.normalized),
    targetObject,
    Math.floor(Date.now() / 1000) + 3600,
    POLICY
  );
  const receipt = await transaction.wait();
  const event = receipt.logs.map((log) => {
    try { return source.interface.parseLog(log); } catch (_error) { return null; }
  }).find((item) => item?.name === 'CrossChainCallRequested');
  if (!event) throw new Error('CrossChainCallRequested event missing');
  return { requestID: event.args.requestID, transactionHash: receipt.hash, gasUsed: Number(receipt.gasUsed) };
}

async function submitAvalancheSource({ source, encoded, targetProfile, targetObject, validatorPolicyHash }) {
  const transaction = await source.submitWarpHXMsgRequest(
    chainIdToBytes32(targetProfile.deployment.chainId),
    bytes32FromText(`evm-local-${targetProfile.deployment.chainId}`),
    targetObject,
    EXECUTE_COMPACT_SELECTOR,
    encoded.payloadHex,
    hashJson(encoded.normalized),
    targetObject,
    Math.floor(Date.now() / 1000) + 3600,
    validatorPolicyHash,
    POLICY
  );
  const receipt = await transaction.wait();
  const event = receipt.logs.map((log) => {
    try { return source.interface.parseLog(log); } catch (_error) { return null; }
  }).find((item) => item?.name === 'AvalancheHXMsgWarpRequested');
  if (!event) throw new Error('AvalancheHXMsgWarpRequested event missing');
  return { requestID: event.args.requestID, transactionHash: receipt.hash, gasUsed: Number(receipt.gasUsed) };
}

async function runExperiment(sourceName, targetName, mode) {
  const runID = `${sourceName}-${targetName}-${mode}-${Date.now()}`;
  const batchGroupID = runID;
  const sourceProfile = chainProfile(sourceName);
  const targetProfile = chainProfile(targetName);
  const sourceProvider = new ethers.JsonRpcProvider(sourceProfile.rpc);
  const targetProvider = new ethers.JsonRpcProvider(targetProfile.rpc);
  const sourceSigner = new ethers.NonceManager(new ethers.Wallet(sourceProfile.privateKey, sourceProvider));
  const sourceArtifact = sourceName === 'avalanche'
    ? fs.readJsonSync(path.join(ROOT, 'artifacts/contracts/AvalancheWarpSourceContract.sol/AvalancheWarpSourceContract.json'))
    : { abi: SOURCE_ABI };
  const sourceAddress = sourceName === 'avalanche'
    ? sourceProfile.deployment.avalancheWarpSourceContract
    : sourceProfile.deployment.evmSourceContract;
  const source = new ethers.Contract(sourceAddress, sourceArtifact.abi, sourceSigner);
  const target = new ethers.Contract(targetProfile.deployment.targetContract, TARGET_ABI, targetProvider);
  const token = new ethers.Contract(targetProfile.deployment.settlementToken, TOKEN_ABI, targetProvider);
  const targetObject = ethers.zeroPadValue(targetProfile.deployment.targetContract, 32);
  const executionBefore = await target.executionCount();
  const balanceBefore = await token.balanceOf(targetProfile.deployment.deployer);
  const validatorPolicyHash = sourceName === 'avalanche' ? await avalanchePolicyHash() : null;
  const sources = [];

  for (let index = 0; index < COUNT; index += 1) {
    const payload = payloadFor(mode, runID, index, targetProfile.deployment.deployer);
    const encoded = encodeCompactBusinessCall(payload);
    if (Number(encoded.compact.opCode) !== 9) {
      throw new Error('batch experiments require the gas-optimized token_transfer path');
    }
    await publishSourceMaterial(encoded.compactCallHash, {
      targetProfile: targetName,
      businessPayload: payload,
      atomicity: { required: false },
      batchGroupID,
      batchSize: COUNT,
      batchIndex: index,
    });
    const submitted = sourceName === 'avalanche'
      ? await submitAvalancheSource({ source, encoded, targetProfile, targetObject, validatorPolicyHash })
      : await submitEthereumSource({ source, encoded, targetProfile, targetObject });
    sources.push(submitted);
  }

  const workflows = await Promise.all(sources.map((item) => waitForWorkflow(item.requestID, {
    timeoutMs: Number(process.env.AUTOMATION_WORKFLOW_TIMEOUT_MS || 10 * 60 * 1000),
  })));
  const watchers = await Promise.all(sources.map((item) => watcherChecked(item.requestID)));
  const targetHashes = [...new Set(workflows.map((workflow) => workflow.targetResult?.transactionHash))];
  const targetReceipt = targetHashes.length === 1
    ? await targetProvider.getTransactionReceipt(targetHashes[0])
    : null;
  const executionAfter = await target.executionCount();
  const balanceAfter = await token.balanceOf(targetProfile.deployment.deployer);
  const expectedTransfer = Array.from({ length: COUNT }, (_, index) => BigInt(index + 1) * 10000n)
    .reduce((sum, value) => sum + value, 0n);
  const transferEvents = targetReceipt
    ? targetReceipt.logs.map((log) => {
      try { return token.interface.parseLog(log); } catch (_error) { return null; }
    }).filter((item) => item?.name === 'Transfer'
      && item.args.to.toLowerCase() === targetProfile.deployment.deployer.toLowerCase())
    : [];
  const sourceGasTotal = sources.reduce((sum, item) => sum + item.gasUsed, 0);
  const targetGasTotal = targetReceipt ? Number(targetReceipt.gasUsed) : 0;
  const protocolGasTotal = sourceGasTotal + targetGasTotal;
  const elapsedMs = Math.max(...workflows.map((workflow) => Number(workflow.completedAt || 0)))
    - Math.min(...workflows.map((workflow) => Number(workflow.discoveredAt || workflow.createdAt || 0)));
  const businessActionValid = balanceAfter - balanceBefore === expectedTransfer
    && transferEvents.length === COUNT
    && executionAfter - executionBefore === BigInt(COUNT);
  const pass = workflows.every((workflow) => workflow.relayerState === 'COMPLETED')
    && watchers.every(Boolean)
    && workflows.every((workflow) => workflow.teeBatch?.batchSize === COUNT)
    && targetHashes.length === 1
    && targetReceipt?.status === 1
    && businessActionValid;

  return {
    mode,
    direction: `${sourceName}-to-${targetName}`,
    count: COUNT,
    sourceTransactions: sources.length,
    sourceGasTotal,
    targetTransactions: targetHashes.length,
    targetGasTotal,
    protocolGasTotal,
    averageProtocolGasPerMessage: Math.ceil(protocolGasTotal / COUNT),
    elapsedMs,
    batch: workflows[0]?.teeBatch,
    optimizedPath: 'executeAssetBatch',
    watcherChecked: watchers.every(Boolean),
    realBusinessAction: {
      balanceBefore: balanceBefore.toString(),
      balanceAfter: balanceAfter.toString(),
      transferred: (balanceAfter - balanceBefore).toString(),
      expected: expectedTransfer.toString(),
      transferEvents: transferEvents.length,
      executionCountBefore: executionBefore.toString(),
      executionCountAfter: executionAfter.toString(),
      executed: (executionAfter - executionBefore).toString(),
    },
    requestIDs: sources.map((item) => item.requestID),
    sourceTransactionHashes: sources.map((item) => item.transactionHash),
    targetTransactionHash: targetHashes[0],
    pass,
  };
}

async function main() {
  const health = await axios.get(`${AUTOMATION_URL}/health`, { headers: authHeaders() });
  if (!health.data?.ok) throw new Error('automation service is unhealthy');
  for (const name of ['ethereum', 'avalanche']) {
    if (!health.data.enabledChains?.includes(name)) throw new Error(`automation chain is disabled: ${name}`);
  }
  const experiments = [];
  for (const mode of ['tee-batch-signing', 'batch-transfer']) {
    experiments.push(await runExperiment('ethereum', 'avalanche', mode));
    experiments.push(await runExperiment('avalanche', 'ethereum', mode));
  }
  const result = {
    testType: 'automation-ethereum-avalanche-batch-experiments',
    testedAt: new Date().toISOString(),
    count: COUNT,
    executionPolicy: 'all batch experiments require token_transfer and executeAssetBatch; generic high-gas business batches are disabled in experiment drivers',
    gasAccounting: 'source protocol transactions plus the single target batch transaction; excludes deployment, TEE registration when already registered, proof construction and off-chain execution',
    experiments,
    pass: experiments.every((experiment) => experiment.pass),
  };
  fs.writeJsonSync(path.join(ROOT, 'runtime/automation-ethereum-avalanche-batch-experiments.json'), result, { spaces: 2 });
  for (const experiment of experiments) {
    console.log(`${experiment.pass ? 'PASS' : 'FAIL'} ${experiment.mode} ${experiment.direction} totalGas=${experiment.protocolGasTotal} avgGas=${experiment.averageProtocolGasPerMessage} targetTxs=${experiment.targetTransactions} elapsedMs=${experiment.elapsedMs}`);
  }
  if (!result.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
