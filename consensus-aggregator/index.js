const axios = require('axios');
const { ethers } = require('ethers');
const {
  computeValidatorSetHash,
  computeConsensusMessage
} = require('../shared/consensus-proof');
const { getTrustedValidatorSet } = require('./validator-set');
const {
  blsHashToCurve,
  blsAggregateSignatures,
  blsVerifyAggregate,
} = require('../shared/bls');

async function requestValidatorSignature(validator, payload, timeoutMs = 4000) {
  const response = await axios.post(`${validator.url}/sign`, payload, {
    timeout: timeoutMs
  });

  const data = response.data || {};
  return {
    signer: data.signer,
    signature: data.signature
  };
}

async function buildConsensusAggregate({
  channelName,
  networkName,
  blockNumber,
  blockHash,
  eventRoot,
  requestID,
  payloadHash,
  txId
}) {
  const validatorScope = channelName || networkName;
  if (!validatorScope) {
    throw new Error('channelName or networkName is required');
  }
  const validatorSet = getTrustedValidatorSet(validatorScope);
  const validatorAddresses = validatorSet.validators.map((validator) => validator.address);
  const validatorSetHash = computeValidatorSetHash(
    validatorSet.validatorSetId,
    validatorSet.threshold,
    validatorAddresses
  );
  const signedMessage = computeConsensusMessage({
    channelName: validatorScope,
    blockNumber,
    blockHash,
    eventRoot,
    requestID,
    payloadHash,
    validatorSetHash
  });

  const signaturePayload = {
    validatorSetId: validatorSet.validatorSetId,
    channelName: validatorScope,
    blockNumber,
    blockHash,
    eventRoot,
    requestID,
    payloadHash,
    validatorSetHash,
    txId,
    digest: signedMessage
  };

  const signatureResults = await Promise.allSettled(
    validatorSet.validators.map((validator) =>
      requestValidatorSignature(validator, signaturePayload).then((result) => ({
        ...result,
        validatorId: validator.id,
        expectedSigner: validator.address
      }))
    )
  );

  const signatures = signatureResults
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
    .filter((item) => item.signer && item.signature);

  if (signatures.length < validatorSet.threshold) {
    const failureCount = signatureResults.filter((result) => result.status !== 'fulfilled').length;
    throw new Error(
      `consensus threshold not satisfied: collected ${signatures.length}/${validatorSet.threshold} signatures (${failureCount} validator requests failed)`
    );
  }

  return {
    validatorSetId: validatorSet.validatorSetId,
    validatorSetHash,
    validatorAddresses,
    threshold: validatorSet.threshold,
    signedMessage,
    signatures: signatures.map(({ signer, signature }) => ({ signer, signature })),
    signatureScheme: 'threshold-ecdsa'
  };
}

async function requestValidatorBlsSignature(validator, payload, timeoutMs = 4000) {
  const response = await axios.post(`${validator.url}/bls-sign`, payload, {
    timeout: timeoutMs
  });

  const data = response.data || {};
  return {
    validatorId: data.validatorId,
    blsSignature: data.blsSignature
  };
}

async function buildBlsConsensusAggregate({
  channelName,
  networkName,
  blockNumber,
  blockHash,
  eventRoot,
  requestID,
  payloadHash,
  txId
}) {
  const validatorScope = channelName || networkName;
  if (!validatorScope) {
    throw new Error('channelName or networkName is required');
  }
  const validatorSet = getTrustedValidatorSet(validatorScope);
  const validatorSetHash = computeValidatorSetHash(
    validatorSet.validatorSetId,
    validatorSet.threshold,
    validatorSet.validators.map((v) => v.address)
  );

  const consensusMessage = computeConsensusMessage({
    channelName: validatorScope,
    blockNumber,
    blockHash,
    eventRoot,
    requestID,
    payloadHash,
    validatorSetHash
  });

  const payload = {
    validatorSetId: validatorSet.validatorSetId,
    channelName: validatorScope,
    blockNumber,
    blockHash,
    eventRoot,
    requestID,
    payloadHash,
    txId,
    consensusMessage,
  };

  const sigResults = await Promise.allSettled(
    validatorSet.validators.map((validator) =>
      requestValidatorBlsSignature(validator, payload).then((result) => ({
        ...result,
        validatorId: validator.id,
      }))
    )
  );

  const signatures = sigResults
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
    .filter((item) => item.blsSignature);

  if (signatures.length < validatorSet.threshold) {
    const failureCount = sigResults.filter((r) => r.status !== 'fulfilled').length;
    throw new Error(
      `BLS consensus threshold not satisfied: collected ${signatures.length}/${validatorSet.threshold} signatures (${failureCount} validator requests failed)`
    );
  }

  // BLS aggregate: N sigs → 1 sig (single pairing to verify)
  const aggregateSig = blsAggregateSignatures(signatures.map((s) => s.blsSignature));

  return {
    validatorSetId: validatorSet.validatorSetId,
    validatorSetHash,
    threshold: validatorSet.threshold,
    aggregateSig,
    validatorBlsPubkeys: validatorSet.validators.map((v) => v.blsPubkey),
    consensusMessage,
    signatureScheme: 'bls-aggregate',
  };
}

async function buildV3ConsensusProof({
  channelName,
  networkName,
  blockNumber,
  blockHash,
  eventRoot,
  requestID,
  payloadHash,
  txId
}) {
  const scope = channelName || networkName;
  if (!scope) throw new Error('channelName or networkName is required');
  const validatorSet = getTrustedValidatorSet(scope);

  const consensusMessage = computeConsensusMessage({
    channelName: scope,
    blockNumber,
    blockHash,
    eventRoot,
    requestID,
    payloadHash,
    validatorSetHash: ethers.ZeroHash, // V3 doesn't use validatorSetHash on-chain
  });

  const payload = {
    validatorSetId: validatorSet.validatorSetId,
    channelName: scope,
    blockNumber,
    blockHash,
    eventRoot,
    requestID,
    payloadHash,
    txId,
    digest: consensusMessage,
  };

  const sigResults = await Promise.allSettled(
    validatorSet.validators.map((v) =>
      requestValidatorSignature(v, payload).then((r) => ({
        signer: r.signer,
        signature: r.signature,
        validatorId: v.id,
      }))
    )
  );

  const collected = sigResults
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter((item) => item.signer && item.signature);

  if (collected.length < validatorSet.threshold) {
    throw new Error(
      `V3 consensus threshold not satisfied: ${collected.length}/${validatorSet.threshold}`
    );
  }

  // Sort by signer address (ascending) for on-chain dedup
  collected.sort((a, b) => {
    const addrA = ethers.getAddress(a.signer).toLowerCase();
    const addrB = ethers.getAddress(b.signer).toLowerCase();
    return addrA < addrB ? -1 : addrA > addrB ? 1 : 0;
  });

  return {
    validatorSetId: validatorSet.validatorSetId,
    threshold: validatorSet.threshold,
    consensusMessage,
    signatures: collected.map(({ signer, signature }) => ({ signer, signature })),
    signerAddresses: collected.map(({ signer }) => signer),
    signatureScheme: 'ecdsa-threshold-v3',
  };
}

module.exports = {
  buildConsensusAggregate,
  buildBlsConsensusAggregate,
  buildV3ConsensusProof,
};
