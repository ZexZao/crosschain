const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { Gateway, Wallets } = require('fabric-network');
const { common } = require('fabric-protos');
const { loadDotEnv } = require('../shared/env');
const {
  ChainType,
  bytes32FromText,
  chainIdToBytes32,
  computeHXMsgDigest,
  computeTargetExecutionHash,
  buildDeliveryMessage,
  hashJson,
  FeedbackType,
} = require('../shared/hxmsg');
const { encodeCompactBusinessCall } = require('../shared/xmsg');
const { buildReceiptProof } = require('../shared/evm/receipt-proof');
const { buildCommitteeHeaderUpdate } = require('../shared/evm/header-committee');
const { buildEvmSourcePayloadHash } = require('../hxmsg-builder/source-builders/evm');
const { buildFabricSourceRecordHash } = require('../hxmsg-builder/source-builders/fabric');
const {
  buildHXMsgFromEvmReceipt,
  FABRIC_INVOKE_SELECTOR,
  buildFabricTargetObject,
} = require('../hxmsg-builder/evm-to-fabric');
const {
  buildHXMsgFromFabricEvent,
  TARGET_EXECUTE_SELECTOR,
} = require('../hxmsg-builder/fabric-to-evm');
const { writeJSON } = require('../shared/utils');
const { teeURLsFromEnv } = require('../shared/tee/subnet-routing');

loadDotEnv();

const PROJECT_ROOT = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, 'runtime');
const EVM_RPC = process.env.EVM_RPC || 'http://127.0.0.1:8545';
const TEE_EVM_RPC = process.env.TEE_EVM_RPC || 'http://evm-node:8545';
const EVM_TEE_URLS = teeURLsFromEnv({ sourceChainType: ChainType.EVM });
const FABRIC_TEE_URLS = process.env.TEE_URLS || process.env.TEE_URL
  ? teeURLsFromEnv({ sourceChainType: ChainType.EVM })
  : teeURLsFromEnv({ sourceChainType: ChainType.FABRIC });
const HARDHAT_DEFAULT_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const SOURCE_ABI = [
  'function submitHXMsgRequest(bytes32 targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 expireAt,(bool,uint8,uint64,bytes32,(bool,uint8,uint8,bytes32,bytes32,bytes32,uint64))) external returns (bytes32)',
  'event CrossChainCallRequested(bytes32 indexed requestID,address indexed sender,bytes32 indexed targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bool feedbackRequired,uint8 expectedFeedbackMsgType,uint64 feedbackTimeout,bytes32 callbackRefHash,bytes32 atomicityHash)',
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function patch(obj, mutator) {
  if (!obj) return;
  mutator(obj);
}

function setNestedHXMsgFields(hxmsg, mutator) {
  mutator(hxmsg);
  patch(hxmsg.canonicalHxmsg, mutator);
  patch(hxmsg.hxmsgEnvelope?.hxmsg, mutator);
}

function recomputeHXMsgBindings(hxmsg, forgedPayload) {
  const { normalized, compact, payloadHex, compactCallHash } = encodeCompactBusinessCall(forgedPayload);
  const businessPayloadHash = hashJson(normalized);

  setNestedHXMsgFields(hxmsg, (m) => {
    m.targetAction.callDataHash = compactCallHash;
    m.payloadBinding.businessPayloadHash = businessPayloadHash;
  });

  if (hxmsg.hxmsgEnvelope?.executionData) {
    hxmsg.hxmsgEnvelope.executionData.callData = payloadHex;
    hxmsg.hxmsgEnvelope.executionData.compactCall = compact;
    hxmsg.hxmsgEnvelope.executionData.businessPayload = normalized;
  }
  hxmsg.callData = payloadHex;
  hxmsg.compactCall = compact;
  hxmsg.callDataDecoded = normalized;

  const targetExecutionHash = computeTargetExecutionHash({
    requestID: hxmsg.header.requestID,
    targetChainID: hxmsg.target.chainID,
    targetObject: hxmsg.targetAction.targetObject,
    functionSelector: hxmsg.targetAction.functionSelector,
    callDataHash: compactCallHash,
    receiver: hxmsg.targetAction.receiver,
  });

  setNestedHXMsgFields(hxmsg, (m) => {
    m.payloadBinding.targetExecutionHash = targetExecutionHash;
  });

  if (hxmsg.deliveryMessage) {
    hxmsg.deliveryMessage = buildDeliveryMessage(hxmsg, {
      callData: payloadHex,
      compactCall: compact,
      businessPayload: normalized,
    });
  }

  return { normalized, compact, payloadHex, compactCallHash, businessPayloadHash, targetExecutionHash };
}

function forgeEvmHXMsg(validHxmsg, forgedPayload) {
  const forged = clone(validHxmsg);
  const binding = recomputeHXMsgBindings(forged, forgedPayload);
  const realSourceRecord = forged.sourceRecord || forged.hxmsgEnvelope?.sourceEvidence?.sourceRecord;
  const fakeSourceRecord = {
    ...realSourceRecord,
    callDataHash: binding.compactCallHash,
  };
  const fakeSourcePayloadHash = buildEvmSourcePayloadHash(fakeSourceRecord);
  setNestedHXMsgFields(forged, (m) => {
    m.payloadBinding.sourcePayloadHash = fakeSourcePayloadHash;
    m.hmsgDigest = computeHXMsgDigest(m);
  });
  forged.hmsgDigest = computeHXMsgDigest(forged);
  if (forged.deliveryMessage) {
    forged.deliveryMessage = buildDeliveryMessage(forged, forged.hxmsgEnvelope?.executionData || {});
  }
  if (forged.hxmsgEnvelope?.sourceEvidence?.sourceRecord) {
    forged.hxmsgEnvelope.sourceEvidence.sourceRecord = fakeSourceRecord;
  }
  forged.sourceRecord = fakeSourceRecord;
  return { forged, binding };
}

function forgeFabricHXMsg(validHxmsg, forgedPayload) {
  const forged = clone(validHxmsg);
  const binding = recomputeHXMsgBindings(forged, forgedPayload);
  const realSourceRecord = forged.sourceRecord || forged.hxmsgEnvelope?.sourceEvidence?.sourceRecord;
  const fakeSourceRecord = {
    ...realSourceRecord,
    callDataHash: binding.compactCallHash,
    businessPayloadHash: binding.businessPayloadHash,
  };
  const fakeSourcePayloadHash = buildFabricSourceRecordHash(fakeSourceRecord);
  setNestedHXMsgFields(forged, (m) => {
    m.payloadBinding.sourcePayloadHash = fakeSourcePayloadHash;
    m.hmsgDigest = computeHXMsgDigest(m);
  });
  forged.hmsgDigest = computeHXMsgDigest(forged);
  if (forged.deliveryMessage) {
    forged.deliveryMessage = buildDeliveryMessage(forged, forged.hxmsgEnvelope?.executionData || {});
  }
  if (forged.hxmsgEnvelope?.sourceEvidence?.sourceRecord) {
    forged.hxmsgEnvelope.sourceEvidence.sourceRecord = fakeSourceRecord;
  }
  forged.sourceRecord = fakeSourceRecord;
  return { forged, binding };
}

async function resolveTeeLeader(urls) {
  const statuses = await Promise.all(urls.map(async (url) => {
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

async function expectTEEReject({ teeUrl, hxmsg, helperData, expectedErrorIncludes }) {
  try {
    const resp = await axios.post(`${teeUrl}/attest`, { hxmsg, helperData }, { timeout: 60000 });
    return {
      pass: false,
      rejected: false,
      error: 'TEE accepted forged h-xmsg',
      unexpectedResponse: resp.data,
    };
  } catch (error) {
    const message = error.response?.data?.error || error.message;
    const pass = expectedErrorIncludes.some((needle) => message.includes(needle));
    return {
      pass,
      rejected: true,
      error: message,
      expectedErrorIncludes,
    };
  }
}

async function runEvmToFabricForgery({ deployment, teeUrl }) {
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const privateKey = Number(deployment.chainId) === 31337
    ? HARDHAT_DEFAULT_PRIVATE_KEY
    : (process.env.DEPLOYER_PRIVATE_KEY || process.env.SEPOLIA_PRIVATE_KEY);
  if (!privateKey) throw new Error('DEPLOYER_PRIVATE_KEY is required outside local Hardhat');
  const signer = new ethers.NonceManager(new ethers.Wallet(privateKey, provider));
  const source = new ethers.Contract(deployment.evmSourceContract, SOURCE_ABI, signer);
  const truePayload = {
    op: 'asset_lock',
    assetId: `FORGE-EVM-ASSET-${Date.now()}`,
    assetType: 'XCST',
    amount: '10.0000',
    recipient: 'fabric.forge.victim',
    owner: 'evm.forge.sender',
    metadata: 'real EVM source request amount 10',
    requireAck: false,
  };
  const forgedPayload = {
    ...truePayload,
    amount: '100.0000',
    recipient: 'fabric.forge.attacker',
    metadata: 'forged EVM source request amount 100',
  };
  const { normalized, payloadHex, compactCallHash } = encodeCompactBusinessCall(truePayload);
  const channelID = process.env.FABRIC_CHANNEL || 'mychannel';
  const chaincodeName = process.env.FABRIC_CHAINCODE || 'xcall';
  const expireAt = Math.floor(Date.now() / 1000) + 3600;
  const tx = await source.submitHXMsgRequest(
    bytes32FromText(`fabric-${channelID}`),
    bytes32FromText('fabric-local-domain'),
    buildFabricTargetObject(channelID, chaincodeName),
    FABRIC_INVOKE_SELECTOR,
    compactCallHash,
    hashJson(normalized),
    bytes32FromText(normalized.actor),
    expireAt,
    [false, FeedbackType.NONE, 0, ethers.ZeroHash, [false, 0, 0, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 0]]
  );
  const receipt = await tx.wait();
  const block = await provider.getBlock(receipt.blockNumber);
  const receiptProof = await buildReceiptProof({ provider, blockNumber: receipt.blockNumber, txHash: receipt.hash });
  const hxmsg = buildHXMsgFromEvmReceipt({ deployment, receipt, block, businessPayload: truePayload });
  const { forged, binding } = forgeEvmHXMsg(hxmsg, forgedPayload);
  const committeeHeaderUpdate = buildCommitteeHeaderUpdate({
    header: receiptProof.blockHeader,
    chainID: `eip155:${deployment.chainId}`,
  });
  const tee = await expectTEEReject({
    teeUrl,
    hxmsg: forged,
    helperData: {
      evmReceiptProof: receiptProof,
      committeeHeaderUpdate,
      evmRpc: TEE_EVM_RPC,
    },
    expectedErrorIncludes: [
      'EVM event callDataHash mismatch',
      'EVM event businessPayloadHash mismatch',
      'EVM sourcePayloadHash mismatch',
    ],
  });
  return {
    caseId: 'FORGE-EVM-FABRIC-SELF-CONSISTENT',
    direction: 'Ethereum -> Fabric',
    sourceTxHash: receipt.hash,
    sourceBlockNumber: receipt.blockNumber,
    trueAmount: truePayload.amount,
    forgedAmount: forgedPayload.amount,
    forgedHmsgDigest: forged.hmsgDigest,
    forgedCallDataHash: binding.compactCallHash,
    ...tee,
  };
}

async function runFabricToEvmForgery({ deployment, teeUrl }) {
  const { gateway, network, contract, channel, chaincode } = await getFabric(PROJECT_ROOT);
  try {
    const trueBusinessPayload = {
      op: 'asset_lock',
      assetId: `FORGE-FABRIC-ASSET-${Date.now()}`,
      assetType: 'XCST',
      amount: '10.0000',
      targetRecipient: deployment.deployer,
      owner: 'fabric.forge.sender',
      metadata: 'real Fabric source request amount 10',
      requireAck: false,
    };
    const forgedBusinessPayload = {
      ...trueBusinessPayload,
      amount: '100.0000',
      metadata: 'forged Fabric source request amount 100',
    };
    const { normalized, compactCallHash } = encodeCompactBusinessCall(trueBusinessPayload);
    const payload = {
      businessPayload: trueBusinessPayload,
      targetChainType: 'EVM',
      targetChainID: chainIdToBytes32(deployment.chainId),
      targetObject: ethers.zeroPadValue(deployment.targetContract, 32),
      functionSelector: TARGET_EXECUTE_SELECTOR,
      callDataHash: compactCallHash,
      businessPayloadHash: hashJson(normalized),
      receiver: ethers.zeroPadValue(deployment.targetContract, 32),
      expireAt: Math.floor(Date.now() / 1000) + 3600,
    };
    const tx = contract.createTransaction('EmitXCall');
    const txId = tx.getTransactionId();
    const emitResp = JSON.parse((await tx.submit(JSON.stringify(payload))).toString());
    const blockNumber = await fabricBlockNumberByTx(network, channel, txId);
    const eventRecord = JSON.parse((await contract.evaluateTransaction('QueryCrosschainEvent', emitResp.requestID)).toString());
    const hxmsg = buildHXMsgFromFabricEvent({
      deployment,
      channelName: channel,
      chaincodeId: chaincode,
      rawPayload: eventRecord,
      txId,
      blockNumber,
      nonce: emitResp.nonce,
      createdAt: eventRecord.createdAt,
    });
    const { forged, binding } = forgeFabricHXMsg(hxmsg, forgedBusinessPayload);
    const tee = await expectTEEReject({
      teeUrl,
      hxmsg: forged,
      helperData: forged._blockData || {},
      expectedErrorIncludes: [
        'callDataHash mismatch',
        'businessPayloadHash mismatch',
        'sourcePayloadHash mismatch',
      ],
    });
    return {
      caseId: 'FORGE-FABRIC-EVM-SELF-CONSISTENT',
      direction: 'Fabric -> Ethereum',
      sourceTxID: txId,
      sourceBlockNumber: blockNumber,
      requestID: emitResp.requestID,
      trueAmount: trueBusinessPayload.amount,
      forgedAmount: forgedBusinessPayload.amount,
      forgedHmsgDigest: forged.hmsgDigest,
      forgedCallDataHash: binding.compactCallHash,
      ...tee,
    };
  } finally {
    gateway.disconnect();
  }
}

async function main() {
  fs.ensureDirSync(RUNTIME_DIR);
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));
  const evmTeeUrl = await resolveTeeLeader(EVM_TEE_URLS);
  const fabricTeeUrl = await resolveTeeLeader(FABRIC_TEE_URLS);
  const startedAt = Date.now();
  const results = [];
  results.push(await runEvmToFabricForgery({ deployment, teeUrl: evmTeeUrl }));
  results.push(await runFabricToEvmForgery({ deployment, teeUrl: fabricTeeUrl }));
  const output = {
    testType: 'self-consistent-hxmsg-forgery-attack',
    testedAt: new Date().toISOString(),
    teeUrls: { evm: evmTeeUrl, fabric: fabricTeeUrl },
    total: results.length,
    pass: results.filter((item) => item.pass).length,
    fail: results.filter((item) => !item.pass).length,
    elapsedMs: Date.now() - startedAt,
    results,
  };
  writeJSON('hxmsg-forgery-attack-results.json', output);
  const summary = [
    '# h-xmsg 自洽伪造攻击测试',
    '',
    `**测试时间**：${output.testedAt}`,
    `**通过率**：${output.pass}/${output.total}`,
    '',
    '| 用例 | 方向 | 真实金额 | 伪造金额 | TEE 是否拒绝 | 错误 | 状态 |',
    '|---|---|---:|---:|---|---|---|',
    ...results.map((r) => `| ${r.caseId} | ${r.direction} | ${r.trueAmount} | ${r.forgedAmount} | ${r.rejected ? 'yes' : 'no'} | ${String(r.error || '').replace(/[|\r\n]/g, ' ')} | ${r.pass ? 'PASS' : 'FAIL'} |`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(RUNTIME_DIR, 'hxmsg-forgery-attack-summary.md'), summary);
  console.log(`FINAL ${output.pass}/${output.total} passed, ${output.fail} failed`);
  for (const r of results) {
    console.log(`${r.caseId} ${r.pass ? 'PASS' : 'FAIL'}: ${r.error}`);
  }
  if (output.fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error.response?.data?.error || error.message);
  process.exit(1);
});
