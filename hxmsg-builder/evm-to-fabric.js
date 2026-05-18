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
  hashJson,
  hashBytes,
  computeTargetExecutionHash,
  computeHXMsgDigest,
  buildEvmMelvPolicyRef,
} = require('../shared/hxmsg');

const FABRIC_INVOKE_SELECTOR = ethers.id('ExecuteHXMsg(bytes32,bytes)').slice(0, 10);
const CROSS_CHAIN_CALL_EVENT = 'event CrossChainCallRequested(bytes32 indexed requestID,address indexed sender,bytes32 indexed targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt)';
const CROSS_CHAIN_CALL_TOPIC = ethers.id('CrossChainCallRequested(bytes32,address,bytes32,bytes32,bytes32,bytes4,bytes32,bytes32,bytes32,uint64,uint64)');

function buildFabricTargetObject(channelID, chaincodeName) {
  return bytes32FromText(`fabric:${channelID}:${chaincodeName}`);
}

function buildEvmEventRef({
  txHash,
  blockNumber,
  blockHash,
  transactionIndex,
  logIndex,
  sourceContract,
}) {
  return {
    txHash,
    blockNumber: Number(blockNumber),
    blockHash,
    transactionIndex: Number(transactionIndex || 0),
    logIndex: Number(logIndex),
    sourceContract: ethers.getAddress(sourceContract),
    eventSignature: CROSS_CHAIN_CALL_TOPIC,
  };
}

function buildEvmEventRefHash(ref) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint64', 'bytes32', 'uint32', 'address', 'bytes32'],
      [ref.txHash, ref.blockNumber, ref.blockHash, ref.logIndex, ref.sourceContract, ref.eventSignature]
    )
  );
}

function buildEvmSourcePayloadHash(record) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'address', 'bytes32', 'bytes32', 'bytes4', 'bytes32', 'uint64', 'uint64'],
      [
        record.requestID,
        record.sender,
        record.sourceContract,
        record.targetChainID,
        record.targetObject,
        record.functionSelector,
        record.callDataHash,
        record.nonce,
        record.expireAt,
      ]
    )
  );
}

function parseCrossChainCallLog(log) {
  const iface = new ethers.Interface([CROSS_CHAIN_CALL_EVENT]);
  const parsed = iface.parseLog(log);
  return {
    requestID: parsed.args.requestID,
    sender: ethers.getAddress(parsed.args.sender),
    targetChainID: parsed.args.targetChainID,
    targetDomainID: parsed.args.targetDomainID,
    targetObject: parsed.args.targetObject,
    functionSelector: parsed.args.functionSelector,
    callDataHash: parsed.args.callDataHash,
    businessPayloadHash: parsed.args.businessPayloadHash,
    receiver: parsed.args.receiver,
    nonce: Number(parsed.args.nonce),
    expireAt: Number(parsed.args.expireAt),
  };
}

function findCrossChainCallLog({ receipt, sourceContract, requestID }) {
  const targetAddress = ethers.getAddress(sourceContract);
  for (const log of receipt.logs || []) {
    if (ethers.getAddress(log.address) !== targetAddress) continue;
    if ((log.topics || [])[0] !== CROSS_CHAIN_CALL_TOPIC) continue;
    const parsed = parseCrossChainCallLog(log);
    if (!requestID || parsed.requestID === requestID) return { log, parsed };
  }
  throw new Error('CrossChainCallRequested log not found in EVM receipt');
}

function buildHXMsgFromEvmReceipt({
  deployment,
  receipt,
  block,
  businessPayload,
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

  const sourceChainID = chainIdToBytes32(deployment.chainId);
  const sourceDomainID = bytes32FromText(`evm-local-${deployment.chainId}`);
  const targetChainID = bytes32FromText(`fabric-${channelID}`);
  const targetDomainID = bytes32FromText('fabric-local-domain');
  const targetObject = buildFabricTargetObject(channelID, chaincodeName);
  const functionSelector = FABRIC_INVOKE_SELECTOR;
  if (parsed.targetChainID !== targetChainID) throw new Error('event targetChainID mismatch');
  if (parsed.targetDomainID !== targetDomainID) throw new Error('event targetDomainID mismatch');
  if (parsed.targetObject !== targetObject) throw new Error('event targetObject mismatch');
  if (parsed.functionSelector !== functionSelector) throw new Error('event functionSelector mismatch');

  const eventRef = buildEvmEventRef({
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    transactionIndex: receipt.index || receipt.transactionIndex || 0,
    logIndex: log.index,
    sourceContract,
  });
  const encodedRef = encodeJsonRef(eventRef);
  const sourcePayloadRecord = {
    requestID: parsed.requestID,
    sender: parsed.sender,
    sourceContract: ethers.getAddress(sourceContract),
    targetChainID,
    targetObject,
    functionSelector,
    callDataHash,
    nonce: parsed.nonce,
    expireAt: parsed.expireAt,
  };
  const sourcePayloadHash = buildEvmSourcePayloadHash(sourcePayloadRecord);
  const targetExecutionHash = computeTargetExecutionHash({
    requestID: parsed.requestID,
    targetChainID,
    targetObject,
    functionSelector,
    callDataHash,
    receiver: parsed.receiver,
  });
  const { policy, policyID, policyHash } = buildEvmMelvPolicyRef({
    sourceChainID: `eip155:${deployment.chainId}`,
    sourceContract,
  });
  const hxmsg = {
    header: {
      version: 1,
      requestID: parsed.requestID,
      msgType: MsgType.CONTRACT_CALL,
      nonce: parsed.nonce,
      createdAt: Number(block.timestamp || Math.floor(Date.now() / 1000)),
      expireAt: parsed.expireAt,
    },
    source: {
      chainType: ChainType.EVM,
      chainID: sourceChainID,
      domainID: sourceDomainID,
    },
    target: {
      chainType: ChainType.FABRIC,
      chainID: targetChainID,
      domainID: targetDomainID,
    },
    sourceRef: {
      refType: RefType.EVM_RECEIPT,
      refHash: buildEvmEventRefHash(eventRef),
      encodedRef,
    },
    targetAction: {
      actionType: ActionType.CHAINCODE_INVOKE,
      targetObject,
      functionSelector,
      callDataHash,
      receiver: parsed.receiver,
    },
    verification: {
      verificationMethod: VerificationMethod.EVM_LIGHT_CLIENT,
      finalityModel: FinalityModel.PROBABILISTIC,
      requiredConfirmations: policy.requiredConfirmations,
      policyRef: {
        policyType: PolicyType.EVM_FINALITY,
        policyID,
        policyHash,
      },
      adapterID: bytes32FromText('tee-adapter-evm-melv-ef-v1'),
    },
    payloadBinding: {
      sourcePayloadHash,
      businessPayloadHash,
      targetExecutionHash,
    },
    feedback: {
      required: Boolean(normalized.requireAck),
      expectedMsgType: normalized.requireAck ? FeedbackType.ACK : FeedbackType.NONE,
      timeout: 0,
      callbackRefHash: ethers.ZeroHash,
    },
    callData: payloadHex,
    callDataDecoded: normalized,
    txId: receipt.hash,
    srcHeight: Number(receipt.blockNumber),
    sourceRecord: sourcePayloadRecord,
    proofMeta: {
      proofType: 'melv-ef',
      messageType: 'h-xmsg',
      verificationMethod: 'EVM_LIGHT_CLIENT',
      policy: policy.policyID,
    },
  };
  hxmsg.hmsgDigest = computeHXMsgDigest(hxmsg);
  return hxmsg;
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
  buildHXMsgFromEvmReceipt,
};
