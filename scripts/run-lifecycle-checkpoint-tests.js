const fs = require('fs-extra');
const path = require('path');
const { ethers, network } = require('hardhat');
const { buildSimulatedAttestationIdentity, evmRegistrationTuple } = require('../shared/tee/attestation');
const { signCommittedDigest, buildQuorumCertificate } = require('../shared/tee/quorum-certificate');
const { clusterCertificateTuple } = require('../shared/tee/registration');
const { CommitmentType, AtomicityMode, FeedbackType, computeLifecycleTerminalRoot } = require('../shared/hxmsg');
const { clusterIDForSubnet, subnetSigningDigest } = require('../shared/tee/domains');

const CLUSTER_ID = clusterIDForSubnet('ethereum-proof-subnet');

async function increaseTime(seconds) {
  await network.provider.send('evm_increaseTime', [seconds]);
  await network.provider.send('evm_mine');
}

async function main() {
  const [deployer, outsider] = await ethers.getSigners();
  const Registry = await ethers.getContractFactory('TEERegistry');
  const registry = await Registry.deploy();
  const Source = await ethers.getContractFactory('EvmSourceContract');
  const source = await Source.deploy(await registry.getAddress());
  const Token = await ethers.getContractFactory('CrossChainToken');
  const token = await Token.deploy('Checkpoint Token', 'CPT', 4, deployer.address);

  const identities = [];
  for (let index = 0; index < 5; index += 1) {
    const wallet = ethers.Wallet.createRandom();
    const identity = buildSimulatedAttestationIdentity({
      privateKey: wallet.privateKey,
      nodeID: `checkpoint-tee-${index + 1}`,
      signerIndex: index,
      subnetID: 'ethereum-proof-subnet',
      subnetProfile: 'ethereum',
      clusterID: CLUSTER_ID,
    });
    identities.push({ wallet, identity });
    await (await registry.registerTEE(evmRegistrationTuple(identity))).wait();
  }

  const latest = await ethers.provider.getBlock('latest');
  const failureData = ethers.toUtf8Bytes('checkpoint-refund');
  const policy = [
    true,
    FeedbackType.RESPONSE,
    Number(latest.timestamp) + 30,
    ethers.ZeroHash,
    [
      true,
      AtomicityMode.COMMIT_OR_COMPENSATE,
      CommitmentType.TOKEN_ESCROW,
      ethers.id('checkpoint-escrow'),
      ethers.id('checkpoint-success'),
      ethers.keccak256(failureData),
      2,
    ],
  ];
  const amount = 100_000n;
  await (await token.mint(deployer.address, amount)).wait();
  await (await token.approve(await source.getAddress(), amount)).wait();
  const tx = await source.submitTokenEscrowHXMsgRequest(
    2, ethers.id('fabric-mychannel'), ethers.id('fabric-domain'), ethers.id('xcall'),
    '0x12345678', ethers.id('call'), ethers.id('business'), ethers.id('receiver'),
    Number(latest.timestamp) + 3600, policy, await token.getAddress(), amount
  );
  const receipt = await tx.wait();
  const event = receipt.logs.map((log) => {
    try { return source.interface.parseLog(log); } catch (_error) { return null; }
  }).find((item) => item?.name === 'CrossChainCallRequested');
  const requestID = event.args.requestID;

  let unauthorizedRejected = false;
  await increaseTime(35);
  try { await source.connect(outsider).startChallenge(requestID); } catch (_error) { unauthorizedRejected = true; }
  await (await source.startChallenge(requestID)).wait();
  await increaseTime(3);
  await (await source.compensateAfterChallenge(requestID, failureData)).wait();

  const record = await source.requests(requestID);
  const escrow = await source.tokenEscrows(requestID);
  const records = [{
    requestID,
    status: Number(record.status),
    commitmentType: Number(record.commitmentType),
    targetExecutionHash: record.targetExecutionHash,
    failureActionHash: record.failureActionHash,
    responseDigest: record.responseDigest,
    escrowRefunded: escrow.refunded,
    escrowSettled: escrow.settled,
  }];
  const expectedRoot = computeLifecycleTerminalRoot(records);
  const preview = await source.previewLifecycleCheckpoint([requestID]);
  if (preview.terminalStateRoot !== expectedRoot) throw new Error('checkpoint root mismatch');

  const sourceChainID = ethers.zeroPadValue(ethers.toBeHex((await ethers.provider.getNetwork()).chainId), 32);
  const scopedDigest = subnetSigningDigest({ clusterID: CLUSTER_ID, epoch: 1, sourceChainType: 1,
    sourceChainID, subjectDigest: preview.signingDigest });
  const signatures = identities.slice(0, 3).map(({ wallet, identity }) => signCommittedDigest({
    privateKey: wallet.privateKey,
    nodeID: identity.nodeID,
    identity,
    committedEntry: {
      requestID,
      hmsgDigest: preview.signingDigest,
      subjectDigest: preview.signingDigest,
      signingDigest: scopedDigest,
      signatureDigestType: 'lifecycleCheckpointDigest',
      term: 1,
      index: 1,
    },
  }));
  const cert = buildQuorumCertificate({
    signatures,
    clusterID: CLUSTER_ID,
    epoch: 1,
    threshold: 3,
    subjectDigest: preview.signingDigest,
    signingDigest: scopedDigest,
    sourceChainType: 1,
    sourceChainID,
    signatureDigestType: 'lifecycleCheckpointDigest',
    term: 1,
    index: 1,
  });
  const checkpointReceipt = await (await source.updateLifecycleCheckpoint(
    [requestID], preview.terminalStateRoot, clusterCertificateTuple(cert)
  )).wait();
  const cleared = await source.requests(requestID);
  const clearedEscrow = await source.tokenEscrows(requestID);
  const result = {
    testType: 'lifecycle-checkpoint-and-watcher-authorization',
    testedAt: new Date().toISOString(),
    pass: unauthorizedRejected && Number(cleared.status) === 0 && clearedEscrow.token === ethers.ZeroAddress,
    unauthorizedWatcherRejected: unauthorizedRejected,
    checkpointEpoch: Number(await source.lifecycleCheckpointEpoch()),
    checkpointRoot: await source.latestLifecycleCheckpointRoot(),
    terminalStateRoot: preview.terminalStateRoot,
    requestCleared: Number(cleared.status) === 0,
    escrowCleared: clearedEscrow.token === ethers.ZeroAddress,
    checkpointGas: Number(checkpointReceipt.gasUsed),
  };
  const output = path.join(__dirname, '..', 'runtime', 'lifecycle-checkpoint-test-result.json');
  await fs.writeJson(output, result, { spaces: 2 });
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
