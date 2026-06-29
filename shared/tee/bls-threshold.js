const { ethers } = require('ethers');

let blsPromise = null;

function strip0x(value) {
  return String(value || '').startsWith('0x') ? String(value).slice(2) : String(value || '');
}

function bytesToHex(bytes) {
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

function hexToBytes(hex) {
  return Uint8Array.from(Buffer.from(strip0x(hex), 'hex'));
}

async function getBLS() {
  if (!blsPromise) {
    blsPromise = import('@chainsafe/bls/herumi').then(async (mod) => {
      const bls = mod.default || mod;
      if (typeof bls.init === 'function') await bls.init();
      return bls;
    });
  }
  return blsPromise;
}

async function blsKeypairFromPrivateKey(privateKey, nodeID = '') {
  const bls = await getBLS();
  let secretKey = null;
  for (let attempt = 0; attempt < 256; attempt += 1) {
    try {
      const seed = hexToBytes(ethers.keccak256(ethers.toUtf8Bytes(`hxmsg-bls:${nodeID}:${privateKey}:${attempt}`)));
      secretKey = bls.SecretKey.fromBytes(seed);
      break;
    } catch (_error) {
      // Try the next deterministic candidate until it falls inside the BLS scalar field.
    }
  }
  if (!secretKey) throw new Error('failed to derive deterministic BLS secret key');
  const publicKey = secretKey.toPublicKey().toBytes();
  return {
    secretKey,
    secretKeyBytes: bytesToHex(secretKey.toBytes()),
    publicKey: bytesToHex(publicKey),
    publicKeyHash: ethers.keccak256(publicKey),
  };
}

async function signShare({ privateKey, nodeID, digest }) {
  const { secretKey, publicKey, publicKeyHash } = await blsKeypairFromPrivateKey(privateKey, nodeID);
  const signature = secretKey.sign(hexToBytes(digest)).toBytes();
  return {
    digest,
    signature: bytesToHex(signature),
    blsPublicKey: publicKey,
    blsPublicKeyHash: publicKeyHash,
  };
}

function participantBit(signerIndex) {
  const index = BigInt(Number(signerIndex));
  if (index < 0n || index >= 256n) throw new Error(`signerIndex out of bitmap range: ${signerIndex}`);
  return 1n << index;
}

function signerBitmap(participants) {
  return participants.reduce((acc, item) => acc | participantBit(item.signerIndex), 0n);
}

function selectedPublicKeyHash(participants) {
  const sorted = [...participants].sort((a, b) => Number(a.signerIndex) - Number(b.signerIndex));
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint16[]', 'bytes32[]'],
      [
        sorted.map((item) => Number(item.signerIndex)),
        sorted.map((item) => item.blsPublicKeyHash),
      ]
    )
  );
}

async function aggregateShares({ shares, clusterID, epoch, threshold, signingDigest, signatureDigestType, term, index }) {
  if (!Array.isArray(shares) || shares.length === 0) throw new Error('BLS shares are required');
  const bls = await getBLS();
  const participants = shares.map((share) => ({
    nodeID: share.nodeID,
    teeAddress: ethers.getAddress(share.teeAddress),
    signerIndex: Number(share.signerIndex),
    blsPublicKey: share.blsPublicKey,
    blsPublicKeyHash: share.blsPublicKeyHash || ethers.keccak256(hexToBytes(share.blsPublicKey)),
  }));
  const signature = bls.aggregateSignatures(shares.map((share) => hexToBytes(share.signature)));
  const aggregateSignature = bytesToHex(signature);
  const aggregatePublicKey = bls.aggregatePublicKeys(participants.map((item) => hexToBytes(item.blsPublicKey)));
  return {
    scheme: 'BLS_THRESHOLD_V1',
    clusterID,
    epoch: Number(epoch || 1),
    threshold: Number(threshold),
    participantCount: participants.length,
    signerBitmap: signerBitmap(participants).toString(),
    selectedPublicKeyHash: selectedPublicKeyHash(participants),
    aggregatePublicKey: bytesToHex(aggregatePublicKey),
    aggregatePublicKeyHash: ethers.keccak256(aggregatePublicKey),
    aggregateSignature,
    signingDigest,
    signatureDigestType,
    committedTerm: Number(term || 0),
    committedIndex: Number(index || 0),
    participants,
  };
}

async function verifyAggregateCertificate(certificate, { publicKeysByIndex, expectedDigest, expectedThreshold } = {}) {
  if (!certificate || certificate.scheme !== 'BLS_THRESHOLD_V1') return false;
  if (expectedDigest && String(certificate.signingDigest).toLowerCase() !== String(expectedDigest).toLowerCase()) return false;
  if (expectedThreshold && Number(certificate.participantCount || 0) < Number(expectedThreshold)) return false;
  const bls = await getBLS();
  const participants = certificate.participants || [];
  if (participants.length !== Number(certificate.participantCount)) return false;
  const publicKeys = participants.map((participant) => {
    const registered = publicKeysByIndex?.get?.(Number(participant.signerIndex));
    return registered || participant.blsPublicKey;
  });
  if (selectedPublicKeyHash(participants).toLowerCase() !== String(certificate.selectedPublicKeyHash).toLowerCase()) return false;
  return bls.verifyAggregate(
    publicKeys.map(hexToBytes),
    hexToBytes(certificate.signingDigest),
    hexToBytes(certificate.aggregateSignature)
  );
}

module.exports = {
  getBLS,
  blsKeypairFromPrivateKey,
  signShare,
  aggregateShares,
  verifyAggregateCertificate,
  signerBitmap,
  selectedPublicKeyHash,
  hexToBytes,
  bytesToHex,
};
