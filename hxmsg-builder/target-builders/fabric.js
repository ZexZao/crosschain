const { ethers } = require('ethers');
const {
  ChainType,
  ActionType,
  bytes32FromText,
  computeTargetExecutionHash,
} = require('../../shared/hxmsg');

const FABRIC_INVOKE_SELECTOR = ethers.id('ExecuteHXMsg(bytes32,bytes)').slice(0, 10);

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
      domainID: bytes32FromText('fabric-local-domain'),
    },
    targetAction,
    targetExecutionHash: computeTargetExecutionHash({
      requestID,
      targetChainID,
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
