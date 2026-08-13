'use strict';

const { Contract } = require('fabric-contract-api');
const { ethers } = require('ethers');

const ABI = ethers.AbiCoder.defaultAbiCoder();
const TEE_CERTIFICATE_DOMAIN = ethers.id('HXMSG_TEE_SUBNET_CERTIFICATE_V1');
const BATCH_DOMAIN = ethers.id('HXMSG_BATCH_V1');
const LIFECYCLE_CHECKPOINT_DOMAIN = ethers.id('HXMSG_LIFECYCLE_CHECKPOINT_V1');
const TERMINAL_STATUS_CODE = Object.freeze({ Completed: 3, Compensated: 4, Failed: 5, Cancelled: 6 });

function parseJson(value, fieldName) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${fieldName} must be valid JSON: ${error.message}`);
  }
}

function strip0x(value) {
  return String(value || '').startsWith('0x') ? String(value).slice(2) : String(value || '');
}

function selectedSignerHash(participants) {
  const sorted = [...participants].sort((a, b) => Number(a.signerIndex) - Number(b.signerIndex));
  return ethers.keccak256(
    ABI.encode(
      ['uint16[]', 'address[]', 'bytes32[]'],
      [
        sorted.map((item) => Number(item.signerIndex)),
        sorted.map((item) => ethers.getAddress(item.teeAddress)),
        sorted.map((item) => item.enclavePubKeyHash),
      ]
    )
  );
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
  feedback = feedback || {};
  return {
    required: Boolean(feedback.required),
    expectedMsgType: Number(feedback.expectedMsgType || 0),
    timeout: Number(feedback.timeout || 0),
    callbackRefHash: feedback.callbackRefHash || ethers.ZeroHash
  };
}

function compactBusinessCallTuple(compact) {
  return [
    Number(compact.opCode),
    compact.recordIdHash,
    compact.actorHash,
    compact.actorAddress || ethers.ZeroAddress,
    BigInt(compact.amount),
    compact.metadataHash,
    Boolean(compact.requireAck)
  ];
}

function hashCompactBusinessCall(compact) {
  return ethers.keccak256(
    ABI.encode(
      ['uint16', 'bytes32', 'bytes32', 'address', 'int256', 'bytes32', 'bool'],
      compactBusinessCallTuple(compact)
    )
  );
}

const COMPACT_OP_CODES = Object.freeze({
  asset_lock: 1,
  mint_confirm: 2,
  receivable_attest: 3,
  logistics_sync: 4,
  medical_consent: 5,
  oracle_update: 6,
  approval_commit: 7,
  subsidy_confirm: 8,
  token_transfer: 9
});

function parseUintUnits(value) {
  const text = String(value || '0');
  if (!/^[0-9]+$/.test(text)) throw new Error(`invalid uint amount: ${text}`);
  return BigInt(text);
}

function compactAmountUnitsForPayload(payload) {
  if (payload.op === 'medical_consent' || payload.op === 'approval_commit') {
    return parseUintUnits(payload.amount);
  }
  return parseAmountUnits(payload.amount);
}

function isEvmAddress(value) {
  return /^0x[0-9a-fA-F]{40}$/.test(String(value || ''));
}

function assertCompactPayloadMatchesBusiness(compact, payload) {
  const expectedOpCode = COMPACT_OP_CODES[payload.op];
  if (!expectedOpCode) throw new Error(`unsupported compact business op: ${payload.op}`);
  if (Number(compact.opCode) !== expectedOpCode) throw new Error('compact opCode mismatch');
  if (String(compact.recordIdHash).toLowerCase() !== ethers.keccak256(ethers.toUtf8Bytes(String(payload.recordId))).toLowerCase()) {
    throw new Error('compact recordIdHash mismatch');
  }
  if (String(compact.actorHash).toLowerCase() !== ethers.keccak256(ethers.toUtf8Bytes(String(payload.actor))).toLowerCase()) {
    throw new Error('compact actorHash mismatch');
  }
  const expectedActorAddress = isEvmAddress(payload.actor) ? ethers.getAddress(payload.actor) : ethers.ZeroAddress;
  if (ethers.getAddress(compact.actorAddress || ethers.ZeroAddress) !== expectedActorAddress) {
    throw new Error('compact actorAddress mismatch');
  }
  if (BigInt(compact.amount) !== compactAmountUnitsForPayload(payload)) {
    throw new Error('compact amount mismatch');
  }
  if (String(compact.metadataHash).toLowerCase() !== ethers.keccak256(ethers.toUtf8Bytes(String(payload.metadata || ''))).toLowerCase()) {
    throw new Error('compact metadataHash mismatch');
  }
  if (Boolean(compact.requireAck) !== Boolean(payload.requireAck)) {
    throw new Error('compact requireAck mismatch');
  }
}

function normalizeAtomicity(atomicity = {}) {
  atomicity = atomicity || {};
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

function validateResponsePolicy(feedback, atomicity) {
  if (feedback.required) {
    if (Number(feedback.expectedMsgType) !== 2) throw new Error('feedback requires RESPONSE message type');
    if (Number(feedback.timeout) <= 0) throw new Error('feedback.timeout is required');
  } else if (Number(feedback.expectedMsgType) !== 0 || Number(feedback.timeout) !== 0
      || String(feedback.callbackRefHash).toLowerCase() !== ethers.ZeroHash) {
    throw new Error('one-way h-xmsg contains unexpected feedback fields');
  }
  if (atomicity.required) {
    if (!feedback.required) throw new Error('atomicity requires RESPONSE feedback');
    if (Number(atomicity.mode) !== 1) throw new Error('bad atomicity mode');
    if (Number(atomicity.challengeWindow) <= 0) throw new Error('atomicity.challengeWindow is required');
  } else if (Number(atomicity.mode) !== 0 || Number(atomicity.commitmentType) !== 0
      || String(atomicity.commitmentRefHash).toLowerCase() !== ethers.ZeroHash
      || String(atomicity.successActionHash).toLowerCase() !== ethers.ZeroHash
      || String(atomicity.failureActionHash).toLowerCase() !== ethers.ZeroHash
      || Number(atomicity.challengeWindow) !== 0) {
    throw new Error('non-atomic h-xmsg contains unexpected atomicity fields');
  }
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

async function settleAssetEscrowRecord(ctx, requestID) {
  const data = await ctx.stub.getState(`assetEscrow:${requestID}`);
  if (!data || data.length === 0) throw new Error(`asset escrow not found: ${requestID}`);
  const escrow = JSON.parse(data.toString());
  if (escrow.status !== 'Locked') throw new Error(`escrow is not locked: ${escrow.status}`);
  escrow.status = 'Settled';
  escrow.settlementTxID = ctx.stub.getTxID();
  escrow.updatedAt = new Date().toISOString();
  await ctx.stub.putState(`assetEscrow:${requestID}`, Buffer.from(JSON.stringify(escrow)));
  ctx.stub.setEvent('ASSET_ESCROW_SETTLED', Buffer.from(JSON.stringify({
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

function canonicalHeader(hxmsg) {
  if (hxmsg.header.deliveryExpireAt === undefined) {
    throw new Error('canonical header.deliveryExpireAt is required');
  }
  return {
    version: Number(hxmsg.header.version),
    requestID: hxmsg.header.requestID,
    msgType: Number(hxmsg.header.msgType),
    nonce: Number(hxmsg.header.nonce),
    nonceScope: hxmsg.header.nonceScope || ethers.ZeroHash,
    sourceTimestamp: Number(hxmsg.header.sourceTimestamp ?? hxmsg.header.createdAt ?? 0),
    deliveryExpireAt: Number(hxmsg.header.deliveryExpireAt)
  };
}

function canonicalVerification(hxmsg) {
  const finality = hxmsg.verification.finality || {};
  return {
    verificationMethod: Number(hxmsg.verification.verificationMethod),
    finality: {
      model: Number(finality.model ?? hxmsg.verification.finalityModel ?? 0),
      confirmations: Number(finality.confirmations ?? hxmsg.verification.requiredConfirmations ?? 0),
      checkpointRoot: finality.checkpointRoot || ethers.ZeroHash,
      epoch: Number(finality.epoch || 0),
      committeePolicyHash: finality.committeePolicyHash || ethers.ZeroHash
    },
    policyRef: {
      policyType: Number(hxmsg.verification.policyRef.policyType),
      policyHash: hxmsg.verification.policyRef.policyHash || ethers.ZeroHash
    },
    verifierProfileHash: hxmsg.verification.verifierProfileHash || hxmsg.verification.adapterID || ethers.ZeroHash
  };
}

function getEnvelope(hxmsg) {
  return hxmsg.hxmsgEnvelope || {};
}

function getAuditRecord(hxmsg) {
  const auditRecord = getEnvelope(hxmsg).auditRecord;
  if (!auditRecord) throw new Error('hxmsgEnvelope.auditRecord is required');
  return auditRecord;
}

function computeHXMsgDigest(hxmsg) {
  const feedback = normalizeFeedback(hxmsg.feedback);
  const header = canonicalHeader(hxmsg);
  const verification = canonicalVerification(hxmsg);
  const headerHash = ethers.keccak256(
    ABI.encode(
      ['uint8', 'bytes32', 'uint8', 'uint64', 'bytes32', 'uint64', 'uint64'],
      [
        header.version,
        header.requestID,
        header.msgType,
        header.nonce,
        header.nonceScope,
        header.sourceTimestamp,
        header.deliveryExpireAt
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
      ['uint8', 'uint8', 'uint16', 'bytes32', 'uint64', 'bytes32', 'uint8', 'bytes32', 'bytes32'],
      [
        verification.verificationMethod,
        verification.finality.model,
        verification.finality.confirmations,
        verification.finality.checkpointRoot,
        verification.finality.epoch,
        verification.finality.committeePolicyHash,
        verification.policyRef.policyType,
        verification.policyRef.policyHash,
        verification.verifierProfileHash
      ]
    )
  );
  const bindingHash = ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes32'],
      [
        hxmsg.payloadBinding.sourcePayloadHash,
        hxmsg.payloadBinding.businessPayloadHash
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
  const targetExecutionHash = hxmsg.deliveryMessage?.targetExecutionHash
    || computeTargetExecutionHashFromHXMsg(hxmsg);
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
    targetExecutionHash,
    feedback.required,
    feedback.expectedMsgType,
    feedback.timeout,
    feedback.callbackRefHash,
    hxmsg.header.deliveryExpireAt,
    computeReplayScopeFromHXMsg(hxmsg),
    hxmsg.header.nonce
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
  const replayHash = ethers.keccak256(
    ABI.encode(['bytes32', 'uint64'], [minimal[15], minimal[16]])
  );
  return ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes32'],
      [chainHash, actionHash, feedbackHash, replayHash]
    )
  );
}

function normalizeMinimalDelivery(value) {
  const input = Array.isArray(value) ? value : [
    value.requestID,
    value.hmsgDigest,
    value.targetChainType,
    value.targetChainID,
    value.actionType,
    value.targetObject,
    value.functionSelector,
    value.callDataHash,
    value.receiver,
    value.targetExecutionHash,
    value.feedbackRequired,
    value.expectedFeedbackMsgType,
    value.feedbackTimeout,
    value.callbackRefHash,
    value.expireAt,
    value.replayScope,
    value.sourceNonce,
    value.sourceChainType,
    value.sourceChainID
  ];
  if (!Array.isArray(input) || input.length !== 19) throw new Error('bad compact h-xmsg delivery');
  return {
    requestID: input[0],
    hmsgDigest: input[1],
    targetChainType: Number(input[2]),
    targetChainID: input[3],
    actionType: Number(input[4]),
    targetObject: input[5],
    functionSelector: input[6],
    callDataHash: input[7],
    receiver: input[8],
    targetExecutionHash: input[9],
    feedbackRequired: Boolean(input[10]),
    expectedFeedbackMsgType: Number(input[11] || 0),
    feedbackTimeout: Number(input[12] || 0),
    callbackRefHash: input[13] || ethers.ZeroHash,
    expireAt: Number(input[14] || 0),
    replayScope: input[15] || ethers.ZeroHash,
    sourceNonce: Number(input[16] || 0),
    sourceChainType: Number(input[17]),
    sourceChainID: input[18]
  };
}

function computeTargetExecutionHashFromMinimal(minimal) {
  return ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes32', 'bytes32', 'bytes4', 'bytes32', 'bytes32'],
      [
        minimal.requestID,
        minimal.targetChainID,
        minimal.targetObject,
        minimal.functionSelector,
        minimal.callDataHash,
        minimal.receiver
      ]
    )
  );
}

function computeHXMsgDeliveryDigestFromMinimal(minimal) {
  const chainHash = ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes32', 'uint8', 'bytes32', 'uint8', 'bytes32', 'uint8'],
      [minimal.requestID, minimal.hmsgDigest, minimal.sourceChainType, minimal.sourceChainID,
        minimal.targetChainType, minimal.targetChainID, minimal.actionType]
    )
  );
  const actionHash = ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes4', 'bytes32', 'bytes32', 'bytes32'],
      [
        minimal.targetObject,
        minimal.functionSelector,
        minimal.callDataHash,
        minimal.receiver,
        minimal.targetExecutionHash
      ]
    )
  );
  const feedbackHash = ethers.keccak256(
    ABI.encode(
      ['bool', 'uint8', 'uint64', 'bytes32', 'uint64'],
      [
        minimal.feedbackRequired,
        minimal.expectedFeedbackMsgType,
        minimal.feedbackTimeout,
        minimal.callbackRefHash,
        minimal.expireAt
      ]
    )
  );
  const replayHash = ethers.keccak256(
    ABI.encode(['bytes32', 'uint64'], [minimal.replayScope, minimal.sourceNonce])
  );
  return ethers.keccak256(
    ABI.encode(['bytes32', 'bytes32', 'bytes32', 'bytes32'], [chainHash, actionHash, feedbackHash, replayHash])
  );
}

function computeReplayScopeFromHXMsg(hxmsg) {
  return ethers.keccak256(
    ABI.encode(
      ['uint8', 'bytes32', 'bytes32', 'bytes32'],
      [hxmsg.source.chainType, hxmsg.source.chainID, hxmsg.source.domainID, hxmsg.header.nonceScope]
    )
  );
}

function replayBitmapKey(replayScope, sourceNonce) {
  if (!replayScope || String(replayScope).toLowerCase() === ethers.ZeroHash) throw new Error('bad replay scope');
  const nonce = BigInt(sourceNonce);
  if (nonce <= 0n) throw new Error('bad source nonce');
  const lane = nonce & 15n;
  const ordinal = nonce >> 4n;
  return {
    key: `hxmsg-replay:${String(replayScope).toLowerCase()}:${lane}:${ordinal >> 8n}`,
    bit: ordinal & 255n
  };
}

async function assertReplayAvailable(ctx, replayScope, sourceNonce) {
  const { key, bit } = replayBitmapKey(replayScope, sourceNonce);
  const data = await ctx.stub.getState(key);
  const bitmap = data && data.length > 0 ? BigInt(data.toString()) : 0n;
  if ((bitmap & (1n << bit)) !== 0n) throw new Error('replay source nonce');
}

async function markReplayConsumed(ctx, replayScope, sourceNonce) {
  const { key, bit } = replayBitmapKey(replayScope, sourceNonce);
  const data = await ctx.stub.getState(key);
  const bitmap = data && data.length > 0 ? BigInt(data.toString()) : 0n;
  await ctx.stub.putState(key, Buffer.from(String(bitmap | (1n << bit))));
}

function computeBatchLeafFromMinimal(minimal) {
  const deliveryDigest = computeHXMsgDeliveryDigestFromMinimal(minimal);
  return ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes32', 'bytes32'],
      [minimal.requestID, minimal.hmsgDigest, deliveryDigest]
    )
  );
}

function toMinimalHXMsg(hxmsg, hmsgDigest) {
  const feedback = normalizeFeedback(hxmsg.feedback);
  return [
    hxmsg.header.requestID,
    hmsgDigest || hxmsg.hmsgDigest || computeHXMsgDigest(hxmsg),
    hxmsg.target.chainType,
    hxmsg.target.chainID,
    hxmsg.targetAction.actionType,
    hxmsg.targetAction.targetObject,
    hxmsg.targetAction.functionSelector,
    hxmsg.targetAction.callDataHash,
    hxmsg.targetAction.receiver,
    hxmsg.deliveryMessage?.targetExecutionHash || computeTargetExecutionHashFromHXMsg(hxmsg),
    feedback.required,
    feedback.expectedMsgType,
    feedback.timeout,
    feedback.callbackRefHash,
    hxmsg.header.deliveryExpireAt,
    computeReplayScopeFromHXMsg(hxmsg),
    hxmsg.header.nonce,
    hxmsg.source.chainType,
    hxmsg.source.chainID
  ];
}

function computeBatchLeaf(hxmsg, hmsgDigest) {
  return computeBatchLeafFromMinimal(
    normalizeMinimalDelivery(toMinimalHXMsg(hxmsg, hmsgDigest))
  );
}

function hashPair(left, right) {
  const [a, b] = BigInt(left) <= BigInt(right) ? [left, right] : [right, left];
  return ethers.keccak256(ABI.encode(['bytes32', 'bytes32'], [a, b]));
}

function verifyMerkleProof(leaf, proof, expectedRoot) {
  let value = leaf;
  for (const sibling of proof || []) {
    value = hashPair(value, sibling);
  }
  return String(value).toLowerCase() === String(expectedRoot).toLowerCase();
}

function computeBatchSigningDigest({ batchID, batchRoot, batchSize, targetChainID }) {
  return ethers.keccak256(
    ABI.encode(
      ['bytes32', 'bytes32', 'bytes32', 'uint64', 'bytes32'],
      [BATCH_DOMAIN, batchID, batchRoot, Number(batchSize), targetChainID]
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

async function getTrustedTEEBySignerIndex(ctx, clusterID, signerIndex) {
  const indexData = await ctx.stub.getState(`teeSignerIndex:${clusterID}:${Number(signerIndex)}`);
  if (!indexData || indexData.length === 0) return null;
  const address = ethers.getAddress(indexData.toString());
  const key = `trustedTEE:${clusterID}:${address}`;
  const data = await ctx.stub.getState(key);
  if (!data || data.length === 0) return null;
  const identity = JSON.parse(data.toString());
  const config = await getTEEClusterConfig(ctx, clusterID);
  const now = getTxTime(ctx);
  const trusted = Boolean(identity.active)
    && Number(identity.epoch || 0) === Number(config.epoch || 1)
    && (!Number(identity.notAfter || 0) || Number(identity.notAfter) > now);
  return trusted ? identity : null;
}

const SIMULATED_ATTESTATION_TYPE = 'SIMULATED_TDX_QUOTE_V1';

async function getTEEClusterConfig(ctx, clusterID) {
  const data = await ctx.stub.getState(`teeClusterConfig:${clusterID}`);
  if (!data || data.length === 0) {
    return { clusterID, epoch: 1, activeTEECount: 0, members: [], signerIndexes: [], exists: false };
  }
  const parsed = JSON.parse(data.toString());
  const members = Array.isArray(parsed.members)
    ? parsed.members.map((address) => ethers.getAddress(address))
    : [];
  return {
    epoch: Number(parsed.epoch || 1),
    activeTEECount: Number(parsed.activeTEECount || members.length || 0),
    members,
    signerIndexes: Array.isArray(parsed.signerIndexes) ? parsed.signerIndexes.map(Number) : []
    , subnetIDHash: parsed.subnetIDHash, sourceChainType: Number(parsed.sourceChainType), exists: true
  };
}

async function putTEEClusterConfig(ctx, clusterID, config) {
  const members = Array.isArray(config.members)
    ? Array.from(new Set(config.members.map((address) => ethers.getAddress(address))))
    : [];
  await ctx.stub.putState(`teeClusterConfig:${clusterID}`, Buffer.from(JSON.stringify({
    clusterID,
    subnetIDHash: config.subnetIDHash,
    sourceChainType: Number(config.sourceChainType),
    epoch: Number(config.epoch || 1),
    activeTEECount: members.length,
    members,
    signerIndexes: Array.isArray(config.signerIndexes) ? Array.from(new Set(config.signerIndexes.map(Number))) : [],
    updatedAt: new Date().toISOString()
  })));
}

function normalizeTEERegistration(input) {
  const identity = typeof input === 'string' ? parseJson(input, 'teeIdentityJson') : input;
  const teeAddress = ethers.getAddress(identity.teeAddress || identity.address);
  return {
    clusterID: identity.clusterID,
    subnetIDHash: identity.subnetIDHash || ethers.id(identity.subnetID || ''),
    sourceChainType: Number(identity.sourceChainType),
    teeAddress,
    signerIndex: Number(identity.signerIndex),
    enclavePubKeyHash: identity.enclavePubKeyHash,
    measurement: identity.measurement,
    quoteHash: identity.quoteHash,
    initialSyncStateHash: identity.initialSyncStateHash || ethers.ZeroHash,
    epoch: Number(identity.epoch || 1),
    notAfter: Number(identity.notAfter || 0),
    attestationType: identity.attestationType || SIMULATED_ATTESTATION_TYPE,
    attestationSignature: identity.attestationSignature || '0x',
    nodeID: identity.nodeID || '',
    subnetID: identity.subnetID || '',
    subnetProfile: identity.subnetProfile || ''
  };
}

function simulatedQuoteHash(identity) {
  return ethers.keccak256(
    ABI.encode(
      ['string', 'bytes32', 'bytes32', 'uint8', 'address', 'uint16', 'bytes32', 'bytes32', 'bytes32', 'uint64', 'uint64'],
      [
        SIMULATED_ATTESTATION_TYPE,
        identity.clusterID,
        identity.subnetIDHash,
        identity.sourceChainType,
        identity.teeAddress,
        identity.signerIndex,
        identity.enclavePubKeyHash,
        identity.measurement,
        identity.initialSyncStateHash,
        identity.epoch,
        identity.notAfter
      ]
    )
  );
}

function teeRegistrationDigest(identity) {
  return ethers.keccak256(
    ABI.encode(
      ['string', 'bytes32', 'bytes32', 'uint8', 'address', 'uint16', 'bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint64', 'uint64'],
      [
        identity.attestationType,
        identity.clusterID,
        identity.subnetIDHash,
        identity.sourceChainType,
        identity.teeAddress,
        identity.signerIndex,
        identity.enclavePubKeyHash,
        identity.measurement,
        identity.quoteHash,
        identity.initialSyncStateHash,
        identity.epoch,
        identity.notAfter
      ]
    )
  );
}

function verifyTEERegistration(identity, expectedEpoch) {
  if (identity.attestationType !== SIMULATED_ATTESTATION_TYPE) {
    throw new Error(`unsupported attestation type: ${identity.attestationType}`);
  }
  if (identity.epoch !== expectedEpoch) throw new Error('bad TEE epoch');
  if (!identity.clusterID || identity.clusterID === ethers.ZeroHash) throw new Error('missing clusterID');
  if (!identity.subnetIDHash || identity.subnetIDHash === ethers.ZeroHash) throw new Error('missing subnetIDHash');
  if (!identity.sourceChainType) throw new Error('missing sourceChainType');
  if (!identity.enclavePubKeyHash || identity.enclavePubKeyHash === ethers.ZeroHash) {
    throw new Error('missing enclavePubKeyHash');
  }
  if (!Number.isInteger(identity.signerIndex) || identity.signerIndex < 0 || identity.signerIndex >= 256) {
    throw new Error('bad signerIndex');
  }
  if (!identity.measurement || identity.measurement === ethers.ZeroHash) {
    throw new Error('missing enclave measurement');
  }
  if (!identity.quoteHash || identity.quoteHash === ethers.ZeroHash) {
    throw new Error('missing quoteHash');
  }
  if (identity.quoteHash.toLowerCase() !== simulatedQuoteHash(identity).toLowerCase()) {
    throw new Error('bad simulated TDX quote');
  }
  const digest = teeRegistrationDigest(identity);
  const signer = ethers.getAddress(ethers.recoverAddress(digest, identity.attestationSignature));
  if (signer !== identity.teeAddress) throw new Error('bad attestation signature');
  return digest;
}

async function currentTEEQuorumThreshold(ctx, clusterID) {
  const config = await getTEEClusterConfig(ctx, clusterID);
  if (config.activeTEECount <= 0) throw new Error('empty TEE cluster');
  return Math.floor(config.activeTEECount / 2) + 1;
}

function assertTEERegistrar(ctx) {
  const allowedMSPs = ['Org1MSP'];
  const mspid = ctx.clientIdentity.getMSPID();
  if (!allowedMSPs.includes(mspid)) {
    throw new Error(`MSP ${mspid} is not allowed to register TEE`);
  }
}

function teeSubnetSigningDigest(cert, subjectDigest) {
  return ethers.keccak256(ABI.encode(
    ['bytes32', 'bytes32', 'uint64', 'uint8', 'bytes32', 'bytes32'],
    [TEE_CERTIFICATE_DOMAIN, cert.clusterID, Number(cert.epoch), Number(cert.sourceChainType),
      cert.sourceChainID, subjectDigest]
  ));
}

async function verifyTEEClusterCertificate(ctx, expectedDigest, certEnvelope,
  expectedSourceChainType = null, expectedSourceChainID = null) {
  const cert = certEnvelope.clusterCertificate || certEnvelope.teeClusterCertification || certEnvelope;
  if (!cert || cert.scheme !== 'ECDSA_QUORUM_V1') throw new Error('bad TEE cluster certificate');
  const config = await getTEEClusterConfig(ctx, cert.clusterID);
  if (!config.exists) throw new Error('unknown TEE subnet cluster');
  if (Number(cert.sourceChainType) !== Number(config.sourceChainType)) throw new Error('unauthorized source TEE subnet');
  if (expectedSourceChainType !== null && Number(cert.sourceChainType) !== Number(expectedSourceChainType)) {
    throw new Error('wrong source TEE subnet');
  }
  if (expectedSourceChainID && String(cert.sourceChainID).toLowerCase() !== String(expectedSourceChainID).toLowerCase()) {
    throw new Error('wrong source chain certificate');
  }
  if (!cert.sourceChainID || cert.sourceChainID === ethers.ZeroHash) throw new Error('missing certificate sourceChainID');
  if (String(cert.subjectDigest).toLowerCase() !== String(expectedDigest).toLowerCase()) {
    throw new Error('TEE certificate subject mismatch');
  }
  const scopedDigest = teeSubnetSigningDigest(cert, expectedDigest);
  if (String(cert.signingDigest).toLowerCase() !== scopedDigest.toLowerCase()) throw new Error('TEE scoped digest mismatch');
  const threshold = await currentTEEQuorumThreshold(ctx, cert.clusterID);
  if (Number(cert.threshold) !== threshold) throw new Error('bad TEE threshold');
  if (Number(cert.participantCount) < threshold) throw new Error(`TEE quorum not satisfied: ${cert.participantCount}/${threshold}`);
  if (!Array.isArray(cert.participants) || cert.participants.length !== Number(cert.participantCount)) {
    throw new Error('bad TEE participants');
  }
  if (!Array.isArray(cert.signatures) || cert.signatures.length !== Number(cert.participantCount)) {
    throw new Error('bad TEE signature count');
  }

  const seen = new Set();
  const participants = [];
  let bitmap = 0n;
  for (let i = 0; i < cert.participants.length; i += 1) {
    const participant = cert.participants[i];
    const signerIndex = Number(participant.signerIndex);
    if (seen.has(signerIndex)) throw new Error('duplicate TEE signer');
    seen.add(signerIndex);
    bitmap |= 1n << BigInt(signerIndex);
    const identity = await getTrustedTEEBySignerIndex(ctx, cert.clusterID, signerIndex);
    if (!identity) throw new Error(`untrusted TEE signer index: ${signerIndex}`);
    if (ethers.getAddress(participant.teeAddress) !== ethers.getAddress(identity.address)) {
      throw new Error('TEE signer address mismatch');
    }
    if (String(participant.enclavePubKeyHash).toLowerCase() !== String(identity.enclavePubKeyHash).toLowerCase()) {
      throw new Error('TEE enclave key hash mismatch');
    }
    const recovered = ethers.getAddress(ethers.recoverAddress(scopedDigest, cert.signatures[i]));
    if (recovered !== ethers.getAddress(identity.address)) {
      throw new Error('bad TEE signature');
    }
    participants.push({
      signerIndex,
      teeAddress: identity.address,
      enclavePubKeyHash: identity.enclavePubKeyHash,
    });
  }
  if (bitmap !== BigInt(cert.signerBitmap)) throw new Error('bad TEE signer bitmap');
  if (selectedSignerHash(participants).toLowerCase() !== String(cert.selectedSignerHash).toLowerCase()) {
    throw new Error('bad selected TEE signer hash');
  }
  return {
    digest: expectedDigest,
    validTEECount: Number(cert.participantCount),
    threshold,
    signerIndexes: Array.from(seen).sort((a, b) => a - b),
    clusterID: cert.clusterID
  };
}

function expectedHXMsgSigningDigest(hxmsg, hmsgDigest, certEnvelope) {
  const cert = certEnvelope.clusterCertificate || certEnvelope.teeClusterCertification || certEnvelope;
  if (cert?.signatureDigestType === 'batchDigest') {
    const batchID = certEnvelope.batchID || cert.batchID;
    const batchRoot = certEnvelope.batchRoot || cert.batchRoot;
    const batchSize = certEnvelope.batchSize || cert.batchSize;
    const batchSigningDigest = certEnvelope.batchSigningDigest || cert.batchSigningDigest || cert.signingDigest;
    const merkleProof = certEnvelope.merkleProof || cert.merkleProof || [];
    if (!batchID || !batchRoot || !batchSize) throw new Error('missing batch certificate metadata');
    const expectedBatchDigest = computeBatchSigningDigest({
      batchID,
      batchRoot,
      batchSize,
      targetChainID: hxmsg.target.chainID
    });
    if (String(expectedBatchDigest).toLowerCase() !== String(batchSigningDigest).toLowerCase()) {
      throw new Error('bad batch signing digest');
    }
    const leaf = computeBatchLeaf(hxmsg, hmsgDigest);
    if (!verifyMerkleProof(leaf, merkleProof, batchRoot)) {
      throw new Error('bad batch merkle proof');
    }
    return batchSigningDigest;
  }
  if (cert?.signatureDigestType === 'deliveryDigest') {
    return computeHXMsgDeliveryDigest({ ...hxmsg, hmsgDigest });
  }
  return hmsgDigest;
}

function expectedMinimalSigningDigest(minimal, certEnvelope) {
  const cert = certEnvelope.clusterCertificate || certEnvelope.teeClusterCertification || certEnvelope;
  if (cert?.signatureDigestType === 'batchDigest') {
    const batchID = certEnvelope.batchID || cert.batchID;
    const batchRoot = certEnvelope.batchRoot || cert.batchRoot;
    const batchSize = certEnvelope.batchSize || cert.batchSize;
    const batchSigningDigest = certEnvelope.batchSigningDigest || cert.batchSigningDigest || cert.signingDigest;
    const merkleProof = certEnvelope.merkleProof || cert.merkleProof || [];
    if (!batchID || !batchRoot || !batchSize) throw new Error('missing batch certificate metadata');
    const expectedBatchDigest = computeBatchSigningDigest({
      batchID,
      batchRoot,
      batchSize,
      targetChainID: minimal.targetChainID
    });
    if (String(expectedBatchDigest).toLowerCase() !== String(batchSigningDigest).toLowerCase()) {
      throw new Error('bad batch signing digest');
    }
    const leaf = computeBatchLeafFromMinimal(minimal);
    if (!verifyMerkleProof(leaf, merkleProof, batchRoot)) {
      throw new Error('bad batch merkle proof');
    }
    return batchSigningDigest;
  }
  if (cert?.signatureDigestType === 'deliveryDigest') {
    return computeHXMsgDeliveryDigestFromMinimal(minimal);
  }
  return minimal.hmsgDigest;
}

function getTxTime(ctx) {
  const ts = ctx.stub.getTxTimestamp();
  return Number(ts.seconds.low || ts.seconds || Math.floor(Date.now() / 1000));
}

async function getResponseLifecycle(ctx, requestID) {
  const data = await ctx.stub.getState(`responseLifecycle:${requestID}`);
  if (!data || data.length === 0) {
    throw new Error(`response lifecycle not found: ${requestID}`);
  }
  return JSON.parse(data.toString());
}

async function putResponseLifecycle(ctx, record) {
  await ctx.stub.putState(`responseLifecycle:${record.requestID}`, Buffer.from(JSON.stringify(record)));
}

function currentIdentityID(ctx) {
  return ethers.keccak256(ethers.toUtf8Bytes(ctx.clientIdentity.getID()));
}

async function assertAuthorizedWatcher(ctx) {
  const identityID = currentIdentityID(ctx);
  const authorized = await ctx.stub.getState(`watcher:${identityID}`);
  if (!authorized || authorized.toString() !== '1') throw new Error('unauthorized watcher');
}

async function lifecycleCheckpointContext(ctx) {
  const channelID = ctx.stub.getChannelID();
  const chainHash = bytes32FromText(`fabric-${channelID}`);
  const contractHash = bytes32FromText(`fabric-${channelID}:xcall`);
  const epochData = await ctx.stub.getState('lifecycleCheckpoint:epoch');
  const rootData = await ctx.stub.getState('lifecycleCheckpoint:root');
  return {
    chainID: BigInt(chainHash),
    lifecycleContract: ethers.getAddress(`0x${strip0x(contractHash).slice(-40)}`),
    epoch: epochData?.length ? Number(epochData.toString()) : 0,
    root: rootData?.length ? rootData.toString() : ethers.ZeroHash
  };
}

async function fabricTerminalRecord(ctx, requestID) {
  const record = await getResponseLifecycle(ctx, requestID);
  const status = TERMINAL_STATUS_CODE[record.status];
  if (!status) throw new Error(`request not terminal: ${requestID}`);
  const escrowData = await ctx.stub.getState(`assetEscrow:${requestID}`);
  const escrow = escrowData?.length ? JSON.parse(escrowData.toString()) : null;
  const refunded = escrow?.status === 'Refunded';
  const settled = escrow?.status === 'Settled';
  if (Number(record.commitmentType) === 3 && !refunded && !settled) throw new Error(`escrow not terminal: ${requestID}`);
  return {
    requestID,
    status,
    commitmentType: Number(record.commitmentType || 0),
    targetExecutionHash: record.targetExecutionHash,
    failureActionHash: record.failureActionHash || ethers.ZeroHash,
    responseDigest: record.responseDigest || ethers.ZeroHash,
    escrowRefunded: refunded,
    escrowSettled: settled
  };
}

function terminalStateRoot(records) {
  let root = ethers.ZeroHash;
  for (const record of records) {
    const leaf = ethers.keccak256(ABI.encode(
      ['bytes32', 'uint8', 'uint8', 'bytes32', 'bytes32', 'bytes32', 'bool', 'bool'],
      [record.requestID, record.status, record.commitmentType, record.targetExecutionHash,
        record.failureActionHash, record.responseDigest, record.escrowRefunded, record.escrowSettled]
    ));
    root = ethers.keccak256(ABI.encode(['bytes32', 'bytes32'], [root, leaf]));
  }
  return root;
}

class XCallContract extends Contract {
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
    const functionSelector = payload.functionSelector || selectorOf('executeCompact(bytes32,bytes)');
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
    validateResponsePolicy(feedback, atomicity);
    if (feedback.required && Number(feedback.timeout) <= createdAt) throw new Error('feedback timeout expired');
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
      status: feedback.required ? 'awaiting_response' : 'submitted',
      updatedAt: new Date().toISOString()
    })));
    if (feedback.required) {
      const lifecycle = {
        requestID,
        owner: ctx.clientIdentity.getID(),
        sourceTxID: txId,
        hmsgDigest: payload.hmsgDigest || ethers.ZeroHash,
        targetChainID: executionTargetChainID,
        targetExecutionHash,
        commitmentType: atomicity.commitmentType,
        commitmentRefHash: atomicity.commitmentRefHash,
        successActionHash: atomicity.successActionHash,
        failureActionHash: atomicity.failureActionHash,
        feedbackTimeout: feedback.timeout || expireAt,
        challengeWindow: atomicity.challengeWindow,
        challengeDeadline: 0,
        atomicityRequired: atomicity.required,
        status: 'Pending',
        createdAt,
        updatedAt: new Date().toISOString()
      };
      await putResponseLifecycle(ctx, lifecycle);
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
    const functionSelector = payload.functionSelector || selectorOf('executeCompact(bytes32,bytes)');
    const callDataHash = payload.callDataHash;
    if (!callDataHash) throw new Error('payload.callDataHash is required for h-xmsg binding');
    const expireAt = Number(payload.expireAt || (createdAt + 3600));
    const feedback = normalizeFeedback(payload.feedback);
    const atomicity = normalizeAtomicity(payload.atomicity);
    validateResponsePolicy(feedback, atomicity);
    if (feedback.required && Number(feedback.timeout) <= createdAt) throw new Error('feedback timeout expired');
    if (!atomicity.required || Number(atomicity.commitmentType) !== 3) {
      throw new Error('asset lock requires TOKEN_ESCROW atomicity');
    }
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
    if (feedback.required) {
      await putResponseLifecycle(ctx, {
        requestID,
        owner: ctx.clientIdentity.getID(),
        sourceTxID: txId,
        hmsgDigest: payload.hmsgDigest || ethers.ZeroHash,
        targetChainID: executionTargetChainID,
        targetExecutionHash,
        commitmentType: atomicity.commitmentType,
        commitmentRefHash: atomicity.commitmentRefHash,
        successActionHash: atomicity.successActionHash,
        failureActionHash: atomicity.failureActionHash,
        feedbackTimeout: feedback.timeout || expireAt,
        challengeWindow: atomicity.challengeWindow,
        challengeDeadline: 0,
        atomicityRequired: atomicity.required,
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
    ctx.stub.setEvent('ASSET_LOCKED_XCALL', Buffer.from(JSON.stringify({
      ...eventRecord,
      txId,
      owner,
      assetType,
      amountUnits: unitsToString(amountUnits)
    })));
    return JSON.stringify({ ok: true, txId, requestID, nonce, escrow });
  }

  async QueryCrosschainEvent(ctx, requestID) {
    const data = await ctx.stub.getState(`crosschainEvents:${requestID}`);
    if (!data || data.length === 0) {
      throw new Error(`crosschain event not found: ${requestID}`);
    }
    return data.toString();
  }

  async RegisterTrustedTEE(ctx, teeIdentityJson) {
    assertTEERegistrar(ctx);
    const identity = normalizeTEERegistration(teeIdentityJson);
    const config = await getTEEClusterConfig(ctx, identity.clusterID);
    if (config.exists) {
      if (String(config.subnetIDHash).toLowerCase() !== String(identity.subnetIDHash).toLowerCase()) {
        throw new Error('TEE subnetID mismatch');
      }
      if (Number(config.sourceChainType) !== Number(identity.sourceChainType)) {
        throw new Error('TEE sourceChainType mismatch');
      }
    } else {
      config.subnetIDHash = identity.subnetIDHash;
      config.sourceChainType = identity.sourceChainType;
      config.exists = true;
    }
    const now = getTxTime(ctx);
    if (identity.notAfter && identity.notAfter <= now) {
      throw new Error('TEE attestation expired');
    }
    const attestationDigest = verifyTEERegistration(identity, Number(config.epoch || 1));
    const address = identity.teeAddress;
    const assignedData = await ctx.stub.getState(`teeAssignedCluster:${address}`);
    if (assignedData && assignedData.length > 0
      && String(assignedData.toString()).toLowerCase() !== String(identity.clusterID).toLowerCase()) {
      throw new Error('TEE key already assigned to another subnet');
    }
    const key = `trustedTEE:${identity.clusterID}:${address}`;
    const signerIndexKey = `teeSignerIndex:${identity.clusterID}:${identity.signerIndex}`;
    const existingIndex = await ctx.stub.getState(signerIndexKey);
    if (existingIndex && existingIndex.length > 0 && ethers.getAddress(existingIndex.toString()) !== address) {
      throw new Error('TEE signerIndex already registered');
    }
    if (!config.members.includes(address)) {
      config.members.push(address);
    }
    config.signerIndexes = Array.from(new Set([...(config.signerIndexes || []), identity.signerIndex]));
    await putTEEClusterConfig(ctx, identity.clusterID, config);
    await ctx.stub.putState(`teeAssignedCluster:${address}`, Buffer.from(identity.clusterID));
    await ctx.stub.putState(signerIndexKey, Buffer.from(address));
    await ctx.stub.putState(key, Buffer.from(JSON.stringify({
      address,
      clusterID: identity.clusterID,
      subnetIDHash: identity.subnetIDHash,
      sourceChainType: identity.sourceChainType,
      signerIndex: identity.signerIndex,
      enclavePubKeyHash: identity.enclavePubKeyHash,
      measurement: identity.measurement,
      quoteHash: identity.quoteHash,
      initialSyncStateHash: identity.initialSyncStateHash,
      attestationType: identity.attestationType,
      attestationDigest,
      epoch: config.epoch,
      notAfter: identity.notAfter,
      nodeID: identity.nodeID,
      active: true,
      registeredByMSP: ctx.clientIdentity.getMSPID(),
      updatedAt: new Date().toISOString()
    })));
    return JSON.stringify({
      ok: true,
      address,
      attestationDigest,
      measurement: identity.measurement,
      epoch: config.epoch,
      activeTEECount: config.members.length,
      quorumThreshold: Math.floor(config.members.length / 2) + 1
    });
  }

  async QueryTrustedTEE(ctx, clusterID, teeAddress) {
    const address = ethers.getAddress(teeAddress);
    const data = await ctx.stub.getState(`trustedTEE:${clusterID}:${address}`);
    return data && data.length > 0 ? data.toString() : '';
  }

  async QueryTEEClusterConfig(ctx, clusterID) {
    const config = await getTEEClusterConfig(ctx, clusterID);
    return JSON.stringify({
      ...config,
      activeTEECount: config.members.length,
      quorumThreshold: config.members.length > 0 ? Math.floor(config.members.length / 2) + 1 : 0
    });
  }

  async ExecuteHXMsgCompact(ctx, deliveryJson, compactCallJson, businessPayloadJson, certJson) {
    const minimal = normalizeMinimalDelivery(parseJson(deliveryJson, 'deliveryJson'));
    const compactCall = parseJson(compactCallJson, 'compactCallJson');
    const parsedPayload = parseJson(businessPayloadJson, 'businessPayloadJson');
    const certEnvelope = parseJson(certJson, 'certJson');
    const auditRecord = {};
    const requestID = minimal.requestID;
    await assertReplayAvailable(ctx, minimal.replayScope, minimal.sourceNonce);

    const now = Number(ctx.stub.getTxTimestamp().seconds.low || ctx.stub.getTxTimestamp().seconds || Math.floor(Date.now() / 1000));
    if (Number(minimal.expireAt) < now) throw new Error('h-xmsg expired');
    if (Number(minimal.targetChainType) !== 2) throw new Error('target is not Fabric');
    if (Number(minimal.actionType) !== 5) throw new Error('action is not chaincode invoke');
    if (String(minimal.functionSelector).toLowerCase() !== selectorOf('ExecuteHXMsgCompact(bytes32,bytes)').toLowerCase()) {
      throw new Error('Fabric compact function selector mismatch');
    }

    const expectedChainID = bytes32FromText(`fabric-${ctx.stub.getChannelID()}`);
    const expectedTargetObject = bytes32FromText('xcall');
    if (String(minimal.targetChainID).toLowerCase() !== expectedChainID.toLowerCase()) {
      throw new Error('Fabric target chainID mismatch');
    }
    if (String(minimal.targetObject).toLowerCase() !== expectedTargetObject.toLowerCase()) {
      throw new Error('Fabric target object mismatch');
    }
    const compactCallHash = hashCompactBusinessCall(compactCall);
    if (String(minimal.callDataHash).toLowerCase() !== compactCallHash.toLowerCase()) {
      throw new Error('compact callDataHash mismatch');
    }
    assertCompactPayloadMatchesBusiness(compactCall, parsedPayload);
    const targetExecutionHash = computeTargetExecutionHashFromMinimal(minimal);
    if (String(minimal.targetExecutionHash).toLowerCase() !== targetExecutionHash.toLowerCase()) {
      throw new Error('targetExecutionHash mismatch');
    }

    const certResult = await verifyTEEClusterCertificate(
      ctx,
      expectedMinimalSigningDigest(minimal, certEnvelope),
      certEnvelope,
      minimal.sourceChainType,
      minimal.sourceChainID
    );
    const businessRecord = await applyBusinessAction(ctx, {
      requestID,
      hmsgDigest: minimal.hmsgDigest,
      callDataHash: minimal.callDataHash,
      parsedPayload,
      sourceChainType: minimal.sourceChainType || 1
    });
    const record = {
      requestID,
      txId: ctx.stub.getTxID(),
      callerMSP: ctx.clientIdentity.getMSPID(),
      hmsgDigest: minimal.hmsgDigest,
      validTEECount: certResult.validTEECount,
      teeThreshold: certResult.threshold,
      teeSigners: certResult.signerIndexes,
      sourceChainType: minimal.sourceChainType || 1,
      sourceTxID: auditRecord.txId || '',
      srcHeight: auditRecord.srcHeight || 0,
      callDataHash: minimal.callDataHash,
      businessPayloadHash: hashJson(parsedPayload),
      targetExecutionHash,
      op: parsedPayload.op,
      recordId: parsedPayload.recordId,
      actor: parsedPayload.actor,
      amount: parsedPayload.amount,
      metadata: parsedPayload.metadata,
      requireAck: Boolean(parsedPayload.requireAck),
      businessKey: businessRecord.businessKey,
      businessStatus: businessRecord.status,
      status: 'executed',
      compressed: true,
      updatedAt: new Date().toISOString()
    };

    await markReplayConsumed(ctx, minimal.replayScope, minimal.sourceNonce);
    await ctx.stub.putState(`crosschainExec:${requestID}`, Buffer.from(JSON.stringify(record)));
    await ctx.stub.putState(`inbound:${requestID}`, Buffer.from(JSON.stringify(record)));
    ctx.stub.setEvent('HXMSG_EXECUTED', Buffer.from(JSON.stringify(record)));

    return JSON.stringify({ ok: true, requestID, status: 'executed', compressed: true, validTEECount: certResult.validTEECount });
  }

  async ExecuteHXMsgCompactBatch(ctx, deliveriesJson, compactCallsJson, businessPayloadsJson, certsJson) {
    const deliveries = parseJson(deliveriesJson, 'deliveriesJson');
    const compactCalls = parseJson(compactCallsJson, 'compactCallsJson');
    const businessPayloads = parseJson(businessPayloadsJson, 'businessPayloadsJson');
    const certEnvelopes = parseJson(certsJson, 'certsJson');
    if (!Array.isArray(deliveries) || deliveries.length === 0) throw new Error('empty compact batch');
    if (!Array.isArray(compactCalls) || compactCalls.length !== deliveries.length) throw new Error('bad compact call count');
    if (!Array.isArray(businessPayloads) || businessPayloads.length !== deliveries.length) throw new Error('bad business payload count');
    if (!Array.isArray(certEnvelopes) || certEnvelopes.length !== deliveries.length) throw new Error('bad certificate count');

    const expectedChainID = bytes32FromText(`fabric-${ctx.stub.getChannelID()}`);
    const expectedTargetObject = bytes32FromText('xcall');
    const now = getTxTime(ctx);
    const prepared = [];
    let batchSigningDigest = null;

    for (let i = 0; i < deliveries.length; i += 1) {
      const minimal = normalizeMinimalDelivery(deliveries[i]);
      const compactCall = compactCalls[i];
      const parsedPayload = businessPayloads[i];
      const certEnvelope = certEnvelopes[i];
      await assertReplayAvailable(ctx, minimal.replayScope, minimal.sourceNonce);
      if (Number(minimal.expireAt) < now) throw new Error(`h-xmsg expired at batch index ${i}`);
      if (Number(minimal.targetChainType) !== 2) throw new Error(`target is not Fabric at batch index ${i}`);
      if (Number(minimal.actionType) !== 5) throw new Error(`action is not chaincode invoke at batch index ${i}`);
      if (String(minimal.functionSelector).toLowerCase() !== selectorOf('ExecuteHXMsgCompact(bytes32,bytes)').toLowerCase()) {
        throw new Error(`Fabric compact function selector mismatch at batch index ${i}`);
      }
      if (String(minimal.targetChainID).toLowerCase() !== expectedChainID.toLowerCase()) {
        throw new Error(`Fabric target chainID mismatch at batch index ${i}`);
      }
      if (String(minimal.targetObject).toLowerCase() !== expectedTargetObject.toLowerCase()) {
        throw new Error(`Fabric target object mismatch at batch index ${i}`);
      }
      if (String(minimal.callDataHash).toLowerCase() !== hashCompactBusinessCall(compactCall).toLowerCase()) {
        throw new Error(`compact callDataHash mismatch at batch index ${i}`);
      }
      assertCompactPayloadMatchesBusiness(compactCall, parsedPayload);
      const targetExecutionHash = computeTargetExecutionHashFromMinimal(minimal);
      if (String(minimal.targetExecutionHash).toLowerCase() !== targetExecutionHash.toLowerCase()) {
        throw new Error(`targetExecutionHash mismatch at batch index ${i}`);
      }

      const signingDigest = expectedMinimalSigningDigest(minimal, certEnvelope);
      if (batchSigningDigest && String(signingDigest).toLowerCase() !== String(batchSigningDigest).toLowerCase()) {
        throw new Error('mixed TEE batch certificates');
      }
      batchSigningDigest = signingDigest;
      prepared.push({ minimal, compactCall, parsedPayload, targetExecutionHash });
    }

    // 所有消息均已通过各自的 Merkle inclusion proof，因此同一批次的 TEE quorum 签名只验证一次。
    const firstMinimal = prepared[0].minimal;
    for (const item of prepared) {
      if (Number(item.minimal.sourceChainType) !== Number(firstMinimal.sourceChainType)
        || String(item.minimal.sourceChainID).toLowerCase() !== String(firstMinimal.sourceChainID).toLowerCase()) {
        throw new Error('mixed source subnet batch');
      }
    }
    const certResult = await verifyTEEClusterCertificate(ctx, batchSigningDigest, certEnvelopes[0],
      firstMinimal.sourceChainType, firstMinimal.sourceChainID);
    const records = [];
    for (const item of prepared) {
      const { minimal, parsedPayload, targetExecutionHash } = item;
      const businessRecord = await applyBusinessAction(ctx, {
        requestID: minimal.requestID,
        hmsgDigest: minimal.hmsgDigest,
        callDataHash: minimal.callDataHash,
        parsedPayload,
        sourceChainType: minimal.sourceChainType || 1
      });
      const record = {
        requestID: minimal.requestID,
        txId: ctx.stub.getTxID(),
        callerMSP: ctx.clientIdentity.getMSPID(),
        hmsgDigest: minimal.hmsgDigest,
        validTEECount: certResult.validTEECount,
        teeThreshold: certResult.threshold,
        teeSigners: certResult.signerIndexes,
        sourceChainType: minimal.sourceChainType || 1,
        sourceTxID: '',
        srcHeight: 0,
        callDataHash: minimal.callDataHash,
        businessPayloadHash: hashJson(parsedPayload),
        targetExecutionHash,
        op: parsedPayload.op,
        recordId: parsedPayload.recordId,
        actor: parsedPayload.actor,
        amount: parsedPayload.amount,
        metadata: parsedPayload.metadata,
        requireAck: Boolean(parsedPayload.requireAck),
        businessKey: businessRecord.businessKey,
        businessStatus: businessRecord.status,
        status: 'executed',
        compressed: true,
        batch: true,
        updatedAt: new Date().toISOString()
      };
      await markReplayConsumed(ctx, minimal.replayScope, minimal.sourceNonce);
      await ctx.stub.putState(`crosschainExec:${minimal.requestID}`, Buffer.from(JSON.stringify(record)));
      await ctx.stub.putState(`inbound:${minimal.requestID}`, Buffer.from(JSON.stringify(record)));
      records.push(record);
    }
    ctx.stub.setEvent('HXMSG_BATCH_EXECUTED', Buffer.from(JSON.stringify({
      txId: ctx.stub.getTxID(),
      batchSize: records.length,
      requestIDs: records.map((record) => record.requestID)
    })));
    return JSON.stringify({
      ok: true,
      status: 'executed',
      batchSize: records.length,
      requestIDs: records.map((record) => record.requestID),
      validTEECount: certResult.validTEECount
    });
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

  async QueryResponseLifecycle(ctx, requestID) {
    const data = await ctx.stub.getState(`responseLifecycle:${requestID}`);
    return data && data.length > 0 ? data.toString() : '';
  }

  async InitializeWatcherAuthorization(ctx) {
    const existing = await ctx.stub.getState('watcher:admin');
    const identityID = currentIdentityID(ctx);
    if (existing?.length && existing.toString() !== identityID) throw new Error('watcher authorization already initialized');
    await ctx.stub.putState('watcher:admin', Buffer.from(identityID));
    await ctx.stub.putState(`watcher:${identityID}`, Buffer.from('1'));
    return JSON.stringify({ ok: true, watcherID: identityID });
  }

  async SetWatcherAuthorization(ctx, watcherID, authorized) {
    const admin = await ctx.stub.getState('watcher:admin');
    if (!admin?.length || admin.toString() !== currentIdentityID(ctx)) throw new Error('not watcher admin');
    if (!/^0x[0-9a-fA-F]{64}$/.test(watcherID)) throw new Error('bad watcherID');
    if (String(authorized) === 'true') await ctx.stub.putState(`watcher:${watcherID}`, Buffer.from('1'));
    else await ctx.stub.deleteState(`watcher:${watcherID}`);
    return JSON.stringify({ ok: true, watcherID, authorized: String(authorized) === 'true' });
  }

  async BindResponseLifecycleHXMsg(ctx, hxmsgJson, certJson) {
    const hxmsg = parseJson(hxmsgJson, 'hxmsgJson');
    const certEnvelope = parseJson(certJson, 'certJson');
    const auditRecord = getAuditRecord(hxmsg);
    const requestID = hxmsg.header.requestID;
    const record = await getResponseLifecycle(ctx, requestID);
    if (!['Pending', 'Challenged'].includes(record.status)) {
      throw new Error(`bad state: ${record.status}`);
    }
    if (record.hmsgDigest && record.hmsgDigest !== ethers.ZeroHash) {
      throw new Error('hmsgDigest already bound');
    }
    if (String(record.sourceTxID).toLowerCase() !== String(auditRecord.txId).toLowerCase()) {
      throw new Error('sourceTxID mismatch');
    }
    const targetExecutionHash = computeTargetExecutionHashFromHXMsg(hxmsg);
    if (String(targetExecutionHash).toLowerCase() !== String(record.targetExecutionHash).toLowerCase()) {
      throw new Error('targetExecutionHash mismatch');
    }
    const hmsgDigest = computeHXMsgDigest(hxmsg);
    const certResult = await verifyTEEClusterCertificate(
      ctx,
      expectedHXMsgSigningDigest(hxmsg, hmsgDigest, certEnvelope),
      certEnvelope,
      hxmsg.source.chainType,
      hxmsg.source.chainID
    );
    record.hmsgDigest = hmsgDigest;
    record.validTEECount = certResult.validTEECount;
    record.teeThreshold = certResult.threshold;
    record.boundAt = getTxTime(ctx);
    record.updatedAt = new Date(record.boundAt * 1000).toISOString();
    await putResponseLifecycle(ctx, record);
    ctx.stub.setEvent('RESPONSE_LIFECYCLE_HXMSG_BOUND', Buffer.from(JSON.stringify({
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
    await assertAuthorizedWatcher(ctx);
    const record = await getResponseLifecycle(ctx, requestID);
    if (record.status !== 'Pending') {
      throw new Error(`bad state: ${record.status}`);
    }
    if (!record.atomicityRequired || Number(record.challengeWindow) <= 0) {
      throw new Error('response-only request cannot be challenged');
    }
    const now = getTxTime(ctx);
    if (now <= Number(record.feedbackTimeout)) {
      throw new Error('not timeout');
    }
    record.status = 'Challenged';
    record.challengeDeadline = now + Number(record.challengeWindow);
    record.updatedAt = new Date(now * 1000).toISOString();
    await putResponseLifecycle(ctx, record);
    ctx.stub.setEvent('CHALLENGE_STARTED', Buffer.from(JSON.stringify({
      requestID,
      challengeDeadline: record.challengeDeadline
    })));
    return JSON.stringify({ ok: true, requestID, status: record.status, challengeDeadline: record.challengeDeadline });
  }

  async CompleteWithResponse(ctx, requestID, responseJson, certJson) {
    const record = await getResponseLifecycle(ctx, requestID);
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
    const certResult = await verifyTEEClusterCertificate(ctx, responseDigest, certEnvelope,
      null, record.targetChainID);
    let settlementResult = null;
    if (Number(record.commitmentType) === 3) {
      settlementResult = await settleAssetEscrowRecord(ctx, requestID);
      record.settlementHandler = 'asset-escrow-settlement';
      record.settlementResultHash = ethers.keccak256(ethers.toUtf8Bytes(stableStringify(settlementResult)));
    }
    record.status = 'Completed';
    record.responseDigest = responseDigest;
    record.validTEECount = certResult.validTEECount;
    record.teeThreshold = certResult.threshold;
    record.completedAt = getTxTime(ctx);
    record.updatedAt = new Date(record.completedAt * 1000).toISOString();
    await ctx.stub.putState(consumedKey, Buffer.from('1'));
    await putResponseLifecycle(ctx, record);
    ctx.stub.setEvent('RESPONSE_COMPLETED', Buffer.from(JSON.stringify({
      requestID,
      responseDigest,
      validTEECount: certResult.validTEECount
    })));
    return JSON.stringify({
      ok: true,
      requestID,
      status: record.status,
      responseDigest,
      settlementHandler: record.settlementHandler || null,
      settlementResultHash: record.settlementResultHash || ethers.ZeroHash
    });
  }

  async CompensateAfterChallenge(ctx, requestID, failureDataJson) {
    await assertAuthorizedWatcher(ctx);
    const record = await getResponseLifecycle(ctx, requestID);
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
    await putResponseLifecycle(ctx, record);
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

  async PreviewLifecycleCheckpoint(ctx, requestIDsJson) {
    const requestIDs = parseJson(requestIDsJson, 'requestIDsJson');
    if (!Array.isArray(requestIDs) || requestIDs.length < 1 || requestIDs.length > 256) throw new Error('bad checkpoint size');
    const records = [];
    for (let index = 0; index < requestIDs.length; index += 1) {
      if (index > 0 && String(requestIDs[index]).toLowerCase() <= String(requestIDs[index - 1]).toLowerCase()) {
        throw new Error('requestIDs not sorted');
      }
      records.push(await fabricTerminalRecord(ctx, requestIDs[index]));
    }
    const terminalRoot = terminalStateRoot(records);
    const context = await lifecycleCheckpointContext(ctx);
    const epoch = context.epoch + 1;
    const signingDigest = ethers.keccak256(ABI.encode(
      ['bytes32', 'uint256', 'address', 'uint64', 'bytes32', 'bytes32', 'uint256'],
      [LIFECYCLE_CHECKPOINT_DOMAIN, context.chainID, context.lifecycleContract, epoch, context.root, terminalRoot, requestIDs.length]
    ));
    return JSON.stringify({
      chainID: context.chainID.toString(), lifecycleContract: context.lifecycleContract, epoch,
      previousCheckpointRoot: context.root, terminalStateRoot: terminalRoot,
      requestCount: requestIDs.length, signingDigest, records
    });
  }

  async UpdateLifecycleCheckpoint(ctx, requestIDsJson, terminalRoot, certJson) {
    await assertAuthorizedWatcher(ctx);
    const preview = JSON.parse(await this.PreviewLifecycleCheckpoint(ctx, requestIDsJson));
    if (String(preview.terminalStateRoot).toLowerCase() !== String(terminalRoot).toLowerCase()) {
      throw new Error('bad terminal state root');
    }
    await verifyTEEClusterCertificate(ctx, preview.signingDigest, parseJson(certJson, 'certJson'),
      2, bytes32FromText(`fabric-${ctx.stub.getChannelID()}`));
    const requestIDs = parseJson(requestIDsJson, 'requestIDsJson');
    for (const requestID of requestIDs) {
      const record = await getResponseLifecycle(ctx, requestID);
      if (record.responseDigest && record.responseDigest !== ethers.ZeroHash) {
        await ctx.stub.deleteState(`response-consumed:${record.responseDigest}`);
      }
      await ctx.stub.deleteState(`assetEscrow:${requestID}`);
      await ctx.stub.deleteState(`responseLifecycle:${requestID}`);
    }
    const checkpointRoot = ethers.keccak256(ABI.encode(
      ['bytes32', 'uint64', 'bytes32', 'uint256'],
      [preview.previousCheckpointRoot, preview.epoch, preview.terminalStateRoot, requestIDs.length]
    ));
    await ctx.stub.putState('lifecycleCheckpoint:epoch', Buffer.from(String(preview.epoch)));
    await ctx.stub.putState('lifecycleCheckpoint:root', Buffer.from(checkpointRoot));
    const result = { ...preview, checkpointRoot };
    await ctx.stub.putState(`lifecycleCheckpoint:${preview.epoch}`, Buffer.from(JSON.stringify(result)));
    ctx.stub.setEvent('LIFECYCLE_CHECKPOINTED', Buffer.from(JSON.stringify(result)));
    return JSON.stringify({ ok: true, ...result });
  }

}

module.exports.contracts = [XCallContract];
