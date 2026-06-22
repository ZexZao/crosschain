const {
  computeHXMsgDigest,
  buildDeliveryMessage,
  buildHXMsgEnvelope,
  hydrateLegacyHXMsg,
  toCanonicalHXMsg,
  attachCanonicalAliases,
  assertHXMsgInvariants,
} = require('../shared/hxmsg');

function composeHXMsg({
  header,
  source,
  target,
  sourceRef,
  targetAction,
  verification,
  payloadBinding,
  feedback,
  atomicity,
  callData,
  compactCall,
  callDataDecoded,
  txId,
  srcHeight,
  sourceRecord,
  proofMeta,
}) {
  const canonicalHxmsg = attachCanonicalAliases(toCanonicalHXMsg({
    header,
    source,
    target,
    sourceRef,
    targetAction,
    verification,
    payloadBinding,
    feedback,
    atomicity: atomicity || undefined,
  }));
  assertHXMsgInvariants(canonicalHxmsg);
  canonicalHxmsg.hmsgDigest = computeHXMsgDigest(canonicalHxmsg);
  const hxmsgEnvelope = buildHXMsgEnvelope({
    canonicalHxmsg,
    sourceEvidence: {
      encodedRef: sourceRef.encodedRef,
      sourceRecord,
    },
    executionData: {
      callData,
      compactCall,
      businessPayload: callDataDecoded,
    },
    runtime: {
      adapterID: verification.adapterID,
    },
    auditRecord: {
      txId,
      srcHeight: Number(srcHeight),
      proofMeta,
    },
  });
  const deliveryMessage = buildDeliveryMessage(canonicalHxmsg, hxmsgEnvelope.executionData);
  const hxmsg = hydrateLegacyHXMsg(canonicalHxmsg, hxmsgEnvelope, deliveryMessage);
  hxmsg.canonicalHxmsg = canonicalHxmsg;
  return hxmsg;
}

module.exports = { composeHXMsg };
