const axios = require('axios');

async function requestConsensusAggregate({
  channelName,
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

module.exports = {
  requestConsensusAggregate
};
