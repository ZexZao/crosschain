// V3 E2E Test: Dual Independent Verification (ECDSa threshold + TEE)
// VerifierContractV3 verifies BOTH paths independently on-chain.
// Usage: node scripts/run-v3-test.js

const { execSync } = require('child_process');
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { readJSON, writeJSON, ensureRuntime } = require('../shared/utils');
const { buildXmsgFromFabricEventV3 } = require('../proof-builder/v3-proof-builder');

ensureRuntime();

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const PAYLOAD_PATH = path.join(RUNTIME_DIR, 'test-payload.json');

const TEE_URL = 'http://127.0.0.1:9000';
const EVM_RPC = 'http://127.0.0.1:8545';
const PRIV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEPLOYMENT = readJSON('deployment.json');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function invokeFabric(payloadObj) {
  fs.writeFileSync(PAYLOAD_PATH, JSON.stringify(payloadObj));
  const cmd = `docker exec fabric-tools bash /fabric-network/fabric-network/scripts/invoke-xcall.sh --payload-file /fabric-network/runtime/test-payload.json 2>&1`;
  let output;
  try {
    output = execSync(cmd, { encoding: 'utf8', timeout: 20000, maxBuffer: 10*1024*1024, env: { ...process.env, MSYS2_ARG_CONV_EXCL: '*' } });
  } catch (e) { output = (e.stdout || '') + '\n' + (e.stderr || ''); }
  const m = output.match(/txId[^a-f0-9]*([a-f0-9]{64})/i);
  return m ? m[1] : null;
}

async function waitForListenerOutput(txId) {
  const p = path.join(RUNTIME_DIR, 'fabric-captured-event.json');
  const start = Date.now();
  while (Date.now() - start < 30000) {
    await sleep(500);
    if (!fs.existsSync(p)) continue;
    const cap = fs.readJsonSync(p);
    if (cap.txId === txId) return cap;
  }
  throw new Error('Timeout waiting for listener output');
}

async function relayToV3(xmsg) {
  // TEE attestation
  const teeResp = await axios.post(`${TEE_URL}/attest`, { xmsg, blsProof: null }, { timeout: 10000 });
  const att = teeResp.data;

  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet = new ethers.Wallet(PRIV_KEY, provider);
  const deployer = new ethers.NonceManager(wallet);

  const v3Abi = [
    'function registerTEE(address) external',
    'function teeWhitelist(address) view returns (bool)',
    'function registerSignersBatch(address[],uint16) external',
    'function registeredSigners(address) view returns (bool)',
    'function signerThreshold() view returns (uint16)',
    'function submit((uint8,bytes32,bytes32,bytes32,bytes32,address,bytes,bytes32,uint64,bytes,bytes,uint64),bytes[],bytes32,address,bytes32,bytes) external',
    'function consumed(bytes32) view returns (bool)',
    'function ctr() view returns (uint64)',
  ];
  const v3 = new ethers.Contract(DEPLOYMENT.verifierContractV3, v3Abi, deployer);

  if (!(await v3.teeWhitelist(att.teePubKey))) {
    const tx = await v3.registerTEE(att.teePubKey); await tx.wait();
  }
  if (!(await v3.registeredSigners(xmsg.v3Proof.signerAddresses[0]))) {
    const tx = await v3.registerSignersBatch(xmsg.v3Proof.signerAddresses, xmsg.v3Proof.threshold);
    await tx.wait();
  }

  const tx = await v3.submit(
    [xmsg.version, xmsg.requestID, xmsg.srcChainID, xmsg.dstChainID, xmsg.srcEmitter,
     xmsg.dstContract, xmsg.payload, xmsg.payloadHash, xmsg.srcHeight,
     ethers.toUtf8Bytes(xmsg.eventProof), ethers.toUtf8Bytes(xmsg.finalityInfo), xmsg.nonce],
    xmsg.v3Proof.signatures.map(s => s.signature),
    xmsg.v3Proof.consensusMessage,
    att.teePubKey, att.reportHash, att.teeSig,
  );
  const receipt = await tx.wait();
  return { txHash: receipt.hash, gasUsed: receipt.gasUsed.toString(), att };
}

async function queryTarget() {
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
  console.log('=== V3 Dual Independent Verification Test ===\n');

  // Test case
  const testCase = {
    op: 'v3_test', recordId: 'V3-001', actor: 'v3-user', amount: '500', requireAck: false
  };

  const t0 = Date.now();

  // Step 1: Invoke Fabric
  console.log('[1/5] Invoking Fabric chaincode...');
  const txId = invokeFabric(testCase);
  console.log('  txId:', txId);

  // Step 2: Wait for listener to capture event
  console.log('[2/5] Waiting for Fabric event...');
  const captured = await waitForListenerOutput(txId);
  console.log('  Captured, blockNumber:', captured.blockNumber);

  // Step 3: Build V3 proof (ECDSA signatures from validators)
  console.log('[3/5] Building V3 proof (ECDSA threshold signatures)...');
  const xmsg = await buildXmsgFromFabricEventV3({ deployment: DEPLOYMENT, ...captured });
  console.log('  proofType:', xmsg.proofMeta.proofType);
  console.log('  signatures:', xmsg.v3Proof.signatures.length, '/ threshold:', xmsg.v3Proof.threshold);
  console.log('  proofBuildMs:', xmsg.proofMeta.proofBuildMs);

  // Save for relayer to read (use unique name to avoid listener overwrite)
  writeJSON('latest-xmsg-v3.json', xmsg);

  // Step 4: Relay to VerifierContractV3 (use in-memory xmsg, not file)
  console.log('[4/5] Relaying to VerifierContractV3...');
  const relayResult = await relayToV3(xmsg);
  console.log('  relayTxHash:', relayResult.txHash);
  console.log('  gasUsed:', relayResult.gasUsed);

  // Step 5: Verify on-chain state
  console.log('[5/5] Verifying on-chain state...');
  const targetState = await queryTarget();
  console.log('  lastOp:', targetState.lastOp);
  console.log('  lastRecordId:', targetState.lastRecordId);
  console.log('  lastAmount:', targetState.lastAmount);

  const pass = targetState.lastOp === 'v3_test'
    && targetState.lastRecordId === 'V3-001'
    && targetState.lastAmount === '500';

  const totalMs = Date.now() - t0;
  console.log('\n' + '='.repeat(60));
  console.log(pass ? '✅ V3 Test PASSED' : '❌ V3 Test FAILED');
  console.log('Total time:', totalMs + 'ms');
  console.log('Proof type: hybrid-v3 (ECDSA threshold + TEE dual independent)');
  console.log('Signer path:', xmsg.v3Proof.signatures.length + '/' + xmsg.v3Proof.threshold + ' ECDSA verified on-chain');
  console.log('TEE path: ecrecover(attestDigest) verified on-chain');
  console.log('Contract:', DEPLOYMENT.verifierContractV3);

  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error(e.message || e); process.exit(1); });
