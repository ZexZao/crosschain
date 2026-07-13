const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { Api, JsonRpc } = require('eosjs');
const { JsSignatureProvider } = require('eosjs/dist/eosjs-jssig');
const { TextDecoder, TextEncoder } = require('util');
const { performance } = require('perf_hooks');

const parentRoot = process.env.PARENT_PROJECT_ROOT || path.resolve(__dirname, '../../crosschain_experiment');
const { loadDotEnv } = require(path.join(parentRoot, 'shared/env'));
const { buildReceiptProof } = require(path.join(parentRoot, 'shared/evm/receipt-proof'));
const { fetchBeaconLightClientInputs, verifySyncCommitteeHeaderUpdate } = require(path.join(parentRoot, 'shared/evm/sync-committee-light-client'));
const { loadSyncCommitteeState, resolveTrustedBlockRoot, saveSyncCommitteeState } = require(path.join(parentRoot, 'shared/evm/sync-committee-state'));
const { clusterCertificateTuple } = require(path.join(parentRoot, 'shared/tee/registration'));
const { bytes32, mercuryRequestDigest, mercuryConfirmationDigest } = require('../shared/mercury-digest');

loadDotEnv(path.join(parentRoot, '.env'));
const root = path.join(__dirname, '..');
const runtime = path.join(root, 'runtime');
const TEE_URLS = String(process.env.MERCURY_TEE_URLS || 'http://127.0.0.1:9300,http://127.0.0.1:9301,http://127.0.0.1:9302,http://127.0.0.1:9303,http://127.0.0.1:9304')
  .split(',').map((item) => item.trim()).filter(Boolean);
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL;
const SEPOLIA_KEY = process.env.SEPOLIA_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
const EOS_RPC = process.env.EOS_RPC_URL || 'http://127.0.0.1:8888';
const EOS_KEY = process.env.EOS_PRIVATE_KEY || '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const VAULT_ABI = [
  'function createDeposit(address,uint256,bytes32,uint64) returns (bytes32)',
  'function confirmTransfer(bytes32,bytes32,(bytes32,uint64,uint16,uint16,uint256,bytes32,bytes,bytes32,uint64,uint64))',
  'event MercuryDepositCreated(bytes32 indexed depositID,address indexed owner,address indexed token,uint256 amount,bytes32 requestHash,uint64 responseDeadline)',
];
const TOKEN_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'];

function nowMs() { return Math.round(performance.now()); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function teePost(route, body) {
  const errors = [];
  for (const url of TEE_URLS) {
    try { return (await axios.post(`${url}${route}`, body, { timeout: 180_000 })).data; }
    catch (error) { errors.push(`${url}: ${error.response?.data?.error || error.message}`); }
  }
  throw new Error(`no Mercury TEE accepted ${route}: ${errors.join('; ')}`);
}

async function waitForFinality(beaconUrl, targetBlockNumber) {
  const timeout = Number(process.env.SEPOLIA_FINALITY_TIMEOUT_MS || 20 * 60 * 1000);
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try {
      const response = await axios.get(`${beaconUrl}/eth/v1/beacon/light_client/finality_update`, { timeout: 20_000 });
      const height = Number(response.data?.data?.finalized_header?.execution?.block_number || 0);
      if (height >= Number(targetBlockNumber)) return height;
    } catch (_error) { /* transient beacon/RPC error */ }
    await sleep(Number(process.env.SEPOLIA_FINALITY_POLL_MS || 12_000));
  }
  throw new Error(`Sepolia finality timeout for block ${targetBlockNumber}`);
}

async function finalizedReceiptProof(provider, receipt, sourceChainID) {
  const receiptProof = await buildReceiptProof({ provider, blockNumber: receipt.blockNumber, txHash: receipt.hash });
  if (process.env.MERCURY_ALLOW_UNFINALIZED_EVM === 'true') return receiptProof;
  const beaconUrl = process.env.SEPOLIA_LIGHT_CLIENT_BEACON_API_URL || process.env.SEPOLIA_BEACON_API_URL;
  if (!beaconUrl) throw new Error('SEPOLIA_LIGHT_CLIENT_BEACON_API_URL is required');
  await waitForFinality(beaconUrl, receipt.blockNumber);
  const state = loadSyncCommitteeState();
  const trustedBlockRoot = process.env.SEPOLIA_TRUSTED_BLOCK_ROOT || resolveTrustedBlockRoot({ state });
  if (!trustedBlockRoot && process.env.SEPOLIA_ALLOW_DYNAMIC_TRUSTED_ROOT !== 'true') {
    throw new Error('SEPOLIA_TRUSTED_BLOCK_ROOT or prior sync committee state is required');
  }
  const syncCommitteeUpdate = await fetchBeaconLightClientInputs({
    beaconApiUrl: beaconUrl,
    executionProvider: provider,
    targetBlockNumber: receipt.blockNumber,
    trustedBlockRoot,
    allowDynamicTrustedRoot: process.env.SEPOLIA_ALLOW_DYNAMIC_TRUSTED_ROOT === 'true',
    maxAncestorHeaders: Number(process.env.SEPOLIA_MAX_ANCESTOR_HEADERS || 512),
  });
  syncCommitteeUpdate.chainID = sourceChainID;
  const verified = await verifySyncCommitteeHeaderUpdate(syncCommitteeUpdate, { expectedChainID: sourceChainID });
  saveSyncCommitteeState({
    chainID: sourceChainID,
    trustedBlockRoot: verified.nextTrustedBlockRoot,
    finalizedHeight: verified.finalizedHeight,
    finalizedHash: verified.finalizedHash,
    beaconFinalizedSlot: verified.beaconFinalizedSlot,
    signatureSlot: verified.signatureSlot,
    syncCommitteePeriod: verified.syncCommitteePeriod,
    participantCount: verified.participantCount,
  });
  return { ...receiptProof, syncCommitteeUpdate };
}

async function waitEOSIrreversible(rpc, blockNum) {
  const started = Date.now();
  const timeout = Number(process.env.EOS_FINALITY_TIMEOUT_MS || 120_000);
  while (Date.now() - started < timeout) {
    const info = await rpc.get_info();
    if (Number(info.last_irreversible_block_num) >= Number(blockNum)) return info;
    await sleep(500);
  }
  throw new Error(`EOS irreversible block timeout: ${blockNum}`);
}

async function main() {
  if (!SEPOLIA_RPC || !SEPOLIA_KEY) throw new Error('SEPOLIA_RPC_URL and SEPOLIA_PRIVATE_KEY are required');
  const startedAt = nowMs();
  fs.ensureDirSync(runtime);
  const sepolia = fs.readJsonSync(path.join(runtime, 'deployment.sepolia.json'));
  const eos = fs.readJsonSync(path.join(runtime, 'deployment.eos.json'));
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const signer = new ethers.Wallet(SEPOLIA_KEY, provider);
  const network = await provider.getNetwork();
  const vault = new ethers.Contract(sepolia.mercuryVault, VAULT_ABI, signer);
  const sourceAsset = process.env.MERCURY_SOURCE_TOKEN || sepolia.reusedSettlementToken;
  if (!sourceAsset) throw new Error('MERCURY_SOURCE_TOKEN or reusedSettlementToken is required');
  const sourceToken = new ethers.Contract(sourceAsset, TOKEN_ABI, signer);
  const sourceAmount = BigInt(process.env.MERCURY_SOURCE_AMOUNT || '1');
  const targetAmount = BigInt(process.env.MERCURY_EOS_TARGET_UNITS || '25000000');
  if (await sourceToken.balanceOf(signer.address) < sourceAmount) throw new Error('insufficient source token balance');

  const latest = await provider.getBlock('latest');
  const request = {
    sourceChainID: `eip155:${network.chainId}`,
    sourceVault: sepolia.mercuryVault,
    owner: signer.address,
    sourceAsset,
    sourceAmount: sourceAmount.toString(),
    targetChainID: eos.chainId,
    targetVault: eos.vault,
    targetAsset: 'EOS',
    targetAccount: eos.receiver,
    targetAmount: targetAmount.toString(),
    targetPrecision: 4,
    requestNonce: Date.now(),
  };
  const requestHash = mercuryRequestDigest(request);
  await (await sourceToken.approve(sepolia.mercuryVault, sourceAmount)).wait();
  const depositTx = await vault.createDeposit(sourceAsset, sourceAmount, requestHash, latest.timestamp + 300);
  const depositReceipt = await depositTx.wait();
  const depositEvent = depositReceipt.logs.map((log) => {
    try { return vault.interface.parseLog(log); } catch (_error) { return null; }
  }).find((item) => item?.name === 'MercuryDepositCreated');
  if (!depositEvent) throw new Error('MercuryDepositCreated event missing');
  request.depositID = depositEvent.args.depositID;
  const sourceProof = await finalizedReceiptProof(provider, depositReceipt, request.sourceChainID);
  const scale = 10n ** BigInt(request.targetPrecision);
  const targetQuantity = `${targetAmount / scale}.${String(targetAmount % scale).padStart(request.targetPrecision, '0')} ${request.targetAsset}`;

  const batch = {
    targetType: 'eos',
    targetChainID: eos.chainId,
    targetVault: eos.vault,
    batchID: ethers.keccak256(ethers.toUtf8Bytes(`mercury-eos-batch-${Date.now()}`)),
    requests: [request],
    transfers: [{ depositID: request.depositID, receiver: eos.receiver, quantity: targetQuantity, amount: targetAmount.toString() }],
  };
  const preparedAt = nowMs();
  const prepared = await teePost('/prepare-transfer-batch', { batch, sourceProofs: [sourceProof] });
  if (!prepared.eosSignatures?.length) throw new Error('TEE batch result is missing EOS signatures');

  const eosRpc = new JsonRpc(EOS_RPC, { fetch });
  const eosApi = new Api({
    rpc: eosRpc,
    signatureProvider: new JsSignatureProvider([EOS_KEY]),
    textDecoder: new TextDecoder(), textEncoder: new TextEncoder(),
  });
  const eosResult = await eosApi.transact({ actions: [{
    account: eos.vault,
    name: 'transfer',
    authorization: [{ actor: eos.vault, permission: 'active' }],
    data: {
      batch_id: batch.batchID.slice(2),
      transfers: batch.transfers.map((item) => ({
        deposit_id: item.depositID.slice(2), receiver: item.receiver, quantity: item.quantity,
      })),
      signatures: prepared.eosSignatures,
    },
  }] }, { blocksBehind: 3, expireSeconds: 120 });
  const blockNum = eosResult.processed.block_num;
  await waitEOSIrreversible(eosRpc, blockNum);
  const block = await eosRpc.get_block(blockNum);
  const targetTxID = bytes32(`0x${eosResult.transaction_id}`);

  const confirmation = {
    chainID: network.chainId.toString(),
    sourceVault: sepolia.mercuryVault,
    depositID: request.depositID,
    requestHash,
    targetTxID,
  };
  const targetProof = {
    chainType: 'eos',
    targetChainID: eos.chainId,
    contract: eos.vault,
    action: 'transfer',
    transactionID: eosResult.transaction_id,
    blockNum,
    blockID: block.id,
    transactionTrace: eosResult,
  };
  const confirmed = await teePost('/confirm-transfer', { confirmation, targetProof });
  if (confirmed.signingDigest !== mercuryConfirmationDigest(confirmation)) throw new Error('confirmation digest mismatch');
  const confirmReceipt = await (await vault.confirmTransfer(
    request.depositID,
    targetTxID,
    clusterCertificateTuple(confirmed.certificate)
  )).wait();

  const output = {
    testType: 'mercury-sepolia-eos-complete-exchange',
    pass: true,
    testedAt: new Date().toISOString(),
    depositID: request.depositID,
    sourceTxHash: depositReceipt.hash,
    sourceBlockNumber: depositReceipt.blockNumber,
    sourceGasUsed: Number(depositReceipt.gasUsed),
    eosTransactionID: eosResult.transaction_id,
    eosBlockNum: blockNum,
    confirmTxHash: confirmReceipt.hash,
    confirmGasUsed: Number(confirmReceipt.gasUsed),
    requestHash,
    batchSigningDigest: prepared.signingDigest,
    confirmationDigest: confirmed.signingDigest,
    raft: confirmed.raft,
    timings: { totalMs: nowMs() - startedAt, depositProofAndBatchConsensusMs: preparedAt - startedAt, targetAndConfirmationMs: nowMs() - preparedAt },
  };
  fs.writeJsonSync(path.join(runtime, 'sepolia-eos-ablation-result.json'), output, { spaces: 2 });
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  fs.ensureDirSync(runtime);
  fs.writeJsonSync(path.join(runtime, 'sepolia-eos-ablation-result.json'), {
    testType: 'mercury-sepolia-eos-complete-exchange', pass: false, testedAt: new Date().toISOString(), error: error.message,
  }, { spaces: 2 });
  console.error(error);
  process.exit(1);
});
