const { ethers } = require('ethers');
const { stableStringify } = require('./codec');

function normalizeFeedback(feedback = {}) {
  return {
    required: Boolean(feedback.required),
    expectedMsgType: Number(feedback.expectedMsgType || 0),
    timeout: Number(feedback.timeout || 0),
    callbackRefHash: feedback.callbackRefHash || ethers.ZeroHash,
  };
}

function hashJson(value) {
  return ethers.keccak256(ethers.toUtf8Bytes(stableStringify(value)));
}

function hashBytes(bytesLike) {
  return ethers.keccak256(bytesLike);
}

function computeTargetExecutionHash({ requestID, targetChainID, targetObject, functionSelector, callDataHash, receiver }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes4', 'bytes32', 'bytes32'],
      [requestID, targetChainID, targetObject, functionSelector, callDataHash, receiver]
    )
  );
}

function computeHXMsgDigest(hxmsg) {
  const headerHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint8', 'bytes32', 'uint8', 'uint64', 'uint64', 'uint64'],
      [
        hxmsg.header.version,
        hxmsg.header.requestID,
        hxmsg.header.msgType,
        hxmsg.header.nonce,
        hxmsg.header.createdAt,
        hxmsg.header.expireAt,
      ]
    )
  );
  const endpointHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint8', 'bytes32', 'bytes32', 'uint8', 'bytes32', 'bytes32', 'uint8', 'bytes32'],
      [
        hxmsg.source.chainType,
        hxmsg.source.chainID,
        hxmsg.source.domainID,
        hxmsg.target.chainType,
        hxmsg.target.chainID,
        hxmsg.target.domainID,
        hxmsg.sourceRef.refType,
        hxmsg.sourceRef.refHash,
      ]
    )
  );
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint8', 'bytes32', 'bytes4', 'bytes32', 'bytes32'],
      [
        hxmsg.targetAction.actionType,
        hxmsg.targetAction.targetObject,
        hxmsg.targetAction.functionSelector,
        hxmsg.targetAction.callDataHash,
        hxmsg.targetAction.receiver,
      ]
    )
  );
  const verificationHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint8', 'uint8', 'uint16', 'uint8', 'bytes32', 'bytes32', 'bytes32'],
      [
        hxmsg.verification.verificationMethod,
        hxmsg.verification.finalityModel,
        hxmsg.verification.requiredConfirmations,
        hxmsg.verification.policyRef.policyType,
        hxmsg.verification.policyRef.policyID,
        hxmsg.verification.policyRef.policyHash,
        hxmsg.verification.adapterID,
      ]
    )
  );
  const bindingHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32'],
      [
        hxmsg.payloadBinding.sourcePayloadHash,
        hxmsg.payloadBinding.businessPayloadHash,
        hxmsg.payloadBinding.targetExecutionHash,
      ]
    )
  );
  const feedback = normalizeFeedback(hxmsg.feedback);
  const feedbackHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bool', 'uint8', 'uint64', 'bytes32'],
      [
        feedback.required,
        feedback.expectedMsgType,
        feedback.timeout,
        feedback.callbackRefHash,
      ]
    )
  );
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [headerHash, endpointHash, actionHash, verificationHash, bindingHash, feedbackHash]
    )
  );
}

function toMinimalHXMsg(hxmsg) {
  const feedback = normalizeFeedback(hxmsg.feedback);
  return [
    hxmsg.header.requestID,
    hxmsg.hmsgDigest || computeHXMsgDigest(hxmsg),
    hxmsg.target.chainType,
    hxmsg.target.chainID,
    hxmsg.targetAction.actionType,
    hxmsg.targetAction.targetObject,
    hxmsg.targetAction.functionSelector,
    hxmsg.targetAction.callDataHash,
    hxmsg.targetAction.receiver,
    hxmsg.payloadBinding.targetExecutionHash,
    feedback.required,
    feedback.expectedMsgType,
    feedback.timeout,
    feedback.callbackRefHash,
    hxmsg.header.expireAt,
  ];
}

function computeHXMsgDeliveryDigest(hxmsg) {
  const minimal = Array.isArray(hxmsg) ? hxmsg : toMinimalHXMsg(hxmsg);
  const chainHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'uint8', 'bytes32', 'uint8'],
      [minimal[0], minimal[1], minimal[2], minimal[3], minimal[4]]
    )
  );
  const actionHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes4', 'bytes32', 'bytes32', 'bytes32'],
      [minimal[5], minimal[6], minimal[7], minimal[8], minimal[9]]
    )
  );
  const feedbackHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bool', 'uint8', 'uint64', 'bytes32', 'uint64'],
      [minimal[10], minimal[11], minimal[12], minimal[13], minimal[14]]
    )
  );
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32'],
      [chainHash, actionHash, feedbackHash]
    )
  );
}

function toOnChainHXMsg(hxmsg) {
  const feedback = normalizeFeedback(hxmsg.feedback);
  return [
    hxmsg.header.version,
    hxmsg.header.msgType,
    hxmsg.header.requestID,
    hxmsg.source.chainType,
    hxmsg.source.chainID,
    hxmsg.source.domainID,
    hxmsg.target.chainType,
    hxmsg.target.chainID,
    hxmsg.target.domainID,
    hxmsg.sourceRef.refType,
    hxmsg.sourceRef.refHash,
    hxmsg.targetAction.actionType,
    hxmsg.targetAction.targetObject,
    hxmsg.targetAction.functionSelector,
    hxmsg.targetAction.callDataHash,
    hxmsg.targetAction.receiver,
    hxmsg.verification.verificationMethod,
    hxmsg.verification.finalityModel,
    hxmsg.verification.requiredConfirmations,
    [
      hxmsg.verification.policyRef.policyType,
      hxmsg.verification.policyRef.policyID,
      hxmsg.verification.policyRef.policyHash,
    ],
    hxmsg.verification.adapterID,
    hxmsg.payloadBinding.sourcePayloadHash,
    hxmsg.payloadBinding.businessPayloadHash,
    hxmsg.payloadBinding.targetExecutionHash,
    feedback.required,
    feedback.expectedMsgType,
    feedback.timeout,
    feedback.callbackRefHash,
    hxmsg.header.nonce,
    hxmsg.header.createdAt,
    hxmsg.header.expireAt,
  ];
}

module.exports = {
  hashJson,
  hashBytes,
  normalizeFeedback,
  computeTargetExecutionHash,
  computeHXMsgDigest,
  computeHXMsgDeliveryDigest,
  toMinimalHXMsg,
  toOnChainHXMsg,
};
