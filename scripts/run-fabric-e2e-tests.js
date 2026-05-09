// E2E test runner: V3 dual independent verification (ECDSA threshold + TEE)
// Usage: node scripts/run-fabric-e2e-tests.js

const { execSync } = require('child_process');
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { writeJSON } = require('../shared/utils');
const { buildXmsgFromFabricEventV3 } = require('../proof-builder/v3-proof-builder');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const TEST_DATA = path.join(__dirname, '..', 'test-data', 'fabric-real-cases.json');
const PAYLOAD_PATH = path.join(RUNTIME_DIR, 'test-payload.json');
const RESULTS_PATH = path.join(RUNTIME_DIR, 'fabric-hybrid-e2e-results.json');

const TEE_URL = 'http://127.0.0.1:9000';
const EVM_RPC = 'http://127.0.0.1:8545';
const PRIV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function invokeFabricChaincode(payloadObj) {
  fs.writeFileSync(PAYLOAD_PATH, JSON.stringify(payloadObj));
  const cmd = `docker exec fabric-tools bash /fabric-network/fabric-network/scripts/invoke-xcall.sh --payload-file /fabric-network/runtime/test-payload.json 2>&1`;
  let output;
  try { output = execSync(cmd, { encoding: 'utf8', timeout: 20000, maxBuffer: 10*1024*1024 }); }
  catch (e) { output = (e.stdout || '') + '\n' + (e.stderr || ''); }
  const txMatch = output.match(/txId[^a-f0-9]*([a-f0-9]{64})/i);
  return txMatch ? txMatch[1] : null;
}

async function buildV3Xmsg(txId) {
  const capturedPath = path.join(RUNTIME_DIR, 'fabric-captured-event.json');
  const start = Date.now();
  while (Date.now() - start < 30000) {
    await sleep(500);
    if (!fs.existsSync(capturedPath)) continue;
    const cap = JSON.parse(fs.readFileSync(capturedPath, 'utf8'));
    if (cap.txId === txId) {
      const deployment = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'deployment.json'), 'utf8'));
      const xmsg = await buildXmsgFromFabricEventV3({ deployment, ...cap });
      // Attach block data for TEE local verification
      xmsg._blockData = { signedBlockBytes: cap.signedBlockBytes || '' };
      return xmsg;
    }
  }
  throw new Error(`Timeout waiting for captured event ${txId}`);
}

async function relayToV3(xmsg) {
  const teeResp = await axios.post(`${TEE_URL}/attest`, {
    xmsg,
    blsProof: null,
    blockData: xmsg._blockData || null,
  }, { timeout: 15000 });
  const att = teeResp.data;

  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet = new ethers.Wallet(PRIV_KEY, provider);
  const deployer = new ethers.NonceManager(wallet);
  const deployment = JSON.parse(fs.readFileSync(path.join(RUNTIME_DIR, 'deployment.json'), 'utf8'));

  const v3Abi = [
    'function registerTEE(address) external', 'function teeWhitelist(address) view returns (bool)',
    'function registerSignersBatch(address[],uint16) external', 'function registeredSigners(address) view returns (bool)',
    'function submit((uint8,uint8,uint8,uint16,bytes32,bytes32,bytes32,bytes32,address,bytes,bytes32,uint64,uint64),bytes[],bytes32,address,bytes32,bytes) external',
  ];
  const v3 = new ethers.Contract(deployment.verifierContractV3, v3Abi, deployer);

  if (!(await v3.teeWhitelist(att.teePubKey))) { const tx = await v3.registerTEE(att.teePubKey); await tx.wait(); }
  if (!(await v3.registeredSigners(xmsg.v3Proof.signerAddresses[0]))) {
    const tx = await v3.registerSignersBatch(xmsg.v3Proof.signerAddresses, xmsg.v3Proof.threshold);
    await tx.wait();
  }

  const tx = await v3.submit(
    [xmsg.version, xmsg.chainType ?? 0, xmsg.finalityModel ?? 0, xmsg.requiredConfirmations ?? 1, xmsg.requestID, xmsg.srcChainID, xmsg.dstChainID, xmsg.srcEmitter,
     xmsg.dstContract, xmsg.payload, xmsg.payloadHash, xmsg.srcHeight, xmsg.nonce],
    xmsg.v3Proof.signatures.map(s => s.signature),
    xmsg.v3Proof.consensusMessage,
    att.teePubKey, att.reportHash, att.teeSig
  );
  const receipt = await tx.wait();
  return { txHash: receipt.hash, gasUsed: receipt.gasUsed.toString() };
}

async function queryTargetState() {
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
  console.log('=== V3 Dual Independent Verification E2E Test Runner ===\n');
  const testData = JSON.parse(fs.readFileSync(TEST_DATA, 'utf8'));
  const cases = testData.cases;
  console.log(`Loaded ${cases.length} test cases\n`);

  const results = []; let passCount = 0, failCount = 0;

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]; const caseId = tc.caseId;
    console.log(`[${i + 1}/${cases.length}] ${caseId}: ${tc.description}`);
    const caseResult = { caseId, description: tc.description, expectedTargetFields: tc.expectedTargetFields, pass: false };
    const tStart = Date.now();

    try {
      console.log('  [1/4] Invoking chaincode...');
      const payload = { ...tc.payload, requireAck: false };
      const txId = invokeFabricChaincode(payload);
      if (!txId) throw new Error('Failed to get txId');
      caseResult.txId = txId;

      console.log('  [2/4] Building V3 proof (ECDSA threshold + TEE)...');
      const xmsg = await buildV3Xmsg(txId);
      caseResult.requestID = xmsg.requestID; caseResult.srcHeight = xmsg.srcHeight;
      caseResult.proofMeta = xmsg.proofMeta;
      console.log(`  proofType: ${xmsg.proofMeta.proofType}, sigs: ${xmsg.v3Proof.signatures.length}/${xmsg.v3Proof.threshold}, buildMs: ${xmsg.proofMeta.proofBuildMs}`);

      console.log('  [3/4] Relaying to VerifierContractV3...');
      const relayResult = await relayToV3(xmsg);
      caseResult.relayTxHash = relayResult.txHash; caseResult.gasUsed = relayResult.gasUsed;
      console.log(`  txHash: ${relayResult.txHash}, gas: ${relayResult.gasUsed}`);

      console.log('  [4/4] Verifying on-chain state...');
      const targetState = await queryTargetState();
      const f = {
        opMatch: targetState.lastOp === tc.expectedTargetFields.op,
        recordIdMatch: targetState.lastRecordId === tc.expectedTargetFields.recordId,
        actorMatch: targetState.lastActor === tc.expectedTargetFields.actor,
        amountMatch: targetState.lastAmount === tc.expectedTargetFields.amount,
      };
      caseResult.fieldCheck = f; caseResult.actualTargetState = targetState;
      caseResult.pass = Object.values(f).every(Boolean);
      caseResult.totalMs = Date.now() - tStart;

      console.log(`  EVM: op=${targetState.lastOp}, recordId=${targetState.lastRecordId}`);
      console.log(`  Fields: ${JSON.stringify(f)}, time: ${caseResult.totalMs}ms`);
      console.log(caseResult.pass ? `  ✅ ${caseId} PASSED\n` : `  ❌ ${caseId} FAILED\n`);
      if (caseResult.pass) passCount++; else failCount++;
    } catch (error) {
      console.log(`  ❌ ${caseId} ERROR: ${error.message}\n`);
      caseResult.error = error.message; failCount++;
    }
    results.push(caseResult);

    writeJSON('fabric-hybrid-e2e-results.json', {
      dataset: 'fabric-hybrid-e2e', testedAt: new Date().toISOString(),
      total: cases.length, pass: passCount, fail: failCount,
      caseIds: cases.map(c => c.caseId), results,
    });
    if (i < cases.length - 1) await sleep(2000);
  }

  console.log('='.repeat(60));
  console.log(`FINAL: ${passCount}/${cases.length} passed, ${failCount}/${cases.length} failed`);
  const { saveForwardSummary } = require('./save-summary');
  saveForwardSummary('fabric-hybrid-e2e-results.json');
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
