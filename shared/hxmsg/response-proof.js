const { ethers } = require('ethers');
const { stableStringify } = require('./codec');

const EVM_EXECUTION_PROOF_V2 = ethers.id('HXMSG_EVM_EXECUTION_PROOF_V2');
const FABRIC_EXECUTION_PROOF_V2 = ethers.id('HXMSG_FABRIC_EXECUTION_PROOF_V2');
const FABRIC_EXECUTION_RESULT_V1 = ethers.id('HXMSG_FABRIC_EXECUTION_RESULT_V1');
const HXMSG_ACCEPTED_EVENT = 'event HXMsgAccepted(bytes32 indexed requestID,bytes32 indexed clusterID,address indexed target,bytes32 hmsgDigest,bytes32 targetExecutionHash,bytes32 resultHash)';
const HXMSG_ACCEPTED_INTERFACE = new ethers.Interface([HXMSG_ACCEPTED_EVENT]);
const HXMSG_ACCEPTED_TOPIC = HXMSG_ACCEPTED_INTERFACE.getEvent('HXMsgAccepted').topicHash;

function sameHex(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function parseHXMsgAcceptedLog(log) {
  const parsed = HXMSG_ACCEPTED_INTERFACE.parseLog(log);
  return {
    requestID: parsed.args.requestID,
    clusterID: parsed.args.clusterID,
    target: ethers.getAddress(parsed.args.target),
    hmsgDigest: parsed.args.hmsgDigest,
    targetExecutionHash: parsed.args.targetExecutionHash,
    resultHash: parsed.args.resultHash,
  };
}

function findHXMsgAcceptedLog({ receipt, gatewayAddress, requestID }) {
  const expectedGateway = ethers.getAddress(gatewayAddress);
  for (const log of receipt.logs || []) {
    if (ethers.getAddress(log.address) !== expectedGateway) continue;
    if (!sameHex(log.topics?.[0], HXMSG_ACCEPTED_TOPIC)) continue;
    const accepted = parseHXMsgAcceptedLog(log);
    if (!requestID || sameHex(accepted.requestID, requestID)) return { log, accepted };
  }
  throw new Error('authorized HXMsgAccepted log not found');
}

function computeAcceptedEventHash(accepted) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'address', 'bytes32', 'bytes32', 'bytes32'],
      [accepted.requestID, accepted.clusterID, accepted.target, accepted.hmsgDigest,
        accepted.targetExecutionHash, accepted.resultHash]
    )
  );
}

function computeEvmExecutionProofRef({ receipt, log, accepted, chainType, chainID, domainID, gatewayAddress }) {
  const transactionHash = receipt.transactionHash || receipt.hash;
  const transactionIndex = Number(receipt.transactionIndex ?? receipt.index ?? 0);
  const logIndex = Number(log.logIndex ?? log.index);
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint8', 'bytes32', 'bytes32', 'address', 'bytes32', 'uint64', 'uint32', 'uint32', 'bytes32'],
      [EVM_EXECUTION_PROOF_V2, Number(chainType), chainID, domainID, ethers.getAddress(gatewayAddress),
        transactionHash, Number(receipt.blockNumber), transactionIndex, logIndex, computeAcceptedEventHash(accepted)]
    )
  );
}

function buildFabricExecutionRecordHash(record) {
  return ethers.keccak256(ethers.toUtf8Bytes(stableStringify({
    requestID: record.requestID,
    txId: record.txId || '',
    hmsgDigest: record.hmsgDigest || ethers.ZeroHash,
    targetChainType: Number(record.targetChainType || 0),
    targetChainID: record.targetChainID || ethers.ZeroHash,
    targetDomainID: record.targetDomainID || ethers.ZeroHash,
    targetObject: record.targetObject || ethers.ZeroHash,
    targetExecutionHash: record.targetExecutionHash || ethers.ZeroHash,
    status: record.status,
    businessKey: record.businessKey || '',
    businessStatus: record.businessStatus || '',
  })));
}

function computeFabricExecutionResultHash(record) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [FABRIC_EXECUTION_RESULT_V1, record.requestID, record.targetExecutionHash,
        ethers.keccak256(ethers.toUtf8Bytes(String(record.businessKey || ''))),
        ethers.keccak256(ethers.toUtf8Bytes(String(record.businessStatus || record.status || '')))]
    )
  );
}

function computeFabricExecutionProofRef({
  record,
  chainID,
  domainID,
  channelID,
  chaincodeName,
  policyHash,
}) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [FABRIC_EXECUTION_PROOF_V2, chainID, domainID,
        ethers.keccak256(ethers.toUtf8Bytes(`${channelID}/${chaincodeName}`)),
        policyHash, buildFabricExecutionRecordHash(record)]
    )
  );
}

module.exports = {
  EVM_EXECUTION_PROOF_V2,
  FABRIC_EXECUTION_PROOF_V2,
  HXMSG_ACCEPTED_EVENT,
  HXMSG_ACCEPTED_TOPIC,
  parseHXMsgAcceptedLog,
  findHXMsgAcceptedLog,
  computeEvmExecutionProofRef,
  buildFabricExecutionRecordHash,
  computeFabricExecutionResultHash,
  computeFabricExecutionProofRef,
};
