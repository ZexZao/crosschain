const test = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const {
  normalizeAnchor,
  selectPinnedSnapshot,
  assertProofMatchesTrustedSnapshot,
} = require('../shared/avalanche/pchain-trust');
const { validatorSetHash, decodeHXMsgWarpPayload } = require('../shared/avalanche/warp-proof');

function validator(index, weight = '100') {
  return {
    nodeID: `NodeID-${index}`,
    publicKey: ethers.hexlify(Uint8Array.from({ length: 48 }, () => index)),
    weight,
  };
}

function fixture() {
  const validators = [validator(1), validator(2), validator(3), validator(4), validator(5)];
  const totalWeight = validators.reduce((sum, item) => sum + BigInt(item.weight), 0n).toString();
  const anchor = normalizeAnchor({
    schemaVersion: 1,
    mode: 'genesis-pinned-local-node',
    staticValidatorSet: true,
    networkID: 1337,
    genesisHash: ethers.keccak256(ethers.toUtf8Bytes('genesis')),
    sourceChainIDs: [ethers.zeroPadValue('0x01', 32)],
    quorumNumerator: 67,
    quorumDenominator: 100,
    validatorSnapshots: [{
      pChainHeight: 10,
      validators,
      validatorSetHash: validatorSetHash(validators),
      totalWeight,
    }],
  });
  const snapshot = selectPinnedSnapshot(anchor, 11);
  const sourceProof = { networkID: 1337, sourceChainID: ethers.zeroPadValue('0x01', 32) };
  const validatorSetRef = {
    networkID: 1337,
    pChainHeight: 11,
    validatorSetHash: snapshot.validatorSetHash,
    totalWeight: snapshot.totalWeight,
    quorumNumerator: 67,
    quorumDenominator: 100,
    canonicalOrdering: 'nodeID-ascending',
  };
  return { anchor, snapshot, sourceProof, validatorSetRef, validators };
}

test('accepts a relayer proof that matches the genesis-pinned validator snapshot', () => {
  assert.doesNotThrow(() => assertProofMatchesTrustedSnapshot({ ...fixture(), suppliedValidatorSet: fixture().validators }));
});

test('rejects a self-consistent attacker validator set', () => {
  const input = fixture();
  const fakeValidators = [validator(11), validator(12), validator(13)];
  input.validatorSetRef = {
    ...input.validatorSetRef,
    validatorSetHash: validatorSetHash(fakeValidators),
    totalWeight: '300',
  };
  assert.throws(
    () => assertProofMatchesTrustedSnapshot({ ...input, suppliedValidatorSet: fakeValidators }),
    /does not match trusted P-Chain snapshot/
  );
});

test('rejects relayer-controlled quorum and source network', () => {
  const quorum = fixture();
  quorum.validatorSetRef.quorumNumerator = 1;
  assert.throws(() => assertProofMatchesTrustedSnapshot(quorum), /cannot override trusted Avalanche quorum/);

  const network = fixture();
  network.sourceProof.networkID = 9999;
  assert.throws(() => assertProofMatchesTrustedSnapshot(network), /not anchored to trusted P-Chain genesis/);
});

test('preserves the target chain type when decoding an h-xmsg Warp payload', () => {
  const tuple = 'tuple(bytes32 requestID,uint8 targetChainType,bytes32 targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bool feedbackRequired,uint8 expectedFeedbackMsgType,uint64 feedbackTimeout,bytes32 callbackRefHash,tuple(bool required,uint8 mode,uint8 commitmentType,bytes32 commitmentRefHash,bytes32 successActionHash,bytes32 failureActionHash,uint64 challengeWindow) atomicity,bytes32 validatorPolicyHash,bytes callData)';
  const value = {
    requestID: ethers.id('request'),
    targetChainType: 1,
    targetChainID: ethers.zeroPadValue('0xaa', 32),
    targetDomainID: ethers.id('target-domain'),
    targetObject: ethers.zeroPadValue('0xbb', 32),
    functionSelector: '0x12345678',
    callDataHash: ethers.id('call-data'),
    businessPayloadHash: ethers.id('business-payload'),
    receiver: ethers.zeroPadValue('0xcc', 32),
    nonce: 7,
    expireAt: 1000,
    feedbackRequired: false,
    expectedFeedbackMsgType: 0,
    feedbackTimeout: 0,
    callbackRefHash: ethers.ZeroHash,
    atomicity: [false, 0, 0, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 0],
    validatorPolicyHash: ethers.id('validator-policy'),
    callData: '0x1234',
  };
  const payload = ethers.AbiCoder.defaultAbiCoder().encode([tuple], [value]);
  const decoded = decodeHXMsgWarpPayload(payload);
  assert.equal(decoded.targetChainType, 1);
  assert.equal(decoded.targetChainID, value.targetChainID);
  assert.equal(decoded.targetDomainID, value.targetDomainID);
});
