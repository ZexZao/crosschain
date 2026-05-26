const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');
const { encodeBusinessPayload } = require('../shared/xmsg');
const {
  bytes32FromText,
  hashJson,
  AtomicityMode,
  CommitmentType,
  FeedbackType,
} = require('../shared/hxmsg');
const { FABRIC_INVOKE_SELECTOR, buildFabricTargetObject } = require('../hxmsg-builder/evm-to-fabric');

async function main() {
  const projectRoot = path.join(__dirname, '..');
  const deployment = fs.readJsonSync(path.join(projectRoot, 'runtime', 'deployment.json'));
  const payloadArg = process.argv[2];
  const payload = payloadArg
    ? JSON.parse(payloadArg)
    : {
        op: 'fabric_invoke',
        recordId: 'EVM-FABRIC-001',
        actor: 'evm.userA',
        amount: '1',
        metadata: 'from evm source contract'
      };

  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC || 'http://127.0.0.1:8545');
  const signer = new ethers.Wallet(
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
    provider
  );
  const contract = new ethers.Contract(
    deployment.evmSourceContract,
    [
      'function submitHXMsgRequest(bytes32 targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 expireAt,(bool,uint8,uint64,bytes32,(bool,uint8,uint8,bytes32,bytes32,bytes32,uint64))) external returns (bytes32)'
    ],
    signer
  );

  const channelID = process.env.FABRIC_CHANNEL || 'mychannel';
  const chaincodeName = process.env.FABRIC_CHAINCODE || 'xcall';
  const { normalized, payloadHex } = encodeBusinessPayload(payload);
  const expireAt = Math.floor(Date.now() / 1000) + 3600;
  const targetChainID = bytes32FromText(`fabric-${channelID}`);
  const targetDomainID = bytes32FromText('fabric-local-domain');
  const targetObject = buildFabricTargetObject(channelID, chaincodeName);
  const callDataHash = ethers.keccak256(payloadHex);
  const businessPayloadHash = hashJson(normalized);
  const receiver = bytes32FromText(normalized.actor);
  const atomicityRequired = Boolean(payload.atomicity?.required);
  const atomicity = atomicityRequired
    ? [
      true,
      payload.atomicity.mode || AtomicityMode.COMMIT_OR_COMPENSATE,
      payload.atomicity.commitmentType || CommitmentType.INTENT_ONLY,
      payload.atomicity.commitmentRefHash || ethers.keccak256(ethers.toUtf8Bytes(`commitment:${normalized.recordId}`)),
      payload.atomicity.successActionHash || ethers.keccak256(ethers.toUtf8Bytes(`success:${normalized.recordId}`)),
      payload.atomicity.failureActionHash || ethers.keccak256(ethers.toUtf8Bytes(payload.failureData || `failure:${normalized.recordId}`)),
      Number(payload.atomicity.challengeWindow || 60),
    ]
    : [false, 0, CommitmentType.NONE, ethers.ZeroHash, ethers.ZeroHash, ethers.ZeroHash, 0];
  const policy = atomicityRequired
    ? [true, FeedbackType.RESPONSE, Number(payload.feedbackTimeout || expireAt), ethers.ZeroHash, atomicity]
    : [false, FeedbackType.NONE, 0, ethers.ZeroHash, atomicity];
  const tx = await contract.submitHXMsgRequest(
    targetChainID,
    targetDomainID,
    targetObject,
    FABRIC_INVOKE_SELECTOR,
    callDataHash,
    businessPayloadHash,
    receiver,
    expireAt,
    policy
  );
  const receipt = await tx.wait();
  const event = receipt.logs
    .map((log) => {
      try {
        return contract.interface.parseLog(log);
      } catch (_) {
        return null;
      }
    })
    .find((parsed) => parsed && parsed.name === 'CrossChainCallRequested');
  console.log(JSON.stringify({
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    requestID: event?.args?.requestID,
    feedbackRequired: atomicityRequired,
    atomicityRequired,
    payload,
    normalized,
    callData: payloadHex
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
