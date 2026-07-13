const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const image = process.env.EOSIO_CDT_IMAGE || 'eostudio/eosio.cdt:v1.8.1';
const contracts = [
  { dir: 'token', source: 'token.cpp', output: 'token.wasm', contract: 'token' },
  { dir: 'mercuryvault', source: 'mercuryvault.cpp', output: 'mercuryvault.wasm', contract: 'mercuryvault' },
];

for (const item of contracts) {
  execFileSync('docker', [
    'run', '--rm',
    '-v', `${path.join(root, 'eos')}:/src`,
    '-w', `/src/contracts/${item.dir}`,
    image,
    'eosio-cpp', '-abigen', '-I', '.', '-contract', item.contract, '-o', item.output, item.source,
  ], { stdio: 'inherit' });
}
