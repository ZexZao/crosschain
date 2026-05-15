const { ethers } = require('ethers');
const { encodeBusinessPayload } = require('../shared/xmsg');
const {
  ChainType,
  RefType,
  MsgType,
  FeedbackType,
  ActionType,
  FinalityModel,
  VerificationMethod,
  PolicyType,
  encodeJsonRef,
  bytes32FromText,
  chainIdToBytes32,
  addressToBytes32,
  hashJson,
  hashBytes,
  buildDefaultFabricHFsvPolicy,
  computeTargetExecutionHash,
  computeHXMsgDigest,
} = require('../shared/hxmsg');

const TARGET_EXECUTE_SELECTOR = ethers.id('execute(bytes32,bytes)').slice(0, 10);

function normalizeFabricEventPayload(rawPayload) {
  return rawPayload.businessPayload || rawPayload.payload || rawPayload;
}

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

function buildHXMsgFromFabricEvent({
  deployment,
  channelName,
  chaincodeId,
  rawPayload,
  txId,
  blockNumber,
  nonce,
  createdAt
}) {
  if (!deployment) throw new Error('deployment is required');
  if (!rawPayload?.requestID) throw new Error('Fabric event payload missing requestID');
  if (!rawPayload?.targetObject) throw new Error('Fabric event payload missing targetObject');
  if (!rawPayload?.callDataHash) throw new Error('Fabric event payload missing callDataHash');

  const businessPayload = normalizeFabricEventPayload(rawPayload);
  const { normalized, payloadHex } = encodeBusinessPayload(businessPayload);
  const callDataHash = ethers.keccak256(payloadHex);
  if (ethers.getBytes(callDataHash).toString() !== ethers.getBytes(rawPayload.callDataHash).toString()) {
    if (callDataHash.toLowerCase() !== String(rawPayload.callDataHash).toLowerCase()) {
      throw new Error(`callDataHash mismatch: event=${rawPayload.callDataHash}, computed=${callDataHash}`);
    }
  }

  const requestID = rawPayload.requestID;
  const targetChainID = chainIdToBytes32(deployment.chainId);
  const sourceChainID = bytes32FromText(`fabric-${channelName}`);
  const sourceDomainID = bytes32FromText('fabric-local-domain');
  const targetDomainID = bytes32FromText(`evm-local-${deployment.chainId}`);
  const targetObject = rawPayload.targetObject;
  const receiver = rawPayload.receiver || targetObject;
  const functionSelector = rawPayload.functionSelector || TARGET_EXECUTE_SELECTOR;

  const sourceRecord = {
    requestID,
    sourceTxID: rawPayload.sourceTxID || txId,
    fabricCaller: rawPayload.fabricCaller || '',
    targetChainType: rawPayload.targetChainType || 'EVM',
    targetChainID: rawPayload.targetChainID || targetChainID,
    targetObject,
    functionSelector,
    callDataHash,
    businessPayloadHash: rawPayload.businessPayloadHash || hashJson(normalized),
    receiver,
    nonce: Number(rawPayload.nonce || nonce || 0),
    expireAt: Number(rawPayload.expireAt),
    status: rawPayload.status || 'COMMITTED',
  };
  const sourcePayloadHash = buildFabricSourceRecordHash(sourceRecord);

  const fabricRef = buildFabricViewRef({ channelName, chaincodeId, requestID });
  const encodedRef = encodeJsonRef(fabricRef);
  const refHash = hashBytes(encodedRef);

  const targetExecutionHash = computeTargetExecutionHash({
    requestID,
    targetChainID,
    targetObject,
    functionSelector,
    callDataHash,
    receiver,
  });

  const hfsvPolicy = buildDefaultFabricHFsvPolicy({
    channelID: channelName,
    chaincodeName: chaincodeId,
  });
  const policyID = bytes32FromText(hfsvPolicy.policyID);
  const policyHash = hashJson(hfsvPolicy);
  const feedbackRequired = Boolean(normalized.requireAck || rawPayload.requireAck);
  const feedback = {
    required: feedbackRequired,
    expectedMsgType: feedbackRequired ? FeedbackType.ACK : FeedbackType.NONE,
    timeout: feedbackRequired
      ? Number(rawPayload.feedbackTimeout || rawPayload.ackTimeout || rawPayload.expireAt)
      : 0,
    callbackRefHash: rawPayload.callbackRefHash || ethers.ZeroHash,
  };

  const hxmsg = {
    header: {
      version: 1,
      requestID,
      msgType: MsgType.CONTRACT_CALL,
      nonce: Number(rawPayload.nonce || nonce || 0),
      createdAt: Number(rawPayload.createdAt || createdAt || Math.floor(Date.now() / 1000)),
      expireAt: Number(rawPayload.expireAt),
    },
    source: {
      chainType: ChainType.FABRIC,
      chainID: sourceChainID,
      domainID: sourceDomainID,
    },
    target: {
      chainType: ChainType.EVM,
      chainID: targetChainID,
      domainID: targetDomainID,
    },
    sourceRef: {
      refType: RefType.FABRIC_VIEW,
      refHash,
      encodedRef,
    },
    targetAction: {
      actionType: ActionType.CONTRACT_CALL,
      targetObject,
      functionSelector,
      callDataHash,
      receiver,
    },
    verification: {
      verificationMethod: VerificationMethod.H_FSV,
      finalityModel: FinalityModel.IMMEDIATE,
      requiredConfirmations: 1,
      policyRef: {
        policyType: PolicyType.FABRIC_ENDORSEMENT,
        policyID,
        policyHash,
      },
      adapterID: bytes32FromText('tee-adapter-fabric-hfsv-v1'),
    },
    payloadBinding: {
      sourcePayloadHash,
      businessPayloadHash: sourceRecord.businessPayloadHash,
      targetExecutionHash,
    },
    feedback,
    callData: payloadHex,
    callDataDecoded: normalized,
    txId,
    srcHeight: Number(blockNumber),
    sourceRecord,
    proofMeta: {
      proofType: 'h-fsv',
      messageType: 'h-xmsg',
      verificationMethod: 'H_FSV',
      policy: hfsvPolicy.policyID,
    },
  };
  hxmsg.hmsgDigest = computeHXMsgDigest(hxmsg);
  return hxmsg;
}

module.exports = {
  TARGET_EXECUTE_SELECTOR,
  buildFabricSourceRecordHash,
  buildFabricViewRef,
  buildHXMsgFromFabricEvent,
};
