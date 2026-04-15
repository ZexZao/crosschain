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

function verifyUpstreamProofs(xmsg) {
  const proofType = detectProofType(xmsg);
  if (proofType === 'simulated-v1') {
    if (!verifySimulatedEvent(xmsg)) {
      throw new Error('VerifyEvent failed');
    }
    if (!verifySimulatedFinality(xmsg)) {
      throw new Error('VerifyFinality failed');
    }
    return { proofType, verificationMode: 'simulation' };
  }

  if (proofType === 'fabric-v1' || proofType === 'fabric-v2') {
    const eventProof = verifyFabricEventProof(xmsg);
    const finalityInfo = verifyFabricFinalityInfo(xmsg);
    if (eventProof.blockHash !== finalityInfo.blockHash) {
      throw new Error('fabric proof/finality blockHash mismatch');
    }
    return {
      proofType,
      verificationMode: 'fabric',
      channelName: eventProof.channelName,
      chaincodeId: eventProof.chaincodeId,
      txId: eventProof.txId,
      blockNumber: eventProof.blockNumber,
      proofType: eventProof.proofType,
      validatorSetId: eventProof.consensusProof?.validatorSetId || null,
      threshold: eventProof.consensusProof?.threshold || null
    };
  }

  if (proofType === 'evm-v1' || proofType === 'evm-v2') {
    const eventProof = verifyEvmEventProof(xmsg);
    const finalityInfo = verifyEvmFinalityInfo(xmsg);
    if (eventProof.blockHash !== finalityInfo.blockHash) {
      throw new Error('evm proof/finality blockHash mismatch');
    }
    return {
      proofType,
      verificationMode: 'evm',
      networkName: eventProof.networkName,
      emitterAddress: eventProof.emitterAddress,
      txHash: eventProof.txHash,
      blockNumber: eventProof.blockNumber,
      validatorSetId: eventProof.consensusProof?.validatorSetId || null,
      threshold: eventProof.consensusProof?.threshold || null
    };
  }

  throw new Error(`Unsupported proof type: ${proofType}`);
}

function computeCoreHash(xmsg, teeAddress) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        'uint8',
        'bytes32',
        'bytes32',
        'bytes32',
        'bytes32',
        'address',
        'bytes32',
        'bytes32',
        'uint64',
        'bytes32',
        'bytes32',
        'uint64',
        'address'
      ],
      [
        xmsg.version,
        xmsg.requestID,
        xmsg.srcChainID,
        xmsg.dstChainID,
        xmsg.srcEmitter,
        xmsg.dstContract,
        ethers.keccak256(xmsg.payload),
        xmsg.payloadHash,
        xmsg.srcHeight,
        ethers.keccak256(ethers.toUtf8Bytes(xmsg.eventProof)),
        ethers.keccak256(ethers.toUtf8Bytes(xmsg.finalityInfo)),
        xmsg.nonce,
        teeAddress
      ]
    )
  );
}

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
    const verificationMeta = verifyUpstreamProofs(xmsg);

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

const port = process.env.PORT || 9000;
app.listen(port, () => {
  console.log(`tee-verifier listening on ${port}`);
});
