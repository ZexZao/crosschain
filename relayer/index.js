const axios = require('axios');
const { ethers } = require('ethers');
const { readJSON, writeJSON, ensureRuntime } = require('../shared/utils');

async function main() {
  ensureRuntime();
  const deployment = readJSON('deployment.json');
  const xmsg = readJSON('latest-xmsg.json');
  if (!deployment || !xmsg) {
    throw new Error('Missing deployment.json or latest-xmsg.json');
  }

  const teeBase = process.env.TEE_URL || 'http://127.0.0.1:9000';
  const rpc = process.env.EVM_RPC || 'http://127.0.0.1:8545';
  const mode = process.argv[2] || 'normal';
  const proofType = xmsg.proofMeta?.proofType || 'fabric-v2';

  const provider = new ethers.JsonRpcProvider(rpc);
  const baseSigner = new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider
  );
  const deployer = new ethers.NonceManager(baseSigner);

  // ────────────────────────────────────────────
  // V3 Path: Dual Independent Verification
  // ────────────────────────────────────────────
  if (proofType === 'hybrid-v3') {
    if (!xmsg.v3Proof) throw new Error('hybrid-v3 xmsg missing v3Proof');

    // TEE attestation (Path B: structure verification)
    const teeResp = await axios.post(`${teeBase}/attest`, {
      xmsg,
      blsProof: xmsg.blsProof || null,
    }, { timeout: 10000 });
    const attestation = teeResp.data;

    const v3Abi = [
      'function registerTEE(address) external',
      'function teeWhitelist(address) view returns (bool)',
      'function registerSignersBatch(address[],uint16) external',
      'function registeredSigners(address) view returns (bool)',
      'function signerThreshold() view returns (uint16)',
      'function submit((uint8,bytes32,bytes32,bytes32,bytes32,address,bytes,bytes32,uint64,uint64),bytes[],bytes32,address,bytes32,bytes) external',
      'function consumed(bytes32) view returns (bool)',
      'function ctr() view returns (uint64)',
    ];
    const v3 = new ethers.Contract(deployment.verifierContractV3, v3Abi, deployer);

    // Register TEE if needed
    if (!(await v3.teeWhitelist(attestation.teePubKey))) {
      const tx = await v3.registerTEE(attestation.teePubKey);
      await tx.wait();
    }

    // Register signers if needed (first time only)
    if (!(await v3.registeredSigners(xmsg.v3Proof.signerAddresses[0]))) {
      const tx = await v3.registerSignersBatch(
        xmsg.v3Proof.signerAddresses,
        xmsg.v3Proof.threshold
      );
      await tx.wait();
    }

    // Submit with dual proofs: ECDSA signatures (Path A) + TEE attestation (Path B)
    const tx = await v3.submit(
      [
        xmsg.version, xmsg.requestID, xmsg.srcChainID, xmsg.dstChainID,
        xmsg.srcEmitter, xmsg.dstContract, xmsg.payload, xmsg.payloadHash,
        xmsg.srcHeight, xmsg.nonce,
      ],
      xmsg.v3Proof.signatures.map(s => s.signature),
      xmsg.v3Proof.consensusMessage,
      attestation.teePubKey,
      attestation.reportHash,
      attestation.teeSig,
    );
    const receipt = await tx.wait();

    const result = {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      proofType: 'hybrid-v3',
      requestID: xmsg.requestID,
      teePubKey: attestation.teePubKey,
      signerCount: xmsg.v3Proof.signerAddresses.length,
      threshold: xmsg.v3Proof.threshold,
    };
    writeJSON('last-relay-result.json', result);
    console.log(JSON.stringify(result, null, 2));
  }

  // ────────────────────────────────────────────
  // V2 Path: Hybrid Bridge (BLS + TEE)
  // ────────────────────────────────────────────
  else if (proofType === 'hybrid-v1') {
    if (!xmsg.blsProof) throw new Error('hybrid-v1 xmsg missing blsProof');

    const teeResp = await axios.post(`${teeBase}/attest`, {
      xmsg, blsProof: xmsg.blsProof,
    }, { timeout: 10000 });
    const attestation = teeResp.data;
    const vsIdBytes32 = ethers.keccak256(ethers.toUtf8Bytes(attestation.validatorSetId));

    const v2Abi = [
      'function registerTEE(address tee) external',
      'function teeWhitelist(address tee) view returns (bool)',
      'function submit((uint8,bytes32,bytes32,bytes32,bytes32,address,bytes,bytes32,uint64,bytes,bytes,uint64),bytes32,bytes,address,bytes32) external',
      'function registerValidatorSet(bytes32,uint16,bytes[]) external',
      'function validatorSetExists(bytes32) view returns (bool)',
    ];
    const v2 = new ethers.Contract(deployment.verifierContractV2 || deployment.verifierContract, v2Abi, deployer);

    if (!(await v2.teeWhitelist(attestation.teePubKey))) {
      const tx = await v2.registerTEE(attestation.teePubKey); await tx.wait();
    }
    if (!(await v2.validatorSetExists(vsIdBytes32))) {
      const pubkeys = xmsg.blsProof.validatorBlsPubkeys || [];
      const tx = await v2.registerValidatorSet(vsIdBytes32, xmsg.blsProof.threshold, pubkeys);
      await tx.wait();
    }

    const tx = await v2.submit(
      [xmsg.version, xmsg.requestID, xmsg.srcChainID, xmsg.dstChainID, xmsg.srcEmitter,
       xmsg.dstContract, xmsg.payload, xmsg.payloadHash, xmsg.srcHeight,
       ethers.toUtf8Bytes(xmsg.eventProof), ethers.toUtf8Bytes(xmsg.finalityInfo), xmsg.nonce],
      attestation.reportHash, attestation.teeSig, attestation.teePubKey, vsIdBytes32
    );
    const receipt = await tx.wait();

    const result = {
      txHash: receipt.hash, blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(), proofType: 'hybrid-v1',
      requestID: xmsg.requestID,
      teeReport: attestation.teeReport, reportHash: attestation.reportHash,
      validatorSetId: attestation.validatorSetId,
    };
    writeJSON('last-relay-result.json', result);
    console.log(JSON.stringify(result, null, 2));
  }

  // ────────────────────────────────────────────
  // Legacy V1 Path: ECDSA + TEE (backward compat)
  // ────────────────────────────────────────────
  else {
    const teeResp = await axios.post(`${teeBase}/verify-sign`, xmsg, { timeout: 10000 });
    const voucher = teeResp.data;
    let submitXMsg = { ...xmsg, teePubKey: voucher.teePubKey };
    if (mode === 'tamper') {
      submitXMsg.payload = ethers.hexlify(ethers.toUtf8Bytes('tampered-payload'));
    } else if (mode === 'forged') {
      submitXMsg.eventProof = JSON.stringify({ forged: true, requestID: xmsg.requestID, payloadHash: xmsg.payloadHash });
    }

    const v1Abi = [
      'function registerTEE(address tee) external',
      'function teeWhitelist(address tee) view returns (bool)',
      'function submit((uint8,bytes32,bytes32,bytes32,bytes32,address,bytes,bytes32,uint64,bytes,bytes,uint64,address),bytes,bytes,uint64,bytes32) external',
    ];
    const v1 = new ethers.Contract(deployment.verifierContract, v1Abi, deployer);

    if (!(await v1.teeWhitelist(voucher.teePubKey))) {
      const tx = await v1.registerTEE(voucher.teePubKey); await tx.wait();
    }

    const tx = await v1.submit(
      [submitXMsg.version, submitXMsg.requestID, submitXMsg.srcChainID, submitXMsg.dstChainID,
       submitXMsg.srcEmitter, submitXMsg.dstContract, submitXMsg.payload, submitXMsg.payloadHash,
       submitXMsg.srcHeight,
       ethers.toUtf8Bytes(submitXMsg.eventProof), ethers.toUtf8Bytes(submitXMsg.finalityInfo),
       submitXMsg.nonce, submitXMsg.teePubKey],
      voucher.teeReport, voucher.teeSig, voucher.ctr, voucher.prevDigest
    );
    const receipt = await tx.wait();

    const result = {
      txHash: receipt.hash, blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(), mode, requestID: submitXMsg.requestID,
      verificationMeta: voucher.verificationMeta || null
    };
    writeJSON('last-relay-result.json', result);
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((err) => {
  console.error(err.shortMessage || err.message || err);
  process.exit(1);
});
