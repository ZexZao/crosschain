const express = require('express');
const path = require('path');
const fs = require('fs-extra');
const { ethers } = require('ethers');
const ecc = require('eosjs-ecc');
const { Api, JsonRpc } = require('eosjs');
const { TextDecoder, TextEncoder } = require('util');

const parentRoot = process.env.PARENT_PROJECT_ROOT || path.resolve(__dirname, '../../crosschain_experiment');
const { loadDotEnv } = require(path.join(parentRoot, 'shared/env'));
const { buildSimulatedAttestationIdentity } = require(path.join(parentRoot, 'shared/tee/attestation'));
const { signCommittedDigest, buildQuorumCertificate } = require(path.join(parentRoot, 'shared/tee/quorum-certificate'));
const { verifyReceiptProof } = require(path.join(parentRoot, 'shared/evm/receipt-proof'));
const { verifySyncCommitteeHeaderUpdate } = require(path.join(parentRoot, 'shared/evm/sync-committee-light-client'));
const { createMercuryRaft } = require('./mercury-raft');
const {
  bytes32,
  hashJSON,
  mercuryRequestDigest,
  mercuryEvmBatchDigest,
  mercuryEOSBatchDigest,
  mercuryConfirmationDigest,
  mercuryCheckpointDigest,
} = require('../shared/mercury-digest');

loadDotEnv(path.join(parentRoot, '.env'));
const app = express();
app.use(express.json({ limit: '30mb' }));

const PORT = Number(process.env.MERCURY_TEE_PORT || process.env.PORT || 9300);
const nodeID = process.env.TEE_NODE_ID || 'mercury-tee-1';
const signerIndex = Number(process.env.TEE_SIGNER_INDEX || 0);
const privateKey = process.env.TEE_PRIVATE_KEY || ethers.Wallet.createRandom().privateKey;
const wallet = new ethers.Wallet(privateKey);
const eosPrivateKey = ecc.PrivateKey.fromBuffer(Buffer.from(privateKey.slice(2), 'hex'));
const clusterID = ethers.keccak256(ethers.toUtf8Bytes(
  process.env.MERCURY_CLUSTER_ID || 'MERCURY_ETH_EOS_ABLATION_CLUSTER_V1'
));
const epoch = Number(process.env.MERCURY_TEE_EPOCH || 1);
const runtimeDir = path.join(__dirname, '..', 'runtime');
fs.ensureDirSync(runtimeDir);
const chainStateFile = path.join(runtimeDir, `mercury-chain-state-${nodeID}.json`);
const chainState = fs.readJsonSync(chainStateFile, { throws: false }) || {
  ethereum: { trustedBlockRoot: process.env.SEPOLIA_TRUSTED_BLOCK_ROOT || null, finalizedHeight: 0, finalizedHash: null },
};
function saveChainState() { fs.writeJsonSync(chainStateFile, chainState, { spaces: 2 }); }

const SOURCE_EVENT = new ethers.Interface([
  'event MercuryDepositCreated(bytes32 indexed depositID,address indexed owner,address indexed token,uint256 amount,bytes32 requestHash,uint64 responseDeadline)',
]);
const TARGET_EVENT = new ethers.Interface([
  'event MercuryTargetTransfer(bytes32 indexed batchID,bytes32 indexed depositID,address indexed receiver,address token,uint256 amount)',
]);

async function identity() {
  return buildSimulatedAttestationIdentity({
    privateKey,
    nodeID,
    subnetID: 'mercury-exchange-cluster',
    subnetProfile: 'mercury',
    signerIndex,
    epoch,
  });
}

async function signEntry(entry) {
  const signed = signCommittedDigest({
    privateKey,
    nodeID,
    identity: await identity(),
    committedEntry: {
      requestID: entry.requestID || ethers.ZeroHash,
      hmsgDigest: entry.signingDigest,
      signingDigest: entry.signingDigest,
      signatureDigestType: entry.operationType,
      term: entry.term,
      index: entry.index,
    },
  });
  if (entry.operationType === 'transferBatch' && entry.payload?.targetType === 'eos') {
    signed.eosSignature = ecc.signHash(entry.signingDigest.slice(2), eosPrivateKey.toWif());
    signed.eosPublicKey = eosPrivateKey.toPublic().toString();
  }
  return signed;
}

function sameHex(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function findEvent(receipt, iface, eventName, expectedAddress) {
  for (const log of receipt.logs || []) {
    if (expectedAddress && !sameHex(log.address, expectedAddress)) continue;
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === eventName) return parsed;
    } catch (_error) { /* unrelated event */ }
  }
  throw new Error(`${eventName} event not found in proved receipt`);
}

async function verifyEvmReceiptEnvelope(envelope, expectedChainID) {
  if (!envelope?.receipt || !Array.isArray(envelope.receiptProof)) {
    throw new Error('receipt and receiptProof are required');
  }
  const receipt = envelope.receipt;
  let trustedHeader;
  if (envelope.syncCommitteeUpdate) {
    const configuredRoot = chainState.ethereum.trustedBlockRoot || process.env.SEPOLIA_TRUSTED_BLOCK_ROOT;
    if (configuredRoot && !sameHex(envelope.syncCommitteeUpdate.trustedBlockRoot, configuredRoot)) {
      throw new Error('sync committee trusted root mismatch');
    }
    const verified = await verifySyncCommitteeHeaderUpdate(envelope.syncCommitteeUpdate, {
      expectedChainID,
      targetBlockNumber: Number(BigInt(receipt.blockNumber)),
      targetBlockHash: receipt.blockHash,
    });
    trustedHeader = verified.header;
    if (Number(BigInt(receipt.blockNumber)) > Number(verified.finalizedHeight)) {
      throw new Error('receipt block is not finalized');
    }
    chainState.ethereum.trustedBlockRoot = verified.nextTrustedBlockRoot;
    chainState.ethereum.finalizedHeight = Number(verified.finalizedHeight);
    chainState.ethereum.finalizedHash = verified.finalizedHash;
    saveChainState();
  } else {
    if (process.env.MERCURY_ALLOW_UNFINALIZED_EVM !== 'true') {
      throw new Error('syncCommitteeUpdate is required for finalized EVM verification');
    }
    trustedHeader = envelope.blockHeader;
  }
  if (!trustedHeader) throw new Error('trusted EVM header is unavailable');
  if (Number(trustedHeader.number) !== Number(BigInt(receipt.blockNumber))) throw new Error('receipt block number mismatch');
  if (!sameHex(trustedHeader.hash, receipt.blockHash)) throw new Error('receipt block hash mismatch');
  const receiptsRoot = trustedHeader.receiptsRoot || envelope.receiptsRoot;
  if (!receiptsRoot) throw new Error('trusted receipts root is unavailable');
  await verifyReceiptProof({
    receiptsRoot,
    transactionIndex: Number(BigInt(receipt.transactionIndex ?? receipt.index)),
    proof: envelope.receiptProof,
    expectedReceipt: receipt,
  });
  return { receipt, trustedHeader };
}

async function verifyEvmDeposit(request, proof) {
  const { receipt } = await verifyEvmReceiptEnvelope(proof, request.sourceChainID);
  const event = findEvent(receipt, SOURCE_EVENT, 'MercuryDepositCreated', request.sourceVault);
  const digest = mercuryRequestDigest(request);
  if (!sameHex(event.args.depositID, request.depositID)) throw new Error('deposit ID mismatch');
  if (!sameHex(event.args.owner, request.owner)) throw new Error('deposit owner mismatch');
  if (!sameHex(event.args.token, request.sourceAsset)) throw new Error('source asset mismatch');
  if (BigInt(event.args.amount) !== BigInt(request.sourceAmount)) throw new Error('source amount mismatch');
  if (!sameHex(event.args.requestHash, digest)) throw new Error('off-chain request is not bound to deposit');
  return { digest, txHash: receipt.transactionHash, blockNumber: Number(BigInt(receipt.blockNumber)) };
}

async function eosRpc(route, body) {
  const endpoint = process.env.EOS_RPC_URL || 'http://eos-nodeos:8888';
  const response = await fetch(`${endpoint}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.what || data?.message || `EOS RPC ${response.status}`);
  return data;
}

async function verifyEosExecution(confirmation, proof) {
  const info = await eosRpc('/v1/chain/get_info');
  const block = await eosRpc('/v1/chain/get_block', { block_num_or_id: Number(proof.blockNum) });
  if (Number(proof.blockNum) > Number(info.last_irreversible_block_num)) throw new Error('EOS transaction is not irreversible');
  if (proof.blockID && !sameHex(proof.blockID, block.id)) throw new Error('EOS block ID mismatch');
  const transaction = (block.transactions || []).find((item) => {
    const id = typeof item.trx === 'string' ? item.trx : item.trx?.id;
    return sameHex(id, proof.transactionID);
  });
  if (!transaction) throw new Error('EOS transaction is not included in irreversible block');
  if (!sameHex(bytes32(proof.transactionID), confirmation.targetTxID)) throw new Error('EOS target transaction mismatch');

  let data;
  const packedTransaction = typeof transaction.trx === 'object' ? transaction.trx : null;
  const actions = packedTransaction?.transaction?.actions || packedTransaction?.trx?.transaction?.actions || [];
  if (actions.length) {
    const endpoint = process.env.EOS_RPC_URL || 'http://eos-nodeos:8888';
    const api = new Api({
      rpc: new JsonRpc(endpoint, { fetch }),
      textDecoder: new TextDecoder(), textEncoder: new TextEncoder(),
    });
    const decodedActions = await api.deserializeActions(actions);
    data = decodedActions.find((item) => item.account === proof.contract && item.name === proof.action)?.data;
  }
  if (!data) {
    let trace;
    try {
      trace = await eosRpc('/v1/history/get_transaction', { id: proof.transactionID, block_num_hint: Number(proof.blockNum) });
    } catch (error) {
      if (process.env.MERCURY_EOS_ALLOW_PUSH_TRACE !== 'true') throw error;
      trace = proof.transactionTrace;
    }
    const actionTraces = trace?.traces || trace?.action_traces || trace?.processed?.action_traces || [];
    const action = actionTraces.find((item) => {
      const act = item.act || item.action_trace?.act;
      return act && act.account === proof.contract && act.name === proof.action;
    });
    if (!action) throw new Error('MERCURY EOS execution action not found');
    data = action.act?.data || action.action_trace?.act?.data || {};
  }
  const transfer = Array.isArray(data.transfers)
    ? data.transfers.find((item) => sameHex(bytes32(item.deposit_id || item.depositID), confirmation.depositID))
    : null;
  const depositID = data.deposit_id || data.depositID || transfer?.deposit_id || transfer?.depositID;
  if (!depositID || !sameHex(bytes32(depositID), confirmation.depositID)) throw new Error('EOS action deposit ID mismatch');
  return { blockNum: Number(proof.blockNum), blockID: block.id, transactionID: proof.transactionID };
}

async function verifyEvmTargetExecution(confirmation, proof) {
  const { receipt } = await verifyEvmReceiptEnvelope(proof, proof.targetChainID);
  if (!sameHex(bytes32(receipt.transactionHash), confirmation.targetTxID)) throw new Error('target transaction mismatch');
  const event = findEvent(receipt, TARGET_EVENT, 'MercuryTargetTransfer', proof.targetVault);
  if (!sameHex(event.args.depositID, confirmation.depositID)) throw new Error('target event deposit ID mismatch');
  return { transactionID: receipt.transactionHash, blockNumber: Number(BigInt(receipt.blockNumber)) };
}

async function verifyConfirmation(confirmation, proof) {
  if (!confirmation?.depositID || !confirmation?.targetTxID) throw new Error('invalid confirmation');
  const chainType = String(proof?.chainType || '').toLowerCase();
  if (chainType === 'eos') await verifyEosExecution(confirmation, proof);
  else if (chainType === 'evm' || chainType === 'ethereum') await verifyEvmTargetExecution(confirmation, proof);
  else throw new Error(`unsupported target proof chainType: ${chainType}`);
  return mercuryConfirmationDigest(confirmation);
}

function assertBatchMatchesRequests(batch) {
  if (!Array.isArray(batch.requests) || !Array.isArray(batch.transfers)) throw new Error('batch requests/transfers are required');
  if (batch.requests.length !== batch.transfers.length || batch.requests.length === 0) throw new Error('batch size mismatch');
  for (let i = 0; i < batch.requests.length; i += 1) {
    const request = batch.requests[i];
    const transfer = batch.transfers[i];
    if (!sameHex(request.depositID, transfer.depositID)) throw new Error('batch deposit mismatch');
    if (BigInt(request.targetAmount) !== BigInt(transfer.amount)) throw new Error('batch target amount mismatch');
    if (batch.targetType === 'evm') {
      if (!sameHex(request.targetAsset, transfer.token)) throw new Error('batch target token mismatch');
      if (!sameHex(request.targetAccount, transfer.receiver)) throw new Error('batch target receiver mismatch');
    } else {
      const precision = Number(request.targetPrecision || 4);
      const units = BigInt(request.targetAmount);
      const scale = 10n ** BigInt(precision);
      const expectedQuantity = `${units / scale}.${String(units % scale).padStart(precision, '0')} ${request.targetAsset}`;
      if (expectedQuantity !== String(transfer.quantity)) throw new Error('EOS target asset/amount mismatch');
      if (String(request.targetAccount) !== String(transfer.receiver)) throw new Error('EOS target receiver mismatch');
    }
  }
}

async function verifyBatch(batch, proofs) {
  assertBatchMatchesRequests(batch);
  if (!Array.isArray(proofs) || proofs.length !== batch.requests.length) throw new Error('one source proof per request is required');
  for (let i = 0; i < batch.requests.length; i += 1) await verifyEvmDeposit(batch.requests[i], proofs[i]);
  if (batch.targetType === 'evm') return mercuryEvmBatchDigest(batch);
  if (batch.targetType === 'eos') return mercuryEOSBatchDigest(batch);
  throw new Error(`unsupported targetType: ${batch.targetType}`);
}

async function verifyCheckpoint(checkpoint, proofs) {
  if (!Array.isArray(checkpoint.depositIDs) || checkpoint.depositIDs.length === 0) throw new Error('empty checkpoint');
  if (!Array.isArray(checkpoint.confirmations) || checkpoint.confirmations.length !== checkpoint.depositIDs.length) {
    throw new Error('checkpoint confirmations must match deposit IDs');
  }
  if (!Array.isArray(proofs) || proofs.length !== checkpoint.depositIDs.length) throw new Error('checkpoint proofs mismatch');
  for (let i = 0; i < checkpoint.depositIDs.length; i += 1) {
    if (!sameHex(checkpoint.depositIDs[i], checkpoint.confirmations[i].depositID)) throw new Error('checkpoint ID mismatch');
    await verifyConfirmation(checkpoint.confirmations[i], proofs[i]);
  }
  return mercuryCheckpointDigest(checkpoint);
}

async function verifyOperation(type, payload, proof) {
  if (type === 'transferBatch') return verifyBatch(payload, proof);
  if (type === 'confirmation') return verifyConfirmation(payload, proof);
  if (type === 'checkpoint') return verifyCheckpoint(payload, proof);
  throw new Error(`unsupported Mercury Raft operation: ${type}`);
}

const raft = createMercuryRaft({
  app,
  nodeID,
  runtimeDir,
  identity: { sign: signEntry },
  verifyOperation,
  buildQuorumCertificate: ({ signatures, signingDigest, term, index, threshold }) => buildQuorumCertificate({
    signatures,
    clusterID,
    epoch,
    threshold,
    signingDigest,
    signatureDigestType: 'mercuryDigest',
    term,
    index,
  }),
});

app.get('/health', (_req, res) => res.json({
  ok: true, address: wallet.address, eosPublicKey: eosPrivateKey.toPublic().toString(), ...raft.status(),
}));
app.get('/identity', async (_req, res, next) => {
  try { res.json(await identity()); } catch (error) { next(error); }
});
app.get('/raft/status', (_req, res) => res.json(raft.status()));

async function committedRoute(req, res, next, { route, type, payloadField, proofField, digest }) {
  try {
    const forwarded = await raft.ensureLeaderOrForward(route, req.body);
    if (forwarded) return res.status(forwarded.status).json(forwarded.body);
    const payload = req.body?.[payloadField];
    const proof = req.body?.[proofField];
    if (!payload) throw new Error(`${payloadField} is required`);
    const signingDigest = digest(payload);
    const result = await raft.commit(type, payload, proof, signingDigest, bytes32(payload.depositID || payload.batchID || payload.checkpointID));
    res.json({
      ok: true,
      signingDigest,
      certificate: result.certificate,
      eosSignatures: result.signatureDetails.map((item) => item.eosSignature).filter(Boolean),
      eosPublicKeys: result.signatureDetails.map((item) => item.eosPublicKey).filter(Boolean),
      raft: raft.status(),
    });
  } catch (error) { next(error); }
}

app.post('/prepare-transfer-batch', (req, res, next) => committedRoute(req, res, next, {
  route: '/prepare-transfer-batch', type: 'transferBatch', payloadField: 'batch', proofField: 'sourceProofs',
  digest: (batch) => batch.targetType === 'evm' ? mercuryEvmBatchDigest(batch) : mercuryEOSBatchDigest(batch),
}));

app.post('/confirm-transfer', (req, res, next) => committedRoute(req, res, next, {
  route: '/confirm-transfer', type: 'confirmation', payloadField: 'confirmation', proofField: 'targetProof',
  digest: mercuryConfirmationDigest,
}));

app.post('/sign-checkpoint', (req, res, next) => committedRoute(req, res, next, {
  route: '/sign-checkpoint', type: 'checkpoint', payloadField: 'checkpoint', proofField: 'targetProofs',
  digest: mercuryCheckpointDigest,
}));

app.use((error, _req, res, _next) => {
  console.error(`[${nodeID}]`, error.stack || error.message);
  res.status(400).json({ ok: false, nodeID, error: error.message || String(error) });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`MERCURY TEE ${nodeID} listening on ${PORT}; address=${wallet.address}`);
});
