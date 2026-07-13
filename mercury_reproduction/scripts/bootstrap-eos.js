const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { Api, JsonRpc, Serialize } = require('eosjs');
const { JsSignatureProvider } = require('eosjs/dist/eosjs-jssig');
const { TextDecoder, TextEncoder } = require('util');

const root = path.join(__dirname, '..');
const endpoint = process.env.EOS_RPC_URL || 'http://127.0.0.1:8888';
const devPrivateKey = process.env.EOS_PRIVATE_KEY || '5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3';
const devPublicKey = process.env.EOS_PUBLIC_KEY || 'EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV';
const rpc = new JsonRpc(endpoint, { fetch });
const api = new Api({
  rpc,
  signatureProvider: new JsSignatureProvider([devPrivateKey]),
  textDecoder: new TextDecoder(),
  textEncoder: new TextEncoder(),
});

async function transact(actions) {
  return api.transact({ actions }, { blocksBehind: 3, expireSeconds: 120 });
}

async function createAccount(account) {
  try {
    await rpc.get_account(account);
    return;
  } catch (_error) { /* create it */ }
  await transact([{
    account: 'eosio', name: 'newaccount', authorization: [{ actor: 'eosio', permission: 'active' }],
    data: {
      creator: 'eosio', name: account,
      owner: { threshold: 1, keys: [{ key: devPublicKey, weight: 1 }], accounts: [], waits: [] },
      active: { threshold: 1, keys: [{ key: devPublicKey, weight: 1 }], accounts: [], waits: [] },
    },
  }]);
}

async function setContract(account, directory, stem) {
  const wasm = fs.readFileSync(path.join(root, 'eos', 'contracts', directory, `${stem}.wasm`)).toString('hex');
  const abiJson = fs.readJsonSync(path.join(root, 'eos', 'contracts', directory, `${stem}.abi`));
  abiJson.error_messages = abiJson.error_messages || [];
  abiJson.abi_extensions = abiJson.abi_extensions || [];
  const abi = Serialize.arrayToHex(api.jsonToRawAbi(abiJson));
  await transact([
    { account: 'eosio', name: 'setcode', authorization: [{ actor: account, permission: 'active' }], data: { account, vmtype: 0, vmversion: 0, code: wasm } },
    { account: 'eosio', name: 'setabi', authorization: [{ actor: account, permission: 'active' }], data: { account, abi } },
  ]);
}

async function teePublicKeys() {
  const urls = String(process.env.MERCURY_TEE_URLS || 'http://127.0.0.1:9300,http://127.0.0.1:9301,http://127.0.0.1:9302,http://127.0.0.1:9303,http://127.0.0.1:9304')
    .split(',').map((item) => item.trim()).filter(Boolean);
  const keys = [];
  for (const url of urls) keys.push((await axios.get(`${url}/health`, { timeout: 10_000 })).data.eosPublicKey);
  return keys;
}

async function main() {
  for (const account of ['eosio.token', 'mercuryvlt', 'eosreceiver']) await createAccount(account);
  await setContract('eosio.token', 'token', 'token');
  await setContract('mercuryvlt', 'mercuryvault', 'mercuryvault');
  await transact([{
    account: 'eosio', name: 'updateauth', authorization: [{ actor: 'mercuryvlt', permission: 'active' }],
    data: {
      account: 'mercuryvlt', permission: 'active', parent: 'owner',
      auth: {
        threshold: 1,
        keys: [{ key: devPublicKey, weight: 1 }],
        accounts: [{ permission: { actor: 'mercuryvlt', permission: 'eosio.code' }, weight: 1 }],
        waits: [],
      },
    },
  }]);
  try {
    await transact([{ account: 'eosio.token', name: 'create', authorization: [{ actor: 'eosio.token', permission: 'active' }], data: { issuer: 'eosio', maximum_supply: '1000000000.0000 EOS' } }]);
  } catch (_error) { /* already created */ }
  try {
    await transact([{ account: 'eosio.token', name: 'issue', authorization: [{ actor: 'eosio', permission: 'active' }], data: { to: 'mercuryvlt', quantity: '1000000.0000 EOS', memo: 'MERCURY target liquidity' } }]);
  } catch (_error) { /* already funded */ }
  const info = await rpc.get_info();
  const operators = await teePublicKeys();
  await transact([{ account: 'mercuryvlt', name: 'init', authorization: [{ actor: 'mercuryvlt', permission: 'active' }], data: {
    chain_id: info.chain_id, token_contract: 'eosio.token', threshold: Math.floor(operators.length / 2) + 1, operators,
  } }]);
  const deployment = { endpoint, chainId: info.chain_id, vault: 'mercuryvlt', token: 'eosio.token', receiver: 'eosreceiver', operators };
  fs.ensureDirSync(path.join(root, 'runtime'));
  fs.writeJsonSync(path.join(root, 'runtime', 'deployment.eos.json'), deployment, { spaces: 2 });
  console.log(JSON.stringify(deployment, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
