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

// ============ Source Chain Independent Verification ============

async function independentFabricVerification({ txId, channelName, blockNumber }) {
  const { Gateway, Wallets } = require('fabric-network');
  const fs = require('fs-extra');
  const path = require('path');
  const { common } = require('fabric-protos');

  const projectRoot = '/app';
  const profilePath = process.env.FABRIC_CONNECTION_PROFILE ||
    path.join(projectRoot, 'fabric-network', 'connection-org1.docker.json');
  const walletPath = process.env.FABRIC_WALLET_PATH ||
    path.join(projectRoot, 'fabric-network', 'wallet');
  const identity = process.env.FABRIC_IDENTITY || 'appUser';
  const chName = channelName || 'mychannel';

  const ccp = fs.readJsonSync(profilePath);
  const wallet = await Wallets.newFileSystemWallet(walletPath);
  const gateway = new Gateway();
  await gateway.connect(ccp, { wallet, identity, discovery: { enabled: false, asLocalhost: false } });

  try {
    const network = await gateway.getNetwork(chName);
    const qscc = network.getContract('qscc');

    let blockBytes;
    try {
      blockBytes = await qscc.evaluateTransaction('GetBlockByTxID', chName, txId);
    } catch (qsccErr) {
      return { sourceVerified: false,
        reason: `Transaction ${txId.slice(0,16)}... not found in Fabric: ${qsccErr.message?.slice(0,80)}` };
    }

    if (!blockBytes || blockBytes.length === 0) {
      return { sourceVerified: false, reason: `Transaction ${txId} not found` };
    }

    const block = common.Block.decode(blockBytes);
    const realBlockNumber = Number(block.header.number);

    if (realBlockNumber !== Number(blockNumber)) {
      return { sourceVerified: false,
        reason: `Block number mismatch: expected=${blockNumber}, fabric=${realBlockNumber}` };
    }

    return { sourceVerified: true, fabricBlockNumber: realBlockNumber, fabricTxId: txId };
  } finally {
    gateway.disconnect();
  }
}

async function independentEvmVerification({ txHash, blockNumber }) {
  const rpcUrl = process.env.EVM_RPC || 'http://evm-node:8545';
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    return { sourceVerified: false, reason: `Transaction ${txHash} not found on EVM` };
  }
  if (Number(receipt.blockNumber) !== Number(blockNumber)) {
    return { sourceVerified: false,
      reason: `Block number mismatch: expected=${blockNumber}, evm=${receipt.blockNumber}` };
  }
  const block = await provider.getBlock(Number(blockNumber));
  if (!block) {
    return { sourceVerified: false, reason: `Block ${blockNumber} not found` };
  }

  return { sourceVerified: true, evmBlockNumber: block.number, txHash };
}

// ============ Report Building ============

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
      ['uint8', 'bytes32', 'bytes32', 'bytes32', 'bytes32',
       'address', 'bytes32', 'bytes32', 'uint64',
       'bytes32', 'bytes32', 'uint64', 'address'],
      [xmsg.version, xmsg.requestID, xmsg.srcChainID, xmsg.dstChainID,
       xmsg.srcEmitter, xmsg.dstContract,
       ethers.keccak256(xmsg.payload), xmsg.payloadHash, xmsg.srcHeight,
       ethers.keccak256(ethers.toUtf8Bytes(xmsg.eventProof)),
       ethers.keccak256(ethers.toUtf8Bytes(xmsg.finalityInfo)),
       xmsg.nonce, teeAddress]
    )
  );
}

function buildEventVerificationReport(xmsg) {
  const proofType = detectProofType(xmsg);

  if (proofType === 'simulated-v1') {
    return {
      proofType, verificationMode: 'simulation',
      eventValid: verifySimulatedEvent(xmsg),
      finalityValid: verifySimulatedFinality(xmsg),
    };
  }

  if (proofType === 'fabric-v1' || proofType === 'fabric-v2') {
    const eventProof = verifyFabricEventProof(xmsg);
    const finalityInfo = verifyFabricFinalityInfo(xmsg);
    return {
      proofType, verificationMode: 'fabric',
      channelName: eventProof.channelName,
      txId: eventProof.txId,
      blockNumber: eventProof.blockNumber,
      eventValid: true, finalityValid: true,
      blockHashMatch: eventProof.blockHash === finalityInfo.blockHash,
    };
  }

  if (proofType === 'evm-v1' || proofType === 'evm-v2') {
    const eventProof = verifyEvmEventProof(xmsg);
    const finalityInfo = verifyEvmFinalityInfo(xmsg);
    return {
      proofType, verificationMode: 'evm',
      networkName: eventProof.networkName,
      txHash: eventProof.txHash,
      blockNumber: eventProof.blockNumber,
      eventValid: true, finalityValid: true,
      blockHashMatch: eventProof.blockHash === finalityInfo.blockHash,
    };
  }

  throw new Error(`Unsupported proof type: ${proofType}`);
}

// ============ Routes ============

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
    const sig = wallet.signingKey.sign(digest).serialized;
    state.ctr = nextCtr;
    state.lastDigest = digest;
    writeJSON('tee-state.json', state);

    res.json({
      teePubKey: teeAddress,
      teeReport: ethers.solidityPacked(['string','address'], ['SIM_TEE_REPORT', teeAddress]),
      teeSig: sig, ctr: nextCtr, prevDigest, digest, verificationMeta
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============ /attest: 独立源链验证 (无 eventProof) ============

app.post('/attest', async (req, res) => {
  try {
    const { xmsg } = req.body;
    if (!xmsg) throw new Error('xmsg is required');

    // 1. Detect source chain type
    // Fabric txId: 64 hex chars without 0x. EVM txHash: 0x + 64 hex chars
    const isFabric = xmsg.txId && !xmsg.txId.startsWith('0x');
    const isEvm = xmsg.txId && xmsg.txId.startsWith('0x');

    // 2. Independent source chain verification
    let sourceCheck;
    if (isFabric) {
      console.log('[attest] Independently verifying Fabric transaction:', xmsg.txId);
      const channelName = process.env.FABRIC_CHANNEL || 'mychannel';
      sourceCheck = await independentFabricVerification({
        txId: xmsg.txId,
        channelName,
        blockNumber: xmsg.srcHeight,
      });
    } else if (isEvm) {
      console.log('[attest] Independently verifying EVM transaction:', xmsg.txId);
      sourceCheck = await independentEvmVerification({
        txHash: xmsg.txId,
        blockNumber: xmsg.srcHeight,
      });
    } else {
      throw new Error(`Unknown chain type: ${chainName}`);
    }

    if (!sourceCheck.sourceVerified) {
      throw new Error(`Independent source chain verification failed: ${sourceCheck.reason}`);
    }

    // 3. Build verification report
    const proofData = xmsg.v3Proof || xmsg.blsProof;
    const report = {
      proofType: 'hybrid-v3',
      verificationMode: isFabric ? 'fabric' : 'evm',
      sourceVerified: true,
      txId: xmsg.txId,
      blockNumber: sourceCheck.fabricBlockNumber || sourceCheck.evmBlockNumber,
      payloadHash: xmsg.payloadHash,
      signatureScheme: proofData?.signatureScheme || (xmsg.v3Proof ? 'ecdsa-threshold-v3' : 'bls-aggregate'),
    };
    if (proofData) {
      report.validatorSetId = proofData.validatorSetId;
      report.threshold = proofData.threshold;
    }
    if (xmsg.v3Proof) report.signerCount = xmsg.v3Proof.signatures.length;

    // 4. Produce TEE attestation
    const wallet = new ethers.Wallet(state.privateKey);
    const teeAddress = wallet.address;
    const reportJson = JSON.stringify(report);
    const reportHash = ethers.keccak256(ethers.toUtf8Bytes(reportJson));
    const attestDigest = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(['bytes32', 'address'], [reportHash, teeAddress])
    );
    const teeSig = wallet.signingKey.sign(attestDigest).serialized;

    console.log('[attest] Independent verification passed:', {
      mode: report.verificationMode,
      sourceVerified: true,
      txId: xmsg.txId?.slice(0, 16) + '...',
    });

    res.json({
      teePubKey: teeAddress,
      teeReport: report,
      reportHash,
      teeSig,
      attestDigest,
      validatorSetId: report.validatorSetId,
    });
  } catch (error) {
    console.error('[attest] Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const port = process.env.PORT || 9000;
app.listen(port, () => {
  console.log(`tee-verifier listening on ${port} (independent source verification enabled)`);
});
