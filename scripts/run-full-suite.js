// Full round-trip E2E test suite: V3 dual independent verification
// Fabric → EVM → Fabric ACK (ECDSA threshold + TEE both paths)

const { execSync } = require('child_process');
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { readJSON, writeJSON, ensureRuntime } = require('../shared/utils');
const { buildXmsgFromFabricEventV3, buildXmsgFromEvmEventV3 } = require('../proof-builder/v3-proof-builder');

ensureRuntime();

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const TEST_DATA = path.join(__dirname, '..', 'test-data', 'fabric-real-cases.json');
const PAYLOAD_PATH = path.join(RUNTIME_DIR, 'test-payload.json');

const TEE_URL = 'http://127.0.0.1:9000';
const EVM_RPC = 'http://127.0.0.1:8545';
const PRIV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEPLOYMENT = readJSON('deployment.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function invokeFabricChaincode(payloadObj) {
  fs.writeFileSync(PAYLOAD_PATH, JSON.stringify(payloadObj));
  const cmd = `docker exec fabric-tools bash /fabric-network/fabric-network/scripts/invoke-xcall.sh --payload-file /fabric-network/runtime/test-payload.json 2>&1`;
  let output;
  try { output = execSync(cmd, { encoding: 'utf8', timeout: 20000, maxBuffer: 10*1024*1024 }); }
  catch (e) { output = (e.stdout || '') + '\n' + (e.stderr || ''); }
  const m = output.match(/txId[^a-f0-9]*([a-f0-9]{64})/i);
  return m ? m[1] : null;
}

async function buildForwardXmsg(txId) {
  const cp = path.join(RUNTIME_DIR, 'fabric-captured-event.json');
  const start = Date.now();
  while (Date.now() - start < 30000) {
    await sleep(500);
    if (!fs.existsSync(cp)) continue;
    const cap = fs.readJsonSync(cp);
    if (cap.txId === txId) {
      const xmsg = await buildXmsgFromFabricEventV3({ deployment: DEPLOYMENT, ...cap });
      xmsg._blockData = { signedBlockBytes: cap.signedBlockBytes || '' };
      return xmsg;
    }
  }
  throw new Error(`Timeout waiting for captured event ${txId}`);
}

async function relayForwardToV3(xmsg) {
  const teeResp = await axios.post(`${TEE_URL}/attest`, {
    xmsg, blsProof: null,
    blockData: xmsg._blockData || null,
  }, { timeout: 15000 });
  const att = teeResp.data;

  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet = new ethers.Wallet(PRIV_KEY, provider);
  const deployer = new ethers.NonceManager(wallet);

  const v3Abi = [
    'function registerTEE(address) external', 'function teeWhitelist(address) view returns (bool)',
    'function registerSignersBatch(address[],uint16) external', 'function registeredSigners(address) view returns (bool)',
    'function submit((uint8,uint8,uint8,uint16,bytes32,bytes32,bytes32,bytes32,address,bytes,bytes32,uint64,uint64),bytes[],bytes32,address,bytes32,bytes) external',
  ];
  const v3 = new ethers.Contract(DEPLOYMENT.verifierContractV3, v3Abi, deployer);

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
  return { txHash: receipt.hash, gasUsed: receipt.gasUsed.toString(), att };
}

async function buildAckXmsg(relayTxHash) {
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const receipt = await provider.getTransactionReceipt(relayTxHash);
  if (!receipt) throw new Error(`Receipt not found: ${relayTxHash}`);

  const targetInterface = new ethers.Interface([
    'event BusinessExecuted(bytes32 indexed requestID,address indexed caller,string op,string recordId,string actor,string amount,bool requireAck)'
  ]);
  const targetLog = receipt.logs.find(log => {
    if (ethers.getAddress(log.address) !== ethers.getAddress(DEPLOYMENT.targetContract)) return false;
    try { targetInterface.parseLog(log); return true; } catch (_) { return false; }
  });
  if (!targetLog) throw new Error(`BusinessExecuted log not found`);
  const parsed = targetInterface.parseLog(targetLog);
  if (!parsed.args.requireAck) return null;

  return await buildXmsgFromEvmEventV3({
    deployment: DEPLOYMENT,
    networkName: 'evm-localhost', emitterAddress: DEPLOYMENT.targetContract,
    eventName: 'BusinessExecuted',
    rawPayload: {
      op: 'ack_confirm', originRequestID: parsed.args.requestID,
      status: 'success', relayTxHash,
      targetOp: parsed.args.op, targetRecordId: parsed.args.recordId,
      targetActor: parsed.args.actor, targetAmount: parsed.args.amount,
      requireAck: false
    },
    txHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash,
    logIndex: Number(targetLog.index), nonce: Number(targetLog.index),
    dstChainName: 'fabric-mychannel', dstContract: ethers.ZeroAddress,
  });
}

async function relayAckToFabric(ackXmsg) {
  const ackPath = path.join(RUNTIME_DIR, 'latest-ack-xmsg.json');
  fs.writeJsonSync(ackPath, ackXmsg, { spaces: 2 });

  // Call ACK daemon via HTTP inside fabric-listener container
  const cmd = `docker exec fabric-listener node -e "const h=require('http');const d=require('fs').readFileSync('/app/runtime/latest-ack-xmsg.json','utf8');const r=h.request({hostname:'localhost',port:3009,path:'/relay-ack',method:'POST',headers:{'Content-Type':'application/json'}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>console.log(b));});r.write(d);r.end();" 2>&1`;

  try {
    const output = execSync(cmd, {
      encoding: 'utf8', timeout: 30000, maxBuffer: 1*1024*1024,
      env: { ...process.env, MSYS2_ARG_CONV_EXCL: '*' }
    });
    const match = output.match(/\{.*\}/s);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.ok) return { mode: 'ack-to-fabric', requestID: parsed.requestID, fabricResult: parsed.fabricResult };
      return { error: parsed.error || 'daemon error' };
    }
    return { error: 'unparseable response' };
  } catch (e) {
    return { error: (e.stdout || '').slice(0, 200) || e.message };
  }
}

async function queryTargetState() {
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const abi = [
    'function executionCount() view returns (uint256)', 'function lastOp() view returns (string)',
    'function lastRecordId() view returns (string)', 'function lastActor() view returns (string)',
    'function lastAmount() view returns (string)',
  ];
  const t = new ethers.Contract(DEPLOYMENT.targetContract, abi, provider);
  return {
    executionCount: (await t.executionCount()).toString(),
    lastOp: await t.lastOp(), lastRecordId: await t.lastRecordId(),
    lastActor: await t.lastActor(), lastAmount: await t.lastAmount(),
  };
}

async function main() {
  console.log('=== V3 Full Round-Trip E2E Test Suite ===\n');
  const testData = fs.readJsonSync(TEST_DATA);
  const cases = testData.cases;
  const results = []; let passCount = 0, failCount = 0;

  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i]; const caseId = tc.caseId;
    console.log(`[${i + 1}/${cases.length}] ${caseId}: ${tc.description}`);
    const caseResult = { caseId, description: tc.description, expectedTargetFields: tc.expectedTargetFields, pass: false };
    const tStart = Date.now();

    try {
      console.log('  [1/6] Invoking chaincode (requireAck=true)...');
      const payload = { ...tc.payload, requireAck: true };
      const txId = invokeFabricChaincode(payload);
      caseResult.txId = txId;

      console.log('  [2/6] Building V3 forward proof...');
      const xmsg = await buildForwardXmsg(txId);
      caseResult.requestID = xmsg.requestID; caseResult.srcHeight = xmsg.srcHeight;
      caseResult.forwardProofMeta = xmsg.proofMeta;

      console.log('  [3/6] Relaying Fabric → EVM (V3)...');
      const relayResult = await relayForwardToV3(xmsg);
      caseResult.relayTxHash = relayResult.txHash; caseResult.forwardGasUsed = relayResult.gasUsed;
      console.log(`  relayTxHash: ${relayResult.txHash}, gas: ${relayResult.gasUsed}`);

      console.log('  [4/6] Building ACK xmsg from EVM receipt...');
      const ackXmsg = await buildAckXmsg(relayResult.txHash);
      if (!ackXmsg) {
        caseResult.ackSkipped = true;
        console.log('  ACK skipped');
      } else {
        caseResult.ackRequestID = ackXmsg.requestID;
        caseResult.ackProofMeta = ackXmsg.proofMeta;

        console.log('  [5/6] Relaying ACK to Fabric...');
        const ackResult = await relayAckToFabric(ackXmsg);
        caseResult.ackFabricResult = ackResult;
        console.log(`  Fabric ACK: ${ackResult?.fabricResult || ackResult?.error || 'N/A'}`);
      }

      console.log('  [6/6] Verifying on-chain state...');
      const targetState = await queryTargetState();
      const f = {
        opMatch: targetState.lastOp === tc.expectedTargetFields.op,
        recordIdMatch: targetState.lastRecordId === tc.expectedTargetFields.recordId,
        actorMatch: targetState.lastActor === tc.expectedTargetFields.actor,
        amountMatch: targetState.lastAmount === tc.expectedTargetFields.amount,
      };
      caseResult.fieldCheck = f; caseResult.actualTargetState = targetState;
      const ackOk = caseResult.ackSkipped || (caseResult.ackFabricResult?.fabricResult?.includes('"ok":true'));
      caseResult.pass = Object.values(f).every(Boolean) && ackOk;
      caseResult.totalMs = Date.now() - tStart;

      console.log(`  EVM: op=${targetState.lastOp}, recordId=${targetState.lastRecordId}`);
      console.log(`  Fields: ${JSON.stringify(f)}, ACK: ${ackOk ? 'confirmed' : 'FAILED'}, time: ${caseResult.totalMs}ms`);
      console.log(caseResult.pass ? `  ✅ ${caseId} PASSED\n` : `  ❌ ${caseId} FAILED\n`);
      if (caseResult.pass) passCount++; else failCount++;

    } catch (error) {
      console.log(`  ❌ ${caseId} ERROR: ${error.message}\n`);
      caseResult.error = error.message; failCount++;
    }
    results.push(caseResult);

    writeJSON('fabric-full-roundtrip-results.json', {
      testType: 'full-roundtrip-e2e-v3', dataset: 'test-data/fabric-real-cases.json',
      testedAt: new Date().toISOString(), total: cases.length, pass: passCount, fail: failCount,
      caseIds: cases.map(c => c.caseId), results,
    });
    if (i < cases.length - 1) await sleep(2000);
  }

  console.log('='.repeat(60));
  console.log(`FINAL: ${passCount}/${cases.length} passed, ${failCount}/${cases.length} failed`);
  const { saveRoundtripSummary } = require('./save-summary');
  saveRoundtripSummary('fabric-full-roundtrip-results.json');
}

main().catch(err => { console.error('Suite error:', err.message || err); process.exit(1); });
