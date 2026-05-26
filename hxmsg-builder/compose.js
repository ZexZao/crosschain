const { computeHXMsgDigest } = require('../shared/hxmsg');

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
  callDataDecoded,
  txId,
  srcHeight,
  sourceRecord,
  proofMeta,
}) {
  const hxmsg = {
    header,
    source,
    target,
    sourceRef,
    targetAction,
    verification,
    payloadBinding,
    feedback,
    atomicity: atomicity || undefined,
    callData,
    callDataDecoded,
    txId,
    srcHeight: Number(srcHeight),
    sourceRecord,
    proofMeta,
  };
  hxmsg.hmsgDigest = computeHXMsgDigest(hxmsg);
  return hxmsg;
}

module.exports = { composeHXMsg };
