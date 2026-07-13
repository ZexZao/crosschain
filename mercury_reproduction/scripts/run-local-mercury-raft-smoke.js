const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { Api, JsonRpc } = require('eosjs');
const { JsSignatureProvider } = require('eosjs/dist/eosjs-jssig');
const { TextDecoder, TextEncoder } = require('util');

const root = path.join(__dirname, '..');
const parentRoot = process.env.PARENT_PROJECT_ROOT || path.resolve(__dirname, '../../crosschain_experiment');
const { buildReceiptProof } = require(path.join(parentRoot, 'shared/evm/receipt-proof'));
const { clusterCertificateTuple } = require(path.join(parentRoot, 'shared/tee/registration'));
const { bytes32, mercuryRequestDigest, mercuryEOSBatchDigest, mercuryConfirmationDigest } = require('../shared/mercury-digest');

const RPC = process.env.LOCAL_EVM_RPC || 'http://127.0.0.1:8545';
const TEE = process.env.MERCURY_TEE_URL || 'http://127.0.0.1:9300';

function artifact(name) {
  return fs.readJsonSync(path.join(root, 'artifacts', 'contracts', `${name}.sol`, `${name.split('/').pop()}.json`));
}

async function deploy(wallet, name, args = []) {
  const built = artifact(name);
  const contract = await new ethers.ContractFactory(built.abi, built.bytecode, wallet).deploy(...args);
  await contract.waitForDeployment();
  return contract;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = await provider.getSigner(0);
  const registry = await deploy(wallet, 'test/MockTEERegistry');
  const token = await deploy(wallet, 'test/MockERC20', ['Local Source', 'LSRC']);
  const vault = await deploy(wallet, 'MercuryVault', [await registry.getAddress(), wallet.address, 0, 60]);
  const eosDeploymentFile = path.join(root, 'runtime', 'deployment.eos.json');
  const eosDeployment = fs.existsSync(eosDeploymentFile) ? fs.readJsonSync(eosDeploymentFile) : null;
  await (await token.mint(wallet.address, 1000n)).wait();
  await (await token.approve(await vault.getAddress(), 100n)).wait();
  const block = await provider.getBlock('latest');
  const request = {
    sourceChainID: 'eip155:31337', sourceVault: await vault.getAddress(), owner: wallet.address,
    sourceAsset: await token.getAddress(), sourceAmount: '100',
    targetChainID: eosDeployment?.chainId || `0x${'11'.repeat(32)}`,
    targetVault: eosDeployment?.vault || 'mercuryvlt', targetAsset: 'EOS',
    targetAccount: eosDeployment?.receiver || 'eosreceiver', targetAmount: '25000000', targetPrecision: 4, requestNonce: Date.now(),
  };
  const requestHash = mercuryRequestDigest(request);
  const receipt = await (await vault.createDeposit(await token.getAddress(), 100n, requestHash, block.timestamp + 300)).wait();
  const event = receipt.logs.map((log) => { try { return vault.interface.parseLog(log); } catch (_error) { return null; } })
    .find((item) => item?.name === 'MercuryDepositCreated');
  request.depositID = event.args.depositID;
  const proof = await buildReceiptProof({ provider, blockNumber: receipt.blockNumber, txHash: receipt.hash });
  const batch = {
    targetType: 'eos', targetChainID: request.targetChainID, targetVault: request.targetVault,
    batchID: ethers.id(`local-mercury-batch-${Date.now()}`), requests: [request],
    transfers: [{ depositID: request.depositID, receiver: request.targetAccount, quantity: '2500.0000 EOS', amount: request.targetAmount }],
  };
  const response = await axios.post(`${TEE}/prepare-transfer-batch`, { batch, sourceProofs: [proof] }, { timeout: 120_000 });
  const result = response.data;
  if (result.signingDigest !== mercuryEOSBatchDigest(batch)) throw new Error('batch digest mismatch');
  if (Number(result.certificate?.participantCount || 0) < 3 || result.eosSignatures?.length < 3) {
    throw new Error('3-of-5 committed certificate was not produced');
  }
  let eosTransactionID = null;
  let confirmationDigest = null;
  if (eosDeployment) {
    const eos = eosDeployment;
    const eosRpc = new JsonRpc(process.env.EOS_RPC_URL || eos.endpoint, { fetch });
    const eosApi = new Api({
      rpc: eosRpc,
      signatureProvider: new JsSignatureProvider([process.env.EOS_PRIVATE_KEY || '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3']),
      textDecoder: new TextDecoder(), textEncoder: new TextEncoder(),
    });
    const executed = await eosApi.transact({ actions: [{
      account: eos.vault, name: 'transfer', authorization: [{ actor: eos.vault, permission: 'active' }],
      data: {
        batch_id: batch.batchID.slice(2),
        transfers: batch.transfers.map((item) => ({ deposit_id: item.depositID.slice(2), receiver: item.receiver, quantity: item.quantity })),
        signatures: result.eosSignatures,
      },
    }] }, { blocksBehind: 3, expireSeconds: 120 });
    eosTransactionID = executed.transaction_id;
    while (Number((await eosRpc.get_info()).last_irreversible_block_num) < Number(executed.processed.block_num)) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const eosBlock = await eosRpc.get_block(executed.processed.block_num);
    const confirmation = {
      chainID: '31337', sourceVault: await vault.getAddress(), depositID: request.depositID,
      requestHash, targetTxID: bytes32(eosTransactionID),
    };
    const confirmed = (await axios.post(`${TEE}/confirm-transfer`, {
      confirmation,
      targetProof: {
        chainType: 'eos', targetChainID: eos.chainId, contract: eos.vault, action: 'transfer',
        transactionID: eosTransactionID, blockNum: executed.processed.block_num, blockID: eosBlock.id,
        transactionTrace: executed,
      },
    }, { timeout: 120_000 })).data;
    confirmationDigest = confirmed.signingDigest;
    if (confirmationDigest !== mercuryConfirmationDigest(confirmation)) throw new Error('confirmation digest mismatch');
    await (await vault.confirmTransfer(request.depositID, confirmation.targetTxID, clusterCertificateTuple(confirmed.certificate))).wait();
  }
  const output = {
    pass: true, depositID: request.depositID, signingDigest: result.signingDigest,
    certificate: result.certificate, raft: result.raft, eosTransactionID, confirmationDigest,
    sourceOutcome: Number(await vault.outcomes(request.depositID)),
  };
  fs.ensureDirSync(path.join(root, 'runtime'));
  fs.writeJsonSync(path.join(root, 'runtime', 'local-mercury-raft-smoke.json'), output, { spaces: 2 });
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => { console.error(error.response?.data || error); process.exit(1); });
