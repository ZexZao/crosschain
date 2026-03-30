const { ethers } = require('ethers');

function normalizeAddresses(addresses) {
  return [...addresses].map((address) => ethers.getAddress(address)).sort();
}

function computeValidatorSetHash(validatorSetId, threshold, addresses) {
  const normalized = normalizeAddresses(addresses);
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['string', 'uint16', 'address[]'],
      [validatorSetId, Number(threshold), normalized]
    )
  );
}

function computeConsensusMessage({
  channelName,
  blockNumber,
  blockHash,
  eventRoot,
  requestID,
  payloadHash,
  validatorSetHash
}) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['string', 'uint64', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [
        channelName,
        Number(blockNumber),
        blockHash,
        eventRoot,
        requestID,
        payloadHash,
        validatorSetHash
      ]
    )
  );
}

function signConsensusMessage(wallet, digest) {
  return wallet.signingKey.sign(digest).serialized;
}

function recoverConsensusSigner(digest, signature) {
  return ethers.recoverAddress(digest, signature);
}

module.exports = {
  normalizeAddresses,
  computeValidatorSetHash,
  computeConsensusMessage,
  signConsensusMessage,
  recoverConsensusSigner
};
