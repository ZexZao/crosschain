const fs = require('fs-extra');
const path = require('path');

const DEFAULT_STATE_FILE = path.join(__dirname, '..', '..', 'runtime', 'sepolia-sync-committee-state.json');

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

module.exports = {
  syncCommitteeStateFile,
  loadSyncCommitteeState,
  resolveTrustedBlockRoot,
  saveSyncCommitteeState,
};
