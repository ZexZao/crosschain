const { ethers } = require('ethers');

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function encodeJsonRef(value) {
  return ethers.hexlify(ethers.toUtf8Bytes(stableStringify(value)));
}

function decodeJsonRef(encodedRef) {
  return JSON.parse(ethers.toUtf8String(encodedRef));
}

function addressToBytes32(address) {
  return ethers.zeroPadValue(ethers.getAddress(address), 32);
}

function bytes32FromText(text) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(text)));
}

function chainIdToBytes32(chainId) {
  return ethers.zeroPadValue(ethers.toBeHex(BigInt(chainId)), 32);
}

module.exports = {
  stableStringify,
  encodeJsonRef,
  decodeJsonRef,
  addressToBytes32,
  bytes32FromText,
  chainIdToBytes32,
};
