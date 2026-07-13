const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { loadDotEnv } = require('../shared/env');

loadDotEnv();

const PROJECT_ROOT = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, 'runtime');
const sepoliaDeployment = process.env.SEPOLIA_DEPLOYMENT_FILE
  || path.join(RUNTIME_DIR, 'deployment.sepolia.json');

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

async function main() {
  requiredEnv('SEPOLIA_RPC_URL');
  requiredEnv('SEPOLIA_PRIVATE_KEY');
  if (!fs.existsSync(sepoliaDeployment)) {
    throw new Error(`Sepolia deployment file not found: ${sepoliaDeployment}`);
  }
  if (!fs.existsSync(path.join(RUNTIME_DIR, 'avalanche-deployment.json'))) {
    throw new Error('runtime/avalanche-deployment.json is required; run npm run deploy:avalanche first');
  }

  const env = {
    ...process.env,
    TARGET_EVM_RPC: process.env.SEPOLIA_RPC_URL,
    TARGET_EVM_PRIVATE_KEY: process.env.SEPOLIA_PRIVATE_KEY,
    TARGET_EVM_DEPLOYMENT_FILE: sepoliaDeployment,
    AVALANCHE_ETHEREUM_RESULT_FILE: process.env.AVALANCHE_SEPOLIA_RESULT_FILE || 'avalanche-sepolia-warp-test-result.json',
    AVALANCHE_ETHEREUM_TEST_TYPE: 'avalanche-to-sepolia-real-warp',
    AVALANCHE_TARGET_LABEL: 'SEPOLIA',
  };

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'run-avalanche-ethereum-warp-test.js')], {
      cwd: PROJECT_ROOT,
      env,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Avalanche->Sepolia Warp test failed with exit code ${code}`));
    });
    child.on('error', reject);
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
