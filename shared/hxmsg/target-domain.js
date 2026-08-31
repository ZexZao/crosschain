const { ethers } = require('ethers');

const TARGET_EXECUTION_DOMAIN_V1 = ethers.id('HXMSG_TARGET_EXECUTION_DOMAIN_V1');
const TARGET_EXECUTION_HASH_V2 = ethers.id('HXMSG_TARGET_EXECUTION_V2');

function requireBytes32(value, label) {
  if (!value || !ethers.isHexString(value, 32) || value === ethers.ZeroHash) {
    throw new Error(`${label} must be a non-zero bytes32`);
  }
  return value;
}

function computeEvmExecutionDomainID({ chainType, chainID, gatewayAddress }) {
  requireBytes32(chainID, 'chainID');
  const gateway = ethers.getAddress(gatewayAddress);
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint8', 'bytes32', 'address'],
      [TARGET_EXECUTION_DOMAIN_V1, Number(chainType), chainID, gateway]
    )
  );
}

function computeFabricExecutionDomainID({ chainID, targetObject }) {
  requireBytes32(chainID, 'chainID');
  requireBytes32(targetObject, 'targetObject');
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint8', 'bytes32', 'bytes32'],
      [TARGET_EXECUTION_DOMAIN_V1, 2, chainID, targetObject]
    )
  );
}

module.exports = {
  TARGET_EXECUTION_DOMAIN_V1,
  TARGET_EXECUTION_HASH_V2,
  computeEvmExecutionDomainID,
  computeFabricExecutionDomainID,
};
