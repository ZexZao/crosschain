// V3 Proof Builder: collects ECDSA signatures from validators.
// eventProof is no longer needed — TEE independently queries source chain.

const { ethers } = require('ethers');
const { ensureRuntime } = require('../shared/utils');
const { createBaseXmsg, createRequestId } = require('../shared/xmsg');
const { requestV3ConsensusAggregate } = require('../consensus-aggregator/client');

async function buildXmsgFromFabricEventV3({
  deployment, channelName, chaincodeId, eventName, rawPayload,
  txId, blockNumber, nonce
}) {
  ensureRuntime();
  const t0 = Date.now();

  const requestID = createRequestId(`fabric-${channelName}-${txId}`, 0, blockNumber);
  const base = createBaseXmsg({
    deployment, rawPayload, requestID,
    srcChainName: `fabric-${channelName}`,
    srcEmitterName: chaincodeId,
    srcHeight: blockNumber, nonce, txId
  });

  // V3: Collect ECDSA signatures from validators
  const v3Proof = await requestV3ConsensusAggregate({
    channelName, blockNumber,
    blockHash: ethers.ZeroHash,
    eventRoot: ethers.ZeroHash,
    requestID: base.requestID,
    payloadHash: base.payloadHash,
    txId
  });

  return buildXmsg(base, v3Proof, t0);
}

async function buildXmsgFromEvmEventV3({
  deployment, networkName, emitterAddress, eventName, rawPayload,
  txHash, blockNumber, blockHash, logIndex, nonce,
  dstChainName, dstContract
}) {
  ensureRuntime();
  const t0 = Date.now();

  const requestID = createRequestId(`${networkName}-${eventName}-${txHash}`, nonce || logIndex || 0, blockNumber);
  const base = createBaseXmsg({
    deployment, rawPayload, requestID,
    srcChainName: networkName,
    srcEmitterName: emitterAddress,
    dstChainName, dstContract,
    srcHeight: blockNumber, nonce: nonce ?? logIndex ?? 0, txId: txHash
  });

  const v3Proof = await requestV3ConsensusAggregate({
    networkName, blockNumber, blockHash,
    eventRoot: ethers.ZeroHash,
    requestID: base.requestID,
    payloadHash: base.payloadHash,
    txId: txHash
  });

  return buildXmsg(base, v3Proof, t0);
}

function buildXmsg(base, v3Proof, t0) {
  return {
    ...base,
    teePubKey: ethers.ZeroAddress,
    proofMeta: {
      proofType: 'hybrid-v3',
      signatureScheme: 'ecdsa-threshold-v3',
      validatorSetId: v3Proof.validatorSetId,
      threshold: v3Proof.threshold,
      validatorCount: v3Proof.signerAddresses.length,
      proofBuildMs: Date.now() - t0,
    },
    v3Proof: {
      consensusMessage: v3Proof.consensusMessage,
      signatures: v3Proof.signatures,
      signerAddresses: v3Proof.signerAddresses,
      threshold: v3Proof.threshold,
      validatorSetId: v3Proof.validatorSetId,
    },
  };
}

module.exports = { buildXmsgFromFabricEventV3, buildXmsgFromEvmEventV3 };
