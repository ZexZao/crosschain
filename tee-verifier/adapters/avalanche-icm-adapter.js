const { ethers } = require('ethers');
const {
  ChainType,
  VerificationMethod,
  hashJson,
  computeTargetExecutionHash,
  computeFeedbackHash,
  computeAtomicityHash,
} = require('../../shared/hxmsg');
const {
  decodeHXMsgWarpPayload,
  verifyAvalancheWeightedSignatures,
} = require('../../shared/avalanche/warp-proof');
const { resolveTrustedValidatorSet } = require('../../shared/avalanche/pchain-trust');

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

async function verifySourceFact({ hxmsg, helperData, chainState, saveChainState }) {
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

  const trustedSet = await resolveTrustedValidatorSet({
    sourceProof,
    validatorSetRef,
    suppliedValidatorSet: validatorSet,
  });
  const weightedProof = verifyAvalancheWeightedSignatures({
    unsignedWarpMessage: sourceProof.unsignedWarpMessage,
    validatorSet: trustedSet.validators,
    signatures: signatureProof.signatures,
    quorumNumerator: trustedSet.quorumNumerator,
    quorumDenominator: trustedSet.quorumDenominator,
  });
  if (!sameHex(weightedProof.validatorSetHash, trustedSet.validatorSetHash)) {
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
  const provenSourceContract = sourceProof.sourceContract || weightedProof.sourceAddress;
  const expectedNonceScope = ethers.zeroPadValue(ethers.getAddress(provenSourceContract), 32);
  if (!sameHex(hxmsg.header.nonceScope, expectedNonceScope)) {
    throw new Error('Avalanche nonceScope is not bound to the Warp-proven source contract');
  }

  const warpPayload = decodeHXMsgWarpPayload(weightedProof.payload);
  if (!sameHex(warpPayload.requestID, hxmsg.header.requestID)) throw new Error('Avalanche requestID mismatch');
  if (Number(warpPayload.nonce) !== Number(hxmsg.header.nonce)) throw new Error('Avalanche nonce mismatch');
  if (Number(warpPayload.expireAt) !== Number(hxmsg.header.expireAt)) throw new Error('Avalanche expireAt mismatch');
  if (!sameHex(warpPayload.targetChainID, hxmsg.target.chainID)) throw new Error('Avalanche targetChainID mismatch');
  if (Number(warpPayload.targetChainType) !== Number(hxmsg.target.chainType)) throw new Error('Avalanche targetChainType mismatch');
  if (!sameHex(warpPayload.targetDomainID, hxmsg.target.domainID)) throw new Error('Avalanche targetDomainID mismatch');
  if (!sameHex(warpPayload.targetObject, hxmsg.targetAction.targetObject)) throw new Error('Avalanche targetObject mismatch');
  if (!sameHex(warpPayload.functionSelector, hxmsg.targetAction.functionSelector)) throw new Error('Avalanche targetAction mismatch');
  if (!sameHex(warpPayload.callDataHash, hxmsg.targetAction.callDataHash)) throw new Error('Avalanche callDataHash mismatch');
  if (!sameHex(ethers.keccak256(warpPayload.callData), warpPayload.callDataHash)) {
    throw new Error('Avalanche Warp callData hash mismatch');
  }
  if (!sameHex(warpPayload.businessPayloadHash, hxmsg.payloadBinding.businessPayloadHash)) throw new Error('Avalanche businessPayloadHash mismatch');
  if (!sameHex(warpPayload.receiver, hxmsg.targetAction.receiver)) throw new Error('Avalanche receiver mismatch');
  if (!sameHex(computeFeedbackHash(warpPayload.feedback), computeFeedbackHash(hxmsg.feedback))) {
    throw new Error('Avalanche feedback policy mismatch');
  }
  if (!sameHex(computeAtomicityHash(warpPayload.atomicity), computeAtomicityHash(hxmsg.atomicity))) {
    throw new Error('Avalanche atomicity policy mismatch');
  }
  if (Number(warpPayload.expireAt || hxmsg.header.deliveryExpireAt) < Math.floor(Date.now() / 1000)) {
    throw new Error('Avalanche payloadBinding expired');
  }

  verifyQuorumWeight({
    signedWeight: weightedProof.signedWeight,
    totalWeight: trustedSet.totalWeight,
    quorumNumerator: trustedSet.quorumNumerator,
    quorumDenominator: trustedSet.quorumDenominator,
  });
  if (String(weightedProof.totalWeight) !== String(trustedSet.totalWeight)) {
    throw new Error('Avalanche verified totalWeight mismatch');
  }

  const policyHash = hashProofObject({
    validatorSetRef,
    canonicalOrdering: validatorSetRef.canonicalOrdering,
  });
  if (!sameHex(policyHash, hxmsg.verification?.policyRef?.policyHash)) {
    throw new Error('Avalanche validator policy hash mismatch');
  }
  if (!sameHex(policyHash, warpPayload.validatorPolicyHash)) {
    throw new Error('Avalanche Warp validator policy binding mismatch');
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
    targetChainType: hxmsg.target.chainType,
    targetChainID: hxmsg.target.chainID,
    targetDomainID: hxmsg.target.domainID,
    targetObject: hxmsg.targetAction.targetObject,
    functionSelector: hxmsg.targetAction.functionSelector,
    callDataHash: hxmsg.targetAction.callDataHash,
    receiver: hxmsg.targetAction.receiver,
  });
  if (!sameHex(targetExecutionHash, hxmsg.payloadBinding.targetExecutionHash)) {
    throw new Error('Avalanche targetExecutionHash mismatch');
  }

  if (chainState) {
    chainState.avalanche = {
      trustMode: trustedSet.trustMode,
      networkID: trustedSet.networkID,
      genesisHash: trustedSet.genesisHash,
      acceptedPChainHeight: trustedSet.acceptedHeight,
      verifiedPChainHeight: trustedSet.pChainHeight,
      validatorSetHash: trustedSet.validatorSetHash,
      totalWeight: trustedSet.totalWeight,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    if (typeof saveChainState === 'function') saveChainState();
  }

  return {
    adapter: 'avalanche-icm-bls',
    verified: true,
    warpMessageID: sourceProof.warpMessageID,
    pChainHeight: Number(validatorSetRef.pChainHeight || 0),
    validatorSetHash: trustedSet.validatorSetHash,
    pChainGenesisHash: trustedSet.genesisHash,
    pChainTrustMode: trustedSet.trustMode,
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
