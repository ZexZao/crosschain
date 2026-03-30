const { ethers } = require('ethers');
const {
  computeConsensusMessage,
  computeValidatorSetHash,
  normalizeAddresses,
  recoverConsensusSigner
} = require('./consensus-proof');
const { getTrustedValidatorSet } = require('../consensus-aggregator/validator-set');
const { buildEventLeaf, buildMerkleProof, verifyMerkleProof } = require('../proof-builder/merkle');

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseJsonField(value, fieldName) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a JSON string`);
  }
  return JSON.parse(value);
}

function sha256HexFromUtf8(value) {
  return ethers.sha256(ethers.toUtf8Bytes(value));
}

function sha256HexFromBase64(value) {
  return ethers.sha256(`0x${Buffer.from(value, 'base64').toString('hex')}`);
}

function computeFabricBlockHash(blockHeader) {
  return sha256HexFromUtf8(stableStringify(blockHeader));
}

function buildFabricEventProof({
  channelName,
  chaincodeId,
  eventName,
  txId,
  blockNumber,
  requestID,
  payloadHash,
  txValidationCode,
  txEnvelopeBase64,
  blockHeader,
  creatorMspId,
  creatorIdBase64,
  endorsements = [],
  rwsetHash,
  timestamp,
  namespace = 'fabric-real',
  consensusProof = null
}) {
  const blockHash = computeFabricBlockHash(blockHeader);
  const txEnvelopeHash = txEnvelopeBase64 ? sha256HexFromBase64(txEnvelopeBase64) : ethers.ZeroHash;
  const creatorHash = creatorIdBase64 ? sha256HexFromBase64(creatorIdBase64) : ethers.ZeroHash;
  const eventLeaf = buildEventLeaf({
    channelName,
    chaincodeId,
    eventName,
    txId,
    blockNumber,
    requestID,
    payloadHash
  });
  const merkleProof = buildMerkleProof([eventLeaf], 0);
  return {
    proofType: consensusProof ? 'fabric-v2' : 'fabric-v1',
    namespace,
    channelName,
    chaincodeId,
    eventName,
    txId,
    blockNumber: Number(blockNumber),
    blockHash,
    requestID,
    payloadHash,
    txValidationCode: txValidationCode || 'VALID',
    txEnvelopeHash,
    blockHeader,
    creatorMspId: creatorMspId || '',
    creatorHash,
    endorsements,
    rwsetHash: rwsetHash || ethers.ZeroHash,
    timestamp: timestamp || new Date().toISOString(),
    eventLeaf,
    eventRoot: merkleProof.root,
    eventMerkleProof: merkleProof.siblings,
    consensusProof
  };
}

function buildFabricFinalityInfo({
  channelName,
  blockNumber,
  blockHeader,
  ordererMspId,
  metadataBase64,
  commitStatus,
  confirmations,
  consensusProof = null
}) {
  return {
    proofType: 'fabric-finality-v2',
    mode: 'permissioned-threshold-commit',
    channelName,
    srcHeight: Number(blockNumber),
    blockHash: computeFabricBlockHash(blockHeader),
    ordererMspId: ordererMspId || 'OrdererMSP',
    metadataHash: metadataBase64 ? sha256HexFromBase64(metadataBase64) : ethers.ZeroHash,
    commitStatus: commitStatus || 'VALID',
    confirmations: confirmations ?? 1,
    validatorSetId: consensusProof?.validatorSetId || null,
    validatorSetHash: consensusProof?.validatorSetHash || null,
    threshold: consensusProof?.threshold || null
  };
}

function verifyConsensusProof(proof, xmsg) {
  if (!proof.consensusProof) {
    throw new Error('fabric proof missing consensusProof');
  }

  const cp = proof.consensusProof;
  const trustedSet = getTrustedValidatorSet(proof.channelName);
  if (cp.validatorSetId !== trustedSet.validatorSetId) {
    throw new Error('fabric consensus validatorSetId mismatch');
  }

  const trustedAddresses = normalizeAddresses(
    trustedSet.validators.map((wallet) => wallet.address)
  );
  const providedAddresses = normalizeAddresses(cp.validatorAddresses || []);
  if (JSON.stringify(trustedAddresses) !== JSON.stringify(providedAddresses)) {
    throw new Error('fabric consensus validator address mismatch');
  }

  const expectedValidatorSetHash = computeValidatorSetHash(
    trustedSet.validatorSetId,
    trustedSet.threshold,
    trustedAddresses
  );
  if (cp.validatorSetHash !== expectedValidatorSetHash) {
    throw new Error('fabric consensus validatorSetHash mismatch');
  }

  if (Number(cp.threshold) !== Number(trustedSet.threshold)) {
    throw new Error('fabric consensus threshold mismatch');
  }

  const recomputedSignedMessage = computeConsensusMessage({
    channelName: proof.channelName,
    blockNumber: proof.blockNumber,
    blockHash: proof.blockHash,
    eventRoot: proof.eventRoot,
    requestID: xmsg.requestID,
    payloadHash: xmsg.payloadHash,
    validatorSetHash: cp.validatorSetHash
  });

  if (cp.signedMessage !== recomputedSignedMessage) {
    throw new Error('fabric consensus signedMessage mismatch');
  }

  const signers = new Set();
  for (const item of cp.signatures || []) {
    const recovered = ethers.getAddress(recoverConsensusSigner(cp.signedMessage, item.signature));
    if (recovered !== ethers.getAddress(item.signer)) {
      throw new Error('fabric consensus signature signer mismatch');
    }
    if (!trustedAddresses.includes(recovered)) {
      throw new Error('fabric consensus signer not trusted');
    }
    signers.add(recovered);
  }

  if (signers.size < trustedSet.threshold) {
    throw new Error('fabric consensus threshold not satisfied');
  }

  return cp;
}

function verifyFabricEventProof(xmsg) {
  const proof = parseJsonField(xmsg.eventProof, 'eventProof');
  if (!['fabric-v1', 'fabric-v2'].includes(proof.proofType)) {
    throw new Error(`unsupported eventProof type: ${proof.proofType || 'unknown'}`);
  }
  if (proof.requestID !== xmsg.requestID) {
    throw new Error('fabric proof requestID mismatch');
  }
  if (proof.payloadHash !== xmsg.payloadHash) {
    throw new Error('fabric proof payloadHash mismatch');
  }
  if (Number(proof.blockNumber) !== Number(xmsg.srcHeight)) {
    throw new Error('fabric proof block height mismatch');
  }
  if (proof.txValidationCode !== 'VALID') {
    throw new Error(`fabric transaction invalid: ${proof.txValidationCode}`);
  }
  if (!proof.blockHeader) {
    throw new Error('fabric proof missing blockHeader');
  }
  const recomputedBlockHash = computeFabricBlockHash(proof.blockHeader);
  if (proof.blockHash !== recomputedBlockHash) {
    throw new Error('fabric proof blockHash mismatch');
  }
  if (proof.txEnvelopeHash && proof.txEnvelopeHash !== ethers.ZeroHash && !ethers.isHexString(proof.txEnvelopeHash, 32)) {
    throw new Error('fabric proof txEnvelopeHash malformed');
  }
  if (proof.proofType === 'fabric-v2') {
    if (!proof.eventLeaf || !proof.eventRoot) {
      throw new Error('fabric proof missing Merkle event data');
    }
    const recomputedLeaf = buildEventLeaf({
      channelName: proof.channelName,
      chaincodeId: proof.chaincodeId,
      eventName: proof.eventName,
      txId: proof.txId,
      blockNumber: proof.blockNumber,
      requestID: xmsg.requestID,
      payloadHash: xmsg.payloadHash
    });
    if (proof.eventLeaf !== recomputedLeaf) {
      throw new Error('fabric proof eventLeaf mismatch');
    }
    if (!verifyMerkleProof(proof.eventLeaf, proof.eventMerkleProof, proof.eventRoot)) {
      throw new Error('fabric proof eventMerkleProof invalid');
    }
    verifyConsensusProof(proof, xmsg);
  }
  return proof;
}

function verifyFabricFinalityInfo(xmsg) {
  const fin = parseJsonField(xmsg.finalityInfo, 'finalityInfo');
  if (!['fabric-finality-v1', 'fabric-finality-v2'].includes(fin.proofType)) {
    throw new Error(`unsupported finalityInfo type: ${fin.proofType || 'unknown'}`);
  }
  if (Number(fin.srcHeight) !== Number(xmsg.srcHeight)) {
    throw new Error('fabric finality height mismatch');
  }
  if (fin.commitStatus !== 'VALID') {
    throw new Error(`fabric finality commit invalid: ${fin.commitStatus}`);
  }
  if (!ethers.isHexString(fin.blockHash, 32)) {
    throw new Error('fabric finality blockHash malformed');
  }
  return fin;
}

module.exports = {
  stableStringify,
  buildFabricEventProof,
  buildFabricFinalityInfo,
  verifyFabricEventProof,
  verifyFabricFinalityInfo,
  computeFabricBlockHash
};
