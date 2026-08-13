const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { loadDotEnv } = require('../shared/env');
const { ChainType } = require('../shared/hxmsg');
const { urlsForSubnet } = require('../shared/tee/subnet-routing');
const { evmRegistrationTuple } = require('../shared/tee/attestation');

loadDotEnv();

const ROOT = path.join(__dirname, '..');
const DEPLOYMENT_FILE = path.join(ROOT, process.env.SEPOLIA_DEPLOYMENT_FILE || 'runtime/deployment.sepolia.json');
const RESULT_FILE = path.join(ROOT, 'runtime', 'sepolia-tee-subnet-registration-result.json');
const RegistryArtifact = require('../artifacts/contracts/TEERegistry.sol/TEERegistry.json');

const SUBNETS = [
  { profile: 'ethereum', sourceChainType: ChainType.EVM },
  { profile: 'fabric', sourceChainType: ChainType.FABRIC },
  { profile: 'avalanche', sourceChainType: ChainType.AVALANCHE },
];

async function fetchIdentity(url) {
  const response = await axios.get(`${url.replace(/\/$/, '')}/identity`, { timeout: 5000 });
  return { ...response.data, url };
}

async function loadSubnet(subnet) {
  const urls = urlsForSubnet(subnet.profile);
  const identities = await Promise.all(urls.map(fetchIdentity));
  if (identities.length !== 5) throw new Error(`${subnet.profile} subnet requires five TEE identities`);
  const clusterIDs = new Set(identities.map((item) => String(item.clusterID).toLowerCase()));
  const subnetIDs = new Set(identities.map((item) => item.subnetID));
  const indexes = new Set(identities.map((item) => Number(item.signerIndex)));
  if (clusterIDs.size !== 1 || subnetIDs.size !== 1) throw new Error(`${subnet.profile} subnet identity mismatch`);
  if (indexes.size !== 5 || ![0, 1, 2, 3, 4].every((index) => indexes.has(index))) {
    throw new Error(`${subnet.profile} subnet signer indexes must be 0..4`);
  }
  for (const identity of identities) {
    if (Number(identity.sourceChainType) !== Number(subnet.sourceChainType)) {
      throw new Error(`${subnet.profile} TEE ${identity.nodeID} has wrong source chain type`);
    }
  }
  return {
    ...subnet,
    clusterID: identities[0].clusterID,
    subnetID: identities[0].subnetID,
    identities: identities.sort((a, b) => Number(a.signerIndex) - Number(b.signerIndex)),
  };
}

async function main() {
  if (!process.env.SEPOLIA_RPC_URL) throw new Error('SEPOLIA_RPC_URL is required');
  const privateKey = process.env.SEPOLIA_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) throw new Error('SEPOLIA_PRIVATE_KEY or DEPLOYER_PRIVATE_KEY is required');
  const deployment = fs.readJsonSync(DEPLOYMENT_FILE);
  const provider = new ethers.JsonRpcProvider(process.env.SEPOLIA_RPC_URL);
  const baseWallet = new ethers.Wallet(privateKey, provider);
  const wallet = new ethers.NonceManager(baseWallet);
  const registry = new ethers.Contract(deployment.teeRegistry, RegistryArtifact.abi, wallet);
  if (Number((await provider.getNetwork()).chainId) !== 11155111) throw new Error('RPC is not Sepolia');
  if ((await registry.owner()).toLowerCase() !== baseWallet.address.toLowerCase()) {
    throw new Error('configured wallet is not TEERegistry owner');
  }

  const subnets = await Promise.all(SUBNETS.map(loadSubnet));
  const allAddresses = subnets.flatMap((subnet) => subnet.identities.map((item) => ethers.getAddress(item.teeAddress)));
  if (new Set(allAddresses).size !== allAddresses.length) throw new Error('TEE signing address is reused across subnets');

  const result = {
    testedAt: new Date().toISOString(),
    chainID: 11155111,
    registry: deployment.teeRegistry,
    owner: baseWallet.address,
    subnets: [],
  };
  for (const subnet of subnets) {
    const members = [];
    for (const identity of subnet.identities) {
      const activeBefore = await registry.isActiveTEE(subnet.clusterID, identity.teeAddress);
      let transactionHash = null;
      let gasUsed = 0n;
      if (!activeBefore) {
        const transaction = await registry.registerTEE(evmRegistrationTuple(identity));
        const receipt = await transaction.wait();
        transactionHash = receipt.hash;
        gasUsed = receipt.gasUsed;
      }
      const active = await registry.isActiveTEE(subnet.clusterID, identity.teeAddress);
      if (!active) throw new Error(`${subnet.profile} TEE ${identity.nodeID} was not activated`);
      members.push({
        nodeID: identity.nodeID,
        signerIndex: Number(identity.signerIndex),
        teeAddress: ethers.getAddress(identity.teeAddress),
        registeredNow: !activeBefore,
        transactionHash,
        gasUsed: gasUsed.toString(),
      });
      console.log(`${subnet.profile} ${identity.nodeID} ${activeBefore ? 'already active' : `registered tx=${transactionHash}`}`);
    }
    const config = await registry.clusters(subnet.clusterID);
    const threshold = await registry.quorumThreshold(subnet.clusterID);
    if (Number(config.activeTEECount) !== 5 || Number(threshold) !== 3) {
      throw new Error(`${subnet.profile} cluster configuration mismatch`);
    }
    result.subnets.push({
      profile: subnet.profile,
      subnetID: subnet.subnetID,
      clusterID: subnet.clusterID,
      sourceChainType: Number(subnet.sourceChainType),
      epoch: Number(config.epoch),
      activeTEECount: Number(config.activeTEECount),
      threshold: Number(threshold),
      members,
    });
  }
  result.totalGasUsed = result.subnets
    .flatMap((subnet) => subnet.members)
    .reduce((total, member) => total + BigInt(member.gasUsed), 0n)
    .toString();
  result.pass = true;
  fs.writeJsonSync(RESULT_FILE, result, { spaces: 2 });
  console.log(JSON.stringify(result, null, 2));
  console.log(`Results: ${RESULT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
