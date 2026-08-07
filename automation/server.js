const express = require('express');
const path = require('path');
const { loadDotEnv } = require('../shared/env');
const { AutomationStore } = require('./shared/store/automation-store');
const { retryDelay } = require('./shared/core/retry-policy');
const { MultiChainListenerService, materialKeysForEvent, scheduleEvent } = require('./shared/listener-service');
const { RelayerService } = require('./relayer/relayer-service');
const { WatcherService } = require('./watcher/watcher-service');
const { sourceProfiles } = require('./config');
const { handleResponse, handleCheckpoint } = require('./handlers');

loadDotEnv();

const port = Number(process.env.AUTOMATION_PORT || 9200);
const pollMs = Number(process.env.AUTOMATION_POLL_MS || 500);
const leaseMs = Number(process.env.AUTOMATION_LEASE_MS || 180_000);
const storeFile = process.env.AUTOMATION_STORE_FILE
  || path.join(__dirname, '..', 'runtime', 'automation-tasks.json');
const roleMode = String(process.env.AUTOMATION_ROLE || 'all').toLowerCase();
const store = new AutomationStore(storeFile);
const relayer = new RelayerService({ store });
const watcher = new WatcherService({ store });
let listener = null;
let stopping = false;

const RELAYER_ROLES = ['relayer-prepare', 'relayer-finality', 'relayer-proof', 'relayer-tee', 'relayer-submit', 'relayer-batch'];
const WATCHER_ROLES = ['watcher-register', 'watch'];

function enabledRoles() {
  if (roleMode === 'relayer') return [...RELAYER_ROLES, 'response'];
  if (roleMode === 'watcher') return [...WATCHER_ROLES, 'checkpoint'];
  return [...RELAYER_ROLES, ...WATCHER_ROLES, 'response', 'checkpoint'];
}

async function dispatch(task) {
  if (RELAYER_ROLES.includes(task.role)) return relayer.handle(task);
  if (WATCHER_ROLES.includes(task.role)) return watcher.handle(task);
  if (task.role === 'response') {
    const result = await handleResponse(task.payload);
    const workflow = store.getWorkflow(task.workflowID);
    if (workflow?.relayerState === 'WAITING_RESPONSE') {
      await relayer.transition(task.workflowID, 'COMPLETED', {
        responseResult: result,
        completedAt: Date.now(),
      });
    }
    const pendingWatch = store.list({ role: 'watch', workflowID: task.workflowID })
      .find((candidate) => candidate.status === 'pending');
    if (pendingWatch) await store.reschedule(pendingWatch.id, 0, pendingWatch.result);
    return { complete: true, result };
  }
  if (task.role === 'checkpoint') return { complete: true, result: await handleCheckpoint(task.payload) };
  throw new Error(`unsupported automation role: ${task.role}`);
}

async function worker(role) {
  while (!stopping) {
    const task = await store.claim(role, leaseMs);
    if (!task) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    try {
      const outcome = await dispatch(task);
      if (outcome.rescheduleMs !== undefined) {
        await store.reschedule(task.id, Number(outcome.rescheduleMs), outcome.result);
      } else {
        await store.complete(task.id, outcome.result, outcome.nextTasks || []);
      }
    } catch (error) {
      console.error(`[automation:${role}] ${task.id}:`, error.message);
      await store.retry(task.id, error, retryDelay(task.attempts));
    }
  }
}

function requireAPIKey(req, res, next) {
  const expected = process.env.AUTOMATION_API_KEY;
  if (!expected) return next();
  const supplied = req.get('authorization');
  if (supplied !== `Bearer ${expected}`) return res.status(401).json({ error: 'unauthorized' });
  return next();
}

async function main() {
  await store.open();
  const profiles = sourceProfiles();
  if (profiles.length) {
    listener = new MultiChainListenerService({
      store,
      profiles,
      pollMs: Number(process.env.AUTOMATION_SCAN_POLL_MS || 3000),
    });
    await listener.start();
  }

  const app = express();
  app.use(express.json({ limit: process.env.AUTOMATION_HTTP_JSON_LIMIT || '20mb' }));
  app.use('/v1', requireAPIKey);

  app.get('/health', (_req, res) => {
    const tasks = store.list();
    res.json({
      ok: true,
      roleMode,
      enabledChains: profiles.map((profile) => profile.name),
      taskCount: tasks.length,
      pending: tasks.filter((task) => task.status === 'pending').length,
      deadLetter: tasks.filter((task) => task.status === 'dead-letter').length,
      cursorCount: store.listCursors().length,
    });
  });
  app.get('/v1/tasks', (req, res) => res.json(store.list({
    role: req.query.role,
    status: req.query.status,
    workflowID: req.query.workflowID,
  })));
  app.get('/v1/tasks/:id', (req, res) => {
    const task = store.get(req.params.id);
    return task ? res.json(task) : res.status(404).json({ error: 'task not found' });
  });
  app.get('/v1/events', (req, res) => res.json(store.listEvents({
    scannerID: req.query.scannerID,
    requestID: req.query.requestID,
  })));
  app.get('/v1/cursors', (_req, res) => res.json(store.listCursors()));
  app.get('/v1/workflows', (_req, res) => res.json(store.listWorkflows()));
  app.get('/v1/workflows/:id', (req, res) => {
    const workflow = store.getWorkflow(req.params.id);
    return workflow ? res.json(workflow) : res.status(404).json({ error: 'workflow not found' });
  });
  app.post('/v1/workflows/:id/cancel', async (req, res, next) => {
    try {
      const taskIDs = await store.cancelWorkflow(req.params.id, req.body?.reason || 'cancelled by operator');
      await store.updateWorkflow(req.params.id, { relayerState: 'FAILED', terminalReason: req.body?.reason || 'cancelled by operator' });
      res.json({ workflowID: req.params.id, cancelledTaskIDs: taskIDs });
    } catch (error) { next(error); }
  });
  app.put('/v1/materials/:key', async (req, res, next) => {
    try {
      const material = await store.putMaterial(req.params.key, req.body);
      const matchingEvents = store.listEvents().filter((event) => (
        event.canonical !== false && materialKeysForEvent(event).includes(req.params.key)
      ));
      const scheduled = [];
      for (const event of matchingEvents) {
        const profile = profiles.find((candidate) => candidate.name === event.sourceProfile)
          || profiles.find((candidate) => event.scannerID?.startsWith(`${candidate.name}:`));
        if (profile) scheduled.push(...await scheduleEvent(store, profile, event));
      }
      res.status(201).json({ ...material, scheduledTaskIDs: scheduled.map((task) => task.id) });
    } catch (error) { next(error); }
  });
  app.get('/v1/materials/:key', (req, res) => {
    const material = store.getMaterial(req.params.key);
    return material
      ? res.json({ key: req.params.key, material })
      : res.status(404).json({ error: 'material not found' });
  });
  for (const role of ['response', 'checkpoint', 'watch']) {
    app.post(`/v1/jobs/${role}`, async (req, res, next) => {
      try {
        const requestID = req.body?.requestID || req.body?.response?.originRequestID;
        const task = await store.enqueue(role, req.body, {
          workflowID: requestID,
          idempotencyKey: req.get('idempotency-key') || `${role}:${requestID || JSON.stringify(req.body)}`,
          maxAttempts: req.body?.maxAttempts,
        });
        res.status(202).json(task);
      } catch (error) { next(error); }
    });
  }
  app.use((error, _req, res, _next) => res.status(400).json({ error: error.message }));

  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`HXMsg automation listening on ${port} role=${roleMode} chains=${profiles.map((p) => p.name).join(',') || 'none'}`);
  });
  for (const role of enabledRoles()) worker(role).catch((error) => console.error(error));
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    if (listener) await listener.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
