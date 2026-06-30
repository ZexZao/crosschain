const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { Gateway, Wallets } = require('fabric-network');
const { encodeCompactBusinessCall } = require('../shared/xmsg');
const {
  bytes32FromText,
  hashJson,
  AtomicityMode,
  CommitmentType,
  FeedbackType,
  buildDeliveryMessage,
  getExecutionData,
} = require('../shared/hxmsg');
const { buildHXMsgFromEvmReceipt, FABRIC_INVOKE_SELECTOR, buildFabricTargetObject } = require('../hxmsg-builder/evm-to-fabric');
const { buildReceiptProof } = require('../shared/evm/receipt-proof');
const { buildCommitteeHeaderUpdate } = require('../shared/evm/header-committee');
const { buildFabricExecutionProofRef, buildFabricExecutionViewRef, buildExecutedResponse } = require('../hxmsg-builder/response');
const { registerEVMTEEs, registerFabricTEEs, clusterCertificateTuple } = require('../shared/tee/registration');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const TEE_URLS = (process.env.TEE_URLS || process.env.TEE_URL || 'http://127.0.0.1:9000,http://127.0.0.1:9001,http://127.0.0.1:9002,http://127.0.0.1:9003,http://127.0.0.1:9004')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);
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
  return { gateway, contract: network.getContract(chaincode), channel, chaincode };
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

async function main() {
  const startedMs = nowMs();
  const stageTimings = {};
  fs.ensureDirSync(RUNTIME_DIR);
  const projectRoot = path.join(__dirname, '..');
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const signer = new ethers.NonceManager(new ethers.Wallet(PRIV_KEY, provider));
  const channelID = process.env.FABRIC_CHANNEL || 'mychannel';
  const chaincodeName = process.env.FABRIC_CHAINCODE || 'xcall';
  const { gateway, contract } = await getFabric(projectRoot);
  const result = {
    testType: 'evm-fabric-challenge-response-e2e',
    pass: false,
    timing: { stageMs: stageTimings },
    gas: {
      evm: {
        submitHXMsgRequest: 0,
        registerTEE: 0,
        completeWithResponse: 0,
        total: 0,
      },
      fabric: { notApplicable: true, reason: 'Hyperledger Fabric transactions do not use EVM gas.' },
    },
  };
  try {
    const teeUrl = await timed(stageTimings, 'resolveTeeLeaderMs', resolveTeeLeader);
    const source = new ethers.Contract(
      deployment.evmSourceContract,
      [
        'function submitHXMsgRequest(bytes32,bytes32,bytes32,bytes4,bytes32,bytes32,bytes32,uint64,(bool,uint8,uint64,bytes32,(bool,uint8,uint8,bytes32,bytes32,bytes32,uint64))) external returns (bytes32)',
        `function completeWithResponse(bytes32,(bytes32,bytes32,uint8,bytes32,bytes32,bytes32),${CLUSTER_CERT_ABI}) external`,
      ],
      signer
    );
    const registry = new ethers.Contract(
    deployment.teeRegistry,
    [
      'function isActiveTEE(address) view returns (bool)',
      `function registerTEE(${TEE_REGISTRATION_ABI}) external`,
    ],
    signer
  );
    const businessPayload = {
      op: 'oracle_update',
      recordId: `EVM-FABRIC-ORACLE-CR-001-${Date.now()}`,
      actor: 'evm.oracle.publisher',
      amount: '123.4500',
      metadata: 'challenge-response e2e oracle update',
      requireAck: false,
    };
    const { normalized, compactCallHash } = encodeCompactBusinessCall(businessPayload);
    const latest = await provider.getBlock('latest');
    const now = Number(latest.timestamp);
    const failureData = 'evm-fabric-failure';
    const receipt = await timed(stageTimings, 'evmSubmitAtomicRequestMs', async () => {
      const atomicity = [
        true,
        AtomicityMode.COMMIT_OR_COMPENSATE,
        CommitmentType.INTENT_ONLY,
        ethers.keccak256(ethers.toUtf8Bytes('evm-fabric-commitment')),
        ethers.keccak256(ethers.toUtf8Bytes('evm-fabric-success')),
        ethers.keccak256(ethers.toUtf8Bytes(failureData)),
        60,
      ];
      const tx = await source.submitHXMsgRequest(
        bytes32FromText(`fabric-${channelID}`),
        bytes32FromText('fabric-local-domain'),
        buildFabricTargetObject(channelID, chaincodeName),
        FABRIC_INVOKE_SELECTOR,
        compactCallHash,
        hashJson(normalized),
        bytes32FromText(normalized.actor),
        now + 3600,
        [true, FeedbackType.RESPONSE, now + 3600, ethers.ZeroHash, atomicity]
      );
      return tx.wait();
    });
    result.gas.evm.submitHXMsgRequest = gasOf(receipt);
    const block = await timed(stageTimings, 'evmGetSourceBlockMs', () =>
      provider.getBlock(receipt.blockNumber));
    const sourceProof = await timed(stageTimings, 'buildEvmReceiptProofMs', () =>
      buildReceiptProof({ provider, blockNumber: receipt.blockNumber, txHash: receipt.hash }));
    const sourceCommitteeHeaderUpdate = buildCommitteeHeaderUpdate({
      header: sourceProof.blockHeader,
      chainID: `eip155:${deployment.chainId}`,
    });
    const feedback = { required: true, expectedMsgType: 2, timeout: now + 3600, callbackRefHash: ethers.ZeroHash };
    const atomicity = {
      required: true,
      mode: AtomicityMode.COMMIT_OR_COMPENSATE,
      commitmentType: CommitmentType.INTENT_ONLY,
      commitmentRefHash: ethers.keccak256(ethers.toUtf8Bytes('evm-fabric-commitment')),
      successActionHash: ethers.keccak256(ethers.toUtf8Bytes('evm-fabric-success')),
      failureActionHash: ethers.keccak256(ethers.toUtf8Bytes(failureData)),
      challengeWindow: 60,
    };
    const hxmsg = buildHXMsgFromEvmReceipt({
      deployment,
      receipt,
      block,
      businessPayload,
      feedbackOverride: feedback,
      atomicity,
      channelID,
      chaincodeName,
    });
    const teeResp = await timed(stageTimings, 'teeAttestHXMsgMs', () => axios.post(`${teeUrl}/attest`, {
      hxmsg,
      helperData: { evmReceiptProof: sourceProof, committeeHeaderUpdate: sourceCommitteeHeaderUpdate },
    }, { timeout: 30000 }));
    const voucher = teeResp.data.teeClusterCertification;
    await timed(stageTimings, 'fabricRegisterTEEMs', () =>
      registerFabricTEEs({ contract, certificate: voucher, teeURLs: TEE_URLS }));
    await timed(stageTimings, 'fabricExecuteHXMsgMs', () =>
      contract.submitTransaction('ExecuteHXMsg', JSON.stringify(hxmsg), getExecutionData(hxmsg).callData, JSON.stringify(voucher)));
    const inbound = JSON.parse((await timed(stageTimings, 'fabricGetInboundStatusMs', () =>
      contract.evaluateTransaction('GetInboundStatus', hxmsg.header.requestID))).toString());
    const response = buildExecutedResponse({
      originRequestID: hxmsg.header.requestID,
      originHmsgDigest: hxmsg.hmsgDigest,
      targetExecutionHash: (hxmsg.deliveryMessage || buildDeliveryMessage(hxmsg)).targetExecutionHash,
      targetProofRefHash: buildFabricExecutionProofRef(inbound),
      responsePayload: { fabricTxId: inbound.txId, status: inbound.status },
    });
    const responseAttest = await timed(stageTimings, 'teeAttestResponseMs', () => axios.post(`${teeUrl}/attest-response`, {
      response,
      helperData: {
        originHxmsg: hxmsg,
        fabricExecutionView: buildFabricExecutionViewRef({
          channelID,
          chaincodeName,
          requestID: hxmsg.header.requestID,
        }),
      },
    }, { timeout: 30000 }));
    const responseVoucher = responseAttest.data.teeClusterCertification;
    const registration = await timed(stageTimings, 'evmRegisterResponseTEEMs', () =>
      registerEVMTEEs({ registry, certificate: responseVoucher, teeURLs: TEE_URLS }));
    result.gas.evm.registerTEE += Number(registration.gasUsed || 0n);
    const completeReceipt = await timed(stageTimings, 'evmCompleteWithResponseMs', async () =>
      (await source.completeWithResponse(
        hxmsg.header.requestID,
        [
          response.originRequestID,
          response.originHmsgDigest,
          response.responseStatus,
          response.targetExecutionHash,
          response.targetProofRefHash,
          response.responsePayloadHash,
        ],
        clusterCertificateTuple(responseVoucher)
      )).wait());
    result.gas.evm.completeWithResponse = gasOf(completeReceipt);
    result.gas.evm.total = result.gas.evm.submitHXMsgRequest + result.gas.evm.registerTEE + result.gas.evm.completeWithResponse;
    result.gas.totalEvmGas = result.gas.evm.total;
    const sourceView = new ethers.Contract(
      deployment.evmSourceContract,
      ['function requests(bytes32) view returns (address,bytes32,bytes32,bytes32,bytes4,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,uint8,uint8)'],
      provider
    );
    const sourceRecord = await sourceView.requests(hxmsg.header.requestID);
    const sourceStatus = Number(sourceRecord.status ?? sourceRecord[18]);
    result.pass = sourceStatus === 3;
    Object.assign(result, {
      requestID: hxmsg.header.requestID,
      evmTxHash: receipt.hash,
      fabricTxId: inbound.txId,
      responseDigest: response.responseDigest,
      teeQuorum: `${responseVoucher.reached}/${responseVoucher.threshold}`,
      sourceStatus,
    });
  } finally {
    gateway.disconnect();
  }
  result.timing.totalMs = nowMs() - startedMs;
  const output = { ...result, testedAt: new Date().toISOString() };
  fs.writeJsonSync(path.join(RUNTIME_DIR, 'hxmsg-evm-fabric-challenge-e2e-results.json'), output, { spaces: 2 });
  fs.writeFileSync(
    path.join(RUNTIME_DIR, 'hxmsg-evm-fabric-challenge-e2e-summary.md'),
    `# EVM -> Fabric 挑战响应闭环测试\n\n` +
      `状态：${output.pass ? 'PASS' : 'FAIL'}\n` +
      `requestID: ${output.requestID || '-'}\n` +
      `总耗时(ms): ${output.timing.totalMs}\n` +
      `EVM Gas: ${output.gas.totalEvmGas ?? 0}\n`
  );
  console.log(`${output.pass ? 'PASS' : 'FAIL'} EVM->Fabric challenge-response requestID=${output.requestID || '-'}`);
  process.exit(output.pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
