const { chainProfile } = require('../config');
const { queryLifecycle, startChallenge, compensate } = require('./chain-client');
const { WatcherState, assertTransition } = require('../shared/core/state-machines');

class WatcherService {
  constructor({ store }) {
    this.store = store;
  }

  async transition(workflowID, to, patch = {}) {
    const workflow = this.store.getWorkflow(workflowID);
    if (workflow?.watcherState) assertTransition('watcher', workflow.watcherState, to);
    return this.store.updateWorkflow(workflowID, { ...patch, watcherState: to });
  }

  async handle(task) {
    if (task.role === 'watcher-register') return this.register(task);
    const payload = task.payload;
    const workflowID = task.workflowID || payload.requestID;
    const profile = chainProfile(payload.sourceProfile);
    const record = await queryLifecycle(payload.sourceProfile, payload.requestID, payload);
    if (!record) {
      await this.store.updateWorkflow(workflowID, { watcherState: WatcherState.CANCELLED, watcherReason: 'request missing' });
      return { complete: true, result: { terminal: true, status: 'missing' } };
    }
    const status = profile.kind === 'fabric' ? record.status : Number(record.status);
    const completed = profile.kind === 'fabric'
      ? ['Completed', 'Failed', 'Cancelled'].includes(status)
      : [3, 5, 6].includes(status);
    const compensated = profile.kind === 'fabric' ? status === 'Compensated' : status === 4;
    if (completed || compensated) {
      const terminalState = compensated ? WatcherState.COMPENSATED : WatcherState.COMPLETED;
      const current = this.store.getWorkflow(workflowID);
      if (!current?.watcherState) {
        await this.store.updateWorkflow(workflowID, { watcherState: terminalState, watcherCompletedAt: Date.now() });
      } else {
        await this.transition(workflowID, terminalState, { watcherCompletedAt: Date.now() });
      }
      return { complete: true, result: { terminal: true, status } };
    }
    const now = Math.floor(Date.now() / 1000);
    const pending = profile.kind === 'fabric' ? status === 'Pending' : status === 1;
    const challenged = profile.kind === 'fabric' ? status === 'Challenged' : status === 2;
    let workflow = this.store.getWorkflow(workflowID);
    if (!workflow?.watcherState) {
      workflow = await this.store.updateWorkflow(workflowID, {
        watcherState: pending ? WatcherState.WATCHING_PENDING : WatcherState.WATCHING_CHALLENGE,
        watcherStartedAt: Date.now(),
      });
    }
    if (pending && Number(record.challengeWindow) > 0 && now > Number(record.feedbackTimeout)) {
      await this.transition(workflowID, WatcherState.CHALLENGE_SUBMITTING);
      const result = await startChallenge(payload.sourceProfile, payload.requestID, payload);
      await this.transition(workflowID, WatcherState.WATCHING_CHALLENGE, {
        challengeResult: result,
        challengedAt: Date.now(),
      });
      return { rescheduleMs: 1000, result: { terminal: false, action: 'challenge-started', ...result } };
    }
    if (challenged && now > Number(record.challengeDeadline)) {
      await this.transition(workflowID, WatcherState.COMPENSATION_SUBMITTING);
      const result = await compensate(payload.sourceProfile, payload.requestID, payload.failureData, payload);
      await this.transition(workflowID, WatcherState.COMPENSATED, {
        compensationResult: result,
        watcherCompletedAt: Date.now(),
      });
      return { complete: true, result: { terminal: true, action: 'compensated', ...result } };
    }
    const nextDeadline = pending ? Number(record.feedbackTimeout) : Number(record.challengeDeadline);
    return {
      rescheduleMs: Math.max(1000, (nextDeadline - now) * 1000),
      result: { terminal: false, status },
    };
  }

  async register(task) {
    const event = this.store.getEvent(task.payload.eventID);
    if (!event || event.canonical === false) {
      return { complete: true, result: { registered: false, reason: 'source event unavailable' } };
    }
    const material = this.store.getMaterial(event.requestID)
      || this.store.getMaterial(event.payload?.callDataHash)
      || {};
    const feedback = event.payload?.feedback || material.feedback || {};
    const atomicity = event.payload?.atomicity || material.atomicity || {};
    if (!Object.keys(material).length) {
      return { rescheduleMs: Number(process.env.AUTOMATION_MATERIAL_POLL_MS || 2000), result: { registered: false, reason: 'waiting-material' } };
    }
    const required = Boolean(feedback.required || event.payload?.feedbackRequired);
    const challengeWindow = Number(atomicity.challengeWindow || material.challengeWindow || 0);
    if (!required || challengeWindow <= 0) {
      return { complete: true, result: { registered: false, reason: 'watch-not-required' } };
    }
    return {
      complete: true,
      result: { registered: true },
      nextTasks: [{
        role: 'watch',
        payload: {
          ...task.payload,
          failureData: material.failureData,
        },
        options: {
          workflowID: task.workflowID,
          idempotencyKey: `watch:${task.workflowID}`,
          maxAttempts: Number(process.env.AUTOMATION_WATCH_MAX_ATTEMPTS || 1000000),
        },
      }],
    };
  }
}

module.exports = { WatcherService };
