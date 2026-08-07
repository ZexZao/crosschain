const { ethers } = require('ethers');

const ABI = ethers.AbiCoder.defaultAbiCoder();
const LIFECYCLE_CHECKPOINT_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes('HXMSG_LIFECYCLE_CHECKPOINT_V1'));
const TERMINAL_STATUSES = new Set([3, 4, 5, 6]);

function normalizeRecord(record) {
  const status = Number(record.status);
  if (!TERMINAL_STATUSES.has(status)) throw new Error(`request is not terminal: ${record.requestID}`);
  return {
    requestID: record.requestID,
    status,
    commitmentType: Number(record.commitmentType || 0),
    targetExecutionHash: record.targetExecutionHash,
    failureActionHash: record.failureActionHash || ethers.ZeroHash,
    responseDigest: record.responseDigest || ethers.ZeroHash,
    escrowRefunded: Boolean(record.escrowRefunded),
    escrowSettled: Boolean(record.escrowSettled),
  };
}

function computeLifecycleTerminalRoot(records) {
  if (!Array.isArray(records) || records.length === 0 || records.length > 256) {
    throw new Error('checkpoint records must contain 1..256 entries');
  }
  let root = ethers.ZeroHash;
  for (const raw of records) {
    const record = normalizeRecord(raw);
    if (record.commitmentType === 3 && !record.escrowRefunded && !record.escrowSettled) {
      throw new Error(`token escrow is not terminal: ${record.requestID}`);
    }
    const leaf = ethers.keccak256(ABI.encode(
      ['bytes32', 'uint8', 'uint8', 'bytes32', 'bytes32', 'bytes32', 'bool', 'bool'],
      [
        record.requestID,
        record.status,
        record.commitmentType,
        record.targetExecutionHash,
        record.failureActionHash,
        record.responseDigest,
        record.escrowRefunded,
        record.escrowSettled,
      ]
    ));
    root = ethers.keccak256(ABI.encode(['bytes32', 'bytes32'], [root, leaf]));
  }
  return root;
}

function computeLifecycleCheckpointDigest(checkpoint) {
  return ethers.keccak256(ABI.encode(
    ['bytes32', 'uint256', 'address', 'uint64', 'bytes32', 'bytes32', 'uint256'],
    [
      LIFECYCLE_CHECKPOINT_DOMAIN,
      BigInt(checkpoint.chainID),
      ethers.getAddress(checkpoint.lifecycleContract),
      Number(checkpoint.epoch),
      checkpoint.previousCheckpointRoot || ethers.ZeroHash,
      checkpoint.terminalStateRoot,
      Number(checkpoint.requestCount),
    ]
  ));
}

function verifyLifecycleCheckpoint(checkpoint, records) {
  const terminalStateRoot = computeLifecycleTerminalRoot(records);
  if (terminalStateRoot.toLowerCase() !== String(checkpoint.terminalStateRoot).toLowerCase()) {
    throw new Error('checkpoint terminalStateRoot mismatch');
  }
  if (Number(checkpoint.requestCount) !== records.length) throw new Error('checkpoint requestCount mismatch');
  return {
    terminalStateRoot,
    signingDigest: computeLifecycleCheckpointDigest(checkpoint),
    requestID: ethers.keccak256(ABI.encode(
      ['address', 'uint64', 'bytes32'],
      [checkpoint.lifecycleContract, Number(checkpoint.epoch), terminalStateRoot]
    )),
  };
}

module.exports = {
  LIFECYCLE_CHECKPOINT_DOMAIN,
  computeLifecycleTerminalRoot,
  computeLifecycleCheckpointDigest,
  verifyLifecycleCheckpoint,
};
