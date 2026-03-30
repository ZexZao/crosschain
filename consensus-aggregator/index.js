const {
  computeValidatorSetHash,
  computeConsensusMessage,
  signConsensusMessage
} = require('../shared/consensus-proof');
const { getTrustedValidatorSet } = require('./validator-set');

function buildConsensusAggregate({
  channelName,
  blockNumber,
  blockHash,
  eventRoot,
  requestID,
  payloadHash
}) {
  const validatorSet = getTrustedValidatorSet(channelName);
  const validatorAddresses = validatorSet.validators.map((wallet) => wallet.address);
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

  const signatures = validatorSet.validators
    .slice(0, validatorSet.threshold)
    .map((wallet) => ({
      signer: wallet.address,
      signature: signConsensusMessage(wallet, signedMessage)
    }));

  return {
    validatorSetId: validatorSet.validatorSetId,
    validatorSetHash,
    validatorAddresses,
    threshold: validatorSet.threshold,
    signedMessage,
    signatures,
    signatureScheme: 'threshold-ecdsa'
  };
}

module.exports = {
  buildConsensusAggregate
};
