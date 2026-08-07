const { ethers } = require('ethers');
const { registerEVMTEEs, registerFabricTEEs, clusterCertificateTuple } = require('../shared/tee/registration');
const { connectFabric } = require('./fabric-client');
const { postToTEELeader } = require('./tee-client');
const { chainProfile, teeURLs } = require('./config');

const RegistryArtifact = require('../artifacts/contracts/TEERegistry.sol/TEERegistry.json');
const SourceArtifact = require('../artifacts/contracts/EvmSourceContract.sol/EvmSourceContract.json');

function walletFor(profile) {
  const provider = new ethers.JsonRpcProvider(profile.rpc);
  return new ethers.NonceManager(new ethers.Wallet(profile.privateKey, provider));
}

function sourceContractAddress(profile, payload = {}) {
  return payload.sourceContract
    || (payload.useWarpSource ? profile.deployment.avalancheWarpSourceContract : null)
    || profile.deployment.evmSourceContract;
}

async function handleResponse(payload) {
  const urls = teeURLs(Number(payload.targetChainType));
  const attested = await postToTEELeader(urls, '/attest-response', {
    response: payload.response,
    helperData: payload.helperData || {},
  });
  const cert = attested.teeClusterCertification;
  const source = chainProfile(payload.sourceProfile);
  if (source.kind === 'fabric') {
    const { gateway, contract } = await connectFabric(source);
    try {
      await registerFabricTEEs({ contract, certificate: cert, teeURLs: urls });
      const result = await contract.submitTransaction(
        'CompleteWithResponse', payload.response.originRequestID, JSON.stringify(payload.response), JSON.stringify(cert)
      );
      return JSON.parse(result.toString());
    } finally {
      gateway.disconnect();
    }
  }
  const signer = walletFor(source);
  const registry = new ethers.Contract(source.deployment.teeRegistry, RegistryArtifact.abi, signer);
  await registerEVMTEEs({ registry, certificate: cert, teeURLs: urls });
  const contract = new ethers.Contract(sourceContractAddress(source, payload), SourceArtifact.abi, signer);
  const tx = await contract.completeWithResponse(
    payload.response.originRequestID, payload.response, clusterCertificateTuple(cert)
  );
  const receipt = await tx.wait();
  return { transactionHash: receipt.hash, gasUsed: receipt.gasUsed.toString() };
}

async function handleCheckpoint(payload) {
  const profile = chainProfile(payload.sourceProfile);
  if (profile.kind === 'fabric') {
    const { gateway, contract } = await connectFabric(profile);
    try {
      await contract.submitTransaction('InitializeWatcherAuthorization');
      const requestIDs = [...new Set(payload.requestIDs || [])].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      const preview = JSON.parse((await contract.evaluateTransaction(
        'PreviewLifecycleCheckpoint', JSON.stringify(requestIDs)
      )).toString());
      const checkpoint = {
        chainID: preview.chainID,
        lifecycleContract: preview.lifecycleContract,
        epoch: preview.epoch,
        previousCheckpointRoot: preview.previousCheckpointRoot,
        terminalStateRoot: preview.terminalStateRoot,
        requestCount: preview.requestCount,
      };
      const attested = await postToTEELeader(teeURLs(profile.chainType), '/attest-checkpoint', {
        checkpoint,
        records: preview.records,
      });
      if (String(attested.checkpointDigest).toLowerCase() !== String(preview.signingDigest).toLowerCase()) {
        throw new Error('TEE checkpoint digest mismatch');
      }
      const cert = attested.teeClusterCertification;
      await registerFabricTEEs({ contract, certificate: cert, teeURLs: teeURLs(profile.chainType) });
      const result = await contract.submitTransaction(
        'UpdateLifecycleCheckpoint', JSON.stringify(requestIDs), preview.terminalStateRoot, JSON.stringify(cert)
      );
      return JSON.parse(result.toString());
    } finally {
      gateway.disconnect();
    }
  }
  const signer = walletFor(profile);
  const contract = new ethers.Contract(sourceContractAddress(profile, payload), SourceArtifact.abi, signer);
  const requestIDs = [...new Set(payload.requestIDs || [])].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  if (!requestIDs.length) throw new Error('checkpoint requestIDs are required');
  const records = [];
  for (const requestID of requestIDs) {
    const record = await contract.requests(requestID);
    const escrow = await contract.tokenEscrows(requestID);
    records.push({
      requestID,
      targetExecutionHash: record.targetExecutionHash,
      failureActionHash: record.failureActionHash,
      commitmentType: Number(record.commitmentType),
      status: Number(record.status),
      responseDigest: record.responseDigest,
      escrowRefunded: Boolean(escrow.refunded),
      escrowSettled: Boolean(escrow.settled),
    });
  }
  const preview = await contract.previewLifecycleCheckpoint(requestIDs);
  const network = await signer.provider.getNetwork();
  const checkpoint = {
    chainID: network.chainId.toString(),
    lifecycleContract: await contract.getAddress(),
    epoch: Number(preview.nextEpoch),
    previousCheckpointRoot: await contract.latestLifecycleCheckpointRoot(),
    terminalStateRoot: preview.terminalStateRoot,
    requestCount: requestIDs.length,
  };
  const attested = await postToTEELeader(teeURLs(profile.chainType), '/attest-checkpoint', { checkpoint, records });
  if (String(attested.checkpointDigest).toLowerCase() !== String(preview.signingDigest).toLowerCase()) {
    throw new Error('TEE checkpoint digest mismatch');
  }
  const cert = attested.teeClusterCertification;
  const registry = new ethers.Contract(profile.deployment.teeRegistry, RegistryArtifact.abi, signer);
  await registerEVMTEEs({ registry, certificate: cert, teeURLs: teeURLs(profile.chainType) });
  const transaction = await contract.updateLifecycleCheckpoint(
    requestIDs, preview.terminalStateRoot, clusterCertificateTuple(cert)
  );
  const receipt = await transaction.wait();
  return {
    epoch: Number(preview.nextEpoch),
    terminalStateRoot: preview.terminalStateRoot,
    transactionHash: receipt.hash,
    gasUsed: receipt.gasUsed.toString(),
    requestCount: requestIDs.length,
  };
}

module.exports = { handleResponse, handleCheckpoint };
