const { ethers } = require('ethers');

function normalizeFinality(verification = {}) {
  if (verification.finality) {
    return {
      model: Number(verification.finality.model || 0),
      confirmations: Number(verification.finality.confirmations || 0),
      checkpointRoot: verification.finality.checkpointRoot || ethers.ZeroHash,
      epoch: Number(verification.finality.epoch || 0),
      committeePolicyHash: verification.finality.committeePolicyHash || ethers.ZeroHash,
    };
  }
  return {
    model: Number(verification.finalityModel || 0),
    confirmations: Number(verification.requiredConfirmations || 0),
    checkpointRoot: ethers.ZeroHash,
    epoch: 0,
    committeePolicyHash: ethers.ZeroHash,
  };
}

function normalizePolicyRef(policyRef = {}) {
  return {
    policyType: Number(policyRef.policyType || 0),
    policyHash: policyRef.policyHash || ethers.ZeroHash,
  };
}

function normalizeVerification(verification = {}) {
  return {
    verificationMethod: Number(verification.verificationMethod || 0),
    finality: normalizeFinality(verification),
    policyRef: normalizePolicyRef(verification.policyRef),
    verifierProfileHash: verification.verifierProfileHash || verification.adapterID || ethers.ZeroHash,
  };
}

function toCanonicalHXMsg(hxmsgOrEnvelope) {
  const source = hxmsgOrEnvelope?.canonicalHxmsg || hxmsgOrEnvelope?.hxmsg || hxmsgOrEnvelope;
  if (!source?.header) throw new Error('canonical h-xmsg header is required');
  return {
    header: {
      version: Number(source.header.version || 1),
      requestID: source.header.requestID,
      msgType: Number(source.header.msgType || 0),
      nonce: Number(source.header.nonce || 0),
      nonceScope: source.header.nonceScope || ethers.ZeroHash,
      sourceTimestamp: Number(source.header.sourceTimestamp ?? source.header.createdAt ?? 0),
      deliveryExpireAt: Number(source.header.deliveryExpireAt ?? source.header.expireAt ?? 0),
    },
    source: {
      chainType: Number(source.source?.chainType || 0),
      chainID: source.source?.chainID || ethers.ZeroHash,
      domainID: source.source?.domainID || ethers.ZeroHash,
    },
    target: {
      chainType: Number(source.target?.chainType || 0),
      chainID: source.target?.chainID || ethers.ZeroHash,
      domainID: source.target?.domainID || ethers.ZeroHash,
    },
    sourceRef: {
      refType: Number(source.sourceRef?.refType || 0),
      refHash: source.sourceRef?.refHash || ethers.ZeroHash,
    },
    targetAction: {
      actionType: Number(source.targetAction?.actionType || 0),
      targetObject: source.targetAction?.targetObject || ethers.ZeroHash,
      functionSelector: source.targetAction?.functionSelector || '0x00000000',
      callDataHash: source.targetAction?.callDataHash || ethers.ZeroHash,
      receiver: source.targetAction?.receiver || ethers.ZeroHash,
    },
    verification: normalizeVerification(source.verification || {}),
    payloadBinding: {
      sourcePayloadHash: source.payloadBinding?.sourcePayloadHash || ethers.ZeroHash,
      businessPayloadHash: source.payloadBinding?.businessPayloadHash || ethers.ZeroHash,
    },
    feedback: source.feedback || {},
    atomicity: source.atomicity || {},
  };
}

function attachCanonicalAliases(hxmsg) {
  if (!hxmsg?.header) return hxmsg;
  hxmsg.header.createdAt = hxmsg.header.sourceTimestamp;
  hxmsg.header.expireAt = hxmsg.header.deliveryExpireAt;
  hxmsg.verification.finalityModel = hxmsg.verification.finality.model;
  hxmsg.verification.requiredConfirmations = hxmsg.verification.finality.confirmations;
  hxmsg.verification.adapterID = hxmsg.verification.verifierProfileHash;
  return hxmsg;
}

module.exports = {
  normalizeFinality,
  normalizeVerification,
  toCanonicalHXMsg,
  attachCanonicalAliases,
};
