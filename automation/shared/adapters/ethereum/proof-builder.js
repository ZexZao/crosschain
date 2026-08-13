const axios = require('axios');
const { ethers } = require('ethers');
const { buildHXMsgFromEvmReceipt } = require('../../../../hxmsg-builder/evm-to-fabric');
const { buildHXMsgFromEvmReceiptToEvm } = require('../../../../hxmsg-builder/evm-to-evm');
const { buildReceiptProof } = require('../../../../shared/evm/receipt-proof');
const { buildCommitteeHeaderUpdate } = require('../../../../shared/evm/header-committee');
const {
  fetchBeaconLightClientInputs,
  verifySyncCommitteeHeaderUpdate,
} = require('../../../../shared/evm/sync-committee-light-client');
const {
  loadSyncCommitteeState,
  resolveTrustedBlockRoot,
} = require('../../../../shared/evm/sync-committee-state');
const { ChainType, getExecutionData } = require('../../../../shared/hxmsg');
const { teeURLsFromEnv } = require('../../../../shared/tee/subnet-routing');

async function fetchQuorumSyncCommitteeRoot() {
  const urls = teeURLsFromEnv({ sourceChainType: ChainType.EVM });
  const roots = await Promise.all(urls.map(async (url) => {
    try {
      const response = await axios.get(`${url}/chain-state`, { timeout: 3000 });
      const state = response.data?.evmChains?.['eip155:11155111'] || response.data?.evm;
      return state?.syncCommittee?.trustedBlockRoot?.toLowerCase() || null;
    } catch (_error) {
      return null;
    }
  }));
  const counts = new Map();
  for (const root of roots.filter(Boolean)) counts.set(root, (counts.get(root) || 0) + 1);
  const [root, count = 0] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] || [];
  return count >= Math.floor(urls.length / 2) + 1 ? root : null;
}

async function buildEthereumEvidence({ profile, targetProfile, event, material }) {
  if (!material?.businessPayload) throw new Error(`source material missing for ${event.requestID}`);
  const provider = new ethers.JsonRpcProvider(profile.rpc);
  const [receipt, block] = await Promise.all([
    provider.getTransactionReceipt(event.transactionID),
    provider.getBlock(event.blockHeight),
  ]);
  if (!receipt || !block) throw new Error('source receipt or block unavailable');
  if (String(receipt.blockHash).toLowerCase() !== String(event.blockHash).toLowerCase()) {
    const error = new Error('source transaction was reorganized');
    error.code = 'SOURCE_ORPHANED';
    throw error;
  }
  const receiptProof = await buildReceiptProof({
    provider,
    blockNumber: receipt.blockNumber,
    txHash: receipt.hash,
  });
  const sourceDeployment = profile.deployment;
  const common = {
    receipt,
    block,
    businessPayload: material.businessPayload,
    feedbackOverride: material.feedback,
    atomicity: material.atomicity,
  };
  const hxmsg = targetProfile.kind === 'fabric'
    ? buildHXMsgFromEvmReceipt({ deployment: sourceDeployment, ...common })
    : buildHXMsgFromEvmReceiptToEvm({
      sourceDeployment,
      targetDeployment: targetProfile.deployment,
      targetChainType: targetProfile.chainType,
      ...common,
    });
  let committeeHeaderUpdate = null;
  let syncCommitteeUpdate = null;
  let verifiedSyncCommittee = null;
  if (profile.finality === 'ethereum-sync-committee') {
    const runtimeState = loadSyncCommitteeState();
    const trustedBlockRoot = await fetchQuorumSyncCommitteeRoot()
      || process.env.SEPOLIA_TRUSTED_BLOCK_ROOT
      || resolveTrustedBlockRoot({ state: runtimeState });
    if (!trustedBlockRoot && process.env.SEPOLIA_ALLOW_DYNAMIC_TRUSTED_ROOT !== 'true') {
      throw new Error('Sepolia trusted block root is not initialized');
    }
    syncCommitteeUpdate = await fetchBeaconLightClientInputs({
      beaconApiUrl: process.env.SEPOLIA_LIGHT_CLIENT_BEACON_API_URL || process.env.SEPOLIA_BEACON_API_URL,
      executionProvider: provider,
      targetBlockNumber: Number(receipt.blockNumber),
      trustedBlockRoot,
      allowDynamicTrustedRoot: process.env.SEPOLIA_ALLOW_DYNAMIC_TRUSTED_ROOT === 'true',
      maxAncestorHeaders: Number(process.env.SEPOLIA_MAX_ANCESTOR_HEADERS || 512),
    });
    syncCommitteeUpdate.chainID = `eip155:${sourceDeployment.chainId}`;
    verifiedSyncCommittee = await verifySyncCommitteeHeaderUpdate(syncCommitteeUpdate, {
      expectedChainID: syncCommitteeUpdate.chainID,
      targetBlockNumber: Number(receipt.blockNumber),
      targetBlockHash: receipt.blockHash,
    });
  } else {
    committeeHeaderUpdate = buildCommitteeHeaderUpdate({
      header: receiptProof.blockHeader,
      chainID: `eip155:${sourceDeployment.chainId}`,
    });
  }
  return {
    hxmsg,
    helperData: {
      evmReceiptProof: receiptProof,
      committeeHeaderUpdate,
      syncCommitteeUpdate,
      evmRpc: profile.name === 'ethereum' ? (process.env.TEE_EVM_RPC || 'http://evm-node:8545') : profile.rpc,
    },
    execution: getExecutionData(hxmsg),
    syncCommitteeState: verifiedSyncCommittee ? {
      chainID: syncCommitteeUpdate.chainID,
      trustedBlockRoot: verifiedSyncCommittee.nextTrustedBlockRoot,
      trustedBlockSlot: verifiedSyncCommittee.nextTrustedBlockSlot,
      finalizedBeaconBlockRoot: verifiedSyncCommittee.finalizedBeaconBlockRoot,
      finalizedHeight: verifiedSyncCommittee.finalizedHeight,
      finalizedHash: verifiedSyncCommittee.finalizedHash,
      beaconFinalizedSlot: verifiedSyncCommittee.beaconFinalizedSlot,
      signatureSlot: verifiedSyncCommittee.signatureSlot,
      syncCommitteePeriod: verifiedSyncCommittee.syncCommitteePeriod,
      participantCount: verifiedSyncCommittee.participantCount,
      source: 'automation-relayer',
    } : null,
  };
}

module.exports = { buildEthereumEvidence, fetchQuorumSyncCommitteeRoot };
