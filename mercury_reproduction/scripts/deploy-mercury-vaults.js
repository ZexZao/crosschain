const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('hardhat');

const parentRoot = process.env.PARENT_PROJECT_ROOT || path.resolve(__dirname, '../../crosschain_experiment');
const parentRuntime = path.join(parentRoot, 'runtime');
const runtime = path.join(__dirname, '..', 'runtime');

async function main() {
  fs.ensureDirSync(runtime);
  const [deployer] = await ethers.getSigners();
  const parentDeploymentFile = process.env.SEPOLIA_DEPLOYMENT_FILE || path.join(parentRuntime, 'deployment.sepolia.json');
  if (!fs.existsSync(parentDeploymentFile)) throw new Error(`Sepolia parent deployment not found: ${parentDeploymentFile}`);
  const parentDeployment = fs.readJsonSync(parentDeploymentFile);
  const clusterID = ethers.keccak256(ethers.toUtf8Bytes(process.env.MERCURY_CLUSTER_ID || 'MERCURY_ETH_EOS_ABLATION_CLUSTER_V1'));
  const Registry = await ethers.getContractFactory('MercuryTEERegistry');
  const registry = await Registry.deploy(clusterID);
  await registry.waitForDeployment();
  const MercuryVault = await ethers.getContractFactory('MercuryVault');
  const treasury = process.env.MERCURY_TREASURY || deployer.address;
  const challengePledge = ethers.parseEther(process.env.MERCURY_CHALLENGE_PLEDGE_ETH || '0.001');
  const challengeWait = Number(process.env.MERCURY_CHALLENGE_WAIT_SECONDS || 600);
  const vault = await MercuryVault.deploy(await registry.getAddress(), treasury, challengePledge, challengeWait);
  await vault.waitForDeployment();

  const deployment = {
    deployer: deployer.address,
    network: 'sepolia',
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    mercuryVault: await vault.getAddress(),
    mercuryTEERegistry: await registry.getAddress(),
    clusterID,
    treasury,
    challengePledge: challengePledge.toString(),
    challengeWait,
    reusedTargetContract: parentDeployment.targetContract || null,
    reusedSettlementToken: parentDeployment.settlementToken || null,
    parentDeploymentFile,
    deployedAt: new Date().toISOString(),
  };
  fs.writeJsonSync(path.join(runtime, 'deployment.sepolia.json'), deployment, { spaces: 2 });
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
