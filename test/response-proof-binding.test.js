const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const {
  ChainType,
  HXMSG_ACCEPTED_EVENT,
  findHXMsgAcceptedLog,
  computeEvmExecutionDomainID,
  computeEvmExecutionProofRef,
  computeFabricExecutionDomainID,
  computeFabricExecutionProofRef,
  computeFabricExecutionResultHash,
  buildDefaultFabricResponseHFsvPolicy,
  bytes32FromText,
  hashJson,
} = require('../shared/hxmsg');

const acceptedInterface = new ethers.Interface([HXMSG_ACCEPTED_EVENT]);

function acceptedLog({ gateway, requestID, index = 0 }) {
  const values = [
    requestID,
    ethers.id('fabric-proof-subnet'),
    '0x00000000000000000000000000000000000000a1',
    ethers.id('canonical-h-xmsg'),
    ethers.id('target-execution'),
    ethers.id('execution-result'),
  ];
  const encoded = acceptedInterface.encodeEventLog(acceptedInterface.getEvent('HXMsgAccepted'), values);
  return { address: gateway, topics: encoded.topics, data: encoded.data, index, logIndex: index };
}

test('EVM ResponseProof binds the authorized gateway and exact accepted log', () => {
  const requestID = ethers.id('response-request');
  const gateway = '0x0000000000000000000000000000000000000101';
  const attackerGateway = '0x0000000000000000000000000000000000000202';
  const receipt = {
    hash: ethers.id('target-transaction'),
    blockNumber: 42,
    index: 3,
    logs: [
      acceptedLog({ gateway: attackerGateway, requestID, index: 5 }),
      acceptedLog({ gateway, requestID, index: 6 }),
    ],
  };
  const chainID = ethers.zeroPadValue(ethers.toBeHex(31337), 32);
  const domainID = computeEvmExecutionDomainID({
    chainType: ChainType.EVM,
    chainID,
    gatewayAddress: gateway,
  });
  const { log, accepted } = findHXMsgAcceptedLog({ receipt, gatewayAddress: gateway, requestID });
  assert.equal(log.index, 6);

  const proofRef = computeEvmExecutionProofRef({
    receipt,
    log,
    accepted,
    chainType: ChainType.EVM,
    chainID,
    domainID,
    gatewayAddress: gateway,
  });
  const wrongGatewayRef = computeEvmExecutionProofRef({
    receipt,
    log: receipt.logs[0],
    accepted: findHXMsgAcceptedLog({ receipt, gatewayAddress: attackerGateway, requestID }).accepted,
    chainType: ChainType.EVM,
    chainID,
    domainID: computeEvmExecutionDomainID({
      chainType: ChainType.EVM,
      chainID,
      gatewayAddress: attackerGateway,
    }),
    gatewayAddress: attackerGateway,
  });
  assert.notEqual(proofRef, wrongGatewayRef);
  assert.throws(
    () => findHXMsgAcceptedLog({
      receipt: { ...receipt, logs: [receipt.logs[0]] },
      gatewayAddress: gateway,
      requestID,
    }),
    /authorized HXMsgAccepted log not found/
  );
});

test('Fabric ResponseProof binds chain, chaincode domain, policy, and execution result', () => {
  const chainID = bytes32FromText('fabric-mychannel');
  const targetObject = bytes32FromText('xcall');
  const domainID = computeFabricExecutionDomainID({ chainID, targetObject });
  const record = {
    requestID: ethers.id('fabric-response-request'),
    txId: 'fabric-target-tx',
    hmsgDigest: ethers.id('canonical-h-xmsg'),
    targetChainType: ChainType.FABRIC,
    targetChainID: chainID,
    targetDomainID: domainID,
    targetObject,
    targetExecutionHash: ethers.id('fabric-target-execution'),
    status: 'executed',
    businessKey: 'asset:42',
    businessStatus: 'transferred',
  };
  const policy = buildDefaultFabricResponseHFsvPolicy({ channelID: 'mychannel', chaincodeName: 'xcall' });
  const proofRef = computeFabricExecutionProofRef({
    record,
    chainID,
    domainID,
    channelID: 'mychannel',
    chaincodeName: 'xcall',
    policyHash: hashJson(policy),
  });
  const wrongDomainRef = computeFabricExecutionProofRef({
    record: { ...record, targetDomainID: ethers.id('attacker-chaincode-domain') },
    chainID,
    domainID: ethers.id('attacker-chaincode-domain'),
    channelID: 'mychannel',
    chaincodeName: 'attacker-chaincode',
    policyHash: hashJson(policy),
  });
  assert.notEqual(proofRef, wrongDomainRef);
  assert.notEqual(
    computeFabricExecutionResultHash(record),
    computeFabricExecutionResultHash({ ...record, businessStatus: 'failed' })
  );
});
