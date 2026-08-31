const {
  ChainType,
  RefType,
  FinalityModel,
  VerificationMethod,
  PolicyType,
  encodeJsonRef,
  bytes32FromText,
  hashJson,
  hashBytes,
  buildDefaultFabricHFsvPolicy,
  computeAtomicityHash,
  computeFeedbackHash,
  normalizeAtomicity,
  normalizeFeedback,
} = require('../../shared/hxmsg');

function buildFabricSourceRecordHash(record) {
  return hashJson({
    requestID: record.requestID,
    sourceTxID: record.sourceTxID,
    fabricCaller: record.fabricCaller || '',
    targetChainType: record.targetChainType,
    targetChainID: record.targetChainID,
    targetDomainID: record.targetDomainID,
    targetObject: record.targetObject,
    functionSelector: record.functionSelector,
    callDataHash: record.callDataHash,
    businessPayloadHash: record.businessPayloadHash,
    receiver: record.receiver,
    nonce: Number(record.nonce),
    expireAt: Number(record.expireAt),
    status: record.status,
    feedbackHash: record.feedbackHash || computeFeedbackHash(record.feedback),
    atomicityHash: record.atomicityHash || computeAtomicityHash(record.atomicity),
  });
}

function buildFabricViewRef({ channelName, chaincodeId, requestID }) {
  const expectedStateKey = `crosschainEvents:${requestID}`;
  return {
    channelID: channelName,
    chaincodeName: chaincodeId,
    queryFunction: 'QueryCrosschainEvent',
    queryArgs: [requestID],
    viewAddress: `fabric://${channelName}/${chaincodeId}/QueryCrosschainEvent/${requestID}`,
    expectedStateKey,
  };
}

function buildFabricSourceFact({
  channelName,
  chaincodeId,
  requestID,
  rawPayload,
  txId,
  blockNumber,
  nonce,
  sourceTxID,
  target,
  targetAction,
  businessPayloadHash,
}) {
  const sourceRecord = {
    requestID,
    sourceTxID: sourceTxID || rawPayload.sourceTxID || txId,
    fabricCaller: rawPayload.fabricCaller || '',
    targetChainType: rawPayload.targetChainType || target.chainType,
    targetChainID: rawPayload.targetChainID || target.chainID,
    targetDomainID: rawPayload.targetDomainID || target.domainID,
    targetObject: targetAction.targetObject,
    functionSelector: targetAction.functionSelector,
    callDataHash: targetAction.callDataHash,
    businessPayloadHash,
    receiver: targetAction.receiver,
    nonce: Number(rawPayload.nonce || nonce || 0),
    expireAt: Number(rawPayload.expireAt),
    status: rawPayload.status || 'COMMITTED',
    feedbackHash: rawPayload.feedbackHash || computeFeedbackHash(rawPayload.feedback),
    atomicityHash: rawPayload.atomicityHash || computeAtomicityHash(rawPayload.atomicity),
  };
  const fabricRef = buildFabricViewRef({ channelName, chaincodeId, requestID });
  const encodedRef = encodeJsonRef(fabricRef);
  const hfsvPolicy = buildDefaultFabricHFsvPolicy({
    channelID: channelName,
    chaincodeName: chaincodeId,
  });
  return {
    nonceScope: bytes32FromText(`fabric:${channelName}:${chaincodeId}`),
    source: {
      chainType: ChainType.FABRIC,
      chainID: bytes32FromText(`fabric-${channelName}`),
      domainID: bytes32FromText('fabric-local-domain'),
    },
    sourceRef: {
      refType: RefType.FABRIC_VIEW,
      refHash: hashBytes(encodedRef),
      encodedRef,
    },
    verification: {
      verificationMethod: VerificationMethod.H_FSV,
      finalityModel: FinalityModel.IMMEDIATE,
      requiredConfirmations: 1,
      policyRef: {
        policyType: PolicyType.FABRIC_ENDORSEMENT,
        policyID: bytes32FromText(hfsvPolicy.policyID),
        policyHash: hashJson(hfsvPolicy),
      },
      adapterID: bytes32FromText('tee-adapter-fabric-hfsv-v1'),
    },
    sourceRecord,
    sourcePayloadHash: buildFabricSourceRecordHash(sourceRecord),
    srcHeight: Number(blockNumber),
    proofMeta: {
      proofType: 'h-fsv',
      messageType: 'h-xmsg',
      verificationMethod: 'H_FSV',
      policy: hfsvPolicy.policyID,
    },
  };
}

function assertFabricPolicyBinding({ rawPayload, feedback, atomicity }) {
  const normalizedFeedback = normalizeFeedback(feedback);
  const recordFeedback = normalizeFeedback(rawPayload.feedback);
  if (normalizedFeedback.required !== recordFeedback.required
      || normalizedFeedback.expectedMsgType !== recordFeedback.expectedMsgType
      || normalizedFeedback.timeout !== recordFeedback.timeout
      || String(normalizedFeedback.callbackRefHash).toLowerCase() !== String(recordFeedback.callbackRefHash).toLowerCase()) {
    throw new Error('Fabric source feedback policy mismatch');
  }
  const feedbackHash = rawPayload.feedbackHash || computeFeedbackHash(recordFeedback);
  if (computeFeedbackHash(normalizedFeedback).toLowerCase() !== String(feedbackHash).toLowerCase()) {
    throw new Error('Fabric source feedback hash mismatch');
  }
  const atomicityHash = rawPayload.atomicityHash || computeAtomicityHash(rawPayload.atomicity);
  const expectedAtomicityHash = computeAtomicityHash(normalizeAtomicity(atomicity));
  if (expectedAtomicityHash.toLowerCase() !== String(atomicityHash).toLowerCase()) {
    throw new Error('Fabric source atomicity policy mismatch');
  }
}

module.exports = {
  buildFabricSourceRecordHash,
  buildFabricViewRef,
  buildFabricSourceFact,
  assertFabricPolicyBinding,
};
