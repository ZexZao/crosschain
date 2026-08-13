const express = require('express');
const { ethers } = require('ethers');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { readJSON, writeJSON, ensureRuntime } = require('../shared/utils');
const { loadDotEnv } = require('../shared/env');
const {
  ChainType,
  VerificationMethod,
  computeHXMsgDigest,
  computeHXMsgDeliveryDigest,
  computeResponseDigest,
  assertEnvelopeBindings,
  buildDeliveryMessage,
  verifyLifecycleCheckpoint,
} = require('../shared/hxmsg');
const { buildHXMsgBatch } = require('../shared/hxmsg/batch');
const { verifySourceFact } = require('./adapters');
const { verifyReceiptProof } = require('../shared/evm/receipt-proof');
const { maintainHeaderWindow } = require('./adapters/evm-melv-adapter');
const { verifyFabricExecutionView } = require('./adapters/fabric-hfsv-adapter');
const { buildSimulatedAttestationIdentity } = require('../shared/tee/attestation');
const { signCommittedDigest, buildQuorumCertificate } = require('../shared/tee/quorum-certificate');
const { clusterIDForSubnet, sourceChainTypeForProfile, subnetSigningDigest } = require('../shared/tee/domains');

loadDotEnv();
ensureRuntime();
const app = express();
app.use(express.json({ limit: process.env.TEE_HTTP_JSON_LIMIT || '16mb' }));

// ============ Chain State ============

const teeNodeID = process.env.TEE_NODE_ID || 'tee-verifier-1';
const teeSubnetID = process.env.TEE_SUBNET_ID || 'ethereum-proof-subnet';
const teeSubnetProfile = process.env.TEE_SUBNET_PROFILE || 'ethereum';
const teeStateFile = process.env.TEE_STATE_FILE || `tee-state-${teeNodeID}.json`;
const teeChainStateFile = process.env.TEE_CHAIN_STATE_FILE || `tee-chain-state-${teeNodeID}.json`;
const teeConsensusStateFile = process.env.TEE_CONSENSUS_STATE_FILE || `tee-consensus-${teeNodeID}.json`;
const raftAppendMaxBytes = Number(process.env.TEE_RAFT_APPEND_MAX_BYTES || 4 * 1024 * 1024);
const raftVerificationLeaseMs = Math.min(
  Math.max(Number(process.env.TEE_RAFT_VERIFICATION_LEASE_MS || 120000), 10000),
  300000
);
let chainState = readJSON(teeChainStateFile);
if (!chainState) {
  chainState = {
    fabric: { tipHeight: 0, tipHash: null, headers: [] },
    evm: { tipHeight: 0, tipHash: null, headers: [] },
    evmChains: {},
  };
}
chainState.evmChains = chainState.evmChains && typeof chainState.evmChains === 'object'
  ? chainState.evmChains
  : {};
if (chainState.evm?.chainID) {
  chainState.evmChains[chainState.evm.chainID] = chainState.evm;
}
writeJSON(teeChainStateFile, chainState);

function saveChainState() {
  writeJSON(teeChainStateFile, chainState);
}

let consensusState = readJSON(teeConsensusStateFile);
if (!consensusState) {
  consensusState = {
    currentTerm: Number(process.env.TEE_RAFT_TERM || 1),
    votedFor: null,
    role: 'follower',
    leaderID: null,
    commitIndex: 0,
    lastApplied: 0,
    log: [],
  };
  writeJSON(teeConsensusStateFile, consensusState);
} else {
  consensusState.currentTerm = Number(consensusState.currentTerm || process.env.TEE_RAFT_TERM || 1);
  consensusState.votedFor = consensusState.votedFor || null;
  consensusState.role = consensusState.role || 'follower';
  consensusState.leaderID = consensusState.leaderID || null;
  consensusState.commitIndex = Number(consensusState.commitIndex || 0);
  consensusState.lastApplied = Number(consensusState.lastApplied || 0);
  consensusState.log = Array.isArray(consensusState.log) ? consensusState.log : [];
  writeJSON(teeConsensusStateFile, consensusState);
}

function saveConsensusState() {
  writeJSON(teeConsensusStateFile, consensusState);
}

let lastHeartbeatAt = Date.now();
let electionDeadlineAt = Date.now() + electionTimeoutMs();
let verificationLeaseUntil = 0;
let activeVerificationLeases = 0;
const peerReplicationState = new Map();
let currentTermBarrierInFlight = null;
let raftReplicationInFlight = 0;

// ============ TEE Identity ============

let state = readJSON(teeStateFile);
const configuredKey = process.env.TEE_PRIVATE_KEY;
if (!state || (configuredKey && state.privateKey !== configuredKey)) {
  const wallet = configuredKey ? new ethers.Wallet(configuredKey) : ethers.Wallet.createRandom();
  state = { privateKey: wallet.privateKey, address: wallet.address };
  writeJSON(teeStateFile, state);
} else if (!state.privateKey && state.sessions?.default?.privateKey) {
  state = {
    privateKey: state.sessions.default.privateKey,
    address: state.sessions.default.address,
    sessions: state.sessions,
  };
  writeJSON(teeStateFile, state);
}

const CLUSTER_ID = process.env.TEE_CLUSTER_ID
  ? ethers.keccak256(ethers.toUtf8Bytes(process.env.TEE_CLUSTER_ID))
  : clusterIDForSubnet(teeSubnetID);
const SUBNET_SOURCE_CHAIN_TYPE = sourceChainTypeForProfile(teeSubnetProfile);
const SUBNET_EPOCH = Number(process.env.TEE_ATTESTATION_EPOCH || 1);

function parseNumberSet(text) {
  return new Set(String(text || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map(Number));
}

function defaultSupportedSourceChains(profile) {
  switch (String(profile || '').toLowerCase()) {
    case 'fabric':
      return new Set([ChainType.FABRIC]);
    case 'avalanche':
      return new Set([ChainType.AVALANCHE]);
    case 'ethereum':
    case 'evm':
    default:
      return new Set([ChainType.EVM]);
  }
}

function defaultSupportedVerificationMethods(profile) {
  switch (String(profile || '').toLowerCase()) {
    case 'fabric':
      return new Set([VerificationMethod.H_FSV, VerificationMethod.FABRIC_TX_STATUS]);
    case 'avalanche':
      return new Set([VerificationMethod.AVALANCHE_ICM_BLS]);
    case 'ethereum':
    case 'evm':
    default:
      return new Set([VerificationMethod.EVM_EVENT, VerificationMethod.EVM_RECEIPT, VerificationMethod.EVM_LIGHT_CLIENT]);
  }
}

const supportedSourceChains = process.env.TEE_SUPPORTED_SOURCE_CHAINS
  ? parseNumberSet(process.env.TEE_SUPPORTED_SOURCE_CHAINS)
  : defaultSupportedSourceChains(teeSubnetProfile);
const supportedVerificationMethods = process.env.TEE_SUPPORTED_VERIFICATION_METHODS
  ? parseNumberSet(process.env.TEE_SUPPORTED_VERIFICATION_METHODS)
  : defaultSupportedVerificationMethods(teeSubnetProfile);

function assertSubnetCanVerify(hxmsg) {
  const sourceChainType = Number(hxmsg.source?.chainType);
  const verificationMethod = Number(hxmsg.verification?.verificationMethod);
  if (!supportedSourceChains.has(sourceChainType)) {
    throw new Error(`TEE subnet ${teeSubnetID} (${teeSubnetProfile}) cannot verify source chainType=${sourceChainType}`);
  }
  if (!supportedVerificationMethods.has(verificationMethod)) {
    throw new Error(`TEE subnet ${teeSubnetID} (${teeSubnetProfile}) cannot verify verificationMethod=${verificationMethod}`);
  }
}

function assertSubnetSourceScope(sourceChainType, sourceChainID) {
  if (Number(sourceChainType) !== SUBNET_SOURCE_CHAIN_TYPE) {
    throw new Error(`TEE subnet ${teeSubnetID} is not authorized for source chainType=${sourceChainType}`);
  }
  if (!sourceChainID || sameHex(sourceChainID, ethers.ZeroHash)) {
    throw new Error('sourceChainID is required for subnet-scoped certification');
  }
}

async function currentTEEIdentity() {
  return buildSimulatedAttestationIdentity({
    privateKey: state.privateKey,
    nodeID: teeNodeID,
    subnetID: teeSubnetID,
    subnetProfile: teeSubnetProfile,
    epoch: Number(process.env.TEE_ATTESTATION_EPOCH || 1),
  });
}

function clusterPeers() {
  return String(process.env.TEE_CLUSTER_PEERS || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function peerIDFromURL(peerURL) {
  try {
    const host = new URL(peerURL).hostname;
    return host === 'tee-verifier' ? 'tee-verifier-1' : host;
  } catch (_error) {
    return peerURL;
  }
}

function clusterPeerDefs() {
  return clusterPeers().map((url) => ({ id: peerIDFromURL(url), url: url.replace(/\/$/, '') }));
}

function knownRaftNodeIDs() {
  return new Set([teeNodeID, ...clusterPeerDefs().map((peer) => peer.id)]);
}

function raftSharedSecret() {
  return process.env.TEE_RAFT_SHARED_SECRET || '';
}

function raftAuthRequired() {
  return clusterPeers().length > 0 && process.env.TEE_RAFT_AUTH_REQUIRED !== 'false';
}

function stableStringify(value) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item) ?? 'null').join(',')}]`;
  }
  return `{${Object.keys(value)
    .filter((key) => stableStringify(value[key]) !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',')}}`;
}

function raftSignaturePayload({ subnetID, senderID, timestamp, method, routePath, body }) {
  return [
    subnetID,
    senderID,
    String(timestamp),
    String(method || 'POST').toUpperCase(),
    routePath,
    stableStringify(body || {}),
  ].join('\n');
}

function signRaftRequest({ routePath, body }) {
  const secret = raftSharedSecret();
  if (!secret) return {};
  const timestamp = Date.now();
  const payload = raftSignaturePayload({
    subnetID: teeSubnetID,
    senderID: teeNodeID,
    timestamp,
    method: 'POST',
    routePath,
    body,
  });
  return {
    'x-tee-node-id': teeNodeID,
    'x-tee-subnet-id': teeSubnetID,
    'x-tee-raft-ts': String(timestamp),
    'x-tee-raft-signature': crypto.createHmac('sha256', secret).update(payload).digest('hex'),
  };
}

function verifyRaftRequest(req, res, next) {
  if (!req.path.startsWith('/internal/raft/')) {
    next();
    return;
  }
  try {
    if (!raftAuthRequired()) {
      next();
      return;
    }
    const secret = raftSharedSecret();
    if (!secret) throw new Error('TEE_RAFT_SHARED_SECRET is required for Raft internal RPC');
    const senderID = String(req.get('x-tee-node-id') || '');
    const subnetID = String(req.get('x-tee-subnet-id') || '');
    const timestamp = Number(req.get('x-tee-raft-ts') || 0);
    const signature = String(req.get('x-tee-raft-signature') || '');
    if (!knownRaftNodeIDs().has(senderID) || senderID === teeNodeID) {
      throw new Error('invalid Raft sender');
    }
    if (subnetID !== teeSubnetID) throw new Error('cross-subnet Raft request rejected');
    if (!timestamp || Math.abs(Date.now() - timestamp) > 30000) {
      throw new Error('stale Raft RPC timestamp');
    }
    const payload = raftSignaturePayload({
      subnetID,
      senderID,
      timestamp,
      method: req.method,
      routePath: req.path,
      body: req.body,
    });
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const left = Buffer.from(signature, 'hex');
    const right = Buffer.from(expected, 'hex');
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      throw new Error('invalid Raft RPC signature');
    }
    req.raftSenderID = senderID;
    next();
  } catch (error) {
    res.status(401).json({ nodeID: teeNodeID, error: error.message });
  }
}

app.use(verifyRaftRequest);

function clusterSize() {
  return clusterPeers().length + 1;
}

function clusterThreshold() {
  return Number(process.env.TEE_CLUSTER_THRESHOLD || Math.floor(clusterSize() / 2) + 1);
}

function raftMajority() {
  return Math.floor(clusterSize() / 2) + 1;
}

function lastLogIndex() {
  return consensusState.log.length ? Number(consensusState.log[consensusState.log.length - 1].index || 0) : 0;
}

function lastLogTerm() {
  return consensusState.log.length ? Number(consensusState.log[consensusState.log.length - 1].term || 0) : 0;
}

function logEntryAt(index) {
  return consensusState.log.find((entry) => Number(entry.index) === Number(index)) || null;
}

function isCandidateLogUpToDate(candidateLastIndex, candidateLastTerm) {
  const localLastTerm = lastLogTerm();
  if (Number(candidateLastTerm) !== localLastTerm) return Number(candidateLastTerm) > localLastTerm;
  return Number(candidateLastIndex) >= lastLogIndex();
}

function stepDown(term, leaderID = null) {
  lastHeartbeatAt = Date.now();
  electionDeadlineAt = Math.max(Date.now() + electionTimeoutMs(), verificationLeaseUntil);
  if (Number(term) > Number(consensusState.currentTerm || 0)) {
    consensusState.currentTerm = Number(term);
    consensusState.votedFor = null;
  }
  consensusState.role = 'follower';
  consensusState.leaderID = leaderID;
  saveConsensusState();
}

function becomeLeader() {
  consensusState.role = 'leader';
  consensusState.leaderID = teeNodeID;
  peerReplicationState.clear();
  initializePeerReplicationState();
  saveConsensusState();
}

function becomeCandidate() {
  consensusState.role = 'candidate';
  consensusState.currentTerm = Number(consensusState.currentTerm || 0) + 1;
  consensusState.votedFor = teeNodeID;
  consensusState.leaderID = null;
  electionDeadlineAt = Date.now() + electionTimeoutMs();
  saveConsensusState();
}

function subjectDigestForHXMsg(hxmsg) {
  return [ChainType.EVM, ChainType.AVALANCHE].includes(Number(hxmsg.target?.chainType))
    ? computeHXMsgDeliveryDigest(hxmsg)
    : (hxmsg.hmsgDigest || computeHXMsgDigest(hxmsg));
}

function scopedSigningDigest(subjectDigest, sourceChainType, sourceChainID) {
  return subnetSigningDigest({
    clusterID: CLUSTER_ID,
    epoch: SUBNET_EPOCH,
    sourceChainType,
    sourceChainID,
    subjectDigest,
  });
}

function normalizeAttestationInput(body = {}) {
  const envelope = body.hxmsg?.hxmsg ? body.hxmsg : body.hxmsg?.hxmsgEnvelope;
  const hxmsg = body.hxmsg?.hxmsg || body.hxmsg;
  const sourceEvidence = envelope?.sourceEvidence || body.sourceEvidence || {};
  const proofHelper = sourceEvidence.helperData || sourceEvidence.proof || {};
  return {
    hxmsg,
    helperData: {
      ...proofHelper,
      ...(body.helperData || body.blockData || {}),
    },
  };
}

function makeConsensusEntry({ hxmsg, helperData, proposerID }) {
  const hmsgDigest = hxmsg.hmsgDigest || computeHXMsgDigest(hxmsg);
  hxmsg.hmsgDigest = hmsgDigest;
  const index = lastLogIndex() + 1;
  const term = Number(consensusState.currentTerm || 1);
  const subjectDigest = subjectDigestForHXMsg(hxmsg);
  const signingDigest = scopedSigningDigest(subjectDigest, hxmsg.source.chainType, hxmsg.source.chainID);
  const signatureDigestType = Number(hxmsg.target?.chainType) === ChainType.EVM ? 'deliveryDigest' : 'hmsgDigest';
  const entryDigest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint64', 'uint64', 'bytes32', 'bytes32', 'bytes32', 'string'],
      [term, index, hxmsg.header.requestID, subjectDigest, signingDigest, signatureDigestType]
    )
  );
  return {
    index,
    term,
    proposerID,
    requestID: hxmsg.header.requestID,
    hmsgDigest,
    subjectDigest,
    signingDigest,
    signatureDigestType,
    sourceChainType: Number(hxmsg.source?.chainType),
    sourceChainID: hxmsg.source?.chainID,
    targetChainType: Number(hxmsg.target?.chainType),
    entryDigest,
    status: 'pending',
    hxmsg,
    helperData: helperData || {},
    createdAt: Math.floor(Date.now() / 1000),
  };
}

function makeDigestConsensusEntry({ requestID, digest, response, checkpoint, helperData, proposerID,
  sourceChainType, sourceChainID, signatureDigestType = 'responseDigest' }) {
  const index = lastLogIndex() + 1;
  const term = Number(consensusState.currentTerm || 1);
  const entryDigest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint64', 'uint64', 'bytes32', 'bytes32', 'string'],
      [term, index, requestID, scopedSigningDigest(digest, sourceChainType, sourceChainID), signatureDigestType]
    )
  );
  return {
    index,
    term,
    proposerID,
    requestID,
    hmsgDigest: digest,
    subjectDigest: digest,
    signingDigest: scopedSigningDigest(digest, sourceChainType, sourceChainID),
    sourceChainType: Number(sourceChainType),
    sourceChainID,
    signatureDigestType,
    entryDigest,
    status: 'pending',
    response,
    checkpoint,
    helperData: helperData || {},
    createdAt: Math.floor(Date.now() / 1000),
  };
}

function makeBatchConsensusEntry({ batch, proposerID }) {
  const sourceChainType = Number(batch.hxmsgs[0].source.chainType);
  const sourceChainID = batch.hxmsgs[0].source.chainID;
  const signingDigest = scopedSigningDigest(batch.batchSigningDigest, sourceChainType, sourceChainID);
  const reusable = consensusState.log.find((item) => (
    Number(item.term) === Number(consensusState.currentTerm || 1)
    && sameHex(item.requestID, batch.batchID)
    && sameHex(item.signingDigest, signingDigest)
  ));
  if (reusable) return reusable;
  const index = lastLogIndex() + 1;
  const term = Number(consensusState.currentTerm || 1);
  const signatureDigestType = 'batchDigest';
  const entryDigest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint64', 'uint64', 'bytes32', 'bytes32', 'string'],
      [term, index, batch.batchID, signingDigest, signatureDigestType]
    )
  );
  return {
    index,
    term,
    proposerID,
    requestID: batch.batchID,
    hmsgDigest: batch.batchSigningDigest,
    subjectDigest: batch.batchSigningDigest,
    signingDigest,
    sourceChainType,
    sourceChainID,
    signatureDigestType,
    entryDigest,
    status: 'pending',
    batch,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

function makeNoopConsensusEntry({ proposerID, reason = 'leader-current-term-barrier' } = {}) {
  const index = lastLogIndex() + 1;
  const term = Number(consensusState.currentTerm || 1);
  const requestID = ethers.ZeroHash;
  const digest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['string', 'string', 'uint64', 'uint64'],
      ['HXMSG_RAFT_NOOP_V1', reason, term, index]
    )
  );
  const entryDigest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint64', 'uint64', 'bytes32', 'bytes32', 'string'],
      [term, index, requestID, digest, 'noop']
    )
  );
  return {
    index,
    term,
    proposerID,
    requestID,
    hmsgDigest: digest,
    signingDigest: digest,
    signatureDigestType: 'noop',
    entryDigest,
    status: 'pending',
    noop: true,
    reason,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

function appendConsensusEntry(entry) {
  const existing = consensusState.log.find((item) => item.entryDigest === entry.entryDigest);
  if (existing) return existing;
  const prevIndex = Number(entry.index || 0) - 1;
  if (prevIndex > 0 && !logEntryAt(prevIndex)) {
    throw new Error(`cannot append non-contiguous Raft entry ${entry.index}; missing ${prevIndex}`);
  }
  const conflict = logEntryAt(entry.index);
  if (conflict && (Number(conflict.term) !== Number(entry.term) || conflict.entryDigest !== entry.entryDigest)) {
    consensusState.log = consensusState.log.filter((item) => Number(item.index) < Number(entry.index));
  }
  consensusState.currentTerm = Math.max(Number(consensusState.currentTerm || 0), Number(entry.term || 0));
  consensusState.log.push({ ...entry, status: entry.status || 'pending' });
  consensusState.log.sort((a, b) => Number(a.index) - Number(b.index));
  saveConsensusState();
  return entry;
}

function commitConsensusEntry(entryDigest) {
  const entry = consensusState.log.find((item) => item.entryDigest === entryDigest);
  if (!entry) throw new Error(`consensus entry not found: ${entryDigest}`);
  if (Number(entry.term) !== Number(consensusState.currentTerm)) {
    throw new Error('leader can only directly commit entries from its current term');
  }
  entry.status = 'committed';
  entry.committedAt = Math.floor(Date.now() / 1000);
  consensusState.commitIndex = Math.max(Number(consensusState.commitIndex || 0), Number(entry.index || 0));
  consensusState.lastApplied = consensusState.commitIndex;
  for (const item of consensusState.log) {
    if (Number(item.index) <= consensusState.commitIndex) {
      item.status = 'committed';
      item.committedAt = item.committedAt || entry.committedAt;
    }
  }
  saveConsensusState();
  pruneRedundantPendingEntries();
  return entry;
}

function pruneRedundantPendingEntries() {
  const committedKeys = new Set(consensusState.log
    .filter((entry) => entry.status === 'committed')
    .map((entry) => `${String(entry.requestID).toLowerCase()}:${String(entry.signingDigest).toLowerCase()}`));
  const pendingSuffix = consensusState.log.filter((entry) => Number(entry.index) > Number(consensusState.commitIndex));
  const entirelyRedundant = pendingSuffix.length > 0 && pendingSuffix.every((entry) => {
    const key = `${String(entry.requestID).toLowerCase()}:${String(entry.signingDigest).toLowerCase()}`;
    return committedKeys.has(key);
  });
  if (!entirelyRedundant) return 0;
  const removed = pendingSuffix.length;
  consensusState.log = consensusState.log.filter((entry) => Number(entry.index) <= Number(consensusState.commitIndex));
  peerReplicationState.clear();
  saveConsensusState();
  return removed;
}

pruneRedundantPendingEntries();

function hasCommittedEntryInCurrentTerm() {
  return consensusState.log.some((entry) => (
    Number(entry.term) === Number(consensusState.currentTerm)
    && Number(entry.index) <= Number(consensusState.commitIndex || 0)
    && entry.status === 'committed'
  ));
}

function assertEntryMatchesHXMsg(entry, hxmsg) {
  const hmsgDigest = hxmsg.hmsgDigest || computeHXMsgDigest(hxmsg);
  const subjectDigest = subjectDigestForHXMsg(hxmsg);
  const signingDigest = scopedSigningDigest(subjectDigest, hxmsg.source.chainType, hxmsg.source.chainID);
  if (entry.requestID !== hxmsg.header.requestID) throw new Error('consensus request mismatch');
  if (String(entry.hmsgDigest).toLowerCase() !== String(hmsgDigest).toLowerCase()) throw new Error('consensus hmsgDigest mismatch');
  if (String(entry.signingDigest).toLowerCase() !== String(signingDigest).toLowerCase()) throw new Error('consensus signingDigest mismatch');
  const expectedEntryDigest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint64', 'uint64', 'bytes32', 'bytes32', 'bytes32', 'string'],
      [Number(entry.term), Number(entry.index), entry.requestID, subjectDigest, entry.signingDigest, entry.signatureDigestType]
    )
  );
  if (String(entry.entryDigest).toLowerCase() !== expectedEntryDigest.toLowerCase()) {
    throw new Error('consensus entry digest mismatch');
  }
}

function assertEntryMatchesDigest(entry, requestID, digest, sourceChainType, sourceChainID) {
  if (entry.requestID !== requestID) throw new Error('consensus request mismatch');
  if (String(entry.hmsgDigest).toLowerCase() !== String(digest).toLowerCase()) {
    throw new Error('consensus digest mismatch');
  }
  const signingDigest = scopedSigningDigest(digest, sourceChainType, sourceChainID);
  if (String(entry.signingDigest).toLowerCase() !== String(signingDigest).toLowerCase()) {
    throw new Error('consensus signing digest mismatch');
  }
  const expectedEntryDigest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint64', 'uint64', 'bytes32', 'bytes32', 'string'],
      [Number(entry.term), Number(entry.index), requestID, signingDigest, entry.signatureDigestType]
    )
  );
  if (String(entry.entryDigest).toLowerCase() !== expectedEntryDigest.toLowerCase()) {
    throw new Error('consensus entry digest mismatch');
  }
}

function assertEntryMatchesBatch(entry, batch) {
  const rebuilt = buildHXMsgBatch(batch.hxmsgs);
  if (!sameHex(rebuilt.batchID, batch.batchID)) throw new Error('batchID mismatch');
  if (!sameHex(rebuilt.batchRoot, batch.batchRoot)) throw new Error('batchRoot mismatch');
  if (!sameHex(rebuilt.batchSigningDigest, batch.batchSigningDigest)) throw new Error('batchSigningDigest mismatch');
  if (!sameHex(entry.requestID, batch.batchID)) throw new Error('consensus batch request mismatch');
  if (!sameHex(entry.hmsgDigest, batch.batchSigningDigest)) throw new Error('consensus batch digest mismatch');
  const signingDigest = scopedSigningDigest(
    batch.batchSigningDigest,
    batch.hxmsgs[0].source.chainType,
    batch.hxmsgs[0].source.chainID
  );
  if (!sameHex(entry.signingDigest, signingDigest)) throw new Error('consensus batch signing digest mismatch');
  const expectedEntryDigest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint64', 'uint64', 'bytes32', 'bytes32', 'string'],
      [Number(entry.term), Number(entry.index), batch.batchID, signingDigest, entry.signatureDigestType]
    )
  );
  if (!sameHex(entry.entryDigest, expectedEntryDigest)) throw new Error('consensus batch entry digest mismatch');
  return rebuilt;
}

function sameHex(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

async function verifyResponseFactLocally({ response, helperData = {} }) {
  if (!response) throw new Error('response is required');
  const responseDigest = computeResponseDigest(response);
  const originHxmsg = helperData.originHxmsg;
  if (originHxmsg) {
    const originDigest = originHxmsg.hmsgDigest || computeHXMsgDigest(originHxmsg);
    if (!sameHex(originDigest, response.originHmsgDigest)) throw new Error('response originHmsgDigest mismatch');
    if (!sameHex(originHxmsg.header.requestID, response.originRequestID)) throw new Error('response originRequestID mismatch');
    const originTargetExecutionHash = (originHxmsg.deliveryMessage || buildDeliveryMessage(originHxmsg)).targetExecutionHash;
    if (!sameHex(originTargetExecutionHash, response.targetExecutionHash)) {
      throw new Error('response targetExecutionHash mismatch');
    }
  }
  if (Number(response.responseStatus) !== 1) throw new Error('only EXECUTED responses are currently supported');

  if (helperData.evmExecutionReceipt) {
    const proofEnvelope = helperData.evmExecutionReceipt;
    const receipt = proofEnvelope.receipt || proofEnvelope;
    if (!proofEnvelope.receiptProof || !proofEnvelope.blockHeader) {
      throw new Error('EVM execution receipt proof is required');
    }
    const provider = new ethers.JsonRpcProvider(helperData.evmRpc || process.env.EVM_RPC || 'http://evm-node:8545');
    const storedHeader = await maintainHeaderWindow({
      provider,
      chainState,
      targetBlockNumber: Number(receipt.blockNumber),
      targetBlockHash: receipt.blockHash,
      committeeHeaderUpdate: helperData.committeeHeaderUpdate || proofEnvelope.committeeHeaderUpdate,
      expectedChainID: helperData.evmChainID || `eip155:${Number(process.env.EVM_CHAIN_ID || 31337)}`,
    });
    await verifyReceiptProof({
      receiptsRoot: storedHeader.receiptsRoot,
      transactionIndex: Number(receipt.transactionIndex ?? receipt.index),
      proof: proofEnvelope.receiptProof,
      expectedReceipt: receipt,
    });
    saveChainState();
    if (Number(receipt.status) !== 1) throw new Error('EVM target execution receipt failed');
    const eventTopic = ethers.id('HXMsgAccepted(bytes32,bytes32,address)');
    const accepted = (receipt.logs || []).find((log) => {
      if (!sameHex((log.topics || [])[0], eventTopic)) return false;
      return sameHex((log.topics || [])[1], response.originRequestID);
    });
    if (!accepted) throw new Error('EVM HXMsgAccepted log for response origin not found');
    const proofRef = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'uint64', 'bytes32'],
        [receipt.transactionHash || receipt.hash, Number(receipt.blockNumber), receipt.blockHash]
      )
    );
    if (!sameHex(response.targetProofRefHash, proofRef)) throw new Error('response targetProofRefHash mismatch');
  } else if (helperData.fabricExecutionView || helperData.fabricChannelID || helperData.fabricChaincodeName) {
    await verifyFabricExecutionView({ response, helperData });
  } else {
    throw new Error('response target execution proof is required');
  }

  return {
    adapter: 'response-proof',
    verified: true,
    responseDigest,
    originRequestID: response.originRequestID,
    responseStatus: response.responseStatus,
  };
}

async function verifyHXMsgLocally({ hxmsg, helperData, enforceExpiry = true }) {
  assertEnvelopeBindings(hxmsg);
  hxmsg.hmsgDigest = hxmsg.hmsgDigest || computeHXMsgDigest(hxmsg);
  if (hxmsg.header.deliveryExpireAt === undefined) throw new Error('canonical header.deliveryExpireAt is required');
  if (enforceExpiry && Number(hxmsg.header.deliveryExpireAt) < Math.floor(Date.now() / 1000)) {
    throw new Error('h-xmsg expired');
  }
  assertSubnetCanVerify(hxmsg);
  const verificationResult = await verifySourceFact({
    hxmsg,
    helperData,
    chainState,
    saveChainState,
  });
  return { verificationResult };
}

async function verifyBatchLocally({ batch, enforceExpiry = true }) {
  if (!batch || !Array.isArray(batch.hxmsgs) || !Array.isArray(batch.helperDataList)) {
    throw new Error('batch.hxmsgs and batch.helperDataList are required');
  }
  if (batch.hxmsgs.length === 0) throw new Error('empty h-xmsg batch');
  if (batch.hxmsgs.length !== batch.helperDataList.length) throw new Error('batch helperData count mismatch');
  const rebuilt = buildHXMsgBatch(batch.hxmsgs);
  if (!sameHex(rebuilt.batchID, batch.batchID)) throw new Error('batchID mismatch');
  if (!sameHex(rebuilt.batchRoot, batch.batchRoot)) throw new Error('batchRoot mismatch');
  if (!sameHex(rebuilt.batchSigningDigest, batch.batchSigningDigest)) throw new Error('batchSigningDigest mismatch');
  const verificationResults = [];
  for (let i = 0; i < batch.hxmsgs.length; i += 1) {
    const local = await verifyHXMsgLocally({
      hxmsg: batch.hxmsgs[i],
      helperData: batch.helperDataList[i] || {},
      enforceExpiry,
    });
    verificationResults.push({
      index: i,
      requestID: batch.hxmsgs[i].header.requestID,
      ...local.verificationResult,
    });
  }
  return { rebuilt, verificationResults };
}

function verifyCheckpointLocally(checkpointEnvelope) {
  if (!checkpointEnvelope?.checkpoint || !Array.isArray(checkpointEnvelope.records)) {
    throw new Error('checkpoint metadata and records are required');
  }
  const verified = verifyLifecycleCheckpoint(checkpointEnvelope.checkpoint, checkpointEnvelope.records);
  return {
    adapter: 'lifecycle-checkpoint',
    verified: true,
    ...verified,
    recordCount: checkpointEnvelope.records.length,
  };
}

async function buildCommittedSignature({ hxmsg, requestID, digest, entry }) {
  const committedEntry = consensusState.log.find((item) => item.entryDigest === entry.entryDigest);
  if (!committedEntry || committedEntry.status !== 'committed') {
    throw new Error('cannot sign before consensus commit');
  }
  if (hxmsg) {
    assertEntryMatchesHXMsg(committedEntry, hxmsg);
  } else if (committedEntry.batch) {
    assertEntryMatchesBatch(committedEntry, committedEntry.batch);
  } else {
    assertEntryMatchesDigest(
      committedEntry,
      requestID,
      digest,
      committedEntry.sourceChainType,
      committedEntry.sourceChainID
    );
  }
  const identity = await currentTEEIdentity();
  return signCommittedDigest({
    privateKey: state.privateKey,
    nodeID: teeNodeID,
    identity,
    committedEntry,
  });
}

async function startElection() {
  becomeCandidate();
  let votes = 1;
  const voteResponses = [{ nodeID: teeNodeID, voteGranted: true, term: consensusState.currentTerm }];
  const request = {
    term: consensusState.currentTerm,
    candidateID: teeNodeID,
    lastLogIndex: lastLogIndex(),
    lastLogTerm: lastLogTerm(),
  };
  await Promise.all(clusterPeerDefs().map(async (peer) => {
    try {
      const resp = await fetch(`${peer.url}/internal/raft/request-vote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...signRaftRequest({ routePath: '/internal/raft/request-vote', body: request }) },
        body: JSON.stringify(request),
      });
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      const data = await resp.json();
      voteResponses.push({ nodeID: data.nodeID || peer.id, voteGranted: Boolean(data.voteGranted), term: data.term });
      if (Number(data.term || 0) > Number(consensusState.currentTerm)) {
        stepDown(Number(data.term));
        return;
      }
      if (data.voteGranted) votes += 1;
    } catch (error) {
      voteResponses.push({ nodeID: peer.id, voteGranted: false, error: error.message });
    }
  }));
  if (votes >= raftMajority() && consensusState.role === 'candidate') {
    becomeLeader();
    return { elected: true, votes, voteResponses };
  }
  consensusState.role = 'follower';
  saveConsensusState();
  return { elected: false, votes, voteResponses };
}

async function ensureRaftLeaderOrForward(originalBody, routePath = '/attest') {
  if (consensusState.role === 'leader') return { localLeader: true };
  const leader = consensusState.leaderID
    ? clusterPeerDefs().find((peer) => peer.id === consensusState.leaderID)
    : null;
  if (leader) {
    const resp = await fetch(`${leader.url}${routePath}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(originalBody),
    });
    const body = await resp.json();
    return { localLeader: false, status: resp.status, body };
  }
  const election = await startElection();
  if (election.elected) return { localLeader: true, election };
  throw new Error(`Raft leader unavailable: election votes ${election.votes}/${raftMajority()}`);
}

function makeAppendEntriesPayload({ entries, leaderCommit }) {
  const firstIndex = entries.length ? Number(entries[0].index) : lastLogIndex() + 1;
  const prevLogIndex = firstIndex - 1;
  const prevEntry = prevLogIndex > 0 ? logEntryAt(prevLogIndex) : null;
  return {
    term: consensusState.currentTerm,
    leaderID: teeNodeID,
    prevLogIndex,
    prevLogTerm: prevEntry ? Number(prevEntry.term) : 0,
    entries,
    leaderCommit,
  };
}

function makeCommitNotificationPayload(committedEntry) {
  return {
    term: consensusState.currentTerm,
    leaderID: teeNodeID,
    prevLogIndex: Number(committedEntry.index),
    prevLogTerm: Number(committedEntry.term),
    entries: [],
    leaderCommit: Number(committedEntry.index),
  };
}

function initializePeerReplicationState() {
  for (const peer of clusterPeerDefs()) {
    if (!peerReplicationState.has(peer.id)) {
      peerReplicationState.set(peer.id, { nextIndex: lastLogIndex() + 1, matchIndex: 0 });
    }
  }
}

function makeAppendEntriesPayloadFromIndex({ nextIndex, leaderCommit, targetIndex = lastLogIndex() }) {
  const prevLogIndex = Math.max(Number(nextIndex || 1) - 1, 0);
  const prevEntry = prevLogIndex > 0 ? logEntryAt(prevLogIndex) : null;
  const candidates = consensusState.log
    .filter((item) => Number(item.index) >= Number(nextIndex || 1)
      && Number(item.index) <= Number(targetIndex))
    .map((item) => ({ ...item }));
  const entries = [];
  let encodedBytes = 0;
  for (const item of candidates) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item));
    if (entries.length > 0 && encodedBytes + itemBytes > raftAppendMaxBytes) break;
    entries.push(item);
    encodedBytes += itemBytes;
  }
  return {
    term: consensusState.currentTerm,
    leaderID: teeNodeID,
    prevLogIndex,
    prevLogTerm: prevEntry ? Number(prevEntry.term) : 0,
    entries,
    leaderCommit,
  };
}

async function sendRaftPost(peer, routePath, body) {
  const resp = await fetch(`${peer.url}${routePath}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      connection: 'close',
      ...signRaftRequest({ routePath, body }),
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`status ${resp.status}`);
  const data = await resp.json();
  return data;
}

async function grantVerificationLease() {
  if (clusterPeers().length === 0) return { granted: 1, leaseUntil: Date.now() + raftVerificationLeaseMs };
  if (consensusState.role !== 'leader') throw new Error('verification lease requires leader role');

  const term = Number(consensusState.currentTerm);
  const leaseUntil = Date.now() + raftVerificationLeaseMs;
  const acknowledgements = [{ nodeID: teeNodeID, granted: true }];
  await Promise.all(clusterPeerDefs().map(async (peer) => {
    try {
      const data = await sendRaftPost(peer, '/internal/raft/verification-lease', {
        term,
        leaderID: teeNodeID,
        leaseUntil,
      });
      if (Number(data.term || 0) > Number(consensusState.currentTerm)) {
        stepDown(Number(data.term), data.leaderID || null);
      }
      acknowledgements.push({
        nodeID: data.nodeID || peer.id,
        granted: Boolean(data.granted),
        term: data.term,
      });
    } catch (error) {
      acknowledgements.push({ nodeID: peer.id, granted: false, error: error.message });
    }
  }));
  const granted = acknowledgements.filter((item) => item.granted).length;
  if (consensusState.role !== 'leader' || Number(consensusState.currentTerm) !== term) {
    throw new Error('leadership changed while granting verification lease');
  }
  if (granted < raftMajority()) {
    throw new Error(`verification lease quorum not reached: ${granted}/${raftMajority()}`);
  }
  verificationLeaseUntil = leaseUntil;
  return { granted, leaseUntil, acknowledgements };
}

async function acquireVerificationLease() {
  const lease = await grantVerificationLease();
  activeVerificationLeases += 1;
  return lease;
}

async function releaseVerificationLease() {
  activeVerificationLeases = Math.max(activeVerificationLeases - 1, 0);
  if (activeVerificationLeases > 0 || consensusState.role !== 'leader') return;
  verificationLeaseUntil = 0;
  const body = { term: Number(consensusState.currentTerm), leaderID: teeNodeID };
  await Promise.all(clusterPeerDefs().map(async (peer) => {
    try {
      await sendRaftPost(peer, '/internal/raft/verification-lease-release', body);
    } catch (_error) {
      // A disconnected follower retains only the bounded lease granted earlier.
    }
  }));
}

async function sendAppendEntries(peer, payload) {
  const data = await sendRaftPost(peer, '/internal/raft/append-entries', payload);
  if (Number(data.term || 0) > Number(consensusState.currentTerm)) {
    stepDown(Number(data.term), data.leaderID || null);
  }
  return data;
}

async function replicateLogToPeer(peer, targetIndex) {
  initializePeerReplicationState();
  const progress = peerReplicationState.get(peer.id) || { nextIndex: 1, matchIndex: 0 };
  if (Number(progress.matchIndex || 0) >= Number(targetIndex)) {
    return {
      nodeID: peer.id,
      peerURL: peer.url,
      accepted: true,
      matchIndex: progress.matchIndex,
      attempts: 0,
    };
  }
  let attempts = 0;
  while (Number(progress.matchIndex || 0) < Number(targetIndex) && attempts < Math.max(lastLogIndex() + 2, 4)) {
    attempts += 1;
    const payload = makeAppendEntriesPayloadFromIndex({
      nextIndex: Math.max(Number(progress.nextIndex || 1), 1),
      leaderCommit: consensusState.commitIndex,
      targetIndex,
    });
    const data = await sendAppendEntries(peer, payload);
    if (Number(data.term || 0) > Number(consensusState.currentTerm)) {
      return {
        nodeID: data.nodeID || peer.id,
        peerURL: peer.url,
        accepted: false,
        matchIndex: data.matchIndex,
        error: 'stepped down for newer term',
      };
    }
    if (data.success) {
      progress.matchIndex = Number(data.matchIndex || payload.prevLogIndex);
      progress.nextIndex = progress.matchIndex + 1;
      peerReplicationState.set(peer.id, progress);
      if (progress.matchIndex >= Number(targetIndex)) {
        return {
          nodeID: data.nodeID || peer.id,
          peerURL: peer.url,
          accepted: true,
          matchIndex: progress.matchIndex,
          attempts,
        };
      }
      continue;
    }
    const conflictIndex = Number(data.conflictIndex || data.matchIndex || 1);
    progress.nextIndex = Math.max(Math.min(Number(progress.nextIndex || 1) - 1, conflictIndex), 1);
    peerReplicationState.set(peer.id, progress);
  }
  return {
    nodeID: peer.id,
    peerURL: peer.url,
    accepted: false,
    matchIndex: progress.matchIndex || 0,
    attempts,
    error: 'unable to catch up follower before retry limit',
  };
}

async function replicateEntryToRaftQuorum(entry) {
  raftReplicationInFlight += 1;
  try {
    appendConsensusEntry(entry);
    const appendAcks = [{ nodeID: teeNodeID, accepted: true, entryDigest: entry.entryDigest }];
    await Promise.all(clusterPeerDefs().map(async (peer) => {
      try {
        appendAcks.push(await replicateLogToPeer(peer, entry.index));
      } catch (error) {
        const cause = error.cause;
        const detail = [error.message, cause?.code, cause?.message].filter(Boolean).join(': ');
        appendAcks.push({ nodeID: peer.id, peerURL: peer.url, accepted: false, error: detail });
      }
    }));
    const accepted = appendAcks.filter((ack) => ack.accepted);
    if (accepted.length < raftMajority()) {
      return { committed: false, appendAcks };
    }
    const committedEntry = commitConsensusEntry(entry.entryDigest);
    const commitAcks = [{ nodeID: teeNodeID, committed: true }];
    await Promise.all(clusterPeerDefs().map(async (peer) => {
      const appended = appendAcks.find((ack) => ack.accepted && ack.peerURL === peer.url);
      if (!appended) return;
      try {
        const data = await sendAppendEntries(peer, makeCommitNotificationPayload(committedEntry));
        commitAcks.push({
          nodeID: data.nodeID || peer.id,
          committed: Boolean(data.success),
          commitIndex: data.commitIndex,
          error: data.success ? undefined : data.reason || 'commit rejected',
        });
      } catch (error) {
        commitAcks.push({ nodeID: peer.id, committed: false, error: error.message });
      }
    }));
    return { committed: true, committedEntry, appendAcks, commitAcks };
  } finally {
    raftReplicationInFlight = Math.max(raftReplicationInFlight - 1, 0);
  }
}

async function ensureCurrentTermCommitBarrier() {
  if (clusterPeers().length === 0) return null;
  if (consensusState.role !== 'leader') throw new Error('current term barrier requires leader role');
  if (hasCommittedEntryInCurrentTerm()) return null;
  if (currentTermBarrierInFlight) return currentTermBarrierInFlight;
  const barrier = makeNoopConsensusEntry({ proposerID: teeNodeID });
  currentTermBarrierInFlight = (async () => {
    try {
      const result = await replicateEntryToRaftQuorum(barrier);
      const accepted = (result.appendAcks || []).filter((ack) => ack.accepted);
      if (!result.committed || accepted.length < raftMajority()) {
        throw new Error(`Raft current-term barrier not committed: ${accepted.length}/${raftMajority()}`);
      }
      return result;
    } finally {
      currentTermBarrierInFlight = null;
    }
  })();
  return currentTermBarrierInFlight;
}

async function collectCommittedCertifications({ hxmsg, committedEntry, commitAcks }) {
  const localSignature = await buildCommittedSignature({
    hxmsg,
    requestID: committedEntry.requestID,
    digest: committedEntry.hmsgDigest,
    entry: committedEntry,
  });
  const signatures = [localSignature];
  const certAcks = [{ nodeID: teeNodeID, signed: true, signature: localSignature }];
  await Promise.all(clusterPeerDefs().map(async (peer) => {
    try {
      let committed = commitAcks.find((ack) => ack.committed && ack.nodeID === peer.id);
      if (!committed) {
        const commitResult = await sendAppendEntries(peer, makeCommitNotificationPayload(committedEntry));
        if (!commitResult.success || Number(commitResult.commitIndex || 0) < Number(committedEntry.index)) {
          throw new Error(commitResult.reason || 'commit notification rejected');
        }
        committed = { nodeID: peer.id, committed: true, commitIndex: commitResult.commitIndex };
      }
      const resp = await fetch(`${peer.url}/internal/raft/sign-committed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...signRaftRequest({
          routePath: '/internal/raft/sign-committed',
          body: { entryDigest: committedEntry.entryDigest },
        }) },
        body: JSON.stringify({ entryDigest: committedEntry.entryDigest }),
      });
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      const data = await resp.json();
      signatures.push(data.signature);
      certAcks.push({ nodeID: data.nodeID, signed: true, signature: data.signature });
    } catch (error) {
      certAcks.push({ nodeID: peer.id, signed: false, error: error.message });
    }
  }));
  const selectedSignatures = signatures
    .filter((signature) => signature && sameHex(signature.signingDigest, committedEntry.signingDigest || committedEntry.hmsgDigest))
    .slice(0, clusterThreshold());
  const clusterCertificate = buildQuorumCertificate({
    signatures: selectedSignatures,
    clusterID: CLUSTER_ID,
    epoch: SUBNET_EPOCH,
    threshold: clusterThreshold(),
    signingDigest: committedEntry.signingDigest || committedEntry.hmsgDigest,
    subjectDigest: committedEntry.subjectDigest || committedEntry.hmsgDigest,
    sourceChainType: committedEntry.sourceChainType,
    sourceChainID: committedEntry.sourceChainID,
    signatureDigestType: committedEntry.signatureDigestType || 'hmsgDigest',
    term: committedEntry.term,
    index: committedEntry.index,
  });
  return { clusterCertificate, signatures: selectedSignatures, certAcks };
}

async function collectClusterDigestCertifications({
  response,
  checkpoint,
  requestID: suppliedRequestID,
  digest: suppliedDigest,
  signatureDigestType = 'responseDigest',
  helperData,
  localResult,
  sourceChainType,
  sourceChainID,
}) {
  const threshold = clusterThreshold();
  const barrierResult = await ensureCurrentTermCommitBarrier();
  const requestID = suppliedRequestID || response.originRequestID;
  const digest = suppliedDigest || computeResponseDigest(response);
  const entry = makeDigestConsensusEntry({
    requestID,
    digest,
    response,
    checkpoint,
    helperData,
    proposerID: teeNodeID,
    sourceChainType,
    sourceChainID,
    signatureDigestType,
  });
  const raftResult = await replicateEntryToRaftQuorum(entry);
  const verificationResults = [{ nodeID: teeNodeID, ...localResult.verificationResult }];
  const accepted = (raftResult.appendAcks || []).filter((ack) => ack.accepted);
  if (!raftResult.committed || accepted.length < raftMajority()) {
    return {
      algorithm: 'mercury-raft-tee-cluster-response',
      proposerID: teeNodeID,
      term: entry.term,
      index: entry.index,
      entryDigest: entry.entryDigest,
      threshold,
      raftMajority: raftMajority(),
      totalConfigured: clusterSize(),
      reached: accepted.length,
      quorumReached: false,
      hmsgDigest: digest,
      appendAcks: raftResult.appendAcks || [],
      barrierEntry: barrierResult?.committedEntry ? {
        index: barrierResult.committedEntry.index,
        term: barrierResult.committedEntry.term,
        entryDigest: barrierResult.committedEntry.entryDigest,
      } : undefined,
      verificationResults,
    };
  }
  const { clusterCertificate, signatures, certAcks } = await collectCommittedCertifications({
    hxmsg: null,
    committedEntry: raftResult.committedEntry,
    commitAcks: raftResult.commitAcks || [],
  });
  return {
    algorithm: `mercury-raft-tee-cluster-${signatureDigestType}`,
    proposerID: teeNodeID,
    leaderID: teeNodeID,
    term: raftResult.committedEntry.term,
    index: raftResult.committedEntry.index,
    entryDigest: raftResult.committedEntry.entryDigest,
    threshold,
    raftMajority: raftMajority(),
    totalConfigured: clusterSize(),
    reached: clusterCertificate.participantCount,
    quorumReached: clusterCertificate.participantCount >= threshold,
    hmsgDigest: digest,
    signingDigest: digest,
    signatureDigestType,
    ...clusterCertificate,
    signatureDetails: signatures,
    appendAcks: raftResult.appendAcks || [],
    commitAcks: raftResult.commitAcks || [],
    barrierEntry: barrierResult?.committedEntry ? {
      index: barrierResult.committedEntry.index,
      term: barrierResult.committedEntry.term,
      entryDigest: barrierResult.committedEntry.entryDigest,
    } : undefined,
    certAcks,
    verificationResults,
  };
}

async function collectClusterAttestations({ hxmsg, helperData, localResult }) {
  const threshold = clusterThreshold();
  const barrierResult = await ensureCurrentTermCommitBarrier();
  const entry = makeConsensusEntry({ hxmsg, helperData, proposerID: teeNodeID });
  const raftResult = await replicateEntryToRaftQuorum(entry);
  const verificationResults = [{ nodeID: teeNodeID, ...localResult.verificationResult }];
  const accepted = (raftResult.appendAcks || []).filter((ack) => ack.accepted);
  if (!raftResult.committed || accepted.length < raftMajority()) {
    return {
      algorithm: 'mercury-raft-tee-cluster',
      proposerID: teeNodeID,
      term: entry.term,
      index: entry.index,
      entryDigest: entry.entryDigest,
      threshold,
      raftMajority: raftMajority(),
      totalConfigured: clusterSize(),
      reached: accepted.length,
      quorumReached: false,
      hmsgDigest: entry.hmsgDigest,
      appendAcks: raftResult.appendAcks || [],
      barrierEntry: barrierResult?.committedEntry ? {
        index: barrierResult.committedEntry.index,
        term: barrierResult.committedEntry.term,
        entryDigest: barrierResult.committedEntry.entryDigest,
      } : undefined,
      verificationResults,
    };
  }

  const { clusterCertificate, signatures, certAcks } = await collectCommittedCertifications({
    hxmsg,
    committedEntry: raftResult.committedEntry,
    commitAcks: raftResult.commitAcks || [],
  });
  return {
    algorithm: 'mercury-raft-tee-cluster',
    proposerID: teeNodeID,
    leaderID: teeNodeID,
    term: raftResult.committedEntry.term,
    index: raftResult.committedEntry.index,
    entryDigest: raftResult.committedEntry.entryDigest,
    threshold,
    raftMajority: raftMajority(),
    totalConfigured: clusterSize(),
    reached: clusterCertificate.participantCount,
    quorumReached: clusterCertificate.participantCount >= threshold,
    hmsgDigest: raftResult.committedEntry.hmsgDigest,
    signingDigest: raftResult.committedEntry.signingDigest,
    signatureDigestType: raftResult.committedEntry.signatureDigestType,
    ...clusterCertificate,
    signatureDetails: signatures,
    appendAcks: raftResult.appendAcks || [],
    commitAcks: raftResult.commitAcks || [],
    barrierEntry: barrierResult?.committedEntry ? {
      index: barrierResult.committedEntry.index,
      term: barrierResult.committedEntry.term,
      entryDigest: barrierResult.committedEntry.entryDigest,
    } : undefined,
    certAcks,
    verificationResults,
  };
}

async function collectClusterBatchCertifications({ batch, localResult }) {
  const threshold = clusterThreshold();
  const barrierResult = await ensureCurrentTermCommitBarrier();
  const entry = makeBatchConsensusEntry({ batch, proposerID: teeNodeID });
  const raftResult = await replicateEntryToRaftQuorum(entry);
  const verificationResults = [{ nodeID: teeNodeID, batchVerified: true, items: localResult.verificationResults }];
  const accepted = (raftResult.appendAcks || []).filter((ack) => ack.accepted);
  if (!raftResult.committed || accepted.length < raftMajority()) {
    return {
      algorithm: 'mercury-raft-tee-batch-cluster',
      proposerID: teeNodeID,
      term: entry.term,
      index: entry.index,
      entryDigest: entry.entryDigest,
      threshold,
      raftMajority: raftMajority(),
      totalConfigured: clusterSize(),
      reached: accepted.length,
      quorumReached: false,
      batchID: batch.batchID,
      batchRoot: batch.batchRoot,
      batchSigningDigest: batch.batchSigningDigest,
      appendAcks: raftResult.appendAcks || [],
      barrierEntry: barrierResult?.committedEntry ? {
        index: barrierResult.committedEntry.index,
        term: barrierResult.committedEntry.term,
        entryDigest: barrierResult.committedEntry.entryDigest,
      } : undefined,
      verificationResults,
    };
  }

  const { clusterCertificate, signatures, certAcks } = await collectCommittedCertifications({
    hxmsg: null,
    committedEntry: raftResult.committedEntry,
    commitAcks: raftResult.commitAcks || [],
  });
  return {
    algorithm: 'mercury-raft-tee-batch-cluster',
    proposerID: teeNodeID,
    leaderID: teeNodeID,
    term: raftResult.committedEntry.term,
    index: raftResult.committedEntry.index,
    entryDigest: raftResult.committedEntry.entryDigest,
    threshold,
    raftMajority: raftMajority(),
    totalConfigured: clusterSize(),
    reached: clusterCertificate.participantCount,
    quorumReached: clusterCertificate.participantCount >= threshold,
    batchID: batch.batchID,
    batchRoot: batch.batchRoot,
    batchSize: batch.hxmsgs.length,
    batchSigningDigest: batch.batchSigningDigest,
    signingDigest: batch.batchSigningDigest,
    signatureDigestType: 'batchDigest',
    ...clusterCertificate,
    signatureDetails: signatures,
    appendAcks: raftResult.appendAcks || [],
    commitAcks: raftResult.commitAcks || [],
    barrierEntry: barrierResult?.committedEntry ? {
      index: barrierResult.committedEntry.index,
      term: barrierResult.committedEntry.term,
      entryDigest: barrierResult.committedEntry.entryDigest,
    } : undefined,
    certAcks,
    verificationResults,
  };
}

// ============ Routes ============

app.get('/pubkey', async (_req, res) => {
  res.json({
    nodeID: teeNodeID,
    subnetID: teeSubnetID,
    subnetProfile: teeSubnetProfile,
    address: state.address,
    attestation: await currentTEEIdentity(),
  });
});

app.get('/identity', async (_req, res) => {
  res.json(await currentTEEIdentity());
});

app.get('/chain-state', (_req, res) => {
  res.json(chainState);
});

app.get('/raft/status', (_req, res) => {
  res.json({
    nodeID: teeNodeID,
    subnetID: teeSubnetID,
    subnetProfile: teeSubnetProfile,
    role: consensusState.role,
    leaderID: consensusState.leaderID,
    term: Number(consensusState.currentTerm || 1),
    votedFor: consensusState.votedFor,
    peers: clusterPeerDefs(),
    threshold: clusterThreshold(),
    raftMajority: raftMajority(),
    address: state.address,
    commitIndex: consensusState.commitIndex,
    lastApplied: consensusState.lastApplied,
    lastLogIndex: lastLogIndex(),
    lastLogTerm: lastLogTerm(),
    logLength: consensusState.log.length,
    verificationLeaseUntil,
    supportedSourceChains: Array.from(supportedSourceChains),
    supportedVerificationMethods: Array.from(supportedVerificationMethods),
  });
});

app.post('/internal/raft/request-vote', (req, res) => {
  try {
    const {
      term,
      candidateID,
      lastLogIndex: candidateLastLogIndex,
      lastLogTerm: candidateLastLogTerm,
    } = req.body;
    if (!candidateID) throw new Error('candidateID is required');
    if (raftAuthRequired() && req.raftSenderID !== candidateID) {
      throw new Error('candidateID does not match authenticated sender');
    }
    let voteGranted = false;
    if (Number(term) < Number(consensusState.currentTerm)) {
      voteGranted = false;
    } else if (Date.now() < verificationLeaseUntil && candidateID !== consensusState.leaderID) {
      voteGranted = false;
    } else {
      if (Number(term) > Number(consensusState.currentTerm)) {
        stepDown(Number(term));
      }
      const canVote = !consensusState.votedFor || consensusState.votedFor === candidateID;
      const upToDate = isCandidateLogUpToDate(candidateLastLogIndex, candidateLastLogTerm);
      voteGranted = canVote && upToDate;
      if (voteGranted) {
        consensusState.votedFor = candidateID;
        consensusState.leaderID = null;
        consensusState.role = 'follower';
        lastHeartbeatAt = Date.now();
        electionDeadlineAt = Date.now() + electionTimeoutMs();
        saveConsensusState();
      }
    }
    res.json({
      nodeID: teeNodeID,
      term: consensusState.currentTerm,
      voteGranted,
    });
  } catch (error) {
    res.status(500).json({ nodeID: teeNodeID, term: consensusState.currentTerm, voteGranted: false, error: error.message });
  }
});

app.post('/internal/raft/verification-lease', (req, res) => {
  try {
    const { term, leaderID, leaseUntil } = req.body;
    if (!leaderID) throw new Error('leaderID is required');
    if (raftAuthRequired() && req.raftSenderID !== leaderID) {
      throw new Error('leaderID does not match authenticated sender');
    }
    if (Number(term) < Number(consensusState.currentTerm)) {
      res.json({ nodeID: teeNodeID, term: consensusState.currentTerm, granted: false });
      return;
    }
    const boundedLeaseUntil = Math.min(
      Math.max(Number(leaseUntil || 0), Date.now()),
      Date.now() + raftVerificationLeaseMs
    );
    verificationLeaseUntil = boundedLeaseUntil;
    stepDown(Number(term), leaderID);
    electionDeadlineAt = Math.max(electionDeadlineAt, verificationLeaseUntil);
    res.json({
      nodeID: teeNodeID,
      term: consensusState.currentTerm,
      leaderID,
      granted: true,
      leaseUntil: verificationLeaseUntil,
    });
  } catch (error) {
    res.status(500).json({ nodeID: teeNodeID, term: consensusState.currentTerm, granted: false, error: error.message });
  }
});

app.post('/internal/raft/verification-lease-release', (req, res) => {
  try {
    const { term, leaderID } = req.body;
    if (!leaderID) throw new Error('leaderID is required');
    if (raftAuthRequired() && req.raftSenderID !== leaderID) {
      throw new Error('leaderID does not match authenticated sender');
    }
    const isCurrentLeader = Number(term) === Number(consensusState.currentTerm)
      && leaderID === consensusState.leaderID;
    if (isCurrentLeader) {
      verificationLeaseUntil = 0;
      electionDeadlineAt = Date.now() + electionTimeoutMs();
    }
    res.json({ nodeID: teeNodeID, term: consensusState.currentTerm, released: isCurrentLeader });
  } catch (error) {
    res.status(500).json({ nodeID: teeNodeID, term: consensusState.currentTerm, released: false, error: error.message });
  }
});

app.post('/internal/raft/append-entries', async (req, res) => {
  try {
    const { term, leaderID, prevLogIndex, prevLogTerm, entries = [], leaderCommit = 0 } = req.body;
    if (!leaderID) throw new Error('leaderID is required');
    if (raftAuthRequired() && req.raftSenderID !== leaderID) {
      throw new Error('leaderID does not match authenticated sender');
    }
    if (Number(term) < Number(consensusState.currentTerm)) {
      res.json({ nodeID: teeNodeID, term: consensusState.currentTerm, success: false, reason: 'stale term' });
      return;
    }
    stepDown(Number(term), leaderID);

    if (Number(prevLogIndex || 0) > 0) {
      const prevEntry = logEntryAt(prevLogIndex);
      if (!prevEntry || Number(prevEntry.term) !== Number(prevLogTerm)) {
        let conflictIndex = Math.min(Number(prevLogIndex), lastLogIndex() + 1);
        if (prevEntry && Number(prevEntry.term) !== Number(prevLogTerm)) {
          const conflictTerm = Number(prevEntry.term);
          const firstConflict = consensusState.log.find((item) => Number(item.term) === conflictTerm);
          conflictIndex = firstConflict ? Number(firstConflict.index) : conflictIndex;
        }
        res.json({
          nodeID: teeNodeID,
          term: consensusState.currentTerm,
          success: false,
          reason: 'log consistency check failed',
          matchIndex: lastLogIndex(),
          conflictIndex,
        });
        return;
      }
    }

    const verificationResults = [];
    for (const entry of entries) {
      let localResult;
      if (entry.noop) {
        localResult = {
          verificationResult: {
            verified: true,
            adapter: 'raft-noop',
            reason: entry.reason || 'leader-current-term-barrier',
          },
        };
      } else if (entry.hxmsg) {
        assertEntryMatchesHXMsg(entry, entry.hxmsg);
        localResult = await verifyHXMsgLocally({
          hxmsg: entry.hxmsg,
          helperData: entry.helperData || {},
          enforceExpiry: Number(entry.index) > Number(leaderCommit),
        });
      } else if (entry.response) {
        const digest = computeResponseDigest(entry.response);
        assertEntryMatchesDigest(entry, entry.response.originRequestID, digest,
          entry.sourceChainType, entry.sourceChainID);
        localResult = { verificationResult: await verifyResponseFactLocally({
          response: entry.response,
          helperData: entry.helperData || {},
        }) };
      } else if (entry.checkpoint) {
        const verified = verifyCheckpointLocally(entry.checkpoint);
        assertEntryMatchesDigest(entry, verified.requestID, verified.signingDigest,
          entry.sourceChainType, entry.sourceChainID);
        localResult = { verificationResult: verified };
      } else if (entry.batch) {
        assertEntryMatchesBatch(entry, entry.batch);
        localResult = { verificationResult: await verifyBatchLocally({
          batch: entry.batch,
          enforceExpiry: Number(entry.index) > Number(leaderCommit),
        }) };
      } else {
        throw new Error('raft entry missing hxmsg, response, checkpoint, batch, or noop');
      }
      verificationResults.push({ entryDigest: entry.entryDigest, ...localResult.verificationResult });
      appendConsensusEntry(entry);
    }

    if (Number(leaderCommit) > Number(consensusState.commitIndex)) {
      const newCommitIndex = Math.min(Number(leaderCommit), lastLogIndex());
      consensusState.commitIndex = newCommitIndex;
      consensusState.lastApplied = newCommitIndex;
      for (const item of consensusState.log) {
        if (Number(item.index) <= newCommitIndex) {
          item.status = 'committed';
          item.committedAt = item.committedAt || Math.floor(Date.now() / 1000);
        }
      }
      saveConsensusState();
    }

    res.json({
      nodeID: teeNodeID,
      term: consensusState.currentTerm,
      success: true,
      matchIndex: lastLogIndex(),
      commitIndex: consensusState.commitIndex,
      verificationResults,
    });
  } catch (error) {
    console.error(`[${teeNodeID}] raft append error:`, error.message);
    res.status(500).json({ nodeID: teeNodeID, term: consensusState.currentTerm, success: false, error: error.message });
  }
});

app.post('/internal/raft/sign-committed', async (req, res) => {
  try {
    const { entryDigest } = req.body;
    if (!entryDigest) throw new Error('entryDigest is required');
    const entry = consensusState.log.find((item) => item.entryDigest === entryDigest);
    if (!entry) throw new Error(`entry not found: ${entryDigest}`);
    if (entry.status !== 'committed') throw new Error('entry is not committed');
    const signature = await buildCommittedSignature({
      hxmsg: entry.hxmsg,
      requestID: entry.requestID,
      digest: entry.hmsgDigest,
      entry,
    });
    res.json({
      nodeID: teeNodeID,
      entryDigest,
      signature,
    });
  } catch (error) {
    res.status(500).json({ nodeID: teeNodeID, error: error.message });
  }
});

// ============ /attest: h-xmsg verification + Raft-backed committed signing ============

app.post('/attest', async (req, res) => {
  let leaseAcquired = false;
  try {
    if (req.body?.hxmsg) {
      const leaderRoute = await ensureRaftLeaderOrForward(req.body);
      if (!leaderRoute.localLeader) {
        res.status(leaderRoute.status).json(leaderRoute.body);
        return;
      }
      await acquireVerificationLease();
      leaseAcquired = true;
      const { hxmsg, helperData } = normalizeAttestationInput(req.body);
      const localResult = await verifyHXMsgLocally({
        hxmsg,
        helperData,
      });
      const teeClusterCertification = await collectClusterAttestations({
        hxmsg,
        helperData,
        localResult,
      });
      if (!teeClusterCertification.quorumReached) {
        throw new Error(`TEE cluster quorum not reached: ${teeClusterCertification.reached}/${teeClusterCertification.threshold}`);
      }
      res.json({
        teeClusterCertification,
        verificationResult: localResult.verificationResult,
      });
      return;
    }
    throw new Error('h-xmsg is required');
  } catch (error) {
    console.error('[attest] Error:', error.stack || error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (leaseAcquired) await releaseVerificationLease();
  }
});

// ============ /attest-batch: verify many h-xmsgs, commit one batch digest ============

app.post('/attest-batch', async (req, res) => {
  let leaseAcquired = false;
  try {
    const hxmsgs = req.body?.hxmsgs;
    const helperDataList = req.body?.helperDataList || [];
    if (!Array.isArray(hxmsgs) || hxmsgs.length === 0) throw new Error('hxmsgs are required');
    if (!Array.isArray(helperDataList) || helperDataList.length !== hxmsgs.length) {
      throw new Error('helperDataList must match hxmsgs length');
    }
    assertSubnetSourceScope(hxmsgs[0].source?.chainType, hxmsgs[0].source?.chainID);
    if (hxmsgs.some((item) => Number(item.source?.chainType) !== Number(hxmsgs[0].source.chainType)
      || !sameHex(item.source?.chainID, hxmsgs[0].source.chainID))) {
      throw new Error('TEE batch contains multiple source-chain security domains');
    }
    const leaderRoute = await ensureRaftLeaderOrForward(req.body, '/attest-batch');
    if (!leaderRoute.localLeader) {
      res.status(leaderRoute.status).json(leaderRoute.body);
      return;
    }
    await acquireVerificationLease();
    leaseAcquired = true;
    const built = buildHXMsgBatch(hxmsgs);
    const batch = {
      batchID: built.batchID,
      batchRoot: built.batchRoot,
      batchSize: built.batchSize,
      targetChainID: built.targetChainID,
      batchSigningDigest: built.batchSigningDigest,
      hxmsgs,
      helperDataList,
    };
    const localResult = await verifyBatchLocally({ batch });
    const teeBatchCertification = await collectClusterBatchCertifications({ batch, localResult });
    if (!teeBatchCertification.quorumReached) {
      const failures = (teeBatchCertification.appendAcks || [])
        .filter((ack) => !ack.accepted)
        .map((ack) => `${ack.nodeID}:${ack.error || ack.reason || 'rejected'}`)
        .join('; ');
      throw new Error(
        `TEE batch quorum not reached: ${teeBatchCertification.reached}/${teeBatchCertification.threshold}`
          + (failures ? `; ${failures}` : '')
      );
    }
    res.json({
      batchID: built.batchID,
      batchRoot: built.batchRoot,
      batchSize: built.batchSize,
      batchSigningDigest: built.batchSigningDigest,
      merkleProofs: built.proofs,
      teeBatchCertification,
      verificationResults: localResult.verificationResults,
    });
  } catch (error) {
    console.error('[attest-batch] Error:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (leaseAcquired) await releaseVerificationLease();
  }
});

app.post('/attest-response', async (req, res) => {
  let leaseAcquired = false;
  try {
    if (!req.body?.response) throw new Error('response is required');
    assertSubnetSourceScope(req.body.sourceChainType, req.body.sourceChainID);
    const leaderRoute = await ensureRaftLeaderOrForward(req.body, '/attest-response');
    if (!leaderRoute.localLeader) {
      res.status(leaderRoute.status).json(leaderRoute.body);
      return;
    }
    await acquireVerificationLease();
    leaseAcquired = true;
    const response = req.body.response;
    const localVerification = await verifyResponseFactLocally({
      response,
      helperData: req.body.helperData || {},
    });
    const teeClusterCertification = await collectClusterDigestCertifications({
      response,
      helperData: req.body.helperData || {},
      localResult: { verificationResult: localVerification },
      sourceChainType: req.body.sourceChainType,
      sourceChainID: req.body.sourceChainID,
    });
    if (!teeClusterCertification.quorumReached) {
      const failures = (teeClusterCertification.appendAcks || [])
        .filter((ack) => !ack.accepted)
        .map((ack) => `${ack.nodeID}:${ack.error || ack.reason || 'rejected'}`)
        .join('; ');
      throw new Error(
        `TEE cluster quorum not reached: ${teeClusterCertification.reached}/${teeClusterCertification.threshold}`
          + (failures ? `; ${failures}` : '')
      );
    }
    res.json({
      responseDigest: computeResponseDigest(response),
      teeClusterCertification,
      verificationResult: localVerification,
    });
  } catch (error) {
    console.error('[attest-response] Error:', error.message);
    res.status(500).json({ error: error.message });
  } finally {
    if (leaseAcquired) await releaseVerificationLease();
  }
});

app.post('/attest-checkpoint', async (req, res) => {
  try {
    assertSubnetSourceScope(req.body?.sourceChainType, req.body?.sourceChainID);
    const checkpointEnvelope = {
      checkpoint: req.body?.checkpoint,
      records: req.body?.records,
    };
    const verified = verifyCheckpointLocally(checkpointEnvelope);
    const leaderRoute = await ensureRaftLeaderOrForward(req.body, '/attest-checkpoint');
    if (!leaderRoute.localLeader) {
      res.status(leaderRoute.status).json(leaderRoute.body);
      return;
    }
    const teeClusterCertification = await collectClusterDigestCertifications({
      checkpoint: checkpointEnvelope,
      requestID: verified.requestID,
      digest: verified.signingDigest,
      signatureDigestType: 'lifecycleCheckpointDigest',
      helperData: {},
      localResult: { verificationResult: verified },
      sourceChainType: req.body.sourceChainType,
      sourceChainID: req.body.sourceChainID,
    });
    if (!teeClusterCertification.quorumReached) {
      throw new Error(`TEE cluster quorum not reached: ${teeClusterCertification.reached}/${teeClusterCertification.threshold}`);
    }
    res.json({
      terminalStateRoot: verified.terminalStateRoot,
      checkpointDigest: verified.signingDigest,
      teeClusterCertification,
      verificationResult: verified,
    });
  } catch (error) {
    console.error('[attest-checkpoint] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

async function sendHeartbeats() {
  if (consensusState.role !== 'leader') return;
  if (raftReplicationInFlight > 0) return;
  if (!hasCommittedEntryInCurrentTerm()) {
    try {
      await ensureCurrentTermCommitBarrier();
    } catch (error) {
      console.error(`[${teeNodeID}] current-term barrier failed:`, error.message);
    }
  }
  await Promise.all(clusterPeerDefs().map(async (peer) => {
    try {
      const replication = await replicateLogToPeer(peer, lastLogIndex());
      if (!replication.accepted) {
        throw new Error(replication.error || 'follower catch-up failed');
      }
      const committedEntry = logEntryAt(consensusState.commitIndex);
      if (committedEntry && Number(replication.matchIndex || 0) >= Number(committedEntry.index)) {
        await sendAppendEntries(peer, makeCommitNotificationPayload(committedEntry));
      }
    } catch (error) {
      console.error(`[${teeNodeID}] heartbeat to ${peer.id} failed:`, error.message);
    }
  }));
}

function electionTimeoutMs() {
  const seed = teeNodeID.split('').reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  return 3000 + (seed % 1000) + Math.floor(Math.random() * 3000);
}

setInterval(() => {
  if (clusterPeers().length === 0) return;
  if (consensusState.role === 'leader') {
    sendHeartbeats().catch((error) => console.error(`[${teeNodeID}] heartbeat error:`, error.message));
    return;
  }
  if (Date.now() > electionDeadlineAt) {
    startElection()
      .then((result) => {
        lastHeartbeatAt = Date.now();
        electionDeadlineAt = Date.now() + electionTimeoutMs();
        if (result.elected) {
          console.log(`[${teeNodeID}] elected Raft leader for term ${consensusState.currentTerm} with ${result.votes}/${clusterSize()} votes`);
        }
      })
      .catch((error) => console.error(`[${teeNodeID}] election error:`, error.message));
  }
}, 1000);

const port = process.env.PORT || 9000;
app.listen(port, () => {
  console.log(`tee-verifier listening on ${port} (Raft-backed local verification)`);
});
