const { createScanner } = require('./adapters');

function relayTaskForEvent(profile, event) {
  if (!['CROSS_CHAIN_REQUEST', 'AVALANCHE_WARP_REQUEST', 'XCALL', 'ASSET_LOCKED_XCALL'].includes(event.eventType)) return [];
  return [{
    role: 'relayer-prepare',
    payload: {
      workflowID: event.requestID,
      requestID: event.requestID,
      eventID: event.eventID,
      sourceProfile: profile.name,
    },
    options: {
      workflowID: event.requestID,
      idempotencyKey: `relayer-prepare:${event.eventID}`,
      maxAttempts: Number(process.env.AUTOMATION_RELAYER_MAX_ATTEMPTS || 120),
    },
  }, {
    role: 'watcher-register',
    payload: {
      workflowID: event.requestID,
      requestID: event.requestID,
      eventID: event.eventID,
      sourceProfile: profile.name,
      useWarpSource: profile.name === 'avalanche',
    },
    options: {
      workflowID: event.requestID,
      idempotencyKey: `watcher-register:${event.eventID}`,
      maxAttempts: Number(process.env.AUTOMATION_WATCH_MAX_ATTEMPTS || 1000000),
    },
  }];
}

function materialKeysForEvent(event) {
  return [event.requestID, event.callDataHash, event.payload?.callDataHash]
    .filter(Boolean)
    .map(String);
}

function hasSourceMaterial(store, event) {
  return materialKeysForEvent(event).some((key) => store.getMaterial(key));
}

async function scheduleEvent(store, profile, event) {
  if (!event?.canonical || !hasSourceMaterial(store, event)) return [];
  const tasks = [];
  for (const spec of relayTaskForEvent(profile, event)) {
    tasks.push(await store.enqueue(spec.role, spec.payload, spec.options));
  }
  return tasks;
}

class MultiChainListenerService {
  constructor({ store, profiles, pollMs = 3000 }) {
    this.store = store;
    this.pollMs = Number(pollMs);
    this.entries = profiles.map((profile) => ({ profile, scanner: createScanner(profile), timer: null, connected: false }));
    this.stopping = false;
  }

  async ingest(profile, scanner, events, cursor) {
    return this.store.ingest({
      scannerID: scanner.id,
      cursor,
      events,
      taskFactory: (event) => hasSourceMaterial(this.store, event)
        ? relayTaskForEvent(profile, event)
        : [],
    });
  }

  async poll(entry) {
    if (this.stopping) return;
    try {
      const cursor = this.store.getCursor(entry.scanner.id);
      const result = await entry.scanner.scan(cursor);
      await this.ingest(entry.profile, entry.scanner, result.events, result.cursor);
    } catch (error) {
      console.error(`[automation:scanner:${entry.profile.name}]`, error.message);
    } finally {
      if (!this.stopping) entry.timer = setTimeout(() => this.poll(entry), this.pollMs);
    }
  }

  async start() {
    for (const entry of this.entries) {
      if (typeof entry.scanner.scan === 'function') {
        this.poll(entry);
      } else {
        this.connectEventScanner(entry);
      }
    }
  }

  async connectEventScanner(entry) {
    if (this.stopping || entry.connected) return;
    try {
      const cursor = this.store.getCursor(entry.scanner.id);
      await entry.scanner.start(cursor, async (event, nextCursor) => {
        await this.ingest(entry.profile, entry.scanner, [event], nextCursor);
      });
      entry.connected = true;
      console.log(`[automation:scanner:${entry.profile.name}] listener connected`);
    } catch (error) {
      console.error(`[automation:scanner:${entry.profile.name}] connect failed:`, error.message);
      if (typeof entry.scanner.stop === 'function') await entry.scanner.stop().catch(() => {});
      if (!this.stopping) entry.timer = setTimeout(() => this.connectEventScanner(entry), this.pollMs);
    }
  }

  async stop() {
    this.stopping = true;
    for (const entry of this.entries) {
      if (entry.timer) clearTimeout(entry.timer);
      if (typeof entry.scanner.stop === 'function') await entry.scanner.stop();
    }
  }
}

module.exports = {
  MultiChainListenerService,
  relayTaskForEvent,
  materialKeysForEvent,
  hasSourceMaterial,
  scheduleEvent,
};
