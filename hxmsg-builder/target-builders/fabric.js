const { ethers } = require('ethers');
const {
  ChainType,
  ActionType,
  bytes32FromText,
  computeTargetExecutionHash,
  computeFabricExecutionDomainID,
} = require('../../shared/hxmsg');

const FABRIC_INVOKE_SELECTOR = ethers.id('ExecuteHXMsgCompact(bytes32,bytes)').slice(0, 10);

function buildFabricTargetObject(channelID, chaincodeName) {
  void channelID;
  return bytes32FromText(chaincodeName);
}

function buildFabricChaincodeTarget({
  channelID,
  chaincodeName,
  requestID,
  callDataHash,
  receiver,
  functionSelector = FABRIC_INVOKE_SELECTOR,
}) {
  const targetChainID = bytes32FromText(`fabric-${channelID}`);
  const targetObject = buildFabricTargetObject(channelID, chaincodeName);
  const targetDomainID = computeFabricExecutionDomainID({ chainID: targetChainID, targetObject });
  const resolvedReceiver = receiver || targetObject;
  const targetAction = {
    actionType: ActionType.CHAINCODE_INVOKE,
    targetObject,
    functionSelector,
    callDataHash,
    receiver: resolvedReceiver,
  };
  return {
    target: {
      chainType: ChainType.FABRIC,
      chainID: targetChainID,
      domainID: targetDomainID,
    },
    targetAction,
    targetExecutionHash: computeTargetExecutionHash({
      requestID,
      targetChainType: ChainType.FABRIC,
      targetChainID,
      targetDomainID,
      targetObject,
      functionSelector,
      callDataHash,
      receiver: resolvedReceiver,
    }),
  };
}

module.exports = {
  FABRIC_INVOKE_SELECTOR,
  buildFabricTargetObject,
  buildFabricChaincodeTarget,
};
