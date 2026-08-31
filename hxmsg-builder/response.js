const { ethers } = require('ethers');
const {
  ResponseStatus,
  computeResponseDigest,
  findHXMsgAcceptedLog,
  computeEvmExecutionProofRef,
  buildFabricExecutionRecordHash,
  computeFabricExecutionResultHash,
  computeFabricExecutionProofRef,
  buildDefaultFabricResponseHFsvPolicy,
  hashJson,
} = require('../shared/hxmsg');

function buildEvmExecutionProofRef(receipt, { originHxmsg, gatewayAddress } = {}) {
  if (!originHxmsg?.target || !gatewayAddress) {
    throw new Error('originHxmsg and gatewayAddress are required for an EVM execution proof ref');
  }
  const { log, accepted } = findHXMsgAcceptedLog({
    receipt,
    gatewayAddress,
    requestID: originHxmsg.header.requestID,
  });
  return computeEvmExecutionProofRef({
    receipt,
    log,
    accepted,
    chainType: originHxmsg.target.chainType,
    chainID: originHxmsg.target.chainID,
    domainID: originHxmsg.target.domainID,
    gatewayAddress,
  });
}

function buildFabricExecutionProofRef(record, { originHxmsg, channelID, chaincodeName } = {}) {
  if (!originHxmsg?.target) throw new Error('originHxmsg is required for a Fabric execution proof ref');
  const policy = buildDefaultFabricResponseHFsvPolicy({ channelID, chaincodeName });
  return computeFabricExecutionProofRef({
    record,
    chainID: originHxmsg.target.chainID,
    domainID: originHxmsg.target.domainID,
    channelID,
    chaincodeName,
    policyHash: hashJson(policy),
  });
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
  responsePayloadHash,
}) {
  if (!responsePayloadHash || responsePayloadHash === ethers.ZeroHash) {
    throw new Error('verified responsePayloadHash is required');
  }
  const response = {
    originRequestID,
    originHmsgDigest,
    responseStatus: ResponseStatus.EXECUTED,
    targetExecutionHash,
    targetProofRefHash,
    responsePayloadHash,
  };
  response.responseDigest = computeResponseDigest(response);
  return response;
}

module.exports = {
  buildEvmExecutionProofRef,
  buildFabricExecutionRecordHash,
  computeFabricExecutionResultHash,
  buildFabricExecutionProofRef,
  buildFabricExecutionViewRef,
  buildExecutedResponse,
};
