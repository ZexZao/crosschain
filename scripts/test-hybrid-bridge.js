// End-to-end test: BLS aggregate + TEE /attest flow
// This tests the hybrid bridge verification pipeline without needing Docker/Fabric.

const { ethers } = require('ethers');
const {
  deriveBlsPrivateKey,
  getBlsPublicKey,
  blsHashToCurve,
  blsSignPoint,
  blsAggregateSignatures,
  blsVerifyAggregate,
} = require('../shared/bls');

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
  } catch (e) {
    console.log(`  FAIL: ${name} — ${e.message}`);
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

console.log('=== BLS Crypto Tests ===');

// 1. Key derivation is deterministic
const pk1a = getBlsPublicKey('test-label');
const pk1b = getBlsPublicKey('test-label');
assert(pk1a === pk1b, 'BLS key derivation not deterministic');
console.log('  PASS: Deterministic key derivation');

// 2. Different labels produce different keys
const pk2 = getBlsPublicKey('other-label');
assert(pk1a !== pk2, 'Different labels produce same key');
console.log('  PASS: Key uniqueness');

// 3. Sign and verify (single)
const privA = deriveBlsPrivateKey('alice');
const pubA = getBlsPublicKey('alice');
const msg = ethers.keccak256(ethers.toUtf8Bytes('hello consensus'));
const msgBytes = ethers.getBytes(msg);
const msgPoint = blsHashToCurve(msgBytes);
const sigA = blsSignPoint(msgPoint, privA);
const { bls12_381 } = require('@noble/curves/bls12-381.js');
const bls = bls12_381.shortSignatures;
const G2 = bls12_381.G2;
const singleValid = bls.verify(
  bls.Signature.fromHex(sigA),
  msgPoint,
  G2.Point.fromHex(pubA)
);
assert(singleValid, 'Single sig verify failed');
console.log('  PASS: Single sign/verify');

// 4. Aggregate 4 signatures, verify with verifyBatch
console.log('\n=== BLS Aggregate Tests ===');
const labels = ['val-1', 'val-2', 'val-3', 'val-4'];
const privKeys = labels.map(l => deriveBlsPrivateKey(l));
const pubKeys = labels.map(l => getBlsPublicKey(l));
const sigs = privKeys.map((priv) => blsSignPoint(msgPoint, priv));

const aggSig = blsAggregateSignatures(sigs);
assert(aggSig.length === 96, 'Aggregate sig should be 96 hex chars (48 bytes)');
console.log('  PASS: Aggregate signature is 48 bytes (96 hex)');

const batchValid = blsVerifyAggregate(aggSig, msgPoint, pubKeys);
assert(batchValid, 'Batch verify failed');
console.log('  PASS: Batch verify 4 validators');

// 5. Threshold (3 of 4)
const subAgg = blsAggregateSignatures(sigs.slice(0, 3));
const subValid = blsVerifyAggregate(subAgg, msgPoint, pubKeys.slice(0, 3));
assert(subValid, 'Threshold 3/4 verify failed');
console.log('  PASS: Threshold 3/4 verify');

// 6. Wrong message should fail
const wrongMsg = blsHashToCurve(ethers.getBytes(ethers.keccak256(ethers.toUtf8Bytes('wrong'))));
assert(!blsVerifyAggregate(aggSig, wrongMsg, pubKeys), 'Should reject wrong message');
console.log('  PASS: Reject wrong message');

// 7. Wrong pubkey should fail
const wrongPubs = [...pubKeys.slice(0, 3), getBlsPublicKey('intruder')];
assert(!blsVerifyAggregate(aggSig, msgPoint, wrongPubs), 'Should reject wrong pubkey');
console.log('  PASS: Reject wrong pubkey');

// 8. Empty/invalid signature
try {
  blsAggregateSignatures([]);
  console.log('  FAIL: Should reject empty sigs');
} catch (_) {
  console.log('  PASS: Reject empty signature array');
}

// 9. M of N threshold flexibility
console.log('\n=== Threshold Flexibility Tests ===');
for (const m of [1, 2, 3, 4]) {
  const subset = sigs.slice(0, m);
  const subPubs = pubKeys.slice(0, m);
  const agg = blsAggregateSignatures(subset);
  const ok = blsVerifyAggregate(agg, msgPoint, subPubs);
  assert(ok, `Threshold ${m}/4 failed`);
  console.log(`  PASS: Threshold ${m}/4 valid`);
}

// 10. Simulate the consensus aggregator flow
console.log('\n=== Simulated Consensus Aggregator Flow ===');
const consensusMsgHex = ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(
    ['string', 'uint64', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
    ['mychannel', 100, ethers.keccak256(ethers.toUtf8Bytes('block-hash')),
     ethers.keccak256(ethers.toUtf8Bytes('event-root')),
     ethers.keccak256(ethers.toUtf8Bytes('req-1')),
     ethers.keccak256(ethers.toUtf8Bytes('payload-hash')),
     ethers.keccak256(ethers.toUtf8Bytes('validator-set-hash'))]
  )
);
const consensusPoint = blsHashToCurve(ethers.getBytes(consensusMsgHex));
const allSigs = privKeys.map((priv) => blsSignPoint(consensusPoint, priv));
const finalAggSig = blsAggregateSignatures(allSigs);
const finalValid = blsVerifyAggregate(finalAggSig, consensusPoint, pubKeys);
assert(finalValid, 'Consensus aggregator flow failed');
console.log('  PASS: Consensus aggregator BLS flow');
console.log('  Aggregate sig:', finalAggSig.slice(0, 20) + '...');
console.log('  Consensus message:', consensusMsgHex.slice(0, 20) + '...');

// 11. TEE /attest request simulation
console.log('\n=== TEE Attestation Simulation ===');
const axios = require('axios');

async function runTeeAttestTest() {
  // Create a simulated xmsg
  const simulatedProof = {
    proofType: 'simulated-v1',
    requestID: ethers.keccak256(ethers.toUtf8Bytes('test-req-1')),
    payloadHash: ethers.keccak256(ethers.toUtf8Bytes('test-payload')),
  };
  const simulatedFinality = {
    srcHeight: 42,
    proof: 'block_committed',
  };

  const xmsg = {
    version: 1,
    requestID: simulatedProof.requestID,
    srcChainID: ethers.keccak256(ethers.toUtf8Bytes('fabric-mychannel')),
    dstChainID: ethers.keccak256(ethers.toUtf8Bytes('evm-31337')),
    srcEmitter: ethers.keccak256(ethers.toUtf8Bytes('xcall')),
    dstContract: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    payload: ethers.hexlify(ethers.toUtf8Bytes('test-payload')),
    payloadHash: simulatedProof.payloadHash,
    srcHeight: 42,
    eventProof: JSON.stringify(simulatedProof),
    finalityInfo: JSON.stringify(simulatedFinality),
    nonce: 1,
  };

  // Build BLS proof
  const blsProof = {
    validatorSetId: 'fabric-mychannel-v1',
    threshold: 3,
    aggregateSig: finalAggSig,
    validatorBlsPubkeys: pubKeys,
    consensusMessage: consensusMsgHex,
  };

  // Call TEE /attest
  try {
    const resp = await axios.post('http://127.0.0.1:9000/attest', {
      xmsg,
      blsProof,
    }, { timeout: 5000 });

    const data = resp.data;
    assert(data.teePubKey && data.teePubKey.startsWith('0x'), 'Missing teePubKey');
    assert(data.teeReport, 'Missing teeReport');
    assert(data.reportHash && data.reportHash.startsWith('0x'), 'Missing reportHash');
    assert(data.teeSig && data.teeSig.length > 128, 'Missing teeSig');
    assert(data.attestDigest && data.attestDigest.startsWith('0x'), 'Missing attestDigest');
    assert(data.validatorSetId === 'fabric-mychannel-v1', 'Wrong validatorSetId');

    // Verify TEE report contents
    const report = data.teeReport;
    assert(report.proofType === 'simulated-v1', 'Wrong proofType in report');
    assert(report.eventValid === true, 'eventValid should be true');
    assert(report.finalityValid === true, 'finalityValid should be true');
    assert(report.blsValid === true, 'blsValid should be true');
    assert(report.signatureScheme === 'bls-aggregate', 'Wrong signature scheme');
    assert(report.validatorSetId === 'fabric-mychannel-v1', 'Wrong validatorSetId in report');

    // Verify TEE signature
    const attestDigest = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'address'],
        [data.reportHash, data.teePubKey]
      )
    );
    const recovered = ethers.recoverAddress(attestDigest, data.teeSig);
    assert(recovered === data.teePubKey, 'TEE signature verification failed');

    console.log('  PASS: TEE /attest response structure');
    console.log('  PASS: TEE report field validation');
    console.log('  PASS: TEE signature verification');
    console.log('  PASS: attestDigest recomputation');

    // Verify reportHash
    const reportJson = JSON.stringify(report);
    const recomputedReportHash = ethers.keccak256(ethers.toUtf8Bytes(reportJson));
    assert(recomputedReportHash === data.reportHash, 'reportHash mismatch');
    console.log('  PASS: reportHash verification');

  } catch (e) {
    if (e.code === 'ECONNREFUSED') {
      console.log('  SKIP: TEE server not running (start with: node tee-verifier/server.js)');
    } else {
      console.log(`  FAIL: TEE attest test — ${e.message}`);
      if (e.response) console.log('  Response:', JSON.stringify(e.response.data));
    }
  }
}

// Run async tests
runTeeAttestTest().then(() => {
  console.log('\n=== All Tests Complete ===');
}).catch(e => {
  console.log('Test error:', e.message);
});
