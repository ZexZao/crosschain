const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { execFileSync } = require('child_process');

const projectRoot = path.join(__dirname, '..');
const runtimeDir = path.join(projectRoot, 'runtime');
const TEE_PORTS = {
  'tee-verifier-1': 9000,
  'tee-verifier-2': 9001,
  'tee-verifier-3': 9002,
  'tee-verifier-4': 9003,
  'tee-verifier-5': 9004,
};
const SERVICE_BY_NODE = {
  'tee-verifier-1': 'tee-verifier',
  'tee-verifier-2': 'tee-verifier-2',
  'tee-verifier-3': 'tee-verifier-3',
  'tee-verifier-4': 'tee-verifier-4',
  'tee-verifier-5': 'tee-verifier-5',
};

function nowMs() {
  return Date.now();
}

function dockerCompose(args) {
  execFileSync('docker', ['compose', ...args], {
    cwd: projectRoot,
    stdio: 'pipe',
    env: {
      ...process.env,
      TEE_RAFT_SHARED_SECRET: process.env.TEE_RAFT_SHARED_SECRET || 'local-raft-dev-secret',
    },
  });
}

async function statusOf(nodeID, timeout = 1500) {
  const port = TEE_PORTS[nodeID];
  const resp = await axios.get(`http://127.0.0.1:${port}/raft/status`, { timeout, proxy: false });
  return resp.data;
}

async function allStatuses() {
  const out = [];
  for (const nodeID of Object.keys(TEE_PORTS)) {
    try {
      out.push({ ok: true, ...(await statusOf(nodeID)) });
    } catch (error) {
      out.push({ ok: false, nodeID, error: error.message });
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForClusterSize(size, timeoutMs = 30000) {
  const started = nowMs();
  while (nowMs() - started < timeoutMs) {
    const statuses = await allStatuses();
    if (statuses.filter((item) => item.ok).length >= size) return statuses;
    await sleep(1000);
  }
  throw new Error(`cluster did not reach ${size} reachable nodes`);
}

async function waitForLeader(excludedLeader = null, timeoutMs = 30000) {
  const started = nowMs();
  while (nowMs() - started < timeoutMs) {
    const statuses = await allStatuses();
    const leaders = statuses.filter((item) => item.ok && item.role === 'leader');
    const leader = leaders.find((item) => !excludedLeader || item.nodeID !== excludedLeader);
    if (leader) return { leader, statuses };
    await sleep(1000);
  }
  throw new Error('leader election timed out');
}

async function waitForStableLeader(timeoutMs = 30000, stablePolls = 3) {
  const started = nowMs();
  let consecutive = 0;
  while (nowMs() - started < timeoutMs) {
    const statuses = await allStatuses();
    const reachable = statuses.filter((item) => item.ok);
    const leaders = reachable.filter((item) => item.role === 'leader');
    const leader = leaders[0];
    const converged = reachable.length === Object.keys(TEE_PORTS).length
      && leaders.length === 1
      && reachable.every((item) => Number(item.term) === Number(leader.term))
      && reachable.every((item) => item.nodeID === leader.nodeID || item.leaderID === leader.nodeID);
    consecutive = converged ? consecutive + 1 : 0;
    if (consecutive >= stablePolls) return { leader, statuses };
    await sleep(1000);
  }
  throw new Error('cluster did not converge to one stable leader');
}

async function runCase(results, caseId, name, fn) {
  const started = nowMs();
  try {
    const detail = await fn();
    results.push({ caseId, name, pass: true, durationMs: nowMs() - started, detail });
    console.log(`${caseId} PASS ${name}`);
  } catch (error) {
    results.push({ caseId, name, pass: false, durationMs: nowMs() - started, error: error.message });
    console.error(`${caseId} FAIL ${name}: ${error.message}`);
  }
}

function writeResults(payload) {
  fs.ensureDirSync(runtimeDir);
  const jsonPath = path.join(runtimeDir, 'raft-cluster-test-results.json');
  const mdPath = path.join(runtimeDir, 'raft-cluster-test-summary.md');
  fs.writeJSONSync(jsonPath, payload, { spaces: 2 });
  let md = '# Raft TEE Cluster Test Results\n\n';
  md += `Tested at: ${payload.testedAt}\n\n`;
  md += `Result: ${payload.pass}/${payload.total} passed\n\n`;
  md += '| Case | Name | Status | Duration(ms) |\n';
  md += '|---|---|---:|---:|\n';
  for (const item of payload.results) {
    md += `| ${item.caseId} | ${item.name} | ${item.pass ? 'PASS' : 'FAIL'} | ${item.durationMs} |\n`;
  }
  md += '\n';
  md += 'Covered scenarios: authenticated internal Raft RPC, leader election, follower crash/rejoin, leader crash/re-election/rejoin.\n';
  fs.writeFileSync(mdPath, md);
  return { jsonPath, mdPath };
}

async function main() {
  const results = [];
  console.log('Starting EVM + TEE Raft cluster...');
  dockerCompose(['up', '-d', 'evm-node', 'tee-verifier', 'tee-verifier-2', 'tee-verifier-3', 'tee-verifier-4', 'tee-verifier-5']);
  await waitForClusterSize(5, 90000);

  await runCase(results, 'RAFT-001', 'internal Raft RPC rejects unauthenticated request', async () => {
    try {
      await axios.post('http://127.0.0.1:9000/internal/raft/request-vote', {
        term: 9999,
        candidateID: 'tee-verifier-2',
        lastLogIndex: 0,
        lastLogTerm: 0,
      }, { timeout: 2000, proxy: false });
    } catch (error) {
      if (error.response?.status === 401) return { rejected: true };
      throw error;
    }
    throw new Error('unauthenticated Raft RPC was accepted');
  });

  let initialLeaderID;
  await runCase(results, 'RAFT-002', 'cluster elects a leader with five nodes', async () => {
    const { leader, statuses } = await waitForLeader(null, 30000);
    initialLeaderID = leader.nodeID;
    return {
      leaderID: leader.nodeID,
      term: leader.term,
      reachable: statuses.filter((item) => item.ok).length,
    };
  });

  let stoppedFollowerID;
  await runCase(results, 'RAFT-003', 'single follower crash keeps majority service available', async () => {
    const statuses = await waitForClusterSize(5, 30000);
    const follower = statuses.find((item) => item.ok && item.nodeID !== initialLeaderID);
    if (!follower) throw new Error('no follower available to stop');
    stoppedFollowerID = follower.nodeID;
    dockerCompose(['stop', SERVICE_BY_NODE[stoppedFollowerID]]);
    await sleep(3000);
    const afterStop = await allStatuses();
    const reachable = afterStop.filter((item) => item.ok).length;
    if (reachable < 4) throw new Error(`expected at least 4 reachable nodes, got ${reachable}`);
    const { leader } = await waitForLeader(null, 15000);
    return { stoppedFollowerID, reachable, leaderID: leader.nodeID };
  });

  await runCase(results, 'RAFT-004', 'stopped follower rejoins cluster', async () => {
    if (!stoppedFollowerID) throw new Error('no stopped follower from previous case');
    dockerCompose(['start', SERVICE_BY_NODE[stoppedFollowerID]]);
    const statuses = await waitForClusterSize(5, 30000);
    return { restartedFollowerID: stoppedFollowerID, reachable: statuses.filter((item) => item.ok).length };
  });

  let stoppedLeaderID;
  await runCase(results, 'RAFT-005', 'leader crash triggers re-election in remaining majority', async () => {
    const { leader } = await waitForLeader(null, 30000);
    stoppedLeaderID = leader.nodeID;
    dockerCompose(['stop', SERVICE_BY_NODE[stoppedLeaderID]]);
    await sleep(4000);
    const elected = await waitForLeader(stoppedLeaderID, 30000);
    return { stoppedLeaderID, newLeaderID: elected.leader.nodeID, term: elected.leader.term };
  });

  await runCase(results, 'RAFT-006', 'old leader rejoins and observes current cluster', async () => {
    if (!stoppedLeaderID) throw new Error('no stopped leader from previous case');
    dockerCompose(['start', SERVICE_BY_NODE[stoppedLeaderID]]);
    const statuses = await waitForClusterSize(5, 30000);
    const elected = await waitForStableLeader(30000);
    const finalStatuses = elected.statuses;
    const leaders = finalStatuses.filter((item) => item.ok && item.role === 'leader');
    if (leaders.length !== 1) throw new Error(`expected one leader after rejoin, got ${leaders.length}`);
    return {
      restartedLeaderID: stoppedLeaderID,
      leaderIDs: leaders.map((item) => item.nodeID),
      reachable: statuses.filter((item) => item.ok).length,
    };
  });

  const pass = results.filter((item) => item.pass).length;
  const payload = {
    testType: 'raft-tee-cluster-fault-tests',
    testedAt: new Date().toISOString(),
    total: results.length,
    pass,
    fail: results.length - pass,
    results,
  };
  const files = writeResults(payload);
  console.log(`FINAL ${pass}/${results.length} passed, ${results.length - pass} failed`);
  console.log(`Results: ${files.jsonPath}`);
  if (pass !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
