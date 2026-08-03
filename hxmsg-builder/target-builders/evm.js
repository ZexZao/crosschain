const { ethers } = require('ethers');
const {
  ChainType,
  ActionType,
  bytes32FromText,
  chainIdToBytes32,
  addressToBytes32,
  computeTargetExecutionHash,
} = require('../../shared/hxmsg');

const TARGET_EXECUTE_SELECTOR = ethers.id('executeCompact(bytes32,(uint16,bytes32,bytes32,address,int256,bytes32,bool))').slice(0, 10);

function buildEvmContractCallTarget({
  chainId,
  requestID,
  targetObject,
  targetAddress,
  functionSelector = TARGET_EXECUTE_SELECTOR,
  callDataHash,
  receiver,
  chainType = ChainType.EVM,
  domainID,
}) {
  const resolvedTargetObject = targetObject || addressToBytes32(targetAddress);
  const resolvedReceiver = receiver || resolvedTargetObject;
  const targetChainID = chainIdToBytes32(chainId);
  const targetAction = {
    actionType: ActionType.CONTRACT_CALL,
    targetObject: resolvedTargetObject,
    functionSelector,
    callDataHash,
    receiver: resolvedReceiver,
  };
  return {
    target: {
      chainType,
      chainID: targetChainID,
      domainID: domainID || bytes32FromText(`${chainType === ChainType.AVALANCHE ? 'avalanche' : 'evm'}-local-${chainId}`),
    },
    targetAction,
    targetExecutionHash: computeTargetExecutionHash({
      requestID,
      targetChainID,
      targetObject: resolvedTargetObject,
      functionSelector,
      callDataHash,
      receiver: resolvedReceiver,
    }),
  };
}

module.exports = {
  TARGET_EXECUTE_SELECTOR,
  buildEvmContractCallTarget,
};
