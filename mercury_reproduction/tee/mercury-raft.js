const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function createMercuryRaft({ app, nodeID, runtimeDir, identity, verifyOperation, buildQuorumCertificate }) {
  const peers = String(process.env.TEE_CLUSTER_PEERS || '')
    .split(',').map((item) => item.trim()).filter(Boolean)
    .map((url) => ({ id: new URL(url).hostname, url: url.replace(/\/$/, '') }));
  const clusterSize = peers.length + 1;
  const majority = Math.floor(clusterSize / 2) + 1;
  const threshold = Number(process.env.MERCURY_CLUSTER_THRESHOLD || majority);
  if (clusterSize > 1 && clusterSize % 2 === 0) {
    throw new Error(`MERCURY requires n=2f+1 operators; configured cluster size is ${clusterSize}`);
  }
  if (threshold !== majority) {
    throw new Error(`MERCURY threshold must be f+1=${majority}; configured ${threshold}`);
  }

  const stateFile = path.join(runtimeDir, `mercury-consensus-${nodeID}.json`);
  const loaded = fs.readJsonSync(stateFile, { throws: false }) || {};
  const state = {
    currentTerm: Number(loaded.currentTerm || 1),
    votedFor: loaded.votedFor || null,
    role: 'follower',
    leaderID: null,
    commitIndex: Number(loaded.commitIndex || 0),
    lastApplied: Number(loaded.lastApplied || 0),
    log: Array.isArray(loaded.log) ? loaded.log : [],
  };
  let electionDeadline = Date.now() + electionTimeout();
  let heartbeatTimer;

  function save() { fs.writeJsonSync(stateFile, state, { spaces: 2 }); }
  function lastEntry() { return state.log[state.log.length - 1] || null; }
  function lastIndex() { return Number(lastEntry()?.index || 0); }
  function lastTerm() { return Number(lastEntry()?.term || 0); }
  function entryAt(index) { return state.log.find((entry) => Number(entry.index) === Number(index)); }
  function secret() { return process.env.TEE_RAFT_SHARED_SECRET || ''; }
  function timeoutReset() { electionDeadline = Date.now() + electionTimeout(); }
  function electionTimeout() {
    const seed = nodeID.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return 2500 + (seed % 700) + Math.floor(Math.random() * 1800);
  }

  function rpcPayload(senderID, timestamp, route, body) {
    return [senderID, String(timestamp), route, stableStringify(body || {})].join('\n');
  }

  function authHeaders(route, body) {
    const timestamp = Date.now();
    return {
      'content-type': 'application/json',
      'x-mercury-node-id': nodeID,
      'x-mercury-raft-ts': String(timestamp),
      'x-mercury-raft-signature': crypto.createHmac('sha256', secret())
        .update(rpcPayload(nodeID, timestamp, route, body)).digest('hex'),
    };
  }

  function authenticate(req, res, next) {
    if (!req.path.startsWith('/internal/raft/')) return next();
    try {
      if (clusterSize === 1 && process.env.TEE_RAFT_AUTH_REQUIRED !== 'true') return next();
      if (!secret()) throw new Error('TEE_RAFT_SHARED_SECRET is required');
      const sender = String(req.get('x-mercury-node-id') || '');
      const timestamp = Number(req.get('x-mercury-raft-ts') || 0);
      const signature = String(req.get('x-mercury-raft-signature') || '');
      if (!peers.some((peer) => peer.id === sender)) throw new Error('unknown Raft sender');
      if (!timestamp || Math.abs(Date.now() - timestamp) > 30_000) throw new Error('stale Raft RPC');
      const expected = crypto.createHmac('sha256', secret())
        .update(rpcPayload(sender, timestamp, req.path, req.body)).digest('hex');
      const left = Buffer.from(signature, 'hex');
      const right = Buffer.from(expected, 'hex');
      if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) throw new Error('bad Raft authentication');
      next();
    } catch (error) {
      res.status(401).json({ ok: false, nodeID, error: error.message });
    }
  }
  app.use(authenticate);

  function stepDown(term, leaderID = null) {
    if (Number(term) > state.currentTerm) {
      state.currentTerm = Number(term);
      state.votedFor = null;
    }
    state.role = 'follower';
    state.leaderID = leaderID;
    timeoutReset();
    save();
  }

  app.post('/internal/raft/request-vote', (req, res) => {
    const { term, candidateID, lastLogIndex, lastLogTerm } = req.body || {};
    if (Number(term) < state.currentTerm) return res.json({ nodeID, term: state.currentTerm, voteGranted: false });
    if (Number(term) > state.currentTerm) stepDown(term);
    const upToDate = Number(lastLogTerm) > lastTerm()
      || (Number(lastLogTerm) === lastTerm() && Number(lastLogIndex) >= lastIndex());
    const grant = upToDate && (!state.votedFor || state.votedFor === candidateID);
    if (grant) {
      state.votedFor = candidateID;
      timeoutReset();
      save();
    }
    res.json({ nodeID, term: state.currentTerm, voteGranted: grant });
  });

  app.post('/internal/raft/append-entries', async (req, res) => {
    try {
      const { term, leaderID, prevLogIndex, prevLogTerm, entries = [], leaderCommit = 0 } = req.body || {};
      if (Number(term) < state.currentTerm) {
        return res.json({ nodeID, term: state.currentTerm, success: false, matchIndex: lastIndex() });
      }
      stepDown(term, leaderID);
      const previous = Number(prevLogIndex) === 0 ? { term: 0 } : entryAt(prevLogIndex);
      if (!previous || Number(previous.term) !== Number(prevLogTerm)) {
        return res.json({ nodeID, term: state.currentTerm, success: false, matchIndex: lastIndex() });
      }
      for (const incoming of entries) {
        const identical = entryAt(incoming.index);
        if (identical?.entryDigest === incoming.entryDigest) continue;
        await verifyOperation(incoming.operationType, incoming.payload, incoming.proof);
        if (String(incoming.signingDigest).toLowerCase() !== String(incoming.verifiedDigest).toLowerCase()) {
          throw new Error('Raft entry signing digest was not locally verified');
        }
        const existing = entryAt(incoming.index);
        if (existing && existing.entryDigest !== incoming.entryDigest) {
          state.log = state.log.filter((item) => Number(item.index) < Number(incoming.index));
        }
        if (!entryAt(incoming.index)) state.log.push({ ...incoming, status: 'pending' });
      }
      state.log.sort((a, b) => Number(a.index) - Number(b.index));
      state.commitIndex = Math.min(Number(leaderCommit), lastIndex());
      for (const item of state.log) if (Number(item.index) <= state.commitIndex) item.status = 'committed';
      state.lastApplied = state.commitIndex;
      save();
      res.json({ nodeID, term: state.currentTerm, success: true, matchIndex: lastIndex(), commitIndex: state.commitIndex });
    } catch (error) {
      res.status(400).json({ nodeID, term: state.currentTerm, success: false, error: error.message, matchIndex: lastIndex() });
    }
  });

  app.post('/internal/raft/sign-committed', async (req, res) => {
    try {
      const entry = state.log.find((item) => item.entryDigest === req.body?.entryDigest);
      if (!entry || Number(entry.index) > state.commitIndex || entry.status !== 'committed') {
        throw new Error('entry is not committed');
      }
      res.json({ nodeID, signature: await identity.sign(entry) });
    } catch (error) {
      res.status(400).json({ nodeID, error: error.message });
    }
  });

  async function rpc(peer, route, body) {
    const response = await fetch(`${peer.url}${route}`, {
      method: 'POST', headers: authHeaders(route, body), body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Raft HTTP ${response.status}`);
    return data;
  }

  async function startElection() {
    state.role = 'candidate';
    state.currentTerm += 1;
    state.votedFor = nodeID;
    state.leaderID = null;
    timeoutReset();
    save();
    let votes = 1;
    await Promise.all(peers.map(async (peer) => {
      try {
        const result = await rpc(peer, '/internal/raft/request-vote', {
          term: state.currentTerm, candidateID: nodeID, lastLogIndex: lastIndex(), lastLogTerm: lastTerm(),
        });
        if (Number(result.term) > state.currentTerm) return stepDown(result.term);
        if (result.voteGranted) votes += 1;
      } catch (_error) { /* unavailable peers are tolerated up to f */ }
    }));
    if (votes >= majority && state.role === 'candidate') {
      state.role = 'leader';
      state.leaderID = nodeID;
      save();
      return true;
    }
    state.role = 'follower';
    save();
    return false;
  }

  function appendPayload(entries, leaderCommit = state.commitIndex) {
    const first = entries[0];
    const prevLogIndex = first ? Number(first.index) - 1 : lastIndex();
    return {
      term: state.currentTerm,
      leaderID: nodeID,
      prevLogIndex,
      prevLogTerm: Number(entryAt(prevLogIndex)?.term || 0),
      entries,
      leaderCommit,
    };
  }

  async function replicate(peer, entry) {
    let next = Number(entry.index);
    for (let attempt = 0; attempt < Math.max(4, lastIndex() + 1); attempt += 1) {
      const entries = state.log.filter((item) => Number(item.index) >= next);
      const result = await rpc(peer, '/internal/raft/append-entries', appendPayload(entries));
      if (Number(result.term) > state.currentTerm) {
        stepDown(result.term);
        return { nodeID: peer.id, accepted: false };
      }
      if (result.success && Number(result.matchIndex) >= Number(entry.index)) {
        return { nodeID: peer.id, accepted: true };
      }
      next = Math.max(1, next - 1);
    }
    return { nodeID: peer.id, accepted: false };
  }

  async function ensureLeaderOrForward(route, body) {
    if (state.role === 'leader') return null;
    const leader = peers.find((peer) => peer.id === state.leaderID);
    if (!leader && !(await startElection())) throw new Error('Raft majority unavailable');
    if (state.role === 'leader') return null;
    const response = await fetch(`${leader.url}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  async function commit(operationType, payload, proof, signingDigest, requestID = ethers.ZeroHash) {
    if (state.role !== 'leader') throw new Error('Raft commit requires leader');
    const verifiedDigest = await verifyOperation(operationType, payload, proof);
    if (String(verifiedDigest).toLowerCase() !== String(signingDigest).toLowerCase()) {
      throw new Error('requested digest does not match locally verified operation');
    }
    const entry = {
      index: lastIndex() + 1,
      term: state.currentTerm,
      operationType,
      requestID,
      signingDigest,
      verifiedDigest,
      payload,
      proof,
      status: 'pending',
      createdAt: Date.now(),
    };
    entry.entryDigest = ethers.keccak256(ethers.toUtf8Bytes(stableStringify(entry)));
    state.log.push(entry);
    save();
    const acks = [{ nodeID, accepted: true }];
    await Promise.all(peers.map(async (peer) => {
      try { acks.push(await replicate(peer, entry)); }
      catch (error) { acks.push({ nodeID: peer.id, accepted: false, error: error.message }); }
    }));
    if (acks.filter((ack) => ack.accepted).length < majority) throw new Error('Raft entry did not reach majority');
    entry.status = 'committed';
    state.commitIndex = entry.index;
    state.lastApplied = entry.index;
    save();
    const committedPeers = acks.filter((ack) => ack.accepted && ack.nodeID !== nodeID);
    await Promise.all(committedPeers.map(async (ack) => {
      const peer = peers.find((item) => item.id === ack.nodeID);
      try { await rpc(peer, '/internal/raft/append-entries', appendPayload([], state.commitIndex)); }
      catch (_error) { /* signature collection below reports missing peers */ }
    }));

    const signatures = [await identity.sign(entry)];
    await Promise.all(committedPeers.map(async (ack) => {
      const peer = peers.find((item) => item.id === ack.nodeID);
      try {
        const result = await rpc(peer, '/internal/raft/sign-committed', { entryDigest: entry.entryDigest });
        if (result.signature) signatures.push(result.signature);
      } catch (_error) { /* quorum checked below */ }
    }));
    if (signatures.length < threshold) throw new Error(`committed signatures below threshold: ${signatures.length}/${threshold}`);
    const certificate = buildQuorumCertificate({
      signatures: signatures.slice(0, threshold),
      signingDigest,
      term: entry.term,
      index: entry.index,
      threshold,
    });
    return { certificate, signatureDetails: signatures.slice(0, threshold), entry, acks };
  }

  async function heartbeat() {
    if (state.role !== 'leader') return;
    await Promise.all(peers.map(async (peer) => {
      try { await rpc(peer, '/internal/raft/append-entries', appendPayload([], state.commitIndex)); }
      catch (_error) { /* normal while an operator is down */ }
    }));
  }

  heartbeatTimer = setInterval(() => {
    if (state.role === 'leader') heartbeat();
    else if (Date.now() > electionDeadline) startElection().catch(() => timeoutReset());
  }, 750);
  heartbeatTimer.unref();

  function status() {
    return {
      nodeID, role: state.role, leaderID: state.leaderID, currentTerm: state.currentTerm,
      commitIndex: state.commitIndex, lastApplied: state.lastApplied, lastLogIndex: lastIndex(),
      clusterSize, majority, threshold,
    };
  }

  return { commit, ensureLeaderOrForward, status, startElection, close: () => clearInterval(heartbeatTimer) };
}

module.exports = { createMercuryRaft };
