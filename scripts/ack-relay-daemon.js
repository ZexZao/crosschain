// Persistent ACK relay daemon — runs inside fabric-listener Docker container.
// Connects to Fabric Gateway ONCE and reuses the connection for all ACK requests.
// Exposes POST /relay-ack on port 3009.

const path = require('path');
const fs = require('fs-extra');
const http = require('http');
const axios = require('axios');
const { Gateway, Wallets } = require('fabric-network');

const PROJECT_ROOT = '/app';
const TEE_URL = 'http://tee-verifier:9000';
const PORT = 3009;

let gateway, contract;
let connectAttempts = 0;

async function connectFabric() {
  const profile = process.env.FABRIC_CONNECTION_PROFILE ||
    path.join(PROJECT_ROOT, 'fabric-network', 'connection-org1.docker.json');
  const walletPath = process.env.FABRIC_WALLET_PATH ||
    path.join(PROJECT_ROOT, 'fabric-network', 'wallet');
  const identity = process.env.FABRIC_IDENTITY || 'appUser';
  const channel = process.env.FABRIC_CHANNEL || 'mychannel';
  const chaincode = process.env.FABRIC_CHAINCODE || 'xcall';

  const ccp = fs.readJsonSync(profile);
  const wallet = await Wallets.newFileSystemWallet(walletPath);

  gateway = new Gateway();
  await gateway.connect(ccp, {
    wallet,
    identity,
    discovery: { enabled: true, asLocalhost: false }
  });
  const network = await gateway.getNetwork(channel);
  contract = network.getContract(chaincode);
  connectAttempts++;
  console.log(`[ack-daemon] Fabric Gateway connected (attempt #${connectAttempts})`);
}

async function ensureConnected() {
  try {
    // Lightweight health check: query a known transaction
    await contract.evaluateTransaction('GetAckStatus', 'health-check');
  } catch (e) {
    // Connection lost — reconnect
    if (e.message && (e.message.includes('UNAVAILABLE') || e.message.includes('GRPC') || e.message.includes('connect'))) {
      console.log('[ack-daemon] Connection lost, reconnecting...');
      try { gateway.disconnect(); } catch (_) {}
      await connectFabric();
    }
    // Other errors (like "health-check not found") are fine — connection is alive
  }
}

async function relayAck(ackXmsg) {
  await ensureConnected();

  // Use /attest (BLS + eventProof + finalityInfo full verification, same as forward path)
  const teeResp = await axios.post(`${TEE_URL}/attest`, {
    xmsg: ackXmsg,
    blsProof: ackXmsg.blsProof,
  }, { timeout: 15000 });
  const attestation = teeResp.data;
  const submitXmsg = { ...ackXmsg, teePubKey: attestation.teePubKey };

  // Fabric submit with full attestation (reportHash + teeSig + teePubKey + validatorSetId)
  const fabricResp = await contract.submitTransaction(
    'ConfirmAckXMsg',
    JSON.stringify(submitXmsg),
    JSON.stringify({
      teePubKey: attestation.teePubKey,
      reportHash: attestation.reportHash,
      teeSig: attestation.teeSig,
      validatorSetId: attestation.validatorSetId,
      blsValid: attestation.teeReport?.blsValid,
      signatureScheme: 'bls-aggregate',
    })
  );

  return {
    ok: true,
    requestID: submitXmsg.requestID,
    fabricResult: fabricResp.toString(),
  };
}

// ── HTTP Server ──

const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'GET' && req.url === '/health') {
    res.end(JSON.stringify({ ok: true, connections: connectAttempts }));
    return;
  }

  if (req.method === 'POST' && req.url === '/relay-ack') {
    try {
      const body = await new Promise((resolve) => {
        let data = '';
        req.on('data', (chunk) => { data += chunk; });
        req.on('end', () => { resolve(data); });
      });

      const ackXmsg = JSON.parse(body);
      const result = await relayAck(ackXmsg);
      res.statusCode = 200;
      res.end(JSON.stringify(result));
    } catch (e) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: e.message || String(e) }));
    }
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not found' }));
});

async function main() {
  await connectFabric();

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`[ack-daemon] Listening on port ${PORT} (Gateway connection reused)`);
  });

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    console.log('[ack-daemon] Shutting down...');
    server.close();
    try { gateway.disconnect(); } catch (_) {}
    process.exit(0);
  });
}

main().catch((e) => {
  console.error('[ack-daemon] Fatal error:', e.message || e);
  process.exit(1);
});
