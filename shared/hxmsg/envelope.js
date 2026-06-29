const { ethers } = require('ethers');
const { hashBytes, hashJson } = require('./hash');
const { toCanonicalHXMsg } = require('./canonical');

function getSourceEvidence(hxmsgOrEnvelope, helperData = {}) {
  return hxmsgOrEnvelope?.hxmsgEnvelope?.sourceEvidence
    || hxmsgOrEnvelope?.sourceEvidence
    || { proof: helperData, helperData };
}

function getExecutionData(hxmsgOrEnvelope) {
  return hxmsgOrEnvelope?.hxmsgEnvelope?.executionData
    || hxmsgOrEnvelope?.executionData
    || {};
}

function getAuditRecord(hxmsgOrEnvelope) {
  return hxmsgOrEnvelope?.hxmsgEnvelope?.auditRecord
    || hxmsgOrEnvelope?.auditRecord
    || {};
}

function buildHXMsgEnvelope({
  canonicalHxmsg,
  sourceEvidence = {},
  executionData = {},
  runtime = {},
  auditRecord = {},
}) {
  return {
    hxmsg: canonicalHxmsg,
    sourceEvidence,
    executionData,
    runtime,
    auditRecord,
  };
}

function hydrateLegacyHXMsg(canonicalHxmsg, envelope = {}, deliveryMessage) {
  const sourceEvidence = envelope.sourceEvidence || {};
  const executionData = envelope.executionData || {};
  const auditRecord = envelope.auditRecord || {};
  const hxmsg = {
    ...canonicalHxmsg,
    hmsgDigest: canonicalHxmsg.hmsgDigest,
    sourceRef: {
      ...canonicalHxmsg.sourceRef,
      encodedRef: sourceEvidence.encodedRef,
    },
    payloadBinding: {
      ...canonicalHxmsg.payloadBinding,
      targetExecutionHash: deliveryMessage?.targetExecutionHash,
    },
    callData: executionData.callData,
    compactCall: executionData.compactCall,
    callDataDecoded: executionData.businessPayload,
    txId: auditRecord.txId,
    srcHeight: auditRecord.srcHeight,
    sourceRecord: sourceEvidence.sourceRecord,
    proofMeta: auditRecord.proofMeta,
  };
  hxmsg.hxmsgEnvelope = envelope;
  if (deliveryMessage) hxmsg.deliveryMessage = deliveryMessage;
  return hxmsg;
}

function assertEnvelopeBindings(hxmsgOrEnvelope) {
  const hxmsg = toCanonicalHXMsg(hxmsgOrEnvelope);
  const sourceEvidence = getSourceEvidence(hxmsgOrEnvelope);
  const executionData = getExecutionData(hxmsgOrEnvelope);
  if (sourceEvidence.encodedRef && hashBytes(sourceEvidence.encodedRef).toLowerCase() !== hxmsg.sourceRef.refHash.toLowerCase()) {
    throw new Error('sourceRef.refHash does not match encodedRef');
  }
  if (executionData.callData && ethers.keccak256(executionData.callData).toLowerCase() !== hxmsg.targetAction.callDataHash.toLowerCase()) {
    throw new Error('callDataHash does not match callData');
  }
  if (executionData.businessPayload && hashJson(executionData.businessPayload).toLowerCase() !== hxmsg.payloadBinding.businessPayloadHash.toLowerCase()) {
    throw new Error('businessPayloadHash does not match businessPayload');
  }
}

module.exports = {
  buildHXMsgEnvelope,
  getSourceEvidence,
  getExecutionData,
  getAuditRecord,
  hydrateLegacyHXMsg,
  assertEnvelopeBindings,
};
