function retryDelay(attempts, options = {}) {
  const baseMs = Number(options.baseMs || 1000);
  const maxMs = Number(options.maxMs || 300_000);
  return Math.min(maxMs, baseMs * (2 ** Math.min(Number(attempts || 0), 8)));
}

module.exports = { retryDelay };
