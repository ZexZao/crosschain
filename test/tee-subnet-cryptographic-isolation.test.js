const { expect } = require('chai');
const { ethers } = require('hardhat');
const { buildSimulatedAttestationIdentity, evmRegistrationTuple } = require('../shared/tee/attestation');
const { signCommittedDigest, buildQuorumCertificate } = require('../shared/tee/quorum-certificate');
const { clusterIDForSubnet, subnetSigningDigest } = require('../shared/tee/domains');
const { clusterCertificateTuple } = require('../shared/tee/registration');
const {
  computeHXMsgDeliveryDigest,
  computeTargetExecutionHash,
  computeEvmExecutionDomainID,
} = require('../shared/hxmsg');

const EPOCH = 1;
const EVM_SOURCE = 1;
const FABRIC_SOURCE = 2;
const AVALANCHE_SOURCE = 3;
const EVM_CLUSTER = clusterIDForSubnet('ethereum-proof-subnet');
const FABRIC_CLUSTER = clusterIDForSubnet('fabric-proof-subnet');
const AVALANCHE_CLUSTER = clusterIDForSubnet('avalanche-proof-subnet');
const EVM_CHAIN_ID = ethers.zeroPadValue(ethers.toBeHex(31337), 32);
const FABRIC_CHAIN_ID = ethers.id('fabric-mychannel');
const AVALANCHE_CHAIN_ID = ethers.zeroPadValue(ethers.toBeHex(43112), 32);

function key(number) {
  return ethers.zeroPadValue(ethers.toBeHex(number), 32);
}

function identity({ privateKey, signerIndex, subnetID, subnetProfile, clusterID }) {
  return buildSimulatedAttestationIdentity({
    privateKey,
    signerIndex,
    nodeID: `${subnetProfile}-${signerIndex + 1}`,
    subnetID,
    subnetProfile,
    clusterID,
    epoch: EPOCH,
  });
}

function certificate({ identities, clusterID, sourceChainType, sourceChainID, subjectDigest }) {
  const signingDigest = subnetSigningDigest({
    clusterID,
    epoch: EPOCH,
    sourceChainType,
    sourceChainID,
    subjectDigest,
  });
  const committedEntry = {
    requestID: ethers.id('subnet-test'),
    hmsgDigest: subjectDigest,
    subjectDigest,
    signingDigest,
    signatureDigestType: 'deliveryDigest',
    term: 1,
    index: 1,
  };
  const signatures = identities.map(({ privateKey, identity: teeIdentity }, index) => signCommittedDigest({
    privateKey,
    nodeID: `node-${index + 1}`,
    identity: teeIdentity,
    committedEntry,
  }));
  return buildQuorumCertificate({
    signatures,
    clusterID,
    epoch: EPOCH,
    threshold: 2,
    subjectDigest,
    signingDigest,
    sourceChainType,
    sourceChainID,
    signatureDigestType: 'deliveryDigest',
    term: 1,
    index: 1,
  });
}

describe('TEE subnet cryptographic isolation', function () {
  it('binds registration, quorum certificates, and delivery to one source-chain subnet', async function () {
    const [owner, target] = await ethers.getSigners();
    const Registry = await ethers.getContractFactory('TEERegistry');
    const registry = await Registry.deploy();
    const Gateway = await ethers.getContractFactory('HXMsgGateway');
    const gateway = await Gateway.deploy(await registry.getAddress(), 1);

    const evmMembers = [1, 2, 3].map((number, signerIndex) => {
      const privateKey = key(number);
      return {
        privateKey,
        identity: identity({ privateKey, signerIndex, subnetID: 'ethereum-proof-subnet',
          subnetProfile: 'ethereum', clusterID: EVM_CLUSTER }),
      };
    });
    const fabricMembers = [6, 7, 8].map((number, signerIndex) => {
      const privateKey = key(number);
      return {
        privateKey,
        identity: identity({ privateKey, signerIndex, subnetID: 'fabric-proof-subnet',
          subnetProfile: 'fabric', clusterID: FABRIC_CLUSTER }),
      };
    });
    const avalancheMembers = [11, 12, 13].map((number, signerIndex) => {
      const privateKey = key(number);
      return {
        privateKey,
        identity: identity({ privateKey, signerIndex, subnetID: 'avalanche-proof-subnet',
          subnetProfile: 'avalanche', clusterID: AVALANCHE_CLUSTER }),
      };
    });
    for (const member of [...evmMembers, ...fabricMembers, ...avalancheMembers]) {
      await registry.registerTEE(evmRegistrationTuple(member.identity));
    }

    const reusedKey = identity({
      privateKey: evmMembers[0].privateKey,
      signerIndex: 4,
      subnetID: 'fabric-proof-subnet',
      subnetProfile: 'fabric',
      clusterID: FABRIC_CLUSTER,
    });
    await expect(registry.registerTEE(evmRegistrationTuple(reusedKey)))
      .to.be.revertedWith('TEE key already assigned to another subnet');

    const targetAddress = await target.getAddress();
    const targetObject = ethers.zeroPadValue(targetAddress, 32);
    const requestID = ethers.id('isolated-delivery');
    const compactCall = [1, ethers.id('record'), ethers.id('actor'), owner.address, 1, ethers.id('metadata'), false];
    const callDataHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint16', 'bytes32', 'bytes32', 'address', 'int256', 'bytes32', 'bool'], compactCall
    ));
    const functionSelector = ethers.id(
      'executeCompact(bytes32,(uint16,bytes32,bytes32,address,int256,bytes32,bool))'
    ).slice(0, 10);
    const targetDomainID = computeEvmExecutionDomainID({
      chainType: EVM_SOURCE,
      chainID: EVM_CHAIN_ID,
      gatewayAddress: await gateway.getAddress(),
    });
    const targetExecutionHash = computeTargetExecutionHash({
      requestID,
      targetChainType: EVM_SOURCE,
      targetChainID: EVM_CHAIN_ID,
      targetDomainID,
      targetObject,
      functionSelector,
      callDataHash,
      receiver: targetObject,
    });
    const minimal = [
      requestID, ethers.id('canonical-hxmsg'), 1, EVM_CHAIN_ID, 1, targetObject, functionSelector,
      callDataHash, targetObject, targetExecutionHash, false, 0, 0, ethers.ZeroHash,
      Math.floor(Date.now() / 1000) + 3600, ethers.id('replay-scope'), 1, EVM_SOURCE, EVM_CHAIN_ID,
      targetDomainID,
    ];
    const subjectDigest = computeHXMsgDeliveryDigest(minimal);
    const fabricCertificate = certificate({ identities: fabricMembers, clusterID: FABRIC_CLUSTER,
      sourceChainType: FABRIC_SOURCE, sourceChainID: FABRIC_CHAIN_ID, subjectDigest });
    await expect(gateway.executeHXMsgMinimalCompactCluster(
      minimal, targetAddress, compactCall, clusterCertificateTuple(fabricCertificate)
    )).to.be.revertedWith('wrong source TEE subnet');

    const avalancheCertificate = certificate({ identities: avalancheMembers, clusterID: AVALANCHE_CLUSTER,
      sourceChainType: AVALANCHE_SOURCE, sourceChainID: AVALANCHE_CHAIN_ID, subjectDigest });
    await expect(gateway.executeHXMsgMinimalCompactCluster(
      minimal, targetAddress, compactCall, clusterCertificateTuple(avalancheCertificate)
    )).to.be.revertedWith('wrong source TEE subnet');

    const evmCertificate = certificate({ identities: evmMembers, clusterID: EVM_CLUSTER,
      sourceChainType: EVM_SOURCE, sourceChainID: EVM_CHAIN_ID, subjectDigest });
    await expect(gateway.executeHXMsgMinimalCompactCluster(
      minimal, targetAddress, compactCall, clusterCertificateTuple(evmCertificate)
    )).to.emit(gateway, 'HXMsgAccepted').withArgs(
      requestID,
      EVM_CLUSTER,
      targetAddress,
      minimal[1],
      targetExecutionHash,
      ethers.keccak256('0x')
    );

    const wrongDomain = [...minimal];
    wrongDomain[0] = ethers.id('wrong-domain-delivery');
    wrongDomain[15] = ethers.id('wrong-domain-replay-scope');
    wrongDomain[16] = 2;
    wrongDomain[19] = ethers.id('attacker-gateway-domain');
    await expect(gateway.executeHXMsgMinimalCompactCluster(
      wrongDomain, targetAddress, compactCall, clusterCertificateTuple(evmCertificate)
    )).to.be.revertedWith('wrong target execution domain');
  });
});
