const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('hardhat');
const { writeJSON, ensureRuntime } = require('../shared/utils');

async function main() {
  ensureRuntime();
  const [deployer] = await ethers.getSigners();

  const Source = await ethers.getContractFactory('EvmSourceContract');
  const source = await Source.deploy();
  await source.waitForDeployment();

  const TEERegistry = await ethers.getContractFactory('TEERegistry');
  const teeRegistry = await TEERegistry.deploy();
  await teeRegistry.waitForDeployment();

  const HXMsgGateway = await ethers.getContractFactory('HXMsgGateway');
  const hxmsgGateway = await HXMsgGateway.deploy(await teeRegistry.getAddress());
  await hxmsgGateway.waitForDeployment();

  const Target = await ethers.getContractFactory('TargetContract');
  const target = await Target.deploy(await hxmsgGateway.getAddress());
  await target.waitForDeployment();

  const deployment = {
    deployer: deployer.address,
    evmSourceContract: await source.getAddress(),
    targetContract: await target.getAddress(),
    teeRegistry: await teeRegistry.getAddress(),
    hxmsgGateway: await hxmsgGateway.getAddress(),
    chainId: Number((await ethers.provider.getNetwork()).chainId),
  };

  writeJSON('deployment.json', deployment);
  fs.writeFileSync(path.join(__dirname, '..', 'runtime', 'DEPLOYED'), 'ok');
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
