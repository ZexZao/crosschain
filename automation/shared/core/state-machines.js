const RelayerState = Object.freeze({
  DISCOVERED: 'DISCOVERED',
  WAITING_MATERIAL: 'WAITING_MATERIAL',
  WAITING_FINALITY: 'WAITING_FINALITY',
  BUILDING_PROOF: 'BUILDING_PROOF',
  TEE_ATTESTING: 'TEE_ATTESTING',
  TARGET_SUBMITTING: 'TARGET_SUBMITTING',
  WAITING_RESPONSE: 'WAITING_RESPONSE',
  COMPLETED: 'COMPLETED',
  ORPHANED: 'ORPHANED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
});

const WatcherState = Object.freeze({
  WATCHING_PENDING: 'WATCHING_PENDING',
  CHALLENGE_SUBMITTING: 'CHALLENGE_SUBMITTING',
  WATCHING_CHALLENGE: 'WATCHING_CHALLENGE',
  COMPENSATION_SUBMITTING: 'COMPENSATION_SUBMITTING',
  COMPLETED: 'COMPLETED',
  COMPENSATED: 'COMPENSATED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
});

const RELAYER_TRANSITIONS = new Map([
  [RelayerState.DISCOVERED, new Set([RelayerState.WAITING_MATERIAL, RelayerState.WAITING_FINALITY, RelayerState.EXPIRED])],
  [RelayerState.WAITING_MATERIAL, new Set([RelayerState.WAITING_FINALITY, RelayerState.EXPIRED])],
  [RelayerState.WAITING_FINALITY, new Set([RelayerState.BUILDING_PROOF, RelayerState.ORPHANED, RelayerState.EXPIRED])],
  [RelayerState.BUILDING_PROOF, new Set([RelayerState.TEE_ATTESTING, RelayerState.ORPHANED, RelayerState.EXPIRED])],
  [RelayerState.TEE_ATTESTING, new Set([RelayerState.TARGET_SUBMITTING, RelayerState.EXPIRED])],
  [RelayerState.TARGET_SUBMITTING, new Set([RelayerState.COMPLETED, RelayerState.WAITING_RESPONSE, RelayerState.EXPIRED])],
  [RelayerState.WAITING_RESPONSE, new Set([RelayerState.COMPLETED])],
]);

const WATCHER_TRANSITIONS = new Map([
  [WatcherState.WATCHING_PENDING, new Set([WatcherState.CHALLENGE_SUBMITTING, WatcherState.COMPLETED, WatcherState.COMPENSATED, WatcherState.CANCELLED])],
  [WatcherState.CHALLENGE_SUBMITTING, new Set([WatcherState.WATCHING_CHALLENGE, WatcherState.COMPLETED, WatcherState.COMPENSATED])],
  [WatcherState.WATCHING_CHALLENGE, new Set([WatcherState.COMPENSATION_SUBMITTING, WatcherState.COMPLETED, WatcherState.COMPENSATED, WatcherState.CANCELLED])],
  [WatcherState.COMPENSATION_SUBMITTING, new Set([WatcherState.COMPENSATED])],
]);

function assertTransition(machine, from, to) {
  const table = machine === 'watcher' ? WATCHER_TRANSITIONS : RELAYER_TRANSITIONS;
  if (from === to) return;
  if (!table.get(from)?.has(to)) throw new Error(`illegal ${machine} state transition: ${from} -> ${to}`);
}

module.exports = { RelayerState, WatcherState, assertTransition };
