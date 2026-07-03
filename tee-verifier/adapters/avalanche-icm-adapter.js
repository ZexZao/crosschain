const { ethers } = require('ethers');
const {
  ChainType,
  VerificationMethod,
  hashJson,
  computeTargetExecutionHash,
} = require('../../shared/hxmsg');
const {
  decodeHXMsgWarpPayload,
  verifyAvalancheWeightedSignatures,
} = require('../../shared/avalanche/warp-proof');

function sameHex(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function hashProofObject(value) {
  return hashJson(value || {});
}

function verifyQuorumWeight({ signedWeight, totalWeight, quorumNumerator = 67, quorumDenominator = 100 }) {
  const signed = BigInt(String(signedWeight || '0'));
  const total = BigInt(String(totalWeight || '0'));
  const numerator = BigInt(Number(quorumNumerator || 67));
  const denominator = BigInt(Number(quorumDenominator || 100));
  if (total <= 0n) throw new Error('Avalanche validator totalWeight is required');
  if (signed * denominator < total * numerator) {
    throw new Error('Avalanche signed validator weight below quorum');
  }
}

async function verifySourceFact({ hxmsg, helperData }) {
  const proof = helperData.avalancheProof || helperData.sourceProof || {};
  if (!proof || !proof.sourceProof || !proof.validatorSetRef || !proof.signatureProof) {
    throw new Error('Avalanche ICM proof is required');
  }
  if (Number(hxmsg.source?.chainType) !== ChainType.AVALANCHE) {
    throw new Error('Avalanche adapter requires Avalanche source chain');
  }
  if (Number(hxmsg.verification?.verificationMethod) !== VerificationMethod.AVALANCHE_ICM_BLS) {
    throw new Error('bad Avalanche verification method');
  }

  const { sourceProof, validatorSetRef, signatureProof, payloadBinding = {}, validatorSet = [] } = proof;
  if (sourceProof.proofType !== 'AvalancheWarpMessage') throw new Error('bad Avalanche source proof type');
  if (signatureProof.scheme && signatureProof.scheme !== 'BLS12-381') throw new Error('bad Avalanche signature scheme');
  if (!sourceProof.unsignedWarpMessage || !sourceProof.unsignedWarpMessageHash) {
    throw new Error('Avalanche unsignedWarpMessage and hash are required');
  }
  const unsignedHash = ethers.sha256(sourceProof.unsignedWarpMessage);
  if (!sameHex(unsignedHash, sourceProof.unsignedWarpMessageHash)) {
    throw new Error('Avalanche unsignedWarpMessageHash mismatch');
  }
  if (sourceProof.warpMessageID && !sameHex(sourceProof.warpMessageID, sourceProof.unsignedWarpMessageHash)) {
    throw new Error('Avalanche warpMessageID must equal unsigned message sha256');
  }
  if (signatureProof.signedMessageHash && !sameHex(signatureProof.signedMessageHash, sourceProof.unsignedWarpMessageHash)) {
    throw new Error('Avalanche signed message hash mismatch');
  }
  if (payloadBinding.sourceMessageID && !sameHex(payloadBinding.sourceMessageID, sourceProof.warpMessageID)) {
    throw new Error('Avalanche payloadBinding sourceMessageID mismatch');
  }

  const weightedProof = verifyAvalancheWeightedSignatures({
    unsignedWarpMessage: sourceProof.unsignedWarpMessage,
    validatorSet,
    signatures: signatureProof.signatures,
    quorumNumerator: validatorSetRef.quorumNumerator,
    quorumDenominator: validatorSetRef.quorumDenominator,
  });
  if (!sameHex(weightedProof.validatorSetHash, validatorSetRef.validatorSetHash)) {
    throw new Error('Avalanche validatorSetHash mismatch');
  }
  if (Number(weightedProof.networkID) !== Number(validatorSetRef.networkID || sourceProof.networkID)) {
    throw new Error('Avalanche networkID mismatch');
  }
  if (!sameHex(weightedProof.sourceChainID, sourceProof.sourceChainID)) {
    throw new Error('Avalanche sourceChainID mismatch');
  }
  if (sourceProof.sourceContract && weightedProof.sourceAddress.toLowerCase() !== String(sourceProof.sourceContract).toLowerCase()) {
    throw new Error('Avalanche source contract mismatch');
  }

  const warpPayload = decodeHXMsgWarpPayload(weightedProof.payload);
  if (!sameHex(warpPayload.targetChainID, hxmsg.target.chainID)) throw new Error('Avalanche targetChainID mismatch');
  if (!sameHex(warpPayload.targetDomainID, hxmsg.target.domainID)) throw new Error('Avalanche targetDomainID mismatch');
  if (!sameHex(warpPayload.targetObject, hxmsg.targetAction.targetObject)) throw new Error('Avalanche targetObject mismatch');
  if (!sameHex(warpPayload.functionSelector, hxmsg.targetAction.functionSelector)) throw new Error('Avalanche targetAction mismatch');
  if (!sameHex(warpPayload.callDataHash, hxmsg.targetAction.callDataHash)) throw new Error('Avalanche callDataHash mismatch');
  if (!sameHex(warpPayload.businessPayloadHash, hxmsg.payloadBinding.businessPayloadHash)) throw new Error('Avalanche businessPayloadHash mismatch');
  if (!sameHex(warpPayload.receiver, hxmsg.targetAction.receiver)) throw new Error('Avalanche receiver mismatch');
  if (Number(warpPayload.expireAt || hxmsg.header.deliveryExpireAt) < Math.floor(Date.now() / 1000)) {
    throw new Error('Avalanche payloadBinding expired');
  }

  verifyQuorumWeight({
    signedWeight: weightedProof.signedWeight,
    totalWeight: validatorSetRef.totalWeight,
    quorumNumerator: validatorSetRef.quorumNumerator,
    quorumDenominator: validatorSetRef.quorumDenominator,
  });

  const policyHash = hashProofObject({
    validatorSetRef,
    canonicalOrdering: validatorSetRef.canonicalOrdering,
  });
  if (!sameHex(policyHash, hxmsg.verification?.policyRef?.policyHash)) {
    throw new Error('Avalanche validator policy hash mismatch');
  }

  const sourceRecord = {
    proofType: sourceProof.proofType,
    warpMessageID: sourceProof.warpMessageID,
    unsignedWarpMessageHash: sourceProof.unsignedWarpMessageHash,
    sourceChainID: sourceProof.sourceChainID,
    sourceContract: sourceProof.sourceContract || weightedProof.sourceAddress,
    networkID: Number(sourceProof.networkID || 0),
    validatorSetHash: validatorSetRef.validatorSetHash,
    pChainHeight: Number(validatorSetRef.pChainHeight || 0),
    signatureSetHash: hashJson(signatureProof.signatures || []),
    signedWeight: String(weightedProof.signedWeight || '0'),
  };
  const sourcePayloadHash = hashJson(sourceRecord);
  if (!sameHex(sourcePayloadHash, hxmsg.payloadBinding.sourcePayloadHash)) {
    throw new Error('Avalanche sourcePayloadHash mismatch');
  }

  const targetExecutionHash = computeTargetExecutionHash({
    requestID: hxmsg.header.requestID,
    targetChainID: hxmsg.target.chainID,
    targetObject: hxmsg.targetAction.targetObject,
    functionSelector: hxmsg.targetAction.functionSelector,
    callDataHash: hxmsg.targetAction.callDataHash,
    receiver: hxmsg.targetAction.receiver,
  });
  if (!sameHex(targetExecutionHash, hxmsg.payloadBinding.targetExecutionHash)) {
    throw new Error('Avalanche targetExecutionHash mismatch');
  }

  return {
    adapter: 'avalanche-icm-bls',
    verified: true,
    warpMessageID: sourceProof.warpMessageID,
    pChainHeight: Number(validatorSetRef.pChainHeight || 0),
    validatorSetHash: validatorSetRef.validatorSetHash,
    verifiedSigners: weightedProof.verifiedSigners,
    signedWeight: String(weightedProof.signedWeight || '0'),
    totalWeight: String(weightedProof.totalWeight || '0'),
    sourcePayloadHash,
    targetExecutionHash,
  };
}

module.exports = {
  sourceChainType: ChainType.AVALANCHE,
  verificationMethod: VerificationMethod.AVALANCHE_ICM_BLS,
  verifySourceFact,
};
