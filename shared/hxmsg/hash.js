const { ethers } = require('ethers');
const { stableStringify } = require('./codec');
const { toCanonicalHXMsg } = require('./canonical');

function normalizeFeedback(feedback = {}) {
  return {
    required: Boolean(feedback.required),
    expectedMsgType: Number(feedback.expectedMsgType || 0),
    timeout: Number(feedback.timeout || 0),
    callbackRefHash: feedback.callbackRefHash || ethers.ZeroHash,
  };
}

function normalizeAtomicity(atomicity = {}) {
  return {
    required: Boolean(atomicity.required),
    mode: Number(atomicity.mode || 0),
    commitmentType: Number(atomicity.commitmentType || 0),
    commitmentRefHash: atomicity.commitmentRefHash || ethers.ZeroHash,
    successActionHash: atomicity.successActionHash || ethers.ZeroHash,
    failureActionHash: atomicity.failureActionHash || ethers.ZeroHash,
    challengeWindow: Number(atomicity.challengeWindow || 0),
  };
}

function computeFeedbackHash(feedback = {}) {
  const normalized = normalizeFeedback(feedback);
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bool', 'uint8', 'uint64', 'bytes32'],
      [
        normalized.required,
        normalized.expectedMsgType,
        normalized.timeout,
        normalized.callbackRefHash,
      ]
    )
  );
}

function computeAtomicityHash(atomicity = {}) {
  const normalized = normalizeAtomicity(atomicity);
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bool', 'uint8', 'uint8', 'bytes32', 'bytes32', 'bytes32', 'uint64'],
      [
        normalized.required,
        normalized.mode,
        normalized.commitmentType,
        normalized.commitmentRefHash,
        normalized.successActionHash,
        normalized.failureActionHash,
        normalized.challengeWindow,
      ]
    )
  );
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
  hxmsg = toCanonicalHXMsg(hxmsg);
  const headerHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint8', 'bytes32', 'uint8', 'uint64', 'bytes32', 'uint64', 'uint64'],
      [
        hxmsg.header.version,
        hxmsg.header.requestID,
        hxmsg.header.msgType,
        hxmsg.header.nonce,
        hxmsg.header.nonceScope,
        hxmsg.header.sourceTimestamp,
        hxmsg.header.deliveryExpireAt,
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
      ['uint8', 'uint8', 'uint16', 'bytes32', 'uint64', 'bytes32', 'uint8', 'bytes32', 'bytes32'],
      [
        hxmsg.verification.verificationMethod,
        hxmsg.verification.finality.model,
        hxmsg.verification.finality.confirmations,
        hxmsg.verification.finality.checkpointRoot,
        hxmsg.verification.finality.epoch,
        hxmsg.verification.finality.committeePolicyHash,
        hxmsg.verification.policyRef.policyType,
        hxmsg.verification.policyRef.policyHash,
        hxmsg.verification.verifierProfileHash,
      ]
    )
  );
  const bindingHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32'],
      [
        hxmsg.payloadBinding.sourcePayloadHash,
        hxmsg.payloadBinding.businessPayloadHash,
      ]
    )
  );
  const feedback = normalizeFeedback(hxmsg.feedback);
  const feedbackHash = computeFeedbackHash(feedback);
  const atomicityHash = computeAtomicityHash(hxmsg.atomicity);
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [headerHash, endpointHash, actionHash, verificationHash, bindingHash, feedbackHash, atomicityHash]
    )
  );
}

function toMinimalHXMsg(hxmsg) {
  hxmsg = toCanonicalHXMsg(hxmsg);
  const feedback = normalizeFeedback(hxmsg.feedback);
  const targetExecutionHash = computeTargetExecutionHash({
    requestID: hxmsg.header.requestID,
    targetChainID: hxmsg.target.chainID,
    targetObject: hxmsg.targetAction.targetObject,
    functionSelector: hxmsg.targetAction.functionSelector,
    callDataHash: hxmsg.targetAction.callDataHash,
    receiver: hxmsg.targetAction.receiver,
  });
  const hmsgDigest = hxmsg.hmsgDigest || computeHXMsgDigest(hxmsg);
  return [
    hxmsg.header.requestID,
    hmsgDigest,
    hxmsg.target.chainType,
    hxmsg.target.chainID,
    hxmsg.targetAction.actionType,
    hxmsg.targetAction.targetObject,
    hxmsg.targetAction.functionSelector,
    hxmsg.targetAction.callDataHash,
    hxmsg.targetAction.receiver,
    targetExecutionHash,
    feedback.required,
    feedback.expectedMsgType,
    feedback.timeout,
    feedback.callbackRefHash,
    hxmsg.header.deliveryExpireAt,
  ];
}

function computeResponseDigest(response) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'uint8', 'bytes32', 'bytes32', 'bytes32'],
      [
        response.originRequestID,
        response.originHmsgDigest,
        Number(response.responseStatus || 0),
        response.targetExecutionHash,
        response.targetProofRefHash || ethers.ZeroHash,
        response.responsePayloadHash || ethers.ZeroHash,
      ]
    )
  );
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
  hxmsg = toCanonicalHXMsg(hxmsg);
  const feedback = normalizeFeedback(hxmsg.feedback);
  const targetExecutionHash = computeTargetExecutionHash({
    requestID: hxmsg.header.requestID,
    targetChainID: hxmsg.target.chainID,
    targetObject: hxmsg.targetAction.targetObject,
    functionSelector: hxmsg.targetAction.functionSelector,
    callDataHash: hxmsg.targetAction.callDataHash,
    receiver: hxmsg.targetAction.receiver,
  });
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
    hxmsg.verification.finality.model,
    hxmsg.verification.finality.confirmations,
    [
      hxmsg.verification.policyRef.policyType,
      ethers.ZeroHash,
      hxmsg.verification.policyRef.policyHash,
    ],
    hxmsg.verification.verifierProfileHash,
    hxmsg.payloadBinding.sourcePayloadHash,
    hxmsg.payloadBinding.businessPayloadHash,
    targetExecutionHash,
    feedback.required,
    feedback.expectedMsgType,
    feedback.timeout,
    feedback.callbackRefHash,
    hxmsg.header.nonce,
    hxmsg.header.sourceTimestamp,
    hxmsg.header.deliveryExpireAt,
  ];
}

module.exports = {
  hashJson,
  hashBytes,
  normalizeFeedback,
  normalizeAtomicity,
  computeFeedbackHash,
  computeAtomicityHash,
  computeTargetExecutionHash,
  computeHXMsgDigest,
  computeHXMsgDeliveryDigest,
  computeResponseDigest,
  toMinimalHXMsg,
  toOnChainHXMsg,
};
