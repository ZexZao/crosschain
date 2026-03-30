const { ethers } = require('ethers');

function hashPair(left, right) {
  return ethers.keccak256(
    ethers.solidityPacked(['bytes32', 'bytes32'], [left, right])
  );
}

function buildEventLeaf({
  channelName,
  chaincodeId,
  eventName,
  txId,
  blockNumber,
  requestID,
  payloadHash
}) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['string', 'string', 'string', 'string', 'uint64', 'bytes32', 'bytes32'],
      [
        channelName,
        chaincodeId,
        eventName,
        txId,
        Number(blockNumber),
        requestID,
        payloadHash
      ]
    )
  );
}

function buildMerkleTree(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) {
    throw new Error('Merkle tree requires at least one leaf');
  }

  const normalizedLeaves = leaves.map((leaf) => ethers.hexlify(leaf));
  const layers = [normalizedLeaves];

  while (layers[layers.length - 1].length > 1) {
    const current = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i];
      const right = current[i + 1] || current[i];
      next.push(hashPair(left, right));
    }
    layers.push(next);
  }

  return layers;
}

function buildMerkleProof(leaves, targetIndex) {
  const layers = buildMerkleTree(leaves);
  let index = targetIndex;
  const siblings = [];

  for (let depth = 0; depth < layers.length - 1; depth += 1) {
    const layer = layers[depth];
    const isRightNode = index % 2 === 1;
    const siblingIndex = isRightNode ? index - 1 : index + 1;
    const sibling = layer[siblingIndex] || layer[index];
    siblings.push({
      position: isRightNode ? 'left' : 'right',
      hash: sibling
    });
    index = Math.floor(index / 2);
  }

  return {
    root: layers[layers.length - 1][0],
    siblings
  };
}

function verifyMerkleProof(leaf, proof, expectedRoot) {
  let computed = ethers.hexlify(leaf);
  for (const sibling of proof || []) {
    computed = sibling.position === 'left'
      ? hashPair(sibling.hash, computed)
      : hashPair(computed, sibling.hash);
  }
  return computed === expectedRoot;
}

module.exports = {
  buildEventLeaf,
  buildMerkleProof,
  verifyMerkleProof
};
