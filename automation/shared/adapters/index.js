const { EthereumEventScanner } = require('./ethereum/scanner');
const { AvalancheEventScanner } = require('./avalanche/scanner');
const { FabricEventScanner } = require('./fabric/scanner');

function scannerStartBlock(name) {
  const key = `AUTOMATION_${name.toUpperCase()}_START_BLOCK`;
  return process.env[key] === undefined ? undefined : Number(process.env[key]);
}

function createScanner(profile) {
  if (profile.name === 'fabric') {
    return new FabricEventScanner({
      id: `fabric:${profile.channel}:${profile.chaincode}`,
      chainID: `fabric:${profile.channel}`,
      profile,
      startBlock: scannerStartBlock('fabric'),
    });
  }
  if (profile.name === 'avalanche') {
    return new AvalancheEventScanner({
      id: `avalanche:${profile.deployment.chainId}:${profile.deployment.avalancheWarpSourceContract}`,
      chainID: `eip155:${profile.deployment.chainId}`,
      rpc: profile.rpc,
      address: profile.deployment.avalancheWarpSourceContract,
      startBlock: scannerStartBlock('avalanche'),
    });
  }
  return new EthereumEventScanner({
    id: `${profile.name}:${profile.deployment.chainId}:${profile.deployment.evmSourceContract}`,
    chainID: `eip155:${profile.deployment.chainId}`,
    rpc: profile.rpc,
    address: profile.deployment.evmSourceContract,
    startBlock: scannerStartBlock(profile.name),
  });
}

module.exports = { createScanner };
