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

  const Verifier = await ethers.getContractFactory('VerifierContract');
  const verifier = await Verifier.deploy();
  await verifier.waitForDeployment();

  const deployment = {
    deployer: deployer.address,
    targetContract: await target.getAddress(),
    verifierContract: await verifier.getAddress(),
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
