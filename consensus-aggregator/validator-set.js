const { ethers } = require('ethers');

function buildWallet(label) {
  const privateKey = ethers.keccak256(ethers.toUtf8Bytes(`crosschain-validator:${label}`));
  return new ethers.Wallet(privateKey);
}

function buildValidator({ id, label, url }) {
  const wallet = buildWallet(label);
  return {
    id,
    label,
    url,
    address: wallet.address
  };
}

const trustedSets = {
  mychannel: {
    validatorSetId: 'fabric-mychannel-v1',
    threshold: 3,
    validators: [
      buildValidator({
        id: 'validator-node-1',
        label: 'mychannel-validator-1',
        url: process.env.VALIDATOR_NODE_1_URL || 'http://validator-node-1:9101'
      }),
      buildValidator({
        id: 'validator-node-2',
        label: 'mychannel-validator-2',
        url: process.env.VALIDATOR_NODE_2_URL || 'http://validator-node-2:9102'
      }),
      buildValidator({
        id: 'validator-node-3',
        label: 'mychannel-validator-3',
        url: process.env.VALIDATOR_NODE_3_URL || 'http://validator-node-3:9103'
      }),
      buildValidator({
        id: 'validator-node-4',
        label: 'mychannel-validator-4',
        url: process.env.VALIDATOR_NODE_4_URL || 'http://validator-node-4:9104'
      })
    ]
  },
  'evm-localhost': {
    validatorSetId: 'evm-localhost-v1',
    threshold: 3,
    validators: [
      buildValidator({
        id: 'evm-validator-node-1',
        label: 'evm-localhost-validator-1',
        url: process.env.EVM_VALIDATOR_NODE_1_URL || 'http://evm-validator-node-1:9301'
      }),
      buildValidator({
        id: 'evm-validator-node-2',
        label: 'evm-localhost-validator-2',
        url: process.env.EVM_VALIDATOR_NODE_2_URL || 'http://evm-validator-node-2:9302'
      }),
      buildValidator({
        id: 'evm-validator-node-3',
        label: 'evm-localhost-validator-3',
        url: process.env.EVM_VALIDATOR_NODE_3_URL || 'http://evm-validator-node-3:9303'
      }),
      buildValidator({
        id: 'evm-validator-node-4',
        label: 'evm-localhost-validator-4',
        url: process.env.EVM_VALIDATOR_NODE_4_URL || 'http://evm-validator-node-4:9304'
      })
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
  return getTrustedValidatorSet(channelName).validators.map((validator) => validator.address);
}

function getValidatorWalletByLabel(label) {
  return buildWallet(label);
}

module.exports = {
  buildWallet,
  getTrustedValidatorSet,
  listTrustedValidatorAddresses,
  getValidatorWalletByLabel
};
