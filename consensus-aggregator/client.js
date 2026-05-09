const axios = require('axios');

async function requestConsensusAggregate({
  channelName,
  networkName,
  blockNumber,
  blockHash,
  eventRoot,
  requestID,
  payloadHash,
  txId
}) {
  const aggregatorUrl = process.env.CONSENSUS_AGGREGATOR_URL || 'http://127.0.0.1:9200';
  const response = await axios.post(
    `${aggregatorUrl}/aggregate`,
    {
      channelName,
      networkName,
      blockNumber,
      blockHash,
      eventRoot,
      requestID,
      payloadHash,
      txId
    },
    {
      timeout: Number(process.env.CONSENSUS_AGGREGATOR_TIMEOUT_MS || 10000)
    }
  );

  return response.data;
}

async function requestBlsConsensusAggregate({
  channelName,
  networkName,
  blockNumber,
  blockHash,
  eventRoot,
  requestID,
  payloadHash,
  txId
}) {
  const aggregatorUrl = process.env.CONSENSUS_AGGREGATOR_URL || 'http://127.0.0.1:9200';
  const response = await axios.post(
    `${aggregatorUrl}/bls-aggregate`,
    {
      channelName,
      networkName,
      blockNumber,
      blockHash,
      eventRoot,
      requestID,
      payloadHash,
      txId
    },
    {
      timeout: Number(process.env.CONSENSUS_AGGREGATOR_TIMEOUT_MS || 10000)
    }
  );

  return response.data;
}

async function requestV3ConsensusAggregate({
  channelName,
  networkName,
  blockNumber,
  blockHash,
  eventRoot,
  requestID,
  payloadHash,
  txId
}) {
  const aggregatorUrl = process.env.CONSENSUS_AGGREGATOR_URL || 'http://127.0.0.1:9200';
  const response = await axios.post(
    `${aggregatorUrl}/v3-aggregate`,
    { channelName, networkName, blockNumber, blockHash, eventRoot, requestID, payloadHash, txId },
    { timeout: Number(process.env.CONSENSUS_AGGREGATOR_TIMEOUT_MS || 10000) }
  );
  return response.data;
}

async function requestMpcConsensusAggregate(params) {
  const aggregatorUrl = process.env.CONSENSUS_AGGREGATOR_URL || 'http://127.0.0.1:9200';
  const response = await axios.post(`${aggregatorUrl}/mpc-aggregate`, params,
    { timeout: Number(process.env.CONSENSUS_AGGREGATOR_TIMEOUT_MS || 10000) });
  return response.data;
}

module.exports = {
  requestConsensusAggregate,
  requestBlsConsensusAggregate,
  requestV3ConsensusAggregate,
  requestMpcConsensusAggregate,
};
