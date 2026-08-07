const { chainProfile, resolveTargetProfile, teeURLs } = require('../config');
const { postToTEELeader } = require('../tee-client');
const { sourceAdapter } = require('./adapter-dispatch');
const { submitTarget, submitTargetBatch } = require('./target-submitter');
const { bindSourceLifecycle, bindFabricResponseLifecycles } = require('./source-lifecycle-binder');
const { RelayerState, assertTransition } = require('../shared/core/state-machines');
const { saveSyncCommitteeState, updateEnvTrustedBlockRoot } = require('../../shared/evm/sync-committee-state');

function monotonicMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

function nextTask(role, payload, workflowID) {
  return {
    role,
    payload: { ...payload, workflowID },
    options: {
      workflowID,
      idempotencyKey: `${role}:${workflowID}`,
      maxAttempts: Number(process.env.AUTOMATION_RELAYER_MAX_ATTEMPTS || 120),
    },
  };
}

class RelayerService {
  constructor({ store }) {
    this.store = store;
  }

  async transition(workflowID, to, patch = {}) {
    const current = this.store.getWorkflow(workflowID);
    if (current?.relayerState) assertTransition('relayer', current.relayerState, to);
    return this.store.updateWorkflow(workflowID, { ...patch, relayerState: to });
  }

  sourceMaterial(event) {
    return this.store.getMaterial(event.requestID)
      || this.store.getMaterial(event.payload?.callDataHash)
      || null;
  }

  async prepare(task) {
    const event = this.store.getEvent(task.payload.eventID);
    if (!event || event.canonical === false) {
      await this.transition(task.workflowID, RelayerState.ORPHANED, { terminalReason: 'source event unavailable' });
      return { complete: true, result: { state: RelayerState.ORPHANED } };
    }
    const material = this.sourceMaterial(event);
    if (!material) {
      const workflow = this.store.getWorkflow(task.workflowID);
      if (!workflow?.relayerState) {
        await this.store.updateWorkflow(task.workflowID, {
          requestID: event.requestID,
          eventID: event.eventID,
          sourceProfile: task.payload.sourceProfile,
          relayerState: RelayerState.WAITING_MATERIAL,
          discoveredAt: Date.now(),
        });
      }
      return { rescheduleMs: Number(process.env.AUTOMATION_MATERIAL_POLL_MS || 2000), result: { state: RelayerState.WAITING_MATERIAL } };
    }
    const expireAt = Number(event.payload?.expireAt || material?.expireAt || 0);
    if (expireAt > 0 && expireAt <= Math.floor(Date.now() / 1000)) {
      await this.transition(task.workflowID, RelayerState.EXPIRED, { terminalReason: 'source request expired' });
      return { complete: true, result: { state: RelayerState.EXPIRED } };
    }
    const targetProfile = resolveTargetProfile(event.payload?.targetChainID, material?.targetProfile);
    const current = this.store.getWorkflow(task.workflowID);
    if (!current?.relayerState) {
      await this.store.updateWorkflow(task.workflowID, {
        requestID: event.requestID,
        eventID: event.eventID,
        sourceProfile: task.payload.sourceProfile,
        targetProfile: targetProfile.name,
        relayerState: RelayerState.DISCOVERED,
        discoveredAt: Date.now(),
      });
    }
    await this.transition(task.workflowID, RelayerState.WAITING_FINALITY, {
      targetProfile: targetProfile.name,
      finalityStartedAt: Date.now(),
    });
    return {
      complete: true,
      result: { state: RelayerState.WAITING_FINALITY },
      nextTasks: [nextTask('relayer-finality', task.payload, task.workflowID)],
    };
  }

  async finality(task) {
    const workflow = this.store.getWorkflow(task.workflowID);
    const event = this.store.getEvent(workflow.eventID);
    const profile = chainProfile(workflow.sourceProfile);
    const result = await sourceAdapter(profile).checkFinality({ profile, event });
    if (!result.ready) {
      if (result.terminal) {
        await this.transition(task.workflowID, result.state === 'ORPHANED' ? RelayerState.ORPHANED : RelayerState.FAILED, {
          terminalReason: result.reason,
        });
        return { complete: true, result };
      }
      return { rescheduleMs: Number(result.pollAfterMs || 3000), result };
    }
    await this.transition(task.workflowID, RelayerState.BUILDING_PROOF, {
      finality: result,
      finalityWaitMs: Math.max(0, Date.now() - Number(workflow.finalityStartedAt || Date.now())),
    });
    return {
      complete: true,
      result,
      nextTasks: [nextTask('relayer-proof', task.payload, task.workflowID)],
    };
  }

  async proof(task) {
    const startedAt = monotonicMs();
    const workflow = this.store.getWorkflow(task.workflowID);
    const event = this.store.getEvent(workflow.eventID);
    const profile = chainProfile(workflow.sourceProfile);
    const targetProfile = chainProfile(workflow.targetProfile);
    const material = this.sourceMaterial(event);
    if (!material) throw new Error(`source material missing for ${event.requestID}`);
    let evidence;
    try {
      evidence = await sourceAdapter(profile).buildEvidence({ profile, targetProfile, event, material });
    } catch (error) {
      if (error.code === 'SOURCE_ORPHANED') {
        await this.transition(task.workflowID, RelayerState.ORPHANED, { terminalReason: error.message });
        return { complete: true, result: { state: RelayerState.ORPHANED, error: error.message } };
      }
      throw error;
    }
    const evidenceKey = `evidence:${task.workflowID}`;
    await this.store.putMaterial(evidenceKey, evidence);
    await this.transition(task.workflowID, RelayerState.TEE_ATTESTING, {
      evidenceKey,
      proofBuildMs: monotonicMs() - startedAt,
    });
    const batchGroupID = material.batchGroupID || material.batch?.groupID || null;
    const batchSize = Number(material.batchSize || material.batch?.size || 0);
    const nextTasks = batchGroupID && batchSize > 1
      ? [{
        role: 'relayer-batch',
        payload: { batchGroupID, batchSize },
        options: {
          workflowID: `batch:${batchGroupID}`,
          idempotencyKey: `relayer-batch:${batchGroupID}`,
          maxAttempts: Number(process.env.AUTOMATION_RELAYER_MAX_ATTEMPTS || 120),
        },
      }]
      : [nextTask('relayer-tee', task.payload, task.workflowID)];
    return {
      complete: true,
      result: { evidenceKey },
      nextTasks,
    };
  }

  batchMembers(batchGroupID) {
    return this.store.listWorkflows().map((workflow) => {
      if (!workflow.evidenceKey) return null;
      const event = this.store.getEvent(workflow.eventID);
      if (!event) return null;
      const material = this.sourceMaterial(event) || {};
      const groupID = material.batchGroupID || material.batch?.groupID;
      if (groupID !== batchGroupID) return null;
      return {
        workflow,
        event,
        material,
        evidence: this.store.getMaterial(workflow.evidenceKey),
        batchIndex: Number(material.batchIndex ?? material.batch?.index ?? Number.MAX_SAFE_INTEGER),
      };
    }).filter(Boolean).sort((a, b) => a.batchIndex - b.batchIndex);
  }

  async batch(task) {
    const startedAt = monotonicMs();
    const expectedSize = Number(task.payload.batchSize);
    const members = this.batchMembers(task.payload.batchGroupID);
    if (members.length < expectedSize || members.some((member) => !member.evidence?.hxmsg)) {
      return {
        rescheduleMs: Number(process.env.AUTOMATION_BATCH_POLL_MS || 500),
        result: { ready: members.length, expected: expectedSize },
      };
    }
    if (members.length !== expectedSize) throw new Error(`automation batch size mismatch: ${members.length}/${expectedSize}`);
    const sourceProfile = members[0].workflow.sourceProfile;
    const targetProfileName = members[0].workflow.targetProfile;
    if (members.some((member) => member.workflow.sourceProfile !== sourceProfile || member.workflow.targetProfile !== targetProfileName)) {
      throw new Error('automation batch mixes source or target profiles');
    }
    const hxmsgs = members.map((member) => member.evidence.hxmsg);
    const attested = await postToTEELeader(
      teeURLs(Number(hxmsgs[0].source.chainType)),
      '/attest-batch',
      {
        hxmsgs,
        helperDataList: members.map((member) => member.evidence.helperData || {}),
      },
      { timeout: Number(process.env.HXMSG_TEE_BATCH_TIMEOUT_MS || 180_000) }
    );
    const certificate = attested.teeBatchCertification;
    if (!certificate?.quorumReached) throw new Error('TEE h-xmsg batch quorum not reached');
    if (Number(attested.batchSize) !== expectedSize) throw new Error('TEE returned unexpected batch size');
    const teeAttestMs = monotonicMs() - startedAt;

    for (let index = 0; index < members.length; index += 1) {
      const member = members[index];
      const certificateKey = `certificate:${member.workflow.id}`;
      await this.store.putMaterial(certificateKey, {
        ...certificate,
        batchID: attested.batchID,
        batchRoot: attested.batchRoot,
        batchSize: expectedSize,
        batchSigningDigest: attested.batchSigningDigest,
        merkleProof: attested.merkleProofs?.[index] || [],
      });
      await this.transition(member.workflow.id, RelayerState.TARGET_SUBMITTING, {
        certificateKey,
        teeAttestMs,
        teeBatch: {
          batchGroupID: task.payload.batchGroupID,
          batchID: attested.batchID,
          batchRoot: attested.batchRoot,
          batchSize: expectedSize,
          batchSigningDigest: attested.batchSigningDigest,
          quorum: `${certificate.reached}/${certificate.threshold}`,
        },
        teeVerification: attested.verificationResults?.[index] || null,
      });
    }

    const targetStartedAt = monotonicMs();
    const sourceProfileConfig = chainProfile(sourceProfile);
    const lifecycleBindings = await bindFabricResponseLifecycles({
      sourceProfile: sourceProfileConfig,
      items: members.map((member) => ({
        hxmsg: member.evidence.hxmsg,
        certificate: this.store.getMaterial(`certificate:${member.workflow.id}`),
      })),
    });
    const lifecycleBindingByRequest = new Map(
      lifecycleBindings.map((binding) => [String(binding.requestID).toLowerCase(), binding])
    );
    const targetProfile = chainProfile(targetProfileName);
    const targetResult = await submitTargetBatch({
      targetProfile,
      items: members.map((member) => ({
        hxmsg: member.evidence.hxmsg,
        execution: member.evidence.execution,
      })),
      batch: {
        certificate,
        batchID: attested.batchID,
        batchRoot: attested.batchRoot,
        batchSigningDigest: attested.batchSigningDigest,
        merkleProofs: attested.merkleProofs || [],
      },
    });
    const targetSubmitMs = monotonicMs() - targetStartedAt;
    for (let index = 0; index < members.length; index += 1) {
      const member = members[index];
      if (member.evidence.syncCommitteeState) {
        saveSyncCommitteeState(member.evidence.syncCommitteeState);
        if (process.env.SEPOLIA_UPDATE_ENV_TRUSTED_ROOT !== 'false') {
          updateEnvTrustedBlockRoot(member.evidence.syncCommitteeState.trustedBlockRoot);
        }
      }
      const feedbackRequired = Boolean(member.evidence.hxmsg.feedback?.required);
      const state = feedbackRequired ? RelayerState.WAITING_RESPONSE : RelayerState.COMPLETED;
      await this.transition(member.workflow.id, state, {
        targetResult: { ...targetResult, batchIndex: index },
        targetSubmitMs,
        sourceLifecycleBinding: lifecycleBindingByRequest.get(
          String(member.evidence.hxmsg.header.requestID).toLowerCase()
        ) || null,
        completedAt: feedbackRequired ? null : Date.now(),
      });
    }
    const batchResult = {
      batchGroupID: task.payload.batchGroupID,
      batchID: attested.batchID,
      batchRoot: attested.batchRoot,
      batchSize: expectedSize,
      quorum: `${certificate.reached}/${certificate.threshold}`,
      teeAttestMs,
      targetSubmitMs,
      targetResult,
    };
    await this.store.putMaterial(`batch-result:${task.payload.batchGroupID}`, batchResult);
    return { complete: true, result: batchResult };
  }

  async tee(task) {
    const startedAt = monotonicMs();
    const workflow = this.store.getWorkflow(task.workflowID);
    const evidence = this.store.getMaterial(workflow.evidenceKey);
    if (!evidence?.hxmsg) throw new Error('relayer evidence is missing');
    const attested = await postToTEELeader(
      teeURLs(Number(evidence.hxmsg.source.chainType)),
      '/attest',
      { hxmsg: evidence.hxmsg, helperData: evidence.helperData || {} },
      { timeout: Number(process.env.HXMSG_TEE_TIMEOUT_MS || 120_000) }
    );
    const certificate = attested.teeClusterCertification;
    if (!certificate?.quorumReached) throw new Error('TEE h-xmsg quorum not reached');
    const certificateKey = `certificate:${task.workflowID}`;
    await this.store.putMaterial(certificateKey, certificate);
    await this.transition(task.workflowID, RelayerState.TARGET_SUBMITTING, {
      certificateKey,
      teeAttestMs: monotonicMs() - startedAt,
      teeVerification: attested.verificationResult,
    });
    return {
      complete: true,
      result: { certificateKey, quorum: `${certificate.reached}/${certificate.threshold}` },
      nextTasks: [nextTask('relayer-submit', task.payload, task.workflowID)],
    };
  }

  async submit(task) {
    const startedAt = monotonicMs();
    const workflow = this.store.getWorkflow(task.workflowID);
    const evidence = this.store.getMaterial(workflow.evidenceKey);
    const certificate = this.store.getMaterial(workflow.certificateKey);
    const targetProfile = chainProfile(workflow.targetProfile);
    const sourceProfile = chainProfile(workflow.sourceProfile);
    const lifecycleBindings = await bindSourceLifecycle({
      sourceProfile,
      hxmsg: evidence.hxmsg,
      certificate,
    });
    const targetResult = await submitTarget({
      targetProfile,
      hxmsg: evidence.hxmsg,
      execution: evidence.execution,
      certificate,
    });
    if (evidence.syncCommitteeState) {
      saveSyncCommitteeState(evidence.syncCommitteeState);
      if (process.env.SEPOLIA_UPDATE_ENV_TRUSTED_ROOT !== 'false') {
        updateEnvTrustedBlockRoot(evidence.syncCommitteeState.trustedBlockRoot);
      }
    }
    const feedbackRequired = Boolean(evidence.hxmsg.feedback?.required);
    const atomicity = evidence.hxmsg.atomicity || {};
    const material = this.sourceMaterial(this.store.getEvent(workflow.eventID)) || {};
    const nextTasks = [];
    if (feedbackRequired && Number(atomicity.challengeWindow || 0) > 0) {
      nextTasks.push({
        role: 'watch',
        payload: {
          workflowID: task.workflowID,
          requestID: task.workflowID,
          sourceProfile: workflow.sourceProfile,
          failureData: material.failureData,
          useWarpSource: workflow.sourceProfile === 'avalanche',
        },
        options: {
          workflowID: task.workflowID,
          idempotencyKey: `watch:${task.workflowID}`,
          maxAttempts: Number(process.env.AUTOMATION_WATCH_MAX_ATTEMPTS || 1000000),
        },
      });
    }
    const state = feedbackRequired ? RelayerState.WAITING_RESPONSE : RelayerState.COMPLETED;
    await this.transition(task.workflowID, state, {
      targetResult,
      sourceLifecycleBinding: lifecycleBindings[0] || null,
      targetSubmitMs: monotonicMs() - startedAt,
      completedAt: feedbackRequired ? null : Date.now(),
    });
    return { complete: true, result: targetResult, nextTasks };
  }

  async handle(task) {
    if (task.role === 'relayer-prepare') return this.prepare(task);
    if (task.role === 'relayer-finality') return this.finality(task);
    if (task.role === 'relayer-proof') return this.proof(task);
    if (task.role === 'relayer-tee') return this.tee(task);
    if (task.role === 'relayer-submit') return this.submit(task);
    if (task.role === 'relayer-batch') return this.batch(task);
    throw new Error(`unsupported relayer task role: ${task.role}`);
  }
}

module.exports = { RelayerService };
