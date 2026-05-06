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

  // Determine which path to use based on proof type
  const proofType = xmsg.proofMeta?.proofType || 'fabric-v2';
  const useHybridPath = proofType === 'hybrid-v1';

  const provider = new ethers.JsonRpcProvider(rpc);
  const baseSigner = new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    provider
  );
  const deployer = new ethers.NonceManager(baseSigner);

  if (useHybridPath) {
    // ── Hybrid bridge path: /attest → VerifierContractV2 ──
    if (!xmsg.blsProof) {
      throw new Error('hybrid-v1 xmsg missing blsProof');
    }

    const teeResp = await axios.post(`${teeBase}/attest`, {
      xmsg,
      blsProof: xmsg.blsProof,
    }, { timeout: 10000 });
    const attestation = teeResp.data;

    // Convert string validatorSetId to bytes32 for on-chain storage
    const validatorSetIdBytes32 = ethers.keccak256(ethers.toUtf8Bytes(attestation.validatorSetId));

    const verifierV2Abi = [
      'function registerTEE(address tee) external',
      'function teeWhitelist(address tee) view returns (bool)',
      'function submit((uint8,bytes32,bytes32,bytes32,bytes32,address,bytes,bytes32,uint64,bytes,bytes,uint64),bytes32,bytes,address,bytes32) external',
      'function consumed(bytes32) view returns (bool)',
      'function ctr() view returns (uint64)',
      'function lastDigest() view returns (bytes32)',
      'function registerValidatorSet(bytes32,uint16,bytes[]) external',
      'function validatorSets(bytes32) view returns (bytes32,uint16,bytes32,bool)',
      'function validatorSetExists(bytes32) view returns (bool)',
    ];
    const verifier = new ethers.Contract(deployment.verifierContractV2 || deployment.verifierContract, verifierV2Abi, deployer);

    // Register TEE if needed
    if (!(await verifier.teeWhitelist(attestation.teePubKey))) {
      const regTx = await verifier.registerTEE(attestation.teePubKey);
      await regTx.wait();
    }

    // Register validator set on-chain if not already present
    try {
      const vsetExists = await verifier.validatorSetExists(validatorSetIdBytes32);
      if (!vsetExists) {
        const pubkeys = xmsg.blsProof.validatorBlsPubkeys || [];
        const regVSetTx = await verifier.registerValidatorSet(
          validatorSetIdBytes32,
          xmsg.blsProof.threshold,
          pubkeys
        );
        await regVSetTx.wait();
      }
    } catch (_) {
      // Validator set may already exist or registration not needed
    }

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

    const result = {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      mode,
      proofType: 'hybrid-v1',
      requestID: xmsg.requestID,
      teeReport: attestation.teeReport,
      reportHash: attestation.reportHash,
      validatorSetId: attestation.validatorSetId,
    };
    writeJSON('last-relay-result.json', result);
    console.log(JSON.stringify(result, null, 2));
  } else {
    // ── Legacy path: /verify-sign → VerifierContract (V1) ──
    const teeResp = await axios.post(`${teeBase}/verify-sign`, xmsg, { timeout: 10000 });
    const voucher = teeResp.data;

    const verifierAbi = [
      'function registerTEE(address tee) external',
      'function teeWhitelist(address tee) view returns (bool)',
      'function submit((uint8,bytes32,bytes32,bytes32,bytes32,address,bytes,bytes32,uint64,bytes,bytes,uint64,address),bytes,bytes,uint64,bytes32) external',
      'function consumed(bytes32) view returns (bool)',
      'function lastCtr() view returns (uint64)',
      'function lastDigest() view returns (bytes32)'
    ];
    const verifier = new ethers.Contract(deployment.verifierContract, verifierAbi, deployer);

    let submitXMsg = { ...xmsg, teePubKey: voucher.teePubKey };
    if (mode === 'tamper') {
      submitXMsg.payload = ethers.hexlify(ethers.toUtf8Bytes('tampered-payload'));
    } else if (mode === 'forged') {
      submitXMsg.eventProof = JSON.stringify({ forged: true, requestID: xmsg.requestID, payloadHash: xmsg.payloadHash });
    }

    if (!(await verifier.teeWhitelist(voucher.teePubKey))) {
      const regTx = await verifier.registerTEE(voucher.teePubKey);
      await regTx.wait();
    }

    const tx = await verifier.submit(
      [
        submitXMsg.version,
        submitXMsg.requestID,
        submitXMsg.srcChainID,
        submitXMsg.dstChainID,
        submitXMsg.srcEmitter,
        submitXMsg.dstContract,
        submitXMsg.payload,
        submitXMsg.payloadHash,
        submitXMsg.srcHeight,
        ethers.toUtf8Bytes(submitXMsg.eventProof),
        ethers.toUtf8Bytes(submitXMsg.finalityInfo),
        submitXMsg.nonce,
        submitXMsg.teePubKey
      ],
      voucher.teeReport,
      voucher.teeSig,
      voucher.ctr,
      voucher.prevDigest
    );
    const receipt = await tx.wait();

    const result = {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      mode,
      requestID: submitXMsg.requestID,
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
