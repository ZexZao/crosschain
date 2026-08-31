const { ethers } = require('ethers');
const {
  ChainType,
  RefType,
  FinalityModel,
  VerificationMethod,
  PolicyType,
  encodeJsonRef,
  bytes32FromText,
  chainIdToBytes32,
  hashBytes,
  buildEvmMelvPolicyRef,
  computeAtomicityHash,
  computeFeedbackHash,
  normalizeAtomicity,
  normalizeFeedback,
} = require('../../shared/hxmsg');

const CROSS_CHAIN_CALL_EVENT = 'event CrossChainCallRequested(bytes32 indexed requestID,address indexed sender,bytes32 indexed targetChainID,uint8 targetChainType,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bool feedbackRequired,uint8 expectedFeedbackMsgType,uint64 feedbackTimeout,bytes32 callbackRefHash,bytes32 atomicityHash)';
const CROSS_CHAIN_CALL_TOPIC = ethers.id('CrossChainCallRequested(bytes32,address,bytes32,uint8,bytes32,bytes32,bytes4,bytes32,bytes32,bytes32,uint64,uint64,bool,uint8,uint64,bytes32,bytes32)');

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
      ['bytes32', 'address', 'address', 'uint8', 'bytes32', 'bytes32', 'bytes32', 'bytes4', 'bytes32', 'bytes32',
        'bytes32', 'uint64', 'uint64', 'bytes32', 'bytes32'],
      [
        record.requestID,
        record.sender,
        record.sourceContract,
        Number(record.targetChainType),
        record.targetChainID,
        record.targetDomainID,
        record.targetObject,
        record.functionSelector,
        record.callDataHash,
        record.businessPayloadHash,
        record.receiver,
        record.nonce,
        record.expireAt,
        record.feedbackHash,
        record.atomicityHash,
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
    targetChainType: Number(parsed.args.targetChainType),
    targetChainID: parsed.args.targetChainID,
    targetDomainID: parsed.args.targetDomainID,
    targetObject: parsed.args.targetObject,
    functionSelector: parsed.args.functionSelector,
    callDataHash: parsed.args.callDataHash,
    businessPayloadHash: parsed.args.businessPayloadHash,
    receiver: parsed.args.receiver,
    nonce: Number(parsed.args.nonce),
    expireAt: Number(parsed.args.expireAt),
    feedback: {
      required: Boolean(parsed.args.feedbackRequired),
      expectedMsgType: Number(parsed.args.expectedFeedbackMsgType),
      timeout: Number(parsed.args.feedbackTimeout),
      callbackRefHash: parsed.args.callbackRefHash,
    },
    feedbackHash: computeFeedbackHash({
      required: Boolean(parsed.args.feedbackRequired),
      expectedMsgType: Number(parsed.args.expectedFeedbackMsgType),
      timeout: Number(parsed.args.feedbackTimeout),
      callbackRefHash: parsed.args.callbackRefHash,
    }),
    atomicityHash: parsed.args.atomicityHash,
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

function buildEvmSourceFact({
  chainId,
  sourceContract,
  receipt,
  log,
  parsed,
  block,
  target,
  targetAction,
}) {
  const eventRef = buildEvmEventRef({
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    transactionIndex: receipt.index || receipt.transactionIndex || 0,
    logIndex: log.index,
    sourceContract,
  });
  const encodedRef = encodeJsonRef(eventRef);
  const sourceRecord = {
    requestID: parsed.requestID,
    sender: parsed.sender,
    sourceContract: ethers.getAddress(sourceContract),
    targetChainType: target.chainType,
    targetChainID: target.chainID,
    targetDomainID: target.domainID,
    targetObject: targetAction.targetObject,
    functionSelector: targetAction.functionSelector,
    callDataHash: targetAction.callDataHash,
    businessPayloadHash: parsed.businessPayloadHash,
    receiver: targetAction.receiver,
    nonce: parsed.nonce,
    expireAt: parsed.expireAt,
    feedbackHash: parsed.feedbackHash,
    atomicityHash: parsed.atomicityHash,
  };
  const { policy, policyID, policyHash } = buildEvmMelvPolicyRef({
    sourceChainID: `eip155:${chainId}`,
    sourceContract,
  });
  return {
    nonceScope: ethers.zeroPadValue(ethers.getAddress(sourceContract), 32),
    source: {
      chainType: ChainType.EVM,
      chainID: chainIdToBytes32(chainId),
      domainID: bytes32FromText(`evm-local-${chainId}`),
    },
    sourceRef: {
      refType: RefType.EVM_RECEIPT,
      refHash: hashBytes(encodedRef),
      encodedRef,
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
    sourceRecord,
    sourcePayloadHash: buildEvmSourcePayloadHash(sourceRecord),
    srcHeight: Number(receipt.blockNumber),
    createdAt: Number(block.timestamp || Math.floor(Date.now() / 1000)),
    proofMeta: {
      proofType: 'melv-ef',
      messageType: 'h-xmsg',
      verificationMethod: 'EVM_LIGHT_CLIENT',
      policy: policy.policyID,
    },
  };
}

function assertEvmPolicyBinding({ parsed, feedback, atomicity }) {
  const normalizedFeedback = normalizeFeedback(feedback);
  if (normalizedFeedback.required !== parsed.feedback.required
      || normalizedFeedback.expectedMsgType !== parsed.feedback.expectedMsgType
      || normalizedFeedback.timeout !== parsed.feedback.timeout
      || String(normalizedFeedback.callbackRefHash).toLowerCase() !== String(parsed.feedback.callbackRefHash).toLowerCase()) {
    throw new Error('EVM event feedback policy mismatch');
  }
  const expectedAtomicityHash = computeAtomicityHash(normalizeAtomicity(atomicity));
  if (expectedAtomicityHash.toLowerCase() !== String(parsed.atomicityHash).toLowerCase()) {
    throw new Error('EVM event atomicity policy mismatch');
  }
}

module.exports = {
  CROSS_CHAIN_CALL_EVENT,
  CROSS_CHAIN_CALL_TOPIC,
  buildEvmEventRef,
  buildEvmEventRefHash,
  buildEvmSourcePayloadHash,
  parseCrossChainCallLog,
  findCrossChainCallLog,
  buildEvmSourceFact,
  assertEvmPolicyBinding,
};
