const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');
const { FeedbackType, AtomicityMode, CommitmentType, ResponseStatus, computeResponseDigest } = require('../shared/hxmsg');
const { buildSimulatedAttestationIdentity, evmRegistrationTuple } = require('../shared/tee/attestation');
const { signCommittedDigest, buildQuorumCertificate } = require('../shared/tee/quorum-certificate');
const { clusterCertificateTuple } = require('../shared/tee/registration');

const ROOT = path.join(__dirname, '..');
const RUNTIME = path.join(ROOT, 'runtime');
const PRIVATE_KEY = process.env.AVALANCHE_PRIVATE_KEY
  || '0x56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027';
const CLUSTER_ID = ethers.id('HXMSG_TEE_CLUSTER_LOCAL_V1');

function artifact(source, name = source) {
  return fs.readJsonSync(path.join(ROOT, 'artifacts', 'contracts', `${source}.sol`, `${name}.json`));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function gas(receipt) { return Number(receipt.gasUsed || 0n); }

async function advanceAvalancheTime(owner, milliseconds) {
  await sleep(milliseconds);
  // AvalancheGo 按新区块更新时间；零值交易只用于让节点产生带当前时间戳的真实区块。
  await (await owner.sendTransaction({ to: await owner.getAddress(), value: 0n })).wait();
}

function responseTuple(response) {
  return [response.originRequestID, response.originHmsgDigest, response.responseStatus,
    response.targetExecutionHash, response.targetProofRefHash, response.responsePayloadHash];
}

async function certificate(identities, digest) {
  const signatures = identities.map(({ wallet, identity }, index) => signCommittedDigest({
    privateKey: wallet.privateKey,
    nodeID: identity.nodeID,
    identity,
    committedEntry: {
      requestID: ethers.ZeroHash,
      hmsgDigest: digest,
      signingDigest: digest,
      signatureDigestType: 'responseDigest',
      term: 1,
      index: index + 1,
    },
  }));
  return clusterCertificateTuple(buildQuorumCertificate({
    signatures,
    clusterID: CLUSTER_ID,
    epoch: 1,
    threshold: 2,
    signingDigest: digest,
    signatureDigestType: 'responseDigest',
    term: 1,
    index: 3,
  }));
}

async function submit(source, policy, suffix, escrow) {
  const now = Math.floor(Date.now() / 1000);
  const callData = ethers.toUtf8Bytes(`avalanche-lifecycle-${suffix}`);
  const common = [
    ethers.id('fabric:mychannel'),
    ethers.id('fabric-local-domain'),
    ethers.id('fabric:mychannel:xcall'),
    ethers.id('ExecuteHXMsg(bytes32,bytes)').slice(0, 10),
    callData,
    ethers.id(`business-${suffix}`),
    ethers.id('fabric-receiver'),
    now + 3600,
    ethers.id('avalanche-local-validator-policy'),
    policy,
  ];
  const tx = escrow
    ? await source.submitTokenEscrowWarpHXMsgRequest(...common, escrow.token, escrow.amount)
    : await source.submitWarpHXMsgRequest(...common);
  const receipt = await tx.wait();
  const event = receipt.logs.map((log) => {
    try { return source.interface.parseLog(log); } catch (_) { return null; }
  }).find((item) => item?.name === 'AvalancheHXMsgWarpRequested');
  if (!event) throw new Error('AvalancheHXMsgWarpRequested event not found');
  return { requestID: event.args.requestID, receipt };
}

async function main() {
  const startedAt = Date.now();
  const deployment = fs.readJsonSync(path.join(RUNTIME, 'avalanche-deployment.json'));
  const provider = new ethers.JsonRpcProvider(process.env.AVALANCHE_RPC_URL || deployment.rpcURL);
  const baseOwner = new ethers.Wallet(PRIVATE_KEY, provider);
  const owner = new ethers.NonceManager(baseOwner);
  const ownerAddress = baseOwner.address;
  // 生命周期回归使用独立合约，避免临时 TEE 身份污染业务实验的 Registry。
  const registryArtifact = artifact('TEERegistry');
  const registry = await new ethers.ContractFactory(registryArtifact.abi, registryArtifact.bytecode, owner).deploy();
  await registry.waitForDeployment();
  const sourceArtifact = artifact('AvalancheWarpSourceContract');
  const source = await new ethers.ContractFactory(sourceArtifact.abi, sourceArtifact.bytecode, owner)
    .deploy(await registry.getAddress());
  await source.waitForDeployment();

  const identities = [];
  for (let i = 0; i < 3; i += 1) {
    const wallet = ethers.Wallet.createRandom();
    const identity = buildSimulatedAttestationIdentity({
      privateKey: wallet.privateKey,
      nodeID: `avalanche-lifecycle-tee-${i + 1}`,
      signerIndex: i,
    });
    identities.push({ wallet, identity });
    await (await registry.registerTEE(evmRegistrationTuple(identity))).wait();
  }

  const responseNow = Math.floor(Date.now() / 1000);
  const responsePolicy = [true, FeedbackType.RESPONSE, responseNow + 120, ethers.ZeroHash,
    [false, 0, CommitmentType.NONE, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 0]];
  const responseRequest = await submit(source, responsePolicy, 'response-only');
  let responseRecord = await source.requests(responseRequest.requestID);
  let nonAtomicChallengeRejected = false;
  try { await source.startChallenge.staticCall(responseRequest.requestID); } catch (_) { nonAtomicChallengeRejected = true; }
  const response = {
    originRequestID: responseRequest.requestID,
    originHmsgDigest: ethers.id('avalanche-origin-hxmsg'),
    responseStatus: ResponseStatus.EXECUTED,
    targetExecutionHash: responseRecord.targetExecutionHash,
    targetProofRefHash: ethers.id('fabric-view-response-proof'),
    responsePayloadHash: ethers.id('fabric-response-payload'),
  };
  const digest = computeResponseDigest(response);
  const completeReceipt = await (await source.completeWithResponse(
    responseRequest.requestID, responseTuple(response), await certificate(identities, digest))).wait();
  responseRecord = await source.requests(responseRequest.requestID);

  const tokenFactory = new ethers.ContractFactory(artifact('CrossChainToken').abi,
    artifact('CrossChainToken').bytecode, owner);
  const token = await tokenFactory.deploy('Avalanche Escrow Token', 'AET', 4, ownerAddress);
  await token.waitForDeployment();
  const amount = 250000n;
  await (await token.mint(ownerAddress, amount)).wait();
  await (await token.approve(await source.getAddress(), amount)).wait();
  const failureData = ethers.toUtf8Bytes('avalanche-token-refund');
  const atomicNow = Math.floor(Date.now() / 1000);
  const atomicPolicy = [true, FeedbackType.RESPONSE, atomicNow + 2, ethers.ZeroHash,
    [true, AtomicityMode.COMMIT_OR_COMPENSATE, CommitmentType.TOKEN_ESCROW,
      ethers.id('avalanche-token-escrow'), ethers.id('avalanche-token-success'),
      ethers.keccak256(failureData), 2]];
  const escrowRequest = await submit(source, atomicPolicy, 'escrow-refund', {
    token: await token.getAddress(), amount,
  });
  const lockedBalance = await token.balanceOf(await source.getAddress());
  await advanceAvalancheTime(owner, 4000);
  const challengeReceipt = await (await source.startChallenge(escrowRequest.requestID)).wait();
  await advanceAvalancheTime(owner, 4000);
  const refundReceipt = await (await source.compensateAfterChallenge(escrowRequest.requestID, failureData)).wait();
  const finalEscrow = await source.tokenEscrows(escrowRequest.requestID);
  const finalRecord = await source.requests(escrowRequest.requestID);
  const ownerBalance = await token.balanceOf(ownerAddress);

  const result = {
    testType: 'avalanche-source-response-lifecycle',
    pass: Number(responseRecord.status) === 3 && nonAtomicChallengeRejected
      && Number(finalRecord.status) === 4 && finalEscrow.refunded
      && lockedBalance === amount && ownerBalance === amount,
    responseOnly: {
      requestID: responseRequest.requestID,
      status: Number(responseRecord.status),
      nonAtomicChallengeRejected,
      gas: { submit: gas(responseRequest.receipt), complete: gas(completeReceipt) },
    },
    tokenEscrowCompensation: {
      requestID: escrowRequest.requestID,
      status: Number(finalRecord.status),
      lockedBalance: lockedBalance.toString(),
      ownerBalanceAfterRefund: ownerBalance.toString(),
      refunded: finalEscrow.refunded,
      gas: { submit: gas(escrowRequest.receipt), challenge: gas(challengeReceipt), refund: gas(refundReceipt) },
    },
    elapsedMs: Date.now() - startedAt,
    testedAt: new Date().toISOString(),
  };
  fs.writeJsonSync(path.join(RUNTIME, 'avalanche-response-lifecycle-result.json'), result, { spaces: 2 });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
