// Run inside fabric-listener Docker container to relay ACK back to Fabric.
// Called via: docker exec fabric-listener node /app/scripts/docker-ack-relay.js

const path = require('path');
const fs = require('fs-extra');
const axios = require('axios');
const { Gateway, Wallets } = require('fabric-network');

async function main() {
  const projectRoot = '/app';
  const ackXmsgPath = path.join(projectRoot, 'runtime', 'latest-ack-xmsg.json');
  const ackXmsg = fs.readJsonSync(ackXmsgPath);

  // TEE verification
  const teeResp = await axios.post('http://tee-verifier:9000/verify-sign', ackXmsg, { timeout: 15000 });
  const voucher = teeResp.data;
  const submitXmsg = { ...ackXmsg, teePubKey: voucher.teePubKey };

  // Fabric connection
  const ccp = fs.readJsonSync(path.join(projectRoot, 'fabric-network', 'connection-org1.docker.json'));
  const wallet = await Wallets.newFileSystemWallet(path.join(projectRoot, 'fabric-network', 'wallet'));
  const gateway = new Gateway();
  await gateway.connect(ccp, { wallet, identity: 'appUser', discovery: { enabled: true, asLocalhost: false } });
  const network = await gateway.getNetwork('mychannel');
  const contract = network.getContract('xcall');

  // Submit ACK
  const resp = await contract.submitTransaction('ConfirmAckXMsg', JSON.stringify(submitXmsg), JSON.stringify(voucher));

  const result = {
    mode: 'ack-to-fabric',
    requestID: submitXmsg.requestID,
    fabricResult: resp.toString(),
  };

  // Write result to shared volume so host can read it
  fs.writeJsonSync(path.join(projectRoot, 'runtime', 'last-ack-to-fabric-result.json'), result, { spaces: 2 });

  console.log('ACK_OK:', JSON.stringify(result));
  await gateway.disconnect();
}

main().catch(e => {
  console.error('ACK_ERROR:', e.message || e);
  // Write error result
  const errResult = { mode: 'ack-to-fabric', error: e.message || String(e) };
  try {
    fs.writeJsonSync('/app/runtime/last-ack-to-fabric-result.json', errResult, { spaces: 2 });
  } catch (_) {}
  process.exit(1);
});
