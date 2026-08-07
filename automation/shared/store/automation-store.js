const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function emptyState() {
  return {
    version: 2,
    tasks: {},
    idempotency: {},
    cursors: {},
    events: {},
    materials: {},
    workflows: {},
  };
}

class AutomationStore {
  constructor(file) {
    this.file = path.resolve(file);
    this.state = emptyState();
    this.writeQueue = Promise.resolve();
  }

  async open() {
    await fs.ensureDir(path.dirname(this.file));
    if (await fs.pathExists(this.file)) {
      this.state = { ...emptyState(), ...(await fs.readJson(this.file)), version: 2 };
    }
    this.recoverExpiredLeases();
    await this.flush();
    return this;
  }

  recoverExpiredLeases(now = Date.now()) {
    for (const task of Object.values(this.state.tasks)) {
      if (task.status === 'running' && Number(task.leaseUntil || 0) <= now) {
        task.status = 'pending';
        task.nextRunAt = now;
        task.updatedAt = now;
      }
    }
  }

  buildTask(role, payload, options = {}) {
    const now = Date.now();
    const idempotencyKey = options.idempotencyKey || `${role}:${payload.requestID || crypto.randomUUID()}`;
    const existingID = this.state.idempotency[idempotencyKey];
    if (existingID && this.state.tasks[existingID]) return this.state.tasks[existingID];
    const task = {
      id: crypto.randomUUID(),
      role,
      idempotencyKey,
      workflowID: options.workflowID || payload.workflowID || payload.requestID || null,
      payload,
      status: 'pending',
      attempts: 0,
      maxAttempts: Number(options.maxAttempts || 12),
      nextRunAt: Number(options.nextRunAt || now),
      leaseUntil: 0,
      createdAt: now,
      updatedAt: now,
      result: null,
      lastError: null,
    };
    this.state.tasks[task.id] = task;
    this.state.idempotency[idempotencyKey] = task.id;
    return task;
  }

  async enqueue(role, payload, options = {}) {
    const task = this.buildTask(role, payload, options);
    await this.flush();
    return clone(task);
  }

  async ingest({ scannerID, cursor, events, taskFactory }) {
    const accepted = [];
    const tasks = [];
    if (cursor?.reorgFrom !== undefined && cursor?.reorgFrom !== null) {
      for (const event of Object.values(this.state.events)) {
        if (event.scannerID !== scannerID || Number(event.blockHeight) <= Number(cursor.reorgFrom)) continue;
        event.canonical = false;
        event.orphanedAt = Date.now();
        for (const task of Object.values(this.state.tasks)) {
          if (task.payload?.eventID !== event.eventID || !['pending', 'running'].includes(task.status)) continue;
          task.status = 'cancelled';
          task.leaseUntil = 0;
          task.lastError = 'source event orphaned by chain reorganization';
          task.updatedAt = Date.now();
        }
      }
    }
    for (const event of events || []) {
      if (!event.eventID) throw new Error('scanner eventID is required');
      if (this.state.events[event.eventID]) continue;
      this.state.events[event.eventID] = {
        ...event,
        scannerID,
        canonical: event.canonical !== false,
        observedAt: event.observedAt || Date.now(),
      };
      accepted.push(event);
      for (const spec of taskFactory ? (taskFactory(event) || []) : []) {
        tasks.push(this.buildTask(spec.role, spec.payload, spec.options));
      }
    }
    if (cursor) {
      this.state.cursors[scannerID] = { ...cursor, scannerID, updatedAt: Date.now() };
    }
    await this.flush();
    return { accepted: clone(accepted), tasks: clone(tasks), cursor: clone(this.state.cursors[scannerID]) };
  }

  async claim(role, leaseMs = 60_000) {
    const now = Date.now();
    this.recoverExpiredLeases(now);
    const task = Object.values(this.state.tasks)
      .filter((item) => item.role === role && item.status === 'pending' && Number(item.nextRunAt) <= now)
      .sort((a, b) => Number(a.nextRunAt) - Number(b.nextRunAt) || Number(a.createdAt) - Number(b.createdAt))[0];
    if (!task) return null;
    task.status = 'running';
    task.attempts += 1;
    task.leaseUntil = now + leaseMs;
    task.updatedAt = now;
    await this.flush();
    return clone(task);
  }

  async complete(id, result, nextTasks = []) {
    const task = this.requireTask(id);
    task.status = 'completed';
    task.result = result ?? null;
    task.leaseUntil = 0;
    task.updatedAt = Date.now();
    const created = nextTasks.map((spec) => this.buildTask(spec.role, spec.payload, spec.options));
    await this.flush();
    return clone(created);
  }

  async retry(id, error, delayMs) {
    const task = this.requireTask(id);
    task.lastError = error instanceof Error ? error.message : String(error);
    task.leaseUntil = 0;
    task.updatedAt = Date.now();
    if (task.attempts >= task.maxAttempts) {
      task.status = 'dead-letter';
    } else {
      task.status = 'pending';
      task.nextRunAt = Date.now() + Number(delayMs);
    }
    await this.flush();
  }

  async reschedule(id, delayMs, result = null) {
    const task = this.requireTask(id);
    task.status = 'pending';
    task.nextRunAt = Date.now() + Number(delayMs);
    task.leaseUntil = 0;
    task.result = result;
    task.updatedAt = Date.now();
    task.attempts = Math.max(0, task.attempts - 1);
    await this.flush();
  }

  async cancelByIdempotencyKey(idempotencyKey, reason = 'cancelled') {
    const id = this.state.idempotency[idempotencyKey];
    const task = id ? this.state.tasks[id] : null;
    if (!task || ['completed', 'cancelled'].includes(task.status)) return null;
    task.status = 'cancelled';
    task.leaseUntil = 0;
    task.lastError = reason;
    task.updatedAt = Date.now();
    await this.flush();
    return clone(task);
  }

  async cancelWorkflow(workflowID, reason = 'cancelled') {
    const cancelled = [];
    for (const task of Object.values(this.state.tasks)) {
      if (task.workflowID !== workflowID || !['pending', 'running'].includes(task.status)) continue;
      task.status = 'cancelled';
      task.leaseUntil = 0;
      task.lastError = reason;
      task.updatedAt = Date.now();
      cancelled.push(task.id);
    }
    await this.flush();
    return cancelled;
  }

  async putMaterial(key, material) {
    this.state.materials[key] = { key, material, updatedAt: Date.now() };
    await this.flush();
    return clone(this.state.materials[key]);
  }

  getMaterial(key) {
    return clone(this.state.materials[key]?.material);
  }

  async updateWorkflow(id, patch) {
    const current = this.state.workflows[id] || { id, createdAt: Date.now() };
    this.state.workflows[id] = { ...current, ...patch, id, updatedAt: Date.now() };
    await this.flush();
    return clone(this.state.workflows[id]);
  }

  getCursor(scannerID) { return clone(this.state.cursors[scannerID] || null); }
  getEvent(eventID) { return clone(this.state.events[eventID] || null); }
  getWorkflow(id) { return clone(this.state.workflows[id] || null); }
  get(id) { return clone(this.state.tasks[id] || null); }

  list(filter = {}) {
    return clone(Object.values(this.state.tasks).filter((task) => (
      (!filter.role || task.role === filter.role)
      && (!filter.status || task.status === filter.status)
      && (!filter.workflowID || task.workflowID === filter.workflowID)
    )));
  }

  listEvents(filter = {}) {
    return clone(Object.values(this.state.events).filter((event) => (
      (!filter.scannerID || event.scannerID === filter.scannerID)
      && (!filter.requestID || event.requestID === filter.requestID)
    )));
  }

  listCursors() { return clone(Object.values(this.state.cursors)); }
  listWorkflows() { return clone(Object.values(this.state.workflows)); }

  requireTask(id) {
    const task = this.state.tasks[id];
    if (!task) throw new Error(`task not found: ${id}`);
    return task;
  }

  async flush() {
    this.writeQueue = this.writeQueue.then(async () => {
      const temp = `${this.file}.${process.pid}.tmp`;
      await fs.writeJson(temp, this.state, { spaces: 2 });
      await fs.rename(temp, this.file);
    });
    return this.writeQueue;
  }
}

module.exports = { AutomationStore };
