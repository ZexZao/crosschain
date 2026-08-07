const fs = require('fs-extra');
const path = require('path');
const { AutomationStore } = require('../automation/shared/store/automation-store');
const { EvmLogScanner } = require('../automation/shared/adapters/evm/scanner-base');
const {
  hasSourceMaterial,
  relayTaskForEvent,
  scheduleEvent,
} = require('../automation/shared/listener-service');

const ROOT = path.join(__dirname, '..');
const tempFile = path.join(ROOT, 'runtime', 'automation-store-test-state.json');
const resultFile = path.join(ROOT, 'runtime', 'automation-store-test-result.json');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  await fs.remove(tempFile);
  const store = await new AutomationStore(tempFile).open();
  const profile = { name: 'ethereum' };
  const event = {
    eventID: 'eip155:31337:0x01:0',
    eventType: 'CROSS_CHAIN_REQUEST',
    requestID: '0xrequest01',
    blockHeight: 10,
    payload: { callDataHash: '0xmaterial01' },
    canonical: true,
  };
  const first = await store.ingest({
    scannerID: 'ethereum:test',
    cursor: { lastScannedBlock: 10 },
    events: [event],
    taskFactory: (item) => hasSourceMaterial(store, item) ? relayTaskForEvent(profile, item) : [],
  });
  assert(first.tasks.length === 0, 'event without material must not create tasks');
  await store.putMaterial('0xmaterial01', { targetProfile: 'fabric', businessPayload: { op: 'benchmark_store' } });
  const scheduled = await scheduleEvent(store, profile, store.getEvent(event.eventID));
  assert(scheduled.length === 2, 'material arrival must schedule relayer and watcher registration');
  const duplicate = await scheduleEvent(store, profile, store.getEvent(event.eventID));
  assert(duplicate.length === 2, 'idempotent scheduling must return existing tasks');
  assert(store.list({ workflowID: event.requestID }).length === 2, 'idempotency keys must prevent duplicate tasks');

  await store.ingest({
    scannerID: 'ethereum:test',
    cursor: { lastScannedBlock: 9, reorgFrom: 9 },
    events: [],
    taskFactory: () => [],
  });
  assert(store.getEvent(event.eventID).canonical === false, 'reorg must orphan events after common ancestor');
  assert(store.list({ workflowID: event.requestID }).every((task) => task.status === 'cancelled'),
    'reorg must cancel pending tasks for orphaned event');
  const scanner = new EvmLogScanner({
    id: 'reset-test',
    chainID: 'eip155:31337',
    provider: {},
    address: '0x0000000000000000000000000000000000000001',
    topic: '0x00',
    parseLog: () => ({}),
  });
  const reset = await scanner.reconcileCursor({ lastScannedBlock: 1000, checkpoints: [] }, 2);
  assert(reset.fromBlock === 0 && reset.reorgFrom === -1,
    'chain reset must discard a cursor above the current tip');

  const result = {
    testType: 'automation-store-ordering-idempotency-reorg',
    testedAt: new Date().toISOString(),
    pass: true,
    checks: {
      eventBeforeMaterial: true,
      idempotentScheduling: true,
      reorgOrphaning: true,
      pendingTaskCancellation: true,
      chainResetRecovery: true,
    },
  };
  await fs.writeJson(resultFile, result, { spaces: 2 });
  await fs.remove(tempFile);
  console.log('FINAL 5/5 passed');
}

main().catch(async (error) => {
  await fs.writeJson(resultFile, {
    testType: 'automation-store-ordering-idempotency-reorg',
    testedAt: new Date().toISOString(),
    pass: false,
    error: error.message,
  }, { spaces: 2 });
  await fs.remove(tempFile);
  console.error(error.stack || error.message);
  process.exit(1);
});
