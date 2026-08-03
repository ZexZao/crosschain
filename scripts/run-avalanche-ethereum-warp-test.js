const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { performance } = require('perf_hooks');
const { ethers } = require('ethers');
const { Gateway, Wallets } = require('fabric-network');
const { loadDotEnv } = require('../shared/env');
const { composeHXMsg } = require('../hxmsg-builder/compose');
const { buildEvmContractCallTarget } = require('../hxmsg-builder/target-builders/evm');
const { buildFabricChaincodeTarget, FABRIC_INVOKE_SELECTOR } = require('../hxmsg-builder/target-builders/fabric');
const { encodeCompactBusinessCall, compactBusinessCallTuple } = require('../shared/xmsg');
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
const { registerEVMTEEs, registerFabricTEEs, clusterCertificateTuple } = require('../shared/tee/registration');
const { writeJSON } = require('../shared/utils');

loadDotEnv();

const PROJECT_ROOT = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, 'runtime');
const RESULT_FILE = process.env.AVALANCHE_ETHEREUM_RESULT_FILE || 'avalanche-ethereum-warp-test-result.json';
const TEST_TYPE = process.env.AVALANCHE_ETHEREUM_TEST_TYPE || 'avalanche-to-ethereum-real-warp';
const TARGET_LABEL = process.env.AVALANCHE_TARGET_LABEL || 'ETH';
const TARGET_DEPLOYMENT_FILE = process.env.TARGET_EVM_DEPLOYMENT_FILE || path.join(RUNTIME_DIR, 'deployment.json');
const TARGET_KIND = String(process.env.AVALANCHE_TARGET_KIND || 'evm').toLowerCase();
const DEFAULT_AVALANCHE_KEY = '0x56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027';
const AVALANCHE_RPC = process.env.AVALANCHE_RPC_URL || 'http://127.0.0.1:9650/ext/bc/C/rpc';
const AVALANCHE_PCHAIN_RPC = process.env.AVALANCHE_PCHAIN_RPC_URL || 'http://127.0.0.1:9650/ext/P';
const AVALANCHE_NODE_ENDPOINTS = (process.env.AVALANCHE_NODE_ENDPOINTS || 'http://127.0.0.1:9650,http://127.0.0.1:9656,http://127.0.0.1:9652,http://127.0.0.1:9654,http://127.0.0.1:9658')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const TEE_URLS = teeURLsFromEnv({ sourceChainType: ChainType.AVALANCHE });
const EVM_RPC = process.env.TARGET_EVM_RPC || process.env.EVM_RPC || 'http://127.0.0.1:8545';
const EVM_KEY = process.env.TARGET_EVM_PRIVATE_KEY || process.env.LOCAL_EVM_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CLUSTER_CERT_ABI = '(bytes32,uint64,uint16,uint16,uint256,bytes32,bytes,bytes32,uint64,uint64)';
const TEE_REGISTRATION_ABI = '(address teeAddress,uint16 signerIndex,bytes32 enclavePubKeyHash,bytes32 measurement,bytes32 quoteHash,bytes32 initialSyncStateHash,uint64 epoch,uint64 notAfter,bytes attestationSignature)';
const MINIMAL_TUPLE = '(bytes32,bytes32,uint8,bytes32,uint8,bytes32,bytes4,bytes32,bytes32,bytes32,bool,uint8,uint64,bytes32,uint64)';
const COMPACT_TUPLE = '(uint16,bytes32,bytes32,address,int256,bytes32,bool)';

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

async function submitAvalancheWarpSource({ avalancheDeployment, targetDeployment, validatorSetRef }) {
  const provider = new ethers.JsonRpcProvider(AVALANCHE_RPC);
  const wallet = new ethers.Wallet(process.env.AVALANCHE_PRIVATE_KEY || DEFAULT_AVALANCHE_KEY, provider);
  const sourceArtifact = artifact('AvalancheWarpSourceContract.sol', 'AvalancheWarpSourceContract');
  const source = new ethers.Contract(avalancheDeployment.avalancheWarpSourceContract, sourceArtifact.abi, wallet);

  const payload = {
    op: 'token_transfer',
    assetId: `AVAX_WARP_${Date.now()}`,
    transferId: `AVAX_WARP_TRANSFER_${Date.now()}`,
    assetType: 'XCST',
    from: 'avalanche.source.account',
    to: TARGET_KIND === 'fabric' ? 'fabric.receiver.account' : undefined,
    amount: '17',
    recipient: `${TARGET_KIND}.receiver`,
    targetRecipient: TARGET_KIND === 'evm' ? targetDeployment.deployer : undefined,
    metadata: `real Avalanche Warp to ${TARGET_LABEL} business action`,
    requireAck: false,
  };
  const encoded = encodeCompactBusinessCall(payload);
  const normalized = encoded.normalized;
  const compact = encoded.compact;
  const callData = encoded.payloadHex;
  const businessPayloadHash = hashJson(normalized);
  const fabricChannel = process.env.FABRIC_CHANNEL || 'mychannel';
  const fabricChaincode = process.env.FABRIC_CHAINCODE || 'xcall';
  const targetChainID = TARGET_KIND === 'fabric'
    ? bytes32FromText(`fabric-${fabricChannel}`)
    : chainIdToBytes32(targetDeployment.chainId);
  const targetDomainID = TARGET_KIND === 'fabric'
    ? bytes32FromText('fabric-local-domain')
    : bytes32FromText(`evm-local-${targetDeployment.chainId}`);
  const targetObject = TARGET_KIND === 'fabric'
    ? bytes32FromText(fabricChaincode)
    : ethers.zeroPadValue(targetDeployment.targetContract, 32);
  const functionSelector = TARGET_KIND === 'fabric'
    ? FABRIC_INVOKE_SELECTOR
    : ethers.id('executeCompact(bytes32,(uint16,bytes32,bytes32,address,int256,bytes32,bool))').slice(0, 10);
  const receiver = targetObject;
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
    compact,
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

function buildHXMsg({ sourceResult, avalancheDeployment, targetDeployment, validators, validatorSetRef, signatures }) {
  const parsed = parseUnsignedWarpMessage(sourceResult.unsignedWarpMessage);
  const warpPayload = decodeHXMsgWarpPayload(parsed.payload);
  const targetPart = TARGET_KIND === 'fabric'
    ? buildFabricChaincodeTarget({
      channelID: process.env.FABRIC_CHANNEL || 'mychannel',
      chaincodeName: process.env.FABRIC_CHAINCODE || 'xcall',
      requestID: sourceResult.requestID,
      functionSelector: warpPayload.functionSelector,
      callDataHash: warpPayload.callDataHash,
      receiver: warpPayload.receiver,
    })
    : buildEvmContractCallTarget({
      chainId: targetDeployment.chainId,
      requestID: sourceResult.requestID,
      targetAddress: targetDeployment.targetContract,
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

async function attest(hxmsgs, teeUrl) {
  const startedAt = nowMs();
  const resp = await axios.post(`${teeUrl}/attest-batch`, {
    hxmsgs,
    helperDataList: hxmsgs.map((hxmsg) => hxmsg._blockData),
  }, { timeout: 120000 });
  const cluster = resp.data.teeBatchCertification;
  if (!cluster?.quorumReached) {
    throw new Error(`TEE quorum not reached: ${cluster?.reached || 0}/${cluster?.threshold || '?'}`);
  }
  return {
    elapsedMs: nowMs() - startedAt,
    cluster,
    verificationResults: resp.data.verificationResults || [],
    batch: buildHXMsgBatch(hxmsgs),
  };
}

async function executeOnEthereum(hxmsgs, tee, ethereumDeployment) {
  const startedAt = nowMs();
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet = new ethers.Wallet(EVM_KEY, provider);
  const deployer = new ethers.NonceManager(wallet);
  const registry = new ethers.Contract(
    ethereumDeployment.teeRegistry,
    ['function isActiveTEE(address) view returns (bool)', `function registerTEE(${TEE_REGISTRATION_ABI}) external`],
    deployer
  );
  const registration = await registerEVMTEEs({ registry, certificate: tee.cluster, teeURLs: TEE_URLS });
  const calls = hxmsgs.map((hxmsg) => getExecutionData(hxmsg).compactCall);
  const target = new ethers.Contract(
    ethereumDeployment.targetContract,
    ['function assetService() view returns (address)'],
    provider
  );
  const assetService = await target.assetService();
  const token = new ethers.Contract(
    ethereumDeployment.settlementToken,
    ['function balanceOf(address) view returns (uint256)'],
    provider
  );
  const expectedByRecipient = new Map();
  for (const call of calls) {
    const recipient = ethers.getAddress(call.actorAddress);
    expectedByRecipient.set(recipient, (expectedByRecipient.get(recipient) || 0n) + BigInt(call.amount));
  }
  const reserveBefore = await token.balanceOf(assetService);
  const recipientBefore = new Map();
  for (const recipient of expectedByRecipient.keys()) {
    recipientBefore.set(recipient, await token.balanceOf(recipient));
  }
  const gateway = new ethers.Contract(
    ethereumDeployment.hxmsgGateway,
    [`function executeHXMsgMinimalCompactBatchCluster(${MINIMAL_TUPLE}[],address,${COMPACT_TUPLE}[],bytes32,bytes32,bytes32[][],${CLUSTER_CERT_ABI}) external`],
    deployer
  );
  const tx = await gateway.executeHXMsgMinimalCompactBatchCluster(
    hxmsgs.map(toMinimalHXMsg),
    ethereumDeployment.targetContract,
    calls.map(compactBusinessCallTuple),
    tee.batch.batchID,
    tee.batch.batchRoot,
    tee.batch.proofs,
    clusterCertificateTuple(tee.cluster)
  );
  const receipt = await tx.wait();
  const reserveAfter = await token.balanceOf(assetService);
  const recipientChanges = [];
  let recipientsVerified = true;
  for (const [recipient, expectedDelta] of expectedByRecipient.entries()) {
    const after = await token.balanceOf(recipient);
    const before = recipientBefore.get(recipient);
    const actualDelta = after - before;
    if (actualDelta !== expectedDelta) recipientsVerified = false;
    recipientChanges.push({
      recipient,
      before: before.toString(),
      after: after.toString(),
      expectedDelta: expectedDelta.toString(),
      actualDelta: actualDelta.toString(),
    });
  }
  const expectedReserveDelta = calls
    .filter((call) => Number(call.opCode) === 9)
    .reduce((sum, call) => sum + BigInt(call.amount), 0n);
  const actualReserveDelta = reserveBefore - reserveAfter;
  return {
    elapsedMs: nowMs() - startedAt,
    txHash: receipt.hash,
    gasUsed: Number(receipt.gasUsed),
    registrationGasUsed: Number(registration.gasUsed || 0n),
    assetActionVerified: recipientsVerified && actualReserveDelta === expectedReserveDelta,
    assetBalances: {
      reserve: {
        address: assetService,
        before: reserveBefore.toString(),
        after: reserveAfter.toString(),
        expectedDelta: expectedReserveDelta.toString(),
        actualDelta: actualReserveDelta.toString(),
      },
      recipients: recipientChanges,
    },
  };
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
    expectedFeedbackMsgType: Number(minimal[11]),
    feedbackTimeout: Number(minimal[12]),
    callbackRefHash: minimal[13],
    expireAt: Number(minimal[14]),
    sourceChainType: ChainType.AVALANCHE,
  };
}

async function getFabricContract() {
  const profile = process.env.FABRIC_CONNECTION_PROFILE || path.join(PROJECT_ROOT, 'fabric-network', 'connection-org1.json');
  const walletPath = process.env.FABRIC_WALLET_PATH || path.join(PROJECT_ROOT, 'fabric-network', 'wallet');
  const wallet = await Wallets.newFileSystemWallet(walletPath);
  const gateway = new Gateway();
  await gateway.connect(fs.readJsonSync(profile), {
    wallet,
    identity: process.env.FABRIC_IDENTITY || 'appUser',
    discovery: { enabled: true, asLocalhost: process.env.FABRIC_AS_LOCALHOST !== 'false' },
  });
  const network = await gateway.getNetwork(process.env.FABRIC_CHANNEL || 'mychannel');
  return { gateway, contract: network.getContract(process.env.FABRIC_CHAINCODE || 'xcall') };
}

async function executeOnFabric(hxmsg, tee, messageIndex) {
  const startedAt = nowMs();
  const { gateway, contract } = await getFabricContract();
  try {
    if (messageIndex === 0) {
      await registerFabricTEEs({ contract, certificate: tee.cluster, teeURLs: TEE_URLS });
    }
    const execution = getExecutionData(hxmsg);
    const businessPayload = execution.businessPayload;
    if (messageIndex === 0 && businessPayload?.op === 'token_transfer') {
      const raw = JSON.parse(businessPayload.metadata || '{}');
      await contract.submitTransaction('InitAssetBalance', raw.from, raw.assetType || 'XCST', '1000');
    }
    const certEnvelope = {
      ...tee.cluster,
      batchID: tee.batch.batchID,
      batchRoot: tee.batch.batchRoot,
      batchSize: tee.batch.batchSize,
      batchSigningDigest: tee.batch.batchSigningDigest,
      merkleProof: tee.batch.proofs[messageIndex],
    };
    const response = await contract.submitTransaction(
      'ExecuteHXMsgCompact',
      JSON.stringify(compactDeliveryObject(hxmsg)),
      JSON.stringify(execution.compactCall),
      JSON.stringify(businessPayload),
      JSON.stringify(certEnvelope)
    );
    return {
      elapsedMs: nowMs() - startedAt,
      txHash: JSON.parse(response.toString()).requestID,
      gasUsed: null,
      registrationGasUsed: 0,
    };
  } finally {
    gateway.disconnect();
  }
}

async function main() {
  fs.ensureDirSync(RUNTIME_DIR);
  const avalancheDeployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'avalanche-deployment.json'));
  const targetDeployment = TARGET_KIND === 'fabric' ? {} : fs.readJsonSync(TARGET_DEPLOYMENT_FILE);
  const teeUrl = await resolveTeeLeader();
  const totalStartedAt = nowMs();

  const validatorStartedAt = nowMs();
  const { validators, ref: validatorSetRef } = await getValidatorSetRef();
  const validatorMs = nowMs() - validatorStartedAt;

  const caseTotal = Number(process.env.AVALANCHE_CASE_TOTAL || (TARGET_KIND === 'fabric' ? 8 : 1));
  const items = [];
  let proofMs = 0;
  for (let i = 0; i < caseTotal; i += 1) {
    const sourceResult = await submitAvalancheWarpSource({ avalancheDeployment, targetDeployment, validatorSetRef });
    console.log(`AVAX->${TARGET_LABEL} SOURCE ${i + 1}/${caseTotal} tx=${sourceResult.sourceTxHash} block=${sourceResult.sourceBlockNumber} gas=${sourceResult.sourceGasUsed}`);
    const proofStartedAt = nowMs();
    const signatures = await collectValidatorSignatures(sourceResult.warpMessageID);
    proofMs += nowMs() - proofStartedAt;
    const hxmsg = buildHXMsg({ sourceResult, avalancheDeployment, targetDeployment, validators, validatorSetRef, signatures });
    items.push({ sourceResult, signatures, hxmsg });
  }

  const tee = await attest(items.map((item) => item.hxmsg), teeUrl);
  console.log(`AVAX->${TARGET_LABEL} TEE batch quorum=${tee.cluster.reached}/${tee.cluster.threshold} size=${items.length}`);

  let targets;
  if (TARGET_KIND === 'fabric') {
    targets = [];
    for (let i = 0; i < items.length; i += 1) {
      targets.push(await executeOnFabric(items[i].hxmsg, tee, i));
    }
  } else {
    const target = await executeOnEthereum(items.map((item) => item.hxmsg), tee, targetDeployment);
    targets = items.map(() => target);
  }
  const perMessageTargetGas = targets[0].gasUsed === null ? null : Math.ceil(targets[0].gasUsed / items.length);
  const results = items.map((item, index) => ({
    requestID: item.hxmsg.header.requestID,
    hmsgDigest: item.hxmsg.hmsgDigest,
    sourceTxHash: item.sourceResult.sourceTxHash,
    sourceBlockNumber: item.sourceResult.sourceBlockNumber,
    sourceGasUsed: item.sourceResult.sourceGasUsed,
    warpMessageID: item.sourceResult.warpMessageID,
    validatorSignatures: item.signatures.length,
    teeVerification: tee.verificationResults[index],
    targetTxHash: targets[index].txHash,
    targetGasUsed: perMessageTargetGas,
  }));
  const sourceGasTotal = results.reduce((sum, item) => sum + item.sourceGasUsed, 0);
  const result = {
    testType: TEST_TYPE,
    testedAt: new Date().toISOString(),
    pass: TARGET_KIND === 'fabric' || Boolean(targets[0].assetActionVerified),
    batchSize: items.length,
    batchID: tee.batch.batchID,
    teeCluster: tee.cluster,
    sourceGasTotal,
    sourceGasAverage: Math.ceil(sourceGasTotal / items.length),
    targetBatchGasUsed: targets[0].gasUsed,
    targetGasAverage: perMessageTargetGas,
    registrationGasUsed: targets[0].registrationGasUsed,
    assetActionVerified: targets[0].assetActionVerified ?? null,
    assetBalances: targets[0].assetBalances ?? null,
    results,
    timings: {
      validatorMs,
      sourceMs: items.reduce((sum, item) => sum + item.sourceResult.elapsedMs, 0),
      proofMs,
      teeMs: tee.elapsedMs,
      targetMs: targets.reduce((sum, item) => sum + item.elapsedMs, 0),
      totalMs: nowMs() - totalStartedAt,
    },
  };
  writeJSON(RESULT_FILE, result);
  console.log(`Results: ${path.join(RUNTIME_DIR, RESULT_FILE)}`);
  process.exit(0);
}

main().catch((error) => {
  const failure = {
    testType: TEST_TYPE,
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
