const { ethers } = require('ethers');
const { ResponseStatus, computeResponseDigest, hashJson } = require('../shared/hxmsg');

function buildEvmExecutionProofRef(receipt) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint64', 'bytes32'],
      [receipt.transactionHash || receipt.hash, Number(receipt.blockNumber), receipt.blockHash]
    )
  );
}

function buildFabricExecutionRecordHash(record) {
  return hashJson({
    requestID: record.requestID,
    txId: record.txId || '',
    hmsgDigest: record.hmsgDigest || ethers.ZeroHash,
    targetExecutionHash: record.targetExecutionHash || ethers.ZeroHash,
    status: record.status,
    businessKey: record.businessKey || '',
    businessStatus: record.businessStatus || '',
  });
}

function buildFabricExecutionProofRef(record) {
  return buildFabricExecutionRecordHash(record);
}

function buildFabricExecutionViewRef({
  channelID = process.env.FABRIC_CHANNEL || 'mychannel',
  chaincodeName = process.env.FABRIC_CHAINCODE || 'xcall',
  requestID,
}) {
  if (!requestID) throw new Error('requestID is required for Fabric execution view ref');
  return {
    channelID,
    chaincodeName,
    queryFunction: 'GetInboundStatus',
    queryArgs: [requestID],
    viewAddress: `fabric://${channelID}/${chaincodeName}/GetInboundStatus/${requestID}`,
    expectedStateKey: `inbound:${requestID}`,
  };
}

function buildExecutedResponse({
  originRequestID,
  originHmsgDigest = ethers.ZeroHash,
  targetExecutionHash,
  targetProofRefHash,
  responsePayload = {},
}) {
  const response = {
    originRequestID,
    originHmsgDigest,
    responseStatus: ResponseStatus.EXECUTED,
    targetExecutionHash,
    targetProofRefHash,
    responsePayloadHash: hashJson(responsePayload),
  };
  response.responseDigest = computeResponseDigest(response);
  return response;
}

module.exports = {
  buildEvmExecutionProofRef,
  buildFabricExecutionRecordHash,
  buildFabricExecutionProofRef,
  buildFabricExecutionViewRef,
  buildExecutedResponse,
};
