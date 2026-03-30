const { ethers } = require('ethers');
const fs = require('fs-extra');
const { writeJSON, readJSON, nowMs, ensureRuntime } = require('../shared/utils');
const { createBaseXmsg, createRequestId } = require('../shared/xmsg');

function buildEventProof(event) {
  return {
    proofType: 'simulated-v1',
    txId: event.txId,
    blockHash: ethers.keccak256(ethers.toUtf8Bytes(`block-${event.srcHeight}`)),
    eventName: 'XCALL',
    requestID: event.requestID,
    payloadHash: event.payloadHash,
    merklePath: ['0x1111', '0x2222'],
  };
}

function buildFinalityInfo(srcHeight) {
  return {
    proofType: 'simulated-finality-v1',
    mode: 'permissioned-committed',
    srcHeight,
    proof: 'block_committed',
    confirmations: 1,
  };
}

function main() {
  ensureRuntime();
  const deployment = readJSON('deployment.json');
  if (!deployment) {
    throw new Error('deployment.json not found; run deploy first');
  }

  const state = readJSON('source-state.json', { nonce: 0, srcHeight: 100 });
  state.nonce += 1;
  state.srcHeight += 1;

  const args = process.argv.slice(2);
  let payloadText = '';
  if (args[0] === '--payload-file') {
    const payloadPath = args[1];
    if (!payloadPath) {
      throw new Error('Missing payload file path after --payload-file');
    }
    payloadText = fs.readFileSync(payloadPath, 'utf8');
  } else {
    payloadText = args.join(' ');
  }
  if (!payloadText) {
    payloadText = JSON.stringify({ op: 'store', value: 'hello-cross-chain' });
  }
  const rawPayload = JSON.parse(payloadText);
  const requestID = createRequestId('fabric-sim', state.nonce, state.srcHeight);
  const txId = ethers.keccak256(ethers.toUtf8Bytes(`tx-${state.nonce}-${nowMs()}`));
  const event = createBaseXmsg({
    deployment,
    rawPayload,
    requestID,
    srcChainName: 'fabric-sim',
    srcEmitterName: 'chaincode-xcall',
    srcHeight: state.srcHeight,
    nonce: state.nonce,
    txId
  });

  const xmsg = {
    ...event,
    eventProof: JSON.stringify(buildEventProof(event)),
    finalityInfo: JSON.stringify(buildFinalityInfo(event.srcHeight)),
    teePubKey: ethers.ZeroAddress,
  };

  writeJSON('source-state.json', state);
  writeJSON('latest-xmsg.json', xmsg);
  console.log(JSON.stringify(xmsg, null, 2));
}

main();
