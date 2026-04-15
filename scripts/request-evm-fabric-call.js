const fs = require('fs-extra');
const path = require('path');
const { ethers } = require('ethers');

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
    ['function requestFabricCall(string payloadJson) external returns (uint64)'],
    signer
  );

  const tx = await contract.requestFabricCall(JSON.stringify(payload));
  const receipt = await tx.wait();
  console.log(JSON.stringify({
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    payload
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
