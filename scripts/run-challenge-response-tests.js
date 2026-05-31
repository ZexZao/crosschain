const fs = require('fs-extra');
const path = require('path');
const { ethers, network } = require('hardhat');
const { computeResponseDigest, CommitmentType, AtomicityMode, FeedbackType, ResponseStatus } = require('../shared/hxmsg');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function gasOf(receipt) {
  return Number(receipt.gasUsed || 0n);
}

async function increaseTime(seconds) {
  await network.provider.send('evm_increaseTime', [seconds]);
  await network.provider.send('evm_mine');
}

function certFor(wallet, requestID, digest) {
  const signature = wallet.signingKey.sign(digest).serialized;
  return [requestID, digest, wallet.address, Math.floor(Date.now() / 1000), signature];
}

async function submitAtomic(source, params = {}) {
  const latest = await ethers.provider.getBlock('latest');
  const now = Number(latest.timestamp);
  const targetChainID = params.targetChainID || ethers.keccak256(ethers.toUtf8Bytes('fabric-mychannel'));
  const targetDomainID = params.targetDomainID || ethers.keccak256(ethers.toUtf8Bytes('fabric-local-domain'));
  const targetObject = params.targetObject || ethers.keccak256(ethers.toUtf8Bytes('fabric:mychannel:xcall'));
  const selector = params.selector || ethers.id('ExecuteHXMsg(bytes32,bytes)').slice(0, 10);
  const callDataHash = params.callDataHash || ethers.keccak256(ethers.toUtf8Bytes(`call-${Date.now()}-${Math.random()}`));
  const businessPayloadHash = params.businessPayloadHash || ethers.keccak256(ethers.toUtf8Bytes('payload'));
  const receiver = params.receiver || ethers.keccak256(ethers.toUtf8Bytes('receiver'));
  const failureData = params.failureData || `failure-${Date.now()}-${Math.random()}`;
  const failureActionHash = ethers.keccak256(ethers.toUtf8Bytes(failureData));
  const atomicity = [
    true,
    AtomicityMode.COMMIT_OR_COMPENSATE,
    params.commitmentType || CommitmentType.INTENT_ONLY,
    params.commitmentRefHash || ethers.keccak256(ethers.toUtf8Bytes('commitment')),
    params.successActionHash || ethers.keccak256(ethers.toUtf8Bytes('success')),
    failureActionHash,
    params.challengeWindow || 5,
  ];
  const tx = await source.submitHXMsgRequest(
    targetChainID,
    targetDomainID,
    targetObject,
    selector,
    callDataHash,
    businessPayloadHash,
    receiver,
    now + 3600,
    [true, FeedbackType.RESPONSE, now + 2, ethers.ZeroHash, atomicity]
  );
  const receipt = await tx.wait();
  const event = receipt.logs
    .map((log) => {
      try {
        return source.interface.parseLog(log);
      } catch (_error) {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === 'CrossChainCallRequested');
  const requestID = event.args.requestID;
  const record = await source.requests(requestID);
  return { requestID, record, failureData, submitGas: gasOf(receipt), submitTxHash: receipt.hash };
}

async function submitTokenEscrowAtomic(source, token, owner, params = {}) {
  const amount = BigInt(params.amount || 1000000n);
  await (await token.mint(owner.address, amount)).wait();
  await (await token.connect(owner).approve(await source.getAddress(), amount)).wait();
  const latest = await ethers.provider.getBlock('latest');
  const now = Number(latest.timestamp);
  const targetChainID = params.targetChainID || ethers.keccak256(ethers.toUtf8Bytes('fabric-mychannel'));
  const targetDomainID = params.targetDomainID || ethers.keccak256(ethers.toUtf8Bytes('fabric-local-domain'));
  const targetObject = params.targetObject || ethers.keccak256(ethers.toUtf8Bytes('fabric:mychannel:xcall'));
  const selector = params.selector || ethers.id('ExecuteHXMsg(bytes32,bytes)').slice(0, 10);
  const callDataHash = params.callDataHash || ethers.keccak256(ethers.toUtf8Bytes(`token-call-${Date.now()}-${Math.random()}`));
  const businessPayloadHash = params.businessPayloadHash || ethers.keccak256(ethers.toUtf8Bytes('token-payload'));
  const receiver = params.receiver || ethers.keccak256(ethers.toUtf8Bytes('token-receiver'));
  const failureData = params.failureData || `token-failure-${Date.now()}-${Math.random()}`;
  const failureActionHash = ethers.keccak256(ethers.toUtf8Bytes(failureData));
  const atomicity = [
    true,
    AtomicityMode.COMMIT_OR_COMPENSATE,
    CommitmentType.TOKEN_ESCROW,
    params.commitmentRefHash || ethers.keccak256(ethers.toUtf8Bytes('token-escrow')),
    params.successActionHash || ethers.keccak256(ethers.toUtf8Bytes('token-success')),
    failureActionHash,
    params.challengeWindow || 5,
  ];
  const tx = await source.connect(owner).submitTokenEscrowHXMsgRequest(
    targetChainID,
    targetDomainID,
    targetObject,
    selector,
    callDataHash,
    businessPayloadHash,
    receiver,
    now + 3600,
    [true, FeedbackType.RESPONSE, params.feedbackTimeout || now + (params.feedbackTimeoutOffset || 10), ethers.ZeroHash, atomicity],
    await token.getAddress(),
    amount
  );
  const receipt = await tx.wait();
  const event = receipt.logs
    .map((log) => {
      try {
        return source.interface.parseLog(log);
      } catch (_error) {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === 'CrossChainCallRequested');
  const requestID = event.args.requestID;
  const record = await source.requests(requestID);
  return { requestID, record, failureData, amount, submitGas: gasOf(receipt), submitTxHash: receipt.hash };
}

function buildResponse(requestID, record, overrides = {}) {
  const response = {
    originRequestID: requestID,
    originHmsgDigest: overrides.originHmsgDigest || ethers.ZeroHash,
    responseStatus: overrides.responseStatus || ResponseStatus.EXECUTED,
    targetExecutionHash: overrides.targetExecutionHash || record.targetExecutionHash,
    targetProofRefHash: overrides.targetProofRefHash || ethers.keccak256(ethers.toUtf8Bytes('target-proof')),
    responsePayloadHash: overrides.responsePayloadHash || ethers.keccak256(ethers.toUtf8Bytes('response-payload')),
  };
  response.digest = computeResponseDigest(response);
  return response;
}

function responseTuple(response) {
  return [
    response.originRequestID,
    response.originHmsgDigest,
    response.responseStatus,
    response.targetExecutionHash,
    response.targetProofRefHash,
    response.responsePayloadHash,
  ];
}

async function expectRevert(label, fn) {
  try {
    await fn();
    return { label, pass: false, error: 'expected revert but transaction succeeded' };
  } catch (error) {
    return { label, pass: true, error: error.message };
  }
}

async function main() {
  const suiteStartedMs = nowMs();
  fs.ensureDirSync(RUNTIME_DIR);
  const [deployer] = await ethers.getSigners();
  const TEERegistry = await ethers.getContractFactory('TEERegistry');
  const registry = await TEERegistry.deploy();
  await registry.waitForDeployment();
  const Source = await ethers.getContractFactory('EvmSourceContract');
  const source = await Source.deploy(await registry.getAddress());
  await source.waitForDeployment();
  const Token = await ethers.getContractFactory('CrossChainToken');
  const token = await Token.deploy('Escrow Test Token', 'ETT', 4, deployer.address);
  await token.waitForDeployment();

  const teeWallets = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
  for (const wallet of teeWallets) {
    await (await registry.registerTEE(wallet.address)).wait();
  }
  const threshold = 2;
  const cases = [];

  {
    const startedMs = nowMs();
    const test = { caseId: 'CR-EVM-001', name: 'Pending -> Completed', pass: false };
    const req = await submitAtomic(source);
    const response = buildResponse(req.requestID, req.record);
    const certs = teeWallets.slice(0, threshold).map((wallet) => certFor(wallet, req.requestID, response.digest));
    const completeReceipt = await (await source.completeWithResponse(req.requestID, responseTuple(response), certs, threshold)).wait();
    const finalRecord = await source.requests(req.requestID);
    test.status = Number(finalRecord.status);
    test.durationMs = nowMs() - startedMs;
    test.gas = {
      submitHXMsgRequest: req.submitGas,
      completeWithResponse: gasOf(completeReceipt),
      total: req.submitGas + gasOf(completeReceipt),
    };
    test.pass = test.status === 3;
    cases.push(test);
  }

  {
    const startedMs = nowMs();
    const test = { caseId: 'CR-EVM-002', name: 'Pending -> Challenged -> Completed', pass: false };
    const req = await submitAtomic(source);
    await increaseTime(3);
    const challengeReceipt = await (await source.startChallenge(req.requestID)).wait();
    const challenged = await source.requests(req.requestID);
    const response = buildResponse(req.requestID, req.record);
    const certs = teeWallets.slice(0, threshold).map((wallet) => certFor(wallet, req.requestID, response.digest));
    const completeReceipt = await (await source.completeWithResponse(req.requestID, responseTuple(response), certs, threshold)).wait();
    const finalRecord = await source.requests(req.requestID);
    test.challengeDeadline = Number(challenged.challengeDeadline);
    test.status = Number(finalRecord.status);
    test.durationMs = nowMs() - startedMs;
    test.gas = {
      submitHXMsgRequest: req.submitGas,
      startChallenge: gasOf(challengeReceipt),
      completeWithResponse: gasOf(completeReceipt),
      total: req.submitGas + gasOf(challengeReceipt) + gasOf(completeReceipt),
    };
    test.pass = test.status === 3 && test.challengeDeadline > 0;
    cases.push(test);
  }

  {
    const startedMs = nowMs();
    const test = { caseId: 'CR-EVM-003', name: 'Pending -> Challenged -> Compensated', pass: false };
    const req = await submitTokenEscrowAtomic(source, token, deployer, { feedbackTimeoutOffset: 5 });
    await increaseTime(6);
    const challengeReceipt = await (await source.startChallenge(req.requestID)).wait();
    await increaseTime(7);
    const compensateReceipt = await (await source.compensateAfterChallenge(req.requestID, ethers.toUtf8Bytes(req.failureData))).wait();
    const finalRecord = await source.requests(req.requestID);
    test.status = Number(finalRecord.status);
    test.durationMs = nowMs() - startedMs;
    test.gas = {
      submitHXMsgRequest: req.submitGas,
      startChallenge: gasOf(challengeReceipt),
      compensateAfterChallenge: gasOf(compensateReceipt),
      total: req.submitGas + gasOf(challengeReceipt) + gasOf(compensateReceipt),
    };
    test.pass = test.status === 4;
    cases.push(test);
  }

  {
    const startedMs = nowMs();
    const req = await submitTokenEscrowAtomic(source, token, deployer);
    const response = buildResponse(req.requestID, req.record);
    const certs = teeWallets.slice(0, 1).map((wallet) => certFor(wallet, req.requestID, response.digest));
    const result = await expectRevert('insufficient TEE quorum rejected', async () => {
      await source.completeWithResponse(req.requestID, responseTuple(response), certs, threshold);
    });
    cases.push({
      caseId: 'CR-EVM-004',
      ...result,
      durationMs: nowMs() - startedMs,
      gas: { submitHXMsgRequest: req.submitGas, revertedTxGas: 0, total: req.submitGas },
    });
  }

  {
    const startedMs = nowMs();
    const req = await submitTokenEscrowAtomic(source, token, deployer, { feedbackTimeoutOffset: 5 });
    await increaseTime(6);
    const challengeReceipt = await (await source.startChallenge(req.requestID)).wait();
    await increaseTime(7);
    const compensateReceipt = await (await source.compensateAfterChallenge(req.requestID, ethers.toUtf8Bytes(req.failureData))).wait();
    const response = buildResponse(req.requestID, req.record);
    const certs = teeWallets.slice(0, threshold).map((wallet) => certFor(wallet, req.requestID, response.digest));
    const result = await expectRevert('late RESPONSE after compensation rejected', async () => {
      await source.completeWithResponse(req.requestID, responseTuple(response), certs, threshold);
    });
    cases.push({
      caseId: 'CR-EVM-005',
      ...result,
      durationMs: nowMs() - startedMs,
      gas: {
        submitHXMsgRequest: req.submitGas,
        startChallenge: gasOf(challengeReceipt),
        compensateAfterChallenge: gasOf(compensateReceipt),
        revertedTxGas: 0,
        total: req.submitGas + gasOf(challengeReceipt) + gasOf(compensateReceipt),
      },
    });
  }

  {
    const startedMs = nowMs();
    const test = { caseId: 'CR-EVM-006', name: 'TOKEN_ESCROW timeout -> ERC20 refund', pass: false };
    const amount = 1234500n;
    await (await token.mint(deployer.address, amount)).wait();
    await (await token.approve(await source.getAddress(), amount)).wait();
    const latest = await ethers.provider.getBlock('latest');
    const now = Number(latest.timestamp);
    const failureData = `token-refund-${Date.now()}`;
    const failureActionHash = ethers.keccak256(ethers.toUtf8Bytes(failureData));
    const atomicity = [
      true,
      AtomicityMode.COMMIT_OR_COMPENSATE,
      CommitmentType.TOKEN_ESCROW,
      ethers.keccak256(ethers.toUtf8Bytes('token-escrow')),
      ethers.keccak256(ethers.toUtf8Bytes('token-success')),
      failureActionHash,
      5,
    ];
    const beforeOwner = await token.balanceOf(deployer.address);
    const beforeSource = await token.balanceOf(await source.getAddress());
    const tx = await source.submitTokenEscrowHXMsgRequest(
      ethers.keccak256(ethers.toUtf8Bytes('fabric-mychannel')),
      ethers.keccak256(ethers.toUtf8Bytes('fabric-local-domain')),
      ethers.keccak256(ethers.toUtf8Bytes('fabric:mychannel:xcall')),
      ethers.id('ExecuteHXMsg(bytes32,bytes)').slice(0, 10),
      ethers.keccak256(ethers.toUtf8Bytes('call-token-escrow')),
      ethers.keccak256(ethers.toUtf8Bytes('payload-token-escrow')),
      ethers.keccak256(ethers.toUtf8Bytes('receiver')),
      now + 3600,
      [true, FeedbackType.RESPONSE, now + 30, ethers.ZeroHash, atomicity],
      await token.getAddress(),
      amount
    );
    const submitReceipt = await tx.wait();
    const event = submitReceipt.logs
      .map((log) => {
        try {
          return source.interface.parseLog(log);
        } catch (_error) {
          return null;
        }
      })
      .find((parsed) => parsed && parsed.name === 'CrossChainCallRequested');
    const requestID = event.args.requestID;
    const afterLockOwner = await token.balanceOf(deployer.address);
    const lockedInSource = await token.balanceOf(await source.getAddress());
    await increaseTime(31);
    const challengeReceipt = await (await source.startChallenge(requestID)).wait();
    await increaseTime(7);
    const compensateReceipt = await (await source.compensateAfterChallenge(requestID, ethers.toUtf8Bytes(failureData))).wait();
    const finalOwner = await token.balanceOf(deployer.address);
    const finalSource = await token.balanceOf(await source.getAddress());
    const escrow = await source.tokenEscrows(requestID);
    const record = await source.requests(requestID);
    test.status = Number(record.status);
    test.durationMs = nowMs() - startedMs;
    test.balances = {
      beforeOwner: beforeOwner.toString(),
      beforeSource: beforeSource.toString(),
      afterLockOwner: afterLockOwner.toString(),
      lockedInSource: lockedInSource.toString(),
      finalOwner: finalOwner.toString(),
      finalSource: finalSource.toString(),
    };
    test.escrow = {
      token: escrow.token,
      owner: escrow.owner,
      amount: escrow.amount.toString(),
      refunded: escrow.refunded,
    };
    test.gas = {
      submitTokenEscrowHXMsgRequest: gasOf(submitReceipt),
      startChallenge: gasOf(challengeReceipt),
      compensateAfterChallenge: gasOf(compensateReceipt),
      total: gasOf(submitReceipt) + gasOf(challengeReceipt) + gasOf(compensateReceipt),
    };
    test.pass = test.status === 4
      && afterLockOwner === beforeOwner - amount
      && lockedInSource === beforeSource + amount
      && finalOwner === beforeOwner
      && finalSource === beforeSource
      && escrow.refunded;
    cases.push(test);
  }

  const pass = cases.filter((item) => item.pass).length;
  const fail = cases.length - pass;
  const output = {
    testType: 'hxmsg-challenge-response-evm-state-machine',
    testedAt: new Date().toISOString(),
    contract: await source.getAddress(),
    registry: await registry.getAddress(),
    total: cases.length,
    pass,
    fail,
    durationMs: nowMs() - suiteStartedMs,
    gasTotal: cases.reduce((sum, item) => sum + Number(item.gas?.total || 0), 0),
    results: cases,
  };
  fs.writeJsonSync(path.join(RUNTIME_DIR, 'hxmsg-challenge-response-results.json'), output, { spaces: 2 });
  fs.writeFileSync(
    path.join(RUNTIME_DIR, 'hxmsg-challenge-response-summary.md'),
    `# h-xmsg 挑战响应测试结果\n\n` +
      `**测试时间**：${output.testedAt}\n` +
      `**通过率**：${pass}/${cases.length}\n\n` +
      `**总耗时**：${output.durationMs} ms\n` +
      `**累计 Gas**：${output.gasTotal}\n\n` +
      `| 用例 | 名称 | 状态 | 耗时(ms) | Gas |\n` +
      `|---|---|---|---:|---:|\n` +
      cases.map((item) => `| ${item.caseId} | ${item.name || item.label} | ${item.pass ? 'PASS' : 'FAIL'} | ${item.durationMs ?? '-'} | ${item.gas?.total ?? '-'} |`).join('\n') +
      `\n`
  );
  console.log(`FINAL ${pass}/${cases.length} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
