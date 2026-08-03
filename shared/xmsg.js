const { ethers } = require('ethers');

const OP_CODES = Object.freeze({
  asset_lock: 1,
  mint_confirm: 2,
  receivable_attest: 3,
  logistics_sync: 4,
  medical_consent: 5,
  oracle_update: 6,
  approval_commit: 7,
  subsidy_confirm: 8,
  token_transfer: 9,
});

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
    rawPayload.transferId,
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
    rawPayload.targetRecipient,
    rawPayload.recipient,
    rawPayload.beneficiary,
    rawPayload.owner,
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

function parseAmount4(text) {
  const value = String(text);
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [wholePart, fracPart = ''] = unsigned.split('.');
  if (!/^\d+$/.test(wholePart || '0') || !/^\d*$/.test(fracPart)) {
    throw new Error(`bad amount: ${text}`);
  }
  const frac = (fracPart + '0000').slice(0, 4);
  if (fracPart.length > 4 && /[1-9]/.test(fracPart.slice(4))) {
    throw new Error(`too many amount decimals: ${text}`);
  }
  const units = BigInt(wholePart || '0') * 10000n + BigInt(frac || '0');
  return negative ? -units : units;
}

function parseUintUnits(text) {
  const value = String(text);
  if (!/^\d+$/.test(value)) throw new Error(`bad uint amount: ${text}`);
  return BigInt(value);
}

function isEvmAddress(text) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(text));
}

function normalizeEvmAddress(text) {
  return ethers.getAddress(String(text).toLowerCase());
}

function amountUnitsForOp(normalized) {
  if (normalized.op === 'medical_consent' || normalized.op === 'approval_commit') {
    return parseUintUnits(normalized.amount);
  }
  return parseAmount4(normalized.amount);
}

function buildCompactBusinessCall(rawPayload) {
  const normalized = normalizeBusinessPayload(rawPayload);
  const opCode = OP_CODES[normalized.op];
  if (!opCode) throw new Error(`unsupported compact op: ${normalized.op}`);
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(normalized.metadata));
  const compact = {
    opCode,
    recordIdHash: ethers.keccak256(ethers.toUtf8Bytes(normalized.recordId)),
    actorHash: ethers.keccak256(ethers.toUtf8Bytes(normalized.actor)),
    actorAddress: isEvmAddress(normalized.actor) ? normalizeEvmAddress(normalized.actor) : ethers.ZeroAddress,
    amount: amountUnitsForOp(normalized).toString(),
    metadataHash,
    requireAck: normalized.requireAck,
  };
  return { normalized, compact };
}

function compactBusinessCallTuple(compact) {
  return [
    Number(compact.opCode),
    compact.recordIdHash,
    compact.actorHash,
    compact.actorAddress || ethers.ZeroAddress,
    BigInt(compact.amount),
    compact.metadataHash,
    Boolean(compact.requireAck),
  ];
}

function encodeCompactBusinessCall(rawPayload) {
  const { normalized, compact } = buildCompactBusinessCall(rawPayload);
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const encoded = abiCoder.encode(
    ['uint16', 'bytes32', 'bytes32', 'address', 'int256', 'bytes32', 'bool'],
    compactBusinessCallTuple(compact)
  );
  return {
    normalized,
    compact,
    payloadHex: encoded,
    compactCallHash: ethers.keccak256(encoded),
  };
}

module.exports = {
  OP_CODES,
  normalizeBusinessPayload,
  encodeBusinessPayload,
  buildCompactBusinessCall,
  compactBusinessCallTuple,
  encodeCompactBusinessCall
};
