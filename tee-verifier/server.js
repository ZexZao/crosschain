const express = require('express');
const { ethers } = require('ethers');
const fs = require('fs-extra');
const path = require('path');
const { readJSON, writeJSON, ensureRuntime } = require('../shared/utils');
const { ChainType, computeHXMsgDigest, computeHXMsgDeliveryDigest } = require('../shared/hxmsg');
const { verifySourceFact } = require('./adapters');
const { buildCertification } = require('./core/certification');

ensureRuntime();
const app = express();
app.use(express.json({ limit: '10mb' }));  // Larger limit for block data

// ============ Chain State ============

const teeNodeID = process.env.TEE_NODE_ID || 'tee-verifier-1';
const teeStateFile = process.env.TEE_STATE_FILE || `tee-state-${teeNodeID}.json`;
const teeChainStateFile = process.env.TEE_CHAIN_STATE_FILE || `tee-chain-state-${teeNodeID}.json`;
const teeConsensusStateFile = process.env.TEE_CONSENSUS_STATE_FILE || `tee-consensus-${teeNodeID}.json`;
let chainState = readJSON(teeChainStateFile);
if (!chainState) {
  chainState = {
    fabric: { tipHeight: 0, tipHash: null, headers: [] },
    evm: { tipHeight: 0, tipHash: null, headers: [] },
  };
  writeJSON(teeChainStateFile, chainState);
}

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

// ============ TEE Identity ============

let state = readJSON(teeStateFile);
if (!state) {
  const configuredKey = process.env.TEE_PRIVATE_KEY;
  const wallet = configuredKey ? new ethers.Wallet(configuredKey) : ethers.Wallet.createRandom();
  state = { privateKey: wallet.privateKey, address: wallet.address, ctr: 0, lastDigest: ethers.ZeroHash, mode: 'normal' };
  writeJSON(teeStateFile, state);
} else if (!state.privateKey && state.sessions?.default?.privateKey) {
  state = {
    privateKey: state.sessions.default.privateKey,
    address: state.sessions.default.address,
    ctr: state.sessions.default.ctr || 0,
    lastDigest: state.sessions.default.lastDigest || ethers.ZeroHash,
    mode: state.mode || 'normal',
    sessions: state.sessions,
  };
  writeJSON(teeStateFile, state);
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
  electionDeadlineAt = Date.now() + electionTimeoutMs();
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

function signingDigestForHXMsg(hxmsg) {
  return Number(hxmsg.target?.chainType) === ChainType.EVM
    ? computeHXMsgDeliveryDigest(hxmsg)
    : (hxmsg.hmsgDigest || computeHXMsgDigest(hxmsg));
}

function makeConsensusEntry({ hxmsg, helperData, proposerID }) {
  const hmsgDigest = hxmsg.hmsgDigest || computeHXMsgDigest(hxmsg);
  hxmsg.hmsgDigest = hmsgDigest;
  const index = lastLogIndex() + 1;
  const term = Number(consensusState.currentTerm || 1);
  const signingDigest = signingDigestForHXMsg(hxmsg);
  const signatureDigestType = Number(hxmsg.target?.chainType) === ChainType.EVM ? 'deliveryDigest' : 'hmsgDigest';
  const entryDigest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint64', 'uint64', 'bytes32', 'bytes32', 'bytes32', 'string'],
      [term, index, hxmsg.header.requestID, hmsgDigest, signingDigest, signatureDigestType]
    )
  );
  return {
    index,
    term,
    proposerID,
    requestID: hxmsg.header.requestID,
    hmsgDigest,
    signingDigest,
    signatureDigestType,
    sourceChainType: Number(hxmsg.source?.chainType),
    targetChainType: Number(hxmsg.target?.chainType),
    entryDigest,
    status: 'pending',
    hxmsg,
    helperData: helperData || {},
    createdAt: Math.floor(Date.now() / 1000),
  };
}

function appendConsensusEntry(entry) {
  const existing = consensusState.log.find((item) => item.entryDigest === entry.entryDigest);
  if (existing) return existing;
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
  return entry;
}

function assertEntryMatchesHXMsg(entry, hxmsg) {
  const hmsgDigest = hxmsg.hmsgDigest || computeHXMsgDigest(hxmsg);
  const signingDigest = signingDigestForHXMsg(hxmsg);
  if (entry.requestID !== hxmsg.header.requestID) throw new Error('consensus request mismatch');
  if (String(entry.hmsgDigest).toLowerCase() !== String(hmsgDigest).toLowerCase()) throw new Error('consensus hmsgDigest mismatch');
  if (String(entry.signingDigest).toLowerCase() !== String(signingDigest).toLowerCase()) throw new Error('consensus signingDigest mismatch');
  const expectedEntryDigest = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint64', 'uint64', 'bytes32', 'bytes32', 'bytes32', 'string'],
      [Number(entry.term), Number(entry.index), entry.requestID, entry.hmsgDigest, entry.signingDigest, entry.signatureDigestType]
    )
  );
  if (String(entry.entryDigest).toLowerCase() !== expectedEntryDigest.toLowerCase()) {
    throw new Error('consensus entry digest mismatch');
  }
}

async function verifyHXMsgLocally({ hxmsg, helperData }) {
  hxmsg.hmsgDigest = hxmsg.hmsgDigest || computeHXMsgDigest(hxmsg);
  if (Number(hxmsg.header.expireAt) < Math.floor(Date.now() / 1000)) {
    throw new Error('h-xmsg expired');
  }
  const verificationResult = await verifySourceFact({
    hxmsg,
    helperData,
    chainState,
    saveChainState,
  });
  return { verificationResult };
}

function buildCommittedCertification({ hxmsg, entry }) {
  const committedEntry = consensusState.log.find((item) => item.entryDigest === entry.entryDigest);
  if (!committedEntry || committedEntry.status !== 'committed') {
    throw new Error('cannot sign before consensus commit');
  }
  assertEntryMatchesHXMsg(committedEntry, hxmsg);
  return buildCertification({
    hxmsg,
    privateKey: state.privateKey,
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
        headers: { 'content-type': 'application/json' },
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

async function ensureRaftLeaderOrForward(originalBody) {
  if (consensusState.role === 'leader') return { localLeader: true };
  const leader = consensusState.leaderID
    ? clusterPeerDefs().find((peer) => peer.id === consensusState.leaderID)
    : null;
  if (leader) {
    const resp = await fetch(`${leader.url}/attest`, {
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

async function sendAppendEntries(peer, payload) {
  const resp = await fetch(`${peer.url}/internal/raft/append-entries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) throw new Error(`status ${resp.status}`);
  const data = await resp.json();
  if (Number(data.term || 0) > Number(consensusState.currentTerm)) {
    stepDown(Number(data.term), data.leaderID || null);
  }
  return data;
}

async function replicateEntryToRaftQuorum(entry) {
  appendConsensusEntry(entry);
  const appendAcks = [{ nodeID: teeNodeID, accepted: true, entryDigest: entry.entryDigest }];
  await Promise.all(clusterPeerDefs().map(async (peer) => {
    try {
      const data = await sendAppendEntries(peer, makeAppendEntriesPayload({
        entries: [entry],
        leaderCommit: consensusState.commitIndex,
      }));
      if (!data.success && data.reason === 'log consistency check failed') {
        const retryPayload = {
          term: consensusState.currentTerm,
          leaderID: teeNodeID,
          prevLogIndex: 0,
          prevLogTerm: 0,
          entries: [entry],
          leaderCommit: consensusState.commitIndex,
        };
        const retryData = await sendAppendEntries(peer, retryPayload);
        appendAcks.push({
          nodeID: retryData.nodeID || peer.id,
          peerURL: peer.url,
          accepted: Boolean(retryData.success),
          matchIndex: retryData.matchIndex,
          error: retryData.success ? undefined : retryData.reason || 'append rejected after retry',
        });
        return;
      }
      appendAcks.push({
        nodeID: data.nodeID || peer.id,
        peerURL: peer.url,
        accepted: Boolean(data.success),
        matchIndex: data.matchIndex,
        error: data.success ? undefined : data.reason || 'append rejected',
      });
    } catch (error) {
      appendAcks.push({ nodeID: peer.id, peerURL: peer.url, accepted: false, error: error.message });
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
      const data = await sendAppendEntries(peer, makeAppendEntriesPayload({
        entries: [],
        leaderCommit: committedEntry.index,
      }));
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
}

async function collectCommittedCertifications({ hxmsg, committedEntry, commitAcks }) {
  const localCommitCert = buildCommittedCertification({ hxmsg, entry: committedEntry });
  const certifications = [localCommitCert];
  const certAcks = [{ nodeID: teeNodeID, signed: true, teeCertification: localCommitCert }];
  await Promise.all(clusterPeerDefs().map(async (peer) => {
    const committed = commitAcks.find((ack) => ack.committed && ack.nodeID === peer.id);
    if (!committed) return;
    try {
      const resp = await fetch(`${peer.url}/internal/raft/sign-committed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entryDigest: committedEntry.entryDigest }),
      });
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      const data = await resp.json();
      certifications.push(data.teeCertification);
      certAcks.push({ nodeID: data.nodeID, signed: true, teeCertification: data.teeCertification });
    } catch (error) {
      certAcks.push({ nodeID: peer.id, signed: false, error: error.message });
    }
  }));
  return { certifications, certAcks };
}

async function collectClusterAttestations({ hxmsg, helperData, localResult }) {
  const threshold = clusterThreshold();
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
      certifications: [],
      appendAcks: raftResult.appendAcks || [],
      verificationResults,
    };
  }

  const { certifications, certAcks } = await collectCommittedCertifications({
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
    reached: certifications.length,
    quorumReached: certifications.length >= threshold,
    hmsgDigest: raftResult.committedEntry.hmsgDigest,
    signingDigest: raftResult.committedEntry.signingDigest,
    signatureDigestType: raftResult.committedEntry.signatureDigestType,
    certifications,
    appendAcks: raftResult.appendAcks || [],
    commitAcks: raftResult.commitAcks || [],
    certAcks,
    verificationResults,
  };
}

// ============ Routes ============

app.get('/pubkey', (_req, res) => {
  res.json({ nodeID: teeNodeID, address: state.address });
});

app.get('/chain-state', (_req, res) => {
  res.json(chainState);
});

app.get('/raft/status', (_req, res) => {
  res.json({
    nodeID: teeNodeID,
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
  });
});

app.post('/mode', (req, res) => {
  state.mode = req.body.mode || 'normal';
  writeJSON(teeStateFile, state);
  res.json({ ok: true, mode: state.mode });
});

app.post('/internal/attest-node', async (req, res) => {
  try {
    const hxmsg = req.body.hxmsg;
    if (!hxmsg) throw new Error('hxmsg is required');
    const result = await verifyHXMsgLocally({
      hxmsg,
      helperData: req.body.helperData || req.body.blockData || {},
    });
    res.json({ nodeID: teeNodeID, ...result });
  } catch (error) {
    console.error(`[${teeNodeID}] internal attest error:`, error.message);
    res.status(500).json({ nodeID: teeNodeID, error: error.message });
  }
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
    let voteGranted = false;
    if (Number(term) < Number(consensusState.currentTerm)) {
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

app.post('/internal/raft/append-entries', async (req, res) => {
  try {
    const { term, leaderID, prevLogIndex, prevLogTerm, entries = [], leaderCommit = 0 } = req.body;
    if (!leaderID) throw new Error('leaderID is required');
    if (Number(term) < Number(consensusState.currentTerm)) {
      res.json({ nodeID: teeNodeID, term: consensusState.currentTerm, success: false, reason: 'stale term' });
      return;
    }
    stepDown(Number(term), leaderID);

    if (Number(prevLogIndex || 0) > 0) {
      const prevEntry = logEntryAt(prevLogIndex);
      if (!prevEntry || Number(prevEntry.term) !== Number(prevLogTerm)) {
        res.json({
          nodeID: teeNodeID,
          term: consensusState.currentTerm,
          success: false,
          reason: 'log consistency check failed',
          matchIndex: lastLogIndex(),
        });
        return;
      }
    }

    const verificationResults = [];
    for (const entry of entries) {
      if (!entry.hxmsg) throw new Error('raft entry missing hxmsg');
      assertEntryMatchesHXMsg(entry, entry.hxmsg);
      const localResult = await verifyHXMsgLocally({
        hxmsg: entry.hxmsg,
        helperData: entry.helperData || {},
      });
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

app.post('/internal/raft/sign-committed', (req, res) => {
  try {
    const { entryDigest } = req.body;
    if (!entryDigest) throw new Error('entryDigest is required');
    const entry = consensusState.log.find((item) => item.entryDigest === entryDigest);
    if (!entry) throw new Error(`entry not found: ${entryDigest}`);
    if (entry.status !== 'committed') throw new Error('entry is not committed');
    const teeCertification = buildCommittedCertification({ hxmsg: entry.hxmsg, entry });
    res.json({
      nodeID: teeNodeID,
      entryDigest,
      teeCertification,
    });
  } catch (error) {
    res.status(500).json({ nodeID: teeNodeID, error: error.message });
  }
});

// ============ /attest: h-xmsg verification + Raft-backed committed signing ============

app.post('/attest', async (req, res) => {
  try {
    if (req.body?.hxmsg) {
      const leaderRoute = await ensureRaftLeaderOrForward(req.body);
      if (!leaderRoute.localLeader) {
        res.status(leaderRoute.status).json(leaderRoute.body);
        return;
      }
      const hxmsg = req.body.hxmsg;
      const localResult = await verifyHXMsgLocally({
        hxmsg,
        helperData: req.body.helperData || req.body.blockData || {},
      });
      const teeClusterCertification = await collectClusterAttestations({
        hxmsg,
        helperData: req.body.helperData || req.body.blockData || {},
        localResult,
      });
      if (!teeClusterCertification.quorumReached) {
        throw new Error(`TEE cluster quorum not reached: ${teeClusterCertification.reached}/${teeClusterCertification.threshold}`);
      }
      res.json({
        teePubKey: teeClusterCertification.certifications[0].teeAddress,
        teeCertification: teeClusterCertification.certifications[0],
        teeClusterCertification,
        verificationResult: localResult.verificationResult,
      });
      return;
    }
    throw new Error('h-xmsg is required');
  } catch (error) {
    console.error('[attest] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

async function sendHeartbeats() {
  if (consensusState.role !== 'leader') return;
  await Promise.all(clusterPeerDefs().map(async (peer) => {
    try {
      await sendAppendEntries(peer, makeAppendEntriesPayload({
        entries: [],
        leaderCommit: consensusState.commitIndex,
      }));
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
