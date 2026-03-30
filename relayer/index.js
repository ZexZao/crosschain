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

  const teeResp = await axios.post(`${teeBase}/verify-sign`, xmsg, { timeout: 10000 });
  const voucher = teeResp.data;

  const provider = new ethers.JsonRpcProvider(rpc);
  const baseSigner = new ethers.Wallet(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  provider
);
const deployer = new ethers.NonceManager(baseSigner);

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

main().catch((err) => {
  console.error(err.shortMessage || err.message || err);
  process.exit(1);
});
