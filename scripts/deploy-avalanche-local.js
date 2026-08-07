const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');

const PROJECT_ROOT = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, 'runtime');
const DEFAULT_AVALANCHE_RPC = 'http://127.0.0.1:9650/ext/bc/C/rpc';
const DEFAULT_LOCAL_PRIVATE_KEY = '0x56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027';

function artifact(name) {
  return fs.readJsonSync(path.join(PROJECT_ROOT, 'artifacts', 'contracts', `${name}.sol`, `${name}.json`));
}

async function deployContract({ wallet, name, args = [] }) {
  const compiled = artifact(name);
  const factory = new ethers.ContractFactory(compiled.abi, compiled.bytecode, wallet);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function main() {
  fs.ensureDirSync(RUNTIME_DIR);
  const rpcURL = process.env.AVALANCHE_RPC_URL || DEFAULT_AVALANCHE_RPC;
  const privateKey = process.env.AVALANCHE_PRIVATE_KEY || DEFAULT_LOCAL_PRIVATE_KEY;
  const provider = new ethers.JsonRpcProvider(rpcURL);
  const baseWallet = new ethers.Wallet(privateKey, provider);
  const wallet = new ethers.NonceManager(baseWallet);
  const network = await provider.getNetwork();
  const balance = await provider.getBalance(baseWallet.address);
  if (balance === 0n) {
    throw new Error(`Avalanche deployer has zero balance: ${baseWallet.address}`);
  }

  const teeRegistry = await deployContract({ wallet, name: 'TEERegistry' });
  const source = await deployContract({
    wallet,
    name: 'EvmSourceContract',
    args: [await teeRegistry.getAddress()],
  });
  const warpSource = await deployContract({
    wallet,
    name: 'AvalancheWarpSourceContract',
    args: [await teeRegistry.getAddress()],
  });
  const gateway = await deployContract({
    wallet,
    name: 'HXMsgGateway',
    args: [await teeRegistry.getAddress(), 3],
  });
  const target = await deployContract({
    wallet,
    name: 'TargetContract',
    args: [
      await gateway.getAddress(),
      BigInt(process.env.INITIAL_ASSET_RESERVE_UNITS || '10000000000000'),
    ],
  });

  const deployment = {
    network: 'avalanche-local',
    rpcURL,
    deployer: baseWallet.address,
    deployerBalanceWei: balance.toString(),
    chainId: Number(network.chainId),
    evmSourceContract: await source.getAddress(),
    avalancheWarpSourceContract: await warpSource.getAddress(),
    hxmsgGateway: await gateway.getAddress(),
    targetContract: await target.getAddress(),
    teeRegistry: await teeRegistry.getAddress(),
    settlementToken: await target.token(),
    initialAssetReserveUnits: process.env.INITIAL_ASSET_RESERVE_UNITS || '10000000000000',
    deployedAt: new Date().toISOString(),
  };
  fs.writeJsonSync(path.join(RUNTIME_DIR, 'avalanche-deployment.json'), deployment, { spaces: 2 });
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
