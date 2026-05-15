const { ethers } = require('ethers');
const { common, protos, rwset, kvrwset } = require('fabric-protos');

const TRANSACTIONS_FILTER = 2;
const VALID = 0;

function bufferFromBytes(value) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value || []);
}

function decodeChannelHeader(payload) {
  return common.ChannelHeader.decode(payload.header.channel_header);
}

function extractChaincodeWrites(actionPayload) {
  const ccActionPayload = protos.ChaincodeActionPayload.decode(actionPayload.payload);
  const proposalResponsePayload = protos.ProposalResponsePayload.decode(
    ccActionPayload.action.proposal_response_payload
  );
  const chaincodeAction = protos.ChaincodeAction.decode(proposalResponsePayload.extension);
  const txRwSet = rwset.TxReadWriteSet.decode(chaincodeAction.results);
  const writes = [];
  for (const nsRwSet of txRwSet.ns_rwset || []) {
    const kv = kvrwset.KVRWSet.decode(nsRwSet.rwset);
    for (const write of kv.writes || []) {
      writes.push({
        namespace: nsRwSet.namespace,
        key: write.key,
        isDelete: Boolean(write.is_delete),
        value: bufferFromBytes(write.value).toString('utf8'),
      });
    }
  }
  return writes;
}

function verifyFabricBlockContainsTx({ blockBytes, expectedTxId, expectedBlockNumber, expectedWriteKey }) {
  const block = common.Block.decode(blockBytes);
  const blockNumber = Number(block.header.number);
  if (blockNumber !== Number(expectedBlockNumber)) {
    throw new Error(`Fabric block number mismatch: expected=${expectedBlockNumber}, actual=${blockNumber}`);
  }

  const validationCodes = block.metadata?.metadata?.[TRANSACTIONS_FILTER] || Buffer.alloc(0);
  const dataItems = block.data?.data || [];
  let matched = null;

  for (let index = 0; index < dataItems.length; index += 1) {
    const envelope = common.Envelope.decode(dataItems[index]);
    const payload = common.Payload.decode(envelope.payload);
    const channelHeader = decodeChannelHeader(payload);
    if (channelHeader.tx_id !== expectedTxId) continue;

    const validationCode = validationCodes[index];
    if (validationCode !== VALID) {
      throw new Error(`Fabric transaction ${expectedTxId} is not VALID: code=${validationCode}`);
    }

    const tx = protos.Transaction.decode(payload.data);
    const writes = [];
    for (const action of tx.actions || []) {
      writes.push(...extractChaincodeWrites(action));
    }
    if (expectedWriteKey && !writes.some((write) => write.key === expectedWriteKey && !write.isDelete)) {
      throw new Error(`Fabric transaction ${expectedTxId} did not write expected key ${expectedWriteKey}`);
    }

    matched = {
      txId: channelHeader.tx_id,
      channelId: channelHeader.channel_id,
      type: channelHeader.type,
      index,
      validationCode,
      writes,
      blockHash: ethers.sha256(common.BlockHeader.encode(block.header).finish()),
    };
    break;
  }

  if (!matched) {
    throw new Error(`Fabric transaction ${expectedTxId} not found in block ${blockNumber}`);
  }
  return matched;
}

module.exports = { verifyFabricBlockContainsTx };
