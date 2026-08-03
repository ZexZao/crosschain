const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { performance } = require('perf_hooks');
const { ethers } = require('ethers');
const { loadDotEnv } = require('../shared/env');
const { buildHXMsgFromEvmReceiptToEvm } = require('../hxmsg-builder/evm-to-evm');
const { buildReceiptProof } = require('../shared/evm/receipt-proof');
const { buildCommitteeHeaderUpdate } = require('../shared/evm/header-committee');
const { buildEvmContractCallTarget } = require('../hxmsg-builder/target-builders/evm');
const { composeHXMsg } = require('../hxmsg-builder/compose');
const { encodeCompactBusinessCall, compactBusinessCallTuple, normalizeBusinessPayload } = require('../shared/xmsg');
const { buildHXMsgBatch } = require('../shared/hxmsg/batch');
const {
  ChainType,
  RefType,
  MsgType,
  FeedbackType,
  FinalityModel,
  PolicyType,
  VerificationMethod,
  bytes32FromText,
  chainIdToBytes32,
  hashJson,
  hashBytes,
  toMinimalHXMsg,
  getExecutionData,
} = require('../shared/hxmsg');
const {
  cb58Encode,
  parseUnsignedWarpMessage,
  decodeHXMsgWarpPayload,
  validatorSetHash,
} = require('../shared/avalanche/warp-proof');
const { teeURLsFromEnv } = require('../shared/tee/subnet-routing');
const { registerEVMTEEs, clusterCertificateTuple } = require('../shared/tee/registration');
const { writeJSON } = require('../shared/utils');

loadDotEnv();

const PROJECT_ROOT = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, 'runtime');
const CASE_FILE = process.env.NO_RESPONSE_CASE_FILE || path.join(PROJECT_ROOT, 'test-cases', 'no-response-no-challenge-cases.json');
const RESULT_FILE = process.env.NO_RESPONSE_RESULT_FILE || 'local-evm-avalanche-no-response-gas-results.json';
const SUMMARY_FILE = path.join(RUNTIME_DIR, process.env.NO_RESPONSE_SUMMARY_FILE || 'local-evm-avalanche-no-response-gas-summary.md');
const EVM_RPC = process.env.EVM_RPC || 'http://127.0.0.1:8545';
const TEE_EVM_RPC = process.env.TEE_EVM_RPC || 'http://evm-node:8545';
const AVALANCHE_RPC = process.env.AVALANCHE_RPC_URL || 'http://127.0.0.1:9650/ext/bc/C/rpc';
const AVALANCHE_PCHAIN_RPC = process.env.AVALANCHE_PCHAIN_RPC_URL || 'http://127.0.0.1:9650/ext/P';
const LOCAL_EVM_KEY = process.env.LOCAL_EVM_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const AVALANCHE_KEY = process.env.AVALANCHE_PRIVATE_KEY || '0x56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027';
const AVALANCHE_NODE_ENDPOINTS = (process.env.AVALANCHE_NODE_ENDPOINTS || 'http://127.0.0.1:9650,http://127.0.0.1:9656,http://127.0.0.1:9652,http://127.0.0.1:9654,http://127.0.0.1:9658')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const EVM_TEE_URLS = teeURLsFromEnv({ sourceChainType: ChainType.EVM });
const AVALANCHE_TEE_URLS = teeURLsFromEnv({ sourceChainType: ChainType.AVALANCHE });
const CLUSTER_CERT_ABI = '(bytes32,uint64,uint16,uint16,uint256,bytes32,bytes,bytes32,uint64,uint64)';
const TEE_REGISTRATION_ABI = '(address teeAddress,uint16 signerIndex,bytes32 enclavePubKeyHash,bytes32 measurement,bytes32 quoteHash,bytes32 initialSyncStateHash,uint64 epoch,uint64 notAfter,bytes attestationSignature)';
const MINIMAL_TUPLE = '(bytes32,bytes32,uint8,bytes32,uint8,bytes32,bytes4,bytes32,bytes32,bytes32,bool,uint8,uint64,bytes32,uint64)';
const COMPACT_TUPLE = '(uint16,bytes32,bytes32,address,int256,bytes32,bool)';
const TEE_BATCH_SIZE = Number(process.env.HXMSG_TEE_BATCH_SIZE || 8);
const SOURCE_ABI = [
  'function submitHXMsgRequest(bytes32 targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 expireAt,(bool,uint8,uint64,bytes32,(bool,uint8,uint8,bytes32,bytes32,bytes32,uint64))) external returns (bytes32)',
  'event CrossChainCallRequested(bytes32 indexed requestID,address indexed sender,bytes32 indexed targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bool feedbackRequired,uint8 expectedFeedbackMsgType,uint64 feedbackTimeout,bytes32 callbackRefHash,bytes32 atomicityHash)',
];

function nowMs() {
  return Math.round(performance.now());
}

function artifact(contractFile, name) {
  return fs.readJsonSync(path.join(PROJECT_ROOT, 'artifacts', 'contracts', contractFile, `${name}.json`));
}

async function rpc(url, method, params) {
  const resp = await axios.post(url, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 30000 });
  if (resp.data.error) throw new Error(`${method}: ${resp.data.error.message}`);
  return resp.data.result;
}

async function resolveTeeLeader(teeURLs, label) {
  const statuses = await Promise.all(teeURLs.map(async (url) => {
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
  throw new Error(`no reachable ${label} TEE node: ${statuses.map((status) => `${status.url}:${status.error}`).join('; ')}`);
}

async function postToLeader(teeURLs, label, routePath, body, { timeout = 120000, maxAttempts = 10 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const teeUrl = await resolveTeeLeader(teeURLs, label);
    try {
      const resp = await axios.post(`${teeUrl}${routePath}`, body, { timeout });
      return { resp, teeUrl, attempt };
    } catch (error) {
      lastError = error;
      const message = error.response?.data?.error || error.message || '';
      const retryable = message.includes('current term barrier requires leader role')
        || message.includes('Raft leader unavailable')
        || message.includes('TEE cluster quorum not reached')
        || Number(error.response?.status || 0) === 409
        || Number(error.response?.status || 0) === 502
        || Number(error.response?.status || 0) === 503;
      if (!retryable || attempt === maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
  throw lastError;
}

function assertNoResponseCase(tc) {
  if (!tc.caseId || !tc.payload) throw new Error('caseId and payload are required');
  if (tc.payload.requireAck !== false) throw new Error(`${tc.caseId} must set requireAck=false`);
  if (tc.payload.atomicity) throw new Error(`${tc.caseId} must not include atomicity`);
}

function makePayload(tc, targetDeployment) {
  return {
    ...tc.payload,
    caseId: tc.caseId,
    targetRecipient: tc.payload.targetRecipient || targetDeployment.deployer,
  };
}

function buildEvmSubmitArgs({ targetDeployment, payload }) {
  const { normalized, compact, payloadHex, compactCallHash } = encodeCompactBusinessCall(payload);
  const callDataHash = compactCallHash;
  const businessPayloadHash = hashJson(normalized);
  const targetChainID = chainIdToBytes32(targetDeployment.chainId);
  const targetDomainID = bytes32FromText(`avalanche-local-${targetDeployment.chainId}`);
  const targetObject = ethers.zeroPadValue(targetDeployment.targetContract, 32);
  const functionSelector = ethers.id('executeCompact(bytes32,(uint16,bytes32,bytes32,address,int256,bytes32,bool))').slice(0, 10);
  const receiver = ethers.zeroPadValue(targetDeployment.targetContract, 32);
  const expireAt = Math.floor(Date.now() / 1000) + 7200;
  const atomicity = [false, 0, 0, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 0];
  const policy = [false, FeedbackType.NONE, 0, ethers.ZeroHash, atomicity];
  return {
    args: [
      targetChainID,
      targetDomainID,
      targetObject,
      functionSelector,
      callDataHash,
      businessPayloadHash,
      receiver,
      expireAt,
      policy,
    ],
    normalized,
    compact,
    payloadHex,
  };
}

async function submitEvmSource({ tc, sourceDeployment, targetDeployment, provider, source, nextNonce }) {
  const payload = makePayload(tc, targetDeployment);
  const submit = buildEvmSubmitArgs({ targetDeployment, payload });
  const startedAt = nowMs();
  const tx = await source.submitHXMsgRequest(...submit.args, { nonce: nextNonce() });
  const receipt = await tx.wait();
  return {
    payload,
    normalized: submit.normalized,
    receipt,
    sourceGasUsed: Number(receipt.gasUsed),
    sourceTxHash: receipt.hash,
    sourceBlockNumber: receipt.blockNumber,
    elapsedMs: nowMs() - startedAt,
  };
}

async function buildEvmOriginHXMsg({ sourceDeployment, targetDeployment, sourceResult, provider }) {
  const [block, receiptProof] = await Promise.all([
    provider.getBlock(sourceResult.receipt.blockNumber),
    buildReceiptProof({ provider, blockNumber: sourceResult.receipt.blockNumber, txHash: sourceResult.receipt.hash }),
  ]);
  const committeeHeaderUpdate = buildCommitteeHeaderUpdate({
    header: receiptProof.blockHeader,
    chainID: `eip155:${sourceDeployment.chainId}`,
  });
  const hxmsg = buildHXMsgFromEvmReceiptToEvm({
    sourceDeployment,
    targetDeployment,
    receipt: sourceResult.receipt,
    block,
    businessPayload: sourceResult.payload,
    targetChainType: ChainType.AVALANCHE,
    compactTarget: true,
  });
  return { hxmsg, receiptProof, committeeHeaderUpdate };
}

async function getValidatorSetRef() {
  const validatorsResp = await rpc(AVALANCHE_PCHAIN_RPC, 'platform.getCurrentValidators', [{}]);
  const heightResp = await rpc(AVALANCHE_PCHAIN_RPC, 'platform.getHeight', [{}]).catch(() => ({ height: 0 }));
  const validators = validatorsResp.validators.map((validator) => ({
    nodeID: validator.nodeID,
    weight: validator.weight,
    publicKey: validator.signer.publicKey,
  }));
  const totalWeight = validators.reduce((sum, validator) => sum + BigInt(validator.weight), 0n).toString();
  const pChainHeight = Number(heightResp.height || heightResp || 0);
  const ref = {
    networkID: Number(process.env.AVALANCHE_NETWORK_ID || 1337),
    pChainHeight,
    validatorSetHash: validatorSetHash(validators),
    totalWeight,
    quorumNumerator: 67,
    quorumDenominator: 100,
    canonicalOrdering: 'nodeID-ascending',
  };
  return { validators, ref };
}

async function collectValidatorSignatures(messageIDHex) {
  const messageID = cb58Encode(messageIDHex);
  const signatures = [];
  for (const baseURL of AVALANCHE_NODE_ENDPOINTS) {
    const nodeID = await rpc(`${baseURL}/ext/info`, 'info.getNodeID', []);
    const signature = await rpc(`${baseURL}/ext/bc/C/rpc`, 'warp_getMessageSignature', [messageID]);
    signatures.push({ nodeID: nodeID.nodeID, signature });
  }
  return signatures.sort((a, b) => a.nodeID.localeCompare(b.nodeID));
}

async function submitAvalancheSource({ tc, avalancheDeployment, targetDeployment, validatorSetRef }) {
  const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC);
  const wallet = new ethers.Wallet(AVALANCHE_KEY, provider);
  const sourceArtifact = artifact('AvalancheWarpSourceContract.sol', 'AvalancheWarpSourceContract');
  const source = new ethers.Contract(avalancheDeployment.avalancheWarpSourceContract, sourceArtifact.abi, wallet);
  const payload = makePayload(tc, targetDeployment);
  const encoded = encodeCompactBusinessCall(payload);
  const normalized = encoded.normalized;
  const compact = encoded.compact;
  const callData = encoded.payloadHex;
  const businessPayloadHash = hashJson(normalized);
  const targetChainID = chainIdToBytes32(targetDeployment.chainId);
  const targetDomainID = bytes32FromText(`evm-local-${targetDeployment.chainId}`);
  const targetObject = ethers.zeroPadValue(targetDeployment.targetContract, 32);
  const functionSelector = ethers.id('executeCompact(bytes32,(uint16,bytes32,bytes32,address,int256,bytes32,bool))').slice(0, 10);
  const receiver = ethers.zeroPadValue(targetDeployment.targetContract, 32);
  const expireAt = Math.floor(Date.now() / 1000) + 7200;
  const policyHash = hashJson({ validatorSetRef, canonicalOrdering: validatorSetRef.canonicalOrdering });
  const startedAt = nowMs();
  const tx = await source.submitWarpHXMsgRequest(
    targetChainID,
    targetDomainID,
    targetObject,
    functionSelector,
    callData,
    businessPayloadHash,
    receiver,
    expireAt,
    policyHash
  );
  const receipt = await tx.wait();
  const iface = new ethers.Interface(sourceArtifact.abi);
  const event = receipt.logs
    .map((log) => {
      try { return iface.parseLog(log); } catch (_) { return null; }
    })
    .find((parsed) => parsed?.name === 'AvalancheHXMsgWarpRequested');
  if (!event) throw new Error('AvalancheHXMsgWarpRequested event not found');
  const warpMessageID = event.args.warpMessageID;
  const unsignedWarpMessage = await rpc(AVALANCHE_RPC, 'warp_getMessage', [cb58Encode(warpMessageID)]);
  return {
    payload,
    normalized,
    compact,
    callData,
    businessPayloadHash,
    requestID: event.args.requestID,
    warpMessageID,
    unsignedWarpMessage,
    sourceGasUsed: Number(receipt.gasUsed),
    sourceTxHash: receipt.hash,
    sourceBlockNumber: receipt.blockNumber,
    elapsedMs: nowMs() - startedAt,
  };
}

function buildAvalancheOriginHXMsg({ sourceResult, avalancheDeployment, targetDeployment, validators, validatorSetRef, signatures }) {
  const parsed = parseUnsignedWarpMessage(sourceResult.unsignedWarpMessage);
  const warpPayload = decodeHXMsgWarpPayload(parsed.payload);
  const targetPart = buildEvmContractCallTarget({
    chainId: targetDeployment.chainId,
    requestID: sourceResult.requestID,
    targetAddress: targetDeployment.targetContract,
    functionSelector: warpPayload.functionSelector,
    callDataHash: warpPayload.callDataHash,
    receiver: warpPayload.receiver,
    chainType: ChainType.EVM,
  });
  const sourceProof = {
    proofType: 'AvalancheWarpMessage',
    warpMessageID: sourceResult.warpMessageID,
    unsignedWarpMessage: sourceResult.unsignedWarpMessage,
    unsignedWarpMessageHash: parsed.unsignedMessageHash,
    sourceChainID: parsed.sourceChainID,
    sourceContract: avalancheDeployment.avalancheWarpSourceContract,
    networkID: parsed.networkID,
  };
  const signatureProof = {
    scheme: 'BLS12-381',
    signedMessageHash: parsed.unsignedMessageHash,
    signatures,
  };
  const sourceRecord = {
    proofType: sourceProof.proofType,
    warpMessageID: sourceProof.warpMessageID,
    unsignedWarpMessageHash: sourceProof.unsignedWarpMessageHash,
    sourceChainID: sourceProof.sourceChainID,
    sourceContract: sourceProof.sourceContract,
    networkID: Number(sourceProof.networkID || 0),
    validatorSetHash: validatorSetRef.validatorSetHash,
    pChainHeight: Number(validatorSetRef.pChainHeight || 0),
    signatureSetHash: hashJson(signatures || []),
    signedWeight: validators.reduce((sum, validator) => sum + BigInt(validator.weight), 0n).toString(),
  };
  const sourcePayloadHash = hashJson(sourceRecord);
  const createdAt = Math.floor(Date.now() / 1000);
  const hxmsg = composeHXMsg({
    header: {
      version: 1,
      requestID: sourceResult.requestID,
      msgType: MsgType.CONTRACT_CALL,
      nonce: Number(warpPayload.nonce),
      createdAt,
      expireAt: warpPayload.expireAt,
    },
    source: {
      chainType: ChainType.AVALANCHE,
      chainID: parsed.sourceChainID,
      domainID: bytes32FromText('avalanche-local-domain'),
    },
    target: targetPart.target,
    sourceRef: {
      refType: RefType.AVALANCHE_WARP_MESSAGE,
      refHash: hashBytes(sourceResult.unsignedWarpMessage),
      encodedRef: sourceResult.unsignedWarpMessage,
    },
    targetAction: targetPart.targetAction,
    verification: {
      verificationMethod: VerificationMethod.AVALANCHE_ICM_BLS,
      finality: {
        model: FinalityModel.APPLICATION,
        confirmations: 0,
        checkpointRoot: validatorSetRef.validatorSetHash,
        epoch: Number(validatorSetRef.pChainHeight),
        committeePolicyHash: warpPayload.policyHash,
      },
      policyRef: {
        policyType: PolicyType.AVALANCHE_VALIDATOR_SET,
        policyHash: warpPayload.policyHash,
      },
      verifierProfileHash: bytes32FromText('avalanche-icm-real-warp-profile-v1'),
      adapterID: 'avalanche-icm-bls',
    },
    payloadBinding: {
      sourcePayloadHash,
      businessPayloadHash: sourceResult.businessPayloadHash,
      targetExecutionHash: targetPart.targetExecutionHash,
    },
    feedback: {
      required: false,
      expectedMsgType: FeedbackType.NONE,
      timeout: 0,
      callbackRefHash: ethers.ZeroHash,
    },
    atomicity: null,
    callData: warpPayload.callData,
    compactCall: sourceResult.compact,
    callDataDecoded: sourceResult.normalized,
    txId: sourceResult.warpMessageID,
    srcHeight: Number(validatorSetRef.pChainHeight || 0),
    sourceRecord,
    proofMeta: {
      proofType: sourceProof.proofType,
      pChainHeight: validatorSetRef.pChainHeight,
      validatorSetHash: validatorSetRef.validatorSetHash,
    },
  });
  hxmsg._blockData = {
    avalancheProof: {
      sourceProof,
      validatorSetRef,
      validatorSet: validators,
      signatureProof,
      payloadBinding: {
        sourceMessageID: sourceProof.warpMessageID,
      },
    },
  };
  return hxmsg;
}

function chunkItems(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function attestBatch({ items, teeURLs, label }) {
  const startedAt = nowMs();
  const { resp } = await postToLeader(teeURLs, label, '/attest-batch', {
    hxmsgs: items.map((item) => item.hxmsg),
    helperDataList: items.map((item) => item.helperData),
  });
  const cluster = resp.data.teeBatchCertification;
  if (!cluster?.quorumReached) throw new Error(`${label} TEE batch quorum not reached`);
  const built = buildHXMsgBatch(items.map((item) => item.hxmsg));
  if (built.batchRoot.toLowerCase() !== String(resp.data.batchRoot).toLowerCase()) {
    throw new Error(`${label} TEE batch root mismatch`);
  }
  return {
    elapsedMs: nowMs() - startedAt,
    cluster,
    built,
    verificationResults: resp.data.verificationResults || [],
  };
}

async function executeCompactBatch({ items, batch, targetDeployment, rpcURL, privateKey, teeURLs }) {
  const startedAt = nowMs();
  const provider = new ethers.JsonRpcProvider(rpcURL);
  const wallet = new ethers.Wallet(privateKey, provider);
  const deployer = new ethers.NonceManager(wallet);
  const registry = new ethers.Contract(
    targetDeployment.teeRegistry,
    ['function isActiveTEE(address) view returns (bool)', `function registerTEE(${TEE_REGISTRATION_ABI}) external`],
    deployer
  );
  const registration = await registerEVMTEEs({ registry, certificate: batch.cluster, teeURLs });
  const calls = items.map((item) => getExecutionData(item.hxmsg).compactCall);
  const allTransfers = calls.every((call) => Number(call.opCode) === 9);
  let assetCheck = null;
  let token;
  let assetService;
  let reserveBefore;
  const expectedByRecipient = new Map();
  const recipientBefore = new Map();
  if (allTransfers) {
    const target = new ethers.Contract(targetDeployment.targetContract, ['function assetService() view returns (address)'], provider);
    assetService = await target.assetService();
    token = new ethers.Contract(targetDeployment.settlementToken, ['function balanceOf(address) view returns (uint256)'], provider);
    reserveBefore = await token.balanceOf(assetService);
    for (const call of calls) {
      const recipient = ethers.getAddress(call.actorAddress);
      expectedByRecipient.set(recipient, (expectedByRecipient.get(recipient) || 0n) + BigInt(call.amount));
    }
    for (const recipient of expectedByRecipient.keys()) {
      recipientBefore.set(recipient, await token.balanceOf(recipient));
    }
  }
  const gateway = new ethers.Contract(
    targetDeployment.hxmsgGateway,
    [`function executeHXMsgMinimalCompactBatchCluster(${MINIMAL_TUPLE}[],address,${COMPACT_TUPLE}[],bytes32,bytes32,${CLUSTER_CERT_ABI}) external`],
    deployer
  );
  const tx = await gateway.executeHXMsgMinimalCompactBatchCluster(
    items.map((item) => toMinimalHXMsg(item.hxmsg)),
    targetDeployment.targetContract,
    calls.map(compactBusinessCallTuple),
    batch.built.batchID,
    batch.built.batchRoot,
    clusterCertificateTuple(batch.cluster),
    process.env.HXMSG_EVM_GAS_LIMIT ? { gasLimit: BigInt(process.env.HXMSG_EVM_GAS_LIMIT) } : {}
  );
  const receipt = await tx.wait();
  if (allTransfers) {
    const reserveAfter = await token.balanceOf(assetService);
    const expectedReserveDelta = calls.reduce((sum, call) => sum + BigInt(call.amount), 0n);
    const recipients = [];
    let verified = reserveBefore - reserveAfter === expectedReserveDelta;
    for (const [recipient, expectedDelta] of expectedByRecipient.entries()) {
      const before = recipientBefore.get(recipient);
      const after = await token.balanceOf(recipient);
      const actualDelta = after - before;
      if (actualDelta !== expectedDelta) verified = false;
      recipients.push({ recipient, before: before.toString(), after: after.toString(), expectedDelta: expectedDelta.toString(), actualDelta: actualDelta.toString() });
    }
    assetCheck = {
      verified,
      reserve: { address: assetService, before: reserveBefore.toString(), after: reserveAfter.toString(), expectedDelta: expectedReserveDelta.toString(), actualDelta: (reserveBefore - reserveAfter).toString() },
      recipients,
    };
  }
  return {
    elapsedMs: nowMs() - startedAt,
    txHash: receipt.hash,
    gasUsed: Number(receipt.gasUsed),
    gasPerMessage: Math.ceil(Number(receipt.gasUsed) / items.length),
    registrationGasUsed: Number(registration.gasUsed || 0n),
    assetCheck,
  };
}

function summarize(results) {
  const passed = results.filter((item) => item.pass);
  const sum = (field) => passed.reduce((acc, item) => acc + Number(item[field] || 0), 0);
  const avg = (field) => (passed.length ? Math.round(sum(field) / passed.length) : 0);
  const byDirection = {};
  for (const direction of ['EVM->Avalanche', 'Avalanche->EVM']) {
    const items = passed.filter((item) => item.direction === direction);
    const dirSum = (field) => items.reduce((acc, item) => acc + Number(item[field] || 0), 0);
    byDirection[direction] = {
      passed: items.length,
      sourceGasTotal: dirSum('sourceGasUsed'),
      sourceGasAverage: items.length ? Math.round(dirSum('sourceGasUsed') / items.length) : 0,
      targetGasTotal: dirSum('targetGasUsed'),
      targetGasAverage: items.length ? Math.round(dirSum('targetGasUsed') / items.length) : 0,
      targetRegistrationGasTotal: dirSum('targetRegistrationGasUsed'),
    };
  }
  return {
    passed: passed.length,
    failed: results.length - passed.length,
    sourceGasTotal: sum('sourceGasUsed'),
    sourceGasAverage: avg('sourceGasUsed'),
    targetGasTotal: sum('targetGasUsed'),
    targetGasAverage: avg('targetGasUsed'),
    targetRegistrationGasTotal: sum('targetRegistrationGasUsed'),
    totalMessageGasWithoutRegistration: sum('sourceGasUsed') + sum('targetGasUsed'),
    totalGasWithRegistration: sum('sourceGasUsed') + sum('targetGasUsed') + sum('targetRegistrationGasUsed'),
    byDirection,
  };
}

function writeSummary(output) {
  const lines = [];
  lines.push('# Local Ethereum/Avalanche No-Response Gas Results');
  lines.push('');
  lines.push(`Tested at: ${output.testedAt}`);
  lines.push(`Cases: ${output.caseFile}`);
  lines.push('');
  lines.push('| Case | Direction | Source gas | Target gas | Target TEE register gas | TEE quorum | Pass |');
  lines.push('|---|---|---:|---:|---:|---|---|');
  for (const item of output.results) {
    lines.push(`| ${item.caseId} | ${item.direction} | ${item.sourceGasUsed ?? '-'} | ${item.targetGasUsed ?? '-'} | ${item.targetRegistrationGasUsed ?? 0} | ${item.teeCluster ? `${item.teeCluster.reached}/${item.teeCluster.threshold}` : '-'} | ${item.pass ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('');
  lines.push(`Message gas without registration: ${output.summary.totalMessageGasWithoutRegistration}`);
  lines.push(`Gas with target TEE registration: ${output.summary.totalGasWithRegistration}`);
  lines.push('');
  fs.writeFileSync(SUMMARY_FILE, `${lines.join('\n')}\n`);
}

async function main() {
  fs.ensureDirSync(RUNTIME_DIR);
  const cases = fs.readJsonSync(CASE_FILE);
  if (!Array.isArray(cases)) throw new Error('case file must be an array of normal test cases');
  cases.forEach(assertNoResponseCase);

  const sourceDeployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));
  const avalancheDeployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'avalanche-deployment.json'));
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet = new ethers.Wallet(LOCAL_EVM_KEY, provider);
  const source = new ethers.Contract(sourceDeployment.evmSourceContract, SOURCE_ABI, wallet);
  let nonceValue = await provider.getTransactionCount(wallet.address, 'pending');
  const nextNonce = () => {
    const nonce = nonceValue;
    nonceValue += 1;
    return nonce;
  };
  const validatorInfo = await getValidatorSetRef();
  const results = [];
  const startedAt = nowMs();

  const evmItems = [];
  for (const tc of cases) {
    try {
      const sourceResult = await submitEvmSource({ tc, sourceDeployment, targetDeployment: avalancheDeployment, provider, source, nextNonce });
      const proof = await buildEvmOriginHXMsg({ sourceDeployment, targetDeployment: avalancheDeployment, sourceResult, provider });
      evmItems.push({
        tc,
        hxmsg: proof.hxmsg,
        helperData: {
          evmReceiptProof: proof.receiptProof,
          committeeHeaderUpdate: proof.committeeHeaderUpdate,
          evmRpc: TEE_EVM_RPC,
        },
        sourceResult,
      });
    } catch (error) {
      results.push({ caseId: tc.caseId, name: tc.name, direction: 'EVM->Avalanche', pass: false, error: error.message });
    }
  }
  for (const items of chunkItems(evmItems, TEE_BATCH_SIZE)) {
    try {
      const batch = await attestBatch({ items, teeURLs: EVM_TEE_URLS, label: 'EVM' });
      const target = await executeCompactBatch({
        items,
        batch,
        targetDeployment: avalancheDeployment,
        rpcURL: AVALANCHE_RPC,
        privateKey: AVALANCHE_KEY,
        teeURLs: EVM_TEE_URLS,
      });
      items.forEach((item, index) => {
        const result = {
          caseId: item.tc.caseId,
          name: item.tc.name,
          direction: 'EVM->Avalanche',
          pass: target.assetCheck?.verified !== false,
          requestID: item.hxmsg.header.requestID,
          hmsgDigest: item.hxmsg.hmsgDigest,
          sourceTxHash: item.sourceResult.sourceTxHash,
          targetTxHash: target.txHash,
          sourceGasUsed: item.sourceResult.sourceGasUsed,
          targetGasUsed: target.gasPerMessage,
          batchTargetGasUsed: target.gasUsed,
          targetRegistrationGasUsed: index === 0 ? target.registrationGasUsed : 0,
          batchID: batch.built.batchID,
          batchSize: items.length,
          teeCluster: batch.cluster,
          teeVerification: batch.verificationResults[index],
          assetCheck: index === 0 ? target.assetCheck : null,
          timings: { sourceMs: item.sourceResult.elapsedMs, teeMs: batch.elapsedMs, targetMs: target.elapsedMs },
          payload: normalizeBusinessPayload(makePayload(item.tc, avalancheDeployment)),
        };
        console.log(`${item.tc.caseId} EVM->Avalanche PASS sourceGas=${result.sourceGasUsed} batchTargetGas=${target.gasUsed} avgTargetGas=${result.targetGasUsed}`);
        results.push(result);
      });
    } catch (error) {
      items.forEach((item) => results.push({ caseId: item.tc.caseId, name: item.tc.name, direction: 'EVM->Avalanche', pass: false, error: error.response?.data?.error || error.message }));
    }
  }

  const avalancheItems = [];
  for (const tc of cases) {
    try {
      const sourceResult = await submitAvalancheSource({ tc, avalancheDeployment, targetDeployment: sourceDeployment, validatorSetRef: validatorInfo.ref });
      const signatures = await collectValidatorSignatures(sourceResult.warpMessageID);
      const hxmsg = buildAvalancheOriginHXMsg({
        sourceResult,
        avalancheDeployment,
        targetDeployment: sourceDeployment,
        validators: validatorInfo.validators,
        validatorSetRef: validatorInfo.ref,
        signatures,
      });
      avalancheItems.push({ tc, hxmsg, helperData: hxmsg._blockData, sourceResult, signatures });
    } catch (error) {
      results.push({ caseId: tc.caseId, name: tc.name, direction: 'Avalanche->EVM', pass: false, error: error.message });
    }
  }
  for (const items of chunkItems(avalancheItems, TEE_BATCH_SIZE)) {
    try {
      const batch = await attestBatch({ items, teeURLs: AVALANCHE_TEE_URLS, label: 'Avalanche' });
      const target = await executeCompactBatch({
        items,
        batch,
        targetDeployment: sourceDeployment,
        rpcURL: EVM_RPC,
        privateKey: LOCAL_EVM_KEY,
        teeURLs: AVALANCHE_TEE_URLS,
      });
      items.forEach((item, index) => {
        const result = {
          caseId: item.tc.caseId,
          name: item.tc.name,
          direction: 'Avalanche->EVM',
          pass: target.assetCheck?.verified !== false,
          requestID: item.hxmsg.header.requestID,
          hmsgDigest: item.hxmsg.hmsgDigest,
          sourceTxHash: item.sourceResult.sourceTxHash,
          targetTxHash: target.txHash,
          sourceGasUsed: item.sourceResult.sourceGasUsed,
          targetGasUsed: target.gasPerMessage,
          batchTargetGasUsed: target.gasUsed,
          targetRegistrationGasUsed: index === 0 ? target.registrationGasUsed : 0,
          validatorSignatures: item.signatures.length,
          batchID: batch.built.batchID,
          batchSize: items.length,
          teeCluster: batch.cluster,
          teeVerification: batch.verificationResults[index],
          assetCheck: index === 0 ? target.assetCheck : null,
          timings: { sourceMs: item.sourceResult.elapsedMs, teeMs: batch.elapsedMs, targetMs: target.elapsedMs },
          payload: normalizeBusinessPayload(makePayload(item.tc, sourceDeployment)),
        };
        console.log(`${item.tc.caseId} Avalanche->EVM PASS sourceGas=${result.sourceGasUsed} batchTargetGas=${target.gasUsed} avgTargetGas=${result.targetGasUsed}`);
        results.push(result);
      });
    } catch (error) {
      items.forEach((item) => results.push({ caseId: item.tc.caseId, name: item.tc.name, direction: 'Avalanche->EVM', pass: false, error: error.response?.data?.error || error.message }));
    }
  }

  const output = {
    testType: 'local-ethereum-avalanche-no-response-no-challenge-gas',
    testedAt: new Date().toISOString(),
    caseFile: CASE_FILE,
    teeBatchSize: TEE_BATCH_SIZE,
    total: results.length,
    summary: summarize(results),
    timings: {
      totalMs: nowMs() - startedAt,
    },
    results,
  };
  writeJSON(RESULT_FILE, output);
  writeSummary(output);
  console.log(`FINAL pass=${output.summary.passed}/${output.total} failed=${output.summary.failed}`);
  console.log(`Results: ${path.join(RUNTIME_DIR, RESULT_FILE)}`);
  console.log(`Summary: ${SUMMARY_FILE}`);
  process.exit(output.summary.failed > 0 ? 1 : 0);
}

main().catch((error) => {
  const failure = {
    testType: 'local-ethereum-avalanche-no-response-no-challenge-gas',
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
