const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');
const { loadDotEnv } = require('../shared/env');
const { encodeCompactBusinessCall } = require('../shared/xmsg');
const {
  bytes32FromText,
  hashJson,
  FeedbackType,
  AtomicityMode,
  CommitmentType,
} = require('../shared/hxmsg');
const { FABRIC_INVOKE_SELECTOR, buildFabricTargetObject } = require('../hxmsg-builder/evm-to-fabric');
const { publishSourceMaterial, getWorkflow } = require('../automation/client');

loadDotEnv();

const ROOT = path.join(__dirname, '..');
const LOCAL_KEY = process.env.LOCAL_EVM_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const SOURCE_ABI = [
  'function submitTokenEscrowHXMsgRequest(bytes32,bytes32,bytes32,bytes4,bytes32,bytes32,bytes32,uint64,(bool,uint8,uint64,bytes32,(bool,uint8,uint8,bytes32,bytes32,bytes32,uint64)),address,uint256) external returns (bytes32)',
  'function requests(bytes32) view returns (bytes32,bytes32,uint64,uint64,uint64,uint8,uint8,bytes32)',
  'function tokenEscrows(bytes32) view returns (address token,address owner,uint256 amount,bool refunded,bool settled)',
  'event CrossChainCallRequested(bytes32 indexed requestID,address indexed sender,bytes32 indexed targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bool feedbackRequired,uint8 expectedFeedbackMsgType,uint64 feedbackTimeout,bytes32 callbackRefHash,bytes32 atomicityHash)',
];

async function waitForCompensation(requestID, timeoutMs = 120000) {
  const startedAt = process.hrtime.bigint();
  while (Number((process.hrtime.bigint() - startedAt) / 1000000n) < timeoutMs) {
    const workflow = await getWorkflow(requestID);
    if (workflow?.watcherState === 'COMPENSATED') return workflow;
    if (workflow?.watcherState === 'FAILED') throw new Error(`watcher failed: ${workflow.watcherReason || 'unknown'}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`watcher compensation timeout: ${requestID}`);
}

async function main() {
  const deployment = fs.readJsonSync(path.join(ROOT, 'runtime', 'deployment.json'));
  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC || 'http://127.0.0.1:8545');
  const wallet = new ethers.Wallet(LOCAL_KEY, provider);
  const signer = new ethers.NonceManager(wallet);
  const ownerAddress = wallet.address;
  const source = new ethers.Contract(deployment.evmSourceContract, SOURCE_ABI, signer);
  const token = new ethers.Contract(deployment.settlementToken, [
    'function approve(address,uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
  ], signer);
  const escrowAmount = 50000n;
  const businessPayload = {
    op: 'asset_lock',
    assetId: `AUTOMATION_WATCHER_ESCROW_${Date.now()}`,
    assetType: 'XCST',
    amount: '5',
    recipient: `fabric.watcher.recipient.${Date.now()}`,
    owner: ownerAddress,
    metadata: 'watcher timeout with real source token escrow refund',
    requireAck: false,
  };
  const encoded = encodeCompactBusinessCall(businessPayload);
  const failureData = ethers.hexlify(ethers.toUtf8Bytes(`refund:${businessPayload.assetId}`));
  const latest = await provider.getBlock('latest');
  // Hardhat 在空闲后会把下一块时间戳推进到墙钟时间，不能只依赖旧 tip 的时间戳。
  const sourceNow = Math.max(Number(latest.timestamp), Math.floor(Date.now() / 1000));
  const feedbackTimeout = sourceNow + 20;
  const challengeWindow = 6;
  const atomicity = {
    required: true,
    mode: AtomicityMode.COMMIT_OR_COMPENSATE,
    commitmentType: CommitmentType.TOKEN_ESCROW,
    commitmentRefHash: ethers.keccak256(ethers.toUtf8Bytes(`escrow:${businessPayload.assetId}`)),
    successActionHash: ethers.keccak256(ethers.toUtf8Bytes(`settle:${businessPayload.assetId}`)),
    failureActionHash: ethers.keccak256(failureData),
    challengeWindow,
  };
  const feedback = {
    required: true,
    expectedMsgType: FeedbackType.RESPONSE,
    timeout: feedbackTimeout,
    callbackRefHash: ethers.ZeroHash,
  };
  await publishSourceMaterial(encoded.compactCallHash, {
    targetProfile: 'fabric',
    businessPayload,
    feedback,
    atomicity,
    failureData,
  });
  await (await token.approve(deployment.evmSourceContract, escrowAmount)).wait();
  const balanceBefore = await token.balanceOf(ownerAddress);
  const policy = [
    true,
    FeedbackType.RESPONSE,
    feedbackTimeout,
    ethers.ZeroHash,
    [
      true,
      AtomicityMode.COMMIT_OR_COMPENSATE,
      CommitmentType.TOKEN_ESCROW,
      atomicity.commitmentRefHash,
      atomicity.successActionHash,
      atomicity.failureActionHash,
      challengeWindow,
    ],
  ];
  const tx = await source.submitTokenEscrowHXMsgRequest(
    bytes32FromText('fabric-mychannel'),
    bytes32FromText('fabric-local-domain'),
    buildFabricTargetObject('mychannel', 'xcall'),
    FABRIC_INVOKE_SELECTOR,
    encoded.compactCallHash,
    hashJson(encoded.normalized),
    bytes32FromText(businessPayload.recipient),
    sourceNow + 3600,
    policy,
    deployment.settlementToken,
    escrowAmount
  );
  const receipt = await tx.wait();
  const event = receipt.logs.map((log) => {
    try { return source.interface.parseLog(log); } catch (_error) { return null; }
  }).find((item) => item?.name === 'CrossChainCallRequested');
  if (!event) throw new Error('CrossChainCallRequested event missing');
  const requestID = event.args.requestID;
  console.log(`SOURCE requestID=${requestID} tx=${receipt.hash} gas=${receipt.gasUsed}`);
  const workflow = await waitForCompensation(requestID);
  const balanceAfter = await token.balanceOf(ownerAddress);
  const escrow = await source.tokenEscrows(requestID);
  const lifecycle = await source.requests(requestID);
  const pass = balanceAfter === balanceBefore
    && escrow.refunded === true
    && escrow.settled === false
    && Number(lifecycle[6]) === 4;
  const result = {
    testType: 'automation-watcher-token-escrow-timeout',
    testedAt: new Date().toISOString(),
    requestID,
    sourceTxHash: receipt.hash,
    sourceGasUsed: Number(receipt.gasUsed),
    targetResult: workflow.targetResult,
    challengeResult: workflow.challengeResult,
    compensationResult: workflow.compensationResult,
    watcherState: workflow.watcherState,
    escrow: {
      amount: escrow.amount.toString(),
      refunded: escrow.refunded,
      settled: escrow.settled,
      ownerBalanceBefore: balanceBefore.toString(),
      ownerBalanceAfter: balanceAfter.toString(),
    },
    pass,
  };
  fs.writeJsonSync(path.join(ROOT, 'runtime', 'automation-watcher-escrow-e2e-result.json'), result, { spaces: 2 });
  console.log(`${pass ? 'PASS' : 'FAIL'} challengeGas=${workflow.challengeResult?.gasUsed || 0} compensationGas=${workflow.compensationResult?.gasUsed || 0}`);
  if (!pass) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
