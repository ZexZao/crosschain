const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');
const { loadDotEnv } = require('../shared/env');

loadDotEnv();
const ROOT = path.join(__dirname, '..');

async function main() {
  const health = await axios.get(`${process.env.AUTOMATION_URL || 'http://127.0.0.1:9200'}/health`);
  if (!health.data?.enabledChains?.includes('avalanche') || !health.data.enabledChains.includes('sepolia')) {
    throw new Error('automation must run with AUTOMATION_ENABLED_CHAINS=sepolia,avalanche');
  }
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-automation-evm-evm-e2e.js')], {
      cwd: ROOT,
      env: {
        ...process.env,
        AUTOMATION_EVM_SOURCE_PROFILE: 'sepolia',
        AUTOMATION_EVM_TARGET_PROFILE: 'avalanche',
        AUTOMATION_EVM_EVM_RESULT_FILE: 'automation-sepolia-avalanche-e2e-result.json',
      },
      stdio: 'inherit',
    });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Sepolia->Avalanche automation test exited ${code}`)));
    child.on('error', reject);
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
