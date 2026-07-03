const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { performance } = require('perf_hooks');
const { ethers } = require('ethers');
const { Gateway, Wallets } = require('fabric-network');
const { composeHXMsg } = require('../hxmsg-builder/compose');
const { buildEvmContractCallTarget, TARGET_EXECUTE_SELECTOR } = require('../hxmsg-builder/target-builders/evm');
const { buildFabricChaincodeTarget, FABRIC_INVOKE_SELECTOR } = require('../hxmsg-builder/target-builders/fabric');
const { encodeBusinessPayload, encodeCompactBusinessCall, compactBusinessCallTuple } = require('../shared/xmsg');
const {
  ChainType,
  RefType,
  MsgType,
  FeedbackType,
  FinalityModel,
  PolicyType,
  VerificationMethod,
  bytes32FromText,
  hashJson,
  toMinimalHXMsg,
  getExecutionData,
  computeTargetExecutionHash,
} = require('../shared/hxmsg');
const { registerEVMTEEs, registerFabricTEEs, clusterCertificateTuple } = require('../shared/tee/registration');
const { teeURLsFromEnv } = require('../shared/tee/subnet-routing');
const { writeJSON } = require('../shared/utils');

const PROJECT_ROOT = path.join(__dirname, '..');
const RUNTIME_DIR = path.join(PROJECT_ROOT, 'runtime');
const RESULTS_FILE_NAME = 'hxmsg-avalanche-crosschain-results.json';
const RESULTS_FILE = path.join(RUNTIME_DIR, RESULTS_FILE_NAME);
const SUMMARY_FILE = path.join(RUNTIME_DIR, 'hxmsg-avalanche-crosschain-summary.md');
const TEE_URLS = teeURLsFromEnv({ sourceChainType: ChainType.AVALANCHE });
const EVM_RPC = process.env.EVM_RPC || 'http://127.0.0.1:8545';
const PRIV_KEY = process.env.DEPLOYER_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CASE_LIMIT = Number(process.env.HXMSG_CASE_LIMIT || 4);
const CLUSTER_CERT_ABI = '(bytes32,uint64,uint16,uint16,uint256,bytes32,bytes,bytes32,uint64,uint64)';
const TEE_REGISTRATION_ABI = '(address teeAddress,uint16 signerIndex,bytes32 enclavePubKeyHash,bytes32 measurement,bytes32 quoteHash,bytes32 initialSyncStateHash,uint64 epoch,uint64 notAfter,bytes attestationSignature)';

function nowMs() {
  return Math.round(performance.now());
}

function compactDeliveryObject(hxmsg) {
  const minimal = toMinimalHXMsg(hxmsg);
  return {
    requestID: minimal[0],
    hmsgDigest: minimal[1],
    sourceChainType: hxmsg.source.chainType,
    targetChainType: Number(minimal[2]),
    targetChainID: minimal[3],
    actionType: Number(minimal[4]),
    targetObject: minimal[5],
    functionSelector: minimal[6],
    callDataHash: minimal[7],
    receiver: minimal[8],
    targetExecutionHash: minimal[9],
    feedbackRequired: Boolean(minimal[10]),
    expectedFeedbackMsgType: Number(minimal[11] || 0),
    feedbackTimeout: Number(minimal[12] || 0),
    callbackRefHash: minimal[13],
    expireAt: Number(minimal[14] || 0),
  };
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
  throw new Error(`no reachable Avalanche TEE node: ${statuses.map((status) => `${status.url}:${status.error}`).join('; ')}`);
}

async function getFabricContract() {
  const profile = process.env.FABRIC_CONNECTION_PROFILE || path.join(PROJECT_ROOT, 'fabric-network', 'connection-org1.json');
  const walletPath = process.env.FABRIC_WALLET_PATH || path.join(PROJECT_ROOT, 'fabric-network', 'wallet');
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
  return { gateway, contract: network.getContract(chaincode), channel, chaincode };
}

function baseCases(runTag) {
  return [
    {
      caseId: 'AVAX-001',
      payload: {
        op: 'asset_lock',
        assetId: `AVAX_ASSET_${runTag}`,
        amount: '10.25',
        recipient: 'crosschain.alice',
        owner: 'avalanche.alice',
        metadata: 'Avalanche asset lock',
        requireAck: false,
      },
    },
    {
      caseId: 'AVAX-002',
      payload: {
        op: 'receivable_attest',
        receivableId: `AVAX_AR_${runTag}`,
        supplier: 'crosschain.supplier',
        amount: '2048',
        debtor: 'avalanche.buyer',
        metadata: 'Avalanche receivable attestation',
        requireAck: false,
      },
    },
    {
      caseId: 'AVAX-003',
      payload: {
        op: 'logistics_sync',
        waybillId: `AVAX_WAYBILL_${runTag}`,
        inspector: 'crosschain.inspector',
        reading: '51',
        location: 'avalanche-zone',
        metadata: 'Avalanche logistics sync',
        requireAck: false,
      },
    },
    {
      caseId: 'AVAX-004',
      payload: {
        op: 'oracle_update',
        feed: `AVAX_FEED_${runTag}`,
        sourceAgency: 'avalanche.oracle',
        price: '3721',
        metadata: 'Avalanche oracle update',
        requireAck: false,
      },
    },
  ].slice(0, CASE_LIMIT);
}

function avalancheValidatorSetRef() {
  return {
    networkID: 1337,
    pChainHeight: 123456,
    validatorSetHash: ethers.keccak256(ethers.toUtf8Bytes('local-avalanche-validator-set-v1')),
    totalWeight: '1000000',
    quorumNumerator: 67,
    quorumDenominator: 100,
    canonicalOrdering: 'nodeID-ascending',
  };
}

function buildAvalancheHXMsg({ deployment, targetKind, payload, caseId, nonce }) {
  const createdAt = Math.floor(Date.now() / 1000);
  const expireAt = createdAt + 3600;
  const effectivePayload = { ...payload };
  if (['asset_lock', 'mint_confirm', 'subsidy_confirm', 'token_transfer'].includes(effectivePayload.op)) {
    effectivePayload.targetRecipient = effectivePayload.targetRecipient || deployment.deployer;
  }
  const compactEncoded = encodeCompactBusinessCall(effectivePayload);
  const rawEncoded = encodeBusinessPayload(effectivePayload);
  const useCompactTarget = targetKind !== 'evm';
  const normalized = compactEncoded.normalized;
  const compact = compactEncoded.compact;
  const payloadHex = useCompactTarget ? compactEncoded.payloadHex : rawEncoded.payloadHex;
  const callDataHash = useCompactTarget ? compactEncoded.compactCallHash : ethers.keccak256(rawEncoded.payloadHex);
  const businessPayloadHash = hashJson(normalized);
  const requestID = ethers.keccak256(ethers.toUtf8Bytes(`avalanche:${targetKind}:${caseId}:${nonce}:${businessPayloadHash}`));
  const targetPart = targetKind === 'evm'
    ? buildEvmContractCallTarget({
      chainId: deployment.chainId,
      requestID,
      targetAddress: deployment.targetContract,
      functionSelector: ethers.id('execute(bytes32,bytes)').slice(0, 10),
      callDataHash,
      receiver: ethers.zeroPadValue(deployment.targetContract, 32),
    })
    : buildFabricChaincodeTarget({
      channelID: process.env.FABRIC_CHANNEL || 'mychannel',
      chaincodeName: process.env.FABRIC_CHAINCODE || 'xcall',
      requestID,
      functionSelector: FABRIC_INVOKE_SELECTOR,
      callDataHash,
    });
  const sourceChainID = bytes32FromText('avalanche-local-c-chain');
  const unsignedWarpMessage = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint64'],
    [requestID, sourceChainID, businessPayloadHash, targetPart.targetExecutionHash, BigInt(expireAt)]
  );
  const unsignedWarpMessageHash = ethers.keccak256(unsignedWarpMessage);
  const validatorSetRef = avalancheValidatorSetRef();
  const sourceProof = {
    proofType: 'AvalancheWarpMessage',
    warpMessageID: ethers.keccak256(ethers.concat([unsignedWarpMessageHash, ethers.toBeHex(nonce, 32)])),
    unsignedWarpMessage,
    unsignedWarpMessageHash,
    sourceChainID,
    networkID: validatorSetRef.networkID,
  };
  const signatureProof = {
    scheme: 'BLS12-381',
    signedMessageHash: unsignedWarpMessageHash,
    signerBitmap: '0x0f',
    aggregateSignature: ethers.hexlify(ethers.randomBytes(96)),
    signedWeight: '700000',
  };
  const sourceRecord = {
    proofType: sourceProof.proofType,
    warpMessageID: sourceProof.warpMessageID,
    unsignedWarpMessageHash: sourceProof.unsignedWarpMessageHash,
    sourceChainID: sourceProof.sourceChainID,
    networkID: Number(sourceProof.networkID || 0),
    validatorSetHash: validatorSetRef.validatorSetHash,
    pChainHeight: Number(validatorSetRef.pChainHeight || 0),
    signerBitmapHash: ethers.keccak256(signatureProof.signerBitmap || '0x'),
    aggregateSignatureHash: ethers.keccak256(signatureProof.aggregateSignature || '0x'),
    signedWeight: String(signatureProof.signedWeight || '0'),
  };
  const sourcePayloadHash = hashJson(sourceRecord);
  const policyHash = hashJson({
    validatorSetRef,
    canonicalOrdering: validatorSetRef.canonicalOrdering,
  });
  const hxmsg = composeHXMsg({
    header: {
      version: 1,
      requestID,
      msgType: MsgType.CONTRACT_CALL,
      nonce,
      createdAt,
      expireAt,
    },
    source: {
      chainType: ChainType.AVALANCHE,
      chainID: sourceChainID,
      domainID: bytes32FromText('avalanche-local-domain'),
    },
    target: targetPart.target,
    sourceRef: {
      refType: RefType.AVALANCHE_WARP_MESSAGE,
      refHash: unsignedWarpMessageHash,
      encodedRef: unsignedWarpMessage,
    },
    targetAction: targetPart.targetAction,
    verification: {
      verificationMethod: VerificationMethod.AVALANCHE_ICM_BLS,
      finality: {
        model: FinalityModel.APPLICATION,
        confirmations: 0,
        checkpointRoot: validatorSetRef.validatorSetHash,
        epoch: Number(validatorSetRef.pChainHeight),
        committeePolicyHash: policyHash,
      },
      policyRef: {
        policyType: PolicyType.AVALANCHE_VALIDATOR_SET,
        policyHash,
      },
      verifierProfileHash: bytes32FromText('avalanche-icm-local-sim-profile-v1'),
      adapterID: 'avalanche-icm-bls',
    },
    payloadBinding: {
      sourcePayloadHash,
      businessPayloadHash,
      targetExecutionHash: targetPart.targetExecutionHash,
    },
    feedback: {
      required: false,
      expectedMsgType: FeedbackType.NONE,
      timeout: 0,
      callbackRefHash: ethers.ZeroHash,
    },
    atomicity: null,
    callData: payloadHex,
    compactCall: compact,
    callDataDecoded: normalized,
    txId: sourceProof.warpMessageID,
    srcHeight: validatorSetRef.pChainHeight,
    sourceRecord,
    proofMeta: {
      proofType: sourceProof.proofType,
      pChainHeight: validatorSetRef.pChainHeight,
      validatorSetHash: validatorSetRef.validatorSetHash,
    },
  });
  hxmsg._blockData = {
    avalancheProof: {
      sourceProof,
      validatorSetRef,
      signatureProof,
      payloadBinding: {
        sourceMessageID: sourceProof.warpMessageID,
        payloadHash: businessPayloadHash,
        targetObject: targetPart.targetAction.targetObject,
        targetAction: targetPart.targetAction.functionSelector,
        expiry: expireAt,
      },
    },
  };
  return hxmsg;
}

async function attest(hxmsg, teeUrl) {
  const startedAt = nowMs();
  const resp = await axios.post(`${teeUrl}/attest`, {
    hxmsg,
    helperData: hxmsg._blockData,
  }, { timeout: 30000 });
  const elapsedMs = nowMs() - startedAt;
  const cluster = resp.data.teeClusterCertification;
  if (!cluster?.quorumReached) {
    throw new Error(`TEE quorum not reached: ${cluster?.reached || 0}/${cluster?.threshold || '?'}`);
  }
  return { elapsedMs, cluster, verificationResult: resp.data.verificationResult };
}

async function executeOnEVM(hxmsg, cluster) {
  const startedAt = nowMs();
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const wallet = new ethers.Wallet(PRIV_KEY, provider);
  const deployer = new ethers.NonceManager(wallet);
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));
  const registry = new ethers.Contract(
    deployment.teeRegistry,
    [
      'function isActiveTEE(address) view returns (bool)',
      `function registerTEE(${TEE_REGISTRATION_ABI}) external`,
    ],
    deployer
  );
  const registration = await registerEVMTEEs({ registry, certificate: cluster, teeURLs: TEE_URLS });
  const gateway = new ethers.Contract(
    deployment.hxmsgGateway,
    [`function executeHXMsgMinimalCluster((bytes32,bytes32,uint8,bytes32,uint8,bytes32,bytes4,bytes32,bytes32,bytes32,bool,uint8,uint64,bytes32,uint64),address,bytes,${CLUSTER_CERT_ABI}) external`],
    deployer
  );
  const tx = await gateway.executeHXMsgMinimalCluster(
    toMinimalHXMsg(hxmsg),
    deployment.targetContract,
    getExecutionData(hxmsg).callData,
    clusterCertificateTuple(cluster)
  );
  const receipt = await tx.wait();
  return {
    elapsedMs: nowMs() - startedAt,
    txHash: receipt.hash,
    gasUsed: Number(receipt.gasUsed),
    registrationGasUsed: Number(registration.gasUsed || 0n),
  };
}

async function executeOnFabric(hxmsg, cluster) {
  const startedAt = nowMs();
  const { gateway, contract } = await getFabricContract();
  try {
    await registerFabricTEEs({ contract, certificate: cluster, teeURLs: TEE_URLS });
    const executionData = getExecutionData(hxmsg);
    const resp = await contract.submitTransaction(
      'ExecuteHXMsgCompact',
      JSON.stringify(compactDeliveryObject(hxmsg)),
      JSON.stringify(executionData.compactCall),
      JSON.stringify(executionData.businessPayload),
      JSON.stringify(cluster)
    );
    return {
      elapsedMs: nowMs() - startedAt,
      fabricResponse: JSON.parse(resp.toString()),
      gasUsed: null,
      gasNote: 'Fabric target execution has no gas metric.',
    };
  } finally {
    gateway.disconnect();
  }
}

function writeSummary(output) {
  const lines = [];
  lines.push('# Avalanche 跨链测试结果');
  lines.push('');
  lines.push(`**测试时间**：${output.testedAt}`);
  lines.push(`**TEE 子网**：Avalanche proof subnet (${TEE_URLS.join(', ')})`);
  lines.push(`**通过率**：${output.pass}/${output.total}`);
  lines.push('');
  lines.push('| 用例 | 方向 | TEE Quorum | Source(ms) | TEE(ms) | Target(ms) | Total(ms) | Gas | 状态 |');
  lines.push('|------|------|------------|------------|---------|------------|-----------|-----|------|');
  for (const r of output.results) {
    const gas = r.target === 'EVM' ? String(r.gasUsed) : 'N/A';
    lines.push(`| ${r.caseId} | Avalanche->${r.target} | ${r.teeCluster ? `${r.teeCluster.reached}/${r.teeCluster.threshold}` : '-'} | ${r.timings.sourceBuildMs} | ${r.timings.teeMs} | ${r.timings.targetMs} | ${r.timings.totalMs} | ${gas} | ${r.pass ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('');
  lines.push(`EVM 目标链总 gas：${output.evmTotalGas}`);
  lines.push(`EVM 目标链平均 gas：${output.evmAverageGas}`);
  lines.push('Fabric 目标链无 gas 计费，本表以 N/A 标记。');
  fs.writeFileSync(SUMMARY_FILE, `${lines.join('\n')}\n`);
}

async function main() {
  fs.ensureDirSync(RUNTIME_DIR);
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));
  const teeUrl = await resolveTeeLeader();
  const cases = baseCases(Date.now());
  const results = [];
  let pass = 0;
  let fail = 0;
  let nonce = 1;

  for (const targetKind of ['evm', 'fabric']) {
    for (const tc of cases) {
      const totalStartedAt = nowMs();
      const caseID = `${tc.caseId}-${targetKind.toUpperCase()}`;
      const result = {
        caseId: caseID,
        target: targetKind === 'evm' ? 'EVM' : 'Fabric',
        pass: false,
        timings: {},
      };
      try {
        const sourceStartedAt = nowMs();
        const hxmsg = buildAvalancheHXMsg({
          deployment,
          targetKind,
          payload: tc.payload,
          caseId: caseID,
          nonce,
        });
        nonce += 1;
        result.requestID = hxmsg.header.requestID;
        result.hmsgDigest = hxmsg.hmsgDigest;
        result.timings.sourceBuildMs = nowMs() - sourceStartedAt;
        console.log(`${caseID} SOURCE simulatedWarp=${hxmsg.sourceRef.refHash}`);

        const tee = await attest(hxmsg, teeUrl);
        result.timings.teeMs = tee.elapsedMs;
        result.teeVerification = tee.verificationResult;
        result.teeCluster = tee.cluster;
        console.log(`${caseID} TEE quorum=${tee.cluster.reached}/${tee.cluster.threshold}`);

        const target = targetKind === 'evm'
          ? await executeOnEVM(hxmsg, tee.cluster)
          : await executeOnFabric(hxmsg, tee.cluster);
        result.timings.targetMs = target.elapsedMs;
        result.gasUsed = target.gasUsed;
        result.registrationGasUsed = target.registrationGasUsed || 0;
        result.txHash = target.txHash || target.fabricResponse?.requestID;
        result.fabricResponse = target.fabricResponse || null;
        result.timings.totalMs = nowMs() - totalStartedAt;
        result.pass = true;
        pass += 1;
        console.log(`${caseID} PASS targetMs=${result.timings.targetMs} gas=${target.gasUsed === null ? 'N/A' : target.gasUsed}`);
      } catch (error) {
        fail += 1;
        result.error = error.response?.data?.error || error.message;
        result.errorDetail = error.response?.data || null;
        result.timings.totalMs = nowMs() - totalStartedAt;
        result.pass = false;
        console.log(`${caseID} ERROR ${result.error}`);
      }
      results.push(result);
      const evmGasResults = results.filter((r) => r.target === 'EVM' && r.pass);
      const evmTotalGas = evmGasResults.reduce((sum, r) => sum + Number(r.gasUsed || 0), 0);
      const output = {
        testType: 'avalanche-to-evm-and-fabric-local-sim',
        testedAt: new Date().toISOString(),
        total: cases.length * 2,
        pass,
        fail,
        teeURLs: TEE_URLS,
        evmTotalGas,
        evmAverageGas: evmGasResults.length ? Math.ceil(evmTotalGas / evmGasResults.length) : 0,
        results,
      };
      writeJSON(RESULTS_FILE_NAME, output);
      writeSummary(output);
    }
  }
  console.log(`FINAL ${pass}/${cases.length * 2} passed, ${fail} failed`);
  console.log(`Results: ${RESULTS_FILE}`);
  console.log(`Summary: ${SUMMARY_FILE}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
