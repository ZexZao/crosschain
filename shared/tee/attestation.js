const { ethers } = require('ethers');
const { blsKeypairFromPrivateKey } = require('./bls-threshold');

const SIMULATED_ATTESTATION_TYPE = 'SIMULATED_TDX_QUOTE_V1';
const DEFAULT_ENCLAVE_MEASUREMENT = ethers.keccak256(
  ethers.toUtf8Bytes('hxmsg-tee-verifier-simulated-enclave-measurement-v1')
);

function normalizeIdentity(identity) {
  if (!identity) throw new Error('TEE identity is required');
  return {
    teeAddress: ethers.getAddress(identity.teeAddress || identity.address),
    enclavePubKey: identity.enclavePubKey || identity.publicKey || '0x',
    enclavePubKeyHash: identity.enclavePubKeyHash || ethers.keccak256(identity.enclavePubKey || '0x'),
    blsPublicKey: identity.blsPublicKey || '0x',
    blsPublicKeyHash: identity.blsPublicKeyHash || ethers.keccak256(identity.blsPublicKey || '0x'),
    signerIndex: Number(identity.signerIndex || 0),
    measurement: identity.measurement || DEFAULT_ENCLAVE_MEASUREMENT,
    quoteHash: identity.quoteHash,
    initialSyncStateHash: identity.initialSyncStateHash || ethers.ZeroHash,
    epoch: Number(identity.epoch || 1),
    notAfter: Number(identity.notAfter || 0),
    attestationType: identity.attestationType || SIMULATED_ATTESTATION_TYPE,
    attestationSignature: identity.attestationSignature || '0x',
    nodeID: identity.nodeID || '',
  };
}

function simulatedQuoteHash(identity) {
  const normalized = normalizeIdentity({
    ...identity,
    quoteHash: identity?.quoteHash || ethers.ZeroHash,
    attestationSignature: identity?.attestationSignature || '0x',
  });
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['string', 'address', 'uint16', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint64', 'uint64'],
      [
        SIMULATED_ATTESTATION_TYPE,
        normalized.teeAddress,
        normalized.signerIndex,
        normalized.enclavePubKeyHash,
        normalized.blsPublicKeyHash,
        normalized.measurement,
        normalized.initialSyncStateHash,
        normalized.epoch,
        normalized.notAfter,
      ]
    )
  );
}

function attestationRegistrationDigest(identity) {
  const normalized = normalizeIdentity(identity);
  const quoteHash = normalized.quoteHash || simulatedQuoteHash(normalized);
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['string', 'address', 'uint16', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint64', 'uint64'],
      [
        normalized.attestationType,
        normalized.teeAddress,
        normalized.signerIndex,
        normalized.enclavePubKeyHash,
        normalized.blsPublicKeyHash,
        normalized.measurement,
        quoteHash,
        normalized.initialSyncStateHash,
        normalized.epoch,
        normalized.notAfter,
      ]
    )
  );
}

function buildSimulatedAttestationIdentity({
  privateKey,
  nodeID,
  chainState,
  epoch = Number(process.env.TEE_ATTESTATION_EPOCH || 1),
  notAfter = Number(process.env.TEE_ATTESTATION_NOT_AFTER || 0),
  measurement = process.env.TEE_ENCLAVE_MEASUREMENT || DEFAULT_ENCLAVE_MEASUREMENT,
} = {}) {
  if (!privateKey) throw new Error('privateKey is required');
  const wallet = new ethers.Wallet(privateKey);
  const enclavePubKey = wallet.signingKey.publicKey;
  const initialSyncStateHash = chainState
    ? ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(chainState)))
    : ethers.ZeroHash;
  const base = {
    nodeID: nodeID || '',
    teeAddress: wallet.address,
    enclavePubKey,
    enclavePubKeyHash: ethers.keccak256(enclavePubKey),
    measurement,
    initialSyncStateHash,
    epoch,
    notAfter,
    attestationType: SIMULATED_ATTESTATION_TYPE,
  };
  const quoteHash = simulatedQuoteHash(base);
  const digest = attestationRegistrationDigest({ ...base, quoteHash });
  return {
    ...base,
    quoteHash,
    attestationDigest: digest,
    attestationSignature: wallet.signingKey.sign(digest).serialized,
  };
}

async function buildSimulatedAttestationIdentityWithBLS(options = {}) {
  const base = buildSimulatedAttestationIdentity(options);
  const bls = await blsKeypairFromPrivateKey(options.privateKey, options.nodeID || '');
  const signerIndex = options.signerIndex !== undefined
    ? Number(options.signerIndex)
    : Number(process.env.TEE_SIGNER_INDEX !== undefined
      ? process.env.TEE_SIGNER_INDEX
      : (String(options.nodeID || '').match(/(\d+)$/)?.[1] || 1)) - 1;
  const identity = {
    ...base,
    signerIndex,
    blsPublicKey: bls.publicKey,
    blsPublicKeyHash: bls.publicKeyHash,
  };
  const quoteHash = simulatedQuoteHash(identity);
  const digest = attestationRegistrationDigest({ ...identity, quoteHash });
  const wallet = new ethers.Wallet(options.privateKey);
  return {
    ...identity,
    quoteHash,
    attestationDigest: digest,
    attestationSignature: wallet.signingKey.sign(digest).serialized,
  };
}

function evmRegistrationTuple(identity) {
  const normalized = normalizeIdentity(identity);
  return [
    normalized.teeAddress,
    normalized.signerIndex,
    normalized.enclavePubKeyHash,
    normalized.blsPublicKeyHash,
    normalized.measurement,
    normalized.quoteHash || simulatedQuoteHash(normalized),
    normalized.initialSyncStateHash,
    normalized.epoch,
    normalized.notAfter,
    normalized.attestationSignature,
  ];
}

module.exports = {
  SIMULATED_ATTESTATION_TYPE,
  DEFAULT_ENCLAVE_MEASUREMENT,
  normalizeIdentity,
  simulatedQuoteHash,
  attestationRegistrationDigest,
  buildSimulatedAttestationIdentity,
  buildSimulatedAttestationIdentityWithBLS,
  evmRegistrationTuple,
};
