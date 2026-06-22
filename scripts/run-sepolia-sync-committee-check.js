const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');
const { loadDotEnv } = require('../shared/env');
const {
  fetchBeaconLightClientInputs,
  verifySyncCommitteeHeaderUpdate,
} = require('../shared/evm/sync-committee-light-client');
const {
  loadSyncCommitteeState,
  resolveTrustedBlockRoot,
  saveSyncCommitteeState,
  syncCommitteeStateFile,
} = require('../shared/evm/sync-committee-state');

loadDotEnv();

function redactUrl(value) {
  return String(value || '')
    .replace(/\/v3\/[^/?#]+/i, '/v3/***')
    .replace(/\/v2\/[^/?#]+/i, '/v2/***');
}

async function main() {
  const runtimeDir = path.join(__dirname, '..', 'runtime');
  fs.ensureDirSync(runtimeDir);

  const executionRpc = process.env.SEPOLIA_RPC_URL;
  const beaconApiUrl = process.env.SEPOLIA_LIGHT_CLIENT_BEACON_API_URL
    || process.env.SEPOLIA_BEACON_API_URL;
  if (!executionRpc) throw new Error('SEPOLIA_RPC_URL is required');
  if (!beaconApiUrl) throw new Error('SEPOLIA_LIGHT_CLIENT_BEACON_API_URL or SEPOLIA_BEACON_API_URL is required');

  const provider = new ethers.JsonRpcProvider(executionRpc);
  const finalizedBlock = await provider.send('eth_getBlockByNumber', ['finalized', false]);
  if (!finalizedBlock) throw new Error('Sepolia finalized execution block not available');
  const targetBlockNumber = Number(BigInt(finalizedBlock.number));
  const targetBlockHash = finalizedBlock.hash;
  const state = loadSyncCommitteeState();
  const trustedBlockRoot = resolveTrustedBlockRoot({ state });
  if (!trustedBlockRoot && process.env.SEPOLIA_ALLOW_DYNAMIC_TRUSTED_ROOT !== 'true') {
    throw new Error(`SEPOLIA_TRUSTED_BLOCK_ROOT or ${syncCommitteeStateFile()} is required`);
  }

  const startedAt = Date.now();
  const update = await fetchBeaconLightClientInputs({
    beaconApiUrl,
    executionProvider: provider,
    targetBlockNumber,
    trustedBlockRoot,
    allowDynamicTrustedRoot: process.env.SEPOLIA_ALLOW_DYNAMIC_TRUSTED_ROOT === 'true',
  });
  update.chainID = `eip155:${process.env.SEPOLIA_CHAIN_ID || 11155111}`;
  const verified = await verifySyncCommitteeHeaderUpdate(update, {
    expectedChainID: update.chainID,
    targetBlockNumber,
    targetBlockHash,
  });
  const elapsedMs = Date.now() - startedAt;
  const nextState = saveSyncCommitteeState({
    chainID: update.chainID,
    trustedBlockRoot: verified.nextTrustedBlockRoot,
    finalizedHeight: verified.finalizedHeight,
    finalizedHash: verified.finalizedHash,
    beaconFinalizedSlot: verified.beaconFinalizedSlot,
    signatureSlot: verified.signatureSlot,
    syncCommitteePeriod: verified.syncCommitteePeriod,
    participantCount: verified.participantCount,
    source: 'run-sepolia-sync-committee-check',
  });

  const output = {
    testType: 'sepolia-sync-committee-light-client',
    testedAt: new Date().toISOString(),
    executionRpc: redactUrl(executionRpc),
    beaconApiUrl: redactUrl(beaconApiUrl),
    chainID: update.chainID,
    targetBlockNumber,
    targetBlockHash,
    trustedBlockRoot: update.trustedBlockRoot,
    nextTrustedBlockRoot: verified.nextTrustedBlockRoot,
    stateFile: syncCommitteeStateFile(),
    savedState: nextState,
    proofType: update.proofType,
    finalityVersion: update.finalityVersion,
    participantCount: verified.participantCount,
    threshold: verified.threshold,
    finalizedHeight: verified.finalizedHeight,
    finalizedHash: verified.finalizedHash,
    beaconFinalizedSlot: verified.beaconFinalizedSlot,
    signatureSlot: verified.signatureSlot,
    syncCommitteePeriod: verified.syncCommitteePeriod,
    committeeUpdates: verified.committeeUpdates || [],
    elapsedMs,
    pass: true,
  };
  fs.writeJsonSync(path.join(runtimeDir, 'sepolia-sync-committee-result.json'), output, { spaces: 2 });
  fs.writeFileSync(
    path.join(runtimeDir, 'sepolia-sync-committee-summary.md'),
    `# Sepolia Sync Committee Verification\n\n` +
      `**测试时间**：${output.testedAt}\n` +
      `**结果**：PASS\n` +
      `**目标执行区块**：${output.targetBlockNumber}\n` +
      `**目标区块哈希**：${output.targetBlockHash}\n` +
      `**finalized 高度**：${output.finalizedHeight}\n` +
      `**sync committee period**：${output.syncCommitteePeriod}\n` +
      `**committee update 数量**：${output.committeeUpdates.length}\n` +
      `**trusted root**：${output.trustedBlockRoot}\n` +
      `**next trusted root**：${output.nextTrustedBlockRoot}\n` +
      `**state file**：${output.stateFile}\n` +
      `**sync committee 参与数**：${output.participantCount}/${512}\n` +
      `**阈值**：${output.threshold}\n` +
      `**耗时**：${output.elapsedMs} ms\n` +
      `**Beacon API**：${output.beaconApiUrl}\n`
  );
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
