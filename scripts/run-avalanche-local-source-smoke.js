const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');
const {
  bytes32FromText,
  chainIdToBytes32,
  addressToBytes32,
  hashJson,
  FeedbackType,
} = require('../shared/hxmsg');
const { encodeBusinessPayload } = require('../shared/xmsg');

const PROJECT_ROOT = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, 'runtime');
const DEFAULT_LOCAL_PRIVATE_KEY = '0x56289e99c94b6912bfc12adc093c9b51124f0dc54ac7a766b2bc5ccf558d8027';

const SOURCE_ABI = [
  'function submitHXMsgRequest(bytes32 targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 expireAt,(bool,uint8,uint64,bytes32,(bool,uint8,uint8,bytes32,bytes32,bytes32,uint64))) external returns (bytes32)',
  'function requests(bytes32) view returns (address,bytes32,bytes32,bytes32,bytes4,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,uint8,uint8)',
  'event CrossChainCallRequested(bytes32 indexed requestID,address indexed sender,bytes32 indexed targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 nonce,uint64 expireAt,bool feedbackRequired,uint8 expectedFeedbackMsgType,uint64 feedbackTimeout,bytes32 callbackRefHash,bytes32 atomicityHash)',
];

async function main() {
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'avalanche-deployment.json'));
  const provider = new ethers.JsonRpcProvider(process.env.AVALANCHE_RPC_URL || deployment.rpcURL);
  const baseWallet = new ethers.Wallet(process.env.AVALANCHE_PRIVATE_KEY || DEFAULT_LOCAL_PRIVATE_KEY, provider);
  const wallet = new ethers.NonceManager(baseWallet);
  const source = new ethers.Contract(deployment.evmSourceContract, SOURCE_ABI, wallet);

  const businessPayload = {
    op: 'asset_lock',
    assetId: `AVAX_LOCAL_ASSET_${Date.now()}`,
    amount: '1.25',
    targetRecipient: deployment.deployer,
    owner: deployment.deployer,
    metadata: 'real avalanche local source transaction',
    requireAck: false,
  };
  const { normalized, payloadHex } = encodeBusinessPayload(businessPayload);
  const targetChainID = chainIdToBytes32(deployment.chainId);
  const targetDomainID = bytes32FromText(`avalanche-local-${deployment.chainId}`);
  const targetObject = addressToBytes32(deployment.targetContract);
  const functionSelector = ethers.id('execute(bytes32,bytes)').slice(0, 10);
  const callDataHash = ethers.keccak256(payloadHex);
  const businessPayloadHash = hashJson(normalized);
  const receiver = targetObject;
  const expireAt = Math.floor(Date.now() / 1000) + 3600;
  const policy = [
    false,
    FeedbackType.NONE,
    0,
    ethers.ZeroHash,
    [
      false,
      0,
      0,
      ethers.ZeroHash,
      ethers.ZeroHash,
      ethers.ZeroHash,
      0,
    ],
  ];

  const tx = await source.submitHXMsgRequest(
    targetChainID,
    targetDomainID,
    targetObject,
    functionSelector,
    callDataHash,
    businessPayloadHash,
    receiver,
    expireAt,
    policy
  );
  const receipt = await tx.wait();
  const event = receipt.logs
    .map((log) => {
      try { return source.interface.parseLog(log); } catch (_error) { return null; }
    })
    .find((item) => item && item.name === 'CrossChainCallRequested');
  if (!event) throw new Error('CrossChainCallRequested event not found');
  const requestID = event.args.requestID;
  const record = await source.requests(requestID);
  const result = {
    network: 'avalanche-local',
    rpcURL: deployment.rpcURL,
    chainId: deployment.chainId,
    sourceContract: deployment.evmSourceContract,
    targetContract: deployment.targetContract,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(),
    requestID,
    callDataHash,
    businessPayloadHash,
    requestStatus: Number(record[18]),
    businessPayload,
    testedAt: new Date().toISOString(),
  };
  fs.writeJsonSync(path.join(RUNTIME_DIR, 'avalanche-source-smoke-result.json'), result, { spaces: 2 });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
