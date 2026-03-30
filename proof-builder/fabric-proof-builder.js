const { ethers } = require('ethers');
const { readJSON, writeJSON, ensureRuntime } = require('../shared/utils');
const { createBaseXmsg, createRequestId } = require('../shared/xmsg');
const { requestConsensusAggregate } = require('../consensus-aggregator/client');
const {
  buildFabricEventProof,
  buildFabricFinalityInfo
} = require('../shared/fabric-proof');

function parseEventPayload(payloadBytes) {
  const text = Buffer.isBuffer(payloadBytes)
    ? payloadBytes.toString('utf8')
    : Buffer.from(payloadBytes).toString('utf8');
  return JSON.parse(text);
}

async function buildXmsgFromFabricEvent({
  deployment,
  channelName,
  chaincodeId,
  eventName,
  rawPayload,
  txId,
  blockNumber,
  nonce,
  txEnvelopeBase64,
  blockHeader,
  blockMetadataBase64,
  creatorMspId,
  creatorIdBase64,
  endorsements,
  rwsetHash,
  ordererMspId,
  txValidationCode
}) {
  ensureRuntime();
  const proofBuildStartedAt = Date.now();
  // Derive requestID from immutable Fabric event identity so multiple listeners
  // observing the same transaction produce the same XMsg.
  const requestID = createRequestId(
    `fabric-${channelName}-${txId}`,
    0,
    blockNumber
  );
  const base = createBaseXmsg({
    deployment,
    rawPayload,
    requestID,
    srcChainName: `fabric-${channelName}`,
    srcEmitterName: chaincodeId,
    srcHeight: blockNumber,
    nonce,
      txId
  });

  const eventProof = buildFabricEventProof({
    channelName,
    chaincodeId,
    eventName,
    txId,
    blockNumber,
    requestID: base.requestID,
    payloadHash: base.payloadHash,
    txValidationCode,
    txEnvelopeBase64,
    blockHeader,
    creatorMspId,
    creatorIdBase64,
    endorsements,
    rwsetHash,
    consensusProof: { placeholder: true }
  });

  const parsedEventProof = { ...eventProof };
  const consensusProof = await requestConsensusAggregate({
    channelName,
    blockNumber,
    blockHash: parsedEventProof.blockHash,
    eventRoot: parsedEventProof.eventRoot,
    requestID: base.requestID,
    payloadHash: base.payloadHash,
    txId
  });
  parsedEventProof.consensusProof = consensusProof;

  const finalityInfo = buildFabricFinalityInfo({
    channelName,
    blockNumber,
    blockHeader,
    ordererMspId,
    metadataBase64: blockMetadataBase64,
    commitStatus: txValidationCode || 'VALID',
    confirmations: 1,
    consensusProof
  });

  return {
    ...base,
    eventProof: JSON.stringify(parsedEventProof),
    finalityInfo: JSON.stringify(finalityInfo),
    teePubKey: ethers.ZeroAddress,
    proofMeta: {
      proofType: 'fabric-v2',
      signatureScheme: 'threshold-ecdsa',
      validatorSetId: parsedEventProof.consensusProof.validatorSetId,
      threshold: parsedEventProof.consensusProof.threshold,
      validatorCount: parsedEventProof.consensusProof.validatorAddresses.length,
      proofBuildMs: Date.now() - proofBuildStartedAt
    }
  };
}

function writeLatestXmsg(xmsg) {
  writeJSON('latest-xmsg.json', xmsg);
  return xmsg;
}

async function buildFromCapturedEvent(relPath = 'fabric-captured-event.json') {
  const captured = readJSON(relPath);
  const deployment = readJSON('deployment.json');
  if (!captured) {
    throw new Error(`${relPath} not found in runtime`);
  }
  if (!deployment) {
    throw new Error('deployment.json not found; run deploy first');
  }
  const xmsg = await buildXmsgFromFabricEvent({
    deployment,
    channelName: captured.channelName,
    chaincodeId: captured.chaincodeId,
    eventName: captured.eventName,
    rawPayload: captured.rawPayload,
    txId: captured.txId,
    blockNumber: captured.blockNumber,
    nonce: captured.nonce,
    txEnvelopeBase64: captured.txEnvelopeBase64,
    blockHeader: captured.blockHeader,
    blockMetadataBase64: captured.blockMetadataBase64,
    creatorMspId: captured.creatorMspId,
    creatorIdBase64: captured.creatorIdBase64,
    endorsements: captured.endorsements,
    rwsetHash: captured.rwsetHash,
    ordererMspId: captured.ordererMspId,
    txValidationCode: captured.txValidationCode
  });
  return writeLatestXmsg(xmsg);
}

if (require.main === module) {
  const relPath = process.argv[2] || 'fabric-captured-event.json';
  buildFromCapturedEvent(relPath)
    .then((xmsg) => {
      console.log(JSON.stringify(xmsg, null, 2));
    })
    .catch((error) => {
      console.error(error.message || error);
      process.exit(1);
    });
}

module.exports = {
  parseEventPayload,
  buildXmsgFromFabricEvent,
  buildFromCapturedEvent,
  writeLatestXmsg
};
