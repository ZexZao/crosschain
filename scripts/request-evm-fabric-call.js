const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');
const { encodeBusinessPayload } = require('../shared/xmsg');
const {
  bytes32FromText,
  hashJson,
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
    ['function submitRequest(bytes32 targetChainID,bytes32 targetDomainID,bytes32 targetObject,bytes4 functionSelector,bytes32 callDataHash,bytes32 businessPayloadHash,bytes32 receiver,uint64 expireAt) external returns (bytes32)'],
    signer
  );

  const channelID = process.env.FABRIC_CHANNEL || 'mychannel';
  const chaincodeName = process.env.FABRIC_CHAINCODE || 'xcall';
  const { normalized, payloadHex } = encodeBusinessPayload(payload);
  const tx = await contract.submitRequest(
    bytes32FromText(`fabric-${channelID}`),
    bytes32FromText('fabric-local-domain'),
    buildFabricTargetObject(channelID, chaincodeName),
    FABRIC_INVOKE_SELECTOR,
    ethers.keccak256(payloadHex),
    hashJson(normalized),
    bytes32FromText(normalized.actor),
    Math.floor(Date.now() / 1000) + 3600
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
    requestID: event?.args?.requestID,
    payload,
    normalized,
    callData: payloadHex
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
