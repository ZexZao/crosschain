const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const { ethers } = require('ethers');
const { Gateway, Wallets } = require('fabric-network');
const { common } = require('fabric-protos');
const { encodeCompactBusinessCall } = require('../shared/xmsg');
const {
  ChainType,
  addressToBytes32,
  chainIdToBytes32,
  hashJson,
  toMinimalHXMsg,
  AtomicityMode,
  CommitmentType,
  FeedbackType,
  getExecutionData,
  buildDeliveryMessage,
} = require('../shared/hxmsg');
const { buildReceiptProof } = require('../shared/evm/receipt-proof');
const { buildCommitteeHeaderUpdate } = require('../shared/evm/header-committee');
const { buildHXMsgFromFabricEvent, TARGET_EXECUTE_SELECTOR } = require('../hxmsg-builder/fabric-to-evm');
const { buildEvmExecutionProofRef, buildExecutedResponse } = require('../hxmsg-builder/response');
const { writeJSON } = require('../shared/utils');
const { registerEVMTEEs, registerFabricTEEs, clusterCertificateTuple } = require('../shared/tee/registration');
const { teeURLsFromEnv } = require('../shared/tee/subnet-routing');

const RUNTIME_DIR = path.join(__dirname, '..', 'runtime');
const TEE_URLS = teeURLsFromEnv({ sourceChainType: ChainType.FABRIC });
const EVM_RPC = process.env.EVM_RPC || 'http://127.0.0.1:8545';
const PRIV_KEY = process.env.DEPLOYER_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const CLUSTER_CERT_ABI = '(bytes32,uint64,uint16,uint16,uint256,bytes32,bytes,bytes32,uint64,uint64)';
const TEE_REGISTRATION_ABI = '(address teeAddress,uint16 signerIndex,bytes32 enclavePubKeyHash,bytes32 measurement,bytes32 quoteHash,bytes32 initialSyncStateHash,uint64 epoch,uint64 notAfter,bytes attestationSignature)';

function amountUnits(amount) {
  const [whole, frac = ''] = String(amount).split('.');
  return BigInt(whole) * 10000n + BigInt((frac + '0000').slice(0, 4));
}

async function resolveTeeLeader() {
  const statuses = await Promise.all(TEE_URLS.map(async (url) => {
    try {
      const resp = await axios.get(`${url}/raft/status`, { timeout: 3000, proxy: false });
      return { url, ...resp.data };
    } catch (error) {
      return { url, error: error.message };
    }
  }));
  const leader = statuses.find((status) => status.role === 'leader');
  if (leader) return leader.url;
  const available = statuses.find((status) => !status.error);
  if (available) return available.url;
  throw new Error(`no reachable TEE node: ${statuses.map((status) => `${status.url}:${status.error}`).join('; ')}`);
}

async function getFabric(projectRoot) {
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
  return { gateway, network, contract: network.getContract(chaincode), channel, chaincode };
}

async function fabricBlockNumberByTx(network, channelID, txId) {
  const qscc = network.getContract('qscc');
  const blockBytes = await qscc.evaluateTransaction('GetBlockByTxID', channelID, txId);
  const block = common.Block.decode(Buffer.from(blockBytes));
  return Number(block.header.number);
}

async function queryBalance(contract, account, assetType = 'XCST') {
  return JSON.parse((await contract.evaluateTransaction('QueryAssetBalance', account, assetType)).toString());
}

async function relayToEvm(hxmsg, teeUrl, deployment) {
  const teeResp = await axios.post(`${teeUrl}/attest`, { hxmsg }, { timeout: 30000, proxy: false });
  const cluster = teeResp.data.teeClusterCertification;
  if (!cluster?.quorumReached) throw new Error(`TEE quorum not reached: ${cluster?.reached}/${cluster?.threshold}`);
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const signer = new ethers.NonceManager(new ethers.Wallet(PRIV_KEY, provider));
  const registry = new ethers.Contract(
    deployment.teeRegistry,
    [
      'function isActiveTEE(address) view returns (bool)',
      `function registerTEE(${TEE_REGISTRATION_ABI}) external`,
    ],
    signer
  );
  await registerEVMTEEs({ registry, certificate: cluster, teeURLs: TEE_URLS });
  const gateway = new ethers.Contract(
    deployment.hxmsgGateway,
    [`function executeHXMsgMinimalCompactCluster((bytes32,bytes32,uint8,bytes32,uint8,bytes32,bytes4,bytes32,bytes32,bytes32,bool,uint8,uint64,bytes32,uint64,bytes32,uint64),address,(uint16 opCode,bytes32 recordIdHash,bytes32 actorHash,address actorAddress,int256 amount,bytes32 metadataHash,bool requireAck),${CLUSTER_CERT_ABI}) external`],
    signer
  );
  const receipt = await (await gateway.executeHXMsgMinimalCompactCluster(
    toMinimalHXMsg(hxmsg),
    deployment.targetContract,
    getExecutionData(hxmsg).compactCall,
    clusterCertificateTuple(cluster)
  )).wait();
  return { teeCluster: cluster, receipt, verificationResult: teeResp.data.verificationResult };
}

async function completeFabricResponse({ contract, provider, hxmsg, relay, teeUrl, deployment }) {
  await registerFabricTEEs({ contract, certificate: relay.teeCluster, teeURLs: TEE_URLS });
  await contract.submitTransaction(
    'BindResponseLifecycleHXMsg', JSON.stringify(hxmsg), JSON.stringify(relay.teeCluster)
  );
  const evmReceipt = await provider.getTransactionReceipt(relay.receipt.hash);
  const evmProof = await buildReceiptProof({
    provider, blockNumber: evmReceipt.blockNumber, txHash: evmReceipt.hash,
  });
  const response = buildExecutedResponse({
    originRequestID: hxmsg.header.requestID,
    originHmsgDigest: hxmsg.hmsgDigest,
    targetExecutionHash: (hxmsg.deliveryMessage || buildDeliveryMessage(hxmsg)).targetExecutionHash,
    targetProofRefHash: buildEvmExecutionProofRef(evmReceipt),
    responsePayload: { txHash: evmReceipt.hash, status: 'executed' },
  });
  const responseAttest = await axios.post(`${teeUrl}/attest-response`, {
    response,
    helperData: {
      originHxmsg: hxmsg,
      evmExecutionReceipt: evmProof,
      committeeHeaderUpdate: buildCommitteeHeaderUpdate({
        header: evmProof.blockHeader,
        chainID: `eip155:${deployment.chainId}`,
      }),
      evmChainID: `eip155:${deployment.chainId}`,
    },
  }, { timeout: 30000, proxy: false });
  const voucher = responseAttest.data.teeClusterCertification;
  await registerFabricTEEs({ contract, certificate: voucher, teeURLs: TEE_URLS });
  await contract.submitTransaction(
    'CompleteWithResponse', hxmsg.header.requestID, JSON.stringify(response), JSON.stringify(voucher)
  );
  return JSON.parse((await contract.evaluateTransaction(
    'QueryResponseLifecycle', hxmsg.header.requestID
  )).toString());
}

async function main() {
  fs.ensureDirSync(RUNTIME_DIR);
  const projectRoot = path.join(__dirname, '..');
  const deployment = fs.readJsonSync(path.join(RUNTIME_DIR, 'deployment.json'));
  const provider = new ethers.JsonRpcProvider(EVM_RPC);
  const receiver = new ethers.Wallet(PRIV_KEY, provider).address;
  const target = new ethers.Contract(
    deployment.targetContract,
    [
      'function token() view returns (address)',
      'function assetAmountByRequest(bytes32) view returns (uint256)',
      'function assetRecipientByRequest(bytes32) view returns (address)',
    ],
    provider
  );
  const tokenAddress = deployment.settlementToken || await target.token();
  const token = new ethers.Contract(tokenAddress, ['function balanceOf(address) view returns (uint256)'], provider);
  const teeUrl = await resolveTeeLeader();
  const { gateway, network, contract, channel, chaincode } = await getFabric(projectRoot);
  const result = {
    testType: 'real-asset-transfer-and-refund',
    testedAt: new Date().toISOString(),
    pass: false,
    cases: [],
  };
  try {
    await contract.submitTransaction('InitializeWatcherAuthorization');
    const owner = 'fabric.asset.ownerA';
    const assetType = 'XCST';
    await contract.submitTransaction('InitAssetBalance', owner, assetType, '1000.0000');
    const before = await queryBalance(contract, owner, assetType);

    const amount = '125.2500';
    const businessPayload = {
      op: 'asset_lock',
      assetId: `REAL-ASSET-${Date.now()}`,
      owner,
      targetRecipient: receiver,
      amount,
      assetType,
      reason: 'real_crosschain_transfer',
      requireAck: true,
    };
    const { normalized, compactCallHash } = encodeCompactBusinessCall(businessPayload);
    const payload = {
      businessPayload,
      targetChainType: 'EVM',
      targetChainID: chainIdToBytes32(deployment.chainId),
      targetObject: addressToBytes32(deployment.targetContract),
      functionSelector: TARGET_EXECUTE_SELECTOR,
      callDataHash: compactCallHash,
      businessPayloadHash: hashJson(normalized),
      receiver: addressToBytes32(receiver),
      expireAt: Math.floor(Date.now() / 1000) + 3600,
      feedback: {
        required: true,
        expectedMsgType: FeedbackType.RESPONSE,
        timeout: Math.floor(Date.now() / 1000) + 3600,
        callbackRefHash: ethers.ZeroHash,
      },
      atomicity: {
        required: true,
        mode: AtomicityMode.COMMIT_OR_COMPENSATE,
        commitmentType: CommitmentType.TOKEN_ESCROW,
        commitmentRefHash: ethers.keccak256(ethers.toUtf8Bytes('fabric-transfer-escrow')),
        successActionHash: ethers.keccak256(ethers.toUtf8Bytes('fabric-transfer-success')),
        failureActionHash: ethers.keccak256(ethers.toUtf8Bytes('fabric-transfer-refund')),
        challengeWindow: 60,
      },
    };

    const lockTx = contract.createTransaction('LockAssetXCall');
    const lockTxId = lockTx.getTransactionId();
    const lockResp = JSON.parse((await lockTx.submit(JSON.stringify(payload))).toString());
    const afterLock = await queryBalance(contract, owner, assetType);
    const escrow = JSON.parse((await contract.evaluateTransaction('QueryAssetEscrow', lockResp.requestID)).toString());
    const blockNumber = await fabricBlockNumberByTx(network, channel, lockTxId);
    const eventRecord = JSON.parse((await contract.evaluateTransaction('QueryCrosschainEvent', lockResp.requestID)).toString());
    const hxmsg = buildHXMsgFromFabricEvent({
      deployment,
      channelName: channel,
      chaincodeId: chaincode,
      rawPayload: eventRecord,
      txId: lockTxId,
      blockNumber,
      nonce: lockResp.nonce,
      createdAt: eventRecord.createdAt,
    });
    const tokenBefore = await token.balanceOf(receiver);
    const relay = await relayToEvm(hxmsg, teeUrl, deployment);
    const settledLifecycle = await completeFabricResponse({
      contract, provider, hxmsg, relay, teeUrl, deployment,
    });
    const settledEscrow = JSON.parse((await contract.evaluateTransaction(
      'QueryAssetEscrow', lockResp.requestID
    )).toString());
    const tokenAfter = await token.balanceOf(receiver);
    const minted = await target.assetAmountByRequest(hxmsg.header.requestID);
    const recipient = await target.assetRecipientByRequest(hxmsg.header.requestID);
    const expectedUnits = amountUnits(amount);
    const transferPass = BigInt(before.balanceUnits) - BigInt(afterLock.balanceUnits) === expectedUnits
      && BigInt(escrow.amountUnits) === expectedUnits
      && escrow.status === 'Locked'
      && tokenAfter - tokenBefore === expectedUnits
      && minted === expectedUnits
      && recipient.toLowerCase() === receiver.toLowerCase()
      && settledLifecycle.status === 'Completed'
      && settledEscrow.status === 'Settled';

    result.cases.push({
      caseId: 'ASSET-001',
      name: 'Fabric escrow lock -> EVM ERC20 mint',
      pass: transferPass,
      requestID: hxmsg.header.requestID,
      fabricOwnerBalanceBefore: before.balanceUnits,
      fabricOwnerBalanceAfterLock: afterLock.balanceUnits,
      fabricEscrow: settledEscrow,
      responseLifecycle: settledLifecycle,
      evmReceiver: receiver,
      evmTokenBefore: tokenBefore.toString(),
      evmTokenAfter: tokenAfter.toString(),
      evmMintedUnits: minted.toString(),
      teeQuorum: `${relay.teeCluster.reached}/${relay.teeCluster.threshold}`,
      evmGas: relay.receipt.gasUsed.toString(),
    });

    const refundAmount = '10.0000';
    const failureData = `fabric-refund-${Date.now()}`;
    const refundBusinessPayload = {
      op: 'asset_lock',
      assetId: `REAL-REFUND-${Date.now()}`,
      owner,
      targetRecipient: receiver,
      amount: refundAmount,
      assetType,
      reason: 'refund_path',
      requireAck: false,
    };
    const encodedRefund = encodeCompactBusinessCall(refundBusinessPayload);
    const refundPayload = {
      businessPayload: refundBusinessPayload,
      targetChainType: 'EVM',
      targetChainID: chainIdToBytes32(deployment.chainId),
      targetObject: addressToBytes32(deployment.targetContract),
      functionSelector: TARGET_EXECUTE_SELECTOR,
      callDataHash: encodedRefund.compactCallHash,
      businessPayloadHash: hashJson(encodedRefund.normalized),
      receiver: addressToBytes32(receiver),
      expireAt: Math.floor(Date.now() / 1000) + 3600,
      feedback: {
        required: true,
        expectedMsgType: FeedbackType.RESPONSE,
        timeout: Math.floor(Date.now() / 1000) + 2,
        callbackRefHash: ethers.ZeroHash,
      },
      atomicity: {
        required: true,
        mode: AtomicityMode.COMMIT_OR_COMPENSATE,
        commitmentType: CommitmentType.TOKEN_ESCROW,
        commitmentRefHash: ethers.keccak256(ethers.toUtf8Bytes('fabric-token-escrow')),
        successActionHash: ethers.keccak256(ethers.toUtf8Bytes('fabric-token-success')),
        failureActionHash: ethers.keccak256(ethers.toUtf8Bytes(failureData)),
        challengeWindow: 2,
      },
    };
    const refundLock = JSON.parse((await contract.submitTransaction('LockAssetXCall', JSON.stringify(refundPayload))).toString());
    const beforeRefund = await queryBalance(contract, owner, assetType);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    await contract.submitTransaction('StartChallenge', refundLock.requestID);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const refundResp = JSON.parse((await contract.submitTransaction('CompensateAfterChallenge', refundLock.requestID, failureData)).toString());
    const afterRefund = await queryBalance(contract, owner, assetType);
    const refundEscrow = JSON.parse((await contract.evaluateTransaction('QueryAssetEscrow', refundLock.requestID)).toString());
    const commitment = JSON.parse((await contract.evaluateTransaction('QueryResponseLifecycle', refundLock.requestID)).toString());
    const refundUnits = amountUnits(refundAmount);
    const refundPass = BigInt(afterRefund.balanceUnits) - BigInt(beforeRefund.balanceUnits) === refundUnits
      && refundResp.status === 'Compensated'
      && refundResp.compensationHandler === 'asset-escrow-refund'
      && refundEscrow.status === 'Refunded'
      && commitment.status === 'Compensated';
    result.cases.push({
      caseId: 'ASSET-002',
      name: 'Fabric challenge timeout auto-dispatches escrow refund',
      pass: refundPass,
      requestID: refundLock.requestID,
      balanceBeforeRefund: beforeRefund.balanceUnits,
      balanceAfterRefund: afterRefund.balanceUnits,
      refundedUnits: refundUnits.toString(),
      compensation: refundResp,
      commitment,
      escrow: refundEscrow,
    });
    result.pass = result.cases.every((item) => item.pass);
  } finally {
    gateway.disconnect();
  }
  writeJSON('real-asset-transfer-refund-results.json', result);
  const md = '# Real Asset Transfer And Refund Test Results\n\n'
    + `Tested at: ${result.testedAt}\n\n`
    + `Result: ${result.cases.filter((item) => item.pass).length}/${result.cases.length} passed\n\n`
    + '| Case | Name | Status |\n|---|---|---|\n'
    + result.cases.map((item) => `| ${item.caseId} | ${item.name} | ${item.pass ? 'PASS' : 'FAIL'} |`).join('\n')
    + '\n';
  fs.writeFileSync(path.join(RUNTIME_DIR, 'real-asset-transfer-refund-summary.md'), md);
  console.log(`FINAL ${result.cases.filter((item) => item.pass).length}/${result.cases.length} passed`);
  process.exit(result.pass ? 0 : 1);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
