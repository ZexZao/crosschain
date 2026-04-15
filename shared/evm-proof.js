const { ethers } = require('ethers');
const {
  computeConsensusMessage,
  computeValidatorSetHash,
  normalizeAddresses,
  recoverConsensusSigner
} = require('./consensus-proof');
const { getTrustedValidatorSet } = require('../consensus-aggregator/validator-set');
const { buildMerkleProof, verifyMerkleProof } = require('../proof-builder/merkle');

function parseJsonField(value, fieldName) {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a JSON string`);
  }
  return JSON.parse(value);
}

function buildEvmEventLeaf({
  networkName,
  emitterAddress,
  eventName,
  txHash,
  logIndex,
  requestID,
  payloadHash
}) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['string', 'address', 'string', 'bytes32', 'uint64', 'bytes32', 'bytes32'],
      [
        networkName,
        ethers.getAddress(emitterAddress),
        eventName,
        txHash,
        Number(logIndex),
        requestID,
        payloadHash
      ]
    )
  );
}

function buildEvmEventProof({
  networkName,
  emitterAddress,
  eventName,
  txHash,
  blockNumber,
  blockHash,
  logIndex,
  requestID,
  payloadHash,
  consensusProof = null
}) {
  const eventLeaf = buildEvmEventLeaf({
    networkName,
    emitterAddress,
    eventName,
    txHash,
    logIndex,
    requestID,
    payloadHash
  });
  const merkleProof = buildMerkleProof([eventLeaf], 0);
  return {
    proofType: consensusProof ? 'evm-v2' : 'evm-v1',
    networkName,
    emitterAddress: ethers.getAddress(emitterAddress),
    eventName,
    txHash,
    blockNumber: Number(blockNumber),
    blockHash,
    logIndex: Number(logIndex),
    requestID,
    payloadHash,
    eventLeaf,
    eventRoot: merkleProof.root,
    eventMerkleProof: merkleProof.siblings,
    consensusProof
  };
}

function buildEvmFinalityInfo({
  networkName,
  blockNumber,
  blockHash,
  confirmations = 1,
  consensusProof = null
}) {
  return {
    proofType: 'evm-finality-v2',
    networkName,
    srcHeight: Number(blockNumber),
    blockHash,
    confirmations: Number(confirmations),
    commitStatus: 'CONFIRMED',
    validatorSetId: consensusProof?.validatorSetId || null,
    validatorSetHash: consensusProof?.validatorSetHash || null,
    threshold: consensusProof?.threshold || null
  };
}

function verifyConsensusProof(proof, xmsg) {
  const cp = proof.consensusProof;
  if (!cp) {
    throw new Error('evm proof missing consensusProof');
  }
  const trustedSet = getTrustedValidatorSet(proof.networkName);
  if (cp.validatorSetId !== trustedSet.validatorSetId) {
    throw new Error('evm consensus validatorSetId mismatch');
  }

  const trustedAddresses = normalizeAddresses(trustedSet.validators.map((validator) => validator.address));
  const providedAddresses = normalizeAddresses(cp.validatorAddresses || []);
  if (JSON.stringify(trustedAddresses) !== JSON.stringify(providedAddresses)) {
    throw new Error('evm consensus validator address mismatch');
  }

  const expectedValidatorSetHash = computeValidatorSetHash(
    trustedSet.validatorSetId,
    trustedSet.threshold,
    trustedAddresses
  );
  if (cp.validatorSetHash !== expectedValidatorSetHash) {
    throw new Error('evm consensus validatorSetHash mismatch');
  }
  if (Number(cp.threshold) !== Number(trustedSet.threshold)) {
    throw new Error('evm consensus threshold mismatch');
  }

  const recomputedSignedMessage = computeConsensusMessage({
    channelName: proof.networkName,
    blockNumber: proof.blockNumber,
    blockHash: proof.blockHash,
    eventRoot: proof.eventRoot,
    requestID: xmsg.requestID,
    payloadHash: xmsg.payloadHash,
    validatorSetHash: cp.validatorSetHash
  });
  if (cp.signedMessage !== recomputedSignedMessage) {
    throw new Error('evm consensus signedMessage mismatch');
  }

  const signers = new Set();
  for (const item of cp.signatures || []) {
    const recovered = ethers.getAddress(recoverConsensusSigner(cp.signedMessage, item.signature));
    if (recovered !== ethers.getAddress(item.signer)) {
      throw new Error('evm consensus signature signer mismatch');
    }
    if (!trustedAddresses.includes(recovered)) {
      throw new Error('evm consensus signer not trusted');
    }
    signers.add(recovered);
  }
  if (signers.size < trustedSet.threshold) {
    throw new Error('evm consensus threshold not satisfied');
  }
}

function verifyEvmEventProof(xmsg) {
  const proof = parseJsonField(xmsg.eventProof, 'eventProof');
  if (!['evm-v1', 'evm-v2'].includes(proof.proofType)) {
    throw new Error(`unsupported evm eventProof type: ${proof.proofType || 'unknown'}`);
  }
  if (proof.requestID !== xmsg.requestID) {
    throw new Error('evm proof requestID mismatch');
  }
  if (proof.payloadHash !== xmsg.payloadHash) {
    throw new Error('evm proof payloadHash mismatch');
  }
  if (Number(proof.blockNumber) !== Number(xmsg.srcHeight)) {
    throw new Error('evm proof block height mismatch');
  }
  if (!ethers.isHexString(proof.blockHash, 32) || !ethers.isHexString(proof.txHash, 32)) {
    throw new Error('evm proof hash malformed');
  }
  const recomputedLeaf = buildEvmEventLeaf({
    networkName: proof.networkName,
    emitterAddress: proof.emitterAddress,
    eventName: proof.eventName,
    txHash: proof.txHash,
    logIndex: proof.logIndex,
    requestID: xmsg.requestID,
    payloadHash: xmsg.payloadHash
  });
  if (proof.eventLeaf !== recomputedLeaf) {
    throw new Error('evm proof eventLeaf mismatch');
  }
  if (!verifyMerkleProof(proof.eventLeaf, proof.eventMerkleProof, proof.eventRoot)) {
    throw new Error('evm proof eventMerkleProof invalid');
  }
  if (proof.proofType === 'evm-v2') {
    verifyConsensusProof(proof, xmsg);
  }
  return proof;
}

function verifyEvmFinalityInfo(xmsg) {
  const fin = parseJsonField(xmsg.finalityInfo, 'finalityInfo');
  if (!['evm-finality-v1', 'evm-finality-v2'].includes(fin.proofType)) {
    throw new Error(`unsupported evm finalityInfo type: ${fin.proofType || 'unknown'}`);
  }
  if (Number(fin.srcHeight) !== Number(xmsg.srcHeight)) {
    throw new Error('evm finality height mismatch');
  }
  if (fin.commitStatus !== 'CONFIRMED') {
    throw new Error(`evm finality invalid status: ${fin.commitStatus}`);
  }
  if (!ethers.isHexString(fin.blockHash, 32)) {
    throw new Error('evm finality blockHash malformed');
  }
  return fin;
}

module.exports = {
  buildEvmEventLeaf,
  buildEvmEventProof,
  buildEvmFinalityInfo,
  verifyEvmEventProof,
  verifyEvmFinalityInfo
};
