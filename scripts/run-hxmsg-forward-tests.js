const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { Gateway, Wallets } = require('fabric-network');
const { common } = require('fabric-protos');
const { encodeBusinessPayload } = require('../shared/xmsg');
const {
  addressToBytes32,
  chainIdToBytes32,
  FeedbackType,
  hashJson,
  toMinimalHXMsg,
} = require('../shared/hxmsg');
const { buildHXMsgFromFabricEvent, TARGET_EXECUTE_SELECTOR } = require('../hxmsg-builder/fabric-to-evm');
const { writeJSON } = require('../shared/utils');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const TEST_DATA = path.join(__dirname, '..', 'test-data', 'fabric-real-cases.json');
const RESULTS_FILE = 'hxmsg-fabric-evm-results.json';
const SUMMARY_FILE = 'hxmsg-test-summary.md';
const TEE_URLS = (process.env.TEE_URLS || process.env.TEE_URL || 'http://127.0.0.1:9000,http://127.0.0.1:9001,http://127.0.0.1:9002,http://127.0.0.1:9003,http://127.0.0.1:9004')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);
const EVM_RPC = process.env.EVM_RPC || 'http://127.0.0.1:8545';
const PRIV_KEY = process.env.DEPLOYER_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function relayHXMsg(hxmsg, teeUrl) {
  const teeResp = await axios.post(`${teeUrl}/attest`, {
    hxmsg,
    helperData: hxmsg._blockData || {},
  }, { timeout: 20000 });
  const cluster = teeResp.data.teeClusterCertification;
  if (!cluster?.quorumReached) {
    throw new Error(`TEE cluster quorum not reached: ${cluster?.reached || 0}/${cluster?.threshold || '?'}`);
  }
  const certs = cluster.certifications || [];
  if (certs.length < Number(cluster.threshold || 1)) {
    throw new Error(`Committed TEE certifications below threshold: ${certs.length}/${cluster.threshold}`);
  }

  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet = new ethers.Wallet(PRIV_KEY, provider);
  const deployer = new ethers.NonceManager(wallet);
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));

  const registry = new ethers.Contract(
    deployment.teeRegistry,
    ['function trustedTEE(address) view returns (bool)', 'function registerTEE(address) external'],
    deployer
  );
  for (const cert of certs) {
    if (!(await registry.trustedTEE(cert.teeAddress))) {
      const tx = await registry.registerTEE(cert.teeAddress);
      await tx.wait();
    }
  }

  const gateway = new ethers.Contract(
    deployment.hxmsgGateway,
    ['function executeHXMsgMinimalCluster((bytes32,bytes32,uint8,bytes32,uint8,bytes32,bytes4,bytes32,bytes32,bytes32,bool,uint8,uint64,bytes32,uint64),address,bytes,(bytes32,bytes32,address,uint64,bytes)[]) external'],
    deployer
  );
  const tx = await gateway.executeHXMsgMinimalCluster(
    toMinimalHXMsg(hxmsg),
    deployment.targetContract,
    hxmsg.callData,
    certs.map((cert) => [
      cert.requestID,
      cert.hmsgDigest,
      cert.teeAddress,
      cert.verifiedAt,
      cert.signature,
    ])
  );
  const receipt = await tx.wait();
  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    teeVerification: teeResp.data.verificationResult,
    teeCluster: cluster,
  };
}

function expectedBusinessStatus(op) {
  return {
    asset_lock: ethers.keccak256(ethers.toUtf8Bytes('ASSET_SETTLED')),
    mint_confirm: ethers.keccak256(ethers.toUtf8Bytes('ASSET_SETTLED')),
    receivable_attest: ethers.keccak256(ethers.toUtf8Bytes('RECEIVABLE_ATTESTED')),
    logistics_sync: ethers.keccak256(ethers.toUtf8Bytes('LOGISTICS_SYNCED')),
    medical_consent: ethers.keccak256(ethers.toUtf8Bytes('CONSENT_GRANTED')),
    oracle_update: ethers.keccak256(ethers.toUtf8Bytes('ORACLE_UPDATED')),
    approval_commit: ethers.keccak256(ethers.toUtf8Bytes('APPROVAL_COMMITTED')),
    subsidy_confirm: ethers.keccak256(ethers.toUtf8Bytes('ASSET_SETTLED')),
  }[op] || ethers.keccak256(ethers.toUtf8Bytes('RECORDED'));
}

async function queryTargetState(requestID) {
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));
  const target = new ethers.Contract(
    deployment.targetContract,
    [
      'function executionCount() view returns (uint256)',
      'function lastRequestID() view returns (bytes32)',
      'function lastPayloadHash() view returns (bytes32)',
      'function getBusinessRecord(bytes32) view returns ((bytes32 requestID,string op,string recordId,string actor,string amount,bytes32 metadataHash,bool requireAck,address service,bytes32 status,uint64 updatedAt))',
    ],
    provider
  );
  const business = await target.getBusinessRecord(requestID);
  return {
    executionCount: (await target.executionCount()).toString(),
    lastRequestID: await target.lastRequestID(),
    lastPayloadHash: await target.lastPayloadHash(),
    business: {
      requestID: business.requestID,
      op: business.op,
      recordId: business.recordId,
      actor: business.actor,
      amount: business.amount,
      metadataHash: business.metadataHash,
      requireAck: business.requireAck,
      service: business.service,
      status: business.status,
      updatedAt: Number(business.updatedAt),
    },
  };
}

function saveSummary(results, totals) {
  let md = '# h-xmsg / h-FSV 正向测试结果 (Fabric → EVM)\n\n';
  md += `**测试时间**：${new Date().toISOString()}\n`;
  md += `**通过率**：${totals.pass}/${totals.total} | **消息结构**：h-xmsg | **Fabric 验证**：h-FSV | **TEE 共识**：Raft-backed TEE cluster | **EVM提交**：HXMsgMinimalCluster | **目标合约**：分类业务服务\n\n`;
  md += '| 用例 | 业务 | 金额 | RESPONSE | Atomicity | Fabric 区块 | EVM Gas | TEE 验证 | TEE Quorum | Peer 背书 | MSP | 交易写集 | 目标执行 | 状态 |\n';
  md += '|------|------|------|----------|-----------|------------|---------|----------|------------|-----------|-----|----------|----------|------|\n';
  for (const r of results) {
    const f = r.fieldCheck || {};
    const quorum = r.teeCluster ? `${r.teeCluster.reached}/${r.teeCluster.threshold}` : '-';
    md += `| ${r.caseId} | ${r.expectedTargetFields?.op || '-'} | ${r.expectedTargetFields?.amount || '-'} | ${r.responseRequired ? 'yes' : 'no'} | ${r.atomicityRequired ? 'yes' : 'no'} | ${r.srcHeight || '-'} | ${(Number(r.gasUsed) || 0).toLocaleString()} | ${r.teeVerification?.adapter || '-'} | ${quorum} | ${r.teeVerification?.endorsementCount ?? '-'} | ${(r.teeVerification?.endorsedMSPIDs || []).join(',') || '-'} | ${r.teeVerification?.validatedWriteKey ? 'checked' : '-'} | ${f.businessMatch ? 'service-action' : '-'} | ${r.pass ? 'PASS' : 'FAIL'} |\n`;
  }
  fs.writeFileSync(path.join(RUNTIME_DIR, SUMMARY_FILE), md);
}

async function main() {
  fs.ensureDirSync(RUNTIME_DIR);
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));
  if (!deployment.hxmsgGateway || !deployment.teeRegistry) {
    throw new Error('deployment.json missing hxmsgGateway/teeRegistry; run deploy after compiling new contracts');
  }

  const testData = fs.readJsonSync(TEST_DATA);
  const cases = testData.cases;
  const targetObject = addressToBytes32(deployment.targetContract);
  const targetChainID = chainIdToBytes32(deployment.chainId);
  const receiver = targetObject;

  const results = [];
  let pass = 0;
  let fail = 0;

  const teeUrl = await resolveTeeLeader();
  const projectRoot = path.join(__dirname, '..');
  const { gateway, network, contract, channel, chaincode } = await getFabric(projectRoot);

  try {
    for (let i = 0; i < cases.length; i += 1) {
      const tc = cases[i];
      const t0 = Date.now();
      const caseResult = {
        caseId: tc.caseId,
        description: tc.description,
        expectedTargetFields: tc.expectedTargetFields,
        pass: false,
      };
      try {
        const businessPayload = { ...tc.payload, requireAck: false };
        if (['asset_lock', 'subsidy_confirm'].includes(businessPayload.op)) {
          businessPayload.targetRecipient = deployment.deployer;
        }
        const expectedFields = { ...(tc.expectedTargetFields || {}) };
        if (['asset_lock', 'subsidy_confirm'].includes(businessPayload.op)) {
          expectedFields.actor = deployment.deployer;
        }
        caseResult.expectedTargetFields = expectedFields;
        const { normalized, payloadHex } = encodeBusinessPayload(businessPayload);
        const payload = {
          businessPayload,
          targetChainType: 'EVM',
          targetChainID,
          targetObject,
          functionSelector: TARGET_EXECUTE_SELECTOR,
          callDataHash: ethers.keccak256(payloadHex),
          businessPayloadHash: hashJson(normalized),
          receiver,
          expireAt: Math.floor(Date.now() / 1000) + 3600,
        };

        console.log(`[${i + 1}/${cases.length}] ${tc.caseId}: invoke Fabric`);
        const tx = contract.createTransaction('EmitXCall');
        const txId = tx.getTransactionId();
        const emitResp = JSON.parse((await tx.submit(JSON.stringify(payload))).toString());
        const blockNumber = await fabricBlockNumberByTx(network, channel, txId);
        const eventRecord = JSON.parse((await contract.evaluateTransaction('QueryCrosschainEvent', emitResp.requestID)).toString());
        caseResult.txId = txId;

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
        const protocolCheck = {
          feedbackDisabled: hxmsg.feedback?.required === false
            && Number(hxmsg.feedback?.expectedMsgType || 0) === FeedbackType.NONE
            && Number(hxmsg.feedback?.timeout || 0) === 0
            && hxmsg.feedback?.callbackRefHash === ethers.ZeroHash,
          atomicityDisabled: !hxmsg.atomicity?.required,
          challengeResponseExpected: false,
        };
        caseResult.requestID = hxmsg.header.requestID;
        caseResult.srcHeight = hxmsg.srcHeight;
        caseResult.hmsgDigest = hxmsg.hmsgDigest;
        caseResult.feedback = hxmsg.feedback;
        caseResult.atomicity = hxmsg.atomicity || null;
        caseResult.responseRequired = Boolean(hxmsg.feedback?.required);
        caseResult.atomicityRequired = Boolean(hxmsg.atomicity?.required);
        caseResult.protocolCheck = protocolCheck;

        console.log(`  h-xmsg ${hxmsg.header.requestID}, block ${hxmsg.srcHeight}`);
        const relay = await relayHXMsg(hxmsg, teeUrl);
        caseResult.relayTxHash = relay.txHash;
        caseResult.gasUsed = relay.gasUsed;
        caseResult.teeVerification = relay.teeVerification;
        caseResult.teeCluster = relay.teeCluster;

        const targetState = await queryTargetState(caseResult.requestID);
        const payloadHash = ethers.keccak256(hxmsg.callData);
        const expected = expectedFields;
        const fieldCheck = {
          requestIDMatch: targetState.lastRequestID === caseResult.requestID,
          payloadHashMatch: targetState.lastPayloadHash === payloadHash,
          businessMatch: targetState.business.requestID === caseResult.requestID
            && targetState.business.op === expected.op
            && targetState.business.recordId === expected.recordId
            && targetState.business.actor === expected.actor
            && targetState.business.amount === expected.amount
            && targetState.business.status === expectedBusinessStatus(expected.op)
            && targetState.business.updatedAt > 0,
        };
        caseResult.fieldCheck = fieldCheck;
        caseResult.actualTargetState = targetState;
        caseResult.expectedPayloadHash = payloadHash;
        caseResult.totalMs = Date.now() - t0;
        caseResult.pass = Object.values(fieldCheck).every(Boolean)
          && protocolCheck.feedbackDisabled
          && protocolCheck.atomicityDisabled
          && relay.teeVerification?.validatedWriteKey?.includes(caseResult.requestID)
          && Number(relay.teeVerification?.endorsementCount || 0) > 0
          && (relay.teeVerification?.endorsedMSPIDs || []).includes('Org1MSP');
        if (caseResult.pass) pass += 1; else fail += 1;
        console.log(`  ${caseResult.pass ? 'PASS' : 'FAIL'} gas=${caseResult.gasUsed} time=${caseResult.totalMs}ms`);
      } catch (error) {
        fail += 1;
        caseResult.error = error.message;
        caseResult.totalMs = Date.now() - t0;
        console.log(`  ERROR ${error.message}`);
      }
      results.push(caseResult);
      writeJSON(RESULTS_FILE, {
        testType: 'hxmsg-hfsv-fabric-to-evm',
        testedAt: new Date().toISOString(),
        total: cases.length,
        pass,
        fail,
        results,
      });
      saveSummary(results, { total: cases.length, pass, fail });
      if (i < cases.length - 1) await sleep(1500);
    }
  } finally {
    gateway.disconnect();
  }

  console.log(`FINAL ${pass}/${cases.length} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
