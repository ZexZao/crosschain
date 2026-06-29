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
const backupDeployment = path.join(RUNTIME_DIR, 'deployment.before-sepolia-fabric-evm-auto.json');

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

async function main() {
  fs.ensureDirSync(RUNTIME_DIR);
  requiredEnv('SEPOLIA_RPC_URL');
  requiredEnv('SEPOLIA_PRIVATE_KEY');
  if (!fs.existsSync(sepoliaDeployment)) {
    throw new Error(`Sepolia deployment file not found: ${sepoliaDeployment}`);
  }

  const hadLocalDeployment = fs.existsSync(localDeployment);
  if (hadLocalDeployment) fs.copyFileSync(localDeployment, backupDeployment);
  fs.copyFileSync(sepoliaDeployment, localDeployment);

  const env = {
    ...process.env,
    EVM_RPC: process.env.EVM_RPC || process.env.SEPOLIA_RPC_URL,
    DEPLOYER_PRIVATE_KEY: process.env.DEPLOYER_PRIVATE_KEY || process.env.SEPOLIA_PRIVATE_KEY,
    HXMSG_CASE_TOTAL: process.env.HXMSG_CASE_TOTAL || process.env.HXMSG_CASE_LIMIT || '1',
    HXMSG_CASE_LIMIT: process.env.HXMSG_CASE_LIMIT || '1',
    HXMSG_TEE_BATCH_SIZE: process.env.HXMSG_TEE_BATCH_SIZE || '1',
    HXMSG_FABRIC_EMIT_DELAY_MS: process.env.HXMSG_FABRIC_EMIT_DELAY_MS || '0',
    HXMSG_EVM_GAS_LIMIT: process.env.HXMSG_EVM_GAS_LIMIT || '5000000',
  };

  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'run-hxmsg-forward-tests.js')], {
        cwd: PROJECT_ROOT,
        env,
        stdio: 'inherit',
      });
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Sepolia Fabric->EVM test failed with exit code ${code}`));
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
