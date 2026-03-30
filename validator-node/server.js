const express = require('express');
const { ethers } = require('ethers');
const fs = require('fs-extra');
const { getValidatorWalletByLabel } = require('../consensus-aggregator/validator-set');
const { Gateway, Wallets } = require('fabric-network');

const label = process.env.VALIDATOR_LABEL;
if (!label) {
  throw new Error('VALIDATOR_LABEL is required');
}

const wallet = getValidatorWalletByLabel(label);
const nodeId = process.env.VALIDATOR_ID || label;
const connectionProfilePath = process.env.FABRIC_CONNECTION_PROFILE;
const walletPath = process.env.FABRIC_WALLET_PATH;
const identity = process.env.FABRIC_IDENTITY || 'appUser';
const channelName = process.env.FABRIC_CHANNEL || 'mychannel';
const targetPeer = process.env.FABRIC_TARGET_PEER;
const app = express();
app.use(express.json({ limit: '512kb' }));

let gatewayPromise = null;

function buildScopedConnectionProfile() {
  if (!connectionProfilePath || !walletPath || !targetPeer) {
    throw new Error('FABRIC_CONNECTION_PROFILE, FABRIC_WALLET_PATH and FABRIC_TARGET_PEER are required');
  }

  const ccp = fs.readJsonSync(connectionProfilePath);
  if (!ccp.peers?.[targetPeer]) {
    throw new Error(`Target peer ${targetPeer} not found in connection profile`);
  }

  const scoped = JSON.parse(JSON.stringify(ccp));
  scoped.organizations.Org1.peers = [targetPeer];
  scoped.channels[channelName].peers = {
    [targetPeer]: scoped.channels[channelName].peers[targetPeer]
  };
  scoped.peers = {
    [targetPeer]: scoped.peers[targetPeer]
  };
  return scoped;
}

async function getGateway() {
  if (!gatewayPromise) {
    gatewayPromise = (async () => {
      const ccp = buildScopedConnectionProfile();
      const walletFs = await Wallets.newFileSystemWallet(walletPath);
      const gateway = new Gateway();
      await gateway.connect(ccp, {
        wallet: walletFs,
        identity,
        discovery: { enabled: false, asLocalhost: false }
      });
      return gateway;
    })();
  }
  return gatewayPromise;
}

async function verifyTxOnAssignedPeer(txId) {
  const gateway = await getGateway();
  const network = await gateway.getNetwork(channelName);
  const qscc = network.getContract('qscc');
  const result = await qscc.evaluateTransaction('GetBlockByTxID', channelName, txId);
  if (!result || result.length === 0) {
    throw new Error(`peer-backed verification failed for txId ${txId}`);
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    validatorId: nodeId,
    label,
    address: wallet.address,
    targetPeer
  });
});

app.get('/info', (_req, res) => {
  res.json({
    validatorId: nodeId,
    label,
    address: wallet.address,
    targetPeer
  });
});

app.post('/sign', async (req, res) => {
  try {
    const digest = req.body?.digest;
    if (!ethers.isHexString(digest, 32)) {
      throw new Error('digest must be a 32-byte hex string');
    }
    const txId = req.body?.txId;
    if (!txId) {
      throw new Error('txId is required for peer-backed verification');
    }

    await verifyTxOnAssignedPeer(txId);

    const signature = wallet.signingKey.sign(digest).serialized;
    res.json({
      ok: true,
      validatorId: nodeId,
      targetPeer,
      signer: wallet.address,
      signature
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

const port = Number(process.env.PORT || 9101);
app.listen(port, () => {
  console.log(`validator-node ${nodeId} listening on ${port} as ${wallet.address} via ${targetPeer}`);
});
