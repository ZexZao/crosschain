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
const { getValidatorSetRef } = require('../automation/shared/adapters/avalanche/proof-builder');
const { connectFabric } = require('../automation/fabric-client');
const { chainProfile } = require('../automation/config');
const { publishSourceMaterial, waitForWorkflow } = require('../automation/client');

loadDotEnv();

const ROOT = path.join(__dirname, '..');
const COUNT = Number(process.env.AUTOMATION_BATCH_EXPERIMENT_SIZE || 8);
const AUTOMATION_URL = String(process.env.AUTOMATION_URL || 'http://127.0.0.1:9200').replace(/\/$/, '');
const POLICY = [false, FeedbackType.NONE, 0, ethers.ZeroHash,
  [false, 0, 0, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 0]];

function authHeaders() {
  return process.env.AUTOMATION_API_KEY
    ? { authorization: `Bearer ${process.env.AUTOMATION_API_KEY}` }
    : {};
}

function payloadFor(mode, runID, index, recipient) {
  return {
    op: 'token_transfer',
    transferId: `FABRIC_AVALANCHE_${mode}_${runID}_${index}`,
    assetType: 'XCST',
    from: 'fabric.avalanche.batch.reserve',
    to: recipient,
    recipient,
    targetRecipient: recipient,
    amount: String(index + 1),
    metadata: `fabric avalanche ${mode} real transfer ${index}`,
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

async function avalanchePolicyHash() {
  const { ref } = await getValidatorSetRef();
  return hashJson({ validatorSetRef: ref, canonicalOrdering: ref.canonicalOrdering });
}

async function runFabricToAvalanche(mode) {
  const startedAt = Date.now();
  const runID = `${mode}-${startedAt}`;
  const groupID = `fabric-avalanche-${runID}`;
  const targetProfile = chainProfile('avalanche');
  const provider = new ethers.JsonRpcProvider(targetProfile.rpc);
  const token = new ethers.Contract(
    targetProfile.deployment.settlementToken,
    ['function balanceOf(address) view returns (uint256)', 'event Transfer(address indexed from,address indexed to,uint256 value)'],
    provider
  );
  const target = new ethers.Contract(
    targetProfile.deployment.targetContract,
    ['function executionCount() view returns (uint256)'],
    provider
  );
  const balanceBefore = await token.balanceOf(targetProfile.deployment.deployer);
  const executionBefore = await target.executionCount();
  const fabric = await connectFabric(chainProfile('fabric'));
  const sources = [];
  try {
    for (let index = 0; index < COUNT; index += 1) {
      const payload = payloadFor(mode, runID, index, targetProfile.deployment.deployer);
      const encoded = encodeCompactBusinessCall(payload);
      if (Number(encoded.compact.opCode) !== 9) throw new Error('asset batch requires compact token_transfer');
      await publishSourceMaterial(encoded.compactCallHash, {
        targetProfile: 'avalanche',
        businessPayload: payload,
        atomicity: { required: false },
        batchGroupID: groupID,
        batchSize: COUNT,
        batchIndex: index,
      });
      const sourcePayload = {
        businessPayload: payload,
        targetChainType: 'AVALANCHE',
        targetChainID: chainIdToBytes32(targetProfile.deployment.chainId),
        targetObject: addressToBytes32(targetProfile.deployment.targetContract),
        functionSelector: TARGET_EXECUTE_SELECTOR,
        callDataHash: encoded.compactCallHash,
        businessPayloadHash: hashJson(encoded.normalized),
        receiver: addressToBytes32(targetProfile.deployment.targetContract),
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
  const { workflows, watchers } = await waitBatch(sources.map((item) => item.requestID));
  const targetHashes = [...new Set(workflows.map((workflow) => workflow.targetResult?.transactionHash))];
  const receipt = targetHashes.length === 1 ? await provider.getTransactionReceipt(targetHashes[0]) : null;
  const balanceAfter = await token.balanceOf(targetProfile.deployment.deployer);
  const executionAfter = await target.executionCount();
  const expected = Array.from({ length: COUNT }, (_, index) => BigInt(index + 1) * 10000n)
    .reduce((sum, amount) => sum + amount, 0n);
  const transferEvents = receipt ? receipt.logs.map((log) => {
    try { return token.interface.parseLog(log); } catch (_error) { return null; }
  }).filter((event) => event?.name === 'Transfer'
    && event.args.to.toLowerCase() === targetProfile.deployment.deployer.toLowerCase()) : [];
  const targetGas = receipt ? Number(receipt.gasUsed) : 0;
  const pass = workflows.every((workflow) => workflow.relayerState === 'COMPLETED')
    && workflows.every((workflow) => workflow.teeBatch?.batchSize === COUNT)
    && watchers.every(Boolean)
    && targetHashes.length === 1
    && receipt?.status === 1
    && balanceAfter - balanceBefore === expected
    && executionAfter - executionBefore === BigInt(COUNT)
    && transferEvents.length === COUNT;
  return {
    mode,
    direction: 'fabric-to-avalanche',
    count: COUNT,
    sourceTransactions: sources.length,
    targetTransactions: targetHashes.length,
    evmProtocolGasTotal: targetGas,
    averageGasPerMessage: Math.ceil(targetGas / COUNT),
    elapsedMs: Date.now() - startedAt,
    teeBatch: workflows[0]?.teeBatch,
    optimizedPath: 'executeFabricEVMCompactBatchCluster/executeAssetBatch',
    watcherChecked: watchers.every(Boolean),
    realTransfer: {
      balanceBefore: balanceBefore.toString(),
      balanceAfter: balanceAfter.toString(),
      transferred: (balanceAfter - balanceBefore).toString(),
      expected: expected.toString(),
      transferEvents: transferEvents.length,
      executionCountBefore: executionBefore.toString(),
      executionCountAfter: executionAfter.toString(),
    },
    sourceTransactionIDs: sources.map((item) => item.transactionID),
    targetTransactionHash: targetHashes[0],
    pass,
  };
}

async function runAvalancheToFabric(mode) {
  const startedAt = Date.now();
  const runID = `${mode}-${startedAt}`;
  const groupID = `avalanche-fabric-${runID}`;
  const sourceProfile = chainProfile('avalanche');
  const provider = new ethers.JsonRpcProvider(sourceProfile.rpc);
  const signer = new ethers.NonceManager(new ethers.Wallet(sourceProfile.privateKey, provider));
  const artifact = fs.readJsonSync(path.join(
    ROOT,
    'artifacts/contracts/AvalancheWarpSourceContract.sol/AvalancheWarpSourceContract.json'
  ));
  const source = new ethers.Contract(sourceProfile.deployment.avalancheWarpSourceContract, artifact.abi, signer);
  const fabricProfile = chainProfile('fabric');
  const recipients = Array.from({ length: COUNT }, (_, index) => (
    `fabric.avalanche.batch.recipient.${runID}.${index}`
  ));
  const balancesBefore = [];
  const fabric = await connectFabric(fabricProfile);
  try {
    const total = Array.from({ length: COUNT }, (_, index) => index + 1).reduce((sum, amount) => sum + amount, 0);
    await fabric.contract.submitTransaction(
      'InitAssetBalance',
      'fabric.avalanche.batch.reserve',
      'XCST',
      String(total + 1000)
    );
    for (const recipient of recipients) balancesBefore.push(await fabricBalance(fabric.contract, recipient));
  } finally {
    fabric.gateway.disconnect();
  }
  const targetObject = buildFabricTargetObject(fabricProfile.channel, fabricProfile.chaincode);
  const policyHash = await avalanchePolicyHash();
  const sources = [];
  for (let index = 0; index < COUNT; index += 1) {
    const payload = payloadFor(mode, runID, index, recipients[index]);
    const encoded = encodeCompactBusinessCall(payload);
    if (Number(encoded.compact.opCode) !== 9) throw new Error('asset batch requires compact token_transfer');
    await publishSourceMaterial(encoded.compactCallHash, {
      targetProfile: 'fabric',
      businessPayload: payload,
      atomicity: { required: false },
      batchGroupID: groupID,
      batchSize: COUNT,
      batchIndex: index,
    });
    const transaction = await source.submitWarpHXMsgRequest(
      bytes32FromText(`fabric-${fabricProfile.channel}`),
      bytes32FromText('fabric-local-domain'),
      targetObject,
      FABRIC_INVOKE_SELECTOR,
      encoded.payloadHex,
      hashJson(encoded.normalized),
      targetObject,
      Math.floor(Date.now() / 1000) + 3600,
      policyHash,
      POLICY
    );
    const receipt = await transaction.wait();
    const event = receipt.logs.map((log) => {
      try { return source.interface.parseLog(log); } catch (_error) { return null; }
    }).find((item) => item?.name === 'AvalancheHXMsgWarpRequested');
    if (!event) throw new Error('AvalancheHXMsgWarpRequested event missing');
    sources.push({
      requestID: event.args.requestID,
      transactionHash: receipt.hash,
      gasUsed: Number(receipt.gasUsed),
    });
  }
  const { workflows, watchers } = await waitBatch(sources.map((item) => item.requestID));
  const targetTransactionIDs = [...new Set(workflows.map((workflow) => workflow.targetResult?.transactionID))];
  const balancesAfter = [];
  const targetFabric = await connectFabric(fabricProfile);
  try {
    for (const recipient of recipients) balancesAfter.push(await fabricBalance(targetFabric.contract, recipient));
  } finally {
    targetFabric.gateway.disconnect();
  }
  const transfersValid = balancesAfter.every((balance, index) => (
    balance - balancesBefore[index] === BigInt(index + 1) * 10000n
  ));
  const sourceGas = sources.reduce((sum, item) => sum + item.gasUsed, 0);
  const pass = workflows.every((workflow) => workflow.relayerState === 'COMPLETED')
    && workflows.every((workflow) => workflow.teeBatch?.batchSize === COUNT)
    && watchers.every(Boolean)
    && targetTransactionIDs.length === 1
    && transfersValid;
  return {
    mode,
    direction: 'avalanche-to-fabric',
    count: COUNT,
    sourceTransactions: sources.length,
    targetTransactions: targetTransactionIDs.length,
    evmProtocolGasTotal: sourceGas,
    averageGasPerMessage: Math.ceil(sourceGas / COUNT),
    elapsedMs: Date.now() - startedAt,
    teeBatch: workflows[0]?.teeBatch,
    optimizedPath: 'ExecuteHXMsgCompactBatch/ApplyAssetTransferBatch',
    watcherChecked: watchers.every(Boolean),
    realTransfersValid: transfersValid,
    sourceTransactionHashes: sources.map((item) => item.transactionHash),
    targetTransactionID: targetTransactionIDs[0],
    pass,
  };
}

async function main() {
  const health = await axios.get(`${AUTOMATION_URL}/health`, { headers: authHeaders() });
  if (health.data.roleMode !== 'all') throw new Error(`automation role must be all, got ${health.data.roleMode}`);
  for (const chain of ['fabric', 'avalanche']) {
    if (!health.data.enabledChains?.includes(chain)) throw new Error(`automation chain is disabled: ${chain}`);
  }
  const experiments = [];
  for (const mode of ['tee-batch-signing', 'batch-transfer']) {
    experiments.push(await runFabricToAvalanche(mode));
    experiments.push(await runAvalancheToFabric(mode));
  }
  const result = {
    testType: 'automation-fabric-avalanche-batch-experiments',
    testedAt: new Date().toISOString(),
    count: COUNT,
    executionPolicy: 'TEE batch attestation plus one real target asset batch transaction',
    mercuryGasAccounting: 'EVM-compatible protocol transactions only; Fabric has no gas and setup is excluded',
    experiments,
    pass: experiments.every((experiment) => experiment.pass),
  };
  const output = path.join(ROOT, 'runtime/automation-fabric-avalanche-batch-experiments.json');
  fs.writeJsonSync(output, result, { spaces: 2 });
  for (const experiment of experiments) {
    console.log(`${experiment.pass ? 'PASS' : 'FAIL'} ${experiment.mode} ${experiment.direction} totalGas=${experiment.evmProtocolGasTotal} avgGas=${experiment.averageGasPerMessage} elapsedMs=${experiment.elapsedMs}`);
  }
  console.log(`Results: ${output}`);
  if (!result.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
