const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');
const { loadDotEnv } = require('../shared/env');
const { encodeCompactBusinessCall } = require('../shared/xmsg');
const { bytes32FromText, hashJson, FeedbackType } = require('../shared/hxmsg');
const { FABRIC_INVOKE_SELECTOR, buildFabricTargetObject } = require('../hxmsg-builder/evm-to-fabric');
const { connectFabric } = require('../automation/fabric-client');
const { chainProfile, executionDomainID } = require('../automation/config');
const { publishSourceMaterial, waitForWorkflow } = require('../automation/client');

loadDotEnv();

const ROOT = path.join(__dirname, '..');
const SOURCE_PROFILE = process.env.AUTOMATION_EVM_SOURCE_PROFILE || 'ethereum';
const SOURCE_ABI = [
  'function submitHXMsgRequest(uint8,bytes32,bytes32,bytes32,bytes4,bytes32,bytes32,bytes32,uint64,(bool,uint8,uint64,bytes32,(bool,uint8,uint8,bytes32,bytes32,bytes32,uint64))) external returns (bytes32)',
  'event CrossChainCallRequested(bytes32 indexed requestID,address indexed sender,bytes32 indexed targetChainID,uint8 targetChainType,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bool feedbackRequired,uint8 expectedFeedbackMsgType,uint64 feedbackTimeout,bytes32 callbackRefHash,bytes32 atomicityHash)',
];

async function queryBalance(account, assetType) {
  const fabric = await connectFabric(chainProfile('fabric'));
  try {
    const response = await fabric.contract.evaluateTransaction('QueryAssetBalance', account, assetType);
    return BigInt(JSON.parse(response.toString()).balanceUnits);
  } finally {
    fabric.gateway.disconnect();
  }
}

async function main() {
  const profile = chainProfile(SOURCE_PROFILE);
  const targetProfile = chainProfile('fabric');
  const deployment = profile.deployment;
  const provider = new ethers.JsonRpcProvider(profile.rpc);
  const source = new ethers.Contract(deployment.evmSourceContract, SOURCE_ABI, new ethers.Wallet(profile.privateKey, provider));
  const recipient = `fabric.automation.recipient.${Date.now()}`;
  const assetType = 'XCST';
  const businessPayload = {
    op: 'asset_lock',
    assetId: `AUTOMATION_EVM_FABRIC_${Date.now()}`,
    assetType,
    amount: '3',
    recipient,
    owner: 'evm.automation.sender',
    metadata: 'automation relayer receipt proof real Fabric asset settlement',
    requireAck: false,
  };
  const encoded = encodeCompactBusinessCall(businessPayload);
  const balanceBefore = await queryBalance(recipient, assetType);
  await publishSourceMaterial(encoded.compactCallHash, {
    targetProfile: 'fabric',
    businessPayload,
    atomicity: { required: false },
  });

  const targetChainID = bytes32FromText('fabric-mychannel');
  const targetDomainID = executionDomainID(targetProfile);
  const targetObject = buildFabricTargetObject('mychannel', 'xcall');
  const expireAt = Math.floor(Date.now() / 1000) + 3600;
  const policy = [false, FeedbackType.NONE, 0, ethers.ZeroHash,
    [false, 0, 0, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 0]];
  const transaction = await source.submitHXMsgRequest(
    targetProfile.chainType,
    targetChainID,
    targetDomainID,
    targetObject,
    FABRIC_INVOKE_SELECTOR,
    encoded.compactCallHash,
    hashJson(encoded.normalized),
    bytes32FromText(recipient),
    expireAt,
    policy
  );
  const receipt = await transaction.wait();
  const event = receipt.logs.map((log) => {
    try { return source.interface.parseLog(log); } catch (_error) { return null; }
  }).find((item) => item?.name === 'CrossChainCallRequested');
  if (!event) throw new Error('CrossChainCallRequested event missing');
  console.log(`SOURCE requestID=${event.args.requestID} tx=${receipt.hash} gas=${receipt.gasUsed}`);

  const workflow = await waitForWorkflow(event.args.requestID, { timeoutMs: 5 * 60 * 1000 });
  if (workflow.relayerState !== 'COMPLETED') throw new Error(`automation workflow ended in ${workflow.relayerState}`);
  const balanceAfter = await queryBalance(recipient, assetType);
  const creditedAmount = balanceAfter - balanceBefore;
  const pass = workflow.targetResult?.ok === true && creditedAmount === 30000n;
  const result = {
    testType: `automation-event-driven-${SOURCE_PROFILE}-to-fabric`,
    testedAt: new Date().toISOString(),
    requestID: event.args.requestID,
    sourceTxHash: receipt.hash,
    sourceGasUsed: Number(receipt.gasUsed),
    targetResult: workflow.targetResult,
    timings: {
      finalityWaitMs: workflow.finalityWaitMs,
      proofBuildMs: workflow.proofBuildMs,
      teeAttestMs: workflow.teeAttestMs,
      targetSubmitMs: workflow.targetSubmitMs,
    },
    realAction: {
      assetType,
      recipient,
      balanceBefore: balanceBefore.toString(),
      balanceAfter: balanceAfter.toString(),
      creditedAmount: creditedAmount.toString(),
    },
    pass,
  };
  fs.writeJsonSync(path.join(ROOT, 'runtime', process.env.AUTOMATION_EVM_FABRIC_RESULT_FILE || 'automation-evm-fabric-e2e-result.json'), result, { spaces: 2 });
  console.log(`${pass ? 'PASS' : 'FAIL'} targetTx=${workflow.targetResult?.transactionID || 'unknown'} credited=${creditedAmount}`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
