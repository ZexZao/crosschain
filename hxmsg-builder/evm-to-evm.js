const { ethers } = require('ethers');
const { encodeBusinessPayload } = require('../shared/xmsg');
const {
  MsgType,
  FeedbackType,
  hashJson,
  normalizeFeedback,
} = require('../shared/hxmsg');
const { composeHXMsg } = require('./compose');
const { buildEvmContractCallTarget } = require('./target-builders/evm');
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

const EVM_EXECUTE_SELECTOR = ethers.id('execute(bytes32,bytes)').slice(0, 10);

function buildHXMsgFromEvmReceiptToEvm({
  sourceDeployment,
  targetDeployment,
  receipt,
  block,
  businessPayload,
  feedbackOverride,
  atomicity,
}) {
  if (!sourceDeployment) throw new Error('sourceDeployment is required');
  if (!targetDeployment) throw new Error('targetDeployment is required');
  if (!receipt) throw new Error('receipt is required');
  if (!block) throw new Error('block is required');

  const sourceContract = sourceDeployment.evmSourceContract;
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

  const targetPart = buildEvmContractCallTarget({
    chainId: targetDeployment.chainId,
    requestID: parsed.requestID,
    targetAddress: targetDeployment.targetContract,
    functionSelector: EVM_EXECUTE_SELECTOR,
    callDataHash,
    receiver: ethers.zeroPadValue(targetDeployment.targetContract, 32),
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
    chainId: sourceDeployment.chainId,
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
    compactCall: null,
    callDataDecoded: normalized,
    txId: receipt.hash,
    srcHeight: sourcePart.srcHeight,
    sourceRecord: sourcePart.sourceRecord,
    proofMeta: sourcePart.proofMeta,
  });
}

module.exports = {
  EVM_EXECUTE_SELECTOR,
  CROSS_CHAIN_CALL_EVENT,
  CROSS_CHAIN_CALL_TOPIC,
  buildEvmEventRef,
  buildEvmEventRefHash,
  buildEvmSourcePayloadHash,
  parseCrossChainCallLog,
  buildHXMsgFromEvmReceiptToEvm,
};
