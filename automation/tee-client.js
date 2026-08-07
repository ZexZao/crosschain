const axios = require('axios');

function retryable(error) {
  const message = error.response?.data?.error || error.message || '';
  return [409, 502, 503].includes(Number(error.response?.status || 0))
    || message.includes('leader')
    || message.includes('current term barrier')
    || message.includes('quorum not reached');
}

async function resolveLeader(urls) {
  const statuses = await Promise.all(urls.map(async (url) => {
    try {
      const response = await axios.get(`${url.replace(/\/$/, '')}/raft/status`, { timeout: 3000 });
      return { url, ...response.data };
    } catch (error) {
      return { url, error: error.message };
    }
  }));
  const leader = statuses.find((status) => status.role === 'leader');
  if (leader) return leader.url;
  const leaderID = statuses.find((status) => status.leaderID)?.leaderID;
  const known = statuses.find((status) => status.nodeID === leaderID && !status.error);
  if (known) return known.url;
  const reachable = statuses.find((status) => !status.error);
  if (reachable) return reachable.url;
  throw new Error(`no reachable TEE node: ${statuses.map((item) => `${item.url}:${item.error}`).join('; ')}`);
}

async function postToTEELeader(urls, route, body, options = {}) {
  let lastError;
  for (let attempt = 1; attempt <= Number(options.attempts || 5); attempt += 1) {
    try {
      const leader = await resolveLeader(urls);
      const response = await axios.post(`${leader.replace(/\/$/, '')}${route}`, body, {
        timeout: Number(options.timeout || 120_000),
      });
      return response.data;
    } catch (error) {
      lastError = error;
      if (!retryable(error) || attempt === Number(options.attempts || 5)) {
        const detail = error.response?.data?.error;
        if (detail && detail !== error.message) {
          const enriched = new Error(`TEE ${route} failed: ${detail}`);
          enriched.cause = error;
          enriched.status = error.response?.status;
          throw enriched;
        }
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 750 * attempt));
    }
  }
  throw lastError;
}

module.exports = { resolveLeader, postToTEELeader };
