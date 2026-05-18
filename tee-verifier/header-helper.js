const express = require('express');
const { ethers } = require('ethers');
const { readJSON, writeJSON, ensureRuntime } = require('../shared/utils');

ensureRuntime();
const app = express();
app.use(express.json());

const stateFile = process.env.TEE_CHAIN_STATE_FILE || 'tee-header-helper-state.json';
let state = readJSON(stateFile) || { evm: { tipHeight: 0, tipHash: null, headers: [] } };

function save() {
  writeJSON(stateFile, state);
}

async function fetchHeader(blockNumber) {
  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC || 'http://evm-node:8545');
  const block = await provider.getBlock(Number(blockNumber));
  if (!block) throw new Error(`block not found: ${blockNumber}`);
  const header = {
    number: Number(block.number),
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: Number(block.timestamp),
  };
  const evm = state.evm;
  evm.tipHeight = Math.max(Number(evm.tipHeight || 0), header.number);
  if (evm.tipHeight === header.number) evm.tipHash = header.hash;
  evm.headers = (evm.headers || []).filter((item) => Number(item.number) !== header.number);
  evm.headers.push(header);
  if (evm.headers.length > 256) evm.headers.shift();
  save();
  return header;
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, role: 'single-simulated-header-helper-tee' });
});

app.get('/headers/:number', async (req, res) => {
  try {
    res.json(await fetchHeader(req.params.number));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/state', (_req, res) => {
  res.json(state);
});

const port = process.env.PORT || 9000;
app.listen(port, () => {
  console.log(`tee header helper listening on ${port}`);
});
