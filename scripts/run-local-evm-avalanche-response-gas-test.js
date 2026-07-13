const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { performance } = require('perf_hooks');
const { ethers } = require('ethers');
const { loadDotEnv } = require('../shared/env');
const { buildHXMsgFromEvmReceiptToEvm } = require('../hxmsg-builder/evm-to-evm');
const { buildReceiptProof } = require('../shared/evm/receipt-proof');
const { buildCommitteeHeaderUpdate } = require('../shared/evm/header-committee');
const {
  ChainType,
  FeedbackType,
  ResponseStatus,
  bytes32FromText,
  chainIdToBytes32,
  hashJson,
  computeResponseDigest,
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
const RESULT_FILE = 'local-evm-avalanche-response-gas-results.json';
const EVM_RPC = process.env.EVM_RPC || 'http://127.0.0.1:8545';
const TEE_EVM_RPC = process.env.TEE_EVM_RPC || 'http://evm-node:8545';
const AVALANCHE_RPC = process.env.AVALANCHE_RPC_URL || 'http://127.0.0.1:9650/ext/bc/C/rpc';
const LOCAL_EVM_KEY = process.env.LOCAL_EVM_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEFAULT_AVALANCHE_KEY = '0x56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027';
const AVALANCHE_KEY = process.env.AVALANCHE_PRIVATE_KEY || DEFAULT_AVALANCHE_KEY;
const EVM_TEE_URLS = teeURLsFromEnv({ sourceChainType: ChainType.EVM });
const CLUSTER_CERT_ABI = '(bytes32,uint64,uint16,uint16,uint256,bytes32,bytes,bytes32,uint64,uint64)';
const TEE_REGISTRATION_ABI = '(address teeAddress,uint16 signerIndex,bytes32 enclavePubKeyHash,bytes32 measurement,bytes32 quoteHash,bytes32 initialSyncStateHash,uint64 epoch,uint64 notAfter,bytes attestationSignature)';
const SOURCE_ABI = [
  'function submitHXMsgRequest(bytes32 targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 expireAt,(bool,uint8,uint64,bytes32,(bool,uint8,uint8,bytes32,bytes32,bytes32,uint64))) external returns (bytes32)',
  'function requests(bytes32) view returns (address,bytes32,bytes32,bytes32,bytes4,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,uint8,uint8)',
  'function completeWithResponse(bytes32,(bytes32,bytes32,uint8,bytes32,bytes32,bytes32),'
    + `${CLUSTER_CERT_ABI}) external`,
  'event CrossChainCallRequested(bytes32 indexed requestID,address indexed sender,bytes32 indexed targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bool feedbackRequired,uint8 expectedFeedbackMsgType,uint64 feedbackTimeout,bytes32 callbackRefHash,bytes32 atomicityHash)',
];

function nowMs() {
  return Math.round(performance.now());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveTeeLeader() {
  const statuses = await Promise.all(EVM_TEE_URLS.map(async (url) => {
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
  throw new Error(`no reachable EVM TEE node: ${statuses.map((status) => `${status.url}:${status.error}`).join('; ')}`);
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

async function postToCurrentTeeLeader(routePath, body, { timeout = 120000, maxAttempts = 10 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const teeUrl = await resolveTeeLeader();
    try {
      const resp = await axios.post(`${teeUrl}${routePath}`, body, { timeout });
      return { resp, teeUrl, attempt };
    } catch (error) {
      lastError = error;
      if (!isRetryableTeeLeaderError(error) || attempt === maxAttempts) throw error;
      console.log(`TEE retry ${attempt}/${maxAttempts}: ${error.response?.data?.error || error.message}`);
      await sleep(1500 * attempt);
    }
  }
  throw lastError;
}

function responseTuple(response) {
  return [
    response.originRequestID,
    response.originHmsgDigest,
    Number(response.responseStatus),
    response.targetExecutionHash,
    response.targetProofRefHash,
    response.responsePayloadHash,
  ];
}

function proofRefFromReceipt(receipt) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint64', 'bytes32'],
      [receipt.hash || receipt.transactionHash, Number(receipt.blockNumber), receipt.blockHash]
    )
  );
}

function buildPayload(avalancheDeployment) {
  return {
    op: 'token_transfer',
    assetId: `LOCAL_EVM_AVAX_RESPONSE_${Date.now()}`,
    amount: '21',
    recipient: 'avalanche.receiver.response',
    targetRecipient: avalancheDeployment.deployer,
    metadata: 'local Ethereum to Avalanche response-required message',
    requireAck: true,
  };
}

function buildSubmitArgs({ avalancheDeployment, payload }) {
  const { normalized, payloadHex } = encodeBusinessPayload(payload);
  const callDataHash = ethers.keccak256(payloadHex);
  const businessPayloadHash = hashJson(normalized);
  const targetChainID = chainIdToBytes32(avalancheDeployment.chainId);
  const targetDomainID = bytes32FromText(`evm-local-${avalancheDeployment.chainId}`);
  const targetObject = ethers.zeroPadValue(avalancheDeployment.targetContract, 32);
  const functionSelector = ethers.id('execute(bytes32,bytes)').slice(0, 10);
  const receiver = ethers.zeroPadValue(avalancheDeployment.targetContract, 32);
  const expireAt = Math.floor(Date.now() / 1000) + 7200;
  const feedbackTimeout = Math.floor(Date.now() / 1000) + 3600;
  const atomicity = [false, 0, 0, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 0];
  const policy = [true, FeedbackType.RESPONSE, feedbackTimeout, ethers.ZeroHash, atomicity];
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
    payloadHex,
  };
}

async function submitSourceRequest({ sourceDeployment, avalancheDeployment }) {
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet = new ethers.Wallet(LOCAL_EVM_KEY, provider);
  const source = new ethers.Contract(sourceDeployment.evmSourceContract, SOURCE_ABI, wallet);
  const payload = buildPayload(avalancheDeployment);
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
    provider,
    wallet,
    source,
    payload,
    normalized: submit.normalized,
    receipt,
    requestID: event.args.requestID,
    sourceTxHash: receipt.hash,
    sourceGasUsed: Number(receipt.gasUsed),
    elapsedMs: nowMs() - startedAt,
  };
}

async function buildOriginHXMsg({ sourceDeployment, avalancheDeployment, sourceResult }) {
  const [block, receiptProof] = await Promise.all([
    sourceResult.provider.getBlock(sourceResult.receipt.blockNumber),
    buildReceiptProof({
      provider: sourceResult.provider,
      blockNumber: sourceResult.receipt.blockNumber,
      txHash: sourceResult.receipt.hash,
    }),
  ]);
  const committeeHeaderUpdate = buildCommitteeHeaderUpdate({
    header: receiptProof.blockHeader,
    chainID: `eip155:${sourceDeployment.chainId}`,
  });
  const hxmsg = buildHXMsgFromEvmReceiptToEvm({
    sourceDeployment,
    targetDeployment: avalancheDeployment,
    receipt: sourceResult.receipt,
    block,
    businessPayload: sourceResult.payload,
  });
  return { hxmsg, receiptProof, committeeHeaderUpdate };
}

async function attestOrigin(hxmsg, receiptProof, committeeHeaderUpdate) {
  const startedAt = nowMs();
  const { resp, teeUrl, attempt } = await postToCurrentTeeLeader('/attest', {
    hxmsg,
    helperData: {
      evmReceiptProof: receiptProof,
      committeeHeaderUpdate,
      evmRpc: TEE_EVM_RPC,
    },
  });
  const cluster = resp.data.teeClusterCertification;
  if (!cluster?.quorumReached) throw new Error(`origin TEE quorum not reached: ${cluster?.reached || 0}/${cluster?.threshold || '?'}`);
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
  const wallet = new ethers.Wallet(AVALANCHE_KEY, provider);
  const deployer = new ethers.NonceManager(wallet);
  const registry = new ethers.Contract(
    avalancheDeployment.teeRegistry,
    ['function isActiveTEE(address) view returns (bool)', `function registerTEE(${TEE_REGISTRATION_ABI}) external`],
    deployer
  );
  const registration = await registerEVMTEEs({ registry, certificate: cluster, teeURLs: EVM_TEE_URLS });
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
    provider,
    receipt,
    elapsedMs: nowMs() - startedAt,
    txHash: receipt.hash,
    gasUsed: Number(receipt.gasUsed),
    registrationGasUsed: Number(registration.gasUsed || 0n),
  };
}

async function attestResponse({ originHxmsg, avalancheExecution }) {
  const receiptProof = await buildReceiptProof({
    provider: avalancheExecution.provider,
    blockNumber: avalancheExecution.receipt.blockNumber,
    txHash: avalancheExecution.receipt.hash,
  });
  const committeeHeaderUpdate = buildCommitteeHeaderUpdate({
    header: receiptProof.blockHeader,
    chainID: 'eip155:1337',
  });
  const response = {
    originRequestID: originHxmsg.header.requestID,
    originHmsgDigest: originHxmsg.hmsgDigest,
    responseStatus: ResponseStatus.EXECUTED,
    targetExecutionHash: originHxmsg.payloadBinding.targetExecutionHash,
    targetProofRefHash: proofRefFromReceipt(avalancheExecution.receipt),
    responsePayloadHash: ethers.keccak256(ethers.toUtf8Bytes(`executed:${originHxmsg.header.requestID}`)),
  };
  const startedAt = nowMs();
  const { resp, teeUrl, attempt } = await postToCurrentTeeLeader('/attest-response', {
    response,
    helperData: {
      originHxmsg,
      evmExecutionReceipt: receiptProof,
      committeeHeaderUpdate,
      evmChainID: 'eip155:1337',
      evmRpc: AVALANCHE_RPC,
    },
  });
  const cluster = resp.data.teeClusterCertification;
  if (!cluster?.quorumReached) throw new Error(`response TEE quorum not reached: ${cluster?.reached || 0}/${cluster?.threshold || '?'}`);
  return {
    response,
    responseDigest: resp.data.responseDigest || computeResponseDigest(response),
    elapsedMs: nowMs() - startedAt,
    teeUrl,
    attempt,
    cluster,
    verificationResult: resp.data.verificationResult,
  };
}

async function completeResponseOnEthereum({ sourceDeployment, sourceResult, responseAttestation }) {
  const startedAt = nowMs();
  const deployer = new ethers.NonceManager(sourceResult.wallet);
  const registry = new ethers.Contract(
    sourceDeployment.teeRegistry,
    ['function isActiveTEE(address) view returns (bool)', `function registerTEE(${TEE_REGISTRATION_ABI}) external`],
    deployer
  );
  const registration = await registerEVMTEEs({
    registry,
    certificate: responseAttestation.cluster,
    teeURLs: EVM_TEE_URLS,
  });
  const source = new ethers.Contract(sourceDeployment.evmSourceContract, SOURCE_ABI, deployer);
  const tx = await source.completeWithResponse(
    sourceResult.requestID,
    responseTuple(responseAttestation.response),
    clusterCertificateTuple(responseAttestation.cluster)
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
  const sourceDeployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));
  const avalancheDeployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'avalanche-deployment.json'));
  const totalStartedAt = nowMs();

  const sourceResult = await submitSourceRequest({ sourceDeployment, avalancheDeployment });
  console.log(`EVM->AVAX SOURCE tx=${sourceResult.sourceTxHash} gas=${sourceResult.sourceGasUsed}`);

  const proofStartedAt = nowMs();
  const originProof = await buildOriginHXMsg({ sourceDeployment, avalancheDeployment, sourceResult });
  const proofBuildMs = nowMs() - proofStartedAt;

  const originTEE = await attestOrigin(originProof.hxmsg, originProof.receiptProof, originProof.committeeHeaderUpdate);
  console.log(`EVM->AVAX TEE quorum=${originTEE.cluster.reached}/${originTEE.cluster.threshold}`);

  const target = await executeOnAvalanche(originProof.hxmsg, originTEE.cluster, avalancheDeployment);
  console.log(`EVM->AVAX TARGET tx=${target.txHash} gas=${target.gasUsed}`);

  const responseTEE = await attestResponse({ originHxmsg: originProof.hxmsg, avalancheExecution: target });
  console.log(`AVAX->EVM RESPONSE TEE quorum=${responseTEE.cluster.reached}/${responseTEE.cluster.threshold}`);

  const completion = await completeResponseOnEthereum({ sourceDeployment, sourceResult, responseAttestation: responseTEE });
  console.log(`AVAX->EVM COMPLETE tx=${completion.txHash} gas=${completion.gasUsed}`);

  const result = {
    testType: 'local-ethereum-avalanche-response-required-gas',
    testedAt: new Date().toISOString(),
    pass: true,
    requestID: originProof.hxmsg.header.requestID,
    hmsgDigest: originProof.hxmsg.hmsgDigest,
    expectedPayload: normalizeBusinessPayload(sourceResult.payload),
    source: {
      chain: 'local-ethereum',
      txHash: sourceResult.sourceTxHash,
      gasUsed: sourceResult.sourceGasUsed,
    },
    target: {
      chain: 'local-avalanche-c-chain',
      txHash: target.txHash,
      gasUsed: target.gasUsed,
      registrationGasUsed: target.registrationGasUsed,
    },
    response: {
      chain: 'local-ethereum',
      responseDigest: responseTEE.responseDigest,
      txHash: completion.txHash,
      gasUsed: completion.gasUsed,
      registrationGasUsed: completion.registrationGasUsed,
    },
    gas: {
      sourceSubmit: sourceResult.sourceGasUsed,
      targetExecute: target.gasUsed,
      targetRegisterTEE: target.registrationGasUsed,
      responseComplete: completion.gasUsed,
      responseRegisterTEE: completion.registrationGasUsed,
      totalWithoutRegistration: sourceResult.sourceGasUsed + target.gasUsed + completion.gasUsed,
      totalWithRegistration: sourceResult.sourceGasUsed + target.gasUsed + target.registrationGasUsed + completion.gasUsed + completion.registrationGasUsed,
    },
    tee: {
      origin: originTEE.verificationResult,
      response: responseTEE.verificationResult,
    },
    timings: {
      sourceMs: sourceResult.elapsedMs,
      proofBuildMs,
      originTeeMs: originTEE.elapsedMs,
      targetMs: target.elapsedMs,
      responseTeeMs: responseTEE.elapsedMs,
      completionMs: completion.elapsedMs,
      totalMs: nowMs() - totalStartedAt,
    },
  };
  writeJSON(RESULT_FILE, result);
  console.log(`Results: ${path.join(RUNTIME_DIR, RESULT_FILE)}`);
}

main().catch((error) => {
  const failure = {
    testType: 'local-ethereum-avalanche-response-required-gas',
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
