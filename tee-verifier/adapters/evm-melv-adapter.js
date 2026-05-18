const { ethers } = require('ethers');
const {
  ChainType,
  VerificationMethod,
  PolicyType,
  decodeJsonRef,
  hashJson,
  buildDefaultEvmMelvPolicy,
  computeTargetExecutionHash,
} = require('../../shared/hxmsg');
const {
  CROSS_CHAIN_CALL_TOPIC,
  parseCrossChainCallLog,
  buildEvmEventRefHash,
  buildEvmSourcePayloadHash,
} = require('../../hxmsg-builder/evm-to-fabric');

function sameHex(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function rememberHeader(chainState, block) {
  if (!chainState.evm) chainState.evm = { tipHeight: 0, tipHash: null, headers: [] };
  const state = chainState.evm;
  const number = Number(block.number);
  if (state.tipHash && number > Number(state.tipHeight) + 1) {
    // In this prototype the helper TEE can bridge gaps; record the observed header
    // without claiming a fully proven canonical chain for skipped heights.
  } else if (state.tipHash && number === Number(state.tipHeight) + 1 && block.parentHash !== state.tipHash) {
    throw new Error('EVM header chain continuity failed');
  }
  if (number >= Number(state.tipHeight || 0)) {
    state.tipHeight = number;
    state.tipHash = block.hash;
  }
  state.headers = (state.headers || []).filter((h) => Number(h.number) !== number);
  state.headers.push({
    number,
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: Number(block.timestamp),
  });
  if (state.headers.length > 128) state.headers.shift();
}

async function queryHeaderHelper(blockNumber) {
  const helperUrl = process.env.MELV_HEADER_HELPER_URL;
  if (!helperUrl) return null;
  const resp = await fetch(`${helperUrl.replace(/\/$/, '')}/headers/${blockNumber}`);
  if (!resp.ok) throw new Error(`header helper returned ${resp.status}`);
  return resp.json();
}

async function verifyMelvEf({ hxmsg, helperData = {}, chainState, saveChainState }) {
  if (Number(hxmsg.source?.chainType) !== ChainType.EVM) {
    throw new Error('MELV-EF adapter requires source.chainType = EVM');
  }
  if (Number(hxmsg.target?.chainType) !== ChainType.FABRIC) {
    throw new Error('MELV-EF adapter requires target.chainType = Fabric');
  }
  if (Number(hxmsg.verification?.verificationMethod) !== VerificationMethod.EVM_LIGHT_CLIENT) {
    throw new Error('MELV-EF adapter requires verificationMethod = EVM_LIGHT_CLIENT');
  }
  if (Number(hxmsg.verification?.policyRef?.policyType) !== PolicyType.EVM_FINALITY) {
    throw new Error('MELV-EF adapter requires EVM finality policy');
  }

  const ref = decodeJsonRef(hxmsg.sourceRef.encodedRef);
  const expectedRefHash = buildEvmEventRefHash(ref);
  if (!sameHex(expectedRefHash, hxmsg.sourceRef.refHash)) {
    throw new Error('EVM sourceRef hash mismatch');
  }

  const policy = buildDefaultEvmMelvPolicy({
    sourceChainID: `eip155:${Number(BigInt(hxmsg.source.chainID))}`,
    sourceContract: ref.sourceContract,
  });
  const expectedPolicyHash = hashJson(policy);
  if (!sameHex(expectedPolicyHash, hxmsg.verification.policyRef.policyHash)) {
    throw new Error('EVM finality policyHash mismatch');
  }
  if (!policy.trustedSourceContracts.includes(String(ref.sourceContract).toLowerCase())) {
    throw new Error('untrusted EVM source contract');
  }

  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC || helperData.evmRpc || 'http://evm-node:8545');
  const receipt = helperData.receipt || await provider.getTransactionReceipt(ref.txHash);
  if (!receipt) throw new Error(`EVM receipt not found: ${ref.txHash}`);
  if (!sameHex(receipt.hash, ref.txHash)) throw new Error('EVM receipt txHash mismatch');
  if (Number(receipt.blockNumber) !== Number(ref.blockNumber)) throw new Error('EVM receipt blockNumber mismatch');
  if (!sameHex(receipt.blockHash, ref.blockHash)) throw new Error('EVM receipt blockHash mismatch');

  const block = helperData.block || await provider.getBlock(Number(ref.blockNumber));
  if (!block) throw new Error(`EVM block not found: ${ref.blockNumber}`);
  if (!sameHex(block.hash, ref.blockHash)) throw new Error('EVM block hash mismatch');
  const helperHeader = await queryHeaderHelper(ref.blockNumber).catch(() => null);
  if (helperHeader && helperHeader.hash && !sameHex(helperHeader.hash, block.hash)) {
    throw new Error('EVM helper TEE header hash mismatch');
  }
  rememberHeader(chainState, block);

  const latestBlock = await provider.getBlockNumber();
  const confirmations = Math.max(0, Number(latestBlock) - Number(ref.blockNumber) + 1);
  if (confirmations < Number(hxmsg.verification.requiredConfirmations || policy.requiredConfirmations)) {
    throw new Error(`EVM confirmations insufficient: got=${confirmations}`);
  }

  const log = (receipt.logs || [])[Number(ref.logIndex)];
  if (!log) throw new Error('EVM logIndex not found in receipt');
  if (!sameHex(log.address, ref.sourceContract)) throw new Error('EVM log address mismatch');
  if (!sameHex(log.topics?.[0], CROSS_CHAIN_CALL_TOPIC)) throw new Error('EVM event signature mismatch');
  const event = parseCrossChainCallLog(log);

  if (!sameHex(event.requestID, hxmsg.header.requestID)) throw new Error('EVM event requestID mismatch');
  if (Number(event.nonce) !== Number(hxmsg.header.nonce)) throw new Error('EVM event nonce mismatch');
  if (Number(event.expireAt) !== Number(hxmsg.header.expireAt)) throw new Error('EVM event expireAt mismatch');
  if (!sameHex(event.targetChainID, hxmsg.target.chainID)) throw new Error('EVM event targetChainID mismatch');
  if (!sameHex(event.targetDomainID, hxmsg.target.domainID)) throw new Error('EVM event targetDomainID mismatch');
  if (!sameHex(event.targetObject, hxmsg.targetAction.targetObject)) throw new Error('EVM event targetObject mismatch');
  if (!sameHex(event.functionSelector, hxmsg.targetAction.functionSelector)) throw new Error('EVM event functionSelector mismatch');
  if (!sameHex(event.callDataHash, hxmsg.targetAction.callDataHash)) throw new Error('EVM event callDataHash mismatch');
  if (!sameHex(event.businessPayloadHash, hxmsg.payloadBinding.businessPayloadHash)) {
    throw new Error('EVM event businessPayloadHash mismatch');
  }

  const sourcePayloadHash = buildEvmSourcePayloadHash({
    requestID: event.requestID,
    sender: event.sender,
    sourceContract: ref.sourceContract,
    targetChainID: event.targetChainID,
    targetObject: event.targetObject,
    functionSelector: event.functionSelector,
    callDataHash: event.callDataHash,
    nonce: event.nonce,
    expireAt: event.expireAt,
  });
  if (!sameHex(sourcePayloadHash, hxmsg.payloadBinding.sourcePayloadHash)) {
    throw new Error('EVM sourcePayloadHash mismatch');
  }
  const targetExecutionHash = computeTargetExecutionHash({
    requestID: hxmsg.header.requestID,
    targetChainID: hxmsg.target.chainID,
    targetObject: hxmsg.targetAction.targetObject,
    functionSelector: hxmsg.targetAction.functionSelector,
    callDataHash: hxmsg.targetAction.callDataHash,
    receiver: hxmsg.targetAction.receiver,
  });
  if (!sameHex(targetExecutionHash, hxmsg.payloadBinding.targetExecutionHash)) {
    throw new Error('EVM targetExecutionHash mismatch');
  }
  saveChainState();
  return {
    adapter: 'evm-melv-ef',
    verified: true,
    txHash: receipt.hash,
    blockNumber: Number(receipt.blockNumber),
    blockHash: receipt.blockHash,
    confirmations,
    headerMaintainer: process.env.MELV_HEADER_HELPER_URL ? 'helper-tee' : 'local-tee',
    lightClientTip: chainState.evm.tipHeight,
    logIndex: Number(ref.logIndex),
    sourceContract: ethers.getAddress(ref.sourceContract),
  };
}

module.exports = { verifyMelvEf };
