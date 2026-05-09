// V3-MPC Proof Builder: single MPC-TSS signature instead of N individual ECDSA sigs
const { ethers } = require('ethers');
const { ensureRuntime } = require('../shared/utils');
const { createBaseXmsg, createRequestId } = require('../shared/xmsg');
const { requestMpcConsensusAggregate } = require('../consensus-aggregator/client');

async function buildXmsgMpc({ deployment, channelName, chaincodeId, rawPayload, txId, blockNumber, nonce }) {
  ensureRuntime();
  const t0 = Date.now();
  const requestID = createRequestId(`fabric-${channelName}-${txId}`, 0, blockNumber);
  const base = createBaseXmsg({
    deployment, rawPayload, requestID,
    srcChainName: `fabric-${channelName}`,
    srcEmitterName: chaincodeId,
    srcHeight: blockNumber, nonce, txId
  });

  const mpcProof = await requestMpcConsensusAggregate({
    channelName, blockNumber,
    blockHash: ethers.ZeroHash, eventRoot: ethers.ZeroHash,
    requestID, payloadHash: base.payloadHash, txId
  });

  return {
    ...base,
    teePubKey: ethers.ZeroAddress,
    proofMeta: {
      proofType: 'hybrid-v3-mpc',
      signatureScheme: 'mpc-tss',
      validatorSetId: mpcProof.validatorSetId,
      threshold: mpcProof.threshold,
      signerCount: mpcProof.signerCount,
      proofBuildMs: Date.now() - t0,
    },
    mpcProof: {
      signature: mpcProof.mpcSignature,
      pubkey: mpcProof.mpcPubkey,
      consensusMessage: mpcProof.consensusMessage,
      threshold: mpcProof.threshold,
    },
  };
}

module.exports = { buildXmsgMpc };
