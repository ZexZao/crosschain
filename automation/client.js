const axios = require('axios');

function automationURL() {
  return String(process.env.AUTOMATION_URL || 'http://127.0.0.1:9200').replace(/\/$/, '');
}

function headers(extra = {}) {
  return process.env.AUTOMATION_API_KEY
    ? { ...extra, authorization: `Bearer ${process.env.AUTOMATION_API_KEY}` }
    : extra;
}

async function publishSourceMaterial(key, material) {
  const response = await axios.put(`${automationURL()}/v1/materials/${key}`, material, {
    headers: headers(),
    timeout: Number(process.env.AUTOMATION_CLIENT_TIMEOUT_MS || 10_000),
  });
  return response.data;
}

async function getMaterial(key) {
  const response = await axios.get(`${automationURL()}/v1/materials/${key}`, {
    headers: headers(),
    timeout: Number(process.env.AUTOMATION_CLIENT_TIMEOUT_MS || 10_000),
  });
  return response.data?.material;
}

async function getWorkflow(requestID) {
  try {
    const response = await axios.get(`${automationURL()}/v1/workflows/${requestID}`, {
      headers: headers(),
      timeout: Number(process.env.AUTOMATION_CLIENT_TIMEOUT_MS || 10_000),
    });
    return response.data;
  } catch (error) {
    const status = Number(error.response?.status || 0);
    if ([404, 502, 503, 504].includes(status)
      || ['ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT'].includes(error.code)) return null;
    throw error;
  }
}

async function waitForWorkflow(requestID, options = {}) {
  const timeoutMs = Number(options.timeoutMs || process.env.AUTOMATION_WORKFLOW_TIMEOUT_MS || 45 * 60 * 1000);
  const pollMs = Number(options.pollMs || 1000);
  const progressIntervalMs = Number(options.progressIntervalMs || 30_000);
  const terminal = new Set(options.terminalStates || ['COMPLETED', 'WAITING_RESPONSE', 'ORPHANED', 'EXPIRED', 'FAILED']);
  const startedAt = process.hrtime.bigint();
  let lastProgressAt = 0;
  while (Number((process.hrtime.bigint() - startedAt) / 1000000n) < timeoutMs) {
    const workflow = await getWorkflow(requestID);
    const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1000000n);
    if (typeof options.onProgress === 'function'
      && (lastProgressAt === 0 || elapsedMs - lastProgressAt >= progressIntervalMs)) {
      await options.onProgress({ requestID, workflow, elapsedMs, timeoutMs });
      lastProgressAt = elapsedMs;
    }
    if (workflow && terminal.has(workflow.relayerState)) return workflow;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`automation workflow timeout: ${requestID}`);
}

module.exports = { publishSourceMaterial, getMaterial, getWorkflow, waitForWorkflow };
