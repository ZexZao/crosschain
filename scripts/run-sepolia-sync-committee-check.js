const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');
const { loadDotEnv } = require('../shared/env');
const {
  fetchBeaconLightClientInputs,
  verifySyncCommitteeHeaderUpdate,
} = require('../shared/evm/sync-committee-light-client');

loadDotEnv();

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

  const startedAt = Date.now();
  const update = await fetchBeaconLightClientInputs({
    beaconApiUrl,
    executionProvider: provider,
    targetBlockNumber,
    trustedBlockRoot: process.env.SEPOLIA_TRUSTED_BLOCK_ROOT,
    allowDynamicTrustedRoot: process.env.SEPOLIA_ALLOW_DYNAMIC_TRUSTED_ROOT === 'true',
  });
  update.chainID = `eip155:${process.env.SEPOLIA_CHAIN_ID || 11155111}`;
  const verified = await verifySyncCommitteeHeaderUpdate(update, {
    expectedChainID: update.chainID,
    targetBlockNumber,
    targetBlockHash,
  });
  const elapsedMs = Date.now() - startedAt;

  const output = {
    testType: 'sepolia-sync-committee-light-client',
    testedAt: new Date().toISOString(),
    executionRpc: executionRpc.replace(/\/v2\/.*/, '/v2/***'),
    beaconApiUrl,
    chainID: update.chainID,
    targetBlockNumber,
    targetBlockHash,
    trustedBlockRoot: update.trustedBlockRoot,
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
