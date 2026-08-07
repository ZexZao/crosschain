const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');
const { loadDotEnv } = require('../shared/env');
const { encodeCompactBusinessCall } = require('../shared/xmsg');
const { addressToBytes32, chainIdToBytes32, hashJson } = require('../shared/hxmsg');
const { TARGET_EXECUTE_SELECTOR } = require('../hxmsg-builder/fabric-to-evm');
const { connectFabric } = require('../automation/fabric-client');
const { chainProfile } = require('../automation/config');
const { publishSourceMaterial, waitForWorkflow } = require('../automation/client');

loadDotEnv();

const ROOT = path.join(__dirname, '..');

async function main() {
  const targetProfileName = process.env.AUTOMATION_EVM_TARGET_PROFILE || 'ethereum';
  const targetProfile = chainProfile(targetProfileName);
  const targetDeployment = targetProfile.deployment;
  const targetProvider = new ethers.JsonRpcProvider(targetProfile.rpc);
  const token = new ethers.Contract(targetDeployment.settlementToken, [
    'function balanceOf(address) view returns (uint256)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  ], targetProvider);
  const payload = {
    op: 'token_transfer',
    transferId: `AUTOMATION_FABRIC_EVM_${Date.now()}`,
    amount: '3',
    targetRecipient: targetDeployment.deployer,
    metadata: 'automation relayer Fabric h-FSV real token transfer',
    requireAck: false,
  };
  const encoded = encodeCompactBusinessCall(payload);
  const recipientBalanceBefore = await token.balanceOf(targetDeployment.deployer);
  await publishSourceMaterial(encoded.compactCallHash, {
    targetProfile: targetProfileName,
    businessPayload: payload,
    atomicity: { required: false },
  });

  const fabric = await connectFabric(chainProfile('fabric'));
  let source;
  try {
    const sourcePayload = {
      businessPayload: payload,
      targetChainType: 'EVM',
      targetChainID: chainIdToBytes32(targetDeployment.chainId),
      targetObject: addressToBytes32(targetDeployment.targetContract),
      functionSelector: TARGET_EXECUTE_SELECTOR,
      callDataHash: encoded.compactCallHash,
      businessPayloadHash: hashJson(encoded.normalized),
      receiver: addressToBytes32(targetDeployment.targetContract),
      expireAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const transaction = fabric.contract.createTransaction('EmitXCall');
    const transactionID = transaction.getTransactionId();
    const response = JSON.parse((await transaction.submit(JSON.stringify(sourcePayload))).toString());
    source = { transactionID, requestID: response.requestID };
    console.log(`SOURCE requestID=${response.requestID} tx=${transactionID}`);
  } finally {
    fabric.gateway.disconnect();
  }

  const workflow = await waitForWorkflow(source.requestID, { timeoutMs: 5 * 60 * 1000 });
  if (workflow.relayerState !== 'COMPLETED') throw new Error(`automation workflow ended in ${workflow.relayerState}`);
  const targetReceipt = await targetProvider.getTransactionReceipt(workflow.targetResult.transactionHash);
  const recipientBalanceAfter = await token.balanceOf(targetDeployment.deployer);
  const transferredAmount = recipientBalanceAfter - recipientBalanceBefore;
  const transfer = targetReceipt.logs.map((log) => {
    try { return token.interface.parseLog(log); } catch (_error) { return null; }
  }).find((event) => event?.name === 'Transfer'
    && event.args.to.toLowerCase() === targetDeployment.deployer.toLowerCase()
    && event.args.value === BigInt(encoded.compact.amount));
  const pass = targetReceipt.status === 1
    && Boolean(transfer)
    && transferredAmount === BigInt(encoded.compact.amount);
  const result = {
    testType: `automation-event-driven-fabric-to-${targetProfileName}`,
    testedAt: new Date().toISOString(),
    requestID: source.requestID,
    sourceTransactionID: source.transactionID,
    sourceGasUsed: null,
    targetResult: workflow.targetResult,
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
      transferredAmount: transferredAmount.toString(),
      transferEventFound: Boolean(transfer),
    },
    pass,
  };
  fs.writeJsonSync(path.join(ROOT, 'runtime', process.env.AUTOMATION_FABRIC_EVM_RESULT_FILE || 'automation-fabric-evm-e2e-result.json'), result, { spaces: 2 });
  console.log(`${pass ? 'PASS' : 'FAIL'} targetTx=${workflow.targetResult.transactionHash} gas=${workflow.targetResult.gasUsed}`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
