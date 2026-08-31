const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const { ethers } = require('ethers');
const { loadDotEnv } = require('../shared/env');
const { ChainType } = require('../shared/hxmsg');
const { teeURLsFromEnv } = require('../shared/tee/subnet-routing');
const { writeJSON } = require('../shared/utils');

loadDotEnv();

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const DEPLOYMENTS = {
  sepolia: path.join(RUNTIME, 'deployment.sepolia.json'),
  ethereum: path.join(RUNTIME, 'deployment.json'),
  avalanche: path.join(RUNTIME, 'avalanche-deployment.json'),
};
const CONTRACT_FIELDS = ['evmSourceContract', 'targetContract', 'teeRegistry', 'hxmsgGateway', 'settlementToken'];
const MINIMAL_TUPLE = '(bytes32,bytes32,uint8,bytes32,uint8,bytes32,bytes4,bytes32,bytes32,bytes32,bool,uint8,uint64,bytes32,uint64,bytes32,uint64,uint8,bytes32,bytes32)';
const COMPACT_TUPLE = '(uint16,bytes32,bytes32,address,int256,bytes32,bool)';
const CLUSTER_CERT_TUPLE = '(bytes32,uint8,bytes32,uint64,uint16,uint16,uint256,bytes32,bytes,bytes32,bytes32,uint64,uint64)';
const COMPACT_BATCH_SELECTOR = ethers.id(
  `executeHXMsgMinimalCompactBatchCluster(${MINIMAL_TUPLE}[],address,${COMPACT_TUPLE}[],bytes32,bytes32,${CLUSTER_CERT_TUPLE})`
).slice(2, 10).toLowerCase();
const SOURCE_V2_SELECTOR = ethers.id(
  'submitHXMsgRequest(uint8,bytes32,bytes32,bytes32,bytes4,bytes32,bytes32,bytes32,uint64,(bool,uint8,uint64,bytes32,(bool,uint8,uint8,bytes32,bytes32,bytes32,uint64)))'
).slice(2, 10).toLowerCase();

async function checkSubnet(label, sourceChainType) {
  const urls = teeURLsFromEnv({ sourceChainType });
  const nodes = await Promise.all(urls.map(async (url) => {
    try {
      const [raft, identity] = await Promise.all([
        axios.get(`${url}/raft/status`, { timeout: 4000 }),
        axios.get(`${url}/identity`, { timeout: 4000 }),
      ]);
      return { url, reachable: true, ...raft.data, attestationMode: identity.data?.attestation?.mode || identity.data?.mode || null };
    } catch (error) {
      return { url, reachable: false, error: error.message };
    }
  }));
  const reachable = nodes.filter((node) => node.reachable);
  const leaders = reachable.filter((node) => node.role === 'leader');
  const indexes = new Set(reachable.map((node) => `${node.commitIndex}:${node.lastLogIndex}`));
  if (nodes.length !== 5 || reachable.length !== 5) throw new Error(`${label} TEE subnet requires 5/5 reachable nodes`);
  if (leaders.length !== 1) throw new Error(`${label} TEE subnet requires exactly one Raft leader`);
  if (indexes.size !== 1) throw new Error(`${label} TEE subnet logs are not aligned`);
  return { label, pass: true, leaderID: leaders[0].nodeID, term: leaders[0].term, nodes };
}

async function checkDeployment(label, rpcURL, deploymentFile, expectedChainID, { requireSepoliaTarget = false } = {}) {
  if (!fs.existsSync(deploymentFile)) throw new Error(`${label} deployment missing: ${deploymentFile}`);
  const deployment = fs.readJsonSync(deploymentFile);
  const provider = new ethers.JsonRpcProvider(rpcURL);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== Number(expectedChainID)) {
    throw new Error(`${label} chain ID mismatch: ${network.chainId}/${expectedChainID}`);
  }
  const contracts = {};
  for (const field of CONTRACT_FIELDS) {
    if (!deployment[field]) throw new Error(`${label} deployment missing ${field}`);
    const code = await provider.getCode(deployment[field]);
    contracts[field] = { address: deployment[field], hasCode: code !== '0x' };
    if (code === '0x') throw new Error(`${label} ${field} has no deployed code`);
  }
  let targetReadiness = null;
  if (requireSepoliaTarget) {
    const gatewayCode = (await provider.getCode(deployment.hxmsgGateway)).toLowerCase();
    const sourceCode = (await provider.getCode(deployment.evmSourceContract)).toLowerCase();
    if (!gatewayCode.includes(COMPACT_BATCH_SELECTOR)) {
      throw new Error('Sepolia Gateway is an old deployment; run npm run deploy:sepolia');
    }
    if (!sourceCode.includes(SOURCE_V2_SELECTOR)) {
      throw new Error('Sepolia source contract is an old deployment; run npm run deploy:sepolia');
    }
    if (deployment.protocolVersion !== 'response-proof-v2' || Number(deployment.targetExecutionHashVersion) !== 2) {
      throw new Error('Sepolia deployment metadata is not response-proof-v2; run npm run deploy:sepolia');
    }
    const gateway = new ethers.Contract(deployment.hxmsgGateway, [
      'function executionDomainID() view returns (bytes32)',
      'function localChainType() view returns (uint8)',
    ], provider);
    const [executionDomainID, localChainType] = await Promise.all([
      gateway.executionDomainID(),
      gateway.localChainType(),
    ]);
    if (Number(localChainType) !== ChainType.EVM
        || executionDomainID.toLowerCase() !== String(deployment.gatewayExecutionDomainID).toLowerCase()) {
      throw new Error('Sepolia Gateway execution domain metadata mismatch');
    }
    const target = new ethers.Contract(deployment.targetContract, ['function assetService() view returns (address)'], provider);
    const assetService = await target.assetService();
    const token = new ethers.Contract(deployment.settlementToken, ['function balanceOf(address) view returns (uint256)'], provider);
    const reserve = await token.balanceOf(assetService);
    const minimumReserve = BigInt(process.env.SEPOLIA_MIN_ASSET_RESERVE_UNITS || '300000');
    if (reserve < minimumReserve) {
      throw new Error(`Sepolia target reserve is insufficient: ${reserve}/${minimumReserve}; run npm run deploy:sepolia`);
    }
    targetReadiness = {
      compactBatchSelector: `0x${COMPACT_BATCH_SELECTOR}`,
      sourceV2Selector: `0x${SOURCE_V2_SELECTOR}`,
      executionDomainID,
      assetService,
      reserveUnits: reserve.toString(),
      minimumReserveUnits: minimumReserve.toString(),
    };
  }
  return {
    label,
    pass: true,
    chainID: Number(network.chainId),
    latestBlock: await provider.getBlockNumber(),
    deploymentFile,
    contracts,
    targetReadiness,
  };
}

async function runSyncCommitteeCheck() {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'run-sepolia-sync-committee-check.js')], {
      cwd: ROOT,
      env: { ...process.env, SEPOLIA_SYNC_COMMITTEE_PERSIST: 'false' },
      stdio: 'inherit',
    });
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`sync committee check exited ${code}`)));
    child.on('error', reject);
  });
  const result = fs.readJsonSync(path.join(RUNTIME, 'sepolia-sync-committee-result.json'));
  if (!result.pass || !result.nextTrustedBlockRoot || Number(result.participantCount) < Number(result.threshold)) {
    throw new Error('sync committee verification result is incomplete');
  }
  return result;
}

async function main() {
  for (const name of ['SEPOLIA_RPC_URL', 'SEPOLIA_PRIVATE_KEY']) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
  if (!process.env.SEPOLIA_LIGHT_CLIENT_BEACON_API_URL && !process.env.SEPOLIA_BEACON_API_URL) {
    throw new Error('SEPOLIA_LIGHT_CLIENT_BEACON_API_URL or SEPOLIA_BEACON_API_URL is required');
  }
  if (!process.env.SEPOLIA_TRUSTED_BLOCK_ROOT) {
    throw new Error('SEPOLIA_TRUSTED_BLOCK_ROOT is required for secure TEE light-client bootstrap');
  }
  const sepoliaProvider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const sepoliaWallet = new ethers.Wallet(process.env.SEPOLIA_PRIVATE_KEY);
  const sepoliaDeployment = fs.readJsonSync(DEPLOYMENTS.sepolia);
  const balance = await sepoliaProvider.getBalance(sepoliaWallet.address);
  const minimumBalance = ethers.parseEther(process.env.SEPOLIA_MIN_BALANCE_ETH || '0.01');
  if (sepoliaWallet.address.toLowerCase() !== String(sepoliaDeployment.deployer).toLowerCase()) {
    throw new Error('Sepolia private key does not match deployment deployer');
  }
  if (balance < minimumBalance) throw new Error(`Sepolia balance below ${ethers.formatEther(minimumBalance)} ETH`);

  const [ethereumTEE, avalancheTEE, sepolia, ethereum, avalanche] = await Promise.all([
    checkSubnet('ethereum', ChainType.EVM),
    checkSubnet('avalanche', ChainType.AVALANCHE),
    checkDeployment('Sepolia', process.env.SEPOLIA_RPC_URL, DEPLOYMENTS.sepolia, 11155111, { requireSepoliaTarget: true }),
    checkDeployment('local-ethereum', process.env.EVM_RPC || 'http://127.0.0.1:8545', DEPLOYMENTS.ethereum, 31337),
    checkDeployment('local-avalanche', process.env.AVALANCHE_RPC_URL || 'http://127.0.0.1:9650/ext/bc/C/rpc', DEPLOYMENTS.avalanche, 1337),
  ]);
  const syncCommittee = await runSyncCommitteeCheck();
  const result = {
    testType: 'sepolia-four-direction-preflight',
    testedAt: new Date().toISOString(),
    pass: true,
    wallet: {
      address: sepoliaWallet.address,
      balanceWei: balance.toString(),
      balanceETH: ethers.formatEther(balance),
      pendingNonce: await sepoliaProvider.getTransactionCount(sepoliaWallet.address, 'pending'),
      matchesDeploymentDeployer: true,
    },
    teeSubnets: { ethereum: ethereumTEE, avalanche: avalancheTEE },
    chains: { sepolia, ethereum, avalanche },
    syncCommittee: {
      pass: syncCommittee.pass,
      trustedBlockRoot: syncCommittee.trustedBlockRoot,
      nextTrustedBlockRoot: syncCommittee.nextTrustedBlockRoot,
      finalizedHeight: syncCommittee.finalizedHeight,
      syncCommitteePeriod: syncCommittee.syncCommitteePeriod,
      committeeUpdateCount: syncCommittee.committeeUpdates?.length || 0,
      participantCount: syncCommittee.participantCount,
      threshold: syncCommittee.threshold,
      stateFile: syncCommittee.stateFile,
    },
  };
  writeJSON('sepolia-four-direction-preflight.json', result);
  console.log(`PREFLIGHT PASS wallet=${result.wallet.address} balance=${result.wallet.balanceETH} ETH`);
  console.log(`TEE ethereum=5/5 leader=${ethereumTEE.leaderID}; avalanche=5/5 leader=${avalancheTEE.leaderID}`);
  console.log(`SYNC COMMITTEE PASS period=${result.syncCommittee.syncCommitteePeriod} participants=${result.syncCommittee.participantCount}/${512}`);
}

main().catch((error) => {
  writeJSON('sepolia-four-direction-preflight.json', {
    testType: 'sepolia-four-direction-preflight',
    testedAt: new Date().toISOString(),
    pass: false,
    error: error.message,
  });
  console.error(error.message);
  process.exit(1);
});
