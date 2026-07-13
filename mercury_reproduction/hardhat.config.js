require('@nomicfoundation/hardhat-toolbox');
const path = require('path');

const parentRoot = process.env.PARENT_PROJECT_ROOT
  || path.resolve(__dirname, '../crosschain_experiment');
const { loadDotEnv } = require(path.join(parentRoot, 'shared/env'));

loadDotEnv(path.join(parentRoot, '.env'));

module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      viaIR: true,
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || '',
      accounts: process.env.SEPOLIA_PRIVATE_KEY ? [process.env.SEPOLIA_PRIVATE_KEY] : [],
      chainId: 11155111,
    },
    localhost: {
      url: process.env.EVM_RPC || 'http://127.0.0.1:8545',
    },
  },
};
