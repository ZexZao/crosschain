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

function buildFabricExecutionProofRef(record) {
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(record)));
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
  buildFabricExecutionProofRef,
  buildExecutedResponse,
};
