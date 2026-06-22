const { ethers } = require('ethers');
const { computeHXMsgDeliveryDigest, computeHXMsgDigest, toMinimalHXMsg } = require('./hash');

const BATCH_DOMAIN = ethers.id('HXMSG_BATCH_V1');

function normalizeMinimal(hxmsgOrMinimal) {
  return Array.isArray(hxmsgOrMinimal) ? hxmsgOrMinimal : toMinimalHXMsg(hxmsgOrMinimal);
}

function computeBatchLeaf(hxmsgOrMinimal) {
  const minimal = normalizeMinimal(hxmsgOrMinimal);
  const deliveryDigest = computeHXMsgDeliveryDigest(minimal);
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32'],
      [minimal[0], minimal[1], deliveryDigest]
    )
  );
}

function hashPair(left, right) {
  const [a, b] = BigInt(left) <= BigInt(right) ? [left, right] : [right, left];
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32'],
      [a, b]
    )
  );
}

function buildMerkleTree(leaves) {
  if (!leaves.length) throw new Error('batch leaves are required');
  const levels = [leaves.map((leaf) => String(leaf).toLowerCase())];
  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(hashPair(prev[i], prev[i + 1] || prev[i]));
    }
    levels.push(next);
  }
  return levels;
}

function getMerkleProof(levels, index) {
  const proof = [];
  let cursor = index;
  for (let level = 0; level < levels.length - 1; level += 1) {
    const nodes = levels[level];
    const siblingIndex = cursor % 2 === 0 ? cursor + 1 : cursor - 1;
    proof.push(nodes[siblingIndex] || nodes[cursor]);
    cursor = Math.floor(cursor / 2);
  }
  return proof;
}

function computeBatchSigningDigest({ batchID, batchRoot, batchSize, targetChainID }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint64', 'bytes32'],
      [BATCH_DOMAIN, batchID, batchRoot, Number(batchSize), targetChainID]
    )
  );
}

function buildHXMsgBatch(hxmsgs) {
  if (!Array.isArray(hxmsgs) || hxmsgs.length === 0) throw new Error('hxmsgs are required');
  const minimals = hxmsgs.map(toMinimalHXMsg);
  const leaves = minimals.map(computeBatchLeaf);
  const levels = buildMerkleTree(leaves);
  const batchRoot = levels[levels.length - 1][0];
  const batchID = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'uint64'],
      [BATCH_DOMAIN, batchRoot, minimals.length]
    )
  );
  const targetChainID = minimals[0][3];
  for (const minimal of minimals) {
    if (String(minimal[3]).toLowerCase() !== String(targetChainID).toLowerCase()) {
      throw new Error('all batch messages must target the same chain');
    }
  }
  const batchSigningDigest = computeBatchSigningDigest({
    batchID,
    batchRoot,
    batchSize: minimals.length,
    targetChainID,
  });
  return {
    batchID,
    batchRoot,
    batchSize: minimals.length,
    targetChainID,
    batchSigningDigest,
    leaves,
    proofs: leaves.map((_leaf, index) => getMerkleProof(levels, index)),
  };
}

module.exports = {
  BATCH_DOMAIN,
  computeBatchLeaf,
  computeBatchSigningDigest,
  buildHXMsgBatch,
  computeHXMsgDigest,
};
