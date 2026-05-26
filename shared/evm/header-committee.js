const { ethers } = require('ethers');

const DEFAULT_COMMITTEE_ID = 'evm-header-committee-local-v1';
const DEFAULT_PRIVATE_KEYS = [
  ethers.keccak256(ethers.toUtf8Bytes('local simulated evm header committee member 1')),
  ethers.keccak256(ethers.toUtf8Bytes('local simulated evm header committee member 2')),
  ethers.keccak256(ethers.toUtf8Bytes('local simulated evm header committee member 3')),
];

function normalizeHeader(header) {
  return {
    number: Number(header.number),
    hash: header.hash,
    parentHash: header.parentHash,
    stateRoot: header.stateRoot,
    transactionsRoot: header.transactionsRoot,
    receiptsRoot: header.receiptsRoot,
    logsBloom: header.logsBloom,
    timestamp: Number(header.timestamp || 0),
  };
}

function parseCsv(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function committeePrivateKeys() {
  return parseCsv(process.env.HEADER_COMMITTEE_PRIVATE_KEYS).length
    ? parseCsv(process.env.HEADER_COMMITTEE_PRIVATE_KEYS)
    : DEFAULT_PRIVATE_KEYS;
}

function committeeSigners() {
  const configured = parseCsv(process.env.HEADER_COMMITTEE_SIGNERS);
  if (configured.length) return configured.map((address) => ethers.getAddress(address));
  return committeePrivateKeys().map((key) => new ethers.Wallet(key).address);
}

function committeeThreshold() {
  const configured = Number(process.env.HEADER_COMMITTEE_THRESHOLD || 0);
  if (configured > 0) return configured;
  return Math.floor(committeeSigners().length / 2) + 1;
}

function headerCommitteeDigest({ committeeID, chainID, header, finalizedHeight, finalizedHash }) {
  const normalized = normalizeHeader(header);
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'string',
        'string',
        'uint64',
        'bytes32',
        'bytes32',
        'bytes32',
        'bytes32',
        'bytes32',
        'uint64',
        'uint64',
        'bytes32',
      ],
      [
        committeeID || DEFAULT_COMMITTEE_ID,
        chainID,
        normalized.number,
        normalized.hash,
        normalized.parentHash,
        normalized.stateRoot,
        normalized.transactionsRoot,
        normalized.receiptsRoot,
        normalized.timestamp,
        Number(finalizedHeight || normalized.number),
        finalizedHash || normalized.hash,
      ]
    )
  );
}

function buildCommitteeHeaderUpdate({
  header,
  chainID,
  committeeID = process.env.HEADER_COMMITTEE_ID || DEFAULT_COMMITTEE_ID,
  threshold = committeeThreshold(),
  finalizedHeight,
  finalizedHash,
  privateKeys = committeePrivateKeys(),
}) {
  const normalized = normalizeHeader(header);
  const finality = {
    mode: 'SIMULATED_COMMITTEE_FINALIZED',
    finalizedHeight: Number(finalizedHeight || normalized.number),
    finalizedHash: finalizedHash || normalized.hash,
  };
  const digest = headerCommitteeDigest({
    committeeID,
    chainID,
    header: normalized,
    finalizedHeight: finality.finalizedHeight,
    finalizedHash: finality.finalizedHash,
  });
  const signatures = privateKeys.slice(0, threshold).map((privateKey) => {
    const wallet = new ethers.Wallet(privateKey);
    return {
      signer: wallet.address,
      signature: wallet.signingKey.sign(digest).serialized,
    };
  });
  return {
    chainType: 'EVM',
    chainID,
    header: normalized,
    finality,
    committeeProof: {
      committeeID,
      threshold,
      digest,
      signatures,
    },
  };
}

function verifyCommitteeHeaderUpdate(update, { expectedChainID } = {}) {
  if (!update?.header || !update?.committeeProof) {
    throw new Error('committee-certified EVM header update is required');
  }
  if (update.chainType !== 'EVM') throw new Error('committee header update chainType must be EVM');
  if (expectedChainID && update.chainID !== expectedChainID) {
    throw new Error('committee header update chainID mismatch');
  }
  const committeeID = update.committeeProof.committeeID || DEFAULT_COMMITTEE_ID;
  if (committeeID !== (process.env.HEADER_COMMITTEE_ID || DEFAULT_COMMITTEE_ID)) {
    throw new Error('untrusted header committee ID');
  }
  const trusted = new Set(committeeSigners().map((address) => ethers.getAddress(address)));
  const threshold = Number(update.committeeProof.threshold || committeeThreshold());
  if (threshold !== committeeThreshold()) {
    throw new Error('header committee threshold mismatch');
  }
  const finality = update.finality || {};
  const digest = headerCommitteeDigest({
    committeeID,
    chainID: update.chainID,
    header: update.header,
    finalizedHeight: finality.finalizedHeight,
    finalizedHash: finality.finalizedHash,
  });
  if (update.committeeProof.digest && update.committeeProof.digest.toLowerCase() !== digest.toLowerCase()) {
    throw new Error('header committee digest mismatch');
  }
  const seen = new Set();
  for (const item of update.committeeProof.signatures || []) {
    const signer = ethers.getAddress(ethers.recoverAddress(digest, item.signature));
    if (signer !== ethers.getAddress(item.signer)) continue;
    if (!trusted.has(signer)) continue;
    seen.add(signer);
  }
  if (seen.size < threshold) {
    throw new Error(`header committee quorum not reached: ${seen.size}/${threshold}`);
  }
  return {
    header: normalizeHeader(update.header),
    finalizedHeight: Number(finality.finalizedHeight || update.header.number),
    finalizedHash: finality.finalizedHash || update.header.hash,
    committeeID,
    threshold,
    signerCount: seen.size,
    digest,
  };
}

module.exports = {
  DEFAULT_COMMITTEE_ID,
  normalizeHeader,
  committeeSigners,
  committeeThreshold,
  headerCommitteeDigest,
  buildCommitteeHeaderUpdate,
  verifyCommitteeHeaderUpdate,
};
