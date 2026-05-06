const { bls12_381 } = require('@noble/curves/bls12-381.js');
const { ethers } = require('ethers');

// Use shortSignatures: G1 signatures (48 bytes), G2 public keys (96 bytes)
// Signatures are smaller, which is better for on-chain submission.
const bls = bls12_381.shortSignatures;
const G2 = bls12_381.G2;

// Domain separation tag for cross-chain consensus messages
const BLS_DST = 'CROSSCHAIN_CONSENSUS_BLS12_381_G1_XMD:SHA-256_SSWU_RO_NUL_';

function toBytes(hex) {
  return ethers.getBytes(hex);
}

function toHex(bytes) {
  // bytes may be Uint8Array or noble Point/Signature with .toHex()
  let hex;
  if (bytes && typeof bytes.toHex === 'function') {
    hex = bytes.toHex();
  } else {
    hex = ethers.hexlify(bytes).slice(2);
  }
  // Ensure 0x prefix for ethers compatibility
  return hex.startsWith('0x') ? hex : '0x' + hex;
}

/**
 * Derive a deterministic BLS private key (32 bytes hex) from a seed label.
 */
function deriveBlsPrivateKey(seedLabel) {
  return ethers.keccak256(
    ethers.toUtf8Bytes(`crosschain-validator:${seedLabel}`)
  );
}

/**
 * Get BLS public key from seed label.
 * Returns 96-byte (G2) compressed public key as hex string.
 */
function getBlsPublicKey(seedLabel) {
  const privKey = deriveBlsPrivateKey(seedLabel);
  return toHex(bls.getPublicKey(toBytes(privKey)));
}

/**
 * Get BLS public key from raw private key hex.
 */
function getBlsPublicKeyFromPriv(privKeyHex) {
  return toHex(bls.getPublicKey(toBytes(privKeyHex)));
}

/**
 * Hash an arbitrary message (Uint8Array) to a point on G2.
 * This is the standard BLS hash-to-curve step.
 */
function blsHashToCurve(msgBytes) {
  return bls.hash(msgBytes, BLS_DST);
}

/**
 * Sign a pre-hashed curve point with BLS private key.
 * Returns 48-byte (G1) compressed signature as hex string.
 */
function blsSignPoint(msgPoint, privKeyHex) {
  return toHex(bls.sign(msgPoint, toBytes(privKeyHex)));
}

/**
 * Sign a raw message (bytes) with BLS.
 * Hashes the message to G2 first, then signs.
 * Returns 48-byte compressed signature as hex string.
 */
function blsSignMessage(msgBytes, privKeyHex) {
  const msgPoint = blsHashToCurve(msgBytes);
  return blsSignPoint(msgPoint, privKeyHex);
}

function strip0x(hex) {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

/**
 * Verify a single BLS signature.
 */
function blsVerifySingle(signatureHex, msgPoint, publicKeyHex) {
  return bls.verify(
    bls.Signature.fromHex(strip0x(signatureHex)),
    msgPoint,
    G2.Point.fromHex(strip0x(publicKeyHex))
  );
}

/**
 * Aggregate multiple BLS signatures (same message) into one.
 * Returns 48-byte aggregated signature as hex.
 */
function blsAggregateSignatures(signatures) {
  if (!Array.isArray(signatures) || signatures.length === 0) {
    throw new Error('signatures must be a non-empty array');
  }
  const sigObjs = signatures.map((s) => bls.Signature.fromHex(strip0x(s)));
  return toHex(bls.aggregateSignatures(sigObjs));
}

/**
 * Verify an aggregated BLS signature against multiple (message, publicKey) pairs.
 * Uses verifyBatch which takes arrays of messages and public keys.
 * This is a single pairing check regardless of N.
 */
function blsVerifyAggregate(aggregateSigHex, msgPoint, publicKeysHex) {
  const aggSig = bls.Signature.fromHex(strip0x(aggregateSigHex));
  const items = publicKeysHex.map((pk) => ({
    message: msgPoint,
    publicKey: G2.Point.fromHex(strip0x(pk)),
  }));
  return bls.verifyBatch(aggSig, items);
}

/**
 * Build a BLS validator identity from seed label.
 */
function buildBlsValidator(label) {
  const privateKey = deriveBlsPrivateKey(label);
  const publicKey = getBlsPublicKeyFromPriv(privateKey);
  return { privateKey, publicKey };
}

/**
 * Normalize BLS public keys for comparison (lexicographic sort).
 */
function normalizeBlsPubkeys(pubkeys) {
  return [...pubkeys].map((pk) => ethers.hexlify(pk)).sort();
}

module.exports = {
  deriveBlsPrivateKey,
  getBlsPublicKey,
  getBlsPublicKeyFromPriv,
  blsHashToCurve,
  blsSignPoint,
  blsSignMessage,
  blsVerifySingle,
  blsAggregateSignatures,
  blsVerifyAggregate,
  buildBlsValidator,
  normalizeBlsPubkeys,
  BLS_DST,
};
