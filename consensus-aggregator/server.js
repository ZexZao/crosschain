const express = require('express');
const { buildConsensusAggregate, buildBlsConsensusAggregate, buildV3ConsensusProof } = require('./index');
const { getTrustedValidatorSet } = require('./validator-set');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'consensus-aggregator' });
});

app.get('/validator-set/:scopeName', (req, res) => {
  try {
    const validatorSet = getTrustedValidatorSet(req.params.scopeName);
    res.json({
      validatorSetId: validatorSet.validatorSetId,
      threshold: validatorSet.threshold,
      validators: validatorSet.validators.map((v) => ({
        id: v.id, address: v.address, url: v.url, blsPubkey: v.blsPubkey,
      }))
    });
  } catch (error) {
    res.status(404).json({ error: error.message });
  }
});

app.post('/aggregate', async (req, res) => {
  try {
    const proof = await buildConsensusAggregate(req.body);
    res.json(proof);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/bls-aggregate', async (req, res) => {
  try {
    const proof = await buildBlsConsensusAggregate(req.body);
    res.json(proof);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// V3: ECDSA threshold signatures array (for on-chain dual verification)
app.post('/v3-aggregate', async (req, res) => {
  try {
    const proof = await buildV3ConsensusProof(req.body);
    res.json(proof);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const port = Number(process.env.PORT || 9200);
app.listen(port, () => {
  console.log(`consensus-aggregator listening on ${port} (V3 ECDSA + BLS + legacy ECDSA)`);
});
