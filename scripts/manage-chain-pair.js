const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const action = String(process.argv[2] || '').toLowerCase();
const pair = String(process.argv[3] || process.env.HXMSG_CHAIN_PAIR || '').toLowerCase();
const validPairs = new Set(['evm-fabric', 'evm-avalanche', 'fabric-avalanche']);

const ethereumTEE = ['tee-verifier', 'tee-verifier-2', 'tee-verifier-3', 'tee-verifier-4', 'tee-verifier-5'];
const fabricTEE = ['tee-fabric-1', 'tee-fabric-2', 'tee-fabric-3', 'tee-fabric-4', 'tee-fabric-5'];
const avalancheTEE = ['tee-avalanche-1', 'tee-avalanche-2', 'tee-avalanche-3', 'tee-avalanche-4', 'tee-avalanche-5'];
const allMainServices = ['evm-node', ...ethereumTEE, ...fabricTEE, ...avalancheTEE];
const fabricServices = [
  'fabric-ca.org1.example.com',
  'orderer.example.com',
  'peer0.org1.example.com',
  'peer1.org1.example.com',
  'peer2.org1.example.com',
  'peer3.org1.example.com',
];

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
  }
}

function compose(args, options) {
  run('docker', ['compose', ...args], options);
}

function fabricCompose(args, options) {
  run('docker', ['compose', '-f', 'docker-compose.fabric.yml', ...args], options);
}

function avalanche(actionName, options) {
  const args = ['network', actionName, '--skip-update-check'];
  if (actionName === 'start') args.splice(2, 0, '--num-nodes', '5');
  const localCLI = path.join(os.homedir(), 'bin', 'avalanche');
  run(process.env.AVALANCHE_CLI || (fs.existsSync(localCLI) ? localCLI : 'avalanche'), args, options);
}

function stopFabricChaincodeContainers() {
  const listed = spawnSync('docker', ['ps', '--filter', 'name=dev-peer', '--format', '{{.Names}}'], {
    encoding: 'utf8',
    env: process.env,
  });
  const names = String(listed.stdout || '').split(/\r?\n/).map((name) => name.trim()).filter(Boolean);
  if (names.length) run('docker', ['stop', ...names], { allowFailure: true });
}

function stopAll() {
  compose(['stop', ...allMainServices], { allowFailure: true });
  fabricCompose(['stop', ...fabricServices], { allowFailure: true });
  stopFabricChaincodeContainers();
  avalanche('stop', { allowFailure: true });
}

function startPair() {
  stopAll();
  const selectedMain = [];
  if (pair.includes('evm')) selectedMain.push('evm-node', ...ethereumTEE);
  if (pair.includes('fabric')) selectedMain.push(...fabricTEE);
  if (pair.includes('avalanche')) selectedMain.push(...avalancheTEE);
  compose(['up', '-d', ...selectedMain]);
  if (pair.includes('fabric')) fabricCompose(['up', '-d', ...fabricServices]);
  if (pair.includes('avalanche')) avalanche('start');
  console.log(`Active chain pair: ${pair}`);
}

if (!['up', 'down'].includes(action)) {
  throw new Error('usage: npm run pair:up -- <evm-fabric|evm-avalanche|fabric-avalanche>');
}
if (action === 'up' && !validPairs.has(pair)) {
  throw new Error(`unsupported chain pair: ${pair || '(missing)'}`);
}

if (action === 'down') stopAll();
else startPair();
