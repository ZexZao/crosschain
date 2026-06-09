const { execFileSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { Gateway, Wallets } = require('fabric-network');
const { loadDotEnv } = require('../shared/env');
const { buildHXMsgFromEvmReceipt } = require('../hxmsg-builder/evm-to-fabric');
const { buildReceiptProof } = require('../shared/evm/receipt-proof');
const { buildCommitteeHeaderUpdate } = require('../shared/evm/header-committee');
const { fetchBeaconLightClientInputs } = require('../shared/evm/sync-committee-light-client');
const { FeedbackType } = require('../shared/hxmsg');
const { normalizeBusinessPayload } = require('../shared/xmsg');
const { writeJSON } = require('../shared/utils');

loadDotEnv();

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const TEE_URLS = (process.env.TEE_URLS || process.env.TEE_URL || 'http://127.0.0.1:9000,http://127.0.0.1:9001,http://127.0.0.1:9002,http://127.0.0.1:9003,http://127.0.0.1:9004')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);
const EVM_RPC = process.env.EVM_RPC || (process.env.USE_SEPOLIA_SYNC_COMMITTEE === 'true'
  ? process.env.SEPOLIA_RPC_URL
  : 'http://127.0.0.1:8545');

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

async function fetchJson(baseUrl, route) {
  const url = `${baseUrl.replace(/\/$/, '')}${route}`;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const resp = await fetch(url, { headers: { accept: 'application/json' } });
      const text = await resp.text();
      if (!resp.ok) {
        throw new Error(`Beacon API ${resp.status} ${url}: ${text.slice(0, 200)}`);
      }
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

async function fetchExecutionFinalized(provider) {
  const finalized = await provider.send('eth_getBlockByNumber', ['finalized', false]);
  if (!finalized) return null;
  return {
    finalized,
    finalizedHeight: Number(BigInt(finalized.number)),
    finalizedHash: finalized.hash,
    source: 'execution-rpc',
  };
}

async function fetchBeaconFinalized(beaconApiUrl) {
  const finality = await fetchJson(beaconApiUrl, '/eth/v1/beacon/light_client/finality_update');
  const execution = finality.data?.finalized_header?.execution;
  if (!execution?.block_number) return null;
  return {
    finalized: finality,
    finalizedHeight: Number(execution.block_number),
    finalizedHash: execution.block_hash,
    beaconFinalizedSlot: Number(finality.data.finalized_header.beacon.slot),
    signatureSlot: Number(finality.data.signature_slot),
    source: 'beacon-light-client-finality-update',
  };
}

async function waitForFinalizedExecutionBlock({
  provider,
  beaconApiUrl,
  targetBlockNumber,
  timeoutMs = 20 * 60 * 1000,
}) {
  const started = Date.now();
  let lastFinality = null;
  async function checkFinality() {
    const finalized = beaconApiUrl
      ? await fetchBeaconFinalized(beaconApiUrl)
      : await fetchExecutionFinalized(provider);
    lastFinality = finalized || lastFinality;
    if (finalized && finalized.finalizedHeight >= Number(targetBlockNumber)) {
      return {
        ...finalized,
        waitMs: Date.now() - started,
      };
    }
    return null;
  }

  while (Date.now() - started < timeoutMs) {
    try {
      const finalized = await checkFinality();
      if (finalized) return finalized;
    } catch (error) {
      lastFinality = lastFinality || { finalizedHeight: 0, source: `transient-error:${error.message}` };
    }
    await new Promise((resolve) => setTimeout(resolve, 12000));
  }
  const finalized = await checkFinality();
  if (finalized) return finalized;
  const last = lastFinality
    ? ` lastFinalized=${lastFinality.finalizedHeight} source=${lastFinality.source}`
    : '';
  throw new Error(`Sepolia finality timeout for block ${targetBlockNumber}.${last}`);
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
  const now = Date.now();
  const cases = [
    {
      caseId: 'EVM-FABRIC-001',
      payload: {
        op: 'asset_lock',
        assetId: `EVM_ASSET_${now}_001`,
        assetType: 'XCST',
        amount: '12.5',
        recipient: 'fabric.alice',
        owner: 'evm.alice',
        metadata: 'sepolia asset settlement',
        requireAck: false,
      },
    },
    {
      caseId: 'EVM-FABRIC-002',
      payload: {
        op: 'mint_confirm',
        assetId: `EVM_MINT_${now}_002`,
        assetType: 'XCST',
        amount: '8',
        recipient: 'fabric.bob',
        issuer: 'evm.bridge.minter',
        metadata: 'sepolia mint confirmation',
        requireAck: false,
      },
    },
    {
      caseId: 'EVM-FABRIC-003',
      payload: {
        op: 'receivable_attest',
        receivableId: `EVM_AR_${now}_003`,
        supplier: 'fabric.supplierA',
        amount: '3200',
        debtor: 'evm.buyerA',
        metadata: 'sepolia receivable attestation',
        requireAck: false,
      },
    },
    {
      caseId: 'EVM-FABRIC-004',
      payload: {
        op: 'logistics_sync',
        waybillId: `EVM_WAYBILL_${now}_004`,
        inspector: 'fabric.inspectorA',
        reading: '42',
        location: 'hangzhou-zone-a',
        metadata: 'sepolia logistics synchronization',
        requireAck: false,
      },
    },
    {
      caseId: 'EVM-FABRIC-005',
      payload: {
        op: 'medical_consent',
        consentId: `EVM_CONSENT_${now}_005`,
        grantee: 'fabric.hospitalA',
        durationDays: 30,
        patient: 'evm.patientA',
        metadata: 'sepolia medical consent grant',
        requireAck: false,
      },
    },
    {
      caseId: 'EVM-FABRIC-006',
      payload: {
        op: 'oracle_update',
        feed: `EVM_PRICE_${now}_006`,
        price: '1.2345',
        sourceAgency: 'evm-oracle-bridge',
        roundId: now,
        metadata: 'sepolia oracle update',
        requireAck: false,
      },
    },
    {
      caseId: 'EVM-FABRIC-007',
      payload: {
        op: 'approval_commit',
        workflowId: `EVM_APPROVAL_${now}_007`,
        approvers: ['fabric.approverA', 'fabric.approverB', 'fabric.approverC'],
        threshold: 2,
        applicant: 'evm.applicantA',
        metadata: 'sepolia approval commit',
        requireAck: false,
      },
    },
    {
      caseId: 'EVM-FABRIC-008',
      payload: {
        op: 'subsidy_confirm',
        applicationId: `EVM_SUBSIDY_${now}_008`,
        assetType: 'XCST',
        subsidyAmount: '66',
        beneficiary: 'fabric.farmerA',
        institution: 'evm.agencyA',
        metadata: 'sepolia subsidy confirmation',
        requireAck: false,
      },
    },
  ];
  const caseLimit = Number(process.env.HXMSG_CASE_LIMIT || cases.length);
  const selectedCases = cases.slice(0, Math.max(0, Math.min(cases.length, caseLimit)));
  const finalityTimeoutMs = Number(process.env.SEPOLIA_FINALITY_TIMEOUT_MS || 15 * 60 * 1000);

  const { gateway, contract } = await getFabricContract(projectRoot);
  const results = [];
  let pass = 0;
  let fail = 0;
  try {
    for (const tc of selectedCases) {
      const caseStartedAt = Date.now();
      let finalityStartedAt = 0;
      const result = {
        caseId: tc.caseId,
        pass: false,
        timings: {
          sourceTxMs: 0,
          finalityWaitMs: 0,
          proofBuildMs: 0,
          hxmsgBuildMs: 0,
          teeAttestMs: 0,
          teeRegistrationMs: 0,
          fabricExecuteMs: 0,
          resultQueryMs: 0,
          totalMs: 0,
        },
      };
      try {
        const sourceTxStartedAt = Date.now();
        const invoke = requestEvmFabricCall(projectRoot, tc.payload);
        result.timings.sourceTxMs = Date.now() - sourceTxStartedAt;
        result.evmTxHash = invoke.txHash;
        result.evmGasUsed = invoke.gasUsed;
        const expectedPayload = normalizeBusinessPayload(tc.payload);
        const receipt = await provider.getTransactionReceipt(invoke.txHash);
        result.sourceBlockNumber = receipt.blockNumber;
        result.sourceBlockHash = receipt.blockHash;
        let finality = null;
        const beaconApiUrl = process.env.SEPOLIA_LIGHT_CLIENT_BEACON_API_URL || process.env.SEPOLIA_BEACON_API_URL;
        if (process.env.USE_SEPOLIA_SYNC_COMMITTEE === 'true') {
          finalityStartedAt = Date.now();
          finality = await waitForFinalizedExecutionBlock({
            provider,
            beaconApiUrl,
            targetBlockNumber: receipt.blockNumber,
            timeoutMs: finalityTimeoutMs,
          });
          result.timings.finalityWaitMs = Date.now() - finalityStartedAt;
          result.finality = {
            finalizedHeight: finality.finalizedHeight,
            finalizedHash: finality.finalizedHash,
            sourceBlockNumber: receipt.blockNumber,
            source: finality.source,
            beaconFinalizedSlot: finality.beaconFinalizedSlot || null,
            signatureSlot: finality.signatureSlot || null,
          };
        }
        const proofStartedAt = Date.now();
        const block = await provider.getBlock(receipt.blockNumber);
        const receiptProof = await buildReceiptProof({
          provider,
          blockNumber: receipt.blockNumber,
          txHash: invoke.txHash,
        });
        let committeeHeaderUpdate = null;
        let syncCommitteeUpdate = null;
        if (process.env.USE_SEPOLIA_SYNC_COMMITTEE === 'true') {
          syncCommitteeUpdate = await fetchBeaconLightClientInputs({
            beaconApiUrl,
            executionProvider: provider,
            targetBlockNumber: receipt.blockNumber,
            trustedBlockRoot: process.env.SEPOLIA_TRUSTED_BLOCK_ROOT,
            allowDynamicTrustedRoot: process.env.SEPOLIA_ALLOW_DYNAMIC_TRUSTED_ROOT === 'true',
          });
          syncCommitteeUpdate.chainID = `eip155:${deployment.chainId}`;
        } else {
          committeeHeaderUpdate = buildCommitteeHeaderUpdate({
            header: receiptProof.blockHeader,
            chainID: `eip155:${deployment.chainId}`,
          });
        }
        result.timings.proofBuildMs = Date.now() - proofStartedAt;
        const hxmsgStartedAt = Date.now();
        const hxmsg = buildHXMsgFromEvmReceipt({
          deployment,
          receipt,
          block,
          businessPayload: tc.payload,
        });
        result.timings.hxmsgBuildMs = Date.now() - hxmsgStartedAt;
        const protocolCheck = {
          feedbackDisabled: hxmsg.feedback?.required === false
            && Number(hxmsg.feedback?.expectedMsgType || 0) === FeedbackType.NONE
            && Number(hxmsg.feedback?.timeout || 0) === 0
            && hxmsg.feedback?.callbackRefHash === ethers.ZeroHash,
          atomicityDisabled: !hxmsg.atomicity?.required,
          challengeResponseExpected: false,
        };
        writeJSON('latest-evm-xmsg.json', hxmsg);
        const teeStartedAt = Date.now();
        const teeResp = await axios.post(`${teeUrl}/attest`, {
          hxmsg,
          helperData: {
            evmReceiptProof: receiptProof,
            committeeHeaderUpdate,
            syncCommitteeUpdate,
            evmRpc: EVM_RPC,
          },
        }, { timeout: 30000 });
        result.timings.teeAttestMs = Date.now() - teeStartedAt;
        const voucher = teeResp.data.teeClusterCertification || teeResp.data.teeCertification;
        const certs = voucher.certifications || [voucher];
        const teeRegistrationStartedAt = Date.now();
        for (const cert of certs) {
          await contract.submitTransaction('RegisterTrustedTEE', cert.teeAddress);
        }
        result.timings.teeRegistrationMs = Date.now() - teeRegistrationStartedAt;
        const fabricStartedAt = Date.now();
        const fabricResp = await contract.submitTransaction(
          'ExecuteHXMsg',
          JSON.stringify(hxmsg),
          hxmsg.callData,
          JSON.stringify(voucher)
        );
        result.timings.fabricExecuteMs = Date.now() - fabricStartedAt;
        const queryStartedAt = Date.now();
        const inbound = await queryInbound(contract, hxmsg.header.requestID);
        const businessRecord = await queryBusinessRecord(contract, hxmsg.header.requestID);
        const sourceRecord = await sourceView.requests(hxmsg.header.requestID);
        result.timings.resultQueryMs = Date.now() - queryStartedAt;
        result.requestID = hxmsg.header.requestID;
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
        result.error = error.response?.data?.error || error.message;
        result.errorDetail = error.response?.data || null;
        result.finalityTimeout = /finality timeout/i.test(result.error || '');
        if (result.finalityTimeout && finalityStartedAt > 0) {
          result.timings.finalityWaitMs = Date.now() - finalityStartedAt;
        }
        console.log(`${tc.caseId} ERROR ${result.error}`);
      }
      result.timings.totalMs = Date.now() - caseStartedAt;
      results.push(result);
    }
  } finally {
    gateway.disconnect();
  }

  const output = {
    testType: 'hxmsg-melv-ef-evm-to-fabric',
    testedAt: new Date().toISOString(),
    total: selectedCases.length,
    configuredTotal: cases.length,
    pass,
    fail,
    results,
  };
  writeJSON('hxmsg-evm-fabric-results.json', output);
  fs.writeFileSync(
    path.join(RUNTIME_DIR, 'hxmsg-evm-fabric-summary.md'),
      `# h-xmsg / MELV-EF EVM -> Fabric 测试结果\n\n` +
      `**测试时间**：${output.testedAt}\n` +
      `**通过率**：${pass}/${selectedCases.length}\n\n` +
      `**finality 等待上限**：${finalityTimeoutMs} ms\n\n` +
      `| 用例 | RESPONSE | Atomicity | EVM tx | EVM Gas | Source tx ms | Finality wait ms | Proof ms | TEE ms | Fabric ms | Total ms | TEE quorum | Fabric 状态 | 状态 |\n` +
      `|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|\n` +
      results.map((r) => `| ${r.caseId} | ${r.responseRequired ? 'yes' : 'no'} | ${r.atomicityRequired ? 'yes' : 'no'} | ${r.evmTxHash || '-'} | ${r.evmGasUsed || '-'} | ${r.timings?.sourceTxMs ?? '-'} | ${r.timings?.finalityWaitMs ?? '-'} | ${r.timings?.proofBuildMs ?? '-'} | ${r.timings?.teeAttestMs ?? '-'} | ${r.timings?.fabricExecuteMs ?? '-'} | ${r.timings?.totalMs ?? '-'} | ${r.teeCluster ? `${r.teeCluster.reached}/${r.teeCluster.threshold}` : '-'} | ${r.inbound?.status || '-'} | ${r.pass ? 'PASS' : 'FAIL'} |`).join('\n') +
      `\n`
  );
  console.log(`FINAL ${pass}/${selectedCases.length} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
