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
    targetChainType: hxmsg.target.chainType,
    targetChainID: hxmsg.target.chainID,
    targetDomainID: hxmsg.target.domainID,
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

module.exports = {
  buildDeliveryMessage,
};
