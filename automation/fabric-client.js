const fs = require('fs-extra');
const { Gateway, Wallets } = require('fabric-network');

async function connectFabric(config) {
  const wallet = await Wallets.newFileSystemWallet(config.walletPath);
  const gateway = new Gateway();
  const connectionProfile = await fs.readJson(config.connectionProfile);
  const dockerHost = process.env.FABRIC_DOCKER_HOST;
  if (dockerHost) {
    for (const peer of Object.values(connectionProfile.peers || {})) {
      peer.url = String(peer.url).replace(/localhost|127\.0\.0\.1/g, dockerHost);
    }
    for (const orderer of Object.values(connectionProfile.orderers || {})) {
      orderer.url = String(orderer.url).replace(/localhost|127\.0\.0\.1/g, dockerHost);
    }
    for (const ca of Object.values(connectionProfile.certificateAuthorities || {})) {
      ca.url = String(ca.url).replace(/localhost|127\.0\.0\.1/g, dockerHost);
    }
  }
  await gateway.connect(connectionProfile, {
    wallet,
    identity: config.identity || 'appUser',
    discovery: { enabled: true, asLocalhost: config.asLocalhost !== false },
  });
  const network = await gateway.getNetwork(config.channel || 'mychannel');
  return { gateway, network, contract: network.getContract(config.chaincode || 'xcall') };
}

module.exports = { connectFabric };
