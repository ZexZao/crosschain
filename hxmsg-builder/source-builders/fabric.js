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
} = require('../../shared/hxmsg');

function buildFabricSourceRecordHash(record) {
  return hashJson({
    requestID: record.requestID,
    sourceTxID: record.sourceTxID,
    fabricCaller: record.fabricCaller || '',
    targetChainType: record.targetChainType,
    targetChainID: record.targetChainID,
    targetObject: record.targetObject,
    functionSelector: record.functionSelector,
    callDataHash: record.callDataHash,
    businessPayloadHash: record.businessPayloadHash,
    receiver: record.receiver,
    nonce: Number(record.nonce),
    expireAt: Number(record.expireAt),
    status: record.status,
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
    targetObject: targetAction.targetObject,
    functionSelector: targetAction.functionSelector,
    callDataHash: targetAction.callDataHash,
    businessPayloadHash,
    receiver: targetAction.receiver,
    nonce: Number(rawPayload.nonce || nonce || 0),
    expireAt: Number(rawPayload.expireAt),
    status: rawPayload.status || 'COMMITTED',
  };
  const fabricRef = buildFabricViewRef({ channelName, chaincodeId, requestID });
  const encodedRef = encodeJsonRef(fabricRef);
  const hfsvPolicy = buildDefaultFabricHFsvPolicy({
    channelID: channelName,
    chaincodeName: chaincodeId,
  });
  return {
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

module.exports = {
  buildFabricSourceRecordHash,
  buildFabricViewRef,
  buildFabricSourceFact,
};
