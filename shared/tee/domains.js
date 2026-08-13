const { ethers } = require('ethers');
const { ChainType } = require('../hxmsg');

const SUBNET_CLUSTER_DOMAIN = 'HXMSG_TEE_SUBNET_CLUSTER_V1';
const SUBNET_CERTIFICATE_DOMAIN = ethers.id('HXMSG_TEE_SUBNET_CERTIFICATE_V1');

function sourceChainTypeForProfile(profile) {
  switch (String(profile || '').toLowerCase()) {
    case 'fabric':
      return ChainType.FABRIC;
    case 'avalanche':
      return ChainType.AVALANCHE;
    case 'ethereum':
    case 'evm':
      return ChainType.EVM;
    default:
      throw new Error(`unsupported TEE subnet profile: ${profile}`);
  }
}

function clusterIDForSubnet(subnetID) {
  if (!subnetID) throw new Error('TEE subnetID is required');
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['string', 'string'],
      [SUBNET_CLUSTER_DOMAIN, String(subnetID)]
    )
  );
}

function subnetSigningDigest({ clusterID, epoch, sourceChainType, sourceChainID, subjectDigest }) {
  if (!clusterID || clusterID === ethers.ZeroHash) throw new Error('clusterID is required');
  if (!sourceChainID || sourceChainID === ethers.ZeroHash) throw new Error('sourceChainID is required');
  if (!subjectDigest || subjectDigest === ethers.ZeroHash) throw new Error('subjectDigest is required');
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'uint64', 'uint8', 'bytes32', 'bytes32'],
      [
        SUBNET_CERTIFICATE_DOMAIN,
        clusterID,
        Number(epoch),
        Number(sourceChainType),
        sourceChainID,
        subjectDigest,
      ]
    )
  );
}

module.exports = {
  SUBNET_CLUSTER_DOMAIN,
  SUBNET_CERTIFICATE_DOMAIN,
  sourceChainTypeForProfile,
  clusterIDForSubnet,
  subnetSigningDigest,
};
