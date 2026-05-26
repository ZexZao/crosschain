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
  buildEvmMelvPolicyRef,
} = require('../../shared/hxmsg');

const CROSS_CHAIN_CALL_EVENT = 'event CrossChainCallRequested(bytes32 indexed requestID,address indexed sender,bytes32 indexed targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt)';
const CROSS_CHAIN_CALL_TOPIC = ethers.id('CrossChainCallRequested(bytes32,address,bytes32,bytes32,bytes32,bytes4,bytes32,bytes32,bytes32,uint64,uint64)');

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
    targetChainID: target.chainID,
    targetObject: targetAction.targetObject,
    functionSelector: targetAction.functionSelector,
    callDataHash: targetAction.callDataHash,
    nonce: parsed.nonce,
    expireAt: parsed.expireAt,
  };
  const { policy, policyID, policyHash } = buildEvmMelvPolicyRef({
    sourceChainID: `eip155:${chainId}`,
    sourceContract,
  });
  return {
    source: {
      chainType: ChainType.EVM,
      chainID: chainIdToBytes32(chainId),
      domainID: bytes32FromText(`evm-local-${chainId}`),
    },
    sourceRef: {
      refType: RefType.EVM_RECEIPT,
      refHash: buildEvmEventRefHash(eventRef),
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

module.exports = {
  CROSS_CHAIN_CALL_EVENT,
  CROSS_CHAIN_CALL_TOPIC,
  buildEvmEventRef,
  buildEvmEventRefHash,
  buildEvmSourcePayloadHash,
  parseCrossChainCallLog,
  findCrossChainCallLog,
  buildEvmSourceFact,
};
