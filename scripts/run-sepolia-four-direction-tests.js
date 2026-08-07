const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { spawn } = require('child_process');
const { loadDotEnv } = require('../shared/env');

loadDotEnv();

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const AUTOMATION_URL = String(process.env.AUTOMATION_URL || 'http://127.0.0.1:9200').replace(/\/$/, '');
const REQUIRED_CHAINS = ['ethereum', 'avalanche', 'sepolia'];
const FINALITY_TIMEOUT_MS = Number(process.env.SEPOLIA_FINALITY_TIMEOUT_MS || 40 * 60 * 1000);
const PREFLIGHT_ONLY = process.env.SEPOLIA_FOUR_DIRECTION_PREFLIGHT_ONLY === 'true';
const SUMMARY_FILE = path.join(RUNTIME, 'sepolia-four-direction-automation-result.json');
const LOCAL_EVM_FUNDER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const LOCAL_AVALANCHE_FUNDER_KEY = '0x56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027';
const LOCAL_CHAINS = [
  {
    label: 'local Ethereum',
    rpcURL: process.env.EVM_RPC || 'http://127.0.0.1:8545',
    chainID: 31337,
    deploymentFile: path.join(RUNTIME, 'deployment.json'),
    deployScript: 'deploy',
    privateKeyEnv: 'LOCAL_EVM_PRIVATE_KEY',
    funderKey: LOCAL_EVM_FUNDER_KEY,
    fundingAmount: '100',
    requiredFields: ['evmSourceContract', 'targetContract', 'teeRegistry', 'hxmsgGateway', 'settlementToken'],
  },
  {
    label: 'local Avalanche',
    rpcURL: process.env.AVALANCHE_RPC_URL || 'http://127.0.0.1:9650/ext/bc/C/rpc',
    chainID: 1337,
    deploymentFile: path.join(RUNTIME, 'avalanche-deployment.json'),
    deployScript: 'deploy:avalanche',
    privateKeyEnv: 'AVALANCHE_PRIVATE_KEY',
    funderKey: LOCAL_AVALANCHE_FUNDER_KEY,
    fundingAmount: '100',
    requiredFields: [
      'evmSourceContract',
      'avalancheWarpSourceContract',
      'targetContract',
      'teeRegistry',
      'hxmsgGateway',
      'settlementToken',
    ],
  },
];

let activeSummary;

function persistSummarySync(summary) {
  fs.writeJsonSync(SUMMARY_FILE, summary, { spaces: 2 });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (activeSummary) {
      activeSummary.pass = false;
      activeSummary.interrupted = true;
      activeSummary.interruptedBy = signal;
      activeSummary.completedAt = new Date().toISOString();
      persistSummarySync(activeSummary);
    }
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

function runProcess(label, command, args, extraEnv = {}) {
  console.log(`\n=== ${label} ===`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: 'inherit',
    });
    child.on('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`${path.basename(args[0] || command)} exited ${code}`)));
    child.on('error', reject);
  });
}

async function waitForAutomation() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await axios.get(`${AUTOMATION_URL}/health`, { timeout: 5000 });
      const enabled = response.data?.enabledChains || [];
      if (response.data?.ok && REQUIRED_CHAINS.every((name) => enabled.includes(name))) return response.data;
    } catch (_error) {
      // Docker may briefly return 502 while the Node process starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`automation did not become healthy with chains=${REQUIRED_CHAINS.join(',')}`);
}

async function waitForRPC(chain) {
  const provider = new ethers.JsonRpcProvider(chain.rpcURL, chain.chainID, { staticNetwork: true });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      const network = await provider.getNetwork();
      if (Number(network.chainId) === chain.chainID) {
        console.log(`${chain.label.toUpperCase()} RPC PASS chainID=${network.chainId}`);
        return provider;
      }
    } catch (_error) {
      // The local nodes need a short warm-up after Docker/Avalanche CLI returns.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${chain.label} RPC did not become ready at ${chain.rpcURL}`);
}

async function createFundedDeploymentAccount(chain, provider) {
  const account = ethers.Wallet.createRandom();
  const funder = new ethers.Wallet(chain.funderKey, provider);
  const tx = await funder.sendTransaction({
    to: account.address,
    value: ethers.parseEther(chain.fundingAmount),
  });
  await tx.wait();
  process.env[chain.privateKeyEnv] = account.privateKey;
  return account.address;
}

async function assertDeploymentIsLive(chain, provider) {
  const deployment = await fs.readJson(chain.deploymentFile);
  for (const field of chain.requiredFields) {
    if (!deployment[field] || await provider.getCode(deployment[field]) === '0x') {
      throw new Error(`${chain.label} deployment has no live ${field}`);
    }
  }
  return deployment;
}

async function prepareLocalInfrastructure() {
  await runProcess(
    'start local Ethereum/Avalanche and TEE subnets',
    process.execPath,
    [path.join(ROOT, 'scripts', 'manage-chain-pair.js'), 'up', 'evm-avalanche']
  );
  const providers = await Promise.all(LOCAL_CHAINS.map(waitForRPC));
  const deployments = [];
  for (let index = 0; index < LOCAL_CHAINS.length; index += 1) {
    const chain = LOCAL_CHAINS[index];
    const deployer = await createFundedDeploymentAccount(chain, providers[index]);
    await runProcess(`${chain.label} fresh contract deployment`, 'npm', ['run', chain.deployScript]);
    const deployment = await assertDeploymentIsLive(chain, providers[index]);
    if (deployment.deployer.toLowerCase() !== deployer.toLowerCase()) {
      throw new Error(`${chain.label} deployment did not use the isolated experiment account`);
    }
    deployments.push({ label: chain.label, deployer, reused: false, deploymentFile: chain.deploymentFile });
  }
  return deployments;
}

async function configureAutomation() {
  await runProcess('stop previous automation workers', 'docker', ['compose', 'stop', 'automation']);
  await fs.remove(path.join(RUNTIME, 'automation-tasks.json'));
  await runProcess(
    'automation configure ethereum,avalanche,sepolia',
    'docker',
    ['compose', 'up', '-d', '--force-recreate', 'automation'],
    { AUTOMATION_ENABLED_CHAINS: REQUIRED_CHAINS.join(',') }
  );
  const health = await waitForAutomation();
  console.log(`AUTOMATION PASS chains=${health.enabledChains.join(',')}`);
}

function normalizeResult(test, raw, elapsedMs) {
  if (!raw?.pass) throw new Error(`${test.direction} result did not pass`);
  if (raw.relayerState !== 'COMPLETED') throw new Error(`${test.direction} Relayer state is ${raw.relayerState}`);
  if (!raw.watcherRegistered) throw new Error(`${test.direction} Watcher policy task did not complete`);
  const sourceGas = Number(raw.sourceGasUsed || 0);
  const targetGas = Number(raw.targetResult?.gasUsed || 0);
  return {
    direction: test.direction,
    sourceProfile: test.sourceProfile,
    targetProfile: test.targetProfile,
    pass: true,
    requestID: raw.requestID,
    sourceTransactionHash: raw.sourceTxHash,
    targetTransactionHash: raw.targetResult?.transactionHash,
    sourceGasUsed: sourceGas,
    targetGasUsed: targetGas,
    protocolGasTotal: sourceGas + targetGas,
    finalityWaitMs: Number(raw.timings?.finalityWaitMs || 0),
    executionWithoutFinalityMs: Math.max(0, elapsedMs - Number(raw.timings?.finalityWaitMs || 0)),
    elapsedMs,
    teeAdapter: raw.teeVerification?.adapter,
    watcherChecked: raw.watcherRegistered,
    realAction: raw.realAction,
    resultFile: path.relative(ROOT, test.resultFile),
  };
}

async function runDirection(test) {
  await fs.remove(test.resultFile);
  const startedAt = Date.now();
  await runProcess(test.direction, process.execPath, [path.join(ROOT, 'scripts', test.script)], {
    ...test.env,
    AUTOMATION_CLIENT_TIMEOUT_MS: process.env.AUTOMATION_CLIENT_TIMEOUT_MS || '30000',
    AUTOMATION_WORKFLOW_TIMEOUT_MS: String(FINALITY_TIMEOUT_MS),
    SEPOLIA_FINALITY_TIMEOUT_MS: String(FINALITY_TIMEOUT_MS),
  });
  const elapsedMs = Date.now() - startedAt;
  if (!await fs.pathExists(test.resultFile)) throw new Error(`${test.direction} result file missing`);
  return normalizeResult(test, await fs.readJson(test.resultFile), elapsedMs);
}

async function main() {
  const summary = {
    testType: 'sepolia-four-direction-automation-e2e',
    testedAt: new Date().toISOString(),
    executionMode: 'serial-to-avoid-sepolia-nonce-conflicts',
    finalityTimeoutMs: FINALITY_TIMEOUT_MS,
    preflightOnly: PREFLIGHT_ONLY,
    cases: [],
    pass: false,
  };
  activeSummary = summary;
  persistSummarySync(summary);
  const tests = [
    {
      direction: 'local-ethereum->Sepolia',
      sourceProfile: 'ethereum',
      targetProfile: 'sepolia',
      script: 'run-automation-evm-evm-e2e.js',
      resultFile: path.join(RUNTIME, 'automation-ethereum-sepolia-e2e-result.json'),
      env: {
        AUTOMATION_EVM_SOURCE_PROFILE: 'ethereum',
        AUTOMATION_EVM_TARGET_PROFILE: 'sepolia',
        AUTOMATION_EVM_EVM_RESULT_FILE: 'automation-ethereum-sepolia-e2e-result.json',
      },
    },
    {
      direction: 'local-avalanche->Sepolia',
      sourceProfile: 'avalanche',
      targetProfile: 'sepolia',
      script: 'run-automation-avalanche-evm-e2e.js',
      resultFile: path.join(RUNTIME, 'automation-avalanche-sepolia-e2e-result.json'),
      env: {
        AUTOMATION_EVM_TARGET_PROFILE: 'sepolia',
        AUTOMATION_AVALANCHE_EVM_RESULT_FILE: 'automation-avalanche-sepolia-e2e-result.json',
      },
    },
    {
      direction: 'Sepolia->local-ethereum',
      sourceProfile: 'sepolia',
      targetProfile: 'ethereum',
      script: 'run-automation-evm-evm-e2e.js',
      resultFile: path.join(RUNTIME, 'automation-sepolia-ethereum-e2e-result.json'),
      env: {
        AUTOMATION_EVM_SOURCE_PROFILE: 'sepolia',
        AUTOMATION_EVM_TARGET_PROFILE: 'ethereum',
        AUTOMATION_EVM_EVM_RESULT_FILE: 'automation-sepolia-ethereum-e2e-result.json',
      },
    },
    {
      direction: 'Sepolia->local-avalanche',
      sourceProfile: 'sepolia',
      targetProfile: 'avalanche',
      script: 'run-automation-evm-evm-e2e.js',
      resultFile: path.join(RUNTIME, 'automation-sepolia-avalanche-e2e-result.json'),
      env: {
        AUTOMATION_EVM_SOURCE_PROFILE: 'sepolia',
        AUTOMATION_EVM_TARGET_PROFILE: 'avalanche',
        AUTOMATION_EVM_EVM_RESULT_FILE: 'automation-sepolia-avalanche-e2e-result.json',
      },
    },
  ];

  try {
    summary.phase = 'PREPARING_LOCAL_INFRASTRUCTURE';
    persistSummarySync(summary);
    summary.localDeployments = await prepareLocalInfrastructure();
    summary.phase = 'CONFIGURING_AUTOMATION';
    persistSummarySync(summary);
    await configureAutomation();
    summary.phase = 'PREFLIGHT';
    persistSummarySync(summary);
    await runProcess('four-direction preflight', process.execPath, [
      path.join(ROOT, 'scripts', 'run-sepolia-four-direction-preflight.js'),
    ]);
    summary.preflight = await fs.readJson(path.join(RUNTIME, 'sepolia-four-direction-preflight.json'));
    persistSummarySync(summary);
    if (PREFLIGHT_ONLY) {
      summary.pass = true;
      console.log('PREFLIGHT-ONLY PASS: no cross-chain source transaction was submitted');
      return;
    }
    for (const test of tests) {
      summary.phase = 'RUNNING_DIRECTION';
      summary.currentDirection = {
        direction: test.direction,
        sourceProfile: test.sourceProfile,
        targetProfile: test.targetProfile,
        startedAt: new Date().toISOString(),
        resultFile: path.relative(ROOT, test.resultFile),
      };
      persistSummarySync(summary);
      summary.cases.push(await runDirection(test));
      delete summary.currentDirection;
      persistSummarySync(summary);
    }
    summary.pass = summary.cases.length === tests.length && summary.cases.every((item) => item.pass);
    summary.phase = 'COMPLETED';
  } catch (error) {
    summary.phase = 'FAILED';
    summary.error = error.message;
    throw error;
  } finally {
    summary.completedAt = new Date().toISOString();
    persistSummarySync(summary);
    activeSummary = undefined;
  }

  for (const item of summary.cases) {
    console.log(`${item.direction} PASS sourceGas=${item.sourceGasUsed} targetGas=${item.targetGasUsed} finalityWaitMs=${item.finalityWaitMs} elapsedMs=${item.elapsedMs}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
