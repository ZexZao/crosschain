const { checkEthereumFinality } = require('../shared/adapters/ethereum/finality');
const { buildEthereumEvidence } = require('../shared/adapters/ethereum/proof-builder');
const { checkFabricFinality } = require('../shared/adapters/fabric/finality');
const { buildFabricEvidence } = require('../shared/adapters/fabric/proof-builder');
const { checkAvalancheFinality } = require('../shared/adapters/avalanche/finality');
const { buildAvalancheEvidence } = require('../shared/adapters/avalanche/proof-builder');

function sourceAdapter(profile) {
  if (profile.name === 'fabric') return { checkFinality: checkFabricFinality, buildEvidence: buildFabricEvidence };
  if (profile.name === 'avalanche') return { checkFinality: checkAvalancheFinality, buildEvidence: buildAvalancheEvidence };
  return { checkFinality: checkEthereumFinality, buildEvidence: buildEthereumEvidence };
}

module.exports = { sourceAdapter };
