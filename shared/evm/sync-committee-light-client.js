const crypto = require('crypto');
const { ethers } = require('ethers');

const DOMAIN_SYNC_COMMITTEE = '0x07000000';
const SYNC_COMMITTEE_SIZE = 512;
const EXECUTION_PAYLOAD_GINDEX = 25;
const FINALIZED_ROOT_GINDEX = 105;
const CURRENT_SYNC_COMMITTEE_GINDEX = 54;
const NEXT_SYNC_COMMITTEE_GINDEX = 55;
const FINALIZED_ROOT_GINDEX_ELECTRA = 169;
const CURRENT_SYNC_COMMITTEE_GINDEX_ELECTRA = 86;
const NEXT_SYNC_COMMITTEE_GINDEX_ELECTRA = 87;

let cachedSsz = null;
let cachedBls = null;
let cachedTypes = null;

function strip0x(value) {
  return String(value || '').replace(/^0x/i, '');
}

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  return Uint8Array.from(Buffer.from(strip0x(value), 'hex'));
}

function hex(value) {
  return `0x${Buffer.from(value).toString('hex')}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function concat(a, b) {
  return Buffer.concat([Buffer.from(a), Buffer.from(b)]);
}

async function sszTypes() {
  if (cachedTypes) return cachedTypes;
  const ssz = cachedSsz || await import('@chainsafe/ssz');
  cachedSsz = ssz;
  const Bytes4 = new ssz.ByteVectorType(4);
  const Bytes20 = new ssz.ByteVectorType(20);
  const Bytes32 = new ssz.ByteVectorType(32);
  const Bytes48 = new ssz.ByteVectorType(48);
  const Bytes256 = new ssz.ByteVectorType(256);
  const ExtraData = new ssz.ByteListType(32);
  const Uint64 = new ssz.UintBigintType(8);
  const Uint256 = new ssz.UintBigintType(32);
  cachedTypes = {
    BeaconBlockHeader: new ssz.ContainerType({
      slot: Uint64,
      proposer_index: Uint64,
      parent_root: Bytes32,
      state_root: Bytes32,
      body_root: Bytes32,
    }),
    ExecutionPayloadHeader: new ssz.ContainerType({
      parent_hash: Bytes32,
      fee_recipient: Bytes20,
      state_root: Bytes32,
      receipts_root: Bytes32,
      logs_bloom: Bytes256,
      prev_randao: Bytes32,
      block_number: Uint64,
      gas_limit: Uint64,
      gas_used: Uint64,
      timestamp: Uint64,
      extra_data: ExtraData,
      base_fee_per_gas: Uint256,
      block_hash: Bytes32,
      transactions_root: Bytes32,
      withdrawals_root: Bytes32,
      blob_gas_used: Uint64,
      excess_blob_gas: Uint64,
    }),
    SyncCommittee: new ssz.ContainerType({
      pubkeys: new ssz.VectorCompositeType(Bytes48, SYNC_COMMITTEE_SIZE),
      aggregate_pubkey: Bytes48,
    }),
    ForkData: new ssz.ContainerType({
      current_version: Bytes4,
      genesis_validators_root: Bytes32,
    }),
    SigningData: new ssz.ContainerType({
      object_root: Bytes32,
      domain: Bytes32,
    }),
  };
  return cachedTypes;
}

async function bls() {
  if (!cachedBls) cachedBls = (await import('@chainsafe/bls')).default;
  return cachedBls;
}

function sameHex(a, b) {
  return String(a || '').toLowerCase() === String(b || '').toLowerCase();
}

function normalizeExecutionHeader(header) {
  return {
    number: Number(header.block_number ?? header.number),
    hash: header.block_hash ?? header.hash,
    parentHash: header.parent_hash ?? header.parentHash,
    stateRoot: header.state_root ?? header.stateRoot,
    transactionsRoot: header.transactions_root ?? header.transactionsRoot,
    receiptsRoot: header.receipts_root ?? header.receiptsRoot,
    logsBloom: header.logs_bloom ?? header.logsBloom,
    timestamp: Number(header.timestamp || 0),
  };
}

async function beaconHeaderRoot(header) {
  const { BeaconBlockHeader } = await sszTypes();
  return BeaconBlockHeader.hashTreeRoot({
    slot: BigInt(header.slot),
    proposer_index: BigInt(header.proposer_index),
    parent_root: bytes(header.parent_root),
    state_root: bytes(header.state_root),
    body_root: bytes(header.body_root),
  });
}

async function executionPayloadHeaderRoot(header) {
  const { ExecutionPayloadHeader } = await sszTypes();
  return ExecutionPayloadHeader.hashTreeRoot({
    parent_hash: bytes(header.parent_hash),
    fee_recipient: bytes(header.fee_recipient),
    state_root: bytes(header.state_root),
    receipts_root: bytes(header.receipts_root),
    logs_bloom: bytes(header.logs_bloom),
    prev_randao: bytes(header.prev_randao),
    block_number: BigInt(header.block_number),
    gas_limit: BigInt(header.gas_limit),
    gas_used: BigInt(header.gas_used),
    timestamp: BigInt(header.timestamp),
    extra_data: bytes(header.extra_data || '0x'),
    base_fee_per_gas: BigInt(header.base_fee_per_gas),
    block_hash: bytes(header.block_hash),
    transactions_root: bytes(header.transactions_root),
    withdrawals_root: bytes(header.withdrawals_root),
    blob_gas_used: BigInt(header.blob_gas_used || 0),
    excess_blob_gas: BigInt(header.excess_blob_gas || 0),
  });
}

async function syncCommitteeRoot(syncCommittee) {
  const { SyncCommittee } = await sszTypes();
  return SyncCommittee.hashTreeRoot({
    pubkeys: syncCommittee.pubkeys.map(bytes),
    aggregate_pubkey: bytes(syncCommittee.aggregate_pubkey),
  });
}

async function forkDataRoot(forkVersion, genesisValidatorsRoot) {
  const { ForkData } = await sszTypes();
  return ForkData.hashTreeRoot({
    current_version: bytes(forkVersion),
    genesis_validators_root: bytes(genesisValidatorsRoot),
  });
}

async function computeDomain(domainType, forkVersion, genesisValidatorsRoot) {
  const root = await forkDataRoot(forkVersion, genesisValidatorsRoot);
  const out = new Uint8Array(32);
  out.set(bytes(domainType), 0);
  out.set(root.slice(0, 28), 4);
  return out;
}

async function computeSigningRoot(objectRoot, domain) {
  const { SigningData } = await sszTypes();
  return SigningData.hashTreeRoot({
    object_root: objectRoot,
    domain,
  });
}

function isValidMerkleBranch(leaf, branch, gindex, expectedRoot) {
  let value = Buffer.from(leaf);
  const index = BigInt(gindex);
  for (let i = 0; i < branch.length; i += 1) {
    const sibling = Buffer.from(bytes(branch[i]));
    value = ((index >> BigInt(i)) & 1n) === 1n
      ? sha256(concat(sibling, value))
      : sha256(concat(value, sibling));
  }
  return sameHex(hex(value), expectedRoot);
}

function parseSyncCommitteeBits(bitHex) {
  const data = bytes(bitHex);
  const bits = [];
  for (let i = 0; i < SYNC_COMMITTEE_SIZE; i += 1) {
    bits.push(Boolean(data[Math.floor(i / 8)] & (1 << (i % 8))));
  }
  return bits;
}

function countTrue(items) {
  return items.reduce((sum, item) => sum + (item ? 1 : 0), 0);
}

function computeEpochAtSlot(slot, spec) {
  return BigInt(slot) / BigInt(spec.SLOTS_PER_EPOCH || 32);
}

function syncCommitteePeriodAtSlot(slot, spec) {
  return computeEpochAtSlot(slot, spec) / BigInt(spec.EPOCHS_PER_SYNC_COMMITTEE_PERIOD || 256);
}

function forkVersionAtSlot(slot, spec) {
  const epoch = computeEpochAtSlot(slot, spec);
  const forks = [
    ['FULU_FORK_EPOCH', 'FULU_FORK_VERSION'],
    ['ELECTRA_FORK_EPOCH', 'ELECTRA_FORK_VERSION'],
    ['DENEB_FORK_EPOCH', 'DENEB_FORK_VERSION'],
    ['CAPELLA_FORK_EPOCH', 'CAPELLA_FORK_VERSION'],
    ['BELLATRIX_FORK_EPOCH', 'BELLATRIX_FORK_VERSION'],
    ['ALTAIR_FORK_EPOCH', 'ALTAIR_FORK_VERSION'],
  ];
  for (const [epochKey, versionKey] of forks) {
    if (spec[epochKey] !== undefined && epoch >= BigInt(spec[epochKey])) {
      return spec[versionKey];
    }
  }
  return spec.GENESIS_FORK_VERSION;
}

function isElectraOrLater(slot, spec) {
  return spec.ELECTRA_FORK_EPOCH !== undefined
    && computeEpochAtSlot(slot, spec) >= BigInt(spec.ELECTRA_FORK_EPOCH);
}

function finalizedRootGindexAtSlot(slot, spec) {
  return isElectraOrLater(slot, spec) ? FINALIZED_ROOT_GINDEX_ELECTRA : FINALIZED_ROOT_GINDEX;
}

function currentSyncCommitteeGindexAtSlot(slot, spec) {
  return isElectraOrLater(slot, spec) ? CURRENT_SYNC_COMMITTEE_GINDEX_ELECTRA : CURRENT_SYNC_COMMITTEE_GINDEX;
}

function nextSyncCommitteeGindexAtSlot(slot, spec) {
  return isElectraOrLater(slot, spec) ? NEXT_SYNC_COMMITTEE_GINDEX_ELECTRA : NEXT_SYNC_COMMITTEE_GINDEX;
}

async function verifySyncAggregate({
  syncCommittee,
  syncAggregate,
  signedHeader,
  signatureSlot,
  genesis,
  spec,
}) {
  const bits = parseSyncCommitteeBits(syncAggregate.sync_committee_bits);
  const participantCount = countTrue(bits);
  const signingForkVersion = forkVersionAtSlot(signatureSlot, spec);
  const signingDomain = await computeDomain(DOMAIN_SYNC_COMMITTEE, signingForkVersion, genesis.genesis_validators_root);
  const signedHeaderRoot = await beaconHeaderRoot(signedHeader);
  const signingRoot = await computeSigningRoot(signedHeaderRoot, signingDomain);
  const participantPubkeys = syncCommittee.pubkeys
    .filter((_pubkey, index) => bits[index])
    .map(bytes);
  const blsLib = await bls();
  const signatureOK = blsLib.verifyAggregate(
    participantPubkeys,
    signingRoot,
    bytes(syncAggregate.sync_committee_signature)
  );
  return {
    signatureOK,
    participantCount,
    signingForkVersion,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(baseUrl, path, { retries = 3, retryDelayMs = 1500 } = {}) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}${path}`;
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const resp = await fetch(url, { headers: { accept: 'application/json' } });
      const text = await resp.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(`Beacon API returned non-JSON for ${path}: ${text.slice(0, 160)}`);
      }
      if (!resp.ok || parsed.error) {
        throw new Error(`Beacon API ${path} failed: ${parsed.message || parsed.error || resp.statusText}`);
      }
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
    }
  }
  throw lastError;
}

function normalizeLightClientUpdates(response) {
  if (!response) return [];
  if (Array.isArray(response)) return response;
  if (Array.isArray(response.data)) return response.data;
  return [];
}

async function fetchLightClientUpdates({
  beaconApiUrl,
  startPeriod,
  endPeriod,
  chunkSize = 128,
}) {
  const updates = [];
  let cursor = BigInt(startPeriod);
  const target = BigInt(endPeriod);
  const maxChunk = BigInt(Math.max(1, Number(chunkSize || 128)));
  while (cursor < target) {
    const count = target - cursor > maxChunk ? maxChunk : target - cursor;
    const response = await fetchJson(
      beaconApiUrl,
      `/eth/v1/beacon/light_client/updates?start_period=${cursor.toString()}&count=${count.toString()}`
    );
    const chunk = normalizeLightClientUpdates(response);
    updates.push(...chunk);
    if (chunk.length === 0) break;
    cursor += BigInt(chunk.length);
  }
  return updates;
}

async function fetchBeaconCheckpointPath({ beaconApiUrl, finalizedHeader, spec, maxHeaders = 64 }) {
  const slotsPerEpoch = Number(spec.SLOTS_PER_EPOCH || 32);
  const finalizedSlot = Number(finalizedHeader.slot);
  const checkpointSlot = Math.floor(finalizedSlot / slotsPerEpoch) * slotsPerEpoch;
  const finalizedRoot = hex(await beaconHeaderRoot(finalizedHeader));
  const path = [{ root: finalizedRoot, header: finalizedHeader }];
  let current = finalizedHeader;
  while (Number(current.slot) > checkpointSlot) {
    if (path.length >= maxHeaders) throw new Error('beacon checkpoint ancestor path is too long');
    const parentRoot = current.parent_root;
    const response = await fetchJson(beaconApiUrl, `/eth/v1/beacon/headers/${parentRoot}`);
    const parent = response.data?.header?.message;
    if (!parent || !sameHex(response.data.root, parentRoot)) {
      throw new Error('beacon checkpoint parent header response mismatch');
    }
    const computedRoot = hex(await beaconHeaderRoot(parent));
    if (!sameHex(computedRoot, parentRoot)) throw new Error('beacon checkpoint parent header root mismatch');
    path.push({ root: computedRoot, header: parent });
    current = parent;
  }
  return path;
}

async function fetchBeaconLightClientInputs({
  beaconApiUrl,
  executionProvider,
  targetBlockNumber,
  trustedBlockRoot,
  allowDynamicTrustedRoot = false,
  maxAncestorHeaders = 256,
}) {
  if (!beaconApiUrl) throw new Error('beaconApiUrl is required');
  let root = trustedBlockRoot;
  if (!root) {
    if (!allowDynamicTrustedRoot) {
      throw new Error('trustedBlockRoot is required for sync committee bootstrap');
    }
    const finalized = await fetchJson(beaconApiUrl, '/eth/v1/beacon/headers/finalized');
    root = finalized.data.root;
  }
  const [genesisResp, specResp, bootstrapResp, finalityResp] = await Promise.all([
    fetchJson(beaconApiUrl, '/eth/v1/beacon/genesis'),
    fetchJson(beaconApiUrl, '/eth/v1/config/spec'),
    fetchJson(beaconApiUrl, `/eth/v1/beacon/light_client/bootstrap/${root}`),
    fetchJson(beaconApiUrl, '/eth/v1/beacon/light_client/finality_update'),
  ]);
  const bootstrapPeriod = syncCommitteePeriodAtSlot(bootstrapResp.data.header.beacon.slot, specResp.data);
  const signaturePeriod = syncCommitteePeriodAtSlot(finalityResp.data.signature_slot, specResp.data);
  const lightClientUpdates = signaturePeriod > bootstrapPeriod
    ? await fetchLightClientUpdates({
      beaconApiUrl,
      startPeriod: bootstrapPeriod,
      endPeriod: signaturePeriod,
      chunkSize: Number(process.env.SEPOLIA_LIGHT_CLIENT_UPDATE_CHUNK_SIZE || 128),
    })
    : [];
  const finalizedExecution = finalityResp.data.finalized_header.execution;
  const beaconCheckpointHeaders = await fetchBeaconCheckpointPath({
    beaconApiUrl,
    finalizedHeader: finalityResp.data.finalized_header.beacon,
    spec: specResp.data,
  });
  const finalizedNumber = Number(finalizedExecution.block_number);
  const ancestorHeaders = [];
  if (executionProvider && targetBlockNumber !== undefined) {
    const start = Number(targetBlockNumber);
    if (start > finalizedNumber) {
      throw new Error(`target block is not finalized yet: target=${start}, finalized=${finalizedNumber}`);
    }
    if (finalizedNumber - start + 1 > maxAncestorHeaders) {
      throw new Error(`ancestor header path too long: ${finalizedNumber - start + 1} > ${maxAncestorHeaders}`);
    }
    for (let n = start; n <= finalizedNumber; n += 1) {
      const block = await executionProvider.send('eth_getBlockByNumber', [ethers.toQuantity(n), false]);
      if (!block) throw new Error(`execution header not found: ${n}`);
      ancestorHeaders.push({
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
  }
  return {
    proofType: 'ETHEREUM_SYNC_COMMITTEE_FINALITY',
    chainType: 'EVM',
    chainID: 'eip155:11155111',
    trustedBlockRoot: root,
    genesis: genesisResp.data,
    spec: specResp.data,
    bootstrap: bootstrapResp.data,
    lightClientUpdates,
    finalityUpdate: finalityResp.data,
    finalityVersion: finalityResp.version,
    beaconCheckpointHeaders,
    ancestorHeaders,
  };
}

async function verifySyncCommitteeHeaderUpdate(update, {
  expectedChainID,
  targetBlockNumber,
  targetBlockHash,
  minParticipationNumerator = 2,
  minParticipationDenominator = 3,
} = {}) {
  if (!update || update.proofType !== 'ETHEREUM_SYNC_COMMITTEE_FINALITY') {
    throw new Error('Ethereum sync committee finality proof is required');
  }
  if (expectedChainID && update.chainID !== expectedChainID) {
    throw new Error('sync committee proof chainID mismatch');
  }
  const { bootstrap, finalityUpdate, genesis, spec } = update;
  if (!bootstrap?.header?.beacon || !bootstrap?.current_sync_committee || !finalityUpdate?.attested_header?.beacon) {
    throw new Error('sync committee proof missing bootstrap/finality data');
  }
  const bootstrapHeaderRoot = await beaconHeaderRoot(bootstrap.header.beacon);
  if (!sameHex(hex(bootstrapHeaderRoot), update.trustedBlockRoot)) {
    throw new Error('bootstrap header root does not match trusted block root');
  }
  const currentRoot = await syncCommitteeRoot(bootstrap.current_sync_committee);
  const currentGindex = currentSyncCommitteeGindexAtSlot(bootstrap.header.beacon.slot, spec);
  if (!isValidMerkleBranch(currentRoot, bootstrap.current_sync_committee_branch, currentGindex, bootstrap.header.beacon.state_root)) {
    throw new Error('current sync committee branch is invalid');
  }

  let activeSyncCommittee = bootstrap.current_sync_committee;
  let activePeriod = syncCommitteePeriodAtSlot(bootstrap.header.beacon.slot, spec);
  const targetSignaturePeriod = syncCommitteePeriodAtSlot(finalityUpdate.signature_slot, spec);
  const committeeUpdates = normalizeLightClientUpdates(update.lightClientUpdates);
  const committeeUpdateSummaries = [];
  for (const envelope of committeeUpdates) {
    const item = envelope.data || envelope;
    if (!item?.attested_header?.beacon || !item?.next_sync_committee || !item?.next_sync_committee_branch) {
      throw new Error('sync committee update missing next committee data');
    }
    const itemSignaturePeriod = syncCommitteePeriodAtSlot(item.signature_slot, spec);
    if (itemSignaturePeriod < activePeriod) continue;
    if (itemSignaturePeriod > activePeriod) {
      throw new Error(`sync committee update period gap: expected=${activePeriod.toString()}, got=${itemSignaturePeriod.toString()}`);
    }
    const aggregate = await verifySyncAggregate({
      syncCommittee: activeSyncCommittee,
      syncAggregate: item.sync_aggregate,
      signedHeader: item.attested_header.beacon,
      signatureSlot: item.signature_slot,
      genesis,
      spec,
    });
    if (!aggregate.signatureOK) {
      throw new Error(`sync committee period ${activePeriod.toString()} update signature is invalid`);
    }
    const nextRoot = await syncCommitteeRoot(item.next_sync_committee);
    const nextGindex = nextSyncCommitteeGindexAtSlot(item.attested_header.beacon.slot, spec);
    if (!isValidMerkleBranch(nextRoot, item.next_sync_committee_branch, nextGindex, item.attested_header.beacon.state_root)) {
      throw new Error(`next sync committee branch is invalid for period ${activePeriod.toString()}`);
    }
    committeeUpdateSummaries.push({
      fromPeriod: Number(activePeriod),
      toPeriod: Number(activePeriod + 1n),
      attestedSlot: Number(item.attested_header.beacon.slot),
      signatureSlot: Number(item.signature_slot),
      participantCount: aggregate.participantCount,
    });
    activeSyncCommittee = item.next_sync_committee;
    activePeriod += 1n;
    if (activePeriod >= targetSignaturePeriod) break;
  }
  if (activePeriod !== targetSignaturePeriod) {
    throw new Error(`sync committee is stale: activePeriod=${activePeriod.toString()}, required=${targetSignaturePeriod.toString()}`);
  }

  const finalizedHeaderRoot = await beaconHeaderRoot(finalityUpdate.finalized_header.beacon);
  const finalityGindex = finalizedRootGindexAtSlot(finalityUpdate.attested_header.beacon.slot, spec);
  if (!isValidMerkleBranch(finalizedHeaderRoot, finalityUpdate.finality_branch, finalityGindex, finalityUpdate.attested_header.beacon.state_root)) {
    throw new Error('finality branch is invalid');
  }
  const finalizedExecutionRoot = await executionPayloadHeaderRoot(finalityUpdate.finalized_header.execution);
  if (!isValidMerkleBranch(finalizedExecutionRoot, finalityUpdate.finalized_header.execution_branch, EXECUTION_PAYLOAD_GINDEX, finalityUpdate.finalized_header.beacon.body_root)) {
    throw new Error('finalized execution payload branch is invalid');
  }
  const attestedExecutionRoot = await executionPayloadHeaderRoot(finalityUpdate.attested_header.execution);
  if (!isValidMerkleBranch(attestedExecutionRoot, finalityUpdate.attested_header.execution_branch, EXECUTION_PAYLOAD_GINDEX, finalityUpdate.attested_header.beacon.body_root)) {
    throw new Error('attested execution payload branch is invalid');
  }

  const bits = parseSyncCommitteeBits(finalityUpdate.sync_aggregate.sync_committee_bits);
  const participantCount = countTrue(bits);
  if (participantCount * minParticipationDenominator < SYNC_COMMITTEE_SIZE * minParticipationNumerator) {
    throw new Error(`sync committee participation below threshold: ${participantCount}/${SYNC_COMMITTEE_SIZE}`);
  }
  const finalityAggregate = await verifySyncAggregate({
    syncCommittee: activeSyncCommittee,
    syncAggregate: finalityUpdate.sync_aggregate,
    signedHeader: finalityUpdate.attested_header.beacon,
    signatureSlot: finalityUpdate.signature_slot,
    genesis,
    spec,
  });
  if (!finalityAggregate.signatureOK) throw new Error('sync committee aggregate signature is invalid');

  const checkpointPath = update.beaconCheckpointHeaders || [];
  if (!checkpointPath.length) throw new Error('beacon checkpoint ancestor path is required');
  let expectedRoot = hex(finalizedHeaderRoot);
  let previousHeader = finalityUpdate.finalized_header.beacon;
  for (let i = 0; i < checkpointPath.length; i += 1) {
    const entry = checkpointPath[i];
    const computedRoot = hex(await beaconHeaderRoot(entry.header));
    if (!sameHex(entry.root, computedRoot) || !sameHex(entry.root, expectedRoot)) {
      throw new Error('beacon checkpoint ancestor root mismatch');
    }
    if (i > 0 && !sameHex(previousHeader.parent_root, entry.root)) {
      throw new Error('beacon checkpoint ancestor hash chain is invalid');
    }
    previousHeader = entry.header;
    expectedRoot = entry.header.parent_root;
  }
  const slotsPerEpoch = Number(spec.SLOTS_PER_EPOCH || 32);
  const checkpointSlot = Math.floor(Number(finalityUpdate.finalized_header.beacon.slot) / slotsPerEpoch) * slotsPerEpoch;
  const checkpoint = checkpointPath[checkpointPath.length - 1];
  if (Number(checkpoint.header.slot) > checkpointSlot) {
    throw new Error('beacon checkpoint ancestor path did not reach finalized epoch boundary');
  }

  const finalizedHeader = normalizeExecutionHeader(finalityUpdate.finalized_header.execution);
  const headers = (update.ancestorHeaders || []).map(normalizeExecutionHeader);
  let targetHeader = finalizedHeader;
  if (targetBlockNumber !== undefined) {
    if (!headers.length) throw new Error('ancestor execution headers are required for non-checkpoint target block');
    headers.sort((a, b) => Number(a.number) - Number(b.number));
    const targetIndex = headers.findIndex((header) => Number(header.number) === Number(targetBlockNumber));
    if (targetIndex === -1) {
      throw new Error('ancestor header path does not include target block');
    }
    for (let i = targetIndex + 1; i < headers.length; i += 1) {
      if (!sameHex(headers[i].parentHash, headers[i - 1].hash)) {
        throw new Error('execution ancestor hash chain is invalid');
      }
    }
    const last = headers[headers.length - 1];
    if (!sameHex(last.hash, finalizedHeader.hash)) {
      throw new Error('execution ancestor path is not anchored to finalized sync-committee header');
    }
    targetHeader = headers[targetIndex];
    if (targetBlockHash && !sameHex(targetHeader.hash, targetBlockHash)) {
      throw new Error('target execution header hash mismatch');
    }
  }
  return {
    header: targetHeader,
    finalizedHeader,
    finalizedHeight: finalizedHeader.number,
    finalizedHash: finalizedHeader.hash,
    beaconFinalizedSlot: Number(finalityUpdate.finalized_header.beacon.slot),
    attestedSlot: Number(finalityUpdate.attested_header.beacon.slot),
    signatureSlot: Number(finalityUpdate.signature_slot),
    syncCommitteePeriod: Number(targetSignaturePeriod),
    committeeUpdates: committeeUpdateSummaries,
    participantCount,
    threshold: Math.ceil((SYNC_COMMITTEE_SIZE * minParticipationNumerator) / minParticipationDenominator),
    trustedBlockRoot: update.trustedBlockRoot,
    finalizedBeaconBlockRoot: hex(finalizedHeaderRoot),
    nextTrustedBlockRoot: checkpoint.root,
    nextTrustedBlockSlot: Number(checkpoint.header.slot),
    proofType: update.proofType,
  };
}

module.exports = {
  EXECUTION_PAYLOAD_GINDEX,
  FINALIZED_ROOT_GINDEX_ELECTRA,
  CURRENT_SYNC_COMMITTEE_GINDEX_ELECTRA,
  NEXT_SYNC_COMMITTEE_GINDEX_ELECTRA,
  normalizeExecutionHeader,
  syncCommitteePeriodAtSlot,
  normalizeLightClientUpdates,
  fetchBeaconLightClientInputs,
  verifySyncCommitteeHeaderUpdate,
};
