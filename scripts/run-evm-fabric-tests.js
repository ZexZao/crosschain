const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { performance } = require('perf_hooks');
const { ethers } = require('ethers');
const { Gateway, Wallets } = require('fabric-network');
const { loadDotEnv } = require('../shared/env');
const { buildHXMsgFromEvmReceipt, FABRIC_INVOKE_SELECTOR, buildFabricTargetObject } = require('../hxmsg-builder/evm-to-fabric');
const { buildReceiptProof } = require('../shared/evm/receipt-proof');
const { buildCommitteeHeaderUpdate } = require('../shared/evm/header-committee');
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
const { FeedbackType } = require('../shared/hxmsg');
const {
  ChainType,
  bytes32FromText,
  hashJson,
  AtomicityMode,
  CommitmentType,
  getExecutionData,
  toMinimalHXMsg,
} = require('../shared/hxmsg');
const { encodeCompactBusinessCall, normalizeBusinessPayload } = require('../shared/xmsg');
const { writeJSON } = require('../shared/utils');
const { registerFabricTEEs } = require('../shared/tee/registration');
const { teeURLsFromEnv } = require('../shared/tee/subnet-routing');

loadDotEnv();

const PROJECT_ROOT = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, 'runtime');
const USE_SEPOLIA_SYNC_COMMITTEE = process.env.USE_SEPOLIA_SYNC_COMMITTEE === 'true';
const EVM_RPC = process.env.EVM_RPC || (USE_SEPOLIA_SYNC_COMMITTEE
  ? process.env.SEPOLIA_RPC_URL
  : 'http://127.0.0.1:8545');
const TEE_EVM_RPC = process.env.TEE_EVM_RPC || (USE_SEPOLIA_SYNC_COMMITTEE
  ? EVM_RPC
  : 'http://evm-node:8545');
const TEE_URLS = teeURLsFromEnv({ sourceChainType: ChainType.EVM });

const REQUESTED_SOURCE_TX_CONCURRENCY = Number(process.env.HXMSG_SOURCE_CONCURRENCY || (USE_SEPOLIA_SYNC_COMMITTEE ? 2 : 1));
const SOURCE_TX_CONCURRENCY = USE_SEPOLIA_SYNC_COMMITTEE || process.env.HXMSG_ALLOW_LOCAL_PARALLEL_SOURCE === 'true'
  ? REQUESTED_SOURCE_TX_CONCURRENCY
  : 1;
const PROOF_CONCURRENCY = Number(process.env.HXMSG_PROOF_CONCURRENCY || (USE_SEPOLIA_SYNC_COMMITTEE ? 2 : 4));
const TEE_CONCURRENCY = Number(process.env.HXMSG_TEE_CONCURRENCY || 1);
const FABRIC_CONCURRENCY = Number(process.env.HXMSG_FABRIC_CONCURRENCY || 2);
const DEFAULT_CASE_TOTAL = Number(process.env.HXMSG_CASE_TOTAL || 64);
const TEE_BATCH_SIZE = Math.max(1, Number(process.env.HXMSG_TEE_BATCH_SIZE || 1));
const NO_WRITE_RESULTS = process.env.HXMSG_NO_WRITE_RESULTS === 'true';

const SOURCE_ABI = [
  'function submitHXMsgRequest(bytes32 targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 expireAt,(bool,uint8,uint64,bytes32,(bool,uint8,uint8,bytes32,bytes32,bytes32,uint64))) external returns (bytes32)',
  'function requests(bytes32) view returns (bytes32 targetExecutionHash,bytes32 failureActionHash,uint64 feedbackTimeout,uint64 challengeWindow,uint64 challengeDeadline,uint8 commitmentType,uint8 status)',
  'event CrossChainCallRequested(bytes32 indexed requestID,address indexed sender,bytes32 indexed targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bool feedbackRequired,uint8 expectedFeedbackMsgType,uint64 feedbackTimeout,bytes32 callbackRefHash,bytes32 atomicityHash)',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function monotonicMs() {
  return Math.round(performance.now());
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function getFabricContract() {
  const profile = process.env.FABRIC_CONNECTION_PROFILE || path.join(PROJECT_ROOT, 'fabric-network', 'connection-org1.json');
  const walletPath = process.env.FABRIC_WALLET_PATH || path.join(PROJECT_ROOT, 'fabric-network', 'wallet');
  const identity = process.env.FABRIC_IDENTITY || 'appUser';
  const channel = process.env.FABRIC_CHANNEL || 'mychannel';
  const chaincode = process.env.FABRIC_CHAINCODE || 'xcall';
  const ccp = fs.readJsonSync(profile);
  const wallet = await Wallets.newFileSystemWallet(walletPath);
  const gateway = new Gateway();
  await gateway.connect(ccp, {
    wallet,
    identity,
    discovery: { enabled: true, asLocalhost: process.env.FABRIC_AS_LOCALHOST !== 'false' },
  });
  const network = await gateway.getNetwork(channel);
  return { gateway, contract: network.getContract(chaincode) };
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
  const knownLeader = knownLeaderID
    ? statuses.find((status) => status.nodeID === knownLeaderID && !status.error)
    : null;
  if (knownLeader) return knownLeader.url;
  const available = statuses.find((status) => !status.error);
  if (available) return available.url;
  throw new Error(`no reachable TEE node: ${statuses.map((status) => `${status.url}:${status.error}`).join('; ')}`);
}

function isRetryableTeeLeaderError(error) {
  const message = error.response?.data?.error || error.message || '';
  return message.includes('current term barrier requires leader role')
    || message.includes('Raft leader unavailable')
    || message.includes('TEE cluster quorum not reached')
    || message.includes('TEE batch quorum not reached')
    || Number(error.response?.status || 0) === 409
    || Number(error.response?.status || 0) === 502
    || Number(error.response?.status || 0) === 503;
}

async function postToCurrentTeeLeader(routePath, body, { timeout, maxAttempts = 3 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const teeUrl = await resolveTeeLeader();
    try {
      const resp = await axios.post(`${teeUrl}${routePath}`, body, { timeout });
      return { resp, teeUrl, attempt };
    } catch (error) {
      lastError = error;
      if (!isRetryableTeeLeaderError(error) || attempt === maxAttempts) throw error;
      const message = error.response?.data?.error || error.message;
      console.log(`TEE leader retry ${attempt}/${maxAttempts}: ${message}`);
      await sleep(1000 * attempt);
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

function buildBaseCaseTemplates(now, round, suffix) {
  return [
    {
      payload: {
        op: 'asset_lock',
        assetId: `EVM_ASSET_${now}_${suffix}`,
        assetType: 'XCST',
        amount: String(12.5 + round),
        recipient: `fabric.alice.${round}`,
        owner: `evm.alice.${round}`,
        metadata: `asset settlement batch ${round}`,
        requireAck: false,
      },
    },
    {
      payload: {
        op: 'mint_confirm',
        assetId: `EVM_MINT_${now}_${suffix}`,
        assetType: 'XCST',
        amount: String(8 + round),
        recipient: `fabric.bob.${round}`,
        issuer: 'evm.bridge.minter',
        metadata: `mint confirmation batch ${round}`,
        requireAck: false,
      },
    },
    {
      payload: {
        op: 'receivable_attest',
        receivableId: `EVM_AR_${now}_${suffix}`,
        supplier: `fabric.supplier.${round}`,
        amount: String(3200 + round),
        debtor: `evm.buyer.${round}`,
        metadata: `receivable attestation batch ${round}`,
        requireAck: false,
      },
    },
    {
      payload: {
        op: 'logistics_sync',
        waybillId: `EVM_WAYBILL_${now}_${suffix}`,
        inspector: `fabric.inspector.${round}`,
        reading: String(42 + round),
        location: `hangzhou-zone-${round}`,
        metadata: `logistics synchronization batch ${round}`,
        requireAck: false,
      },
    },
    {
      payload: {
        op: 'medical_consent',
        consentId: `EVM_CONSENT_${now}_${suffix}`,
        grantee: `fabric.hospital.${round}`,
        durationDays: 30 + round,
        patient: `evm.patient.${round}`,
        metadata: `medical consent grant batch ${round}`,
        requireAck: false,
      },
    },
    {
      payload: {
        op: 'oracle_update',
        feed: `EVM_PRICE_${now}_${suffix}`,
        price: `1.${String(2345 + round).padStart(4, '0')}`,
        sourceAgency: 'evm-oracle-bridge',
        roundId: now + round,
        metadata: `oracle update batch ${round}`,
        requireAck: false,
      },
    },
    {
      payload: {
        op: 'approval_commit',
        workflowId: `EVM_APPROVAL_${now}_${suffix}`,
        approvers: [`fabric.approverA.${round}`, `fabric.approverB.${round}`, `fabric.approverC.${round}`],
        threshold: 2,
        applicant: `evm.applicant.${round}`,
        metadata: `approval commit batch ${round}`,
        requireAck: false,
      },
    },
    {
      payload: {
        op: 'subsidy_confirm',
        applicationId: `EVM_SUBSIDY_${now}_${suffix}`,
        assetType: 'XCST',
        subsidyAmount: String(66 + round),
        beneficiary: `fabric.farmer.${round}`,
        institution: 'evm.agencyA',
        metadata: `subsidy confirmation batch ${round}`,
        requireAck: false,
      },
    },
  ];
}

function buildCases(now, total = DEFAULT_CASE_TOTAL) {
  const cases = [];
  let round = 0;
  while (cases.length < total) {
    round += 1;
    const templates = buildBaseCaseTemplates(now, round, String(round).padStart(3, '0'));
    for (const template of templates) {
      if (cases.length >= total) break;
      const caseNo = cases.length + 1;
      cases.push({
        caseId: `EVM-FABRIC-${String(caseNo).padStart(3, '0')}`,
        payload: template.payload,
      });
    }
  }
  return cases;
}

function expectedBusinessStatus(op) {
  return {
    asset_lock: 'ASSET_SETTLED',
    mint_confirm: 'ASSET_SETTLED',
    receivable_attest: 'RECEIVABLE_ATTESTED',
    logistics_sync: 'LOGISTICS_SYNCED',
    medical_consent: 'CONSENT_GRANTED',
    oracle_update: 'ORACLE_UPDATED',
    approval_commit: 'APPROVAL_COMMITTED',
    subsidy_confirm: 'ASSET_SETTLED',
    identity_attest: 'IDENTITY_ATTESTED',
    carbon_retire: 'CARBON_RETIRED',
    iot_alert: 'IOT_ALERT_RECORDED',
    certificate_verify: 'CERTIFICATE_VERIFIED',
    benchmark_store: 'BENCHMARK_STORED',
  }[op] || 'RECORDED';
}

function buildSubmitArgs({ deployment, payload }) {
  const channelID = process.env.FABRIC_CHANNEL || 'mychannel';
  const chaincodeName = process.env.FABRIC_CHAINCODE || 'xcall';
  const { normalized, payloadHex, compactCallHash } = encodeCompactBusinessCall(payload);
  const expireAt = Math.floor(Date.now() / 1000) + 3600;
  const targetChainID = bytes32FromText(`fabric-${channelID}`);
  const targetDomainID = bytes32FromText('fabric-local-domain');
  const targetObject = buildFabricTargetObject(channelID, chaincodeName);
  const callDataHash = compactCallHash;
  const businessPayloadHash = hashJson(normalized);
  const receiver = bytes32FromText(normalized.actor);
  const atomicityRequired = Boolean(payload.atomicity?.required);
  const atomicity = atomicityRequired
    ? [
      true,
      payload.atomicity.mode || AtomicityMode.COMMIT_OR_COMPENSATE,
      payload.atomicity.commitmentType || CommitmentType.INTENT_ONLY,
      payload.atomicity.commitmentRefHash || ethers.keccak256(ethers.toUtf8Bytes(`commitment:${normalized.recordId}`)),
      payload.atomicity.successActionHash || ethers.keccak256(ethers.toUtf8Bytes(`success:${normalized.recordId}`)),
      payload.atomicity.failureActionHash || ethers.keccak256(ethers.toUtf8Bytes(payload.failureData || `failure:${normalized.recordId}`)),
      Number(payload.atomicity.challengeWindow || 60),
    ]
    : [false, 0, CommitmentType.NONE, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 0];
  const policy = atomicityRequired
    ? [true, FeedbackType.RESPONSE, Number(payload.feedbackTimeout || expireAt), ethers.ZeroHash, atomicity]
    : [false, FeedbackType.NONE, 0, ethers.ZeroHash, atomicity];
  return {
    args: [
      targetChainID,
      targetDomainID,
      targetObject,
      FABRIC_INVOKE_SELECTOR,
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
    chainId: deployment.chainId,
  };
}

async function sendSourceTransaction({ sourceContract, provider, deployment, tc, nextNonce }) {
  const result = baseResult(tc);
  result.timings.caseStartedAt = monotonicMs();
  const startedAt = monotonicMs();
  const submit = buildSubmitArgs({ deployment, payload: tc.payload });
  const txOptions = {};
  if (nextNonce) txOptions.nonce = nextNonce();
  const tx = await sourceContract.submitHXMsgRequest(...submit.args, txOptions);
  const receipt = await tx.wait();
  const event = receipt.logs
    .map((log) => {
      try {
        return sourceContract.interface.parseLog(log);
      } catch (_) {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === 'CrossChainCallRequested');
  if (!event?.args?.requestID) throw new Error('CrossChainCallRequested event not found');
  result.timings.sourceTxMs = monotonicMs() - startedAt;
  result.evmTxHash = receipt.hash;
  result.evmGasUsed = receipt.gasUsed.toString();
  result.sourceBlockNumber = receipt.blockNumber;
  result.sourceBlockHash = receipt.blockHash;
  result.requestID = event.args.requestID;
  result.callData = submit.payloadHex;
  result.expectedPayload = normalizeBusinessPayload(tc.payload);
  console.log(`${tc.caseId} SOURCE tx=${receipt.hash} block=${receipt.blockNumber}`);
  return { tc, result, receipt };
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

async function fetchExecutionFinalized(provider) {
  const finalized = await provider.send('eth_getBlockByNumber', ['finalized', false]);
  if (!finalized) return null;
  return {
    finalized,
    finalizedHeight: Number(BigInt(finalized.number)),
    finalizedHash: finalized.hash,
    source: 'execution-rpc',
  };
}

async function fetchBeaconFinalized(beaconApiUrl) {
  const finality = await fetchJson(beaconApiUrl, '/eth/v1/beacon/light_client/finality_update');
  const execution = finality.data?.finalized_header?.execution;
  if (!execution?.block_number) return null;
  return {
    finalized: finality,
    finalizedHeight: Number(execution.block_number),
    finalizedHash: execution.block_hash,
    beaconFinalizedSlot: Number(finality.data.finalized_header.beacon.slot),
    signatureSlot: Number(finality.data.signature_slot),
    source: 'beacon-light-client-finality-update',
  };
}

async function waitForFinalizedExecutionBlock({ provider, beaconApiUrl, targetBlockNumber, timeoutMs }) {
  const started = monotonicMs();
  let lastFinality = null;
  async function checkFinality() {
    const finalized = beaconApiUrl ? await fetchBeaconFinalized(beaconApiUrl) : await fetchExecutionFinalized(provider);
    lastFinality = finalized || lastFinality;
    if (finalized && finalized.finalizedHeight >= Number(targetBlockNumber)) {
      return { ...finalized, waitMs: monotonicMs() - started };
    }
    return null;
  }
  while (monotonicMs() - started < timeoutMs) {
    try {
      const finalized = await checkFinality();
      if (finalized) return finalized;
    } catch (error) {
      lastFinality = lastFinality || { finalizedHeight: 0, source: `transient-error:${error.message}` };
    }
    await sleep(12000);
  }
  const finalized = await checkFinality();
  if (finalized) return finalized;
  const last = lastFinality ? ` lastFinalized=${lastFinality.finalizedHeight} source=${lastFinality.source}` : '';
  throw new Error(`Sepolia finality timeout for block ${targetBlockNumber}.${last}`);
}

async function buildProofItem({ item, provider, deployment, sharedSyncCommitteeUpdate }) {
  const { tc, result, receipt } = item;
  try {
    const proofStartedAt = monotonicMs();
    const [block, receiptProof] = await Promise.all([
      provider.getBlock(receipt.blockNumber),
      buildReceiptProof({ provider, blockNumber: receipt.blockNumber, txHash: receipt.hash }),
    ]);
    let committeeHeaderUpdate = null;
    let syncCommitteeUpdate = null;
    if (USE_SEPOLIA_SYNC_COMMITTEE) {
      syncCommitteeUpdate = {
        ...sharedSyncCommitteeUpdate,
        chainID: `eip155:${deployment.chainId}`,
      };
    } else {
      committeeHeaderUpdate = buildCommitteeHeaderUpdate({
        header: receiptProof.blockHeader,
        chainID: `eip155:${deployment.chainId}`,
      });
    }
    result.timings.proofBuildMs = monotonicMs() - proofStartedAt;

    const hxmsgStartedAt = monotonicMs();
    const hxmsg = buildHXMsgFromEvmReceipt({
      deployment,
      receipt,
      block,
      businessPayload: tc.payload,
    });
    result.timings.hxmsgBuildMs = monotonicMs() - hxmsgStartedAt;
    result.feedback = hxmsg.feedback;
    result.atomicity = hxmsg.atomicity || null;
    result.responseRequired = Boolean(hxmsg.feedback?.required);
    result.atomicityRequired = Boolean(hxmsg.atomicity?.required);
    result.protocolCheck = {
      feedbackDisabled: hxmsg.feedback?.required === false
        && Number(hxmsg.feedback?.expectedMsgType || 0) === FeedbackType.NONE
        && Number(hxmsg.feedback?.timeout || 0) === 0
        && hxmsg.feedback?.callbackRefHash === ethers.ZeroHash,
      atomicityDisabled: !hxmsg.atomicity?.required,
      challengeResponseExpected: false,
    };
    if (!NO_WRITE_RESULTS) {
      writeJSON(`latest-evm-xmsg-${tc.caseId}.json`, hxmsg);
    }
    return {
      ...item,
      hxmsg,
      receiptProof,
      committeeHeaderUpdate,
      syncCommitteeUpdate,
    };
  } catch (error) {
    result.error = error.response?.data?.error || error.message;
    result.errorDetail = error.response?.data || null;
    console.log(`${tc.caseId} PROOF ERROR ${result.error}`);
    return item;
  }
}

async function attestWithTEE({ item }) {
  const { tc, result, hxmsg, receiptProof, committeeHeaderUpdate, syncCommitteeUpdate } = item;
  if (!hxmsg || !receiptProof) return item;
  try {
    const teeStartedAt = monotonicMs();
    const { resp: teeResp } = await postToCurrentTeeLeader('/attest', {
      hxmsg,
      helperData: {
        evmReceiptProof: receiptProof,
        committeeHeaderUpdate,
        syncCommitteeUpdate,
        evmRpc: TEE_EVM_RPC,
      },
    }, { timeout: Number(process.env.HXMSG_TEE_TIMEOUT_MS || 60000) });
    result.timings.teeAttestMs = monotonicMs() - teeStartedAt;
    const voucher = teeResp.data.teeClusterCertification;
    if (!voucher?.quorumReached) throw new Error(`TEE quorum not reached: ${voucher?.reached || 0}/${voucher?.threshold || '?'}`);
    result.teeVerification = teeResp.data.verificationResult;
    result.teeCluster = teeResp.data.teeClusterCertification;
    console.log(`${tc.caseId} TEE quorum=${result.teeCluster.reached}/${result.teeCluster.threshold}`);
    return { ...item, hxmsg, voucher };
  } catch (error) {
    result.error = error.response?.data?.error || error.message;
    result.errorDetail = error.response?.data || null;
    console.log(`${tc.caseId} TEE ERROR ${result.error}`);
    return item;
  }
}

function chunkItems(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function attestBatchWithTEE({ items }) {
  const eligible = items.filter((item) => !item.sourceFailed && !item.error && item.hxmsg && item.receiptProof);
  if (eligible.length === 0) return items;
  const teeStartedAt = monotonicMs();
  try {
    const { resp: teeResp } = await postToCurrentTeeLeader('/attest-batch', {
      hxmsgs: eligible.map((item) => item.hxmsg),
      helperDataList: eligible.map((item) => ({
        evmReceiptProof: item.receiptProof,
        committeeHeaderUpdate: item.committeeHeaderUpdate,
        syncCommitteeUpdate: item.syncCommitteeUpdate,
        evmRpc: TEE_EVM_RPC,
      })),
    }, { timeout: Number(process.env.HXMSG_TEE_TIMEOUT_MS || 120000) });
    const elapsed = monotonicMs() - teeStartedAt;
    const batchCert = teeResp.data.teeBatchCertification;
    if (!batchCert?.quorumReached) throw new Error(`TEE batch quorum not reached: ${batchCert?.reached || 0}/${batchCert?.threshold || '?'}`);
    eligible.forEach((item, index) => {
      item.result.timings.teeAttestMs = elapsed;
      item.result.teeVerification = teeResp.data.verificationResults?.[index] || null;
      item.result.teeCluster = batchCert;
      item.result.teeBatch = {
        batchID: teeResp.data.batchID,
        batchRoot: teeResp.data.batchRoot,
        batchSize: teeResp.data.batchSize,
        batchSigningDigest: teeResp.data.batchSigningDigest,
      };
      item.voucher = {
        ...batchCert,
        batchID: teeResp.data.batchID,
        batchRoot: teeResp.data.batchRoot,
        batchSize: teeResp.data.batchSize,
        batchSigningDigest: teeResp.data.batchSigningDigest,
        merkleProof: teeResp.data.merkleProofs?.[index] || [],
      };
      console.log(`${item.tc.caseId} TEE batch quorum=${batchCert.reached}/${batchCert.threshold} batchSize=${teeResp.data.batchSize}`);
    });
    return items;
  } catch (error) {
    const message = error.response?.data?.error || error.message;
    for (const item of eligible) {
      item.result.error = message;
      item.result.errorDetail = error.response?.data || null;
      console.log(`${item.tc.caseId} TEE BATCH ERROR ${message}`);
    }
    return items;
  }
}

async function registerTrustedTEEs(contract, attestedItems) {
  const certificates = attestedItems.map((item) => item.voucher).filter(Boolean);
  const startedAt = monotonicMs();
  const registration = await registerFabricTEEs({ contract, certificates, teeURLs: TEE_URLS });
  return {
    teeAddresses: registration.teeAddresses,
    elapsedMs: monotonicMs() - startedAt,
  };
}

async function queryInbound(contract, requestID) {
  const data = await contract.evaluateTransaction('GetInboundStatus', requestID);
  return data && data.length > 0 ? JSON.parse(data.toString()) : null;
}

async function queryBusinessRecord(contract, requestID) {
  const data = await contract.evaluateTransaction('QueryBusinessRecordByRequest', requestID);
  return data && data.length > 0 ? JSON.parse(data.toString()) : null;
}

function compactDeliveryObject(hxmsg) {
  const minimal = toMinimalHXMsg(hxmsg);
  return {
    requestID: minimal[0],
    hmsgDigest: minimal[1],
    targetChainType: Number(minimal[2]),
    targetChainID: minimal[3],
    actionType: Number(minimal[4]),
    targetObject: minimal[5],
    functionSelector: minimal[6],
    callDataHash: minimal[7],
    receiver: minimal[8],
    targetExecutionHash: minimal[9],
    feedbackRequired: Boolean(minimal[10]),
    expectedFeedbackMsgType: Number(minimal[11] || 0),
    feedbackTimeout: Number(minimal[12] || 0),
    callbackRefHash: minimal[13],
    expireAt: Number(minimal[14] || 0),
    sourceChainType: Number(hxmsg.source?.chainType || ChainType.EVM),
  };
}

function jsonBytes(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value));
}

async function executeOnFabric({ item, contract, sourceView }) {
  const { result, hxmsg, voucher } = item;
  if (!hxmsg || !voucher) {
    result.pass = false;
    result.timings.totalMs = monotonicMs() - result.timings.caseStartedAt;
    return item;
  }
  try {
    const executionData = getExecutionData(hxmsg);
    const compactDelivery = compactDeliveryObject(hxmsg);
    const compactCall = executionData.compactCall;
    const businessPayload = executionData.businessPayload;
    if (!compactCall || !businessPayload) throw new Error('compact execution data is required');
    const fullArgs = [JSON.stringify(hxmsg), executionData.callData, JSON.stringify(voucher)];
    const compactArgs = [
      JSON.stringify(compactDelivery),
      JSON.stringify(compactCall),
      JSON.stringify(businessPayload),
      JSON.stringify(voucher),
    ];
    const fabricStartedAt = monotonicMs();
    const fabricResp = await contract.submitTransaction(
      'ExecuteHXMsgCompact',
      ...compactArgs
    );
    result.timings.fabricExecuteMs = monotonicMs() - fabricStartedAt;
    result.fabricSubmissionBytes = {
      legacyFullJsonArgs: fullArgs.reduce((sum, arg) => sum + jsonBytes(arg), 0),
      compactJsonArgs: compactArgs.reduce((sum, arg) => sum + jsonBytes(arg), 0),
      savedBytes: fullArgs.reduce((sum, arg) => sum + jsonBytes(arg), 0) - compactArgs.reduce((sum, arg) => sum + jsonBytes(arg), 0),
    };

    const queryStartedAt = monotonicMs();
    const inbound = await queryInbound(contract, hxmsg.header.requestID);
    const businessRecord = await queryBusinessRecord(contract, hxmsg.header.requestID);
    const sourceRecord = await sourceView.requests(hxmsg.header.requestID);
    result.timings.resultQueryMs = monotonicMs() - queryStartedAt;
    result.fabricResult = fabricResp.toString();
    result.inbound = inbound;
    result.businessRecord = businessRecord;
    result.sourceRequest = {
      status: Number(sourceRecord.status ?? sourceRecord[6]),
      feedbackTimeout: Number(sourceRecord.feedbackTimeout ?? sourceRecord[2]),
      challengeWindow: Number(sourceRecord.challengeWindow ?? sourceRecord[3]),
      challengeDeadline: Number(sourceRecord.challengeDeadline ?? sourceRecord[4]),
      commitmentType: Number(sourceRecord.commitmentType ?? sourceRecord[5]),
    };
    result.pass = Boolean(inbound)
      && Boolean(businessRecord)
      && inbound.recordId === result.expectedPayload.recordId
      && inbound.actor === result.expectedPayload.actor
      && inbound.amount === result.expectedPayload.amount
      && inbound.status === 'executed'
      && businessRecord.op === inbound.op
      && businessRecord.recordId === inbound.recordId
      && businessRecord.actor === inbound.actor
      && businessRecord.amount === inbound.amount
      && businessRecord.status === expectedBusinessStatus(inbound.op)
      && result.protocolCheck.feedbackDisabled
      && result.protocolCheck.atomicityDisabled
      && result.sourceRequest.challengeWindow === 0
      && result.sourceRequest.commitmentType === 0
      && Number(inbound.validTEECount || 0) >= Number((voucher.threshold || 1));
    console.log(`${result.caseId} ${result.pass ? 'PASS' : 'FAIL'} requestID=${result.requestID}`);
  } catch (error) {
    result.error = error.responses?.[0]?.response?.message || error.response?.data?.error || error.message;
    result.errorDetail = error.response?.data || null;
    console.log(`${result.caseId} FABRIC ERROR ${result.error}`);
  }
  result.timings.totalMs = monotonicMs() - result.timings.caseStartedAt;
  return item;
}

function baseResult(tc) {
  return {
    caseId: tc.caseId,
    pass: false,
    timings: {
      sourceTxMs: 0,
      finalityWaitMs: 0,
      proofBuildMs: 0,
      hxmsgBuildMs: 0,
      teeAttestMs: 0,
      teeRegistrationMs: 0,
      fabricExecuteMs: 0,
      resultQueryMs: 0,
      totalMs: 0,
    },
  };
}

function writeSummary({ output, finalityTimeoutMs, sharedFinality }) {
  const compressionRows = output.results
    .map((r) => r.fabricSubmissionBytes)
    .filter(Boolean);
  const sumCompression = (field) => compressionRows.reduce((sum, row) => sum + Number(row[field] || 0), 0);
  const legacyBytes = sumCompression('legacyFullJsonArgs');
  const compactBytes = sumCompression('compactJsonArgs');
  const savedBytes = sumCompression('savedBytes');
  const compressionSummary = compressionRows.length > 0
    ? `**Fabric 目标提交压缩**：legacy avg=${(legacyBytes / compressionRows.length / 1024).toFixed(2)} KiB, compact avg=${(compactBytes / compressionRows.length / 1024).toFixed(2)} KiB, saved=${(savedBytes / compressionRows.length / 1024).toFixed(2)} KiB/message, reduction=${(100 * (1 - compactBytes / legacyBytes)).toFixed(2)}%\n`
    : '';
  fs.writeFileSync(
    path.join(RUNTIME_DIR, 'hxmsg-evm-fabric-summary.md'),
    `# h-xmsg / MELV-EF EVM -> Fabric 测试结果\n\n` +
      `**测试时间**：${output.testedAt}\n` +
      `**通过率**：${output.pass}/${output.total}\n` +
      `**运行模式**：${output.executionMode}\n` +
      `**并发配置**：source=${output.concurrency.sourceTx}, proof=${output.concurrency.proof}, tee=${output.concurrency.tee}, fabric=${output.concurrency.fabric}\n` +
      `**TEE 批签名大小**：${output.teeBatchSize || 1}\n` +
      `**finality 等待上限**：${finalityTimeoutMs} ms\n` +
      `**共享 finality 等待**：${sharedFinality ? `${sharedFinality.waitMs} ms, finalizedHeight=${sharedFinality.finalizedHeight}` : '-'}\n` +
      compressionSummary +
      `\n` +
      `| 用例 | RESPONSE | Atomicity | EVM tx | EVM Gas | Source tx ms | Finality wait ms | Proof ms | TEE ms | Fabric ms | Total ms | TEE quorum | Fabric 状态 | 状态 |\n` +
      `|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|\n` +
      output.results.map((r) => `| ${r.caseId} | ${r.responseRequired ? 'yes' : 'no'} | ${r.atomicityRequired ? 'yes' : 'no'} | ${r.evmTxHash || '-'} | ${r.evmGasUsed || '-'} | ${r.timings?.sourceTxMs ?? '-'} | ${r.timings?.finalityWaitMs ?? '-'} | ${r.timings?.proofBuildMs ?? '-'} | ${r.timings?.teeAttestMs ?? '-'} | ${r.timings?.fabricExecuteMs ?? '-'} | ${r.timings?.totalMs ?? '-'} | ${r.teeCluster ? `${r.teeCluster.reached}/${r.teeCluster.threshold}` : '-'} | ${r.inbound?.status || '-'} | ${r.pass ? 'PASS' : 'FAIL'} |`).join('\n') +
      `\n`
  );
}

async function main() {
  if (!EVM_RPC) throw new Error('EVM_RPC or SEPOLIA_RPC_URL is required');
  fs.ensureDirSync(RUNTIME_DIR);
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const signerPrivateKey = USE_SEPOLIA_SYNC_COMMITTEE
    ? (process.env.SEPOLIA_PRIVATE_KEY || process.env.DEPLOYER_PRIVATE_KEY)
    : (process.env.LOCAL_EVM_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
  if (!signerPrivateKey) throw new Error('SEPOLIA_PRIVATE_KEY is required for Sepolia mode');
  const signer = new ethers.Wallet(
    signerPrivateKey,
    provider
  );
  let nextNonceValue = await provider.getTransactionCount(signer.address, 'pending');
  const nextNonce = () => {
    const nonce = nextNonceValue;
    nextNonceValue += 1;
    return nonce;
  };
  const sourceContract = new ethers.Contract(deployment.evmSourceContract, SOURCE_ABI, signer);
  const sourceView = new ethers.Contract(deployment.evmSourceContract, SOURCE_ABI, provider);
  const now = Date.now();
  const cases = buildCases(now, DEFAULT_CASE_TOTAL);
  const caseLimit = Number(process.env.HXMSG_CASE_LIMIT || cases.length);
  const selectedCases = cases.slice(0, Math.max(0, Math.min(cases.length, caseLimit)));
  const finalityTimeoutMs = Number(process.env.SEPOLIA_FINALITY_TIMEOUT_MS || 15 * 60 * 1000);
  const beaconApiUrl = process.env.SEPOLIA_LIGHT_CLIENT_BEACON_API_URL || process.env.SEPOLIA_BEACON_API_URL;
  const startedAt = monotonicMs();
  let latestSharedFinality = null;
  let syncCommitteeState = null;

  console.log(`RUN ${selectedCases.length}/${cases.length} cases mode=${USE_SEPOLIA_SYNC_COMMITTEE ? 'sepolia-sync-committee' : 'local-mock-committee'} sourceConcurrency=${SOURCE_TX_CONCURRENCY}`);
  if (!USE_SEPOLIA_SYNC_COMMITTEE && REQUESTED_SOURCE_TX_CONCURRENCY > 1 && process.env.HXMSG_ALLOW_LOCAL_PARALLEL_SOURCE !== 'true') {
    console.log('Local Hardhat automine uses sourceConcurrency=1; later proof/TEE/Fabric stages still run with configured concurrency.');
  }

  const sourceItems = await mapLimit(selectedCases, SOURCE_TX_CONCURRENCY, (tc) => sendSourceTransaction({
    sourceContract,
    provider,
    deployment,
    tc,
    nextNonce,
  }).catch((error) => {
    const result = baseResult(tc);
    result.timings.caseStartedAt = monotonicMs();
    result.error = error.message;
    result.timings.totalMs = monotonicMs() - result.timings.caseStartedAt;
    console.log(`${tc.caseId} SOURCE ERROR ${result.error}`);
    return { tc, result, sourceFailed: true };
  }));

  const sourceSuccess = sourceItems.filter((item) => !item.sourceFailed);
  let sharedSyncCommitteeUpdate = null;
  if (USE_SEPOLIA_SYNC_COMMITTEE && sourceSuccess.length > 0) {
    syncCommitteeState = loadSyncCommitteeState();
    const teeUrlForState = await resolveTeeLeader();
    const teeTrustedBlockRoot = await fetchTeeSyncCommitteeRoot(teeUrlForState);
    const trustedBlockRoot = teeTrustedBlockRoot
      || process.env.SEPOLIA_TRUSTED_BLOCK_ROOT
      || resolveTrustedBlockRoot({ state: syncCommitteeState });
    if (!trustedBlockRoot && process.env.SEPOLIA_ALLOW_DYNAMIC_TRUSTED_ROOT !== 'true') {
      throw new Error(`SEPOLIA_TRUSTED_BLOCK_ROOT or ${syncCommitteeStateFile()} is required`);
    }
    const finalityStartedAt = monotonicMs();
    const minBlock = Math.min(...sourceSuccess.map((item) => item.receipt.blockNumber));
    const maxBlock = Math.max(...sourceSuccess.map((item) => item.receipt.blockNumber));
    latestSharedFinality = await waitForFinalizedExecutionBlock({
      provider,
      beaconApiUrl,
      targetBlockNumber: maxBlock,
      timeoutMs: finalityTimeoutMs,
    });
    const finalityWaitMs = monotonicMs() - finalityStartedAt;
    for (const item of sourceSuccess) {
      item.result.timings.finalityWaitMs = finalityWaitMs;
      item.result.finality = {
        finalizedHeight: latestSharedFinality.finalizedHeight,
        finalizedHash: latestSharedFinality.finalizedHash,
        sourceBlockNumber: item.receipt.blockNumber,
        source: latestSharedFinality.source,
        beaconFinalizedSlot: latestSharedFinality.beaconFinalizedSlot || null,
        signatureSlot: latestSharedFinality.signatureSlot || null,
        sharedFinalityForMaxSourceBlock: maxBlock,
      };
    }
    const syncStartedAt = monotonicMs();
    sharedSyncCommitteeUpdate = await fetchBeaconLightClientInputs({
      beaconApiUrl,
      executionProvider: provider,
      targetBlockNumber: minBlock,
      trustedBlockRoot,
      allowDynamicTrustedRoot: process.env.SEPOLIA_ALLOW_DYNAMIC_TRUSTED_ROOT === 'true',
      maxAncestorHeaders: Number(process.env.SEPOLIA_MAX_ANCESTOR_HEADERS || 512),
    });
    sharedSyncCommitteeUpdate.chainID = `eip155:${deployment.chainId}`;
    const verifiedSyncCommittee = await verifySyncCommitteeHeaderUpdate(sharedSyncCommitteeUpdate, {
      expectedChainID: sharedSyncCommitteeUpdate.chainID,
    });
    syncCommitteeState = saveSyncCommitteeState({
      chainID: sharedSyncCommitteeUpdate.chainID,
      trustedBlockRoot: verifiedSyncCommittee.nextTrustedBlockRoot,
      finalizedHeight: verifiedSyncCommittee.finalizedHeight,
      finalizedHash: verifiedSyncCommittee.finalizedHash,
      beaconFinalizedSlot: verifiedSyncCommittee.beaconFinalizedSlot,
      signatureSlot: verifiedSyncCommittee.signatureSlot,
      syncCommitteePeriod: verifiedSyncCommittee.syncCommitteePeriod,
      participantCount: verifiedSyncCommittee.participantCount,
      source: 'run-evm-fabric-tests',
    });
    const syncFetchMs = monotonicMs() - syncStartedAt;
    for (const item of sourceSuccess) {
      item.result.timings.sharedSyncCommitteeFetchMs = syncFetchMs;
      item.result.syncCommittee = {
        trustedBlockRoot: sharedSyncCommitteeUpdate.trustedBlockRoot,
        nextTrustedBlockRoot: verifiedSyncCommittee.nextTrustedBlockRoot,
        trustedRootSource: teeTrustedBlockRoot ? 'tee-chain-state' : (process.env.SEPOLIA_TRUSTED_BLOCK_ROOT ? 'env' : 'runtime-state'),
        syncCommitteePeriod: verifiedSyncCommittee.syncCommitteePeriod,
        committeeUpdateCount: verifiedSyncCommittee.committeeUpdates.length,
        participantCount: verifiedSyncCommittee.participantCount,
        stateFile: syncCommitteeStateFile(),
      };
    }
  }

  const proofItems = await mapLimit(sourceItems, PROOF_CONCURRENCY, async (item) => {
    if (item.sourceFailed) return item;
    return buildProofItem({ item, provider, deployment, sharedSyncCommitteeUpdate });
  });

  let attestedItems;
  if (TEE_BATCH_SIZE > 1) {
    const batches = chunkItems(proofItems, TEE_BATCH_SIZE);
    const attestedBatches = await mapLimit(batches, TEE_CONCURRENCY, (items) => attestBatchWithTEE({ items }));
    attestedItems = attestedBatches.flat();
  } else {
    attestedItems = await mapLimit(proofItems, TEE_CONCURRENCY, async (item) => {
      if (item.sourceFailed || item.error) return item;
      return attestWithTEE({ item });
    });
  }

  const { gateway, contract } = await getFabricContract();
  try {
    const registration = await registerTrustedTEEs(contract, attestedItems);
    for (const item of attestedItems) {
      if (item.voucher) item.result.timings.teeRegistrationMs = registration.elapsedMs;
    }
    await mapLimit(attestedItems, FABRIC_CONCURRENCY, (item) => executeOnFabric({ item, contract, sourceView }));
    for (const item of attestedItems) {
      const result = item.result;
      if (!result.timings.totalMs) {
        result.timings.totalMs = monotonicMs() - (result.timings.caseStartedAt || startedAt);
      }
      delete result.timings.caseStartedAt;
    }
  } finally {
    gateway.disconnect();
  }

  const results = attestedItems.map((item) => item.result);
  const pass = results.filter((result) => result.pass).length;
  const fail = results.length - pass;
  const output = {
    testType: 'hxmsg-melv-ef-evm-to-fabric',
    testedAt: new Date().toISOString(),
    executionMode: USE_SEPOLIA_SYNC_COMMITTEE ? 'sepolia-sync-committee' : 'local-mock-committee',
    total: selectedCases.length,
    configuredTotal: cases.length,
    pass,
    fail,
    concurrency: {
      sourceTx: SOURCE_TX_CONCURRENCY,
      proof: PROOF_CONCURRENCY,
      tee: TEE_CONCURRENCY,
      fabric: FABRIC_CONCURRENCY,
    },
    teeBatchSize: TEE_BATCH_SIZE,
    sharedFinality: latestSharedFinality,
    syncCommitteeState,
    elapsedMs: monotonicMs() - startedAt,
    results,
  };
  if (!NO_WRITE_RESULTS) {
    writeJSON('hxmsg-evm-fabric-results.json', output);
    writeSummary({ output, finalityTimeoutMs, sharedFinality: latestSharedFinality });
  }
  console.log(`FINAL ${pass}/${selectedCases.length} passed, ${fail} failed elapsedMs=${output.elapsedMs}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
