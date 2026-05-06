const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('hardhat');
const { writeJSON, ensureRuntime } = require('../shared/utils');

async function main() {
  ensureRuntime();
  const [deployer] = await ethers.getSigners();

  const Target = await ethers.getContractFactory('TargetContract');
  const target = await Target.deploy();
  await target.waitForDeployment();

  const Source = await ethers.getContractFactory('EvmSourceContract');
  const source = await Source.deploy();
  await source.waitForDeployment();

  // Deploy V1 (legacy, backward compatible)
  const Verifier = await ethers.getContractFactory('VerifierContract');
  const verifier = await Verifier.deploy();
  await verifier.waitForDeployment();

  // Deploy V2 (hybrid bridge: BLS + TEE dual verification)
  const VerifierV2 = await ethers.getContractFactory('VerifierContractV2');
  const verifierV2 = await VerifierV2.deploy();
  await verifierV2.waitForDeployment();

  const deployment = {
    deployer: deployer.address,
    evmSourceContract: await source.getAddress(),
    targetContract: await target.getAddress(),
    verifierContract: await verifier.getAddress(),
    verifierContractV2: await verifierV2.getAddress(),
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
