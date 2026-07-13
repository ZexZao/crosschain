const { ethers } = require('ethers');
const crypto = require('crypto');
const { Serialize } = require('eosjs');
const { TextDecoder, TextEncoder } = require('util');

const ABI = ethers.AbiCoder.defaultAbiCoder();

function bytes32(value) {
  if (!value) return ethers.ZeroHash;
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)) return value;
  if (typeof value === 'string' && /^[0-9a-fA-F]{64}$/.test(value)) return `0x${value}`;
  return ethers.keccak256(ethers.toUtf8Bytes(String(value)));
}

function stableStringify(value) {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashJSON(value) {
  return ethers.keccak256(ethers.toUtf8Bytes(stableStringify(value)));
}

function normalizeAddress(value) {
  return ethers.getAddress(value);
}

function mercuryRequestDigest(request) {
  return ethers.keccak256(ABI.encode(
    [
      'string', 'bytes32', 'address', 'address', 'address', 'uint256',
      'bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'uint64',
    ],
    [
      'MERCURY_REQUEST_V1',
      bytes32(request.sourceChainID),
      normalizeAddress(request.sourceVault),
      normalizeAddress(request.owner),
      normalizeAddress(request.sourceAsset),
      BigInt(request.sourceAmount),
      bytes32(request.targetChainID),
      bytes32(request.targetVault),
      bytes32(request.targetAsset),
      bytes32(request.targetAccount),
      BigInt(request.targetAmount),
      BigInt(request.requestNonce || 0),
    ]
  ));
}

function evmTransferSetHash(transfers) {
  return ethers.keccak256(ABI.encode(
    ['tuple(bytes32 depositID,address token,address receiver,uint256 amount)[]'],
    [transfers.map((item) => ({
      depositID: bytes32(item.depositID),
      token: normalizeAddress(item.token),
      receiver: normalizeAddress(item.receiver),
      amount: BigInt(item.amount),
    }))]
  ));
}

function mercuryEvmBatchDigest({ chainID, targetVault, batchID, transfers, transferSetHash }) {
  const setHash = transferSetHash || evmTransferSetHash(transfers);
  return ethers.keccak256(ABI.encode(
    ['string', 'uint256', 'address', 'bytes32', 'bytes32'],
    ['MERCURY_TRANSFER_BATCH_V1', BigInt(chainID), normalizeAddress(targetVault), bytes32(batchID), setHash]
  ));
}

function mercuryEOSBatchDigest({ targetChainID, targetVault, batchID, transfers, transferSetHash }) {
  if (transferSetHash) throw new Error('EOS batch digest must be computed from transfers');
  const buffer = new Serialize.SerialBuffer({ textEncoder: new TextEncoder(), textDecoder: new TextDecoder() });
  buffer.pushArray(Serialize.hexToUint8Array(bytes32(targetChainID).slice(2)));
  buffer.pushName(String(targetVault));
  buffer.pushArray(Serialize.hexToUint8Array(bytes32(batchID).slice(2)));
  buffer.pushVaruint32(transfers.length);
  for (const item of transfers) {
    buffer.pushArray(Serialize.hexToUint8Array(bytes32(item.depositID || item.deposit_id).slice(2)));
    buffer.pushName(String(item.receiver));
    buffer.pushAsset(String(item.quantity));
  }
  return `0x${crypto.createHash('sha256').update(buffer.asUint8Array()).digest('hex')}`;
}

function mercuryConfirmationDigest({ chainID, sourceVault, depositID, requestHash, targetTxID }) {
  return ethers.keccak256(ABI.encode(
    ['string', 'uint256', 'address', 'bytes32', 'bytes32', 'bytes32'],
    [
      'MERCURY_CONFIRM_V1',
      BigInt(chainID),
      normalizeAddress(sourceVault),
      bytes32(depositID),
      bytes32(requestHash),
      bytes32(targetTxID),
    ]
  ));
}

function mercuryCheckpointDigest({ chainID, sourceVault, checkpointID, targetTxRoot, depositIDs, idSetHash }) {
  const setHash = idSetHash || ethers.keccak256(ABI.encode(['bytes32[]'], [depositIDs.map(bytes32)]));
  return ethers.keccak256(ABI.encode(
    ['string', 'uint256', 'address', 'bytes32', 'bytes32', 'bytes32'],
    [
      'MERCURY_CHECKPOINT_V1',
      BigInt(chainID),
      normalizeAddress(sourceVault),
      bytes32(checkpointID),
      bytes32(targetTxRoot),
      setHash,
    ]
  ));
}

module.exports = {
  bytes32,
  stableStringify,
  hashJSON,
  mercuryRequestDigest,
  evmTransferSetHash,
  mercuryEvmBatchDigest,
  mercuryEOSBatchDigest,
  mercuryConfirmationDigest,
  mercuryCheckpointDigest,
};
