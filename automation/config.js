const path = require('path');
const fs = require('fs-extra');
const { teeURLsFromEnv } = require('../shared/tee/subnet-routing');
const { ChainType, bytes32FromText, chainIdToBytes32 } = require('../shared/hxmsg');

const ROOT = path.join(__dirname, '..');
const LOCAL_EVM_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const LOCAL_AVALANCHE_KEY = '0x56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027';

function deployment(file) {
  const absolute = path.resolve(ROOT, file);
  if (!fs.pathExistsSync(absolute)) throw new Error(`deployment not found: ${absolute}`);
  return { file: absolute, ...fs.readJsonSync(absolute) };
}

function evmProfile(name) {
  if (name === 'avalanche') {
    return {
      kind: 'evm',
      name,
      rpc: process.env.AVALANCHE_RPC_URL || 'http://127.0.0.1:9650/ext/bc/C/rpc',
      privateKey: process.env.AVALANCHE_PRIVATE_KEY || LOCAL_AVALANCHE_KEY,
      deployment: deployment(process.env.AVALANCHE_DEPLOYMENT_FILE || 'runtime/avalanche-deployment.json'),
      chainType: ChainType.AVALANCHE,
      finality: 'avalanche-warp',
    };
  }
  if (name === 'sepolia') {
    return {
      kind: 'evm',
      name,
      rpc: process.env.SEPOLIA_RPC_URL,
      privateKey: process.env.SEPOLIA_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY,
      deployment: deployment(process.env.SEPOLIA_DEPLOYMENT_FILE || 'runtime/deployment.sepolia.json'),
      chainType: ChainType.EVM,
      finality: 'ethereum-sync-committee',
    };
  }
  return {
    kind: 'evm',
    name: 'ethereum',
    rpc: process.env.EVM_RPC || 'http://127.0.0.1:8545',
    privateKey: process.env.LOCAL_EVM_PRIVATE_KEY || LOCAL_EVM_KEY,
    deployment: deployment(process.env.EVM_DEPLOYMENT_FILE || 'runtime/deployment.json'),
    chainType: ChainType.EVM,
    finality: 'local-header-committee',
  };
}

function fabricProfile() {
  return {
    kind: 'fabric',
    name: 'fabric',
    connectionProfile: path.resolve(ROOT, process.env.FABRIC_CONNECTION_PROFILE || 'fabric-network/connection-org1.json'),
    walletPath: path.resolve(ROOT, process.env.FABRIC_WALLET_PATH || 'fabric-network/wallet'),
    identity: process.env.FABRIC_IDENTITY || 'appUser',
    channel: process.env.FABRIC_CHANNEL || 'mychannel',
    chaincode: process.env.FABRIC_CHAINCODE || 'xcall',
    asLocalhost: process.env.FABRIC_AS_LOCALHOST !== 'false',
    chainType: ChainType.FABRIC,
    finality: 'deterministic',
  };
}

function chainProfile(name) {
  if (name === 'fabric') return fabricProfile();
  return evmProfile(name);
}

function enabledChainNames() {
  return String(process.env.AUTOMATION_ENABLED_CHAINS || '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
}

function sourceProfiles() {
  return enabledChainNames().map(chainProfile);
}

function targetChainID(profile) {
  return profile.kind === 'fabric'
    ? bytes32FromText(`fabric-${profile.channel}`)
    : chainIdToBytes32(profile.deployment.chainId);
}

function resolveTargetProfile(targetID, preferredName) {
  if (preferredName) return chainProfile(preferredName);
  const candidates = [...new Set([...enabledChainNames(), 'ethereum', 'sepolia', 'avalanche', 'fabric'])];
  for (const name of candidates) {
    try {
      const profile = chainProfile(name);
      if (targetChainID(profile).toLowerCase() === String(targetID).toLowerCase()) return profile;
    } catch (_error) {
      // A two-chain local experiment intentionally leaves unrelated deployments unavailable.
    }
  }
  throw new Error(`no target profile configured for chainID ${targetID}`);
}

function teeURLs(sourceChainType) {
  return teeURLsFromEnv({ sourceChainType });
}

module.exports = {
  ROOT,
  chainProfile,
  sourceProfiles,
  enabledChainNames,
  targetChainID,
  resolveTargetProfile,
  teeURLs,
};
