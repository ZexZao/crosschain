const { ethers } = require('ethers');
const { ensureRuntime, writeJSON, readJSON } = require('../shared/utils');
const { createBaseXmsg, createRequestId } = require('../shared/xmsg');
const { requestConsensusAggregate } = require('../consensus-aggregator/client');
const {
  buildEvmEventProof,
  buildEvmFinalityInfo
} = require('../shared/evm-proof');

async function buildXmsgFromEvmEvent({
  deployment,
  networkName = 'evm-localhost',
  emitterAddress,
  eventName,
  rawPayload,
  txHash,
  blockNumber,
  blockHash,
  logIndex,
  nonce,
  dstChainName = 'fabric-mychannel',
  dstContract = ethers.ZeroAddress
}) {
  ensureRuntime();
  const proofBuildStartedAt = Date.now();
  const requestID = createRequestId(
    `${networkName}-${eventName}-${txHash}`,
    nonce || logIndex || 0,
    blockNumber
  );

  const base = createBaseXmsg({
    deployment,
    rawPayload,
    requestID,
    srcChainName: networkName,
    srcEmitterName: emitterAddress,
    dstChainName,
    dstContract,
    srcHeight: blockNumber,
    nonce: nonce ?? logIndex ?? 0,
    txId: txHash
  });

  const eventProof = buildEvmEventProof({
    networkName,
    emitterAddress,
    eventName,
    txHash,
    blockNumber,
    blockHash,
    logIndex,
    requestID: base.requestID,
    payloadHash: base.payloadHash,
    consensusProof: { placeholder: true }
  });

  const parsedEventProof = { ...eventProof };
  const consensusProof = await requestConsensusAggregate({
    networkName,
    blockNumber,
    blockHash,
    eventRoot: parsedEventProof.eventRoot,
    requestID: base.requestID,
    payloadHash: base.payloadHash,
    txId: txHash
  });
  parsedEventProof.consensusProof = consensusProof;

  const finalityInfo = buildEvmFinalityInfo({
    networkName,
    blockNumber,
    blockHash,
    confirmations: 1,
    consensusProof
  });

  return {
    ...base,
    eventProof: JSON.stringify(parsedEventProof),
    finalityInfo: JSON.stringify(finalityInfo),
    teePubKey: ethers.ZeroAddress,
    proofMeta: {
      proofType: 'evm-v2',
      signatureScheme: 'threshold-ecdsa',
      validatorSetId: consensusProof.validatorSetId,
      threshold: consensusProof.threshold,
      validatorCount: consensusProof.validatorAddresses.length,
      proofBuildMs: Date.now() - proofBuildStartedAt
    }
  };
}

function writeLatestXmsg(xmsg, relPath = 'latest-evm-xmsg.json') {
  writeJSON(relPath, xmsg);
  return xmsg;
}

async function buildFromCapturedEvent(relPath = 'evm-captured-event.json', outputRelPath = 'latest-evm-xmsg.json') {
  const captured = readJSON(relPath);
  const deployment = readJSON('deployment.json');
  if (!captured) {
    throw new Error(`${relPath} not found in runtime`);
  }
  if (!deployment) {
    throw new Error('deployment.json not found; run deploy first');
  }
  const xmsg = await buildXmsgFromEvmEvent({
    deployment,
    networkName: captured.networkName,
    emitterAddress: captured.emitterAddress,
    eventName: captured.eventName,
    rawPayload: captured.rawPayload,
    txHash: captured.txHash,
    blockNumber: captured.blockNumber,
    blockHash: captured.blockHash,
    logIndex: captured.logIndex,
    nonce: captured.nonce,
    dstChainName: captured.dstChainName,
    dstContract: captured.dstContract
  });
  return writeLatestXmsg(xmsg, outputRelPath);
}

module.exports = {
  buildXmsgFromEvmEvent,
  buildFromCapturedEvent,
  writeLatestXmsg
};
