const { ethers } = require('ethers');
const { EvmLogScanner } = require('../evm/scanner-base');

const EVENT = 'event AvalancheHXMsgWarpRequested(bytes32 indexed requestID,bytes32 indexed warpMessageID,address indexed sender,uint8 targetChainType,bytes32 targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bytes32 validatorPolicyHash,bytes32 feedbackHash,bytes32 atomicityHash)';
const iface = new ethers.Interface([EVENT]);
const topic = iface.getEvent('AvalancheHXMsgWarpRequested').topicHash;

function parseAvalancheLog(log) {
  const args = iface.parseLog(log).args;
  return {
    requestID: args.requestID,
    warpMessageID: args.warpMessageID,
    sender: args.sender,
    targetChainType: Number(args.targetChainType),
    targetChainID: args.targetChainID,
    targetDomainID: args.targetDomainID,
    targetObject: args.targetObject,
    functionSelector: args.functionSelector,
    callDataHash: args.callDataHash,
    businessPayloadHash: args.businessPayloadHash,
    receiver: args.receiver,
    nonce: Number(args.nonce),
    expireAt: Number(args.expireAt),
    validatorPolicyHash: args.validatorPolicyHash,
    feedbackHash: args.feedbackHash,
    atomicityHash: args.atomicityHash,
  };
}

class AvalancheEventScanner extends EvmLogScanner {
  constructor(options) {
    super({
      ...options,
      topic,
      parseLog: parseAvalancheLog,
      eventType: 'AVALANCHE_WARP_REQUEST',
    });
  }
}

module.exports = { AvalancheEventScanner, AVALANCHE_WARP_EVENT: EVENT };
