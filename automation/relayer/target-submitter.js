const { ethers } = require('ethers');
const { ChainType, toMinimalHXMsg, getExecutionData } = require('../../shared/hxmsg');
const { compactBusinessCallTuple } = require('../../shared/xmsg');
const { registerEVMTEEs, registerFabricTEEs, clusterCertificateTuple } = require('../../shared/tee/registration');
const { connectFabric } = require('../fabric-client');
const { teeURLs } = require('../config');

const GatewayArtifact = require('../../artifacts/contracts/HXMsgGateway.sol/HXMsgGateway.json');
const RegistryArtifact = require('../../artifacts/contracts/TEERegistry.sol/TEERegistry.json');
const CLUSTER_CERT_ABI = '(bytes32,uint8,bytes32,uint64,uint16,uint16,uint256,bytes32,bytes,bytes32,bytes32,uint64,uint64)';

function walletFor(profile) {
  const provider = new ethers.JsonRpcProvider(profile.rpc);
  return new ethers.NonceManager(new ethers.Wallet(profile.privateKey, provider));
}

async function submitToEVM(targetProfile, hxmsg, execution, certificate) {
  const signer = walletFor(targetProfile);
  const deployment = targetProfile.deployment;
  const registry = new ethers.Contract(deployment.teeRegistry, RegistryArtifact.abi, signer);
  await registerEVMTEEs({
    registry,
    certificate,
    teeURLs: teeURLs(Number(hxmsg.source.chainType)),
  });
  const gateway = new ethers.Contract(deployment.hxmsgGateway, GatewayArtifact.abi, signer);
  const target = execution.target || deployment.targetContract;
  if (!execution.compactCall) throw new Error('compact target execution is required');
  const transaction = await gateway.executeHXMsgMinimalCompactCluster(
    toMinimalHXMsg(hxmsg), target, execution.compactCall, clusterCertificateTuple(certificate)
  );
  const receipt = await transaction.wait();
  return {
    transactionHash: receipt.hash,
    blockNumber: Number(receipt.blockNumber),
    gasUsed: receipt.gasUsed.toString(),
  };
}

async function submitToFabric(targetProfile, hxmsg, execution, certificate) {
  const { gateway, contract } = await connectFabric(targetProfile);
  try {
    await registerFabricTEEs({
      contract,
      certificate,
      teeURLs: teeURLs(Number(hxmsg.source.chainType)),
    });
    const minimal = toMinimalHXMsg(hxmsg);
    const delivery = {
      requestID: minimal[0], hmsgDigest: minimal[1], targetChainType: Number(minimal[2]), targetChainID: minimal[3],
      actionType: Number(minimal[4]), targetObject: minimal[5], functionSelector: minimal[6], callDataHash: minimal[7],
      receiver: minimal[8], targetExecutionHash: minimal[9], feedbackRequired: Boolean(minimal[10]),
      expectedFeedbackMsgType: Number(minimal[11]), feedbackTimeout: Number(minimal[12]), callbackRefHash: minimal[13],
      expireAt: Number(minimal[14]), replayScope: minimal[15], sourceNonce: Number(minimal[16]),
      sourceChainType: Number(minimal[17]), sourceChainID: minimal[18], targetDomainID: minimal[19],
    };
    const data = execution.compactCall ? execution : getExecutionData(hxmsg);
    const transaction = contract.createTransaction('ExecuteHXMsgCompact');
    const transactionID = transaction.getTransactionId();
    const response = await transaction.submit(
      JSON.stringify(delivery),
      JSON.stringify(data.compactCall),
      JSON.stringify(data.businessPayload),
      JSON.stringify(certificate)
    );
    return { ...JSON.parse(response.toString()), transactionID };
  } finally {
    gateway.disconnect();
  }
}

async function submitTarget({ targetProfile, hxmsg, execution, certificate }) {
  return targetProfile.kind === 'fabric'
    ? submitToFabric(targetProfile, hxmsg, execution, certificate)
    : submitToEVM(targetProfile, hxmsg, execution, certificate);
}

function compactFabricDelivery(hxmsg) {
  const minimal = toMinimalHXMsg(hxmsg);
  return [minimal[0], minimal[1], minimal[7], minimal[14], minimal[15], minimal[16], minimal[17], minimal[18], minimal[19]];
}

function fabricDelivery(hxmsg) {
  const minimal = toMinimalHXMsg(hxmsg);
  return {
    requestID: minimal[0], hmsgDigest: minimal[1], targetChainType: Number(minimal[2]), targetChainID: minimal[3],
    actionType: Number(minimal[4]), targetObject: minimal[5], functionSelector: minimal[6], callDataHash: minimal[7],
    receiver: minimal[8], targetExecutionHash: minimal[9], feedbackRequired: Boolean(minimal[10]),
    expectedFeedbackMsgType: Number(minimal[11]), feedbackTimeout: Number(minimal[12]), callbackRefHash: minimal[13],
    expireAt: Number(minimal[14]), replayScope: minimal[15], sourceNonce: Number(minimal[16]),
    sourceChainType: Number(minimal[17]), sourceChainID: minimal[18], targetDomainID: minimal[19],
  };
}

async function submitBatchToEVM(targetProfile, items, batch) {
  const signer = walletFor(targetProfile);
  const deployment = targetProfile.deployment;
  const registry = new ethers.Contract(deployment.teeRegistry, RegistryArtifact.abi, signer);
  await registerEVMTEEs({
    registry,
    certificate: batch.certificate,
    teeURLs: teeURLs(Number(items[0].hxmsg.source.chainType)),
  });
  const target = items[0].execution.target || deployment.targetContract;
  if (items.some((item) => (item.execution.target || deployment.targetContract).toLowerCase() !== target.toLowerCase())) {
    throw new Error('automation batch contains multiple EVM target contracts');
  }
  const sourceChainType = Number(items[0].hxmsg.source.chainType);
  if (items.some((item) => Number(item.hxmsg.source.chainType) !== sourceChainType)) {
    throw new Error('automation batch contains multiple source chain types');
  }
  const gateway = new ethers.Contract(deployment.hxmsgGateway, GatewayArtifact.abi, signer);
  const calls = items.map((item) => compactBusinessCallTuple(item.execution.compactCall));
  const useFabricFastPath = sourceChainType === ChainType.FABRIC
    && items.every((item) => !item.hxmsg.feedback?.required && !item.hxmsg.atomicity?.required);
  const transaction = useFabricFastPath
    ? await gateway[`executeFabricEVMCompactBatchCluster((bytes32,bytes32,bytes32,uint64,bytes32,uint64,uint8,bytes32,bytes32)[],address,(uint16,bytes32,bytes32,address,int256,bytes32,bool)[],bytes32,bytes32,${CLUSTER_CERT_ABI})`](
      items.map((item) => compactFabricDelivery(item.hxmsg)),
      target,
      calls,
      batch.batchID,
      batch.batchRoot,
      clusterCertificateTuple(batch.certificate)
    )
    : await gateway[`executeHXMsgMinimalCompactBatchCluster((bytes32,bytes32,uint8,bytes32,uint8,bytes32,bytes4,bytes32,bytes32,bytes32,bool,uint8,uint64,bytes32,uint64,bytes32,uint64,uint8,bytes32,bytes32)[],address,(uint16,bytes32,bytes32,address,int256,bytes32,bool)[],bytes32,bytes32,${CLUSTER_CERT_ABI})`](
      items.map((item) => toMinimalHXMsg(item.hxmsg)),
      target,
      calls,
      batch.batchID,
      batch.batchRoot,
      clusterCertificateTuple(batch.certificate)
    );
  const receipt = await transaction.wait();
  return {
    transactionHash: receipt.hash,
    blockNumber: Number(receipt.blockNumber),
    gasUsed: receipt.gasUsed.toString(),
    batchSize: items.length,
  };
}

async function submitBatchToFabric(targetProfile, items, batch) {
  const { gateway, contract } = await connectFabric(targetProfile);
  try {
    await registerFabricTEEs({
      contract,
      certificate: batch.certificate,
      teeURLs: teeURLs(Number(items[0].hxmsg.source.chainType)),
    });
    const certificates = items.map((_, index) => ({
      ...batch.certificate,
      batchID: batch.batchID,
      batchRoot: batch.batchRoot,
      batchSize: items.length,
      batchSigningDigest: batch.batchSigningDigest,
      merkleProof: batch.merkleProofs[index] || [],
    }));
    const transaction = contract.createTransaction('ExecuteHXMsgCompactBatch');
    const transactionID = transaction.getTransactionId();
    const response = await transaction.submit(
      JSON.stringify(items.map((item) => fabricDelivery(item.hxmsg))),
      JSON.stringify(items.map((item) => item.execution.compactCall || getExecutionData(item.hxmsg).compactCall)),
      JSON.stringify(items.map((item) => item.execution.businessPayload || getExecutionData(item.hxmsg).businessPayload)),
      JSON.stringify(certificates)
    );
    return { ...JSON.parse(response.toString()), transactionID, batchSize: items.length };
  } finally {
    gateway.disconnect();
  }
}

async function submitTargetBatch({ targetProfile, items, batch }) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('empty automation target batch');
  return targetProfile.kind === 'fabric'
    ? submitBatchToFabric(targetProfile, items, batch)
    : submitBatchToEVM(targetProfile, items, batch);
}

module.exports = {
  submitTarget,
  submitTargetBatch,
};
