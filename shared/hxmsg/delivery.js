const { ethers } = require('ethers');
const {
  computeTargetExecutionHash,
  computeHXMsgDigest,
  computeReplayScope,
  normalizeFeedback,
} = require('./hash');
const { toCanonicalHXMsg } = require('./canonical');

function buildDeliveryMessage(hxmsgOrEnvelope, executionData = {}) {
  const hxmsg = toCanonicalHXMsg(hxmsgOrEnvelope);
  const hmsgDigest = hxmsgOrEnvelope?.hmsgDigest || hxmsgOrEnvelope?.deliveryMessage?.hmsgDigest || computeHXMsgDigest(hxmsg);
  const feedback = normalizeFeedback(hxmsg.feedback);
  const targetExecutionHash = computeTargetExecutionHash({
    requestID: hxmsg.header.requestID,
    targetChainID: hxmsg.target.chainID,
    targetObject: hxmsg.targetAction.targetObject,
    functionSelector: hxmsg.targetAction.functionSelector,
    callDataHash: hxmsg.targetAction.callDataHash,
    receiver: hxmsg.targetAction.receiver,
  });
  return {
    requestID: hxmsg.header.requestID,
    hmsgDigest,
    target: hxmsg.target,
    targetAction: hxmsg.targetAction,
    callData: executionData.callData,
    callDataHash: hxmsg.targetAction.callDataHash,
    targetExecutionHash,
    feedback,
    deliveryExpireAt: hxmsg.header.deliveryExpireAt,
    replayScope: computeReplayScope(hxmsg),
    sourceNonce: hxmsg.header.nonce,
  };
}

function toMinimalHXMsgV2(hxmsgOrEnvelope) {
  const delivery = hxmsgOrEnvelope?.deliveryMessage || buildDeliveryMessage(hxmsgOrEnvelope);
  return [
    delivery.requestID,
    delivery.hmsgDigest,
    delivery.target.chainType,
    delivery.target.chainID,
    delivery.targetAction.actionType,
    delivery.targetAction.targetObject,
    delivery.targetAction.functionSelector,
    delivery.targetAction.callDataHash,
    delivery.targetAction.receiver,
    delivery.targetExecutionHash,
    delivery.feedback.required,
    delivery.feedback.expectedMsgType,
    delivery.feedback.timeout,
    delivery.feedback.callbackRefHash,
    delivery.deliveryExpireAt,
    delivery.replayScope,
    delivery.sourceNonce,
  ];
}

function computeDeliveryDigest(deliveryOrHxmsg) {
  const minimal = Array.isArray(deliveryOrHxmsg)
    ? deliveryOrHxmsg
    : toMinimalHXMsgV2(deliveryOrHxmsg);
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
  const replayHash = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint64'],
      [minimal[15], minimal[16]]
    )
  );
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [chainHash, actionHash, feedbackHash, replayHash]
    )
  );
}

module.exports = {
  buildDeliveryMessage,
  toMinimalHXMsgV2,
  computeDeliveryDigest,
};
