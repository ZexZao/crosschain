const axios = require('axios');
const {
  computeValidatorSetHash,
  computeConsensusMessage
} = require('../shared/consensus-proof');
const { getTrustedValidatorSet } = require('./validator-set');

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
  blockNumber,
  blockHash,
  eventRoot,
  requestID,
  payloadHash,
  txId
}) {
  const validatorSet = getTrustedValidatorSet(channelName);
  const validatorAddresses = validatorSet.validators.map((validator) => validator.address);
  const validatorSetHash = computeValidatorSetHash(
    validatorSet.validatorSetId,
    validatorSet.threshold,
    validatorAddresses
  );
  const signedMessage = computeConsensusMessage({
    channelName,
    blockNumber,
    blockHash,
    eventRoot,
    requestID,
    payloadHash,
    validatorSetHash
  });

  const signaturePayload = {
    validatorSetId: validatorSet.validatorSetId,
    channelName,
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

module.exports = {
  buildConsensusAggregate
};
