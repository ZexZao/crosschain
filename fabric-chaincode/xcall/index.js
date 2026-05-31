'use strict';

const { Contract } = require('fabric-contract-api');
const { ethers } = require('ethers');

const ABI = ethers.AbiCoder.defaultAbiCoder();

function parseJson(value, fieldName) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${fieldName} must be valid JSON: ${error.message}`);
  }
}

function computeCoreHash(xmsg, teePubKey) {
  return ethers.keccak256(
    ABI.encode(
      [
        'uint8',
        'bytes32',
        'bytes32',
        'bytes32',
        'bytes32',
        'address',
        'bytes32',
        'bytes32',
        'uint64',
        'bytes32',
        'bytes32',
        'uint64',
        'address'
      ],
      [
        Number(xmsg.version),
        xmsg.requestID,
        xmsg.srcChainID,
        xmsg.dstChainID,
        xmsg.srcEmitter,
        xmsg.dstContract || ethers.ZeroAddress,
        ethers.keccak256(xmsg.payload),
        xmsg.payloadHash,
        Number(xmsg.srcHeight),
        ethers.keccak256(ethers.toUtf8Bytes(xmsg.eventProof)),
        ethers.keccak256(ethers.toUtf8Bytes(xmsg.finalityInfo)),
        Number(xmsg.nonce),
        teePubKey
      ]
    )
  );
}

function computeDigest(xmsg, ctr, prevDigest, teePubKey) {
  const coreHash = computeCoreHash(xmsg, teePubKey);
  return ethers.keccak256(ABI.encode(['bytes32', 'uint64', 'bytes32'], [coreHash, Number(ctr), prevDigest]));
}

function decodeBusinessPayload(payloadHex) {
  const [op, recordId, actor, amount, metadata, requireAck] = ABI.decode(
    ['string', 'string', 'string', 'string', 'string', 'bool'],
    payloadHex
  );
  return {
    op,
    recordId,
    actor,
    amount,
    metadata,
    requireAck
  };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashJson(value) {
  return ethers.keccak256(ethers.toUtf8Bytes(stableStringify(value)));
}

function addressToBytes32(value) {
  return ethers.zeroPadValue(ethers.getAddress(value), 32);
}

function selectorOf(signature) {
  return ethers.id(signature).slice(0, 10);
}

function bytes32FromText(text) {
  return ethers.keccak256(ethers.toUtf8Bytes(String(text)));
}

function normalizeFeedback(feedback = {}) {
  return {
    required: Boolean(feedback.required),
    expectedMsgType: Number(feedback.expectedMsgType || 0),
    timeout: Number(feedback.timeout || 0),
    callbackRefHash: feedback.callbackRefHash || ethers.ZeroHash
  };
}

function normalizeAtomicity(atomicity = {}) {
  return {
    required: Boolean(atomicity.required),
    mode: Number(atomicity.mode || 0),
    commitmentType: Number(atomicity.commitmentType || 0),
    commitmentRefHash: atomicity.commitmentRefHash || ethers.ZeroHash,
    successActionHash: atomicity.successActionHash || ethers.ZeroHash,
    failureActionHash: atomicity.failureActionHash || ethers.ZeroHash,
    challengeWindow: Number(atomicity.challengeWindow || 0)
  };
}

function computeFeedbackHash(feedback = {}) {
  const normalized = normalizeFeedback(feedback);
  return ethers.keccak256(
    ABI.encode(
      ['bool', 'uint8', 'uint64', 'bytes32'],
      [normalized.required, normalized.expectedMsgType, normalized.timeout, normalized.callbackRefHash]
    )
  );
}

function computeAtomicityHash(atomicity = {}) {
  const normalized = normalizeAtomicity(atomicity);
  return ethers.keccak256(
    ABI.encode(
      ['bool', 'uint8', 'uint8', 'bytes32', 'bytes32', 'bytes32', 'uint64'],
      [
        normalized.required,
        normalized.mode,
        normalized.commitmentType,
        normalized.commitmentRefHash,
        normalized.successActionHash,
        normalized.failureActionHash,
        normalized.challengeWindow
      ]
    )
  );
}

function computeResponseDigest(response) {
  return ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes32', 'uint8', 'bytes32', 'bytes32', 'bytes32'],
      [
        response.originRequestID,
        response.originHmsgDigest,
        Number(response.responseStatus || 0),
        response.targetExecutionHash,
        response.targetProofRefHash || ethers.ZeroHash,
        response.responsePayloadHash || ethers.ZeroHash
      ]
    )
  );
}

function parseAmountUnits(value) {
  const text = String(value || '0');
  if (!/^[0-9]+(\.[0-9]{1,4})?$/.test(text)) {
    throw new Error(`invalid asset amount: ${text}`);
  }
  const [whole, frac = ''] = text.split('.');
  return BigInt(whole) * 10000n + BigInt((frac + '0000').slice(0, 4));
}

function unitsToString(value) {
  return String(value);
}

function assetBalanceKey(account, assetType) {
  return `assetBalance:${assetType}:${account}`;
}

async function getAssetBalanceUnits(ctx, account, assetType) {
  const data = await ctx.stub.getState(assetBalanceKey(account, assetType));
  return data && data.length > 0 ? BigInt(data.toString()) : 0n;
}

async function putAssetBalanceUnits(ctx, account, assetType, value) {
  if (value < 0n) throw new Error('negative balance');
  await ctx.stub.putState(assetBalanceKey(account, assetType), Buffer.from(unitsToString(value)));
}

async function refundAssetEscrowRecord(ctx, requestID) {
  const data = await ctx.stub.getState(`assetEscrow:${requestID}`);
  if (!data || data.length === 0) throw new Error(`asset escrow not found: ${requestID}`);
  const escrow = JSON.parse(data.toString());
  if (escrow.status !== 'Locked') throw new Error(`escrow is not locked: ${escrow.status}`);
  const balance = await getAssetBalanceUnits(ctx, escrow.owner, escrow.assetType);
  const amountUnits = BigInt(escrow.amountUnits);
  await putAssetBalanceUnits(ctx, escrow.owner, escrow.assetType, balance + amountUnits);
  escrow.status = 'Refunded';
  escrow.refundTxID = ctx.stub.getTxID();
  escrow.updatedAt = new Date().toISOString();
  await ctx.stub.putState(`assetEscrow:${requestID}`, Buffer.from(JSON.stringify(escrow)));
  ctx.stub.setEvent('ASSET_ESCROW_REFUNDED', Buffer.from(JSON.stringify({
    requestID,
    owner: escrow.owner,
    assetType: escrow.assetType,
    amountUnits: escrow.amountUnits
  })));
  return escrow;
}

function computeTargetExecutionHashFromHXMsg(hxmsg) {
  return ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes4', 'bytes32', 'bytes32'],
      [
        hxmsg.header.requestID,
        hxmsg.target.chainID,
        hxmsg.targetAction.targetObject,
        hxmsg.targetAction.functionSelector,
        hxmsg.targetAction.callDataHash,
        hxmsg.targetAction.receiver
      ]
    )
  );
}

function computeHXMsgDigest(hxmsg) {
  const feedback = normalizeFeedback(hxmsg.feedback);
  const headerHash = ethers.keccak256(
    ABI.encode(
      ['uint8', 'bytes32', 'uint8', 'uint64', 'uint64', 'uint64'],
      [
        Number(hxmsg.header.version),
        hxmsg.header.requestID,
        Number(hxmsg.header.msgType),
        Number(hxmsg.header.nonce),
        Number(hxmsg.header.createdAt),
        Number(hxmsg.header.expireAt)
      ]
    )
  );
  const endpointHash = ethers.keccak256(
    ABI.encode(
      ['uint8', 'bytes32', 'bytes32', 'uint8', 'bytes32', 'bytes32', 'uint8', 'bytes32'],
      [
        Number(hxmsg.source.chainType),
        hxmsg.source.chainID,
        hxmsg.source.domainID,
        Number(hxmsg.target.chainType),
        hxmsg.target.chainID,
        hxmsg.target.domainID,
        Number(hxmsg.sourceRef.refType),
        hxmsg.sourceRef.refHash
      ]
    )
  );
  const actionHash = ethers.keccak256(
    ABI.encode(
      ['uint8', 'bytes32', 'bytes4', 'bytes32', 'bytes32'],
      [
        Number(hxmsg.targetAction.actionType),
        hxmsg.targetAction.targetObject,
        hxmsg.targetAction.functionSelector,
        hxmsg.targetAction.callDataHash,
        hxmsg.targetAction.receiver
      ]
    )
  );
  const verificationHash = ethers.keccak256(
    ABI.encode(
      ['uint8', 'uint8', 'uint16', 'uint8', 'bytes32', 'bytes32', 'bytes32'],
      [
        Number(hxmsg.verification.verificationMethod),
        Number(hxmsg.verification.finalityModel),
        Number(hxmsg.verification.requiredConfirmations),
        Number(hxmsg.verification.policyRef.policyType),
        hxmsg.verification.policyRef.policyID,
        hxmsg.verification.policyRef.policyHash,
        hxmsg.verification.adapterID
      ]
    )
  );
  const bindingHash = ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes32', 'bytes32'],
      [
        hxmsg.payloadBinding.sourcePayloadHash,
        hxmsg.payloadBinding.businessPayloadHash,
        hxmsg.payloadBinding.targetExecutionHash
      ]
    )
  );
  const feedbackHash = ethers.keccak256(
    ABI.encode(
      ['bool', 'uint8', 'uint64', 'bytes32'],
      [feedback.required, feedback.expectedMsgType, feedback.timeout, feedback.callbackRefHash]
    )
  );
  const atomicity = normalizeAtomicity(hxmsg.atomicity);
  const atomicityHash = ethers.keccak256(
    ABI.encode(
      ['bool', 'uint8', 'uint8', 'bytes32', 'bytes32', 'bytes32', 'uint64'],
      [
        atomicity.required,
        atomicity.mode,
        atomicity.commitmentType,
        atomicity.commitmentRefHash,
        atomicity.successActionHash,
        atomicity.failureActionHash,
        atomicity.challengeWindow
      ]
    )
  );
  return ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [headerHash, endpointHash, actionHash, verificationHash, bindingHash, feedbackHash, atomicityHash]
    )
  );
}

function computeHXMsgDeliveryDigest(hxmsg) {
  const feedback = normalizeFeedback(hxmsg.feedback);
  const minimal = [
    hxmsg.header.requestID,
    hxmsg.hmsgDigest || computeHXMsgDigest(hxmsg),
    hxmsg.target.chainType,
    hxmsg.target.chainID,
    hxmsg.targetAction.actionType,
    hxmsg.targetAction.targetObject,
    hxmsg.targetAction.functionSelector,
    hxmsg.targetAction.callDataHash,
    hxmsg.targetAction.receiver,
    hxmsg.payloadBinding.targetExecutionHash,
    feedback.required,
    feedback.expectedMsgType,
    feedback.timeout,
    feedback.callbackRefHash,
    hxmsg.header.expireAt
  ];
  const chainHash = ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes32', 'uint8', 'bytes32', 'uint8'],
      [minimal[0], minimal[1], minimal[2], minimal[3], minimal[4]]
    )
  );
  const actionHash = ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes4', 'bytes32', 'bytes32', 'bytes32'],
      [minimal[5], minimal[6], minimal[7], minimal[8], minimal[9]]
    )
  );
  const feedbackHash = ethers.keccak256(
    ABI.encode(
      ['bool', 'uint8', 'uint64', 'bytes32', 'uint64'],
      [minimal[10], minimal[11], minimal[12], minimal[13], minimal[14]]
    )
  );
  return ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes32', 'bytes32'],
      [chainHash, actionHash, feedbackHash]
    )
  );
}

function businessKey(op, recordId) {
  return `${op}:${recordId}`;
}

function businessStatusForOp(op) {
  const statuses = {
    asset_lock: 'ASSET_SETTLED',
    mint_confirm: 'ASSET_SETTLED',
    receivable_attest: 'RECEIVABLE_ATTESTED',
    logistics_sync: 'LOGISTICS_SYNCED',
    medical_consent: 'CONSENT_GRANTED',
    oracle_update: 'ORACLE_UPDATED',
    approval_commit: 'APPROVAL_COMMITTED',
    subsidy_confirm: 'ASSET_SETTLED',
    token_transfer: 'TOKEN_TRANSFERRED',
    identity_attest: 'IDENTITY_ATTESTED',
    carbon_retire: 'CARBON_RETIRED',
    iot_alert: 'IOT_ALERT_RECORDED',
    certificate_verify: 'CERTIFICATE_VERIFIED',
    benchmark_store: 'BENCHMARK_STORED'
  };
  return statuses[op] || 'RECORDED';
}

function parseBusinessMetadata(metadata) {
  if (!metadata) return {};
  try {
    return JSON.parse(metadata);
  } catch (_error) {
    return {};
  }
}

async function applyTokenTransfer(ctx, parsedPayload, rawPayload) {
  // Fabric 侧真实转账：从一个逻辑 Fabric 账户扣款，并给另一个账户加款。
  // 该函数用于目标链 token_transfer 操作，不用于源链 escrow 锁定。
  const assetType = rawPayload.assetType || 'XCST';
  const from = rawPayload.from || rawPayload.sender || rawPayload.owner;
  const to = rawPayload.to || rawPayload.recipient || rawPayload.targetRecipient || parsedPayload.actor;
  if (!from || !to) throw new Error('token_transfer requires from and to');
  const amountUnits = parseAmountUnits(parsedPayload.amount);
  const fromBalance = await getAssetBalanceUnits(ctx, from, assetType);
  if (fromBalance < amountUnits) {
    throw new Error(`insufficient Fabric asset balance: ${fromBalance}/${amountUnits}`);
  }
  const toBalance = await getAssetBalanceUnits(ctx, to, assetType);
  await putAssetBalanceUnits(ctx, from, assetType, fromBalance - amountUnits);
  await putAssetBalanceUnits(ctx, to, assetType, toBalance + amountUnits);
  const transfer = {
    service: 'fabric-token-transfer',
    assetType,
    from,
    to,
    amountUnits: unitsToString(amountUnits),
    fromBalanceAfter: unitsToString(fromBalance - amountUnits),
    toBalanceAfter: unitsToString(toBalance + amountUnits)
  };
  await ctx.stub.putState(`fabricTransfer:${rawPayload.transferId || parsedPayload.recordId}`, Buffer.from(JSON.stringify(transfer)));
  return transfer;
}

async function creditFabricAsset(ctx, parsedPayload, rawPayload) {
  // Fabric 侧真实结算：在 EVM 源链事实被验证后，把规范化金额入账到接收方
  // Fabric 资产余额中。
  const assetType = rawPayload.assetType || 'XCST';
  const account = rawPayload.recipient || rawPayload.targetRecipient || rawPayload.beneficiary || rawPayload.applicant || parsedPayload.actor;
  if (!account) throw new Error(`${parsedPayload.op} requires recipient account`);
  const amountUnits = parseAmountUnits(parsedPayload.amount);
  const balance = await getAssetBalanceUnits(ctx, account, assetType);
  await putAssetBalanceUnits(ctx, account, assetType, balance + amountUnits);
  const settlement = {
    service: 'fabric-asset-settlement',
    assetType,
    account,
    amountUnits: unitsToString(amountUnits),
    balanceAfter: unitsToString(balance + amountUnits)
  };
  await ctx.stub.putState(`fabricSettlement:${parsedPayload.recordId}`, Buffer.from(JSON.stringify(settlement)));
  return settlement;
}

async function executeBusinessService(ctx, parsedPayload) {
  // 按业务类别分发目标链动作。下面每个分支都会写入领域专属账本对象，
  // 或真实改变 Fabric 资产余额，而不是只修改通用 inbound 状态。
  const rawPayload = parseBusinessMetadata(parsedPayload.metadata);
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(parsedPayload.metadata || ''));
  if (['asset_lock', 'mint_confirm', 'subsidy_confirm'].includes(parsedPayload.op)) {
    return creditFabricAsset(ctx, parsedPayload, rawPayload);
  }
  if (parsedPayload.op === 'token_transfer') {
    return applyTokenTransfer(ctx, parsedPayload, rawPayload);
  }
  if (parsedPayload.op === 'receivable_attest') {
    const result = {
      service: 'fabric-receivable-registry',
      receivableId: parsedPayload.recordId,
      supplier: parsedPayload.actor,
      amountUnits: unitsToString(parseAmountUnits(parsedPayload.amount)),
      metadataHash,
      attested: true
    };
    await ctx.stub.putState(`receivable:${parsedPayload.recordId}`, Buffer.from(JSON.stringify(result)));
    return result;
  }
  if (parsedPayload.op === 'logistics_sync') {
    const result = {
      service: 'fabric-logistics-tracker',
      waybillId: parsedPayload.recordId,
      inspector: parsedPayload.actor,
      reading: parsedPayload.amount,
      metadataHash
    };
    await ctx.stub.putState(`logistics:${parsedPayload.recordId}`, Buffer.from(JSON.stringify(result)));
    return result;
  }
  if (parsedPayload.op === 'medical_consent') {
    const durationDays = Number(parsedPayload.amount);
    if (!Number.isInteger(durationDays) || durationDays <= 0) throw new Error('medical_consent requires positive duration');
    const now = getTxTime(ctx);
    const result = {
      service: 'fabric-consent-registry',
      consentId: parsedPayload.recordId,
      grantee: parsedPayload.actor,
      durationDays,
      grantedAt: now,
      expiresAt: now + durationDays * 24 * 3600,
      active: true,
      metadataHash
    };
    await ctx.stub.putState(`consent:${parsedPayload.recordId}`, Buffer.from(JSON.stringify(result)));
    return result;
  }
  if (parsedPayload.op === 'oracle_update') {
    const result = {
      service: 'fabric-oracle-feed',
      feedId: parsedPayload.recordId,
      publisher: parsedPayload.actor,
      priceUnits: unitsToString(parseAmountUnits(parsedPayload.amount)),
      metadataHash
    };
    await ctx.stub.putState(`oracle:${parsedPayload.recordId}`, Buffer.from(JSON.stringify(result)));
    return result;
  }
  if (parsedPayload.op === 'approval_commit') {
    const threshold = Number(parsedPayload.amount);
    if (!Number.isInteger(threshold) || threshold <= 0) throw new Error('approval_commit requires positive threshold');
    const result = {
      service: 'fabric-approval-workflow',
      workflowId: parsedPayload.recordId,
      approvers: parsedPayload.actor,
      threshold,
      passed: true,
      metadataHash
    };
    await ctx.stub.putState(`approval:${parsedPayload.recordId}`, Buffer.from(JSON.stringify(result)));
    return result;
  }
  throw new Error(`unsupported business op: ${parsedPayload.op}`);
}

async function applyBusinessAction(ctx, { requestID, hmsgDigest, callDataHash, parsedPayload, sourceChainType }) {
  const key = businessKey(parsedPayload.op, parsedPayload.recordId);
  const serviceResult = await executeBusinessService(ctx, parsedPayload);
  const record = {
    requestID,
    businessKey: key,
    op: parsedPayload.op,
    recordId: parsedPayload.recordId,
    actor: parsedPayload.actor,
    amount: parsedPayload.amount,
    metadataHash: ethers.keccak256(ethers.toUtf8Bytes(parsedPayload.metadata || '')),
    requireAck: Boolean(parsedPayload.requireAck),
    status: businessStatusForOp(parsedPayload.op),
    service: serviceResult.service,
    serviceResultHash: ethers.keccak256(ethers.toUtf8Bytes(stableStringify(serviceResult))),
    serviceResult,
    sourceChainType,
    hmsgDigest,
    callDataHash,
    fabricTxId: ctx.stub.getTxID(),
    updatedAt: new Date().toISOString()
  };
  await ctx.stub.putState(`business:${key}`, Buffer.from(JSON.stringify(record)));
  await ctx.stub.putState(`businessByRequest:${requestID}`, Buffer.from(JSON.stringify(record)));
  await ctx.stub.putState(`businessOp:${parsedPayload.op}:${requestID}`, Buffer.from(JSON.stringify({
    requestID,
    businessKey: key,
    status: record.status,
    updatedAt: record.updatedAt
  })));
  ctx.stub.setEvent('BUSINESS_ACTION_APPLIED', Buffer.from(JSON.stringify(record)));
  return record;
}

async function isTrustedTEE(ctx, address) {
  const key = `trustedTEE:${ethers.getAddress(address)}`;
  const data = await ctx.stub.getState(key);
  return data && data.length > 0;
}

function assertTEERegistrar(ctx) {
  const allowedMSPs = ['Org1MSP'];
  const mspid = ctx.clientIdentity.getMSPID();
  if (!allowedMSPs.includes(mspid)) {
    throw new Error(`MSP ${mspid} is not allowed to register TEE`);
  }
}

async function verifyTEECertification(ctx, hxmsg, certEnvelope) {
  const hmsgDigest = computeHXMsgDigest(hxmsg);
  const certs = certEnvelope.certifications || (
    certEnvelope.teeCertification ? [certEnvelope.teeCertification] : [certEnvelope]
  );
  const threshold = Number(certEnvelope.threshold || 1);
  const seen = new Set();
  let valid = 0;
  for (const cert of certs) {
    if (!cert || cert.requestID !== hxmsg.header.requestID) continue;
    if (String(cert.hmsgDigest).toLowerCase() !== hmsgDigest.toLowerCase()) continue;
    const expectedSigningDigest = cert.signatureDigestType === 'deliveryDigest'
      ? computeHXMsgDeliveryDigest({ ...hxmsg, hmsgDigest })
      : hmsgDigest;
    if (String(cert.signingDigest || expectedSigningDigest).toLowerCase() !== expectedSigningDigest.toLowerCase()) continue;
    const signer = ethers.getAddress(ethers.recoverAddress(expectedSigningDigest, cert.signature));
    if (signer !== ethers.getAddress(cert.teeAddress)) continue;
    if (!(await isTrustedTEE(ctx, signer))) continue;
    if (seen.has(signer)) continue;
    seen.add(signer);
    valid += 1;
  }
  if (valid < threshold) {
    throw new Error(`TEE quorum not satisfied: ${valid}/${threshold}`);
  }
  return { hmsgDigest, validTEECount: valid, threshold, signers: Array.from(seen) };
}

async function verifyTEEDigestCertification(ctx, requestID, digest, certEnvelope) {
  const certs = certEnvelope.certifications || (
    certEnvelope.teeCertification ? [certEnvelope.teeCertification] : [certEnvelope]
  );
  const threshold = Number(certEnvelope.threshold || 1);
  const seen = new Set();
  let valid = 0;
  for (const cert of certs) {
    if (!cert || cert.requestID !== requestID) continue;
    if (String(cert.hmsgDigest).toLowerCase() !== String(digest).toLowerCase()) continue;
    const signer = ethers.getAddress(ethers.recoverAddress(digest, cert.signature));
    if (signer !== ethers.getAddress(cert.teeAddress)) continue;
    if (!(await isTrustedTEE(ctx, signer))) continue;
    if (seen.has(signer)) continue;
    seen.add(signer);
    valid += 1;
  }
  if (valid < threshold) {
    throw new Error(`TEE quorum not satisfied: ${valid}/${threshold}`);
  }
  return { digest, validTEECount: valid, threshold, signers: Array.from(seen) };
}

function getTxTime(ctx) {
  const ts = ctx.stub.getTxTimestamp();
  return Number(ts.seconds.low || ts.seconds || Math.floor(Date.now() / 1000));
}

async function getCommitment(ctx, requestID) {
  const data = await ctx.stub.getState(`commitment:${requestID}`);
  if (!data || data.length === 0) {
    throw new Error(`commitment not found: ${requestID}`);
  }
  return JSON.parse(data.toString());
}

async function putCommitment(ctx, record) {
  await ctx.stub.putState(`commitment:${record.requestID}`, Buffer.from(JSON.stringify(record)));
}

class XCallContract extends Contract {
  async InitLedger() {
    return;
  }

  async EmitXCall(ctx, payloadJson) {
    let payload;
    try {
      payload = JSON.parse(payloadJson);
    } catch (error) {
      throw new Error(`payloadJson must be valid JSON: ${error.message}`);
    }

    const nonceKey = 'xcall_nonce';
    const nonceBytes = await ctx.stub.getState(nonceKey);
    const nonce = nonceBytes && nonceBytes.length > 0 ? Number(nonceBytes.toString()) + 1 : 1;
    await ctx.stub.putState(nonceKey, Buffer.from(String(nonce)));

    const txId = ctx.stub.getTxID();
    const txTime = ctx.stub.getTxTimestamp();
    const createdAt = Number(txTime.seconds.low || txTime.seconds || Math.floor(Date.now() / 1000));
    const requestID = payload.requestID || ethers.keccak256(
      ethers.toUtf8Bytes(`fabric:${ctx.stub.getChannelID()}:${txId}:${nonce}`)
    );
    const businessPayload = payload.businessPayload || payload.payload || payload;
    const businessPayloadHash = payload.businessPayloadHash || hashJson(businessPayload);
    const targetObject = payload.targetObject || (
      payload.targetContract ? addressToBytes32(payload.targetContract) : ethers.ZeroHash
    );
    const receiver = payload.receiver || targetObject;
    const functionSelector = payload.functionSelector || selectorOf('execute(bytes32,bytes)');
    const callDataHash = payload.callDataHash;
    if (!callDataHash) {
      throw new Error('payload.callDataHash is required for h-xmsg binding');
    }
    const expireAt = Number(payload.expireAt || (createdAt + 3600));

    const feedback = normalizeFeedback(payload.feedback || {
      required: Boolean(businessPayload.requireAck || payload.requireAck),
      expectedMsgType: businessPayload.requireAck || payload.requireAck ? 2 : 0,
      timeout: businessPayload.requireAck || payload.requireAck ? expireAt : 0,
      callbackRefHash: payload.callbackRefHash || ethers.ZeroHash
    });
    const atomicity = normalizeAtomicity(payload.atomicity);
    const feedbackHash = computeFeedbackHash(feedback);
    const atomicityHash = computeAtomicityHash(atomicity);

    const eventRecord = {
      requestID,
      sourceTxID: txId,
      fabricCaller: ctx.clientIdentity.getID(),
      targetChainType: payload.targetChainType || 'EVM',
      targetChainID: payload.targetChainID || '',
      targetObject,
      functionSelector,
      callDataHash,
      businessPayloadHash,
      receiver,
      nonce,
      createdAt,
      expireAt,
      status: 'COMMITTED',
      businessPayload,
      feedback,
      feedbackHash,
      atomicity,
      atomicityHash
    };
    const executionTargetChainID = payload.targetChainID || ethers.ZeroHash;
    const targetExecutionHash = ethers.keccak256(
      ABI.encode(
        ['bytes32', 'bytes32', 'bytes32', 'bytes4', 'bytes32', 'bytes32'],
        [requestID, executionTargetChainID, targetObject, functionSelector, callDataHash, receiver]
      )
    );
    const eventPayload = {
      ...eventRecord,
      fabricTxId: txId,
      fabricNonce: nonce,
      emittedAt: new Date(createdAt * 1000).toISOString()
    };

    await ctx.stub.putState(`xcall:${txId}`, Buffer.from(JSON.stringify(eventPayload)));
    await ctx.stub.putState(`crosschainEvents:${requestID}`, Buffer.from(JSON.stringify(eventRecord)));
    await ctx.stub.putState(`outbound:${txId}`, Buffer.from(JSON.stringify({
      txId,
      requestID,
      nonce,
      status: 'pending',
      updatedAt: new Date().toISOString()
    })));
    if (atomicity.required) {
      if (!feedback.required || Number(feedback.expectedMsgType) !== 2) {
        throw new Error('atomic h-xmsg requires RESPONSE feedback');
      }
      if (!atomicity.challengeWindow) {
        throw new Error('atomicity.challengeWindow is required');
      }
      const commitment = {
        requestID,
        owner: ctx.clientIdentity.getID(),
        sourceTxID: txId,
        hmsgDigest: payload.hmsgDigest || ethers.ZeroHash,
        targetExecutionHash,
        commitmentType: atomicity.commitmentType,
        commitmentRefHash: atomicity.commitmentRefHash,
        successActionHash: atomicity.successActionHash,
        failureActionHash: atomicity.failureActionHash,
        feedbackTimeout: feedback.timeout || expireAt,
        challengeWindow: atomicity.challengeWindow,
        challengeDeadline: 0,
        status: 'Pending',
        createdAt,
        updatedAt: new Date().toISOString()
      };
      await putCommitment(ctx, commitment);
    }
    ctx.stub.setEvent('XCALL', Buffer.from(JSON.stringify(eventPayload)));

    return JSON.stringify({
      ok: true,
      txId,
      requestID,
      nonce,
      eventName: 'XCALL'
    });
  }

  async InitAssetBalance(ctx, account, assetType, amount) {
    const units = parseAmountUnits(amount);
    await putAssetBalanceUnits(ctx, account, assetType || 'XCST', units);
    return JSON.stringify({ ok: true, account, assetType: assetType || 'XCST', balanceUnits: unitsToString(units) });
  }

  async QueryAssetBalance(ctx, account, assetType) {
    const units = await getAssetBalanceUnits(ctx, account, assetType || 'XCST');
    return JSON.stringify({ account, assetType: assetType || 'XCST', balanceUnits: unitsToString(units) });
  }

  async QueryAssetEscrow(ctx, requestID) {
    const data = await ctx.stub.getState(`assetEscrow:${requestID}`);
    return data && data.length > 0 ? data.toString() : '';
  }

  async LockAssetXCall(ctx, payloadJson) {
    const payload = parseJson(payloadJson, 'payloadJson');
    const businessPayload = payload.businessPayload || payload.payload || payload;
    const owner = businessPayload.owner || businessPayload.actor;
    if (!owner) throw new Error('asset lock owner is required');
    const assetType = businessPayload.assetType || payload.assetType || 'XCST';
    const amount = businessPayload.amount;
    const amountUnits = parseAmountUnits(amount);
    if (amountUnits <= 0n) throw new Error('asset lock amount must be positive');

    const before = await getAssetBalanceUnits(ctx, owner, assetType);
    if (before < amountUnits) {
      throw new Error(`insufficient Fabric asset balance: ${before}/${amountUnits}`);
    }

    const nonceKey = 'xcall_nonce';
    const nonceBytes = await ctx.stub.getState(nonceKey);
    const nonce = nonceBytes && nonceBytes.length > 0 ? Number(nonceBytes.toString()) + 1 : 1;
    await ctx.stub.putState(nonceKey, Buffer.from(String(nonce)));

    const txId = ctx.stub.getTxID();
    const txTime = ctx.stub.getTxTimestamp();
    const createdAt = Number(txTime.seconds.low || txTime.seconds || Math.floor(Date.now() / 1000));
    const requestID = payload.requestID || ethers.keccak256(
      ethers.toUtf8Bytes(`fabric-lock:${ctx.stub.getChannelID()}:${txId}:${nonce}`)
    );
    const targetObject = payload.targetObject || (
      payload.targetContract ? addressToBytes32(payload.targetContract) : ethers.ZeroHash
    );
    const receiver = payload.receiver || targetObject;
    const functionSelector = payload.functionSelector || selectorOf('execute(bytes32,bytes)');
    const callDataHash = payload.callDataHash;
    if (!callDataHash) throw new Error('payload.callDataHash is required for h-xmsg binding');
    const expireAt = Number(payload.expireAt || (createdAt + 3600));
    const feedback = normalizeFeedback(payload.feedback);
    const atomicity = normalizeAtomicity(payload.atomicity);
    const feedbackHash = computeFeedbackHash(feedback);
    const atomicityHash = computeAtomicityHash(atomicity);
    const businessPayloadHash = payload.businessPayloadHash || hashJson(businessPayload);

    await putAssetBalanceUnits(ctx, owner, assetType, before - amountUnits);
    const escrow = {
      requestID,
      owner,
      assetType,
      amount,
      amountUnits: unitsToString(amountUnits),
      status: 'Locked',
      sourceTxID: txId,
      createdAt,
      updatedAt: new Date(createdAt * 1000).toISOString()
    };
    await ctx.stub.putState(`assetEscrow:${requestID}`, Buffer.from(JSON.stringify(escrow)));

    const eventRecord = {
      requestID,
      sourceTxID: txId,
      fabricCaller: ctx.clientIdentity.getID(),
      targetChainType: payload.targetChainType || 'EVM',
      targetChainID: payload.targetChainID || '',
      targetObject,
      functionSelector,
      callDataHash,
      businessPayloadHash,
      receiver,
      nonce,
      createdAt,
      expireAt,
      status: 'COMMITTED',
      businessPayload,
      assetLock: escrow,
      feedback,
      feedbackHash,
      atomicity,
      atomicityHash
    };
    const executionTargetChainID = payload.targetChainID || ethers.ZeroHash;
    const targetExecutionHash = ethers.keccak256(
      ABI.encode(
        ['bytes32', 'bytes32', 'bytes32', 'bytes4', 'bytes32', 'bytes32'],
        [requestID, executionTargetChainID, targetObject, functionSelector, callDataHash, receiver]
      )
    );
    if (atomicity.required) {
      await putCommitment(ctx, {
        requestID,
        owner: ctx.clientIdentity.getID(),
        sourceTxID: txId,
        hmsgDigest: payload.hmsgDigest || ethers.ZeroHash,
        targetExecutionHash,
        commitmentType: atomicity.commitmentType,
        commitmentRefHash: atomicity.commitmentRefHash,
        successActionHash: atomicity.successActionHash,
        failureActionHash: atomicity.failureActionHash,
        feedbackTimeout: feedback.timeout || expireAt,
        challengeWindow: atomicity.challengeWindow,
        challengeDeadline: 0,
        status: 'Pending',
        createdAt,
        updatedAt: new Date().toISOString()
      });
    }
    await ctx.stub.putState(`xcall:${txId}`, Buffer.from(JSON.stringify({ ...eventRecord, fabricTxId: txId, fabricNonce: nonce })));
    await ctx.stub.putState(`crosschainEvents:${requestID}`, Buffer.from(JSON.stringify(eventRecord)));
    await ctx.stub.putState(`outbound:${txId}`, Buffer.from(JSON.stringify({
      txId,
      requestID,
      nonce,
      status: 'asset_locked',
      updatedAt: new Date().toISOString()
    })));
    ctx.stub.setEvent('ASSET_LOCKED_XCALL', Buffer.from(JSON.stringify({ requestID, txId, owner, assetType, amountUnits: unitsToString(amountUnits) })));
    return JSON.stringify({ ok: true, txId, requestID, nonce, escrow });
  }

  async RefundAssetEscrow(ctx, requestID) {
    const escrow = await refundAssetEscrowRecord(ctx, requestID);
    return JSON.stringify({ ok: true, requestID, escrow });
  }

  async QueryCrosschainEvent(ctx, requestID) {
    const data = await ctx.stub.getState(`crosschainEvents:${requestID}`);
    if (!data || data.length === 0) {
      throw new Error(`crosschain event not found: ${requestID}`);
    }
    return data.toString();
  }

  async RegisterTrustedTEE(ctx, teeAddress) {
    assertTEERegistrar(ctx);
    const address = ethers.getAddress(teeAddress);
    await ctx.stub.putState(`trustedTEE:${address}`, Buffer.from(JSON.stringify({
      address,
      registeredByMSP: ctx.clientIdentity.getMSPID(),
      updatedAt: new Date().toISOString()
    })));
    return JSON.stringify({ ok: true, address });
  }

  async QueryTrustedTEE(ctx, teeAddress) {
    const address = ethers.getAddress(teeAddress);
    const data = await ctx.stub.getState(`trustedTEE:${address}`);
    return data && data.length > 0 ? data.toString() : '';
  }

  async ExecuteHXMsg(ctx, hxmsgJson, callDataHex, certJson) {
    const hxmsg = parseJson(hxmsgJson, 'hxmsgJson');
    const certEnvelope = parseJson(certJson, 'certJson');
    const requestID = hxmsg.header.requestID;
    const consumedKey = `hxmsg-consumed:${requestID}`;
    const consumed = await ctx.stub.getState(consumedKey);
    if (consumed && consumed.length > 0) {
      throw new Error('replay requestID');
    }

    const now = Number(ctx.stub.getTxTimestamp().seconds.low || ctx.stub.getTxTimestamp().seconds || Math.floor(Date.now() / 1000));
    if (Number(hxmsg.header.expireAt) < now) throw new Error('h-xmsg expired');
    if (Number(hxmsg.target.chainType) !== 2) throw new Error('target is not Fabric');
    if (Number(hxmsg.targetAction.actionType) !== 5) throw new Error('action is not chaincode invoke');

    const expectedChainID = bytes32FromText(`fabric-${ctx.stub.getChannelID()}`);
    const expectedDomainID = bytes32FromText('fabric-local-domain');
    const expectedTargetObject = bytes32FromText(`fabric:${ctx.stub.getChannelID()}:xcall`);
    if (String(hxmsg.target.chainID).toLowerCase() !== expectedChainID.toLowerCase()) {
      throw new Error('Fabric target chainID mismatch');
    }
    if (String(hxmsg.target.domainID).toLowerCase() !== expectedDomainID.toLowerCase()) {
      throw new Error('Fabric target domainID mismatch');
    }
    if (String(hxmsg.targetAction.targetObject).toLowerCase() !== expectedTargetObject.toLowerCase()) {
      throw new Error('Fabric target object mismatch');
    }
    if (String(hxmsg.targetAction.callDataHash).toLowerCase() !== ethers.keccak256(callDataHex).toLowerCase()) {
      throw new Error('callDataHash mismatch');
    }
    const targetExecutionHash = computeTargetExecutionHashFromHXMsg(hxmsg);
    if (String(hxmsg.payloadBinding.targetExecutionHash).toLowerCase() !== targetExecutionHash.toLowerCase()) {
      throw new Error('targetExecutionHash mismatch');
    }

    const certResult = await verifyTEECertification(ctx, hxmsg, certEnvelope);
    const parsedPayload = decodeBusinessPayload(callDataHex);
    const businessRecord = await applyBusinessAction(ctx, {
      requestID,
      hmsgDigest: certResult.hmsgDigest,
      callDataHash: hxmsg.targetAction.callDataHash,
      parsedPayload,
      sourceChainType: hxmsg.source.chainType
    });
    const record = {
      requestID,
      txId: ctx.stub.getTxID(),
      callerMSP: ctx.clientIdentity.getMSPID(),
      hmsgDigest: certResult.hmsgDigest,
      validTEECount: certResult.validTEECount,
      teeThreshold: certResult.threshold,
      teeSigners: certResult.signers,
      sourceChainType: hxmsg.source.chainType,
      sourceTxID: hxmsg.txId || '',
      srcHeight: hxmsg.srcHeight || 0,
      callDataHash: hxmsg.targetAction.callDataHash,
      businessPayloadHash: hxmsg.payloadBinding.businessPayloadHash,
      op: parsedPayload.op,
      recordId: parsedPayload.recordId,
      actor: parsedPayload.actor,
      amount: parsedPayload.amount,
      metadata: parsedPayload.metadata,
      requireAck: Boolean(parsedPayload.requireAck),
      businessKey: businessRecord.businessKey,
      businessStatus: businessRecord.status,
      status: 'executed',
      updatedAt: new Date().toISOString()
    };

    await ctx.stub.putState(consumedKey, Buffer.from('1'));
    await ctx.stub.putState(`crosschainExec:${requestID}`, Buffer.from(JSON.stringify(record)));
    await ctx.stub.putState(`inbound:${requestID}`, Buffer.from(JSON.stringify(record)));
    ctx.stub.setEvent('HXMSG_EXECUTED', Buffer.from(JSON.stringify(record)));

    return JSON.stringify({ ok: true, requestID, status: 'executed', validTEECount: certResult.validTEECount });
  }

  async GetInboundStatus(ctx, requestID) {
    const data = await ctx.stub.getState(`inbound:${requestID}`);
    return data && data.length > 0 ? data.toString() : '';
  }

  async QueryBusinessRecord(ctx, op, recordId) {
    const data = await ctx.stub.getState(`business:${businessKey(op, recordId)}`);
    return data && data.length > 0 ? data.toString() : '';
  }

  async QueryBusinessRecordByRequest(ctx, requestID) {
    const data = await ctx.stub.getState(`businessByRequest:${requestID}`);
    return data && data.length > 0 ? data.toString() : '';
  }

  async QueryCommitment(ctx, requestID) {
    const data = await ctx.stub.getState(`commitment:${requestID}`);
    return data && data.length > 0 ? data.toString() : '';
  }

  async BindCommitmentHXMsg(ctx, hxmsgJson, certJson) {
    const hxmsg = parseJson(hxmsgJson, 'hxmsgJson');
    const certEnvelope = parseJson(certJson, 'certJson');
    const requestID = hxmsg.header.requestID;
    const record = await getCommitment(ctx, requestID);
    if (!['Pending', 'Challenged'].includes(record.status)) {
      throw new Error(`bad state: ${record.status}`);
    }
    if (record.hmsgDigest && record.hmsgDigest !== ethers.ZeroHash) {
      throw new Error('hmsgDigest already bound');
    }
    if (String(record.sourceTxID).toLowerCase() !== String(hxmsg.txId).toLowerCase()) {
      throw new Error('sourceTxID mismatch');
    }
    const targetExecutionHash = computeTargetExecutionHashFromHXMsg(hxmsg);
    if (String(targetExecutionHash).toLowerCase() !== String(record.targetExecutionHash).toLowerCase()) {
      throw new Error('targetExecutionHash mismatch');
    }
    const certResult = await verifyTEECertification(ctx, hxmsg, certEnvelope);
    record.hmsgDigest = certResult.hmsgDigest;
    record.validTEECount = certResult.validTEECount;
    record.teeThreshold = certResult.threshold;
    record.boundAt = getTxTime(ctx);
    record.updatedAt = new Date(record.boundAt * 1000).toISOString();
    await putCommitment(ctx, record);
    ctx.stub.setEvent('COMMITMENT_HXMSG_BOUND', Buffer.from(JSON.stringify({
      requestID,
      hmsgDigest: record.hmsgDigest,
      validTEECount: certResult.validTEECount
    })));
    return JSON.stringify({
      ok: true,
      requestID,
      hmsgDigest: record.hmsgDigest,
      validTEECount: certResult.validTEECount
    });
  }

  async StartChallenge(ctx, requestID) {
    const record = await getCommitment(ctx, requestID);
    if (record.status !== 'Pending') {
      throw new Error(`bad state: ${record.status}`);
    }
    const now = getTxTime(ctx);
    if (now <= Number(record.feedbackTimeout)) {
      throw new Error('not timeout');
    }
    record.status = 'Challenged';
    record.challengeDeadline = now + Number(record.challengeWindow);
    record.updatedAt = new Date(now * 1000).toISOString();
    await putCommitment(ctx, record);
    ctx.stub.setEvent('CHALLENGE_STARTED', Buffer.from(JSON.stringify({
      requestID,
      challengeDeadline: record.challengeDeadline
    })));
    return JSON.stringify({ ok: true, requestID, status: record.status, challengeDeadline: record.challengeDeadline });
  }

  async CompleteWithResponse(ctx, requestID, responseJson, certJson) {
    const record = await getCommitment(ctx, requestID);
    if (!['Pending', 'Challenged'].includes(record.status)) {
      throw new Error(`bad state: ${record.status}`);
    }
    const response = parseJson(responseJson, 'responseJson');
    const certEnvelope = parseJson(certJson, 'certJson');
    if (String(response.originRequestID).toLowerCase() !== String(requestID).toLowerCase()) {
      throw new Error('bad originRequestID');
    }
    if (!record.hmsgDigest || record.hmsgDigest === ethers.ZeroHash) {
      throw new Error('hmsgDigest not bound');
    }
    if (String(response.originHmsgDigest).toLowerCase() !== String(record.hmsgDigest).toLowerCase()) {
      throw new Error('bad originHmsgDigest');
    }
    if (String(response.targetExecutionHash).toLowerCase() !== String(record.targetExecutionHash).toLowerCase()) {
      throw new Error('bad targetExecutionHash');
    }
    if (Number(response.responseStatus) !== 1) {
      throw new Error('response is not EXECUTED');
    }
    const responseDigest = computeResponseDigest(response);
    const consumedKey = `response-consumed:${responseDigest}`;
    const consumed = await ctx.stub.getState(consumedKey);
    if (consumed && consumed.length > 0) {
      throw new Error('response replay');
    }
    const certResult = await verifyTEEDigestCertification(ctx, requestID, responseDigest, certEnvelope);
    record.status = 'Completed';
    record.responseDigest = responseDigest;
    record.validTEECount = certResult.validTEECount;
    record.teeThreshold = certResult.threshold;
    record.completedAt = getTxTime(ctx);
    record.updatedAt = new Date(record.completedAt * 1000).toISOString();
    await ctx.stub.putState(consumedKey, Buffer.from('1'));
    await putCommitment(ctx, record);
    ctx.stub.setEvent('RESPONSE_COMPLETED', Buffer.from(JSON.stringify({
      requestID,
      responseDigest,
      validTEECount: certResult.validTEECount
    })));
    return JSON.stringify({ ok: true, requestID, status: record.status, responseDigest });
  }

  async CompensateAfterChallenge(ctx, requestID, failureDataJson) {
    const record = await getCommitment(ctx, requestID);
    if (record.status !== 'Challenged') {
      throw new Error(`bad state: ${record.status}`);
    }
    const now = getTxTime(ctx);
    if (now <= Number(record.challengeDeadline)) {
      throw new Error('challenge active');
    }
    const failureHash = ethers.keccak256(ethers.toUtf8Bytes(failureDataJson || ''));
    if (String(failureHash).toLowerCase() !== String(record.failureActionHash).toLowerCase()) {
      throw new Error('bad failure data');
    }
    if (Number(record.commitmentType) !== 3) throw new Error('unsupported commitment');
    let compensationResult = null;
    compensationResult = await refundAssetEscrowRecord(ctx, requestID);
    record.status = 'Compensated';
    record.compensationHandler = 'asset-escrow-refund';
    record.compensationResultHash = compensationResult
      ? ethers.keccak256(ethers.toUtf8Bytes(stableStringify(compensationResult)))
      : ethers.ZeroHash;
    record.compensatedAt = now;
    record.updatedAt = new Date(now * 1000).toISOString();
    await putCommitment(ctx, record);
    ctx.stub.setEvent('REQUEST_COMPENSATED', Buffer.from(JSON.stringify({
      requestID,
      commitmentType: record.commitmentType,
      compensationHandler: record.compensationHandler,
      compensationResultHash: record.compensationResultHash
    })));
    return JSON.stringify({
      ok: true,
      requestID,
      status: record.status,
      compensationHandler: record.compensationHandler,
      compensationResultHash: record.compensationResultHash
    });
  }

  async GetAckStatus(ctx, originRequestID) {
    const data = await ctx.stub.getState(`ack:${originRequestID}`);
    return data && data.length > 0 ? data.toString() : '';
  }
}

module.exports.contracts = [XCallContract];
