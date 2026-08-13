const { ethers } = require('ethers');

const CERT_SCHEME = 'ECDSA_QUORUM_V1';
const ABI = ethers.AbiCoder.defaultAbiCoder();

function participantBit(signerIndex) {
  const index = BigInt(Number(signerIndex));
  if (index < 0n || index >= 256n) throw new Error(`signerIndex out of bitmap range: ${signerIndex}`);
  return 1n << index;
}

function signerBitmap(participants) {
  return participants.reduce((acc, item) => acc | participantBit(item.signerIndex), 0n);
}

function selectedSignerHash(participants) {
  const sorted = [...participants].sort((a, b) => Number(a.signerIndex) - Number(b.signerIndex));
  return ethers.keccak256(
    ABI.encode(
      ['uint16[]', 'address[]', 'bytes32[]'],
      [
        sorted.map((item) => Number(item.signerIndex)),
        sorted.map((item) => ethers.getAddress(item.teeAddress)),
        sorted.map((item) => item.enclavePubKeyHash),
      ]
    )
  );
}

function encodeSignatures(signatures) {
  return ABI.encode(['bytes[]'], [signatures]);
}

function signCommittedDigest({ privateKey, nodeID, identity, committedEntry }) {
  const wallet = new ethers.Wallet(privateKey);
  const signingDigest = committedEntry.signingDigest || committedEntry.hmsgDigest;
  return {
    nodeID,
    teeAddress: wallet.address,
    signerIndex: Number(identity.signerIndex),
    enclavePubKeyHash: identity.enclavePubKeyHash,
    requestID: committedEntry.requestID,
    hmsgDigest: committedEntry.hmsgDigest,
    signingDigest,
    signatureDigestType: committedEntry.signatureDigestType || 'hmsgDigest',
    signature: wallet.signingKey.sign(signingDigest).serialized,
    committedTerm: committedEntry.term,
    committedIndex: committedEntry.index,
  };
}

function buildQuorumCertificate({
  signatures,
  clusterID,
  epoch,
  threshold,
  signingDigest,
  subjectDigest,
  sourceChainType,
  sourceChainID,
  signatureDigestType,
  term,
  index,
  allowBelowThreshold = false,
}) {
  if (!Array.isArray(signatures) || signatures.length === 0) throw new Error('TEE signatures are required');
  const unique = new Map();
  for (const item of signatures) {
    if (!item || String(item.signingDigest).toLowerCase() !== String(signingDigest).toLowerCase()) continue;
    unique.set(Number(item.signerIndex), item);
  }
  const selected = Array.from(unique.values())
    .sort((a, b) => Number(a.signerIndex) - Number(b.signerIndex))
    .slice(0, Number(threshold));
  if (!allowBelowThreshold && selected.length < Number(threshold)) {
    throw new Error(`TEE signatures below threshold: ${selected.length}/${threshold}`);
  }
  const participants = selected.map((item) => ({
    nodeID: item.nodeID,
    teeAddress: ethers.getAddress(item.teeAddress),
    signerIndex: Number(item.signerIndex),
    enclavePubKeyHash: item.enclavePubKeyHash,
  }));
  return {
    scheme: CERT_SCHEME,
    clusterID,
    sourceChainType: Number(sourceChainType),
    sourceChainID,
    epoch: Number(epoch),
    threshold: Number(threshold),
    participantCount: participants.length,
    signerBitmap: signerBitmap(participants).toString(),
    selectedSignerHash: selectedSignerHash(participants),
    signatures: selected.map((item) => item.signature),
    signatureBundle: encodeSignatures(selected.map((item) => item.signature)),
    signingDigest,
    subjectDigest,
    signatureDigestType,
    committedTerm: Number(term || 0),
    committedIndex: Number(index || 0),
    participants,
  };
}

module.exports = {
  CERT_SCHEME,
  selectedSignerHash,
  encodeSignatures,
  signCommittedDigest,
  buildQuorumCertificate,
  signerBitmap,
};
