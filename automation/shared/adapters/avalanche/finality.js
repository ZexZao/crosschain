const { ethers } = require('ethers');

async function checkAvalancheFinality({ profile, event }) {
  const provider = new ethers.JsonRpcProvider(profile.rpc);
  const receipt = await provider.getTransactionReceipt(event.transactionID);
  if (!receipt) return { ready: false, pollAfterMs: 1000, reason: 'receipt-unavailable' };
  if (Number(receipt.status) !== 1) return { terminal: true, state: 'FAILED', reason: 'source-transaction-reverted' };
  if (String(receipt.blockHash).toLowerCase() !== String(event.blockHash).toLowerCase()) {
    return { terminal: true, state: 'ORPHANED', reason: 'source-transaction-reorganized' };
  }
  return {
    ready: true,
    finalizedHeight: Number(receipt.blockNumber),
    finalizedHash: receipt.blockHash,
    source: 'avalanche-snowman-finality',
  };
}

module.exports = { checkAvalancheFinality };
