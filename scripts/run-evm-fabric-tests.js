const { execFileSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { Gateway, Wallets } = require('fabric-network');
const { buildHXMsgFromEvmReceipt } = require('../hxmsg-builder/evm-to-fabric');
const { buildReceiptProof } = require('../shared/evm/receipt-proof');
const { writeJSON } = require('../shared/utils');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const TEE_URL = process.env.TEE_URL || 'http://127.0.0.1:9000';
const EVM_RPC = process.env.EVM_RPC || 'http://127.0.0.1:8545';

async function getFabricContract(projectRoot) {
  const profile = process.env.FABRIC_CONNECTION_PROFILE || path.join(projectRoot, 'fabric-network', 'connection-org1.json');
  const walletPath = process.env.FABRIC_WALLET_PATH || path.join(projectRoot, 'fabric-network', 'wallet');
  const identity = process.env.FABRIC_IDENTITY || 'appUser';
  const channel = process.env.FABRIC_CHANNEL || 'mychannel';
  const chaincode = process.env.FABRIC_CHAINCODE || 'xcall';
  const ccp = fs.readJsonSync(profile);
  const wallet = await Wallets.newFileSystemWallet(walletPath);
  const gateway = new Gateway();
  await gateway.connect(ccp, {
    wallet,
    identity,
    discovery: { enabled: true, asLocalhost: process.env.FABRIC_AS_LOCALHOST !== 'false' },
  });
  const network = await gateway.getNetwork(channel);
  return { gateway, contract: network.getContract(chaincode) };
}

function requestEvmFabricCall(projectRoot, payload) {
  const stdout = execFileSync(process.execPath, [
    path.join(projectRoot, 'scripts', 'request-evm-fabric-call.js'),
    JSON.stringify(payload),
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  return JSON.parse(stdout);
}

async function queryInbound(contract, requestID) {
  const data = await contract.evaluateTransaction('GetInboundStatus', requestID);
  return data && data.length > 0 ? JSON.parse(data.toString()) : null;
}

async function main() {
  fs.ensureDirSync(RUNTIME_DIR);
  const projectRoot = path.join(__dirname, '..');
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const cases = [
    {
      caseId: 'EVM-FABRIC-001',
      payload: {
        op: 'fabric_invoke',
        recordId: 'EVM-FABRIC-001',
        actor: 'evm.userA',
        amount: '1',
        metadata: 'stage4 melv-ef request',
        requireAck: false,
      },
    },
  ];

  const { gateway, contract } = await getFabricContract(projectRoot);
  const results = [];
  let pass = 0;
  let fail = 0;
  try {
    for (const tc of cases) {
      const result = { caseId: tc.caseId, pass: false };
      try {
        const invoke = requestEvmFabricCall(projectRoot, tc.payload);
        const receipt = await provider.getTransactionReceipt(invoke.txHash);
        const block = await provider.getBlock(receipt.blockNumber);
        const receiptProof = await buildReceiptProof({
          provider,
          blockNumber: receipt.blockNumber,
          txHash: invoke.txHash,
        });
        const hxmsg = buildHXMsgFromEvmReceipt({
          deployment,
          receipt,
          block,
          businessPayload: tc.payload,
        });
        writeJSON('latest-evm-xmsg.json', hxmsg);
        const teeResp = await axios.post(`${TEE_URL}/attest`, {
          hxmsg,
          helperData: { evmReceiptProof: receiptProof },
        }, { timeout: 30000 });
        const voucher = teeResp.data.teeClusterCertification || teeResp.data.teeCertification;
        const certs = voucher.certifications || [voucher];
        for (const cert of certs) {
          await contract.submitTransaction('RegisterTrustedTEE', cert.teeAddress);
        }
        const fabricResp = await contract.submitTransaction(
          'ExecuteHXMsg',
          JSON.stringify(hxmsg),
          hxmsg.callData,
          JSON.stringify(voucher)
        );
        const inbound = await queryInbound(contract, hxmsg.header.requestID);
        result.requestID = hxmsg.header.requestID;
        result.evmTxHash = invoke.txHash;
        result.fabricResult = fabricResp.toString();
        result.teeVerification = teeResp.data.verificationResult;
        result.teeCluster = teeResp.data.teeClusterCertification;
        result.inbound = inbound;
        result.pass = Boolean(inbound)
          && inbound.recordId === tc.payload.recordId
          && inbound.status === 'executed'
          && Number(inbound.validTEECount || 0) >= Number((voucher.threshold || 1));
        if (result.pass) pass += 1; else fail += 1;
        console.log(`${tc.caseId} ${result.pass ? 'PASS' : 'FAIL'} requestID=${result.requestID}`);
      } catch (error) {
        fail += 1;
        result.error = error.message;
        console.log(`${tc.caseId} ERROR ${error.message}`);
      }
      results.push(result);
    }
  } finally {
    gateway.disconnect();
  }

  const output = {
    testType: 'hxmsg-melv-ef-evm-to-fabric',
    testedAt: new Date().toISOString(),
    total: cases.length,
    pass,
    fail,
    results,
  };
  writeJSON('hxmsg-evm-fabric-results.json', output);
  fs.writeFileSync(
    path.join(RUNTIME_DIR, 'hxmsg-evm-fabric-summary.md'),
    `# h-xmsg / MELV-EF EVM -> Fabric 测试结果\n\n` +
      `**测试时间**：${output.testedAt}\n` +
      `**通过率**：${pass}/${cases.length}\n\n` +
      `| 用例 | EVM tx | TEE adapter | TEE quorum | Fabric 状态 | 状态 |\n` +
      `|---|---|---|---:|---|---|\n` +
      results.map((r) => `| ${r.caseId} | ${r.evmTxHash || '-'} | ${r.teeVerification?.adapter || '-'} | ${r.teeCluster ? `${r.teeCluster.reached}/${r.teeCluster.threshold}` : '-'} | ${r.inbound?.status || '-'} | ${r.pass ? 'PASS' : 'FAIL'} |`).join('\n') +
      `\n`
  );
  console.log(`FINAL ${pass}/${cases.length} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
