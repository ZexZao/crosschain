const express = require('express');
const { buildConsensusAggregate } = require('./index');
const { getTrustedValidatorSet } = require('./validator-set');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'consensus-aggregator' });
});

app.get('/validator-set/:channelName', (req, res) => {
  try {
    const validatorSet = getTrustedValidatorSet(req.params.channelName);
    res.json({
      validatorSetId: validatorSet.validatorSetId,
      threshold: validatorSet.threshold,
      validators: validatorSet.validators.map((validator) => ({
        id: validator.id,
        address: validator.address,
        url: validator.url
      }))
    });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.post('/aggregate', async (req, res) => {
  try {
    const consensusProof = await buildConsensusAggregate(req.body);
    res.json(consensusProof);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const port = Number(process.env.PORT || 9200);
app.listen(port, () => {
  console.log(`consensus-aggregator listening on ${port}`);
});
