const { ChainType } = require('../hxmsg');

const DEFAULT_TEE_SUBNETS = Object.freeze({
  ethereum: {
    subnetID: 'ethereum-proof-subnet',
    profile: 'ethereum',
    urls: [
      'http://127.0.0.1:9000',
      'http://127.0.0.1:9001',
      'http://127.0.0.1:9002',
      'http://127.0.0.1:9003',
      'http://127.0.0.1:9004',
    ],
  },
  fabric: {
    subnetID: 'fabric-proof-subnet',
    profile: 'fabric',
    urls: [
      'http://127.0.0.1:9100',
      'http://127.0.0.1:9101',
      'http://127.0.0.1:9102',
      'http://127.0.0.1:9103',
      'http://127.0.0.1:9104',
    ],
  },
  avalanche: {
    subnetID: 'avalanche-proof-subnet',
    profile: 'avalanche',
    urls: [
      'http://127.0.0.1:9020',
      'http://127.0.0.1:9021',
      'http://127.0.0.1:9022',
      'http://127.0.0.1:9023',
      'http://127.0.0.1:9024',
    ],
  },
});

function parseURLs(text) {
  return String(text || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

function urlsForSubnet(profile) {
  const key = String(profile || '').toLowerCase();
  const envName = `TEE_${key.toUpperCase()}_SUBNET_URLS`;
  return parseURLs(process.env[envName]).length
    ? parseURLs(process.env[envName])
    : (DEFAULT_TEE_SUBNETS[key]?.urls || DEFAULT_TEE_SUBNETS.ethereum.urls);
}

function defaultSubnetProfileForSourceChain(chainType) {
  switch (Number(chainType)) {
    case ChainType.EVM:
      return 'ethereum';
    case ChainType.FABRIC:
      return 'fabric';
    case ChainType.AVALANCHE:
      return 'avalanche';
    default:
      return 'ethereum';
  }
}

function defaultTEEURLsForSourceChain(chainType) {
  return urlsForSubnet(defaultSubnetProfileForSourceChain(chainType));
}

function teeURLsFromEnv({ sourceChainType, fallbackProfile = 'ethereum' } = {}) {
  const explicit = parseURLs(process.env.TEE_URLS || process.env.TEE_URL);
  if (explicit.length) return explicit;
  if (sourceChainType !== undefined) return defaultTEEURLsForSourceChain(sourceChainType);
  return urlsForSubnet(fallbackProfile);
}

module.exports = {
  DEFAULT_TEE_SUBNETS,
  parseURLs,
  urlsForSubnet,
  defaultSubnetProfileForSourceChain,
  defaultTEEURLsForSourceChain,
  teeURLsFromEnv,
};
