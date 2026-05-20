const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const { Gateway, Wallets } = require('fabric-network');
const { ethers } = require('ethers');
const { buildReceiptProof } = require('../shared/evm/receipt-proof');
const { readJSON, writeJSON, ensureRuntime } = require('../shared/utils');

async function getFabricContract(projectRoot) {
  const profile = process.env.FABRIC_CONNECTION_PROFILE || path.join(projectRoot, 'fabric-network', 'connection-org1.json');
  const walletPath = process.env.FABRIC_WALLET_PATH || path.join(projectRoot, 'fabric-network', 'wallet');
  const identity = process.env.FABRIC_IDENTITY || 'appUser';
  const channel = process.env.FABRIC_CHANNEL || 'mychannel';
  const chaincode = process.env.FABRIC_CHAINCODE || 'xcall';
  const asLocalhost = process.env.FABRIC_AS_LOCALHOST !== 'false';

  const ccp = fs.readJsonSync(profile);
  const wallet = await Wallets.newFileSystemWallet(walletPath);
  const gateway = new Gateway();
  await gateway.connect(ccp, {
    wallet,
    identity,
    discovery: { enabled: true, asLocalhost }
  });
  const network = await gateway.getNetwork(channel);
  return {
    gateway,
    contract: network.getContract(chaincode)
  };
}

async function main() {
  ensureRuntime();
  const projectRoot = path.join(__dirname, '..');
  const relPath = process.argv[2] || 'latest-evm-xmsg.json';
  const xmsg = readJSON(relPath);
  if (!xmsg) {
    throw new Error(`Missing ${relPath}`);
  }

  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC || 'http://127.0.0.1:8545');
  const receiptProof = await buildReceiptProof({
    provider,
    blockNumber: xmsg.srcHeight,
    txHash: xmsg.txId,
  });

  const teeBase = process.env.TEE_URL || 'http://127.0.0.1:9000';
  const teeResp = await axios.post(`${teeBase}/attest`, {
    hxmsg: xmsg,
    helperData: { evmReceiptProof: receiptProof },
  }, { timeout: 30000 });
  const voucher = teeResp.data.teeClusterCertification || teeResp.data.teeCertification;

  const { gateway, contract } = await getFabricContract(projectRoot);
  try {
    const certs = voucher.certifications || [voucher];
    for (const cert of certs) {
      await contract.submitTransaction('RegisterTrustedTEE', cert.teeAddress);
    }
    const fabricResp = await contract.submitTransaction(
      'ExecuteHXMsg',
      JSON.stringify(xmsg),
      xmsg.callData,
      JSON.stringify(voucher)
    );
    const result = {
      mode: 'evm-to-fabric',
      requestID: xmsg.header?.requestID || xmsg.requestID,
      txHash: xmsg.txId,
      fabricResult: fabricResp.toString(),
      verificationMeta: teeResp.data.verificationResult,
      teeCluster: teeResp.data.teeClusterCertification || null
    };
    writeJSON('last-evm-to-fabric-result.json', result);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    gateway.disconnect();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
