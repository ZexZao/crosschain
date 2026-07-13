const { expect } = require('chai');
const { ethers, network } = require('hardhat');
const path = require('path');
const parentRoot = path.resolve(__dirname, '../../crosschain_experiment');
const { buildSimulatedAttestationIdentity, evmRegistrationTuple } = require(path.join(parentRoot, 'shared/tee/attestation'));
const { signCommittedDigest, buildQuorumCertificate } = require(path.join(parentRoot, 'shared/tee/quorum-certificate'));
const { clusterCertificateTuple } = require(path.join(parentRoot, 'shared/tee/registration'));

function certificate(signingDigest) {
  return {
    clusterID: ethers.ZeroHash,
    epoch: 1,
    threshold: 1,
    participantCount: 1,
    signerBitmap: 1,
    selectedSignerHash: ethers.ZeroHash,
    signatures: '0x',
    signingDigest,
    committedTerm: 1,
    committedIndex: 1,
  };
}

async function mineAfter(seconds) {
  await network.provider.send('evm_increaseTime', [seconds]);
  await network.provider.send('evm_mine');
}

async function fixture() {
  const [deployer, owner, treasury, receiver] = await ethers.getSigners();
  const Registry = await ethers.getContractFactory('MockTEERegistry');
  const registry = await Registry.deploy();
  const Token = await ethers.getContractFactory('MockERC20');
  const sourceToken = await Token.deploy('Source', 'SRC');
  const targetToken = await Token.deploy('Target', 'TGT');
  const pledge = ethers.parseEther('0.01');
  const Vault = await ethers.getContractFactory('MercuryVault');
  const vault = await Vault.deploy(await registry.getAddress(), treasury.address, pledge, 60);
  const Target = await ethers.getContractFactory('MercuryTargetVault');
  const target = await Target.deploy(await registry.getAddress());
  await sourceToken.mint(owner.address, 10_000n);
  await targetToken.mint(await target.getAddress(), 10_000n);
  await sourceToken.connect(owner).approve(await vault.getAddress(), ethers.MaxUint256);
  return { deployer, owner, treasury, receiver, registry, sourceToken, targetToken, vault, target, pledge };
}

async function createDeposit(ctx, suffix = '1', amount = 100n) {
  const block = await ethers.provider.getBlock('latest');
  const requestHash = ethers.id(`request-${suffix}`);
  const tx = await ctx.vault.connect(ctx.owner).createDeposit(
    await ctx.sourceToken.getAddress(),
    amount,
    requestHash,
    block.timestamp + 10
  );
  const receipt = await tx.wait();
  const event = receipt.logs
    .map((log) => {
      try { return ctx.vault.interface.parseLog(log); } catch (_error) { return null; }
    })
    .find((item) => item?.name === 'MercuryDepositCreated');
  return { depositID: event.args.depositID, requestHash, amount };
}

describe('MERCURY protocol state machine', function () {
  it('accepts only a 3-of-5 certificate from its isolated Mercury registry', async function () {
    const [, owner, treasury] = await ethers.getSigners();
    const clusterID = ethers.id('MERCURY_ETH_EOS_ABLATION_CLUSTER_V1');
    const Registry = await ethers.getContractFactory('MercuryTEERegistry');
    const registry = await Registry.deploy(clusterID);
    const identities = [];
    for (let i = 0; i < 5; i += 1) {
      const wallet = ethers.Wallet.createRandom();
      const identity = buildSimulatedAttestationIdentity({ privateKey: wallet.privateKey, nodeID: `mercury-tee-${i + 1}`, signerIndex: i });
      identities.push({ wallet, identity });
      await registry.registerTEE(evmRegistrationTuple(identity));
    }
    expect(await registry.quorumThreshold()).to.equal(3);
    const Token = await ethers.getContractFactory('MockERC20');
    const token = await Token.deploy('Source', 'SRC');
    const Vault = await ethers.getContractFactory('MercuryVault');
    const vault = await Vault.deploy(await registry.getAddress(), treasury.address, 0, 60);
    await token.mint(owner.address, 100n);
    await token.connect(owner).approve(await vault.getAddress(), 100n);
    const block = await ethers.provider.getBlock('latest');
    const requestHash = ethers.id('isolated-registry-request');
    const receipt = await (await vault.connect(owner).createDeposit(await token.getAddress(), 100n, requestHash, block.timestamp + 100)).wait();
    const event = receipt.logs.map((log) => { try { return vault.interface.parseLog(log); } catch (_error) { return null; } })
      .find((item) => item?.name === 'MercuryDepositCreated');
    const targetTxID = ethers.id('isolated-registry-target');
    const digest = await vault.confirmationDigest(event.args.depositID, requestHash, targetTxID);
    const signatures = identities.slice(0, 3).map(({ wallet, identity }) => signCommittedDigest({
      privateKey: wallet.privateKey,
      nodeID: identity.nodeID,
      identity,
      committedEntry: { requestID: event.args.depositID, hmsgDigest: digest, signingDigest: digest, term: 2, index: 7 },
    }));
    const cert = buildQuorumCertificate({ signatures, clusterID, epoch: 1, threshold: 3, signingDigest: digest, term: 2, index: 7 });
    await vault.confirmTransfer(event.args.depositID, targetTxID, clusterCertificateTuple(cert));
    expect(await vault.outcomes(event.args.depositID)).to.equal(1);
  });

  it('confirms a finalized target transfer and releases the source deposit to treasury', async function () {
    const ctx = await fixture();
    const dep = await createDeposit(ctx);
    const targetTxID = ethers.id('target-tx-1');
    const digest = await ctx.vault.confirmationDigest(dep.depositID, dep.requestHash, targetTxID);
    await expect(ctx.vault.confirmTransfer(dep.depositID, targetTxID, certificate(digest)))
      .to.emit(ctx.vault, 'MercuryDepositConfirmed');
    expect(await ctx.vault.outcomes(dep.depositID)).to.equal(1);
    expect((await ctx.vault.deposits(dep.depositID)).owner).to.equal(ethers.ZeroAddress);
    expect(await ctx.sourceToken.balanceOf(ctx.treasury.address)).to.equal(dep.amount);
  });

  it('returns the deposit and pledge when operators remain unavailable', async function () {
    const ctx = await fixture();
    const dep = await createDeposit(ctx);
    await mineAfter(11);
    await ctx.vault.connect(ctx.owner).startChallenge(dep.depositID, { value: ctx.pledge });
    await mineAfter(61);
    const before = await ctx.sourceToken.balanceOf(ctx.owner.address);
    await expect(ctx.vault.connect(ctx.owner).resolveChallenge(dep.depositID))
      .to.emit(ctx.vault, 'MercuryRefunded');
    expect(await ctx.sourceToken.balanceOf(ctx.owner.address)).to.equal(before + dep.amount);
    expect(await ctx.vault.outcomes(dep.depositID)).to.equal(2);
    expect(await ethers.provider.getBalance(await ctx.vault.getAddress())).to.equal(0);
  });

  it('forfeits a malicious/late challenge pledge when operators prove target completion', async function () {
    const ctx = await fixture();
    const dep = await createDeposit(ctx);
    await mineAfter(11);
    await ctx.vault.connect(ctx.owner).startChallenge(dep.depositID, { value: ctx.pledge });
    const targetTxID = ethers.id('target-tx-after-challenge');
    const digest = await ctx.vault.confirmationDigest(dep.depositID, dep.requestHash, targetTxID);
    const before = await ethers.provider.getBalance(ctx.treasury.address);
    await ctx.vault.confirmTransfer(dep.depositID, targetTxID, certificate(digest));
    expect(await ethers.provider.getBalance(ctx.treasury.address)).to.equal(before + ctx.pledge);
    expect(await ctx.sourceToken.balanceOf(ctx.treasury.address)).to.equal(dep.amount);
  });

  it('executes a quorum-certified target batch exactly once', async function () {
    const ctx = await fixture();
    const batchID = ethers.id('batch-1');
    const transfers = [{
      depositID: ethers.id('deposit-target-1'),
      token: await ctx.targetToken.getAddress(),
      receiver: ctx.receiver.address,
      amount: 250n,
    }];
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const transferSetHash = ethers.keccak256(coder.encode(
      ['tuple(bytes32 depositID,address token,address receiver,uint256 amount)[]'],
      [transfers]
    ));
    const digest = await ctx.target.batchDigest(batchID, transferSetHash);
    await expect(ctx.target.executeBatch(batchID, transfers, certificate(digest)))
      .to.emit(ctx.target, 'MercuryBatchExecuted');
    expect(await ctx.targetToken.balanceOf(ctx.receiver.address)).to.equal(250n);
    await expect(ctx.target.executeBatch(batchID, transfers, certificate(digest))).to.be.revertedWith('batch replay');
  });

  it('checkpoint-confirms an idSet and removes all corresponding deposits', async function () {
    const ctx = await fixture();
    const first = await createDeposit(ctx, 'checkpoint-1', 100n);
    const second = await createDeposit(ctx, 'checkpoint-2', 200n);
    const ids = [first.depositID, second.depositID];
    const checkpointID = ethers.id('checkpoint-1');
    const targetTxRoot = ethers.id('target-tx-root');
    const idSetHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes32[]'], [ids]));
    const digest = await ctx.vault.checkpointDigest(checkpointID, targetTxRoot, idSetHash);
    await expect(ctx.vault.updateCheckpoint(checkpointID, targetTxRoot, ids, certificate(digest)))
      .to.emit(ctx.vault, 'MercuryCheckpointUpdated');
    expect(await ctx.vault.outcomes(first.depositID)).to.equal(1);
    expect(await ctx.vault.outcomes(second.depositID)).to.equal(1);
    expect(await ctx.sourceToken.balanceOf(ctx.treasury.address)).to.equal(300n);
  });
});
