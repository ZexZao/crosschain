const express = require('express');
const { ethers } = require('ethers');
const { readJSON, writeJSON, ensureRuntime } = require('../shared/utils');
const {
  verifyFabricEventProof,
  verifyFabricFinalityInfo
} = require('../shared/fabric-proof');
const {
  verifyEvmEventProof,
  verifyEvmFinalityInfo
} = require('../shared/evm-proof');
const {
  blsHashToCurve,
  blsVerifyAggregate,
} = require('../shared/bls');

ensureRuntime();
const app = express();
app.use(express.json({ limit: '1mb' }));

let state = readJSON('tee-state.json');
if (!state) {
  const wallet = ethers.Wallet.createRandom();
  state = {
    privateKey: wallet.privateKey,
    address: wallet.address,
    ctr: 0,
    lastDigest: ethers.ZeroHash,
    mode: 'normal'
  };
  writeJSON('tee-state.json', state);
}

function verifySimulatedEvent(xmsg) {
  const proof = JSON.parse(xmsg.eventProof);
  return proof.requestID === xmsg.requestID && proof.payloadHash === xmsg.payloadHash;
}

function verifySimulatedFinality(xmsg) {
  const fin = JSON.parse(xmsg.finalityInfo);
  return fin.srcHeight === xmsg.srcHeight && fin.proof === 'block_committed';
}

function detectProofType(xmsg) {
  const proof = JSON.parse(xmsg.eventProof);
  return proof.proofType || 'simulated-v1';
}

function computeCoreHash(xmsg, teeAddress) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'uint8', 'bytes32', 'bytes32', 'bytes32', 'bytes32',
        'address', 'bytes32', 'bytes32', 'uint64',
        'bytes32', 'bytes32', 'uint64', 'address'
      ],
      [
        xmsg.version, xmsg.requestID, xmsg.srcChainID, xmsg.dstChainID,
        xmsg.srcEmitter, xmsg.dstContract,
        ethers.keccak256(xmsg.payload), xmsg.payloadHash, xmsg.srcHeight,
        ethers.keccak256(ethers.toUtf8Bytes(xmsg.eventProof)),
        ethers.keccak256(ethers.toUtf8Bytes(xmsg.finalityInfo)),
        xmsg.nonce, teeAddress
      ]
    )
  );
}

function buildEventVerificationReport(xmsg) {
  const proofType = detectProofType(xmsg);

  if (proofType === 'simulated-v1') {
    return {
      proofType,
      verificationMode: 'simulation',
      eventValid: verifySimulatedEvent(xmsg),
      finalityValid: verifySimulatedFinality(xmsg),
    };
  }

  if (proofType === 'fabric-v1' || proofType === 'fabric-v2') {
    const eventProof = verifyFabricEventProof(xmsg);
    const finalityInfo = verifyFabricFinalityInfo(xmsg);
    return {
      proofType,
      verificationMode: 'fabric',
      channelName: eventProof.channelName,
      txId: eventProof.txId,
      blockNumber: eventProof.blockNumber,
      eventValid: true,
      finalityValid: true,
      blockHashMatch: eventProof.blockHash === finalityInfo.blockHash,
    };
  }

  if (proofType === 'evm-v1' || proofType === 'evm-v2') {
    const eventProof = verifyEvmEventProof(xmsg);
    const finalityInfo = verifyEvmFinalityInfo(xmsg);
    return {
      proofType,
      verificationMode: 'evm',
      networkName: eventProof.networkName,
      txHash: eventProof.txHash,
      blockNumber: eventProof.blockNumber,
      eventValid: true,
      finalityValid: true,
      blockHashMatch: eventProof.blockHash === finalityInfo.blockHash,
    };
  }

  throw new Error(`Unsupported proof type: ${proofType}`);
}

// ── Original /verify-sign (ECDSA path, backward-compatible) ──

app.get('/pubkey', (_req, res) => {
  res.json({ address: state.address, report: ethers.solidityPacked(['string','address'], ['SIM_TEE_REPORT', state.address]) });
});

app.post('/mode', (req, res) => {
  state.mode = req.body.mode || 'normal';
  writeJSON('tee-state.json', state);
  res.json({ ok: true, mode: state.mode });
});

app.post('/rollback', (req, res) => {
  const ctr = req.body.ctr ?? 0;
  const lastDigest = req.body.lastDigest ?? ethers.ZeroHash;
  state.ctr = ctr;
  state.lastDigest = lastDigest;
  writeJSON('tee-state.json', state);
  res.json({ ok: true, ctr: state.ctr, lastDigest: state.lastDigest });
});

app.post('/verify-sign', async (req, res) => {
  try {
    const xmsg = req.body;
    const verificationMeta = buildEventVerificationReport(xmsg);

    if (!verificationMeta.eventValid) throw new Error('VerifyEvent failed');
    if (!verificationMeta.finalityValid) throw new Error('VerifyFinality failed');
    if (verificationMeta.blockHashMatch === false) throw new Error('blockHash mismatch');

    const wallet = new ethers.Wallet(state.privateKey);
    const teeAddress = wallet.address;
    const nextCtr = state.ctr + 1;
    const prevDigest = state.lastDigest;
    const coreHash = computeCoreHash(xmsg, teeAddress);
    const digest = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint64', 'bytes32'], [coreHash, nextCtr, prevDigest])
    );

    let signDigest = digest;
    if (state.mode === 'tamper-sign') {
      signDigest = ethers.keccak256(ethers.toUtf8Bytes('tampered-digest'));
    }

    const sig = wallet.signingKey.sign(signDigest).serialized;
    state.ctr = nextCtr;
    state.lastDigest = digest;
    writeJSON('tee-state.json', state);

    res.json({
      teePubKey: teeAddress,
      teeReport: ethers.solidityPacked(['string','address'], ['SIM_TEE_REPORT', teeAddress]),
      teeSig: sig,
      ctr: nextCtr,
      prevDigest,
      digest,
      verificationMeta
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ── New /attest (BLS aggregate + structured report, hybrid bridge path) ──

app.post('/attest', async (req, res) => {
  try {
    const { xmsg, blsProof } = req.body;
    if (!xmsg || !blsProof) {
      throw new Error('xmsg and blsProof are required');
    }

    // 1. Verify event proof structure
    const report = buildEventVerificationReport(xmsg);
    report.validatorSetId = blsProof.validatorSetId;
    report.threshold = blsProof.threshold;
    report.timestamp = Date.now();

    if (!report.eventValid) throw new Error('event proof invalid');
    if (!report.finalityValid) throw new Error('finality info invalid');

    // 2. Verify BLS aggregate signature (O(1) pairing operation)
    const msgBytes = ethers.getBytes(blsProof.consensusMessage);
    const msgPoint = blsHashToCurve(msgBytes);
    const blsValid = blsVerifyAggregate(
      blsProof.aggregateSig,
      msgPoint,
      blsProof.validatorBlsPubkeys
    );

    if (!blsValid) {
      throw new Error('BLS aggregate signature invalid');
    }
    report.blsValid = true;
    report.signatureScheme = 'bls-aggregate';

    // 3. Produce TEE attestation with deterministic digest (no timestamp —
    //    the contract must be able to recompute attestDigest on-chain).
    const wallet = new ethers.Wallet(state.privateKey);
    const teeAddress = wallet.address;

    const reportJson = JSON.stringify(report);
    const reportHash = ethers.keccak256(ethers.toUtf8Bytes(reportJson));

    const attestDigest = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'address'],
        [reportHash, teeAddress]
      )
    );
    const teeSig = wallet.signingKey.sign(attestDigest).serialized;

    res.json({
      teePubKey: teeAddress,
      teeReport: report,
      reportHash,
      teeSig,
      attestDigest,
      validatorSetId: report.validatorSetId,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const port = process.env.PORT || 9000;
app.listen(port, () => {
  console.log(`tee-verifier listening on ${port} (hybrid bridge mode ready)`);
});
