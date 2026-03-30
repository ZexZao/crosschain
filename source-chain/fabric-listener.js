const fs = require('fs-extra');
const path = require('path');
const { ensureRuntime, writeJSON, readJSON, nowMs } = require('../shared/utils');
const { buildXmsgFromFabricEvent } = require('../proof-builder/fabric-proof-builder');

function loadFabricSdk() {
  try {
    // Loaded lazily so the simulation path keeps working without Fabric packages.
    return require('fabric-network');
  } catch (error) {
    throw new Error(
      'fabric-network package is not installed. Run npm install after pulling the real Fabric upgrade.'
    );
  }
}

function normalizeArgv(argv) {
  const options = {
    profile: process.env.FABRIC_CONNECTION_PROFILE,
    wallet: process.env.FABRIC_WALLET_PATH,
    identity: process.env.FABRIC_IDENTITY || 'appUser',
    channel: process.env.FABRIC_CHANNEL || 'mychannel',
    chaincode: process.env.FABRIC_CHAINCODE || 'xcall',
    eventName: process.env.FABRIC_EVENT_NAME || 'XCALL',
    asLocalhost: process.env.FABRIC_AS_LOCALHOST !== 'false',
    mockFile: null
  };

  const args = [...argv];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--profile') options.profile = args[++i];
    else if (arg === '--wallet') options.wallet = args[++i];
    else if (arg === '--identity') options.identity = args[++i];
    else if (arg === '--channel') options.channel = args[++i];
    else if (arg === '--chaincode') options.chaincode = args[++i];
    else if (arg === '--event-name') options.eventName = args[++i];
    else if (arg === '--as-localhost') options.asLocalhost = args[++i] !== 'false';
    else if (arg === '--mock-file') options.mockFile = args[++i];
  }

  return options;
}

function extractString(bufferLike) {
  if (!bufferLike) return '';
  if (Buffer.isBuffer(bufferLike)) return bufferLike.toString('utf8');
  if (typeof bufferLike === 'string') return bufferLike;
  if (ArrayBuffer.isView(bufferLike)) return Buffer.from(bufferLike.buffer).toString('utf8');
  return String(bufferLike);
}

function mapCapturedEvent(contractEvent, options) {
  const listenerReceivedAtMs = nowMs();
  const payloadText = extractString(contractEvent.payload);
  const rawPayload = JSON.parse(payloadText);
  const txEvent = typeof contractEvent.getTransactionEvent === 'function'
    ? contractEvent.getTransactionEvent()
    : contractEvent.transactionEvent;
  const blockEvent = txEvent && typeof txEvent.getBlockEvent === 'function'
    ? txEvent.getBlockEvent()
    : txEvent?.blockEvent;

  const blockNumber = Number(
    blockEvent?.blockNumber ??
    txEvent?.blockNumber ??
    contractEvent.blockNumber ??
    0
  );

  const txId = txEvent?.transactionId || contractEvent.transactionId || contractEvent.txId;
  if (!txId || !blockNumber) {
    throw new Error('Fabric listener could not extract txId or blockNumber from the contract event');
  }

  const txEnvelopeBase64 = contractEvent.transactionData
    ? Buffer.from(contractEvent.transactionData).toString('base64')
    : '';
  const metadataBase64 = blockEvent?.metadata
    ? Buffer.from(blockEvent.metadata).toString('base64')
    : '';

  return {
    channelName: options.channel,
    chaincodeId: options.chaincode,
    eventName: contractEvent.eventName || options.eventName,
    rawPayload,
    txId,
    blockNumber,
    nonce: Date.now(),
    txEnvelopeBase64,
    blockHeader: {
      number: blockNumber,
      previousHash: blockEvent?.previousBlockHash || '',
      dataHash: blockEvent?.blockDataHash || ''
    },
    blockMetadataBase64: metadataBase64,
    creatorMspId: txEvent?.identity?.mspId || '',
    creatorIdBase64: txEvent?.identity?.idBytes
      ? Buffer.from(txEvent.identity.idBytes).toString('base64')
      : '',
    endorsements: [],
    rwsetHash: '',
    ordererMspId: 'OrdererMSP',
    txValidationCode: txEvent?.status || 'VALID',
    listenerTiming: {
      listenerReceivedAtMs,
      listenerReceivedAt: new Date(listenerReceivedAtMs).toISOString()
    }
  };
}

async function runMockListener(mockFile) {
  const captured = fs.readJsonSync(path.resolve(mockFile));
  const listenerReceivedAtMs = captured.listenerTiming?.listenerReceivedAtMs || nowMs();
  captured.listenerTiming = {
    listenerReceivedAtMs,
    listenerReceivedAt: captured.listenerTiming?.listenerReceivedAt || new Date(listenerReceivedAtMs).toISOString()
  };
  writeJSON('fabric-captured-event.json', captured);
  const deployment = readJSON('deployment.json');
  if (!deployment) {
    throw new Error('deployment.json not found; run deploy first');
  }
  const xmsg = await buildXmsgFromFabricEvent({ deployment, ...captured });
  const xmsgWrittenAtMs = nowMs();
  xmsg.listenerTiming = {
    ...captured.listenerTiming,
    xmsgWrittenAtMs,
    xmsgWrittenAt: new Date(xmsgWrittenAtMs).toISOString(),
    processingMs: xmsgWrittenAtMs - captured.listenerTiming.listenerReceivedAtMs
  };
  writeJSON('latest-xmsg.json', xmsg);
  return xmsg;
}

async function runGatewayListener(options) {
  const { Gateway, Wallets } = loadFabricSdk();
  if (!options.profile || !options.wallet) {
    throw new Error('Missing Fabric connection profile or wallet path');
  }

  const ccp = fs.readJsonSync(path.resolve(options.profile));
  const wallet = await Wallets.newFileSystemWallet(path.resolve(options.wallet));
  const gateway = new Gateway();
  await gateway.connect(ccp, {
    wallet,
    identity: options.identity,
    discovery: { enabled: true, asLocalhost: options.asLocalhost }
  });

  const deployment = readJSON('deployment.json');
  if (!deployment) {
    throw new Error('deployment.json not found; run deploy first');
  }

  const network = await gateway.getNetwork(options.channel);
  const contract = network.getContract(options.chaincode);
  console.log(`Listening Fabric events on ${options.channel}/${options.chaincode}:${options.eventName}`);

  await contract.addContractListener(async (contractEvent) => {
    if (options.eventName && contractEvent.eventName !== options.eventName) {
      return;
    }

    try {
      const captured = mapCapturedEvent(contractEvent, options);
      writeJSON('fabric-captured-event.json', captured);
      const xmsg = await buildXmsgFromFabricEvent({ deployment, ...captured });
      const xmsgWrittenAtMs = nowMs();
      xmsg.listenerTiming = {
        ...captured.listenerTiming,
        xmsgWrittenAtMs,
        xmsgWrittenAt: new Date(xmsgWrittenAtMs).toISOString(),
        processingMs: xmsgWrittenAtMs - captured.listenerTiming.listenerReceivedAtMs
      };
      writeJSON('latest-xmsg.json', xmsg);
      console.log(JSON.stringify({
        ok: true,
        txId: xmsg.txId,
        requestID: xmsg.requestID,
        srcHeight: xmsg.srcHeight,
        listenerProcessingMs: xmsg.listenerTiming.processingMs,
        proofBuildMs: xmsg.proofMeta?.proofBuildMs || 0,
        proofType: xmsg.proofMeta?.proofType || 'fabric-v1'
      }));
    } catch (error) {
      console.error(`Fabric event processing failed: ${error.message}`);
    }
  });
}

async function main() {
  ensureRuntime();
  const options = normalizeArgv(process.argv.slice(2));
  if (options.mockFile) {
    const xmsg = await runMockListener(options.mockFile);
    console.log(JSON.stringify(xmsg, null, 2));
    return;
  }
  await runGatewayListener(options);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
