const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('hardhat');
const { writeJSON, ensureRuntime } = require('../shared/utils');

async function main() {
  ensureRuntime();
  const [defaultDeployer] = await ethers.getSigners();
  const deployer = process.env.LOCAL_EVM_PRIVATE_KEY
    ? new ethers.Wallet(process.env.LOCAL_EVM_PRIVATE_KEY, ethers.provider)
    : defaultDeployer;

  const TEERegistry = await ethers.getContractFactory('TEERegistry', deployer);
  const teeRegistry = await TEERegistry.deploy();
  await teeRegistry.waitForDeployment();

  const Source = await ethers.getContractFactory('EvmSourceContract', deployer);
  const source = await Source.deploy(await teeRegistry.getAddress());
  await source.waitForDeployment();

  const HXMsgGateway = await ethers.getContractFactory('HXMsgGateway', deployer);
  const hxmsgGateway = await HXMsgGateway.deploy(await teeRegistry.getAddress(), 1);
  await hxmsgGateway.waitForDeployment();

  const Target = await ethers.getContractFactory('TargetContract', deployer);
  const initialAssetReserveUnits = BigInt(process.env.INITIAL_ASSET_RESERVE_UNITS || '10000000000000');
  const target = await Target.deploy(await hxmsgGateway.getAddress(), initialAssetReserveUnits);
  await target.waitForDeployment();

  const deployment = {
    deployer: deployer.address,
    evmSourceContract: await source.getAddress(),
    targetContract: await target.getAddress(),
    settlementToken: await target.token(),
    initialAssetReserveUnits: initialAssetReserveUnits.toString(),
    teeRegistry: await teeRegistry.getAddress(),
    hxmsgGateway: await hxmsgGateway.getAddress(),
    chainId: Number((await ethers.provider.getNetwork()).chainId),
  };

  writeJSON(process.env.DEPLOYMENT_OUTPUT_FILE || 'deployment.json', deployment);
  fs.writeFileSync(path.join(__dirname, '..', 'runtime', 'DEPLOYED'), 'ok');
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
