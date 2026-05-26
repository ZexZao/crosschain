const { ethers } = require('ethers');
const {
  ChainType,
  ActionType,
  bytes32FromText,
  chainIdToBytes32,
  addressToBytes32,
  computeTargetExecutionHash,
} = require('../../shared/hxmsg');

const TARGET_EXECUTE_SELECTOR = ethers.id('execute(bytes32,bytes)').slice(0, 10);

function buildEvmContractCallTarget({
  chainId,
  requestID,
  targetObject,
  targetAddress,
  functionSelector = TARGET_EXECUTE_SELECTOR,
  callDataHash,
  receiver,
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
      chainType: ChainType.EVM,
      chainID: targetChainID,
      domainID: bytes32FromText(`evm-local-${chainId}`),
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
