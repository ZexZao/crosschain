const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const axios = require('axios');
const {
  cb58Decode,
  validatorSetHash,
} = require('../shared/avalanche/warp-proof');
const {
  PRIMARY_NETWORK_ID,
  DEFAULT_ANCHOR_FILE,
  normalizeRpcValidators,
} = require('../shared/avalanche/pchain-trust');

const PROJECT_ROOT = path.resolve(__dirname, '..');

function latestNetworkRun() {
  if (process.env.AVALANCHE_NETWORK_RUN_DIR) return process.env.AVALANCHE_NETWORK_RUN_DIR;
  const runsDir = path.join(os.homedir(), '.avalanche-cli', 'runs');
  const candidates = fs.readdirSync(runsDir)
    .map((name) => path.join(runsDir, name))
    .filter((dir) => fs.existsSync(path.join(dir, 'genesis.json')))
    .map((dir) => ({ dir, mtime: fs.statSync(dir).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) throw new Error('no Avalanche CLI network run with genesis.json found');
  return candidates[0].dir;
}

function nodeEndpoints() {
  return String(process.env.AVALANCHE_NODE_ENDPOINTS
    || 'http://127.0.0.1:9650,http://127.0.0.1:9656,http://127.0.0.1:9652,http://127.0.0.1:9654,http://127.0.0.1:9658')
    .split(',').map((item) => item.trim()).filter(Boolean);
}

async function rpc(url, method, params) {
  const response = await axios.post(url, { jsonrpc: '2.0', id: 1, method, params }, { timeout: 10_000 });
  if (response.data?.error) throw new Error(`${url} ${method}: ${response.data.error.message}`);
  return response.data?.result;
}

function genesisValidatorIdentity(genesis) {
  return (genesis.initialStakers || []).map((item) => ({
    nodeID: String(item.nodeID),
    publicKey: String(item.signer?.publicKey || '').toLowerCase(),
  })).sort((a, b) => a.nodeID.localeCompare(b.nodeID));
}

function assertGenesisValidators(genesis, validators) {
  const expected = genesisValidatorIdentity(genesis);
  const actual = validators.map((item) => ({
    nodeID: item.nodeID,
    publicKey: item.publicKey.toLowerCase(),
  })).sort((a, b) => a.nodeID.localeCompare(b.nodeID));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('P-Chain validator identities do not match Avalanche genesis');
  }

  const stakedAddresses = new Set((genesis.initialStakedFunds || []).map(String));
  const initialStake = (genesis.allocations || [])
    .filter((allocation) => stakedAddresses.has(String(allocation.avaxAddr)))
    .reduce((sum, allocation) => sum
      + BigInt(allocation.initialAmount || 0)
      + (allocation.unlockSchedule || []).reduce((part, item) => part + BigInt(item.amount || 0), 0n), 0n);
  if (initialStake <= 0n || initialStake % BigInt(expected.length) !== 0n) {
    throw new Error('Avalanche genesis initial stake cannot be divided across initial validators');
  }
  const expectedWeight = initialStake / BigInt(expected.length);
  if (!validators.every((item) => BigInt(item.weight) === expectedWeight)) {
    throw new Error('P-Chain validator weights do not match Avalanche genesis stake allocation');
  }
}

async function main() {
  const runDir = latestNetworkRun();
  const genesisPath = process.env.AVALANCHE_GENESIS_FILE || path.join(runDir, 'genesis.json');
  const genesisBytes = fs.readFileSync(genesisPath);
  const genesis = JSON.parse(genesisBytes.toString('utf8'));
  const endpoints = nodeEndpoints();

  const nodeStates = await Promise.all(endpoints.map(async (baseURL) => {
    const [heightResult, chainResult] = await Promise.all([
      rpc(`${baseURL}/ext/bc/P`, 'platform.getHeight', {}),
      rpc(`${baseURL}/ext/info`, 'info.getBlockchainID', { alias: 'C' }),
    ]);
    return {
      baseURL,
      height: Number(heightResult.height),
      blockchainID: chainResult.blockchainID,
    };
  }));
  const sourceBlockchainID = nodeStates[0].blockchainID;
  if (!nodeStates.every((item) => item.blockchainID === sourceBlockchainID)) {
    throw new Error('Avalanche nodes disagree on C-Chain blockchainID');
  }
  const pChainHeight = Math.min(...nodeStates.map((item) => item.height));
  const snapshots = await Promise.all(nodeStates.map(async ({ baseURL }) => {
    const result = await rpc(`${baseURL}/ext/bc/P`, 'platform.getAllValidatorsAt', { height: pChainHeight });
    const set = result.validatorSets?.[PRIMARY_NETWORK_ID];
    if (!set) throw new Error(`${baseURL} did not return Primary Network validator set`);
    const validators = normalizeRpcValidators(set.validators);
    return {
      validators,
      validatorSetHash: validatorSetHash(validators),
      totalWeight: String(set.totalWeight),
    };
  }));
  const expectedSnapshot = snapshots[0];
  if (!snapshots.every((item) => item.validatorSetHash === expectedSnapshot.validatorSetHash
      && item.totalWeight === expectedSnapshot.totalWeight)) {
    throw new Error('Avalanche nodes disagree on P-Chain validator set');
  }
  assertGenesisValidators(genesis, expectedSnapshot.validators);

  const anchor = {
    schemaVersion: 1,
    mode: 'genesis-pinned-local-node',
    staticValidatorSet: true,
    networkID: Number(genesis.networkID),
    genesisHash: `0x${crypto.createHash('sha256').update(genesisBytes).digest('hex')}`,
    primaryNetworkID: PRIMARY_NETWORK_ID,
    sourceBlockchainIDs: [cb58Decode(sourceBlockchainID)],
    sourceBlockchainIDCB58: sourceBlockchainID,
    quorumNumerator: 67,
    quorumDenominator: 100,
    validatorSnapshots: [{
      pChainHeight,
      validatorSetHash: expectedSnapshot.validatorSetHash,
      totalWeight: expectedSnapshot.totalWeight,
      validators: expectedSnapshot.validators,
    }],
    provenance: {
      genesisInitialStakersMatched: true,
      genesisStakeWeightsMatched: true,
      independentlyQueriedNodes: nodeStates.length,
      generatedAt: new Date().toISOString(),
    },
  };
  const output = process.env.AVALANCHE_PCHAIN_TRUST_ANCHOR_FILE
    || path.join(PROJECT_ROOT, path.relative(PROJECT_ROOT, DEFAULT_ANCHOR_FILE));
  fs.outputJsonSync(output, anchor, { spaces: 2 });
  console.log(`Avalanche P-Chain trust anchor: ${output}`);
  console.log(`network=${anchor.networkID} pChainHeight=${pChainHeight} validators=${expectedSnapshot.validators.length}`);
  console.log(`validatorSetHash=${expectedSnapshot.validatorSetHash}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
