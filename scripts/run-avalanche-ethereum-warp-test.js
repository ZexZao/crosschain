const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { performance } = require('perf_hooks');
const { ethers } = require('ethers');
const { composeHXMsg } = require('../hxmsg-builder/compose');
const { buildEvmContractCallTarget } = require('../hxmsg-builder/target-builders/evm');
const { encodeBusinessPayload } = require('../shared/xmsg');
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

const PROJECT_ROOT = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, 'runtime');
const RESULT_FILE = 'avalanche-ethereum-warp-test-result.json';
const DEFAULT_AVALANCHE_KEY = '0x56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027';
const AVALANCHE_RPC = process.env.AVALANCHE_RPC_URL || 'http://127.0.0.1:9650/ext/bc/C/rpc';
const AVALANCHE_PCHAIN_RPC = process.env.AVALANCHE_PCHAIN_RPC_URL || 'http://127.0.0.1:9650/ext/P';
const AVALANCHE_NODE_ENDPOINTS = (process.env.AVALANCHE_NODE_ENDPOINTS || 'http://127.0.0.1:9650,http://127.0.0.1:9656,http://127.0.0.1:9652,http://127.0.0.1:9654,http://127.0.0.1:9658')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const TEE_URLS = teeURLsFromEnv({ sourceChainType: ChainType.AVALANCHE });
const EVM_RPC = process.env.EVM_RPC || 'http://127.0.0.1:8545';
const EVM_KEY = process.env.DEPLOYER_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CLUSTER_CERT_ABI = '(bytes32,uint64,uint16,uint16,uint256,bytes32,bytes,bytes32,uint64,uint64)';
const TEE_REGISTRATION_ABI = '(address teeAddress,uint16 signerIndex,bytes32 enclavePubKeyHash,bytes32 measurement,bytes32 quoteHash,bytes32 initialSyncStateHash,uint64 epoch,uint64 notAfter,bytes attestationSignature)';

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
  throw new Error(`no reachable Avalanche TEE node: ${statuses.map((s) => `${s.url}:${s.error}`).join('; ')}`);
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

async function submitAvalancheWarpSource({ avalancheDeployment, ethereumDeployment, validatorSetRef }) {
  const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC);
  const wallet = new ethers.Wallet(process.env.AVALANCHE_PRIVATE_KEY || DEFAULT_AVALANCHE_KEY, provider);
  const sourceArtifact = artifact('AvalancheWarpSourceContract.sol', 'AvalancheWarpSourceContract');
  const source = new ethers.Contract(avalancheDeployment.avalancheWarpSourceContract, sourceArtifact.abi, wallet);

  const payload = {
    op: 'token_transfer',
    assetId: `AVAX_WARP_${Date.now()}`,
    amount: '17',
    recipient: 'ethereum.receiver',
    targetRecipient: ethereumDeployment.deployer,
    metadata: 'real Avalanche Warp to Ethereum business action',
    requireAck: false,
  };
  const encoded = encodeBusinessPayload(payload);
  const normalized = encoded.normalized;
  const callData = encoded.payloadHex;
  const businessPayloadHash = hashJson(normalized);
  const targetChainID = chainIdToBytes32(ethereumDeployment.chainId);
  const targetDomainID = bytes32FromText(`evm-local-${ethereumDeployment.chainId}`);
  const targetObject = ethers.zeroPadValue(ethereumDeployment.targetContract, 32);
  const functionSelector = ethers.id('execute(bytes32,bytes)').slice(0, 10);
  const receiver = ethers.zeroPadValue(ethereumDeployment.targetContract, 32);
  const expireAt = Math.floor(Date.now() / 1000) + 3600;
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
    callData,
    businessPayloadHash,
    targetChainID,
    targetDomainID,
    targetObject,
    functionSelector,
    receiver,
    expireAt,
    policyHash,
    requestID: event.args.requestID,
    warpMessageID,
    unsignedWarpMessage,
    sourceGasUsed: Number(receipt.gasUsed),
    sourceTxHash: receipt.hash,
    sourceBlockNumber: receipt.blockNumber,
    elapsedMs: nowMs() - startedAt,
  };
}

function buildHXMsg({ sourceResult, avalancheDeployment, ethereumDeployment, validators, validatorSetRef, signatures }) {
  const parsed = parseUnsignedWarpMessage(sourceResult.unsignedWarpMessage);
  const warpPayload = decodeHXMsgWarpPayload(parsed.payload);
  const targetPart = buildEvmContractCallTarget({
    chainId: ethereumDeployment.chainId,
    requestID: sourceResult.requestID,
    targetAddress: ethereumDeployment.targetContract,
    functionSelector: warpPayload.functionSelector,
    callDataHash: warpPayload.callDataHash,
    receiver: warpPayload.receiver,
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
    compactCall: null,
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

async function attest(hxmsg, teeUrl) {
  const startedAt = nowMs();
  const resp = await axios.post(`${teeUrl}/attest`, { hxmsg, helperData: hxmsg._blockData }, { timeout: 60000 });
  const cluster = resp.data.teeClusterCertification;
  if (!cluster?.quorumReached) {
    throw new Error(`TEE quorum not reached: ${cluster?.reached || 0}/${cluster?.threshold || '?'}`);
  }
  return { elapsedMs: nowMs() - startedAt, cluster, verificationResult: resp.data.verificationResult };
}

async function executeOnEthereum(hxmsg, cluster, ethereumDeployment) {
  const startedAt = nowMs();
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet = new ethers.Wallet(EVM_KEY, provider);
  const deployer = new ethers.NonceManager(wallet);
  const registry = new ethers.Contract(
    ethereumDeployment.teeRegistry,
    ['function isActiveTEE(address) view returns (bool)', `function registerTEE(${TEE_REGISTRATION_ABI}) external`],
    deployer
  );
  const registration = await registerEVMTEEs({ registry, certificate: cluster, teeURLs: TEE_URLS });
  const gateway = new ethers.Contract(
    ethereumDeployment.hxmsgGateway,
    [`function executeHXMsgMinimalCluster((bytes32,bytes32,uint8,bytes32,uint8,bytes32,bytes4,bytes32,bytes32,bytes32,bool,uint8,uint64,bytes32,uint64),address,bytes,${CLUSTER_CERT_ABI}) external`],
    deployer
  );
  const tx = await gateway.executeHXMsgMinimalCluster(
    toMinimalHXMsg(hxmsg),
    ethereumDeployment.targetContract,
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
  const avalancheDeployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'avalanche-deployment.json'));
  const ethereumDeployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));
  const teeUrl = await resolveTeeLeader();
  const totalStartedAt = nowMs();

  const validatorStartedAt = nowMs();
  const { validators, ref: validatorSetRef } = await getValidatorSetRef();
  const validatorMs = nowMs() - validatorStartedAt;

  const sourceResult = await submitAvalancheWarpSource({ avalancheDeployment, ethereumDeployment, validatorSetRef });
  console.log(`AVAX->ETH SOURCE tx=${sourceResult.sourceTxHash} block=${sourceResult.sourceBlockNumber} gas=${sourceResult.sourceGasUsed}`);

  const proofStartedAt = nowMs();
  const signatures = await collectValidatorSignatures(sourceResult.warpMessageID);
  const proofMs = nowMs() - proofStartedAt;
  console.log(`AVAX->ETH PROOF signatures=${signatures.length} proofMs=${proofMs}`);

  const hxmsg = buildHXMsg({ sourceResult, avalancheDeployment, ethereumDeployment, validators, validatorSetRef, signatures });
  const tee = await attest(hxmsg, teeUrl);
  console.log(`AVAX->ETH TEE quorum=${tee.cluster.reached}/${tee.cluster.threshold} signedWeight=${tee.verificationResult.signedWeight}/${tee.verificationResult.totalWeight}`);

  const target = await executeOnEthereum(hxmsg, tee.cluster, ethereumDeployment);
  console.log(`AVAX->ETH PASS targetTx=${target.txHash} gas=${target.gasUsed}`);

  const result = {
    testType: 'avalanche-to-ethereum-real-warp',
    testedAt: new Date().toISOString(),
    pass: true,
    requestID: hxmsg.header.requestID,
    hmsgDigest: hxmsg.hmsgDigest,
    sourceTxHash: sourceResult.sourceTxHash,
    sourceBlockNumber: sourceResult.sourceBlockNumber,
    sourceGasUsed: sourceResult.sourceGasUsed,
    warpMessageID: sourceResult.warpMessageID,
    validatorSignatures: signatures.length,
    teeCluster: tee.cluster,
    teeVerification: tee.verificationResult,
    targetTxHash: target.txHash,
    targetGasUsed: target.gasUsed,
    registrationGasUsed: target.registrationGasUsed,
    timings: {
      validatorMs,
      sourceMs: sourceResult.elapsedMs,
      proofMs,
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
    testType: 'avalanche-to-ethereum-real-warp',
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
