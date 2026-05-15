const { execSync } = require('child_process');
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { encodeBusinessPayload } = require('../shared/xmsg');
const {
  addressToBytes32,
  chainIdToBytes32,
  hashJson,
  toOnChainHXMsg,
} = require('../shared/hxmsg');
const { buildHXMsgFromFabricEvent, TARGET_EXECUTE_SELECTOR } = require('../hxmsg-builder/fabric-to-evm');
const { writeJSON } = require('../shared/utils');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const TEST_DATA = path.join(__dirname, '..', 'test-data', 'fabric-real-cases.json');
const PAYLOAD_PATH = path.join(RUNTIME_DIR, 'test-payload.json');
const RESULTS_FILE = 'hxmsg-fabric-evm-results.json';
const SUMMARY_FILE = 'hxmsg-test-summary.md';
const TEE_URL = process.env.TEE_URL || 'http://127.0.0.1:9000';
const EVM_RPC = process.env.EVM_RPC || 'http://127.0.0.1:8545';
const PRIV_KEY = process.env.DEPLOYER_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function invokeFabricChaincode(payloadObj) {
  fs.ensureDirSync(RUNTIME_DIR);
  fs.writeJsonSync(PAYLOAD_PATH, payloadObj, { spaces: 2 });
  const cmd = 'docker exec fabric-tools bash /fabric-network/fabric-network/scripts/invoke-xcall.sh --payload-file /fabric-network/runtime/test-payload.json 2>&1';
  let output;
  try {
    output = execSync(cmd, { encoding: 'utf8', timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    output = `${error.stdout || ''}\n${error.stderr || ''}`;
  }
  const txMatch = output.match(/txId[^a-f0-9]*([a-f0-9]{64})/i);
  if (!txMatch) {
    throw new Error(`Failed to parse Fabric txId from invoke output:\n${output.slice(-1200)}`);
  }
  return txMatch[1];
}

async function waitForCapturedEvent(txId) {
  const capturedPath = path.join(RUNTIME_DIR, 'fabric-captured-event.json');
  const started = Date.now();
  while (Date.now() - started < 45000) {
    await sleep(500);
    if (!fs.existsSync(capturedPath)) continue;
    const captured = fs.readJsonSync(capturedPath);
    if (captured.txId === txId) return captured;
  }
  throw new Error(`Timeout waiting for Fabric listener event ${txId}`);
}

async function relayHXMsg(hxmsg) {
  const teeResp = await axios.post(`${TEE_URL}/attest`, {
    hxmsg,
    helperData: hxmsg._blockData || {},
  }, { timeout: 20000 });
  const { teeCertification } = teeResp.data;

  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet = new ethers.Wallet(PRIV_KEY, provider);
  const deployer = new ethers.NonceManager(wallet);
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));

  const registry = new ethers.Contract(
    deployment.teeRegistry,
    ['function trustedTEE(address) view returns (bool)', 'function registerTEE(address) external'],
    deployer
  );
  if (!(await registry.trustedTEE(teeCertification.teeAddress))) {
    const tx = await registry.registerTEE(teeCertification.teeAddress);
    await tx.wait();
  }

  const gateway = new ethers.Contract(
    deployment.hxmsgGateway,
    ['function executeHXMsg((uint8,uint8,bytes32,uint8,bytes32,bytes32,uint8,bytes32,bytes32,uint8,bytes32,uint8,bytes32,bytes4,bytes32,bytes32,uint8,uint8,uint16,(uint8,bytes32,bytes32),bytes32,bytes32,bytes32,bytes32,bool,uint8,uint64,bytes32,uint64,uint64,uint64),address,bytes,(bytes32,bytes32,address,uint64,bytes)) external'],
    deployer
  );
  const tx = await gateway.executeHXMsg(
    toOnChainHXMsg(hxmsg),
    deployment.targetContract,
    hxmsg.callData,
    [
      teeCertification.requestID,
      teeCertification.hmsgDigest,
      teeCertification.teeAddress,
      teeCertification.verifiedAt,
      teeCertification.signature,
    ]
  );
  const receipt = await tx.wait();
  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    teeVerification: teeResp.data.verificationResult,
  };
}

async function queryTargetState() {
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));
  const target = new ethers.Contract(
    deployment.targetContract,
    [
      'function executionCount() view returns (uint256)',
      'function lastOp() view returns (string)',
      'function lastRecordId() view returns (string)',
      'function lastActor() view returns (string)',
      'function lastAmount() view returns (string)',
    ],
    provider
  );
  return {
    executionCount: (await target.executionCount()).toString(),
    lastOp: await target.lastOp(),
    lastRecordId: await target.lastRecordId(),
    lastActor: await target.lastActor(),
    lastAmount: await target.lastAmount(),
  };
}

function saveSummary(results, totals) {
  let md = '# h-xmsg / h-FSV 正向测试结果 (Fabric → EVM)\n\n';
  md += `**测试时间**：${new Date().toISOString()}\n`;
  md += `**通过率**：${totals.pass}/${totals.total} | **消息结构**：h-xmsg | **Fabric 验证**：h-FSV | **目标合约**：HXMsgGateway\n\n`;
  md += '| 用例 | 业务 | 金额 | Fabric 区块 | EVM Gas | TEE 验证 | Peer 背书 | MSP | 交易写集 | 字段 | 状态 |\n';
  md += '|------|------|------|------------|---------|----------|-----------|-----|----------|------|------|\n';
  for (const r of results) {
    const f = r.fieldCheck || {};
    md += `| ${r.caseId} | ${r.expectedTargetFields?.op || '-'} | ${r.expectedTargetFields?.amount || '-'} | ${r.srcHeight || '-'} | ${(Number(r.gasUsed) || 0).toLocaleString()} | ${r.teeVerification?.adapter || '-'} | ${r.teeVerification?.endorsementCount ?? '-'} | ${(r.teeVerification?.endorsedMSPIDs || []).join(',') || '-'} | ${r.teeVerification?.validatedWriteKey ? 'checked' : '-'} | ${f.opMatch ? 'Y' : 'N'}/${f.recordIdMatch ? 'Y' : 'N'}/${f.actorMatch ? 'Y' : 'N'}/${f.amountMatch ? 'Y' : 'N'} | ${r.pass ? 'PASS' : 'FAIL'} |\n`;
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
      const txId = invokeFabricChaincode(payload);
      caseResult.txId = txId;

      const captured = await waitForCapturedEvent(txId);
      const hxmsg = buildHXMsgFromFabricEvent({ deployment, ...captured });
      hxmsg._blockData = { signedBlockBytes: captured.signedBlockBytes || '' };
      caseResult.requestID = hxmsg.header.requestID;
      caseResult.srcHeight = hxmsg.srcHeight;
      caseResult.hmsgDigest = hxmsg.hmsgDigest;

      console.log(`  h-xmsg ${hxmsg.header.requestID}, block ${hxmsg.srcHeight}`);
      const relay = await relayHXMsg(hxmsg);
      caseResult.relayTxHash = relay.txHash;
      caseResult.gasUsed = relay.gasUsed;
      caseResult.teeVerification = relay.teeVerification;

      const targetState = await queryTargetState();
      const fieldCheck = {
        opMatch: targetState.lastOp === tc.expectedTargetFields.op,
        recordIdMatch: targetState.lastRecordId === tc.expectedTargetFields.recordId,
        actorMatch: targetState.lastActor === tc.expectedTargetFields.actor,
        amountMatch: targetState.lastAmount === tc.expectedTargetFields.amount,
      };
      caseResult.fieldCheck = fieldCheck;
      caseResult.actualTargetState = targetState;
      caseResult.totalMs = Date.now() - t0;
      caseResult.pass = Object.values(fieldCheck).every(Boolean)
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

  console.log(`FINAL ${pass}/${cases.length} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
