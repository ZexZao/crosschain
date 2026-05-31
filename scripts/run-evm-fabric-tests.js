const { execFileSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { Gateway, Wallets } = require('fabric-network');
const { buildHXMsgFromEvmReceipt } = require('../hxmsg-builder/evm-to-fabric');
const { buildReceiptProof } = require('../shared/evm/receipt-proof');
const { buildCommitteeHeaderUpdate } = require('../shared/evm/header-committee');
const { FeedbackType } = require('../shared/hxmsg');
const { normalizeBusinessPayload } = require('../shared/xmsg');
const { writeJSON } = require('../shared/utils');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const TEE_URLS = (process.env.TEE_URLS || process.env.TEE_URL || 'http://127.0.0.1:9000,http://127.0.0.1:9001,http://127.0.0.1:9002,http://127.0.0.1:9003,http://127.0.0.1:9004')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);
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

async function resolveTeeLeader() {
  const statuses = await Promise.all(TEE_URLS.map(async (url) => {
    try {
      const resp = await axios.get(`${url}/raft/status`, { timeout: 3000 });
      return { url, ...resp.data };
    } catch (error) {
      return { url, error: error.message };
    }
  }));
  const leader = statuses.find((status) => status.role === 'leader');
  if (leader) return leader.url;
  const knownLeaderID = statuses.find((status) => status.leaderID)?.leaderID;
  const knownLeader = knownLeaderID
    ? statuses.find((status) => status.nodeID === knownLeaderID && !status.error)
    : null;
  if (knownLeader) return knownLeader.url;
  const available = statuses.find((status) => !status.error);
  if (available) return available.url;
  throw new Error(`no reachable TEE node: ${statuses.map((status) => `${status.url}:${status.error}`).join('; ')}`);
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

async function queryBusinessRecord(contract, requestID) {
  const data = await contract.evaluateTransaction('QueryBusinessRecordByRequest', requestID);
  return data && data.length > 0 ? JSON.parse(data.toString()) : null;
}

function expectedBusinessStatus(op) {
  return {
    asset_lock: 'ASSET_SETTLED',
    mint_confirm: 'ASSET_SETTLED',
    receivable_attest: 'RECEIVABLE_ATTESTED',
    logistics_sync: 'LOGISTICS_SYNCED',
    medical_consent: 'CONSENT_GRANTED',
    oracle_update: 'ORACLE_UPDATED',
    approval_commit: 'APPROVAL_COMMITTED',
    subsidy_confirm: 'ASSET_SETTLED',
    identity_attest: 'IDENTITY_ATTESTED',
    carbon_retire: 'CARBON_RETIRED',
    iot_alert: 'IOT_ALERT_RECORDED',
    certificate_verify: 'CERTIFICATE_VERIFIED',
    benchmark_store: 'BENCHMARK_STORED',
  }[op] || 'RECORDED';
}

async function main() {
  fs.ensureDirSync(RUNTIME_DIR);
  const projectRoot = path.join(__dirname, '..');
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const sourceView = new ethers.Contract(
    deployment.evmSourceContract,
    ['function requests(bytes32) view returns (address,bytes32,bytes32,bytes32,bytes4,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,uint64,uint64,uint64,uint64,uint64,uint8,uint8)'],
    provider
  );
  const teeUrl = await resolveTeeLeader();
  const cases = [
    {
      caseId: 'EVM-FABRIC-001',
      payload: {
        op: 'oracle_update',
        feed: `EVM_FABRIC_PRICE_${Date.now()}`,
        price: '1.2345',
        sourceAgency: 'evm-oracle-bridge',
        roundId: Date.now(),
        metadata: 'stage4 melv-ef oracle update',
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
        const expectedPayload = normalizeBusinessPayload(tc.payload);
        const receipt = await provider.getTransactionReceipt(invoke.txHash);
        const block = await provider.getBlock(receipt.blockNumber);
        const receiptProof = await buildReceiptProof({
          provider,
          blockNumber: receipt.blockNumber,
          txHash: invoke.txHash,
        });
        const committeeHeaderUpdate = buildCommitteeHeaderUpdate({
          header: receiptProof.blockHeader,
          chainID: `eip155:${deployment.chainId}`,
        });
        const hxmsg = buildHXMsgFromEvmReceipt({
          deployment,
          receipt,
          block,
          businessPayload: tc.payload,
        });
        const protocolCheck = {
          feedbackDisabled: hxmsg.feedback?.required === false
            && Number(hxmsg.feedback?.expectedMsgType || 0) === FeedbackType.NONE
            && Number(hxmsg.feedback?.timeout || 0) === 0
            && hxmsg.feedback?.callbackRefHash === ethers.ZeroHash,
          atomicityDisabled: !hxmsg.atomicity?.required,
          challengeResponseExpected: false,
        };
        writeJSON('latest-evm-xmsg.json', hxmsg);
        const teeResp = await axios.post(`${teeUrl}/attest`, {
          hxmsg,
          helperData: { evmReceiptProof: receiptProof, committeeHeaderUpdate },
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
        const businessRecord = await queryBusinessRecord(contract, hxmsg.header.requestID);
        const sourceRecord = await sourceView.requests(hxmsg.header.requestID);
        result.requestID = hxmsg.header.requestID;
        result.evmTxHash = invoke.txHash;
        result.evmGasUsed = invoke.gasUsed;
        result.feedback = hxmsg.feedback;
        result.atomicity = hxmsg.atomicity || null;
        result.responseRequired = Boolean(hxmsg.feedback?.required);
        result.atomicityRequired = Boolean(hxmsg.atomicity?.required);
        result.protocolCheck = protocolCheck;
        result.sourceRequest = {
          status: Number(sourceRecord.status ?? sourceRecord[18]),
          feedbackTimeout: Number(sourceRecord.feedbackTimeout ?? sourceRecord[14]),
          challengeWindow: Number(sourceRecord.challengeWindow ?? sourceRecord[15]),
          challengeDeadline: Number(sourceRecord.challengeDeadline ?? sourceRecord[16]),
          commitmentType: Number(sourceRecord.commitmentType ?? sourceRecord[17]),
        };
        result.fabricResult = fabricResp.toString();
        result.teeVerification = teeResp.data.verificationResult;
        result.teeCluster = teeResp.data.teeClusterCertification;
        result.inbound = inbound;
        result.businessRecord = businessRecord;
        result.pass = Boolean(inbound)
          && Boolean(businessRecord)
          && inbound.recordId === expectedPayload.recordId
          && inbound.actor === expectedPayload.actor
          && inbound.amount === expectedPayload.amount
          && inbound.status === 'executed'
          && businessRecord.op === inbound.op
          && businessRecord.recordId === inbound.recordId
          && businessRecord.actor === inbound.actor
          && businessRecord.amount === inbound.amount
          && businessRecord.status === expectedBusinessStatus(inbound.op)
          && protocolCheck.feedbackDisabled
          && protocolCheck.atomicityDisabled
          && result.sourceRequest.challengeWindow === 0
          && result.sourceRequest.commitmentType === 0
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
      `| 用例 | RESPONSE | Atomicity | EVM tx | EVM Gas | TEE adapter | TEE quorum | Fabric 状态 | Source challengeWindow | 状态 |\n` +
      `|---|---|---|---|---:|---|---:|---|---:|---|\n` +
      results.map((r) => `| ${r.caseId} | ${r.responseRequired ? 'yes' : 'no'} | ${r.atomicityRequired ? 'yes' : 'no'} | ${r.evmTxHash || '-'} | ${r.evmGasUsed || '-'} | ${r.teeVerification?.adapter || '-'} | ${r.teeCluster ? `${r.teeCluster.reached}/${r.teeCluster.threshold}` : '-'} | ${r.inbound?.status || '-'} | ${r.sourceRequest?.challengeWindow ?? '-'} | ${r.pass ? 'PASS' : 'FAIL'} |`).join('\n') +
      `\n`
  );
  console.log(`FINAL ${pass}/${cases.length} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
