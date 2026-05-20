const { ethers } = require('ethers');

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return '';
}

function normalizeBusinessPayload(rawPayload) {
  const recordId = firstDefined(
    rawPayload.assetId,
    rawPayload.escrowId,
    rawPayload.receivableId,
    rawPayload.waybillId,
    rawPayload.credentialId,
    rawPayload.consentId,
    rawPayload.creditBatch,
    rawPayload.deviceId,
    rawPayload.applicationId,
    rawPayload.certificateNo,
    rawPayload.workflowId,
    rawPayload.feed,
    rawPayload.dataTag,
    rawPayload.caseId,
    rawPayload.recordId,
    'UNSPECIFIED'
  );

  const actor = firstDefined(
    rawPayload.owner,
    rawPayload.beneficiary,
    rawPayload.supplier,
    rawPayload.issuer,
    rawPayload.grantee,
    rawPayload.projectOwner,
    rawPayload.inspector,
    rawPayload.applicant,
    rawPayload.institution,
    rawPayload.sourceAgency,
    rawPayload.dataOwner,
    rawPayload.actor,
    Array.isArray(rawPayload.approvers) ? rawPayload.approvers.join(',') : '',
    'UNKNOWN'
  );

  const amount = String(
    firstDefined(
      rawPayload.amount,
      rawPayload.subsidyAmount,
      rawPayload.price,
      rawPayload.reading,
      rawPayload.durationDays,
      rawPayload.insuredAreaMu,
      rawPayload.threshold,
      '0'
    )
  );

  return {
    op: String(firstDefined(rawPayload.op, 'unknown')),
    recordId: String(recordId),
    actor: String(actor),
    amount,
    metadata: JSON.stringify(rawPayload),
    requireAck: Boolean(rawPayload.requireAck)
  };
}

function encodeBusinessPayload(rawPayload) {
  const normalized = normalizeBusinessPayload(rawPayload);
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return {
    normalized,
    payloadHex: abiCoder.encode(
      ['string', 'string', 'string', 'string', 'string', 'bool'],
      [
        normalized.op,
        normalized.recordId,
        normalized.actor,
        normalized.amount,
        normalized.metadata,
        normalized.requireAck
      ]
    )
  };
}

module.exports = {
  normalizeBusinessPayload,
  encodeBusinessPayload
};
