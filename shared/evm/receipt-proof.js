const { ethers } = require('ethers');
const { Trie } = require('@ethereumjs/trie');
const { RLP } = require('@ethereumjs/rlp');
const { bytesToHex, hexToBytes } = require('@ethereumjs/util');

function bytes(value) {
  if (!value || value === '0x') return new Uint8Array([]);
  if (value instanceof Uint8Array) return value;
  return hexToBytes(ethers.hexlify(value));
}

function quantityBytes(value) {
  return bytes(ethers.toBeHex(BigInt(value || 0)));
}

function encodeLog(log) {
  return [
    bytes(log.address),
    (log.topics || []).map((topic) => bytes(topic)),
    bytes(log.data || '0x'),
  ];
}

function encodeReceiptForTrie(receipt) {
  const status = receipt.status !== undefined && receipt.status !== null
    ? quantityBytes(receipt.status ? 1 : 0)
    : bytes(receipt.root);
  const payload = RLP.encode([
    status,
    quantityBytes(receipt.cumulativeGasUsed),
    bytes(receipt.logsBloom),
    (receipt.logs || []).map(encodeLog),
  ]);
  const type = receipt.type !== undefined && receipt.type !== null
    ? Number(receipt.type)
    : 0;
  if (type > 0) {
    return ethers.concat([ethers.toBeHex(type), bytesToHex(payload)]);
  }
  return bytesToHex(payload);
}

function receiptTrieKey(transactionIndex) {
  return RLP.encode(Number(transactionIndex));
}

async function buildReceiptTrie(receipts) {
  const trie = new Trie();
  for (const receipt of receipts) {
    await trie.put(
      receiptTrieKey(receipt.transactionIndex ?? receipt.index),
      bytes(encodeReceiptForTrie(receipt))
    );
  }
  return trie;
}

async function buildReceiptProof({ provider, blockNumber, txHash }) {
  const block = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), false]);
  if (!block) throw new Error(`EVM block not found: ${blockNumber}`);
  const txHashes = block.transactions || [];
  if (!txHashes.length) throw new Error(`EVM block ${blockNumber} has no transactions`);

  const receipts = [];
  for (const hash of txHashes) {
    const receipt = await provider.send('eth_getTransactionReceipt', [hash]);
    if (!receipt) throw new Error(`EVM receipt not found while building proof: ${hash}`);
    receipts.push(receipt);
  }
  const target = receipts.find((receipt) => String(receipt.transactionHash).toLowerCase() === String(txHash).toLowerCase());
  if (!target) throw new Error(`target receipt ${txHash} not found in block ${blockNumber}`);

  const trie = await buildReceiptTrie(receipts);
  const computedRoot = bytesToHex(trie.root());
  if (String(computedRoot).toLowerCase() !== String(block.receiptsRoot).toLowerCase()) {
    throw new Error(`computed receiptsRoot mismatch: block=${block.receiptsRoot}, computed=${computedRoot}`);
  }
  const proof = await trie.createProof(receiptTrieKey(target.transactionIndex));
  return {
    blockHeader: {
      number: Number(BigInt(block.number)),
      hash: block.hash,
      parentHash: block.parentHash,
      stateRoot: block.stateRoot,
      transactionsRoot: block.transactionsRoot,
      receiptsRoot: block.receiptsRoot,
      logsBloom: block.logsBloom,
      timestamp: Number(BigInt(block.timestamp)),
    },
    receipt: target,
    receiptProof: proof.map((node) => bytesToHex(node)),
    receiptTrieKey: bytesToHex(receiptTrieKey(target.transactionIndex)),
    receiptValue: encodeReceiptForTrie(target),
    receiptsRoot: block.receiptsRoot,
  };
}

async function verifyReceiptProof({ receiptsRoot, transactionIndex, proof, expectedReceipt }) {
  const root = bytes(receiptsRoot);
  const key = receiptTrieKey(transactionIndex);
  const proofNodes = (proof || []).map((node) => bytes(node));
  const trie = new Trie();
  const value = await trie.verifyProof(root, key, proofNodes);
  if (!value) throw new Error('EVM receipt MPT proof returned empty value');
  const encoded = encodeReceiptForTrie(expectedReceipt);
  if (bytesToHex(value).toLowerCase() !== encoded.toLowerCase()) {
    throw new Error('EVM receipt MPT proof value mismatch');
  }
  return true;
}

module.exports = {
  encodeReceiptForTrie,
  buildReceiptProof,
  verifyReceiptProof,
};
