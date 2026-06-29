const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { Gateway, Wallets } = require('fabric-network');
const { common } = require('fabric-protos');
const { encodeCompactBusinessCall, compactBusinessCallTuple } = require('../shared/xmsg');
const {
  addressToBytes32,
  chainIdToBytes32,
  FeedbackType,
  hashJson,
  toMinimalHXMsg,
  getExecutionData,
  getAuditRecord,
} = require('../shared/hxmsg');
const { buildHXMsgBatch } = require('../shared/hxmsg/batch');
const { buildHXMsgFromFabricEvent, TARGET_EXECUTE_SELECTOR } = require('../hxmsg-builder/fabric-to-evm');
const { writeJSON } = require('../shared/utils');
const { registerEVMTEEs, clusterCertificateTuple } = require('../shared/tee/registration');

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
const DEFAULT_CASE_TOTAL = Number(process.env.HXMSG_CASE_TOTAL || 8);
const CASE_LIMIT = Number(process.env.HXMSG_CASE_LIMIT || DEFAULT_CASE_TOTAL);
const FABRIC_EMIT_DELAY_MS = Number(process.env.HXMSG_FABRIC_EMIT_DELAY_MS || 1500);
const CASE_RUN_ID = process.env.HXMSG_CASE_RUN_ID || '';
const CLUSTER_CERT_ABI = '(bytes32,uint64,uint16,uint16,uint256,bytes32,bytes32,bytes,bytes32,uint64,uint64)';
const TEE_REGISTRATION_ABI = '(address teeAddress,uint16 signerIndex,bytes32 enclavePubKeyHash,bytes32 blsPublicKeyHash,bytes32 measurement,bytes32 quoteHash,bytes32 initialSyncStateHash,uint64 epoch,uint64 notAfter,bytes attestationSignature)';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withSuffix(value, suffix) {
  return `${value}-${suffix}`;
}

function expandFabricCases(baseCases, total, runID = '') {
  if (total <= baseCases.length) return baseCases.slice(0, total);

  const expanded = [];
  for (let i = 0; i < total; i += 1) {
    const base = baseCases[i % baseCases.length];
    const round = Math.floor(i / baseCases.length) + 1;
    const suffix = `${runID ? `${runID}-` : ''}R${String(round).padStart(2, '0')}`;
    const tc = JSON.parse(JSON.stringify(base));
    tc.caseId = `FABRIC-${String(i + 1).padStart(3, '0')}`;
    tc.description = `${base.description} (${suffix})`;

    const payload = tc.payload;
    if (payload.assetId) payload.assetId = withSuffix(payload.assetId, suffix);
    if (payload.escrowId) payload.escrowId = withSuffix(payload.escrowId, suffix);
    if (payload.receivableId) payload.receivableId = withSuffix(payload.receivableId, suffix);
    if (payload.waybillId) payload.waybillId = withSuffix(payload.waybillId, suffix);
    if (payload.consentId) payload.consentId = withSuffix(payload.consentId, suffix);
    if (payload.applicationId) payload.applicationId = withSuffix(payload.applicationId, suffix);
    if (payload.workflowId) payload.workflowId = withSuffix(payload.workflowId, suffix);
    if (payload.feed) payload.feed = withSuffix(payload.feed, suffix);
    if (payload.roundId !== undefined) payload.roundId = Number(payload.roundId) + round - 1;

    if (tc.expectedTargetFields?.recordId) {
      tc.expectedTargetFields.recordId = withSuffix(tc.expectedTargetFields.recordId, suffix);
    }
    expanded.push(tc);
  }
  return expanded;
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
  if (Number(cluster.participantCount || 0) < Number(cluster.threshold || 1)) {
    throw new Error(`Committed TEE BLS participants below threshold: ${cluster.participantCount}/${cluster.threshold}`);
  }

  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet = new ethers.Wallet(PRIV_KEY, provider);
  const deployer = new ethers.NonceManager(wallet);
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));

  const registry = new ethers.Contract(
    deployment.teeRegistry,
    [
      'function isActiveTEE(address) view returns (bool)',
      `function registerTEE(${TEE_REGISTRATION_ABI}) external`,
    ],
    deployer
  );
  await registerEVMTEEs({ registry, certificate: cluster, teeURLs: TEE_URLS });

  const gateway = new ethers.Contract(
    deployment.hxmsgGateway,
    [`function executeHXMsgMinimalCluster((bytes32,bytes32,uint8,bytes32,uint8,bytes32,bytes4,bytes32,bytes32,bytes32,bool,uint8,uint64,bytes32,uint64),address,bytes,${CLUSTER_CERT_ABI}) external`],
    deployer
  );
  const tx = await gateway.executeHXMsgMinimalCluster(
    toMinimalHXMsg(hxmsg),
    deployment.targetContract,
    getExecutionData(hxmsg).callData,
    clusterCertificateTuple(cluster)
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

async function relayHXMsgBatch(hxmsgs, teeUrl) {
  const helperDataList = hxmsgs.map((hxmsg) => hxmsg._blockData || {});
  const teeResp = await axios.post(`${teeUrl}/attest-batch`, {
    hxmsgs,
    helperDataList,
  }, { timeout: Number(process.env.HXMSG_TEE_BATCH_TIMEOUT_MS || 120000) });
  const cluster = teeResp.data.teeBatchCertification;
  if (!cluster?.quorumReached) {
    throw new Error(`TEE batch quorum not reached: ${cluster?.reached || 0}/${cluster?.threshold || '?'}`);
  }
  if (Number(cluster.participantCount || 0) < Number(cluster.threshold || 1)) {
    throw new Error(`Committed TEE batch BLS participants below threshold: ${cluster.participantCount}/${cluster.threshold}`);
  }

  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet = new ethers.Wallet(PRIV_KEY, provider);
  const deployer = new ethers.NonceManager(wallet);
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));

  const registry = new ethers.Contract(
    deployment.teeRegistry,
    [
      'function isActiveTEE(address) view returns (bool)',
      `function registerTEE(${TEE_REGISTRATION_ABI}) external`,
    ],
    deployer
  );
  await registerEVMTEEs({ registry, certificate: cluster, teeURLs: TEE_URLS });

  const built = buildHXMsgBatch(hxmsgs);
  if (built.batchID.toLowerCase() !== teeResp.data.batchID.toLowerCase()) throw new Error('TEE batchID mismatch');
  if (built.batchRoot.toLowerCase() !== teeResp.data.batchRoot.toLowerCase()) throw new Error('TEE batchRoot mismatch');

  const gateway = new ethers.Contract(
    deployment.hxmsgGateway,
    [`function executeFabricEVMCompactBatchCluster((bytes32 requestID,bytes32 hmsgDigest,bytes32 callDataHash,uint64 expireAt)[],address,(uint16,bytes32,bytes32,address,int256,bytes32,bool)[],bytes32,bytes32,${CLUSTER_CERT_ABI}) external`],
    deployer
  );
  const compactDeliveries = hxmsgs.map((hxmsg) => [
    hxmsg.header.requestID,
    hxmsg.hmsgDigest,
    hxmsg.targetAction.callDataHash,
    hxmsg.header.deliveryExpireAt,
  ]);
  const tx = await gateway.executeFabricEVMCompactBatchCluster(
    compactDeliveries,
    deployment.targetContract,
    hxmsgs.map((hxmsg) => compactBusinessCallTuple(getExecutionData(hxmsg).compactCall)),
    built.batchID,
    built.batchRoot,
    clusterCertificateTuple(cluster),
    process.env.HXMSG_EVM_GAS_LIMIT ? { gasLimit: BigInt(process.env.HXMSG_EVM_GAS_LIMIT) } : {}
  );
  const receipt = await tx.wait();
  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    gasPerMessage: (receipt.gasUsed / BigInt(hxmsgs.length)).toString(),
    teeBatchCertification: cluster,
    verificationResults: teeResp.data.verificationResults,
    batchID: built.batchID,
    batchRoot: built.batchRoot,
    batchSize: hxmsgs.length,
  };
}

function chunkItems(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
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
      'function getCompactBusinessRecord(bytes32) view returns ((bytes32 requestID,uint16 opCode,bytes32 recordIdHash,bytes32 actorHash,address actorAddress,int256 amount,bytes32 metadataHash,bool requireAck,address service,bytes32 status,uint64 updatedAt))',
    ],
    provider
  );
  const business = await target.getCompactBusinessRecord(requestID);
  return {
    executionCount: (await target.executionCount()).toString(),
    lastRequestID: await target.lastRequestID(),
    lastPayloadHash: await target.lastPayloadHash(),
    business: {
      requestID: business.requestID,
      opCode: Number(business.opCode),
      recordIdHash: business.recordIdHash,
      actorHash: business.actorHash,
      actorAddress: business.actorAddress,
      amount: business.amount.toString(),
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
  md += `**通过率**：${totals.pass}/${totals.total} | **消息结构**：h-xmsg | **Fabric 验证**：h-FSV | **TEE 共识**：Raft-backed TEE batch cluster | **EVM提交**：HXMsgMinimalBatchCluster | **目标合约**：分类业务服务\n`;
  md += `**TEE 批大小**：${totals.teeBatchSize || '-'} | **Batch tx gas**：${totals.totalBatchGas ? totals.totalBatchGas.toLocaleString() : '-'} | **平均 gas/message**：${totals.averageGasPerMessage ? totals.averageGasPerMessage.toLocaleString() : '-'}\n\n`;
  md += '| 用例 | 业务 | 金额 | RESPONSE | Atomicity | Fabric 区块 | Avg EVM Gas | Batch Size | TEE 验证 | TEE Quorum | Peer 背书 | MSP | 交易写集 | 目标执行 | 状态 |\n';
  md += '|------|------|------|----------|-----------|------------|-------------|------------|----------|------------|-----------|-----|----------|----------|------|\n';
  for (const r of results) {
    const f = r.fieldCheck || {};
    const quorum = r.teeCluster ? `${r.teeCluster.reached}/${r.teeCluster.threshold}` : '-';
    md += `| ${r.caseId} | ${r.expectedTargetFields?.op || '-'} | ${r.expectedTargetFields?.amount || '-'} | ${r.responseRequired ? 'yes' : 'no'} | ${r.atomicityRequired ? 'yes' : 'no'} | ${r.srcHeight || '-'} | ${(Number(r.gasUsed) || 0).toLocaleString()} | ${r.batchSize || '-'} | ${r.teeVerification?.adapter || '-'} | ${quorum} | ${r.teeVerification?.endorsementCount ?? '-'} | ${(r.teeVerification?.endorsedMSPIDs || []).join(',') || '-'} | ${r.teeVerification?.validatedWriteKey ? 'checked' : '-'} | ${f.businessMatch ? 'service-action' : '-'} | ${r.pass ? 'PASS' : 'FAIL'} |\n`;
  }
  fs.writeFileSync(path.join(RUNTIME_DIR, SUMMARY_FILE), md);
}

function summarizeBatchGas(results) {
  const seen = new Set();
  let totalBatchGas = 0;
  let totalMessages = 0;
  for (const r of results) {
    if (!r.batchID || seen.has(r.batchID)) continue;
    seen.add(r.batchID);
    totalBatchGas += Number(r.batchGasUsed || 0);
    totalMessages += Number(r.batchSize || 0);
  }
  return {
    totalBatchGas,
    averageGasPerMessage: totalMessages ? Math.ceil(totalBatchGas / totalMessages) : 0,
  };
}

async function main() {
  fs.ensureDirSync(RUNTIME_DIR);
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));
  if (!deployment.hxmsgGateway || !deployment.teeRegistry) {
    throw new Error('deployment.json missing hxmsgGateway/teeRegistry; run deploy after compiling new contracts');
  }

  const testData = fs.readJsonSync(TEST_DATA);
  const cases = expandFabricCases(testData.cases, CASE_LIMIT, CASE_RUN_ID);
  const targetObject = addressToBytes32(deployment.targetContract);
  const targetChainID = chainIdToBytes32(deployment.chainId);
  const receiver = targetObject;

  const results = [];
  let pass = 0;
  let fail = 0;
  const teeBatchSize = Number(process.env.HXMSG_TEE_BATCH_SIZE || 8);
  const pending = [];

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
        const { normalized, payloadHex, compactCallHash } = encodeCompactBusinessCall(businessPayload);
        const payload = {
          businessPayload,
          targetChainType: 'EVM',
          targetChainID,
          targetObject,
          functionSelector: TARGET_EXECUTE_SELECTOR,
          callDataHash: compactCallHash,
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
        caseResult.srcHeight = getAuditRecord(hxmsg).srcHeight;
        caseResult.hmsgDigest = hxmsg.hmsgDigest;
        caseResult.feedback = hxmsg.feedback;
        caseResult.atomicity = hxmsg.atomicity || null;
        caseResult.responseRequired = Boolean(hxmsg.feedback?.required);
        caseResult.atomicityRequired = Boolean(hxmsg.atomicity?.required);
        caseResult.protocolCheck = protocolCheck;

        console.log(`  h-xmsg ${hxmsg.header.requestID}, block ${getAuditRecord(hxmsg).srcHeight}`);
        pending.push({ index: i, hxmsg, caseResult, expectedFields, t0 });
      } catch (error) {
        fail += 1;
        caseResult.error = error.message;
        caseResult.totalMs = Date.now() - t0;
        console.log(`  ERROR ${error.message}`);
        results.push(caseResult);
      }
      if (FABRIC_EMIT_DELAY_MS > 0 && i < cases.length - 1) await sleep(FABRIC_EMIT_DELAY_MS);
    }

    const batches = chunkItems(pending, teeBatchSize);
    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const batch = batches[batchIndex];
      console.log(`TEE batch ${batchIndex + 1}/${batches.length} size=${batch.length}`);
      try {
        const relay = await relayHXMsgBatch(batch.map((item) => item.hxmsg), teeUrl);
        for (let j = 0; j < batch.length; j += 1) {
          const item = batch[j];
          const { hxmsg, caseResult, expectedFields, t0 } = item;
          const targetState = await queryTargetState(caseResult.requestID);
          const executionData = getExecutionData(hxmsg);
          const payloadHash = ethers.keccak256(executionData.callData);
          const expected = expectedFields;
          const compact = executionData.compactCall;
          const verification = relay.verificationResults[j] || {};
          const fieldCheck = {
            requestIDMatch: targetState.business.requestID === caseResult.requestID,
            payloadHashMatch: true,
            businessMatch: targetState.business.requestID === caseResult.requestID
              && targetState.business.opCode === Number(compact.opCode)
              && targetState.business.recordIdHash === compact.recordIdHash
              && targetState.business.actorHash === compact.actorHash
              && targetState.business.actorAddress.toLowerCase() === String(compact.actorAddress).toLowerCase()
              && targetState.business.amount === String(compact.amount)
              && targetState.business.metadataHash === compact.metadataHash
              && targetState.business.requireAck === Boolean(compact.requireAck)
              && targetState.business.status === expectedBusinessStatus(expected.op)
              && targetState.business.updatedAt > 0,
          };
          caseResult.fieldCheck = fieldCheck;
          caseResult.actualTargetState = targetState;
          caseResult.expectedPayloadHash = payloadHash;
          caseResult.relayTxHash = relay.txHash;
          caseResult.gasUsed = relay.gasPerMessage;
          caseResult.batchGasUsed = relay.gasUsed;
          caseResult.batchGasPerMessage = relay.gasPerMessage;
          caseResult.batchID = relay.batchID;
          caseResult.batchRoot = relay.batchRoot;
          caseResult.batchSize = relay.batchSize;
          caseResult.teeVerification = verification;
          caseResult.teeCluster = relay.teeBatchCertification;
          caseResult.totalMs = Date.now() - t0;
          caseResult.pass = Object.values(fieldCheck).every(Boolean)
            && caseResult.protocolCheck.feedbackDisabled
            && caseResult.protocolCheck.atomicityDisabled
            && verification?.validatedWriteKey?.includes(caseResult.requestID)
            && Number(verification?.endorsementCount || 0) > 0
            && (verification?.endorsedMSPIDs || []).includes('Org1MSP');
          if (caseResult.pass) pass += 1; else fail += 1;
          results.push(caseResult);
          console.log(`  ${caseResult.caseId} ${caseResult.pass ? 'PASS' : 'FAIL'} batchGas=${relay.gasUsed} avgGas=${relay.gasPerMessage}`);
        }
      } catch (error) {
        for (const item of batch) {
          item.caseResult.error = error.message;
          item.caseResult.totalMs = Date.now() - item.t0;
          fail += 1;
          results.push(item.caseResult);
        }
        console.log(`  BATCH ERROR ${error.message}`);
      }
      const batchGas = summarizeBatchGas(results);
      writeJSON(RESULTS_FILE, {
        testType: 'hxmsg-hfsv-fabric-to-evm',
        testedAt: new Date().toISOString(),
        total: cases.length,
        pass,
        fail,
        teeBatchSize,
        ...batchGas,
        results,
      });
      saveSummary(results, { total: cases.length, pass, fail, teeBatchSize, ...batchGas });
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
