const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { Gateway, Wallets } = require('fabric-network');
const { common } = require('fabric-protos');
const { encodeCompactBusinessCall } = require('../shared/xmsg');
const {
  ChainType,
  addressToBytes32,
  chainIdToBytes32,
  hashJson,
  toMinimalHXMsg,
  buildDeliveryMessage,
  getExecutionData,
} = require('../shared/hxmsg');
const { buildReceiptProof } = require('../shared/evm/receipt-proof');
const { buildCommitteeHeaderUpdate } = require('../shared/evm/header-committee');
const { buildHXMsgFromFabricEvent, TARGET_EXECUTE_SELECTOR } = require('../hxmsg-builder/fabric-to-evm');
const { buildEvmExecutionProofRef, buildExecutedResponse } = require('../hxmsg-builder/response');
const { registerEVMTEEs, registerFabricTEEs, clusterCertificateTuple } = require('../shared/tee/registration');
const { teeURLsFromEnv } = require('../shared/tee/subnet-routing');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const TEE_URLS = teeURLsFromEnv({ sourceChainType: ChainType.FABRIC });
const EVM_RPC = process.env.EVM_RPC || 'http://127.0.0.1:8545';
const PRIV_KEY = process.env.DEPLOYER_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CLUSTER_CERT_ABI = '(bytes32,uint64,uint16,uint16,uint256,bytes32,bytes,bytes32,uint64,uint64)';
const TEE_REGISTRATION_ABI = '(address teeAddress,uint16 signerIndex,bytes32 enclavePubKeyHash,bytes32 measurement,bytes32 quoteHash,bytes32 initialSyncStateHash,uint64 epoch,uint64 notAfter,bytes attestationSignature)';

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

async function timed(stageTimings, name, fn) {
  const startedMs = nowMs();
  try {
    return await fn();
  } finally {
    stageTimings[name] = (stageTimings[name] || 0) + (nowMs() - startedMs);
  }
}

function gasOf(receipt) {
  return Number(receipt?.gasUsed || 0n);
}

async function getFabric(projectRoot) {
  const profile = process.env.FABRIC_CONNECTION_PROFILE || path.join(projectRoot, 'fabric-network', 'connection-org1.json');
  const walletPath = process.env.FABRIC_WALLET_PATH || path.join(projectRoot, 'fabric-network', 'wallet');
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
  return {
    gateway,
    network,
    contract: network.getContract(chaincode),
    channel,
    chaincode,
  };
}

async function fabricBlockNumberByTx(network, channelID, txId) {
  const qscc = network.getContract('qscc');
  const blockBytes = await qscc.evaluateTransaction('GetBlockByTxID', channelID, txId);
  const block = common.Block.decode(Buffer.from(blockBytes));
  return Number(block.header.number);
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

async function relayToEvm(hxmsg, deployment, teeUrl, stageTimings) {
  const teeResp = await timed(stageTimings, 'teeAttestHXMsgMs', () =>
    axios.post(`${teeUrl}/attest`, { hxmsg }, { timeout: 30000 }));
  const cluster = teeResp.data.teeClusterCertification;
  if (!cluster?.quorumReached) throw new Error('TEE quorum not reached for CONTRACT_CALL');
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const signer = new ethers.NonceManager(new ethers.Wallet(PRIV_KEY, provider));
  const gas = {
    registerTEE: 0,
    executeHXMsgMinimalCluster: 0,
    total: 0,
  };
  const registry = new ethers.Contract(
    deployment.teeRegistry,
    [
      'function isActiveTEE(address) view returns (bool)',
      `function registerTEE(${TEE_REGISTRATION_ABI}) external`,
    ],
    signer
  );
  const registration = await timed(stageTimings, 'evmRegisterTEEMs', () =>
    registerEVMTEEs({ registry, certificate: cluster, teeURLs: TEE_URLS }));
  gas.registerTEE += Number(registration.gasUsed || 0n);
  const gateway = new ethers.Contract(
    deployment.hxmsgGateway,
    [`function executeHXMsgMinimalCompactCluster((bytes32,bytes32,uint8,bytes32,uint8,bytes32,bytes4,bytes32,bytes32,bytes32,bool,uint8,uint64,bytes32,uint64,bytes32,uint64),address,(uint16 opCode,bytes32 recordIdHash,bytes32 actorHash,address actorAddress,int256 amount,bytes32 metadataHash,bool requireAck),${CLUSTER_CERT_ABI}) external`],
    signer
  );
  const receipt = await timed(stageTimings, 'evmTargetExecutionMs', async () => {
    const tx = await gateway.executeHXMsgMinimalCompactCluster(
      toMinimalHXMsg(hxmsg),
      deployment.targetContract,
      getExecutionData(hxmsg).compactCall,
      clusterCertificateTuple(cluster)
    );
    return tx.wait();
  });
  gas.executeHXMsgMinimalCompactCluster = gasOf(receipt);
  gas.total = gas.registerTEE + gas.executeHXMsgMinimalCompactCluster;
  return { receipt, teeCluster: cluster, teeVerification: teeResp.data.verificationResult, gas };
}

async function main() {
  const startedMs = nowMs();
  const stageTimings = {};
  fs.ensureDirSync(RUNTIME_DIR);
  const projectRoot = path.join(__dirname, '..');
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const { gateway, network, contract, channel, chaincode } = await getFabric(projectRoot);
  const result = {
    testType: 'fabric-evm-response-e2e',
    pass: false,
    timing: { stageMs: stageTimings },
    gas: { evm: {}, fabric: { notApplicable: true, reason: 'Hyperledger Fabric transactions do not use EVM gas.' } },
  };
  try {
    const teeUrl = await timed(stageTimings, 'resolveTeeLeaderMs', resolveTeeLeader);
    const targetObject = addressToBytes32(deployment.targetContract);
    const targetChainID = chainIdToBytes32(deployment.chainId);
    const businessPayload = {
      op: 'asset_lock',
      recordId: `FABRIC-EVM-ASSET-CR-001-${Date.now()}`,
      actor: deployment.deployer,
      amount: '1.0000',
      metadata: 'challenge-response e2e asset settlement',
      requireAck: true,
    };
    const { normalized, compactCallHash } = encodeCompactBusinessCall(businessPayload);
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      businessPayload,
      targetChainType: 'EVM',
      targetChainID,
      targetObject,
      functionSelector: TARGET_EXECUTE_SELECTOR,
      callDataHash: compactCallHash,
      businessPayloadHash: hashJson(normalized),
      receiver: targetObject,
      expireAt: now + 3600,
      feedback: { required: true, expectedMsgType: 2, timeout: now + 3600, callbackRefHash: ethers.ZeroHash },
      atomicity: null,
    };
    const tx = contract.createTransaction('EmitXCall');
    const txId = tx.getTransactionId();
    const emitResp = JSON.parse((await timed(stageTimings, 'fabricEmitXCallMs', () =>
      tx.submit(JSON.stringify(payload)))).toString());
    const blockNumber = await timed(stageTimings, 'fabricQueryBlockMs', () =>
      fabricBlockNumberByTx(network, channel, txId));
    const eventRecord = JSON.parse((await timed(stageTimings, 'fabricQueryCrosschainEventMs', () =>
      contract.evaluateTransaction('QueryCrosschainEvent', emitResp.requestID))).toString());
    const hxmsg = buildHXMsgFromFabricEvent({
      deployment,
      channelName: channel,
      chaincodeId: chaincode,
      rawPayload: { ...eventRecord, feedback: payload.feedback, atomicity: payload.atomicity },
      txId,
      blockNumber,
      nonce: emitResp.nonce,
      createdAt: eventRecord.createdAt,
    });
    const relay = await relayToEvm(hxmsg, deployment, teeUrl, stageTimings);
    await timed(stageTimings, 'fabricRegisterTEEMs', () =>
      registerFabricTEEs({ contract, certificate: relay.teeCluster, teeURLs: TEE_URLS }));
    await timed(stageTimings, 'fabricBindResponseLifecycleHXMsgMs', () =>
      contract.submitTransaction('BindResponseLifecycleHXMsg', JSON.stringify(hxmsg), JSON.stringify(relay.teeCluster)));
    const evmReceipt = await timed(stageTimings, 'evmGetTargetReceiptMs', () =>
      provider.getTransactionReceipt(relay.receipt.hash));
    const evmProof = await timed(stageTimings, 'buildEvmReceiptProofMs', () =>
      buildReceiptProof({ provider, blockNumber: evmReceipt.blockNumber, txHash: evmReceipt.hash }));
    const evmCommitteeHeaderUpdate = buildCommitteeHeaderUpdate({
      header: evmProof.blockHeader,
      chainID: `eip155:${deployment.chainId}`,
    });
    const response = buildExecutedResponse({
      originRequestID: hxmsg.header.requestID,
      originHmsgDigest: hxmsg.hmsgDigest,
      targetExecutionHash: (hxmsg.deliveryMessage || buildDeliveryMessage(hxmsg)).targetExecutionHash,
      targetProofRefHash: buildEvmExecutionProofRef(evmReceipt),
      responsePayload: { txHash: evmReceipt.hash, status: 'executed' },
    });
    const responseAttest = await timed(stageTimings, 'teeAttestResponseMs', () => axios.post(`${teeUrl}/attest-response`, {
      response,
      helperData: {
        originHxmsg: hxmsg,
        evmExecutionReceipt: evmProof,
        committeeHeaderUpdate: evmCommitteeHeaderUpdate,
        evmChainID: `eip155:${deployment.chainId}`,
      },
    }, { timeout: 30000 }));
    const voucher = responseAttest.data.teeClusterCertification;
    await timed(stageTimings, 'fabricRegisterResponseTEEMs', () =>
      registerFabricTEEs({ contract, certificate: voucher, teeURLs: TEE_URLS }));
    await timed(stageTimings, 'fabricCompleteWithResponseMs', () =>
      contract.submitTransaction('CompleteWithResponse', hxmsg.header.requestID, JSON.stringify(response), JSON.stringify(voucher)));
    const lifecycle = JSON.parse((await timed(stageTimings, 'fabricQueryResponseLifecycleMs', () =>
      contract.evaluateTransaction('QueryResponseLifecycle', hxmsg.header.requestID))).toString());
    result.pass = lifecycle.status === 'Completed';
    result.gas.evm = relay.gas;
    result.gas.totalEvmGas = relay.gas.total;
    Object.assign(result, {
      requestID: hxmsg.header.requestID,
      fabricTxId: txId,
      evmTxHash: evmReceipt.hash,
      responseDigest: response.responseDigest,
      teeQuorum: `${voucher.reached}/${voucher.threshold}`,
      responseLifecycle: lifecycle,
    });
  } finally {
    gateway.disconnect();
  }
  result.timing.totalMs = nowMs() - startedMs;
  const output = { ...result, testedAt: new Date().toISOString() };
  fs.writeJsonSync(path.join(RUNTIME_DIR, 'hxmsg-fabric-evm-challenge-e2e-results.json'), output, { spaces: 2 });
  fs.writeFileSync(
    path.join(RUNTIME_DIR, 'hxmsg-fabric-evm-challenge-e2e-summary.md'),
    `# Fabric -> EVM RESPONSE 闭环测试\n\n` +
      `状态：${output.pass ? 'PASS' : 'FAIL'}\n` +
      `requestID: ${output.requestID || '-'}\n` +
      `总耗时(ms): ${output.timing.totalMs}\n` +
      `EVM Gas: ${output.gas.totalEvmGas ?? 0}\n`
  );
  console.log(`${output.pass ? 'PASS' : 'FAIL'} Fabric->EVM response lifecycle requestID=${output.requestID || '-'}`);
  process.exit(output.pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
