// MPC-TSS E2E Test: single combined signature + TEE dual verification
const { execSync } = require('child_process');
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { writeJSON } = require('../shared/utils');
const { buildXmsgMpc } = require('../proof-builder/mpc-proof-builder');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const TEST_DATA = path.join(__dirname, '..', 'test-data', 'fabric-real-cases.json');
const PAYLOAD_PATH = path.join(RUNTIME_DIR, 'test-payload.json');
const TEE_URL = 'http://127.0.0.1:9000';
const EVM_RPC = 'http://127.0.0.1:8545';
const PRIV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function invokeFabric(payloadObj) {
  fs.writeFileSync(PAYLOAD_PATH, JSON.stringify(payloadObj));
  const cmd = `docker exec fabric-tools bash /fabric-network/fabric-network/scripts/invoke-xcall.sh --payload-file /fabric-network/runtime/test-payload.json 2>&1`;
  let out;
  try { out = execSync(cmd, { encoding: 'utf8', timeout: 20000, maxBuffer: 10*1024*1024 }); }
  catch (e) { out = (e.stdout || '') + '\n' + (e.stderr || ''); }
  const m = out.match(/txId[^a-f0-9]*([a-f0-9]{64})/i);
  return m ? m[1] : null;
}

async function waitForCapturedEvent(txId) {
  const p = path.join(RUNTIME_DIR, 'fabric-captured-event.json');
  const start = Date.now();
  while (Date.now() - start < 30000) {
    await sleep(500);
    if (!fs.existsSync(p)) continue;
    const cap = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (cap.txId === txId) return cap;
  }
  throw new Error(`Timeout waiting for captured event ${txId}`);
}

async function relayMpc(xmsg) {
  const teeResp = await axios.post(`${TEE_URL}/attest`, { xmsg, blsProof: null, blockData: xmsg._blockData || null }, { timeout: 15000 });
  const att = teeResp.data;

  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet = new ethers.Wallet(PRIV_KEY, provider);
  const deployer = new ethers.NonceManager(wallet);
  const deployment = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'deployment.json'), 'utf8'));

  const mpcAbi = [
    'function setSignerPubkey(address) external',
    'function signerPubkey() view returns (address)',
    'function registerTEE(address) external',
    'function teeWhitelist(address) view returns (bool)',
    'function submit((uint8,uint8,uint8,uint16,bytes32,bytes32,bytes32,bytes32,address,bytes,bytes32,uint64,uint64),bytes,bytes32,address,bytes32,bytes) external',
    'function consumed(bytes32) view returns (bool)',
    'function ctr() view returns (uint64)',
  ];
  const mpc = new ethers.Contract(deployment.verifierContractV3MPC, mpcAbi, deployer);

  if (!(await mpc.teeWhitelist(att.teePubKey))) {
    const tx = await mpc.registerTEE(att.teePubKey); await tx.wait();
  }
  const currentPubkey = await mpc.signerPubkey();
  if (currentPubkey === ethers.ZeroAddress) {
    const tx = await mpc.setSignerPubkey(xmsg.mpcProof.pubkey);
    await tx.wait();
  }

  const tx = await mpc.submit(
    [xmsg.version, xmsg.chainType ?? 0, xmsg.finalityModel ?? 0, xmsg.requiredConfirmations ?? 1,
     xmsg.requestID, xmsg.srcChainID, xmsg.dstChainID, xmsg.srcEmitter,
     xmsg.dstContract, xmsg.payload, xmsg.payloadHash, xmsg.srcHeight, xmsg.nonce],
    xmsg.mpcProof.signature,
    xmsg.mpcProof.consensusMessage,
    att.teePubKey, att.reportHash, att.teeSig
  );
  const receipt = await tx.wait();
  return { txHash: receipt.hash, gasUsed: receipt.gasUsed.toString() };
}

async function queryTarget() {
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const deployment = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'deployment.json'), 'utf8'));
  const abi = [
    'function executionCount() view returns (uint256)', 'function lastOp() view returns (string)',
    'function lastRecordId() view returns (string)', 'function lastActor() view returns (string)',
    'function lastAmount() view returns (string)',
  ];
  const t = new ethers.Contract(deployment.targetContract, abi, provider);
  return {
    executionCount: (await t.executionCount()).toString(),
    lastOp: await t.lastOp(), lastRecordId: await t.lastRecordId(),
    lastActor: await t.lastActor(), lastAmount: await t.lastAmount(),
  };
}

async function main() {
  console.log('=== MPC-TSS E2E Test Runner ===\n');
  const testData = JSON.parse(fs.readFileSync(TEST_DATA, 'utf8'));
  const cases = testData.cases;
  const results = []; let passCount = 0, failCount = 0;

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]; const caseId = tc.caseId;
    console.log(`[${i + 1}/${cases.length}] ${caseId}: ${tc.description}`);
    const caseResult = { caseId, description: tc.description, expectedTargetFields: tc.expectedTargetFields, pass: false };
    const tStart = Date.now();

    try {
      console.log('  [1/4] Invoking chaincode...');
      const payload = { ...tc.payload, requireAck: false };
      const txId = invokeFabric(payload);
      if (!txId) throw new Error('Failed to get txId');
      caseResult.txId = txId;

      console.log('  [2/4] Building MPC-TSS proof...');
      const captured = await waitForCapturedEvent(txId);
      const deployment = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'deployment.json'), 'utf8'));
      const xmsg = await buildXmsgMpc({ deployment, ...captured });
      xmsg._blockData = { signedBlockBytes: captured.signedBlockBytes || '' };
      caseResult.requestID = xmsg.requestID; caseResult.srcHeight = xmsg.srcHeight;
      caseResult.proofMeta = xmsg.proofMeta;
      console.log(`  proofType: ${xmsg.proofMeta.proofType}, signerCount: ${xmsg.proofMeta.signerCount}, ms: ${xmsg.proofMeta.proofBuildMs}`);

      console.log('  [3/4] Relaying (MPC-TSS single sig)...');
      const relayResult = await relayMpc(xmsg);
      caseResult.relayTxHash = relayResult.txHash; caseResult.gasUsed = relayResult.gasUsed;
      console.log(`  txHash: ${relayResult.txHash}, gas: ${relayResult.gasUsed}`);

      console.log('  [4/4] Verifying on-chain state...');
      const targetState = await queryTarget();
      const f = {
        opMatch: targetState.lastOp === tc.expectedTargetFields.op,
        recordIdMatch: targetState.lastRecordId === tc.expectedTargetFields.recordId,
        actorMatch: targetState.lastActor === tc.expectedTargetFields.actor,
        amountMatch: targetState.lastAmount === tc.expectedTargetFields.amount,
      };
      caseResult.fieldCheck = f; caseResult.actualTargetState = targetState;
      caseResult.pass = Object.values(f).every(Boolean);
      caseResult.totalMs = Date.now() - tStart;

      console.log(`  EVM: op=${targetState.lastOp}, recordId=${targetState.lastRecordId}, fields: ${JSON.stringify(f)}, time: ${caseResult.totalMs}ms`);
      console.log(caseResult.pass ? `  ✅ ${caseId} PASSED\n` : `  ❌ ${caseId} FAILED\n`);
      if (caseResult.pass) passCount++; else failCount++;
    } catch (error) {
      console.log(`  ❌ ${caseId} ERROR: ${error.message}\n`);
      caseResult.error = error.message; failCount++;
    }
    results.push(caseResult);

    writeJSON('mpc-e2e-results.json', {
      dataset: 'mpc-tss-e2e', testedAt: new Date().toISOString(),
      total: cases.length, pass: passCount, fail: failCount,
      caseIds: cases.map(c => c.caseId), results,
    });
    if (i < cases.length - 1) await sleep(2000);
  }

  console.log('='.repeat(60));
  console.log(`MPC-TSS FINAL: ${passCount}/${cases.length} passed`);

  // Generate formatted summary
  const summaryData = { results, total: cases.length, pass: passCount, fail: failCount };
  saveMpcSummary(summaryData);

  process.exit(failCount > 0 ? 1 : 0);
}

function saveMpcSummary(data) {
  const { results, total, pass } = data;
  let md = '# MPC-TSS 正向测试结果 (Fabric → EVM)\n\n';
  md += `**测试时间**：${new Date().toISOString()}\n`;
  md += `**通过率**：${pass}/${total} | **签名方案**：MPC-TSS (single ECDSA) | **合约**：VerifierContractV3MPC\n\n`;
  md += '| 用例 | 业务 | 金额 | Gas | 端到端时延 | 字段 | 状态 |\n';
  md += '|------|------|------|-----|------------|------|------|\n';
  let gs = 0, ts = 0;
  for (const r of results) {
    const g = parseInt(r.gasUsed) || 0; gs += g;
    const t = parseInt(r.totalMs) || 0; ts += t;
    const f = r.fieldCheck || {};
    md += `| ${r.caseId} | ${r.expectedTargetFields?.op||'-'} | ${r.expectedTargetFields?.amount||'-'} | ${g.toLocaleString()} | ${t}ms | ${f.opMatch?'✅':'❌'}/${f.recordIdMatch?'✅':'❌'}/${f.actorMatch?'✅':'❌'}/${f.amountMatch?'✅':'❌'} | ${r.pass?'✅':'❌'} |\n`;
  }
  const n = results.length || 1;
  md += `\n| **平均** | | | **${Math.round(gs/n).toLocaleString()}** | **${Math.round(ts/n)}ms** | **${pass}/${total}** | **${pass}/${total}** |\n`;
  fs.writeFileSync(path.join(RUNTIME_DIR, 'test-summary.md'), md);
  console.log(`\nFormatted summary: runtime/test-summary.md`);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
