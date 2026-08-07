const { ethers } = require('ethers');
const { chainProfile } = require('../config');
const { connectFabric } = require('../fabric-client');

const SourceArtifact = require('../../artifacts/contracts/EvmSourceContract.sol/EvmSourceContract.json');

function walletFor(profile) {
  const provider = new ethers.JsonRpcProvider(profile.rpc);
  return new ethers.NonceManager(new ethers.Wallet(profile.privateKey, provider));
}

function sourceAddress(profile, options = {}) {
  return options.sourceContract
    || (options.useWarpSource ? profile.deployment.avalancheWarpSourceContract : null)
    || profile.deployment.evmSourceContract;
}

async function queryLifecycle(profileName, requestID, options = {}) {
  const profile = chainProfile(profileName);
  if (profile.kind === 'fabric') {
    const { gateway, contract } = await connectFabric(profile);
    try {
      const result = await contract.evaluateTransaction('QueryResponseLifecycle', requestID);
      return result.length ? JSON.parse(result.toString()) : null;
    } finally {
      gateway.disconnect();
    }
  }
  const contract = new ethers.Contract(sourceAddress(profile, options), SourceArtifact.abi, walletFor(profile));
  const value = await contract.requests(requestID);
  return {
    targetExecutionHash: value.targetExecutionHash,
    failureActionHash: value.failureActionHash,
    feedbackTimeout: Number(value.feedbackTimeout),
    challengeWindow: Number(value.challengeWindow),
    challengeDeadline: Number(value.challengeDeadline),
    commitmentType: Number(value.commitmentType),
    status: Number(value.status),
    responseDigest: value.responseDigest,
  };
}

async function startChallenge(profileName, requestID, options = {}) {
  const profile = chainProfile(profileName);
  if (profile.kind === 'fabric') {
    const { gateway, contract } = await connectFabric(profile);
    try {
      await contract.submitTransaction('InitializeWatcherAuthorization');
      await contract.submitTransaction('StartChallenge', requestID);
      return { chain: 'fabric', requestID };
    } finally {
      gateway.disconnect();
    }
  }
  const contract = new ethers.Contract(sourceAddress(profile, options), SourceArtifact.abi, walletFor(profile));
  const receipt = await (await contract.startChallenge(requestID)).wait();
  return { transactionHash: receipt.hash, gasUsed: receipt.gasUsed.toString() };
}

async function compensate(profileName, requestID, failureData, options = {}) {
  if (!failureData) throw new Error('failureData is required for compensation');
  const profile = chainProfile(profileName);
  if (profile.kind === 'fabric') {
    const { gateway, contract } = await connectFabric(profile);
    try {
      await contract.submitTransaction('InitializeWatcherAuthorization');
      const result = await contract.submitTransaction('CompensateAfterChallenge', requestID, failureData);
      return result.length ? JSON.parse(result.toString()) : { requestID };
    } finally {
      gateway.disconnect();
    }
  }
  const contract = new ethers.Contract(sourceAddress(profile, options), SourceArtifact.abi, walletFor(profile));
  const receipt = await (await contract.compensateAfterChallenge(requestID, failureData)).wait();
  return { transactionHash: receipt.hash, gasUsed: receipt.gasUsed.toString() };
}

module.exports = { queryLifecycle, startChallenge, compensate };
