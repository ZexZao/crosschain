const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { performance } = require('perf_hooks');
const { ethers } = require('ethers');
const { loadDotEnv } = require('../shared/env');
const { buildHXMsgFromEvmReceiptToEvm, EVM_EXECUTE_SELECTOR } = require('../hxmsg-builder/evm-to-evm');
const { buildReceiptProof } = require('../shared/evm/receipt-proof');
const {
  fetchBeaconLightClientInputs,
  verifySyncCommitteeHeaderUpdate,
} = require('../shared/evm/sync-committee-light-client');
const {
  loadSyncCommitteeState,
  resolveTrustedBlockRoot,
  saveSyncCommitteeState,
  syncCommitteeStateFile,
} = require('../shared/evm/sync-committee-state');
const {
  ChainType,
  FeedbackType,
  bytes32FromText,
  chainIdToBytes32,
  hashJson,
  getExecutionData,
  toMinimalHXMsg,
} = require('../shared/hxmsg');
const { encodeBusinessPayload, normalizeBusinessPayload } = require('../shared/xmsg');
const { teeURLsFromEnv } = require('../shared/tee/subnet-routing');
const { registerEVMTEEs, clusterCertificateTuple } = require('../shared/tee/registration');
const { writeJSON } = require('../shared/utils');

loadDotEnv();

const PROJECT_ROOT = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, 'runtime');
const RESULT_FILE = process.env.SEPOLIA_AVALANCHE_RESULT_FILE || 'sepolia-avalanche-warp-test-result.json';
const SEPOLIA_DEPLOYMENT_FILE = process.env.SEPOLIA_DEPLOYMENT_FILE || path.join(RUNTIME_DIR, 'deployment.sepolia.json');
const AVALANCHE_DEPLOYMENT_FILE = process.env.AVALANCHE_DEPLOYMENT_FILE || path.join(RUNTIME_DIR, 'avalanche-deployment.json');
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL;
const SEPOLIA_KEY = process.env.SEPOLIA_PRIVATE_KEY;
const AVALANCHE_RPC = process.env.AVALANCHE_RPC_URL || 'http://127.0.0.1:9650/ext/bc/C/rpc';
const TEE_URLS = teeURLsFromEnv({ sourceChainType: ChainType.EVM });
const CLUSTER_CERT_ABI = '(bytes32,uint64,uint16,uint16,uint256,bytes32,bytes,bytes32,uint64,uint64)';
const TEE_REGISTRATION_ABI = '(address teeAddress,uint16 signerIndex,bytes32 enclavePubKeyHash,bytes32 measurement,bytes32 quoteHash,bytes32 initialSyncStateHash,uint64 epoch,uint64 notAfter,bytes attestationSignature)';
const SOURCE_ABI = [
  'function submitHXMsgRequest(bytes32 targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 expireAt,(bool,uint8,uint64,bytes32,(bool,uint8,uint8,bytes32,bytes32,bytes32,uint64))) external returns (bytes32)',
  'event CrossChainCallRequested(bytes32 indexed requestID,address indexed sender,bytes32 indexed targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bool feedbackRequired,uint8 expectedFeedbackMsgType,uint64 feedbackTimeout,bytes32 callbackRefHash,bytes32 atomicityHash)',
];

function nowMs() {
  return Math.round(performance.now());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`${name} is required`);
}

async function fetchJson(baseUrl, route) {
  const url = `${baseUrl.replace(/\/$/, '')}${route}`;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const resp = await fetch(url, { headers: { accept: 'application/json' } });
      const text = await resp.text();
      if (!resp.ok) throw new Error(`Beacon API ${resp.status} ${url}: ${text.slice(0, 200)}`);
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(1500 * (attempt + 1));
    }
  }
  throw lastError;
}

async function fetchBeaconFinalized(beaconApiUrl) {
  const finality = await fetchJson(beaconApiUrl, '/eth/v1/beacon/light_client/finality_update');
  const execution = finality.data?.finalized_header?.execution;
  if (!execution?.block_number) return null;
  return {
    finalizedHeight: Number(execution.block_number),
    finalizedHash: execution.block_hash,
    beaconFinalizedSlot: Number(finality.data.finalized_header.beacon.slot),
    signatureSlot: Number(finality.data.signature_slot),
    source: 'beacon-light-client-finality-update',
  };
}

async function waitForFinalizedExecutionBlock({ beaconApiUrl, targetBlockNumber, timeoutMs }) {
  const started = nowMs();
  let lastFinality = null;
  while (nowMs() - started < timeoutMs) {
    try {
      const finalized = await fetchBeaconFinalized(beaconApiUrl);
      lastFinality = finalized || lastFinality;
      if (finalized && finalized.finalizedHeight >= Number(targetBlockNumber)) {
        return { ...finalized, waitMs: nowMs() - started };
      }
    } catch (error) {
      lastFinality = lastFinality || { finalizedHeight: 0, source: `transient-error:${error.message}` };
    }
    await sleep(Number(process.env.SEPOLIA_FINALITY_POLL_MS || 12000));
  }
  const last = lastFinality ? ` lastFinalized=${lastFinality.finalizedHeight} source=${lastFinality.source}` : '';
  throw new Error(`Sepolia finality timeout for block ${targetBlockNumber}.${last}`);
}

async function resolveTeeLeader() {
  const statuses = await Promise.all(TEE_URLS.map(async (url) => {
    try {
      const resp = await axios.get(`${url}/raft/status`, { timeout: 3000 });
      return { url, ...resp.data };
    } catch (error) {
      return { url, error: error.message };
    }
  }));
  const leader = statuses.find((status) => status.role === 'leader');
  if (leader) return leader.url;
  const knownLeaderID = statuses.find((status) => status.leaderID)?.leaderID;
  const knownLeader = knownLeaderID ? statuses.find((status) => status.nodeID === knownLeaderID && !status.error) : null;
  if (knownLeader) return knownLeader.url;
  const available = statuses.find((status) => !status.error);
  if (available) return available.url;
  throw new Error(`no reachable EVM TEE node: ${statuses.map((s) => `${s.url}:${s.error}`).join('; ')}`);
}

function isRetryableTeeLeaderError(error) {
  const message = error.response?.data?.error || error.message || '';
  return message.includes('current term barrier requires leader role')
    || message.includes('Raft leader unavailable')
    || message.includes('TEE cluster quorum not reached')
    || Number(error.response?.status || 0) === 409
    || Number(error.response?.status || 0) === 502
    || Number(error.response?.status || 0) === 503;
}

async function postToCurrentTeeLeader(routePath, body, { timeout, maxAttempts = Number(process.env.HXMSG_TEE_MAX_ATTEMPTS || 10) } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const teeUrl = await resolveTeeLeader();
    try {
      const resp = await axios.post(`${teeUrl}${routePath}`, body, { timeout });
      return { resp, teeUrl, attempt };
    } catch (error) {
      lastError = error;
      if (!isRetryableTeeLeaderError(error) || attempt === maxAttempts) throw error;
      console.log(`TEE leader retry ${attempt}/${maxAttempts}: ${error.response?.data?.error || error.message}`);
      await sleep(Number(process.env.HXMSG_TEE_RETRY_BASE_MS || 3000) * attempt);
    }
  }
  throw lastError;
}

async function fetchTeeSyncCommitteeRoot(teeUrl) {
  try {
    const resp = await axios.get(`${teeUrl}/chain-state`, { timeout: 3000 });
    return resp.data?.evm?.syncCommittee?.trustedBlockRoot || null;
  } catch (_error) {
    return null;
  }
}

function buildBusinessPayload(targetDeployment) {
  const now = Date.now();
  return {
    op: 'token_transfer',
    assetId: `SEPOLIA_TO_AVAX_${now}`,
    amount: '19',
    recipient: 'avalanche.receiver',
    targetRecipient: targetDeployment.deployer,
    metadata: 'real Sepolia receipt proof to Avalanche C-Chain business action',
    requireAck: false,
  };
}

function buildSubmitArgs({ avalancheDeployment, payload }) {
  const { normalized, payloadHex } = encodeBusinessPayload(payload);
  const callDataHash = ethers.keccak256(payloadHex);
  const businessPayloadHash = hashJson(normalized);
  const targetChainID = chainIdToBytes32(avalancheDeployment.chainId);
  const targetDomainID = bytes32FromText(`evm-local-${avalancheDeployment.chainId}`);
  const targetObject = ethers.zeroPadValue(avalancheDeployment.targetContract, 32);
  const receiver = ethers.zeroPadValue(avalancheDeployment.targetContract, 32);
  const expireAt = Math.floor(Date.now() / 1000) + Number(process.env.SEPOLIA_AVALANCHE_EXPIRE_SECONDS || 7200);
  const atomicity = [false, 0, 0, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 0];
  const policy = [false, FeedbackType.NONE, 0, ethers.ZeroHash, atomicity];
  return {
    args: [
      targetChainID,
      targetDomainID,
      targetObject,
      EVM_EXECUTE_SELECTOR,
      callDataHash,
      businessPayloadHash,
      receiver,
      expireAt,
      policy,
    ],
    normalized,
    payloadHex,
    callDataHash,
    businessPayloadHash,
  };
}

async function submitSepoliaSource({ provider, sourceDeployment, avalancheDeployment }) {
  const wallet = new ethers.Wallet(SEPOLIA_KEY, provider);
  const source = new ethers.Contract(sourceDeployment.evmSourceContract, SOURCE_ABI, wallet);
  const payload = buildBusinessPayload(avalancheDeployment);
  const submit = buildSubmitArgs({ avalancheDeployment, payload });
  const startedAt = nowMs();
  const tx = await source.submitHXMsgRequest(...submit.args);
  const receipt = await tx.wait();
  const event = receipt.logs
    .map((log) => {
      try { return source.interface.parseLog(log); } catch (_) { return null; }
    })
    .find((parsed) => parsed?.name === 'CrossChainCallRequested');
  if (!event?.args?.requestID) throw new Error('CrossChainCallRequested event not found');
  return {
    payload,
    normalized: submit.normalized,
    callData: submit.payloadHex,
    requestID: event.args.requestID,
    receipt,
    sourceTxHash: receipt.hash,
    sourceBlockNumber: receipt.blockNumber,
    sourceBlockHash: receipt.blockHash,
    sourceGasUsed: Number(receipt.gasUsed),
    elapsedMs: nowMs() - startedAt,
  };
}

async function buildProofAndHXMsg({ provider, sourceDeployment, avalancheDeployment, sourceResult }) {
  const proofStartedAt = nowMs();
  const [block, receiptProof] = await Promise.all([
    provider.getBlock(sourceResult.receipt.blockNumber),
    buildReceiptProof({
      provider,
      blockNumber: sourceResult.receipt.blockNumber,
      txHash: sourceResult.receipt.hash,
    }),
  ]);
  const beaconApiUrl = process.env.SEPOLIA_LIGHT_CLIENT_BEACON_API_URL || process.env.SEPOLIA_BEACON_API_URL;
  const finalityStartedAt = nowMs();
  const finality = await waitForFinalizedExecutionBlock({
    beaconApiUrl,
    targetBlockNumber: sourceResult.receipt.blockNumber,
    timeoutMs: Number(process.env.SEPOLIA_FINALITY_TIMEOUT_MS || 20 * 60 * 1000),
  });
  const finalityWaitMs = nowMs() - finalityStartedAt;

  const syncCommitteeState = loadSyncCommitteeState();
  const teeUrlForState = await resolveTeeLeader();
  const teeTrustedBlockRoot = await fetchTeeSyncCommitteeRoot(teeUrlForState);
  const trustedBlockRoot = teeTrustedBlockRoot
    || process.env.SEPOLIA_TRUSTED_BLOCK_ROOT
    || resolveTrustedBlockRoot({ state: syncCommitteeState });
  if (!trustedBlockRoot && process.env.SEPOLIA_ALLOW_DYNAMIC_TRUSTED_ROOT !== 'true') {
    throw new Error(`SEPOLIA_TRUSTED_BLOCK_ROOT or ${syncCommitteeStateFile()} is required`);
  }
  const syncStartedAt = nowMs();
  const syncCommitteeUpdate = await fetchBeaconLightClientInputs({
    beaconApiUrl,
    executionProvider: provider,
    targetBlockNumber: sourceResult.receipt.blockNumber,
    trustedBlockRoot,
    allowDynamicTrustedRoot: process.env.SEPOLIA_ALLOW_DYNAMIC_TRUSTED_ROOT === 'true',
    maxAncestorHeaders: Number(process.env.SEPOLIA_MAX_ANCESTOR_HEADERS || 512),
  });
  syncCommitteeUpdate.chainID = `eip155:${sourceDeployment.chainId}`;
  const verifiedSyncCommittee = await verifySyncCommitteeHeaderUpdate(syncCommitteeUpdate, {
    expectedChainID: syncCommitteeUpdate.chainID,
  });
  saveSyncCommitteeState({
    chainID: syncCommitteeUpdate.chainID,
    trustedBlockRoot: verifiedSyncCommittee.nextTrustedBlockRoot,
    finalizedHeight: verifiedSyncCommittee.finalizedHeight,
    finalizedHash: verifiedSyncCommittee.finalizedHash,
    beaconFinalizedSlot: verifiedSyncCommittee.beaconFinalizedSlot,
    signatureSlot: verifiedSyncCommittee.signatureSlot,
    syncCommitteePeriod: verifiedSyncCommittee.syncCommitteePeriod,
  });

  const hxmsg = buildHXMsgFromEvmReceiptToEvm({
    sourceDeployment,
    targetDeployment: avalancheDeployment,
    receipt: sourceResult.receipt,
    block,
    businessPayload: sourceResult.payload,
  });
  return {
    hxmsg,
    receiptProof,
    syncCommitteeUpdate,
    timings: {
      proofBuildMs: nowMs() - proofStartedAt,
      finalityWaitMs,
      syncCommitteeBuildMs: nowMs() - syncStartedAt,
    },
    finality,
  };
}

async function attest(hxmsg, receiptProof, syncCommitteeUpdate) {
  const startedAt = nowMs();
  const { resp, teeUrl, attempt } = await postToCurrentTeeLeader('/attest', {
    hxmsg,
    helperData: {
      evmReceiptProof: receiptProof,
      syncCommitteeUpdate,
      evmRpc: SEPOLIA_RPC,
    },
  }, { timeout: Number(process.env.HXMSG_TEE_TIMEOUT_MS || 120000) });
  const cluster = resp.data.teeClusterCertification;
  if (!cluster?.quorumReached) throw new Error(`TEE quorum not reached: ${cluster?.reached || 0}/${cluster?.threshold || '?'}`);
  return {
    elapsedMs: nowMs() - startedAt,
    teeUrl,
    attempt,
    cluster,
    verificationResult: resp.data.verificationResult,
  };
}

async function executeOnAvalanche(hxmsg, cluster, avalancheDeployment) {
  const startedAt = nowMs();
  const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC);
  const wallet = new ethers.Wallet(process.env.AVALANCHE_PRIVATE_KEY || '0x56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027', provider);
  const deployer = new ethers.NonceManager(wallet);
  const registry = new ethers.Contract(
    avalancheDeployment.teeRegistry,
    ['function isActiveTEE(address) view returns (bool)', `function registerTEE(${TEE_REGISTRATION_ABI}) external`],
    deployer
  );
  const registration = await registerEVMTEEs({ registry, certificate: cluster, teeURLs: TEE_URLS });
  const gateway = new ethers.Contract(
    avalancheDeployment.hxmsgGateway,
    [`function executeHXMsgMinimalCluster((bytes32,bytes32,uint8,bytes32,uint8,bytes32,bytes4,bytes32,bytes32,bytes32,bool,uint8,uint64,bytes32,uint64),address,bytes,${CLUSTER_CERT_ABI}) external`],
    deployer
  );
  const tx = await gateway.executeHXMsgMinimalCluster(
    toMinimalHXMsg(hxmsg),
    avalancheDeployment.targetContract,
    getExecutionData(hxmsg).callData,
    clusterCertificateTuple(cluster)
  );
  const receipt = await tx.wait();
  return {
    elapsedMs: nowMs() - startedAt,
    txHash: receipt.hash,
    gasUsed: Number(receipt.gasUsed),
    registrationGasUsed: Number(registration.gasUsed || 0n),
  };
}

async function main() {
  fs.ensureDirSync(RUNTIME_DIR);
  requiredEnv('SEPOLIA_RPC_URL');
  requiredEnv('SEPOLIA_PRIVATE_KEY');
  if (!process.env.SEPOLIA_LIGHT_CLIENT_BEACON_API_URL && !process.env.SEPOLIA_BEACON_API_URL) {
    throw new Error('SEPOLIA_LIGHT_CLIENT_BEACON_API_URL or SEPOLIA_BEACON_API_URL is required');
  }
  if (!fs.existsSync(SEPOLIA_DEPLOYMENT_FILE)) throw new Error(`Sepolia deployment file not found: ${SEPOLIA_DEPLOYMENT_FILE}`);
  if (!fs.existsSync(AVALANCHE_DEPLOYMENT_FILE)) throw new Error(`Avalanche deployment file not found: ${AVALANCHE_DEPLOYMENT_FILE}`);

  const sourceDeployment = fs.readJsonSync(SEPOLIA_DEPLOYMENT_FILE);
  const avalancheDeployment = fs.readJsonSync(AVALANCHE_DEPLOYMENT_FILE);
  const provider = new ethers.JsonRpcProvider(SEPOLIA_RPC);
  const totalStartedAt = nowMs();

  const sourceResult = await submitSepoliaSource({ provider, sourceDeployment, avalancheDeployment });
  console.log(`SEPOLIA->AVAX SOURCE tx=${sourceResult.sourceTxHash} block=${sourceResult.sourceBlockNumber} gas=${sourceResult.sourceGasUsed}`);

  const proof = await buildProofAndHXMsg({ provider, sourceDeployment, avalancheDeployment, sourceResult });
  console.log(`SEPOLIA->AVAX PROOF finalized=${proof.finality.finalizedHeight} finalityWaitMs=${proof.timings.finalityWaitMs}`);

  const tee = await attest(proof.hxmsg, proof.receiptProof, proof.syncCommitteeUpdate);
  console.log(`SEPOLIA->AVAX TEE quorum=${tee.cluster.reached}/${tee.cluster.threshold} block=${tee.verificationResult.blockNumber}`);

  const target = await executeOnAvalanche(proof.hxmsg, tee.cluster, avalancheDeployment);
  console.log(`SEPOLIA->AVAX PASS targetTx=${target.txHash} gas=${target.gasUsed}`);

  const result = {
    testType: 'sepolia-to-avalanche-sync-committee-to-warp-target',
    testedAt: new Date().toISOString(),
    pass: true,
    requestID: proof.hxmsg.header.requestID,
    hmsgDigest: proof.hxmsg.hmsgDigest,
    sourceTxHash: sourceResult.sourceTxHash,
    sourceBlockNumber: sourceResult.sourceBlockNumber,
    sourceBlockHash: sourceResult.sourceBlockHash,
    sourceGasUsed: sourceResult.sourceGasUsed,
    finality: proof.finality,
    teeCluster: tee.cluster,
    teeVerification: tee.verificationResult,
    targetTxHash: target.txHash,
    targetGasUsed: target.gasUsed,
    registrationGasUsed: target.registrationGasUsed,
    expectedPayload: normalizeBusinessPayload(sourceResult.payload),
    timings: {
      sourceMs: sourceResult.elapsedMs,
      ...proof.timings,
      teeMs: tee.elapsedMs,
      targetMs: target.elapsedMs,
      totalMs: nowMs() - totalStartedAt,
    },
  };
  writeJSON(RESULT_FILE, result);
  console.log(`Results: ${path.join(RUNTIME_DIR, RESULT_FILE)}`);
}

main().catch((error) => {
  const failure = {
    testType: 'sepolia-to-avalanche-sync-committee-to-warp-target',
    testedAt: new Date().toISOString(),
    pass: false,
    error: error.response?.data?.error || error.message,
    stack: error.stack,
    errorDetail: error.response?.data || null,
  };
  writeJSON(RESULT_FILE, failure);
  console.error(failure.error);
  process.exit(1);
});
