// E2E test runner: runs all 8 FABRIC test cases through the hybrid bridge
// Usage: node scripts/run-fabric-e2e-tests.js

const { execSync } = require('child_process');
const { ethers } = require('ethers');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { writeJSON } = require('../shared/utils');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const TEST_DATA = path.join(__dirname, '..', 'test-data', 'fabric-real-cases.json');
const XMSG_PATH = path.join(RUNTIME_DIR, 'latest-xmsg.json');
const PAYLOAD_PATH = path.join(RUNTIME_DIR, 'test-payload.json');
const DEPLOYMENT_PATH = path.join(RUNTIME_DIR, 'deployment.json');
const RESULTS_PATH = path.join(RUNTIME_DIR, 'fabric-hybrid-e2e-results.json');

const TEE_URL = 'http://127.0.0.1:9000';
const EVM_RPC = 'http://127.0.0.1:8545';
const PRIV_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function invokeFabricChaincode(payloadObj) {
  // Write payload to temp file (mounted in container at /fabric-network/runtime/test-payload.json)
  fs.writeFileSync(PAYLOAD_PATH, JSON.stringify(payloadObj));

  // Use the invoke script inside the container with --payload-file
  // Redirect stderr to stdout since Fabric peer writes output to stderr
  const cmd = `docker exec fabric-tools bash /fabric-network/fabric-network/scripts/invoke-xcall.sh --payload-file /fabric-network/runtime/test-payload.json 2>&1`;

  console.log('  Invoking Fabric chaincode...');
  let output;
  try {
    output = execSync(cmd, { encoding: 'utf8', timeout: 20000, maxBuffer: 10 * 1024 * 1024 });
  } catch (e) {
    // execSync also captures stderr when redirected with 2>&1
    output = (e.stdout || '') + '\n' + (e.stderr || '');
    if (!output.trim() && e.message) output = e.message;
  }
  console.log('  Invoke output:', output.slice(0, 300).replace(/\n/g, ' '));

  // Extract txId from output — it appears as: "txId\":\"<hex>\"
  const txMatch = output.match(/txId[^a-f0-9]*([a-f0-9]{64})/i);
  if (txMatch) {
    return txMatch[1];
  }
  return null;
}

async function waitForNewXmsg(expectedTxId, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(500);
    if (!fs.existsSync(XMSG_PATH)) continue;
    const xmsg = readJSON(XMSG_PATH);
    if (xmsg.txId === expectedTxId && xmsg.blsProof) {
      return xmsg;
    }
  }
  throw new Error(`Timeout waiting for xmsg with txId ${expectedTxId}`);
}

async function teeAttest(xmsg) {
  const resp = await axios.post(`${TEE_URL}/attest`, {
    xmsg,
    blsProof: xmsg.blsProof,
  }, { timeout: 15000 });
  return resp.data;
}

async function relayToEvm(xmsg, attestation) {
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet = new ethers.Wallet(PRIV_KEY, provider);
  const deployer = new ethers.NonceManager(wallet);

  const deployment = readJSON(DEPLOYMENT_PATH);
  const validatorSetIdBytes32 = ethers.keccak256(ethers.toUtf8Bytes(attestation.validatorSetId));

  const verifierV2Abi = [
    'function registerTEE(address tee) external',
    'function teeWhitelist(address tee) view returns (bool)',
    'function submit((uint8,bytes32,bytes32,bytes32,bytes32,address,bytes,bytes32,uint64,bytes,bytes,uint64),bytes32,bytes,address,bytes32) external',
    'function registerValidatorSet(bytes32,uint16,bytes[]) external',
    'function validatorSetExists(bytes32) view returns (bool)',
    'function ctr() view returns (uint64)',
  ];
  const verifier = new ethers.Contract(deployment.verifierContractV2, verifierV2Abi, deployer);

  // Register TEE if needed
  const teeReg = await verifier.teeWhitelist(attestation.teePubKey);
  if (!teeReg) {
    const tx = await verifier.registerTEE(attestation.teePubKey);
    await tx.wait();
  }

  // Register validator set if needed
  const vsetExists = await verifier.validatorSetExists(validatorSetIdBytes32);
  if (!vsetExists) {
    const pubkeys = xmsg.blsProof.validatorBlsPubkeys || [];
    const tx = await verifier.registerValidatorSet(
      validatorSetIdBytes32,
      xmsg.blsProof.threshold,
      pubkeys
    );
    await tx.wait();
  }

  // Submit
  const tx = await verifier.submit(
    [
      xmsg.version,
      xmsg.requestID,
      xmsg.srcChainID,
      xmsg.dstChainID,
      xmsg.srcEmitter,
      xmsg.dstContract,
      xmsg.payload,
      xmsg.payloadHash,
      xmsg.srcHeight,
      ethers.toUtf8Bytes(xmsg.eventProof),
      ethers.toUtf8Bytes(xmsg.finalityInfo),
      xmsg.nonce,
    ],
    attestation.reportHash,
    attestation.teeSig,
    attestation.teePubKey,
    validatorSetIdBytes32
  );
  const receipt = await tx.wait();
  return { txHash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString() };
}

async function queryTargetState() {
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const deployment = readJSON(DEPLOYMENT_PATH);

  const targetAbi = [
    'function executionCount() view returns (uint256)',
    'function historyCount() view returns (uint256)',
    'function lastRequestID() view returns (bytes32)',
    'function lastOp() view returns (string)',
    'function lastRecordId() view returns (string)',
    'function lastActor() view returns (string)',
    'function lastAmount() view returns (string)',
    'function lastPayloadHash() view returns (bytes32)',
  ];
  const target = new ethers.Contract(deployment.targetContract, targetAbi, provider);

  const [execCount, histCount, lastReq, lastOp, lastRecordId, lastActor, lastAmount, lastPayloadHash] =
    await Promise.all([
      target.executionCount(), target.historyCount(), target.lastRequestID(),
      target.lastOp(), target.lastRecordId(), target.lastActor(),
      target.lastAmount(), target.lastPayloadHash()
    ]);

  return {
    executionCount: execCount.toString(),
    historyCount: histCount.toString(),
    lastRequestID: lastReq,
    lastOp,
    lastRecordId,
    lastActor,
    lastAmount,
    lastPayloadHash,
  };
}

function checkFields(expected, actual) {
  return {
    opMatch: actual.lastOp === expected.op,
    recordIdMatch: actual.lastRecordId === expected.recordId,
    actorMatch: actual.lastActor === expected.actor,
    amountMatch: actual.lastAmount === expected.amount,
  };
}

async function main() {
  console.log('=== Fabric Hybrid Bridge E2E Test Runner ===\n');

  if (!fs.existsSync(TEST_DATA)) {
    console.error('Test data not found:', TEST_DATA);
    process.exit(1);
  }

  const testData = readJSON(TEST_DATA);
  const cases = testData.cases;
  console.log(`Loaded ${cases.length} test cases from ${TEST_DATA}\n`);

  const results = [];
  let passCount = 0;
  let failCount = 0;

  for (let i = 0; i < cases.length; i++) {
    const testCase = cases[i];
    const caseId = testCase.caseId;
    console.log(`[${i + 1}/${cases.length}] ${caseId}: ${testCase.description}`);
    console.log(`  Expected: op=${testCase.expectedTargetFields.op}, recordId=${testCase.expectedTargetFields.recordId}`);

    const caseResult = {
      caseId,
      description: testCase.description,
      dataset: 'test-data/fabric-real-cases.json',
      expectedTargetFields: testCase.expectedTargetFields,
      pass: false,
    };

    try {
      const tStart = Date.now();

      // Step 1: Invoke Fabric chaincode
      console.log('  [1/5] Invoking chaincode...');
      const payload = { ...testCase.payload, requireAck: false };
      const txId = invokeFabricChaincode(payload);

      if (!txId) {
        throw new Error('Failed to get txId from chaincode invoke');
      }
      caseResult.txId = txId;
      console.log(`  txId: ${txId}`);

      // Step 2: Wait for listener to capture event and build xmsg
      console.log('  [2/5] Waiting for listener to build xmsg...');
      const xmsg = await waitForNewXmsg(txId);
      caseResult.requestID = xmsg.requestID;
      caseResult.srcHeight = xmsg.srcHeight;
      caseResult.proofMeta = xmsg.proofMeta;
      console.log(`  requestID: ${xmsg.requestID}, srcHeight: ${xmsg.srcHeight}`);
      console.log(`  proofType: ${xmsg.proofMeta.proofType}, proofBuildMs: ${xmsg.proofMeta.proofBuildMs}`);

      // Step 3: TEE attestation
      console.log('  [3/5] Running TEE attestation...');
      const attestation = await teeAttest(xmsg);
      console.log(`  blsValid: ${attestation.teeReport.blsValid}, teePubKey: ${attestation.teePubKey}`);
      caseResult.teeAttestation = {
        teePubKey: attestation.teePubKey,
        reportHash: attestation.reportHash,
        blsValid: attestation.teeReport.blsValid,
        validatorSetId: attestation.validatorSetId,
      };

      // Step 4: Relay to EVM
      console.log('  [4/5] Relaying to EVM...');
      const relayResult = await relayToEvm(xmsg, attestation);
      caseResult.relayTxHash = relayResult.txHash;
      caseResult.gasUsed = relayResult.gasUsed;
      console.log(`  relayTxHash: ${relayResult.txHash}, gasUsed: ${relayResult.gasUsed}`);

      // Step 5: Verify on-chain state
      console.log('  [5/5] Verifying on-chain state...');
      const targetState = await queryTargetState();
      caseResult.actualTargetState = targetState;
      caseResult.fieldCheck = checkFields(testCase.expectedTargetFields, targetState);
      caseResult.pass = Object.values(caseResult.fieldCheck).every(Boolean);
      caseResult.totalMs = Date.now() - tStart;

      console.log(`  Target state: op=${targetState.lastOp}, recordId=${targetState.lastRecordId}`);
      console.log(`  Field checks: ${JSON.stringify(caseResult.fieldCheck)}`);

      if (caseResult.pass) {
        console.log(`  ✅ ${caseId} PASSED\n`);
        passCount++;
      } else {
        console.log(`  ❌ ${caseId} FAILED\n`);
        failCount++;
      }
    } catch (error) {
      console.log(`  ❌ ${caseId} ERROR: ${error.message}\n`);
      caseResult.error = error.message;
      failCount++;
    }

    results.push(caseResult);

    // Save incremental results
    const summary = {
      dataset: 'fabric-hybrid-e2e',
      testedAt: new Date().toISOString(),
      total: cases.length,
      pass: passCount,
      fail: failCount,
      caseIds: cases.map(c => c.caseId),
      results,
    };
    writeJSON('fabric-hybrid-e2e-results.json', summary);

    // Brief delay between cases to let Fabric settle
    if (i < cases.length - 1) {
      await sleep(3000);
    }
  }

  // Final summary
  console.log('='.repeat(60));
  console.log(`FINAL: ${passCount}/${cases.length} passed, ${failCount}/${cases.length} failed`);
  console.log(`Results saved to: ${RESULTS_PATH}`);

  // Generate formatted summary table
  const { saveForwardSummary } = require('./save-summary');
  saveForwardSummary('fabric-hybrid-e2e-results.json');

  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner error:', err.message || err);
  process.exit(1);
});
