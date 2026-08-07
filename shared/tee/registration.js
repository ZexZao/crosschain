const axios = require('axios');
const { ethers } = require('ethers');
const { evmRegistrationTuple } = require('./attestation');

function teeURLsFromEnv() {
  return String(process.env.TEE_URLS || process.env.TEE_URL || 'http://127.0.0.1:9000,http://127.0.0.1:9001,http://127.0.0.1:9002,http://127.0.0.1:9003,http://127.0.0.1:9004')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
}

async function fetchTEEIdentities(urls = teeURLsFromEnv()) {
  const identities = [];
  for (const url of urls) {
    try {
      const resp = await axios.get(`${url.replace(/\/$/, '')}/identity`, { timeout: 5000 });
      identities.push({ ...resp.data, url });
    } catch (_error) {
      // Some tests may only require a quorum subset; ignore unreachable peers here.
    }
  }
  return identities;
}

async function identityByAddressMap(urls = teeURLsFromEnv()) {
  const identities = await fetchTEEIdentities(urls);
  const byAddress = new Map();
  for (const identity of identities) {
    byAddress.set(ethers.getAddress(identity.teeAddress || identity.address), identity);
  }
  return byAddress;
}

function certificateParticipants(certificate) {
  const cert = certificate?.clusterCertificate || certificate;
  const participants = cert?.participants || [];
  return participants
    .filter((participant) => participant?.teeAddress)
    .map((participant) => ({
      ...participant,
      teeAddress: ethers.getAddress(participant.teeAddress),
      signerIndex: Number(participant.signerIndex),
    }));
}

function uniqueParticipantAddresses(certificates = []) {
  const addresses = [];
  for (const certificate of certificates.filter(Boolean)) {
    for (const participant of certificateParticipants(certificate)) {
      if (!addresses.includes(participant.teeAddress)) addresses.push(participant.teeAddress);
    }
  }
  return addresses;
}

function clusterCertificateTuple(certificate) {
  const cert = certificate?.clusterCertificate || certificate;
  if (!cert) throw new Error('cluster certificate is required');
  return [
    cert.clusterID,
    Number(cert.epoch),
    Number(cert.threshold),
    Number(cert.participantCount),
    BigInt(cert.signerBitmap),
    cert.selectedSignerHash,
    cert.signatureBundle,
    cert.signingDigest,
    Number(cert.committedTerm || 0),
    Number(cert.committedIndex || 0),
  ];
}

async function registerEVMTEEs({ registry, certificate, certificates, teeURLs = teeURLsFromEnv() }) {
  const byAddress = await identityByAddressMap(teeURLs);
  let registered = 0;
  let gasUsed = 0n;
  const participantAddresses = uniqueParticipantAddresses(certificates || [certificate]);
  const addresses = Array.from(new Set([...byAddress.keys(), ...participantAddresses]));
  const managedRunner = registry.runner;
  const signer = managedRunner?.signer || managedRunner;
  if (!signer?.provider) throw new Error('EVM TEE registry signer with provider is required');
  const signerAddress = await signer.getAddress();
  const readNonce = async () => Math.max(
    await signer.provider.getTransactionCount(signerAddress, 'latest'),
    await signer.provider.getTransactionCount(signerAddress, 'pending')
  );
  let nextNonce = await readNonce();
  const writer = registry.connect(signer);
  for (const address of addresses) {
    if (await registry.isActiveTEE(address)) continue;
    const identity = byAddress.get(address);
    if (!identity) throw new Error(`TEE identity not found for ${address}`);
    let completed = false;
    for (let attempt = 1; attempt <= 3 && !completed; attempt += 1) {
      try {
        const tx = await writer.registerTEE(evmRegistrationTuple(identity), { nonce: nextNonce });
        nextNonce += 1;
        const receipt = await tx.wait();
        registered += 1;
        gasUsed += receipt.gasUsed || 0n;
        completed = true;
      } catch (error) {
        if (await registry.isActiveTEE(address)) {
          completed = true;
          nextNonce = await readNonce();
          break;
        }
        const code = String(error.code || '');
        const message = String(error.info?.error?.message || error.message || '').toLowerCase();
        const nonceError = code === 'NONCE_EXPIRED'
          || message.includes('nonce too low')
          || message.includes('nonce has already been used')
          || message.includes('replacement transaction underpriced');
        if (!nonceError || attempt === 3) throw error;
        nextNonce = await readNonce();
      }
    }
  }
  if (typeof managedRunner?.reset === 'function') managedRunner.reset();
  return { registered, gasUsed };
}

async function registerFabricTEEs({ contract, certificate, certificates, teeURLs = teeURLsFromEnv() }) {
  const byAddress = await identityByAddressMap(teeURLs);
  const participantAddresses = uniqueParticipantAddresses(certificates || [certificate]);
  const addresses = Array.from(new Set([...byAddress.keys(), ...participantAddresses]));
  for (const address of addresses) {
    const identity = byAddress.get(address);
    if (!identity) throw new Error(`TEE identity not found for ${address}`);
    await contract.submitTransaction('RegisterTrustedTEE', JSON.stringify(identity));
  }
  return { teeAddresses: addresses };
}

module.exports = {
  teeURLsFromEnv,
  fetchTEEIdentities,
  identityByAddressMap,
  certificateParticipants,
  clusterCertificateTuple,
  registerEVMTEEs,
  registerFabricTEEs,
};
