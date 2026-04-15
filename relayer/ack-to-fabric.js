const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const { Gateway, Wallets } = require('fabric-network');
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
  const relPath = process.argv[2] || 'latest-ack-xmsg.json';
  const xmsg = readJSON(relPath);
  if (!xmsg) {
    throw new Error(`Missing ${relPath}`);
  }

  const teeBase = process.env.TEE_URL || 'http://127.0.0.1:9000';
  const teeResp = await axios.post(`${teeBase}/verify-sign`, xmsg, { timeout: 10000 });
  const voucher = teeResp.data;
  const submitXmsg = { ...xmsg, teePubKey: voucher.teePubKey };

  const { gateway, contract } = await getFabricContract(projectRoot);
  try {
    const fabricResp = await contract.submitTransaction(
      'ConfirmAckXMsg',
      JSON.stringify(submitXmsg),
      JSON.stringify(voucher)
    );
    const result = {
      mode: 'ack-to-fabric',
      requestID: submitXmsg.requestID,
      txHash: submitXmsg.txId,
      fabricResult: fabricResp.toString(),
      verificationMeta: voucher.verificationMeta || null
    };
    writeJSON('last-ack-to-fabric-result.json', result);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    gateway.disconnect();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
