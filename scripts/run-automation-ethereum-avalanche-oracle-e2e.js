const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { loadDotEnv } = require('../shared/env');
const { encodeCompactBusinessCall } = require('../shared/xmsg');
const { chainIdToBytes32, bytes32FromText, hashJson, FeedbackType } = require('../shared/hxmsg');
const { publishSourceMaterial, waitForWorkflow } = require('../automation/client');
const { chainProfile, executionDomainID } = require('../automation/config');

loadDotEnv();

const ROOT = path.join(__dirname, '..');
const AUTOMATION_URL = String(process.env.AUTOMATION_URL || 'http://127.0.0.1:9200').replace(/\/$/, '');
const SOURCE_ABI = [
  'function submitHXMsgRequest(uint8,bytes32,bytes32,bytes32,bytes4,bytes32,bytes32,bytes32,uint64,(bool,uint8,uint64,bytes32,(bool,uint8,uint8,bytes32,bytes32,bytes32,uint64))) external returns (bytes32)',
  'event CrossChainCallRequested(bytes32 indexed requestID,address indexed sender,bytes32 indexed targetChainID,uint8 targetChainType,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bool feedbackRequired,uint8 expectedFeedbackMsgType,uint64 feedbackTimeout,bytes32 callbackRefHash,bytes32 atomicityHash)',
];
const TARGET_ABI = [
  'function oracleService() view returns (address)',
  'function getCompactBusinessRecord(bytes32) view returns ((bytes32,uint16,bytes32,bytes32,address,int256,bytes32,bool,address,bytes32,uint64))',
];
const ORACLE_ABI = [
  'function compactLatestRound(bytes32) view returns (bytes32 requestID,bytes32 feedIdHash,bytes32 publisherHash,uint256 priceUnits,bytes32 metadataHash,uint64 updatedAt)',
  'event CompactOracleUpdated(bytes32 indexed requestID,bytes32 indexed feedIdHash,bytes32 indexed publisherHash,uint256 priceUnits)',
];

function authHeaders() {
  return process.env.AUTOMATION_API_KEY ? { authorization: `Bearer ${process.env.AUTOMATION_API_KEY}` } : {};
}

async function watcherChecked(requestID) {
  const response = await axios.get(`${AUTOMATION_URL}/v1/tasks`, {
    params: { workflowID: requestID },
    headers: authHeaders(),
    timeout: Number(process.env.AUTOMATION_CLIENT_TIMEOUT_MS || 30_000),
  });
  const task = response.data.find((item) => item.role === 'watcher-register');
  return Boolean(task && task.status === 'completed' && task.result?.reason === 'watch-not-required');
}

async function main() {
  const sourceProfile = chainProfile('ethereum');
  const targetProfile = chainProfile('avalanche');
  const sourceProvider = new ethers.JsonRpcProvider(sourceProfile.rpc);
  const targetProvider = new ethers.JsonRpcProvider(targetProfile.rpc);
  const source = new ethers.Contract(
    sourceProfile.deployment.evmSourceContract,
    SOURCE_ABI,
    new ethers.Wallet(sourceProfile.privateKey, sourceProvider)
  );
  const target = new ethers.Contract(targetProfile.deployment.targetContract, TARGET_ABI, targetProvider);
  const oracle = new ethers.Contract(await target.oracleService(), ORACLE_ABI, targetProvider);
  const runID = Date.now();
  const payload = {
    op: 'oracle_update',
    feed: `ETH_USD_AUTOMATION_${runID}`,
    price: '3150.1250',
    sourceAgency: 'automation.oracle.non-transfer',
    roundId: runID,
    metadata: 'ordinary non-transfer automation test',
    requireAck: false,
  };
  const encoded = encodeCompactBusinessCall(payload);
  if (Number(encoded.compact.opCode) !== 6) throw new Error('expected oracle_update compact call');

  await publishSourceMaterial(encoded.compactCallHash, {
    targetProfile: 'avalanche',
    businessPayload: payload,
    atomicity: { required: false },
  });
  const targetObject = ethers.zeroPadValue(targetProfile.deployment.targetContract, 32);
  const policy = [false, FeedbackType.NONE, 0, ethers.ZeroHash,
    [false, 0, 0, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 0]];
  const transaction = await source.submitHXMsgRequest(
    targetProfile.chainType,
    chainIdToBytes32(targetProfile.deployment.chainId),
    executionDomainID(targetProfile),
    targetObject,
    ethers.id('executeCompact(bytes32,(uint16,bytes32,bytes32,address,int256,bytes32,bool))').slice(0, 10),
    encoded.compactCallHash,
    hashJson(encoded.normalized),
    targetObject,
    Math.floor(Date.now() / 1000) + 3600,
    policy
  );
  const sourceReceipt = await transaction.wait();
  const requested = sourceReceipt.logs.map((log) => {
    try { return source.interface.parseLog(log); } catch (_error) { return null; }
  }).find((item) => item?.name === 'CrossChainCallRequested');
  if (!requested) throw new Error('CrossChainCallRequested event missing');

  const requestID = requested.args.requestID;
  const workflow = await waitForWorkflow(requestID, {
    timeoutMs: Number(process.env.AUTOMATION_WORKFLOW_TIMEOUT_MS || 5 * 60 * 1000),
  });
  const watcherRegistered = await watcherChecked(requestID);
  const targetReceipt = await targetProvider.getTransactionReceipt(workflow.targetResult?.transactionHash);
  const round = await oracle.compactLatestRound(encoded.compact.recordIdHash);
  const record = await target.getCompactBusinessRecord(requestID);
  const recordOpCode = Number(record.opCode ?? record[1]);
  const oracleEvent = targetReceipt.logs.map((log) => {
    try { return oracle.interface.parseLog(log); } catch (_error) { return null; }
  }).find((item) => item?.name === 'CompactOracleUpdated' && item.args.requestID === requestID);
  const sourceGasUsed = Number(sourceReceipt.gasUsed);
  const targetGasUsed = Number(targetReceipt.gasUsed);
  const pass = workflow.relayerState === 'COMPLETED'
    && watcherRegistered
    && targetReceipt.status === 1
    && round.requestID === requestID
    && round.feedIdHash === encoded.compact.recordIdHash
    && round.publisherHash === encoded.compact.actorHash
    && round.priceUnits === BigInt(encoded.compact.amount)
    && recordOpCode === 6
    && Boolean(oracleEvent);
  const result = {
    testType: 'automation-ethereum-to-avalanche-ordinary-oracle-update',
    testedAt: new Date().toISOString(),
    requestID,
    sourceTransactionHash: sourceReceipt.hash,
    targetTransactionHash: targetReceipt.hash,
    sourceGasUsed,
    targetGasUsed,
    protocolGasTotal: sourceGasUsed + targetGasUsed,
    relayerState: workflow.relayerState,
    watcherChecked: watcherRegistered,
    teeVerification: workflow.teeVerification,
    timings: {
      finalityWaitMs: workflow.finalityWaitMs,
      proofBuildMs: workflow.proofBuildMs,
      teeAttestMs: workflow.teeAttestMs,
      targetSubmitMs: workflow.targetSubmitMs,
    },
    realBusinessAction: {
      oracleService: await target.oracleService(),
      feedIdHash: round.feedIdHash,
      publisherHash: round.publisherHash,
      priceUnits: round.priceUnits.toString(),
      compactRecordOpCode: recordOpCode,
      eventFound: Boolean(oracleEvent),
    },
    pass,
  };
  fs.writeJsonSync(path.join(ROOT, 'runtime/automation-ethereum-avalanche-oracle-e2e-result.json'), result, { spaces: 2 });
  console.log(`${pass ? 'PASS' : 'FAIL'} sourceGas=${sourceGasUsed} targetGas=${targetGasUsed} totalGas=${sourceGasUsed + targetGasUsed}`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
