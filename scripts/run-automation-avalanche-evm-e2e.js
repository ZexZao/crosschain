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
const AUTOMATION_URL = String(process.env.AUTOMATION_URL || 'http://127.0.0.1:9200').replace(/\/$/, '');

function headers() {
  return process.env.AUTOMATION_API_KEY ? { authorization: `Bearer ${process.env.AUTOMATION_API_KEY}` } : {};
}

async function watcherChecked(requestID) {
  const response = await axios.get(`${AUTOMATION_URL}/v1/tasks`, {
    params: { workflowID: requestID },
    headers: headers(),
  });
  const task = response.data.find((item) => item.role === 'watcher-register');
  return Boolean(task && task.status === 'completed' && task.result?.reason === 'watch-not-required');
}

async function main() {
  const sourceProfile = chainProfile('avalanche');
  const targetProfileName = process.env.AUTOMATION_EVM_TARGET_PROFILE || 'ethereum';
  const targetProfile = chainProfile(targetProfileName);
  const sourceArtifact = fs.readJsonSync(path.join(
    ROOT, 'artifacts', 'contracts', 'AvalancheWarpSourceContract.sol', 'AvalancheWarpSourceContract.json'
  ));
  const sourceProvider = new ethers.JsonRpcProvider(sourceProfile.rpc);
  const targetProvider = new ethers.JsonRpcProvider(targetProfile.rpc);
  const source = new ethers.Contract(
    sourceProfile.deployment.avalancheWarpSourceContract,
    sourceArtifact.abi,
    new ethers.Wallet(sourceProfile.privateKey, sourceProvider)
  );
  const targetToken = new ethers.Contract(targetProfile.deployment.settlementToken, [
    'function balanceOf(address) view returns (uint256)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  ], targetProvider);
  const payload = {
    op: 'token_transfer',
    transferId: `AUTOMATION_AVALANCHE_EVM_${Date.now()}`,
    assetType: 'XCST',
    from: 'avalanche.automation.sender',
    amount: '3',
    targetRecipient: targetProfile.deployment.deployer,
    metadata: 'automation Relayer Avalanche Warp real token transfer',
    requireAck: false,
  };
  const encoded = encodeCompactBusinessCall(payload);
  const balanceBefore = await targetToken.balanceOf(targetProfile.deployment.deployer);
  await publishSourceMaterial(encoded.compactCallHash, {
    targetProfile: targetProfileName,
    businessPayload: payload,
    atomicity: { required: false },
  });
  const { ref: validatorSetRef } = await getValidatorSetRef();
  const validatorPolicyHash = hashJson({
    validatorSetRef,
    canonicalOrdering: validatorSetRef.canonicalOrdering,
  });
  const targetObject = ethers.zeroPadValue(targetProfile.deployment.targetContract, 32);
  const policy = [false, FeedbackType.NONE, 0, ethers.ZeroHash,
    [false, 0, 0, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 0]];
  const transaction = await source.submitWarpHXMsgRequest(
    chainIdToBytes32(targetProfile.deployment.chainId),
    bytes32FromText(`evm-local-${targetProfile.deployment.chainId}`),
    targetObject,
    ethers.id('executeCompact(bytes32,(uint16,bytes32,bytes32,address,int256,bytes32,bool))').slice(0, 10),
    encoded.payloadHex,
    hashJson(encoded.normalized),
    targetObject,
    Math.floor(Date.now() / 1000) + 3600,
    validatorPolicyHash,
    policy
  );
  const receipt = await transaction.wait();
  const event = receipt.logs.map((log) => {
    try { return source.interface.parseLog(log); } catch (_error) { return null; }
  }).find((item) => item?.name === 'AvalancheHXMsgWarpRequested');
  if (!event) throw new Error('AvalancheHXMsgWarpRequested event missing');
  console.log(`SOURCE requestID=${event.args.requestID} tx=${receipt.hash} gas=${receipt.gasUsed}`);

  const workflow = await waitForWorkflow(event.args.requestID, { timeoutMs: 10 * 60 * 1000 });
  const watcherRegistered = await watcherChecked(event.args.requestID);
  const targetReceipt = await targetProvider.getTransactionReceipt(workflow.targetResult?.transactionHash);
  const balanceAfter = await targetToken.balanceOf(targetProfile.deployment.deployer);
  const transferredAmount = balanceAfter - balanceBefore;
  const transfer = targetReceipt?.logs.map((log) => {
    try { return targetToken.interface.parseLog(log); } catch (_error) { return null; }
  }).find((item) => item?.name === 'Transfer'
    && item.args.to.toLowerCase() === targetProfile.deployment.deployer.toLowerCase()
    && item.args.value === BigInt(encoded.compact.amount));
  const pass = workflow.relayerState === 'COMPLETED'
    && watcherRegistered
    && targetReceipt?.status === 1
    && Boolean(transfer)
    && transferredAmount === BigInt(encoded.compact.amount);
  const result = {
    testType: `automation-event-driven-avalanche-to-${targetProfileName}`,
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
    relayerState: workflow.relayerState,
    watcherRegistered,
    teeVerification: workflow.teeVerification,
    realAction: {
      token: targetProfile.deployment.settlementToken,
      recipient: targetProfile.deployment.deployer,
      balanceBefore: balanceBefore.toString(),
      balanceAfter: balanceAfter.toString(),
      transferredAmount: transferredAmount.toString(),
      transferEventFound: Boolean(transfer),
    },
    pass,
  };
  fs.writeJsonSync(path.join(ROOT, 'runtime', process.env.AUTOMATION_AVALANCHE_EVM_RESULT_FILE || 'automation-avalanche-ethereum-e2e-result.json'), result, { spaces: 2 });
  console.log(`${pass ? 'PASS' : 'FAIL'} targetTx=${workflow.targetResult?.transactionHash} gas=${workflow.targetResult?.gasUsed}`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
