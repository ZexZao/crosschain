const { ethers } = require('ethers');

async function fetchBeaconFinality(beaconApiUrl) {
  const url = `${String(beaconApiUrl).replace(/\/$/, '')}/eth/v1/beacon/light_client/finality_update`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Beacon finality API returned ${response.status}`);
  const body = await response.json();
  const execution = body.data?.finalized_header?.execution;
  if (!execution) throw new Error('Beacon finality response missing execution header');
  return {
    finalizedHeight: Number(execution.block_number),
    finalizedHash: execution.block_hash,
    beaconFinalizedSlot: Number(body.data.finalized_header.beacon.slot),
    signatureSlot: Number(body.data.signature_slot),
    source: 'beacon-light-client-finality-update',
  };
}

async function checkEthereumFinality({ profile, event }) {
  const provider = new ethers.JsonRpcProvider(profile.rpc);
  const receipt = await provider.getTransactionReceipt(event.transactionID);
  if (!receipt) return { ready: false, pollAfterMs: 12_000, reason: 'receipt-unavailable' };
  if (Number(receipt.status) !== 1) return { terminal: true, state: 'FAILED', reason: 'source-transaction-reverted' };
  if (String(receipt.blockHash).toLowerCase() !== String(event.blockHash).toLowerCase()) {
    return { terminal: true, state: 'ORPHANED', reason: 'source-transaction-reorganized' };
  }
  if (profile.finality !== 'ethereum-sync-committee') {
    return {
      ready: true,
      finalizedHeight: Number(receipt.blockNumber),
      finalizedHash: receipt.blockHash,
      source: 'local-header-committee',
    };
  }
  const beaconApiUrl = process.env.SEPOLIA_LIGHT_CLIENT_BEACON_API_URL || process.env.SEPOLIA_BEACON_API_URL;
  if (!beaconApiUrl) throw new Error('Sepolia Beacon API URL is required');
  const finality = await fetchBeaconFinality(beaconApiUrl);
  return Number(finality.finalizedHeight) >= Number(event.blockHeight)
    ? { ready: true, ...finality }
    : { ready: false, pollAfterMs: 12_000, ...finality };
}

module.exports = { fetchBeaconFinality, checkEthereumFinality };
