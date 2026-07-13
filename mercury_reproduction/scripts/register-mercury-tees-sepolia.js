const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');

const parentRoot = process.env.PARENT_PROJECT_ROOT || path.resolve(__dirname, '../../crosschain_experiment');
const { loadDotEnv } = require(path.join(parentRoot, 'shared/env'));
const { evmRegistrationTuple } = require(path.join(parentRoot, 'shared/tee/attestation'));

loadDotEnv(path.join(parentRoot, '.env'));

const parentRuntime = path.join(parentRoot, 'runtime');
const runtime = path.join(__dirname, '..', 'runtime');
const TEE_URLS = String(process.env.MERCURY_TEE_URLS || 'http://127.0.0.1:9300,http://127.0.0.1:9301,http://127.0.0.1:9302,http://127.0.0.1:9303,http://127.0.0.1:9304')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const REGISTRY_ABI = [
  'function isActiveTEE(address) view returns (bool)',
  'function registerTEE((address teeAddress,uint16 signerIndex,bytes32 enclavePubKeyHash,bytes32 measurement,bytes32 quoteHash,bytes32 initialSyncStateHash,uint64 epoch,uint64 notAfter,bytes attestationSignature)) external',
];

async function main() {
  if (!process.env.SEPOLIA_RPC_URL || !process.env.SEPOLIA_PRIVATE_KEY) {
    throw new Error('SEPOLIA_RPC_URL and SEPOLIA_PRIVATE_KEY are required');
  }
  fs.ensureDirSync(runtime);
  const deploymentFile = process.env.MERCURY_SEPOLIA_DEPLOYMENT_FILE || path.join(runtime, 'deployment.sepolia.json');
  const deployment = fs.readJsonSync(deploymentFile);
  if (!deployment.mercuryTEERegistry) throw new Error(`mercuryTEERegistry missing in ${deploymentFile}`);
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const wallet = new ethers.Wallet(process.env.SEPOLIA_PRIVATE_KEY, provider);
  const registry = new ethers.Contract(deployment.mercuryTEERegistry, REGISTRY_ABI, wallet);

  const results = [];
  for (const url of TEE_URLS) {
    const resp = await axios.get(`${url}/identity`, { timeout: 10000 });
    const identity = resp.data;
    const address = ethers.getAddress(identity.teeAddress || identity.address);
    const active = await registry.isActiveTEE(address);
    if (active) {
      results.push({ url, teeAddress: address, registered: false, alreadyActive: true, gasUsed: 0 });
      continue;
    }
    const tx = await registry.registerTEE(evmRegistrationTuple(identity));
    const receipt = await tx.wait();
    results.push({ url, teeAddress: address, registered: true, txHash: receipt.hash, gasUsed: Number(receipt.gasUsed) });
  }
  const output = {
    registeredAt: new Date().toISOString(),
    deploymentFile,
    teeRegistry: deployment.mercuryTEERegistry,
    results,
    gasTotal: results.reduce((sum, item) => sum + Number(item.gasUsed || 0), 0),
  };
  fs.writeJsonSync(path.join(runtime, 'sepolia-tee-registration.json'), output, { spaces: 2 });
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
