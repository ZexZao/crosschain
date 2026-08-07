const { ethers } = require('ethers');
const { encodeCompactBusinessCall } = require('../shared/xmsg');
const { MsgType, FeedbackType, hashJson } = require('../shared/hxmsg');
const { composeHXMsg } = require('./compose');
const {
  TARGET_EXECUTE_SELECTOR,
  buildEvmContractCallTarget,
} = require('./target-builders/evm');
const {
  buildFabricSourceRecordHash,
  buildFabricViewRef,
  buildFabricSourceFact,
  assertFabricPolicyBinding,
} = require('./source-builders/fabric');

function normalizeFabricEventPayload(rawPayload) {
  return rawPayload.businessPayload || rawPayload.payload || rawPayload;
}

function buildHXMsgFromFabricEvent({
  deployment,
  channelName,
  chaincodeId,
  rawPayload,
  txId,
  blockNumber,
  nonce,
  createdAt,
  targetChainType,
  targetDomainID,
}) {
  if (!deployment) throw new Error('deployment is required');
  if (!rawPayload?.requestID) throw new Error('Fabric event payload missing requestID');
  if (!rawPayload?.targetObject) throw new Error('Fabric event payload missing targetObject');
  if (!rawPayload?.callDataHash) throw new Error('Fabric event payload missing callDataHash');

  const businessPayload = normalizeFabricEventPayload(rawPayload);
  const { normalized, compact, payloadHex, compactCallHash } = encodeCompactBusinessCall(businessPayload);
  const callDataHash = compactCallHash;
  if (callDataHash.toLowerCase() !== String(rawPayload.callDataHash).toLowerCase()) {
    throw new Error(`callDataHash mismatch: event=${rawPayload.callDataHash}, computed=${callDataHash}`);
  }

  const requestID = rawPayload.requestID;
  const targetPart = buildEvmContractCallTarget({
    chainId: deployment.chainId,
    requestID,
    targetObject: rawPayload.targetObject,
    functionSelector: rawPayload.functionSelector || TARGET_EXECUTE_SELECTOR,
    callDataHash,
    receiver: rawPayload.receiver || rawPayload.targetObject,
    chainType: targetChainType,
    domainID: targetDomainID,
  });
  const businessPayloadHash = rawPayload.businessPayloadHash || hashJson(normalized);
  const sourcePart = buildFabricSourceFact({
    channelName,
    chaincodeId,
    requestID,
    rawPayload,
    txId,
    blockNumber,
    nonce,
    target: targetPart.target,
    targetAction: targetPart.targetAction,
    businessPayloadHash,
  });

  const feedbackRequired = Boolean(normalized.requireAck || rawPayload.requireAck);
  const atomicity = rawPayload.atomicity || null;
  // 链上 XCALL 事件中的显式 feedback 是源链事实，builder 不得用业务 requireAck 重写其类型。
  const feedback = rawPayload.feedback ? {
    required: Boolean(rawPayload.feedback.required),
    expectedMsgType: Number(rawPayload.feedback.expectedMsgType || 0),
    timeout: Number(rawPayload.feedback.timeout || 0),
    callbackRefHash: rawPayload.feedback.callbackRefHash || ethers.ZeroHash,
  } : {
    required: atomicity?.required ? true : feedbackRequired,
    expectedMsgType: atomicity?.required ? FeedbackType.RESPONSE : (feedbackRequired ? FeedbackType.ACK : FeedbackType.NONE),
    timeout: atomicity?.required || feedbackRequired
      ? Number(rawPayload.feedbackTimeout || rawPayload.ackTimeout || rawPayload.expireAt)
      : 0,
    callbackRefHash: rawPayload.callbackRefHash || ethers.ZeroHash,
  };
  assertFabricPolicyBinding({ rawPayload, feedback, atomicity });

  return composeHXMsg({
    header: {
      version: 1,
      requestID,
      msgType: MsgType.CONTRACT_CALL,
      nonce: Number(rawPayload.nonce || nonce || 0),
      nonceScope: sourcePart.nonceScope,
      createdAt: Number(rawPayload.createdAt || createdAt || Math.floor(Date.now() / 1000)),
      expireAt: Number(rawPayload.expireAt),
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
    compactCall: compact,
    callDataDecoded: normalized,
    txId,
    srcHeight: sourcePart.srcHeight,
    sourceRecord: sourcePart.sourceRecord,
    proofMeta: sourcePart.proofMeta,
  });
}

module.exports = {
  TARGET_EXECUTE_SELECTOR,
  buildFabricSourceRecordHash,
  buildFabricViewRef,
  assertFabricPolicyBinding,
  buildHXMsgFromFabricEvent,
};
