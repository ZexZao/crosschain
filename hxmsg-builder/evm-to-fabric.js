const { ethers } = require('ethers');
const { encodeBusinessPayload } = require('../shared/xmsg');
const {
  MsgType,
  FeedbackType,
  hashJson,
  normalizeFeedback,
} = require('../shared/hxmsg');
const { composeHXMsg } = require('./compose');
const {
  FABRIC_INVOKE_SELECTOR,
  buildFabricTargetObject,
  buildFabricChaincodeTarget,
} = require('./target-builders/fabric');
const {
  CROSS_CHAIN_CALL_EVENT,
  CROSS_CHAIN_CALL_TOPIC,
  buildEvmEventRef,
  buildEvmEventRefHash,
  buildEvmSourcePayloadHash,
  parseCrossChainCallLog,
  findCrossChainCallLog,
  buildEvmSourceFact,
  assertEvmPolicyBinding,
} = require('./source-builders/evm');

function buildHXMsgFromEvmReceipt({
  deployment,
  receipt,
  block,
  businessPayload,
  feedbackOverride,
  atomicity,
  channelID = process.env.FABRIC_CHANNEL || 'mychannel',
  chaincodeName = process.env.FABRIC_CHAINCODE || 'xcall',
}) {
  if (!deployment) throw new Error('deployment is required');
  if (!receipt) throw new Error('receipt is required');
  if (!block) throw new Error('block is required');

  const sourceContract = deployment.evmSourceContract;
  const { log, parsed } = findCrossChainCallLog({ receipt, sourceContract });
  const { normalized, payloadHex } = encodeBusinessPayload(businessPayload);
  const callDataHash = ethers.keccak256(payloadHex);
  if (callDataHash.toLowerCase() !== parsed.callDataHash.toLowerCase()) {
    throw new Error(`callDataHash mismatch: event=${parsed.callDataHash}, computed=${callDataHash}`);
  }
  const businessPayloadHash = hashJson(normalized);
  if (businessPayloadHash.toLowerCase() !== parsed.businessPayloadHash.toLowerCase()) {
    throw new Error(`businessPayloadHash mismatch: event=${parsed.businessPayloadHash}, computed=${businessPayloadHash}`);
  }

  const targetPart = buildFabricChaincodeTarget({
    channelID,
    chaincodeName,
    requestID: parsed.requestID,
    callDataHash,
    receiver: parsed.receiver,
  });
  if (parsed.targetChainID !== targetPart.target.chainID) throw new Error('event targetChainID mismatch');
  if (parsed.targetDomainID !== targetPart.target.domainID) throw new Error('event targetDomainID mismatch');
  if (parsed.targetObject !== targetPart.targetAction.targetObject) throw new Error('event targetObject mismatch');
  if (parsed.functionSelector !== targetPart.targetAction.functionSelector) throw new Error('event functionSelector mismatch');

  const feedback = normalizeFeedback(feedbackOverride || parsed.feedback || {
    required: Boolean(normalized.requireAck),
    expectedMsgType: normalized.requireAck ? FeedbackType.ACK : FeedbackType.NONE,
    timeout: 0,
    callbackRefHash: ethers.ZeroHash,
  });
  assertEvmPolicyBinding({ parsed, feedback, atomicity });

  const sourcePart = buildEvmSourceFact({
    chainId: deployment.chainId,
    sourceContract,
    receipt,
    log,
    parsed,
    block,
    target: targetPart.target,
    targetAction: targetPart.targetAction,
  });

  return composeHXMsg({
    header: {
      version: 1,
      requestID: parsed.requestID,
      msgType: MsgType.CONTRACT_CALL,
      nonce: parsed.nonce,
      createdAt: sourcePart.createdAt,
      expireAt: parsed.expireAt,
    },
    source: sourcePart.source,
    target: targetPart.target,
    sourceRef: sourcePart.sourceRef,
    targetAction: targetPart.targetAction,
    verification: sourcePart.verification,
    payloadBinding: {
      sourcePayloadHash: sourcePart.sourcePayloadHash,
      businessPayloadHash,
      targetExecutionHash: targetPart.targetExecutionHash,
    },
    feedback,
    atomicity,
    callData: payloadHex,
    callDataDecoded: normalized,
    txId: receipt.hash,
    srcHeight: sourcePart.srcHeight,
    sourceRecord: sourcePart.sourceRecord,
    proofMeta: sourcePart.proofMeta,
  });
}

module.exports = {
  FABRIC_INVOKE_SELECTOR,
  CROSS_CHAIN_CALL_EVENT,
  CROSS_CHAIN_CALL_TOPIC,
  buildFabricTargetObject,
  buildEvmEventRef,
  buildEvmEventRefHash,
  buildEvmSourcePayloadHash,
  parseCrossChainCallLog,
  assertEvmPolicyBinding,
  buildHXMsgFromEvmReceipt,
};
