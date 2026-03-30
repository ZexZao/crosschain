const { ethers } = require('ethers');

function buildWallet(label) {
  const privateKey = ethers.keccak256(ethers.toUtf8Bytes(`crosschain-validator:${label}`));
  return new ethers.Wallet(privateKey);
}

const trustedSets = {
  mychannel: {
    validatorSetId: 'fabric-mychannel-v1',
    threshold: 3,
    validators: [
      buildWallet('mychannel-validator-1'),
      buildWallet('mychannel-validator-2'),
      buildWallet('mychannel-validator-3'),
      buildWallet('mychannel-validator-4')
    ]
  }
};

function getTrustedValidatorSet(channelName) {
  const set = trustedSets[channelName];
  if (!set) {
    throw new Error(`No trusted validator set configured for channel ${channelName}`);
  }
  return set;
}

function listTrustedValidatorAddresses(channelName) {
  return getTrustedValidatorSet(channelName).validators.map((wallet) => wallet.address);
}

module.exports = {
  getTrustedValidatorSet,
  listTrustedValidatorAddresses
};
