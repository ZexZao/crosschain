const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { loadDotEnv } = require('../shared/env');

loadDotEnv();

const PROJECT_ROOT = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, 'runtime');
const localDeployment = path.join(RUNTIME_DIR, 'deployment.json');
const sepoliaDeployment = process.env.SEPOLIA_DEPLOYMENT_FILE
  || path.join(RUNTIME_DIR, 'deployment.sepolia.json');
const backupDeployment = path.join(RUNTIME_DIR, 'deployment.before-sepolia-auto.json');

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

async function main() {
  fs.ensureDirSync(RUNTIME_DIR);
  requiredEnv('SEPOLIA_RPC_URL');
  requiredEnv('SEPOLIA_PRIVATE_KEY');
  if (!process.env.SEPOLIA_LIGHT_CLIENT_BEACON_API_URL && !process.env.SEPOLIA_BEACON_API_URL) {
    throw new Error('SEPOLIA_LIGHT_CLIENT_BEACON_API_URL or SEPOLIA_BEACON_API_URL is required');
  }
  if (!fs.existsSync(sepoliaDeployment)) {
    throw new Error(`Sepolia deployment file not found: ${sepoliaDeployment}`);
  }

  const hadLocalDeployment = fs.existsSync(localDeployment);
  if (hadLocalDeployment) fs.copyFileSync(localDeployment, backupDeployment);
  fs.copyFileSync(sepoliaDeployment, localDeployment);

  const env = {
    ...process.env,
    USE_SEPOLIA_SYNC_COMMITTEE: 'true',
    HXMSG_CASE_TOTAL: process.env.HXMSG_CASE_TOTAL || process.env.HXMSG_CASE_LIMIT || '1',
    HXMSG_CASE_LIMIT: process.env.HXMSG_CASE_LIMIT || '1',
    HXMSG_SOURCE_CONCURRENCY: process.env.HXMSG_SOURCE_CONCURRENCY || '1',
    HXMSG_PROOF_CONCURRENCY: process.env.HXMSG_PROOF_CONCURRENCY || '1',
    HXMSG_TEE_CONCURRENCY: process.env.HXMSG_TEE_CONCURRENCY || '1',
    HXMSG_FABRIC_CONCURRENCY: process.env.HXMSG_FABRIC_CONCURRENCY || '1',
    SEPOLIA_FINALITY_TIMEOUT_MS: process.env.SEPOLIA_FINALITY_TIMEOUT_MS || String(20 * 60 * 1000),
  };

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'run-evm-fabric-tests.js')], {
        cwd: PROJECT_ROOT,
        env,
        stdio: 'inherit',
      });
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Sepolia EVM->Fabric test failed with exit code ${code}`));
      });
      child.on('error', reject);
    });
  } finally {
    if (hadLocalDeployment) fs.copyFileSync(backupDeployment, localDeployment);
    else fs.removeSync(localDeployment);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
