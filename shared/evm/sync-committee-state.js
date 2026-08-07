const fs = require('fs-extra');
const path = require('path');

const DEFAULT_STATE_FILE = path.join(__dirname, '..', '..', 'runtime', 'sepolia-sync-committee-state.json');
const DEFAULT_ENV_FILE = path.join(__dirname, '..', '..', '.env');

function syncCommitteeStateFile() {
  return process.env.SEPOLIA_SYNC_COMMITTEE_STATE_FILE || DEFAULT_STATE_FILE;
}

function loadSyncCommitteeState(filePath = syncCommitteeStateFile()) {
  if (!fs.existsSync(filePath)) return null;
  const state = fs.readJsonSync(filePath);
  return state && typeof state === 'object' ? state : null;
}

function resolveTrustedBlockRoot({ state, env = process.env } = {}) {
  const candidate = state?.trustedBlockRoot || env.SEPOLIA_TRUSTED_BLOCK_ROOT;
  return candidate || null;
}

function saveSyncCommitteeState({
  chainID,
  trustedBlockRoot,
  trustedBlockSlot,
  finalizedBeaconBlockRoot,
  finalizedHeight,
  finalizedHash,
  beaconFinalizedSlot,
  signatureSlot,
  syncCommitteePeriod,
  participantCount,
  source = 'verified-sync-committee-update',
}, filePath = syncCommitteeStateFile()) {
  if (!trustedBlockRoot) throw new Error('trustedBlockRoot is required');
  fs.ensureDirSync(path.dirname(filePath));
  const state = {
    chainID,
    trustedBlockRoot,
    trustedBlockSlot: Number(trustedBlockSlot || 0),
    finalizedBeaconBlockRoot: finalizedBeaconBlockRoot || null,
    finalizedHeight: Number(finalizedHeight || 0),
    finalizedHash: finalizedHash || null,
    beaconFinalizedSlot: Number(beaconFinalizedSlot || 0),
    signatureSlot: Number(signatureSlot || 0),
    syncCommitteePeriod: Number(syncCommitteePeriod || 0),
    participantCount: Number(participantCount || 0),
    source,
    updatedAt: new Date().toISOString(),
  };
  fs.writeJsonSync(filePath, state, { spaces: 2 });
  return state;
}

function updateEnvTrustedBlockRoot(trustedBlockRoot, {
  envFile = process.env.SEPOLIA_ENV_FILE || DEFAULT_ENV_FILE,
  enabled = process.env.SEPOLIA_UPDATE_ENV_TRUSTED_ROOT !== 'false',
} = {}) {
  if (!enabled) return { updated: false, envFile, reason: 'disabled' };
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(trustedBlockRoot || ''))) {
    throw new Error('trustedBlockRoot must be a bytes32 hex value');
  }

  const current = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  const newline = current.includes('\r\n') ? '\r\n' : '\n';
  const line = `SEPOLIA_TRUSTED_BLOCK_ROOT=${trustedBlockRoot}`;
  const pattern = /^SEPOLIA_TRUSTED_BLOCK_ROOT=.*$/m;
  const next = pattern.test(current)
    ? current.replace(pattern, line)
    : `${current}${current && !current.endsWith('\n') ? newline : ''}${line}${newline}`;
  if (next === current) {
    process.env.SEPOLIA_TRUSTED_BLOCK_ROOT = trustedBlockRoot;
    return { updated: false, envFile, trustedBlockRoot, reason: 'unchanged' };
  }

  fs.ensureDirSync(path.dirname(envFile));
  const temporary = `${envFile}.tmp-${process.pid}-${Date.now()}`;
  const mode = fs.existsSync(envFile) ? fs.statSync(envFile).mode : 0o600;
  try {
    fs.writeFileSync(temporary, next, { encoding: 'utf8', mode });
    fs.renameSync(temporary, envFile);
  } finally {
    if (fs.existsSync(temporary)) fs.removeSync(temporary);
  }
  process.env.SEPOLIA_TRUSTED_BLOCK_ROOT = trustedBlockRoot;
  return { updated: true, envFile, trustedBlockRoot };
}

module.exports = {
  syncCommitteeStateFile,
  loadSyncCommitteeState,
  resolveTrustedBlockRoot,
  saveSyncCommitteeState,
  updateEnvTrustedBlockRoot,
};
