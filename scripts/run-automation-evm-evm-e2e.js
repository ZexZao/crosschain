const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { loadDotEnv } = require('../shared/env');
const { encodeCompactBusinessCall } = require('../shared/xmsg');
const { chainIdToBytes32, bytes32FromText, hashJson, FeedbackType } = require('../shared/hxmsg');
const { publishSourceMaterial, waitForWorkflow } = require('../automation/client');
const { chainProfile } = require('../automation/config');

loadDotEnv();

const ROOT = path.join(__dirname, '..');
const SOURCE_PROFILE = process.env.AUTOMATION_EVM_SOURCE_PROFILE || 'ethereum';
const TARGET_PROFILE = process.env.AUTOMATION_EVM_TARGET_PROFILE || 'avalanche';
const RESULT_FILE = process.env.AUTOMATION_EVM_EVM_RESULT_FILE
  || process.env.AUTOMATION_EVM_AVALANCHE_RESULT_FILE
  || `automation-${SOURCE_PROFILE}-${TARGET_PROFILE}-e2e-result.json`;
const RESULT_PATH = path.join(ROOT, 'runtime', RESULT_FILE);
const SOURCE_ABI = [
  'function submitHXMsgRequest(bytes32,bytes32,bytes32,bytes4,bytes32,bytes32,bytes32,uint64,(bool,uint8,uint64,bytes32,(bool,uint8,uint8,bytes32,bytes32,bytes32,uint64))) external returns (bytes32)',
  'event CrossChainCallRequested(bytes32 indexed requestID,address indexed sender,bytes32 indexed targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bool feedbackRequired,uint8 expectedFeedbackMsgType,uint64 feedbackTimeout,bytes32 callbackRefHash,bytes32 atomicityHash)',
];

async function watcherChecked(requestID) {
  const baseURL = String(process.env.AUTOMATION_URL || 'http://127.0.0.1:9200').replace(/\/$/, '');
  const response = await axios.get(`${baseURL}/v1/tasks`, {
    params: { workflowID: requestID },
    headers: process.env.AUTOMATION_API_KEY
      ? { authorization: `Bearer ${process.env.AUTOMATION_API_KEY}` }
      : {},
  });
  const task = response.data.find((item) => item.role === 'watcher-register');
  return Boolean(task && task.status === 'completed' && task.result?.reason === 'watch-not-required');
}

async function main() {
  const sourceProfile = chainProfile(SOURCE_PROFILE);
  const targetProfile = chainProfile(TARGET_PROFILE);
  const sourceDeployment = sourceProfile.deployment;
  const targetDeployment = targetProfile.deployment;
  const sourceProvider = new ethers.JsonRpcProvider(sourceProfile.rpc);
  const targetProvider = new ethers.JsonRpcProvider(targetProfile.rpc);
  const source = new ethers.Contract(sourceDeployment.evmSourceContract, SOURCE_ABI, new ethers.Wallet(sourceProfile.privateKey, sourceProvider));
  const targetToken = new ethers.Contract(targetDeployment.settlementToken, [
    'function balanceOf(address) view returns (uint256)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  ], targetProvider);
  const payload = {
    op: 'token_transfer',
    transferId: `AUTOMATION_${SOURCE_PROFILE}_${TARGET_PROFILE}_${Date.now()}`,
    amount: '3',
    targetRecipient: targetDeployment.deployer,
    metadata: `automation ${SOURCE_PROFILE} to ${TARGET_PROFILE} real token transfer`,
    requireAck: false,
  };
  const encoded = encodeCompactBusinessCall(payload);
  const recipientBalanceBefore = await targetToken.balanceOf(targetDeployment.deployer);
  const atomicity = {
    required: false,
    mode: 0,
    commitmentType: 0,
    commitmentRefHash: ethers.ZeroHash,
    successActionHash: ethers.ZeroHash,
    failureActionHash: ethers.ZeroHash,
    challengeWindow: 0,
  };
  await publishSourceMaterial(encoded.compactCallHash, {
    targetProfile: TARGET_PROFILE,
    businessPayload: payload,
    atomicity,
  });
  const targetChainID = chainIdToBytes32(targetDeployment.chainId);
  const targetObject = ethers.zeroPadValue(targetDeployment.targetContract, 32);
  const expireAt = Math.floor(Date.now() / 1000) + 3600;
  const policy = [false, FeedbackType.NONE, 0, ethers.ZeroHash,
    [false, 0, 0, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 0]];
  const tx = await source.submitHXMsgRequest(
    targetChainID,
    bytes32FromText(`${TARGET_PROFILE === 'avalanche' ? 'avalanche' : 'evm'}-local-${targetDeployment.chainId}`),
    targetObject,
    ethers.id('executeCompact(bytes32,(uint16,bytes32,bytes32,address,int256,bytes32,bool))').slice(0, 10),
    encoded.compactCallHash,
    hashJson(encoded.normalized),
    targetObject,
    expireAt,
    policy
  );
  const receipt = await tx.wait();
  const parsed = receipt.logs.map((log) => {
    try { return source.interface.parseLog(log); } catch (_error) { return null; }
  }).find((event) => event?.name === 'CrossChainCallRequested');
  if (!parsed) throw new Error('CrossChainCallRequested event missing');
  console.log(`SOURCE requestID=${parsed.args.requestID} tx=${receipt.hash} gas=${receipt.gasUsed}`);
  fs.writeJsonSync(RESULT_PATH, {
    testType: `automation-event-driven-${SOURCE_PROFILE}-to-${TARGET_PROFILE}`,
    testedAt: new Date().toISOString(),
    sourceProfile: SOURCE_PROFILE,
    targetProfile: TARGET_PROFILE,
    phase: 'WAITING_AUTOMATION',
    inProgress: true,
    requestID: parsed.args.requestID,
    sourceTxHash: receipt.hash,
    sourceGasUsed: Number(receipt.gasUsed),
    expectedTransfer: {
      token: targetDeployment.settlementToken,
      recipient: targetDeployment.deployer,
      amount: encoded.compact.amount.toString(),
      balanceBefore: recipientBalanceBefore.toString(),
    },
    pass: false,
  }, { spaces: 2 });
  const workflowTimeoutMs = SOURCE_PROFILE === 'sepolia'
    ? Number(process.env.SEPOLIA_FINALITY_TIMEOUT_MS || 40 * 60 * 1000)
    : Number(process.env.AUTOMATION_WORKFLOW_TIMEOUT_MS || 5 * 60 * 1000);
  const workflow = await waitForWorkflow(parsed.args.requestID, {
    timeoutMs: workflowTimeoutMs,
    progressIntervalMs: Number(process.env.AUTOMATION_PROGRESS_INTERVAL_MS || 30_000),
    onProgress: ({ workflow: current, elapsedMs, timeoutMs }) => {
      const state = current?.relayerState || 'DISCOVERING';
      const finalityMs = Number(current?.finalityWaitMs || 0);
      console.log(`WAIT requestID=${parsed.args.requestID} state=${state} elapsedMs=${elapsedMs}/${timeoutMs} finalityWaitMs=${finalityMs}`);
    },
  });
  if (workflow.relayerState !== 'COMPLETED') throw new Error(`automation workflow ended in ${workflow.relayerState}`);
  const watcherRegistered = await watcherChecked(parsed.args.requestID);

  const recipientBalanceAfter = await targetToken.balanceOf(targetDeployment.deployer);
  const targetReceipt = await targetProvider.getTransactionReceipt(workflow.targetResult.transactionHash);
  const transfer = targetReceipt.logs.map((log) => {
    try { return targetToken.interface.parseLog(log); } catch (_error) { return null; }
  }).find((event) => event?.name === 'Transfer'
    && event.args.to.toLowerCase() === targetDeployment.deployer.toLowerCase()
    && event.args.value === BigInt(encoded.compact.amount));
  const amount = recipientBalanceAfter - recipientBalanceBefore;
  const pass = targetReceipt.status === 1
    && Boolean(transfer)
    && amount === BigInt(encoded.compact.amount)
    && watcherRegistered;
  const result = {
    testType: `automation-event-driven-${SOURCE_PROFILE}-to-${TARGET_PROFILE}`,
    testedAt: new Date().toISOString(),
    sourceProfile: SOURCE_PROFILE,
    targetProfile: TARGET_PROFILE,
    phase: 'COMPLETED',
    inProgress: false,
    requestID: parsed.args.requestID,
    sourceTxHash: receipt.hash,
    sourceGasUsed: Number(receipt.gasUsed),
    targetResult: workflow.targetResult,
    relayerState: workflow.relayerState,
    watcherRegistered,
    teeVerification: workflow.teeVerification,
    timings: {
      finalityWaitMs: workflow.finalityWaitMs,
      proofBuildMs: workflow.proofBuildMs,
      teeAttestMs: workflow.teeAttestMs,
      targetSubmitMs: workflow.targetSubmitMs,
    },
    realAction: {
      token: targetDeployment.settlementToken,
      recipient: targetDeployment.deployer,
      balanceBefore: recipientBalanceBefore.toString(),
      balanceAfter: recipientBalanceAfter.toString(),
      transferredAmount: amount.toString(),
      transferEventFound: Boolean(transfer),
    },
    pass,
  };
  fs.writeJsonSync(RESULT_PATH, result, { spaces: 2 });
  console.log(`${pass ? 'PASS' : 'FAIL'} targetTx=${workflow.targetResult?.transactionHash} gas=${workflow.targetResult?.gasUsed}`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  if (fs.existsSync(RESULT_PATH)) {
    const partial = fs.readJsonSync(RESULT_PATH, { throws: false }) || {};
    fs.writeJsonSync(RESULT_PATH, {
      ...partial,
      phase: 'CLIENT_EXITED_BEFORE_VERIFICATION',
      monitoringInterrupted: true,
      workflowMayContinue: true,
      clientExitedAt: new Date().toISOString(),
      clientError: error.message,
      pass: false,
    }, { spaces: 2 });
  }
  console.error(error.stack || error.message);
  process.exit(1);
});
