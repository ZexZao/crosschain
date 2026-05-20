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
const { verifyReceiptProof } = require('../../shared/evm/receipt-proof');

function sameHex(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function normalizeHeader(header) {
  return {
    number: Number(header.number),
    hash: header.hash,
    parentHash: header.parentHash,
    stateRoot: header.stateRoot,
    transactionsRoot: header.transactionsRoot,
    receiptsRoot: header.receiptsRoot,
    logsBloom: header.logsBloom,
    timestamp: Number(header.timestamp || 0),
  };
}

function rememberHeader(chainState, header, { finalized = false, windowSize = 128 } = {}) {
  if (!chainState.evm) chainState.evm = { tipHeight: 0, tipHash: null, headers: [] };
  const state = chainState.evm;
  const block = normalizeHeader(header);
  if (!block.hash || !block.parentHash || !block.receiptsRoot) {
    throw new Error('EVM header missing hash, parentHash, or receiptsRoot');
  }
  const number = Number(block.number);
  const prevHeader = (state.headers || []).find((h) => Number(h.number) === number - 1);
  if (prevHeader && block.parentHash !== prevHeader.hash) {
    throw new Error('EVM header chain continuity failed');
  }
  if (number >= Number(state.tipHeight || 0)) {
    state.tipHeight = number;
    state.tipHash = block.hash;
  }
  state.headers = (state.headers || []).filter((h) => Number(h.number) !== number);
  state.headers.push(block);
  state.headers.sort((a, b) => Number(a.number) - Number(b.number));
  while (state.headers.length > windowSize) state.headers.shift();
  if (finalized && number >= Number(state.finalizedHeight || 0)) {
    state.finalizedHeight = number;
    state.finalizedHash = block.hash;
  }
  return block;
}

function findStoredHeader(chainState, blockNumber, blockHash) {
  const header = (chainState.evm?.headers || []).find((item) => Number(item.number) === Number(blockNumber));
  if (!header) return null;
  if (!sameHex(header.hash, blockHash)) {
    throw new Error('stored EVM header hash mismatch');
  }
  return header;
}

async function fetchRpcHeader(provider, blockNumber) {
  const block = await provider.send('eth_getBlockByNumber', [ethers.toQuantity(blockNumber), false]);
  if (!block) throw new Error(`EVM block not found: ${blockNumber}`);
  return normalizeHeader({
    number: Number(BigInt(block.number)),
    hash: block.hash,
    parentHash: block.parentHash,
    stateRoot: block.stateRoot,
    transactionsRoot: block.transactionsRoot,
    receiptsRoot: block.receiptsRoot,
    logsBloom: block.logsBloom,
    timestamp: Number(BigInt(block.timestamp)),
  });
}

async function fetchFinalizedHeader(provider) {
  try {
    const block = await provider.send('eth_getBlockByNumber', ['finalized', false]);
    if (!block) return null;
    return normalizeHeader({
      number: Number(BigInt(block.number)),
      hash: block.hash,
      parentHash: block.parentHash,
      stateRoot: block.stateRoot,
      transactionsRoot: block.transactionsRoot,
      receiptsRoot: block.receiptsRoot,
      logsBloom: block.logsBloom,
      timestamp: Number(BigInt(block.timestamp)),
    });
  } catch (_error) {
    return null;
  }
}

async function maintainHeaderWindow({ provider, chainState, targetBlockNumber, targetBlockHash, proofHeader }) {
  const windowSize = Number(process.env.MELV_HEADER_WINDOW_SIZE || 128);
  const state = chainState.evm || { tipHeight: 0, tipHash: null, headers: [] };
  chainState.evm = state;
  const latestNumber = await provider.getBlockNumber();
  const start = Math.max(
    Number(targetBlockNumber),
    Math.max(0, Number(state.tipHeight || 0) + 1)
  );
  const end = Math.max(Number(targetBlockNumber), Number(latestNumber));

  if (!findStoredHeader(chainState, targetBlockNumber, targetBlockHash)) {
    rememberHeader(chainState, proofHeader, { windowSize });
  }
  for (let n = start; n <= end; n += 1) {
    const existing = (chainState.evm.headers || []).find((h) => Number(h.number) === n);
    if (existing) continue;
    const header = await fetchRpcHeader(provider, n);
    rememberHeader(chainState, header, { windowSize });
  }

  const finalizedHeader = await fetchFinalizedHeader(provider);
  if (finalizedHeader) {
    rememberHeader(chainState, finalizedHeader, { finalized: true, windowSize });
  } else {
    const required = Number(process.env.MELV_LOCAL_FINALITY_CONFIRMATIONS || 1);
    const finalizedHeight = Math.max(0, Number(latestNumber) - required + 1);
    const header = (chainState.evm.headers || []).find((h) => Number(h.number) === finalizedHeight)
      || (finalizedHeight > 0 ? await fetchRpcHeader(provider, finalizedHeight) : null);
    if (header) rememberHeader(chainState, header, { finalized: true, windowSize });
  }

  const stored = findStoredHeader(chainState, targetBlockNumber, targetBlockHash);
  if (!stored) throw new Error('target EVM header is outside maintained header window');
  return stored;
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

  const proofEnvelope = helperData.evmReceiptProof;
  if (!proofEnvelope?.receipt || !proofEnvelope?.receiptProof || !proofEnvelope?.blockHeader) {
    throw new Error('EVM receipt MPT proof is required');
  }
  const provider = new ethers.JsonRpcProvider(process.env.EVM_RPC || helperData.evmRpc || 'http://evm-node:8545');
  const proofHeader = normalizeHeader(proofEnvelope.blockHeader);
  if (Number(proofHeader.number) !== Number(ref.blockNumber)) throw new Error('EVM proof header blockNumber mismatch');
  if (!sameHex(proofHeader.hash, ref.blockHash)) throw new Error('EVM proof header blockHash mismatch');
  if (!sameHex(proofEnvelope.receiptsRoot, proofHeader.receiptsRoot)) throw new Error('EVM proof receiptsRoot mismatch');

  const storedHeader = await maintainHeaderWindow({
    provider,
    chainState,
    targetBlockNumber: ref.blockNumber,
    targetBlockHash: ref.blockHash,
    proofHeader,
  });

  const receipt = proofEnvelope.receipt;
  if (!sameHex(receipt.transactionHash || receipt.hash, ref.txHash)) throw new Error('EVM receipt txHash mismatch');
  if (Number(BigInt(receipt.blockNumber)) !== Number(ref.blockNumber)) throw new Error('EVM receipt blockNumber mismatch');
  if (!sameHex(receipt.blockHash, ref.blockHash)) throw new Error('EVM receipt blockHash mismatch');
  await verifyReceiptProof({
    receiptsRoot: storedHeader.receiptsRoot,
    transactionIndex: Number(receipt.transactionIndex ?? receipt.index),
    proof: proofEnvelope.receiptProof,
    expectedReceipt: receipt,
  });

  const latestBlock = await provider.getBlockNumber();
  const confirmations = Math.max(0, Number(latestBlock) - Number(ref.blockNumber) + 1);
  if (confirmations < Number(hxmsg.verification.requiredConfirmations || policy.requiredConfirmations)) {
    throw new Error(`EVM confirmations insufficient: got=${confirmations}`);
  }
  if (chainState.evm?.finalizedHeight && Number(ref.blockNumber) > Number(chainState.evm.finalizedHeight)) {
    throw new Error(`EVM block is not finalized by maintained checkpoint: block=${ref.blockNumber}, finalized=${chainState.evm.finalizedHeight}`);
  }

  const log = (receipt.logs || []).find((item, index) => {
    const globalIndex = item.logIndex ?? item.index;
    if (globalIndex !== undefined && Number(BigInt(globalIndex)) === Number(ref.logIndex)) return true;
    return index === Number(ref.logIndex);
  });
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
    receiptProof: 'mpt-verified',
    headerMaintainer: 'tee-sliding-header-window',
    lightClientTip: chainState.evm.tipHeight,
    finalizedHeight: chainState.evm.finalizedHeight || 0,
    logIndex: Number(ref.logIndex),
    sourceContract: ethers.getAddress(ref.sourceContract),
  };
}

module.exports = {
  adapterID: 'tee-adapter-evm-melv-ef-v1',
  sourceChainType: ChainType.EVM,
  verificationMethod: VerificationMethod.EVM_LIGHT_CLIENT,
  verifySourceFact: verifyMelvEf,
  verifyMelvEf,
};
