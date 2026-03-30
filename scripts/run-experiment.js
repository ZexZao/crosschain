const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const { ethers } = require('ethers');
const { readJSON, writeJSON } = require('../shared/utils');

const projectRoot = path.join(__dirname, '..');
const defaultFunctionalDataset = path.join(projectRoot, 'test-data', 'functional-cases.json');

function runNodeScript(scriptPath, args = []) {
  return execFileSync(process.execPath, [path.join(projectRoot, scriptPath), ...args], {
    stdio: 'pipe',
    cwd: projectRoot,
    encoding: 'utf8'
  });
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const options = {
    mode: 'normal',
    dataset: null,
    caseId: null,
    payload: null
  };

  if (args[0] && !args[0].startsWith('--')) {
    options.mode = args.shift();
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--dataset') {
      options.dataset = args[i + 1];
      i += 1;
    } else if (arg === '--case') {
      options.caseId = args[i + 1];
      i += 1;
    } else if (arg === '--payload') {
      options.payload = args[i + 1];
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      printUsageAndExit();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printUsageAndExit() {
  console.log(`
Usage:
  node scripts/run-experiment.js <mode>
  node scripts/run-experiment.js <mode> --dataset <file> --case <case-id>
  node scripts/run-experiment.js normal --payload '{"op":"demo"}'

Examples:
  node scripts/run-experiment.js normal
  node scripts/run-experiment.js normal --dataset test-data/functional-cases.json --case FUNC-001
  node scripts/run-experiment.js normal --dataset test-data/performance-cases.json --case PERF-009
  node scripts/run-experiment.js replay --dataset test-data/security-cases.json --case SEC-003
`);
  process.exit(0);
}

function loadDataset(datasetPath) {
  const resolved = path.resolve(projectRoot, datasetPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Dataset file not found: ${resolved}`);
  }
  const dataset = fs.readJsonSync(resolved);
  return { resolved, dataset };
}

function findCase(dataset, caseId) {
  const found = (dataset.cases || []).find((item) => item.caseId === caseId);
  if (!found) {
    throw new Error(`Case not found: ${caseId}`);
  }
  return found;
}

function resolvePayloadContext(options) {
  if (options.payload) {
    const payload = JSON.parse(options.payload);
    return {
      payload,
      meta: {
        payloadSource: 'inline',
        caseId: null,
        dataset: null
      }
    };
  }

  if (!options.dataset || !options.caseId) {
    return {
      payload: { op: 'demo', mode: options.mode, ts: Date.now() },
      meta: {
        payloadSource: 'default',
        caseId: null,
        dataset: null
      }
    };
  }

  const { resolved, dataset } = loadDataset(options.dataset);
  const selectedCase = findCase(dataset, options.caseId);

  let payloadCase = selectedCase;
  let payloadDatasetPath = resolved;
  if (!payloadCase.payload) {
    if (!selectedCase.referenceCaseId) {
      throw new Error(`Case ${selectedCase.caseId} does not contain payload and has no referenceCaseId`);
    }
    const functional = loadDataset(defaultFunctionalDataset);
    payloadCase = findCase(functional.dataset, selectedCase.referenceCaseId);
    payloadDatasetPath = functional.resolved;
  }

  const finalMode = selectedCase.mode || selectedCase.expectedMode || options.mode;
  return {
    payload: payloadCase.payload,
    meta: {
      payloadSource: 'dataset',
      dataset: path.relative(projectRoot, resolved),
      payloadDataset: path.relative(projectRoot, payloadDatasetPath),
      caseId: selectedCase.caseId,
      payloadCaseId: payloadCase.caseId,
      caseInfo: selectedCase,
      finalMode
    }
  };
}

async function setMode(mode) {
  const mapping = {
    normal: 'normal',
    tamper: 'normal',
    replay: 'normal',
    forged: 'normal',
    rollback: 'normal'
  };
  await axios.post('http://127.0.0.1:9000/mode', { mode: mapping[mode] || 'normal' });
}

async function syncTeeStateWithChain() {
  const deployment = readJSON('deployment.json');
  if (!deployment) {
    throw new Error('deployment.json not found; run deploy first');
  }

  const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
  const verifier = new ethers.Contract(deployment.verifierContract, [
    'function lastCtr() view returns (uint64)',
    'function lastDigest() view returns (bytes32)'
  ], provider);

  const lastCtr = Number(await verifier.lastCtr());
  const lastDigest = await verifier.lastDigest();
  await axios.post('http://127.0.0.1:9000/rollback', { ctr: lastCtr, lastDigest });
}

function generateXmsg(payload) {
  const payloadText = JSON.stringify(payload);
  if (payloadText.length > 6000) {
    const tempPayloadPath = path.join(projectRoot, 'runtime', 'temp-payload.json');
    fs.writeFileSync(tempPayloadPath, payloadText);
    try {
      runNodeScript('source-chain/fabric-sim.js', ['--payload-file', tempPayloadPath]);
    } finally {
      fs.removeSync(tempPayloadPath);
    }
    return;
  }
  runNodeScript('source-chain/fabric-sim.js', [payloadText]);
}

function relay(mode) {
  runNodeScript('relayer/index.js', [mode]);
}

async function runRollbackScenario(result) {
  const tee = readJSON('tee-state.json');
  const deployment = readJSON('deployment.json');
  const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
  const verifier = new ethers.Contract(deployment.verifierContract, [
    'function lastCtr() view returns (uint64)',
    'function lastDigest() view returns (bytes32)'
  ], provider);

  relay('normal');
  const lastCtr = Number(await verifier.lastCtr());
  await axios.post('http://127.0.0.1:9000/rollback', {
    ctr: Math.max(0, lastCtr - 1),
    lastDigest: ethers.ZeroHash
  });

  generateXmsg({ op: 'demo2', mode: 'rollback', ts: Date.now() });
  relay('normal');

  result.expected = 'rollback attempt should fail because continuity breaks';
  result.observed = 'unexpected success';
  result.pass = false;

  await axios.post('http://127.0.0.1:9000/rollback', {
    ctr: tee.ctr,
    lastDigest: tee.lastDigest
  });
}

async function main() {
  const options = parseArgs(process.argv);
  const payloadContext = resolvePayloadContext(options);
  const mode = payloadContext.meta.finalMode || options.mode;
  const started = Date.now();
  const result = {
    mode,
    startedAt: new Date(started).toISOString(),
    dataset: payloadContext.meta.dataset,
    caseId: payloadContext.meta.caseId,
    payloadCaseId: payloadContext.meta.payloadCaseId,
    payloadSource: payloadContext.meta.payloadSource
  };

  if (payloadContext.meta.caseInfo) {
    result.caseInfo = payloadContext.meta.caseInfo;
  }
  if (payloadContext.meta.payloadDataset) {
    result.payloadDataset = payloadContext.meta.payloadDataset;
  }

  await setMode(mode);
  await syncTeeStateWithChain();
  generateXmsg(payloadContext.payload);

  try {
    if (mode === 'replay') {
      relay('normal');
      relay('normal');
      result.expected = 'second submit should fail';
      result.observed = 'unexpected success';
      result.pass = false;
    } else if (mode === 'tamper') {
      relay('tamper');
      result.expected = 'tampered payload should fail';
      result.observed = 'unexpected success';
      result.pass = false;
    } else if (mode === 'forged') {
      relay('forged');
      result.expected = 'forged proof should fail inside tee or verifier';
      result.observed = 'unexpected success';
      result.pass = false;
    } else if (mode === 'rollback') {
      await runRollbackScenario(result);
    } else {
      relay('normal');
      result.expected = 'success';
      result.observed = 'success';
      result.pass = true;
    }
  } catch (err) {
    result.error = err.stderr?.toString() || err.message;
    result.pass = mode !== 'normal';
    result.observed = 'reverted as expected';
  }

  result.durationMs = Date.now() - started;
  writeJSON(`experiment-${mode}.json`, result);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
