async function checkFabricFinality({ event }) {
  return {
    ready: true,
    finalizedHeight: Number(event.blockHeight),
    finalizedHash: event.blockHash || null,
    source: 'fabric-deterministic-commit',
  };
}

module.exports = { checkFabricFinality };
