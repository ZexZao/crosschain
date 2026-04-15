const express = require('express');
const { ethers } = require('ethers');
const { getValidatorWalletByLabel } = require('../consensus-aggregator/validator-set');

const label = process.env.VALIDATOR_LABEL;
if (!label) {
  throw new Error('VALIDATOR_LABEL is required');
}

const wallet = getValidatorWalletByLabel(label);
const nodeId = process.env.VALIDATOR_ID || label;
const rpcUrl = process.env.EVM_RPC || 'http://evm-node:8545';
const provider = new ethers.JsonRpcProvider(rpcUrl);
const expectedEmitter = process.env.EVM_EXPECTED_EMITTER
  ? ethers.getAddress(process.env.EVM_EXPECTED_EMITTER)
  : null;
const app = express();
app.use(express.json({ limit: '512kb' }));

async function verifyTxOnEvm({ txHash, blockHash, eventEmitter }) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) {
    throw new Error(`evm receipt not found for txHash ${txHash}`);
  }
  if (blockHash && receipt.blockHash !== blockHash) {
    throw new Error(`evm blockHash mismatch for txHash ${txHash}`);
  }
  const normalizedEmitter = eventEmitter ? ethers.getAddress(eventEmitter) : null;
  const emitter = expectedEmitter || normalizedEmitter;
  if (emitter) {
    const hasLog = receipt.logs.some((log) => ethers.getAddress(log.address) === emitter);
    if (!hasLog) {
      throw new Error(`evm receipt does not contain expected emitter ${emitter}`);
    }
  }
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    validatorId: nodeId,
    label,
    address: wallet.address,
    rpcUrl,
    expectedEmitter
  });
});

app.get('/info', (_req, res) => {
  res.json({
    validatorId: nodeId,
    label,
    address: wallet.address,
    rpcUrl,
    expectedEmitter
  });
});

app.post('/sign', async (req, res) => {
  try {
    const digest = req.body?.digest;
    if (!ethers.isHexString(digest, 32)) {
      throw new Error('digest must be a 32-byte hex string');
    }
    const txHash = req.body?.txId || req.body?.txHash;
    if (!txHash || !ethers.isHexString(txHash, 32)) {
      throw new Error('txHash is required for evm-backed verification');
    }

    await verifyTxOnEvm({
      txHash,
      blockHash: req.body?.blockHash,
      eventEmitter: req.body?.eventEmitter
    });

    const signature = wallet.signingKey.sign(digest).serialized;
    res.json({
      ok: true,
      validatorId: nodeId,
      signer: wallet.address,
      signature
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

const port = Number(process.env.PORT || 9301);
app.listen(port, () => {
  console.log(`evm-validator-node ${nodeId} listening on ${port} as ${wallet.address}`);
});
