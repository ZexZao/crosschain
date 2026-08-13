const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { canonicalizeValidators, validatorSetHash } = require('./warp-proof');

const PRIMARY_NETWORK_ID = '11111111111111111111111111111111LpoYY';
const DEFAULT_ANCHOR_FILE = path.join(__dirname, '..', '..', 'runtime', 'avalanche-pchain-trust-anchor.json');

function sameText(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function normalizeRpcValidators(rawValidators) {
  const validators = [];
  for (const item of rawValidators || []) {
    const nodeIDs = Array.isArray(item.nodeIDs) && item.nodeIDs.length ? item.nodeIDs : [item.nodeID];
    for (const nodeID of nodeIDs.filter(Boolean)) {
      validators.push({
        nodeID: String(nodeID),
        publicKey: item.publicKey || item.signer?.publicKey,
        weight: String(item.weight),
      });
    }
  }
  return canonicalizeValidators(validators);
}

function normalizeAnchor(anchor) {
  if (!anchor || Number(anchor.schemaVersion) !== 1) throw new Error('unsupported Avalanche P-Chain trust anchor');
  if (!anchor.genesisHash) throw new Error('Avalanche P-Chain genesisHash is required');
  if (!Number.isInteger(Number(anchor.networkID))) throw new Error('Avalanche P-Chain networkID is required');
  if (!Array.isArray(anchor.validatorSnapshots) || anchor.validatorSnapshots.length === 0) {
    throw new Error('Avalanche P-Chain validator snapshot is required');
  }
  const validatorSnapshots = anchor.validatorSnapshots.map((snapshot) => {
    const validators = canonicalizeValidators(snapshot.validators);
    const computedHash = validatorSetHash(validators);
    if (!sameText(computedHash, snapshot.validatorSetHash)) {
      throw new Error('Avalanche trust anchor validatorSetHash mismatch');
    }
    const computedWeight = validators.reduce((sum, item) => sum + BigInt(item.weight), 0n).toString();
    if (String(snapshot.totalWeight) !== computedWeight) {
      throw new Error('Avalanche trust anchor totalWeight mismatch');
    }
    return {
      ...snapshot,
      pChainHeight: Number(snapshot.pChainHeight),
      validators,
      validatorSetHash: computedHash,
      totalWeight: computedWeight,
    };
  }).sort((a, b) => a.pChainHeight - b.pChainHeight);
  return {
    ...anchor,
    networkID: Number(anchor.networkID),
    primaryNetworkID: anchor.primaryNetworkID || PRIMARY_NETWORK_ID,
    quorumNumerator: Number(anchor.quorumNumerator || 67),
    quorumDenominator: Number(anchor.quorumDenominator || 100),
    validatorSnapshots,
  };
}

function loadPChainTrustAnchor(anchorFile = process.env.AVALANCHE_PCHAIN_TRUST_ANCHOR_FILE || DEFAULT_ANCHOR_FILE) {
  if (!fs.existsSync(anchorFile)) {
    throw new Error(`Avalanche P-Chain trust anchor is not provisioned: ${anchorFile}`);
  }
  return normalizeAnchor(fs.readJsonSync(anchorFile));
}

function selectPinnedSnapshot(anchor, pChainHeight) {
  const height = Number(pChainHeight);
  if (!Number.isInteger(height) || height < 0) throw new Error('invalid Avalanche P-Chain height');
  const candidates = anchor.validatorSnapshots.filter((snapshot) => snapshot.pChainHeight <= height);
  const snapshot = candidates[candidates.length - 1];
  if (!snapshot) throw new Error(`no trusted Avalanche validator snapshot at P-Chain height ${height}`);
  if (snapshot.validUntilHeight !== undefined && height > Number(snapshot.validUntilHeight)) {
    throw new Error(`Avalanche validator snapshot expired at P-Chain height ${snapshot.validUntilHeight}`);
  }
  if (!anchor.staticValidatorSet && snapshot.pChainHeight !== height) {
    throw new Error(`exact Avalanche validator snapshot required at P-Chain height ${height}`);
  }
  return snapshot;
}

async function pChainRpc(rpcURL, method, params) {
  const response = await axios.post(rpcURL, {
    jsonrpc: '2.0', id: 1, method, params,
  }, { timeout: Number(process.env.AVALANCHE_PCHAIN_RPC_TIMEOUT_MS || 10_000) });
  if (response.data?.error) throw new Error(`${method}: ${response.data.error.message}`);
  return response.data?.result;
}

function assertProofMatchesTrustedSnapshot({
  anchor,
  snapshot,
  validatorSetRef,
  sourceProof,
  suppliedValidatorSet = [],
}) {
  if (Number(sourceProof?.networkID) !== anchor.networkID
      || Number(validatorSetRef?.networkID) !== anchor.networkID) {
    throw new Error('Avalanche proof networkID is not anchored to trusted P-Chain genesis');
  }
  if (anchor.sourceChainIDs?.length
      && !anchor.sourceChainIDs.some((chainID) => sameText(chainID, sourceProof?.sourceChainID))) {
    throw new Error('Avalanche sourceChainID is not authorized by P-Chain trust anchor');
  }
  if (!sameText(validatorSetRef?.validatorSetHash, snapshot.validatorSetHash)) {
    throw new Error('relayer validatorSetHash does not match trusted P-Chain snapshot');
  }
  if (String(validatorSetRef?.totalWeight) !== snapshot.totalWeight) {
    throw new Error('relayer totalWeight does not match trusted P-Chain snapshot');
  }
  if (Number(validatorSetRef?.quorumNumerator) !== anchor.quorumNumerator
      || Number(validatorSetRef?.quorumDenominator) !== anchor.quorumDenominator) {
    throw new Error('relayer cannot override trusted Avalanche quorum policy');
  }
  if (validatorSetRef?.canonicalOrdering !== 'nodeID-ascending') {
    throw new Error('unsupported Avalanche validator canonical ordering');
  }
  if (suppliedValidatorSet.length
      && !sameText(validatorSetHash(suppliedValidatorSet), snapshot.validatorSetHash)) {
    throw new Error('relayer validator set does not match trusted P-Chain snapshot');
  }
}

async function resolveTrustedValidatorSet({ validatorSetRef, sourceProof, suppliedValidatorSet = [] } = {}) {
  const anchor = loadPChainTrustAnchor();
  const pChainHeight = Number(validatorSetRef?.pChainHeight);
  const snapshot = selectPinnedSnapshot(anchor, pChainHeight);
  assertProofMatchesTrustedSnapshot({
    anchor,
    snapshot,
    validatorSetRef,
    sourceProof,
    suppliedValidatorSet,
  });
  const rpcURL = process.env.AVALANCHE_PCHAIN_RPC_URL;
  if (!rpcURL) throw new Error('Avalanche TEE requires its own AVALANCHE_PCHAIN_RPC_URL');
  const accepted = await pChainRpc(rpcURL, 'platform.getHeight', {});
  const acceptedHeight = Number(accepted?.height);
  if (!Number.isInteger(acceptedHeight) || pChainHeight > acceptedHeight) {
    throw new Error(`P-Chain height is not accepted locally: proof=${pChainHeight} local=${acceptedHeight}`);
  }
  const maxLag = Number(process.env.AVALANCHE_PCHAIN_MAX_HEIGHT_LAG || 1000);
  if (acceptedHeight - pChainHeight > maxLag) {
    throw new Error(`P-Chain validator snapshot is stale: proof=${pChainHeight} local=${acceptedHeight}`);
  }
  const result = await pChainRpc(rpcURL, 'platform.getAllValidatorsAt', { height: pChainHeight });
  const rpcSet = result?.validatorSets?.[anchor.primaryNetworkID];
  if (!rpcSet) throw new Error(`P-Chain validator set missing at height ${pChainHeight}`);
  const rpcValidators = normalizeRpcValidators(rpcSet.validators);
  const rpcHash = validatorSetHash(rpcValidators);
  if (!sameText(rpcHash, snapshot.validatorSetHash)) {
    throw new Error('local P-Chain validator set does not match genesis-pinned trust anchor');
  }
  if (String(rpcSet.totalWeight) !== snapshot.totalWeight) {
    throw new Error('local P-Chain totalWeight does not match trusted snapshot');
  }

  return {
    validators: snapshot.validators,
    validatorSetHash: snapshot.validatorSetHash,
    totalWeight: snapshot.totalWeight,
    pChainHeight,
    acceptedHeight,
    networkID: anchor.networkID,
    genesisHash: anchor.genesisHash,
    quorumNumerator: anchor.quorumNumerator,
    quorumDenominator: anchor.quorumDenominator,
    trustMode: anchor.mode,
  };
}

function describePChainTrustAnchor() {
  const anchor = loadPChainTrustAnchor();
  const latest = anchor.validatorSnapshots[anchor.validatorSnapshots.length - 1];
  return {
    mode: anchor.mode,
    networkID: anchor.networkID,
    genesisHash: anchor.genesisHash,
    sourceChainIDs: anchor.sourceChainIDs || [],
    snapshotHeight: latest.pChainHeight,
    validatorSetHash: latest.validatorSetHash,
    totalWeight: latest.totalWeight,
    validatorCount: latest.validators.length,
    quorumNumerator: anchor.quorumNumerator,
    quorumDenominator: anchor.quorumDenominator,
  };
}

module.exports = {
  PRIMARY_NETWORK_ID,
  DEFAULT_ANCHOR_FILE,
  normalizeRpcValidators,
  normalizeAnchor,
  loadPChainTrustAnchor,
  selectPinnedSnapshot,
  assertProofMatchesTrustedSnapshot,
  resolveTrustedValidatorSet,
  describePChainTrustAnchor,
};
