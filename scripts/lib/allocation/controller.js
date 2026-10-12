'use strict';
const crypto = require('node:crypto');
const path = require('node:path');
const { normalizePolicy, normalizeOperationInput, canonicalDigest } = require('./validation');
const { fail } = require('./errors');
const { evaluateInitialRoute } = require('./policy');
const { prepareBindings, prepareSaved } = require('./controller-preflight');
const { resultFor } = require('./controller-results');
const execution = require('./controller-execution');
const { mutate } = require('./controller-mutations');

function defaults(overrides) {
  return { ...require('./runtime'), ...require('./provider-process'), ...require('./context'),
    ...require('./journal'), ...require('./workspace'), ...require('../state-store'),
    clock: () => new Date(), idFactory: prefix => `${prefix}:${crypto.randomUUID()}`, ...overrides };
}
function identityOf(input) {
  return input.identity || Object.fromEntries(['sessionId', 'taskId', 'revision', 'phase'].map(key => [key, input.task[key]]));
}
function requestId(input) { return input.requestId || input.progressId || input.checkpointId || input.switchId || input.recoveryId; }
function snapshot(context) { return context.store.getRevision(context.identity, { private: true }); }
function stateCode(state) {
  return `ECC_ALLOCATION_${({ blocked: 'PROCESS_FAILED', 'provider-paused': 'PROVIDER_PAUSED',
    'recovery-required': 'RECOVERY_REQUIRED', exhausted: 'EXHAUSTED' })[state] || 'OK'}`;
}
function safeCode(error) {
  return error.code?.startsWith('ECC_ALLOCATION_') ? error.code : error.code === 'STATE_STORE_BUSY' ? 'ECC_ALLOCATION_BUSY' : 'ECC_ALLOCATION_PERSISTENCE_FAILED';
}
function makeContext({ store, input, policy, dbPath, dependencies, identity }) {
  const now = () => {
    const value = dependencies.clock(); return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  };
  return { store, input, policy, dbPath, dependencies, identity, now, id: dependencies.idFactory,
    ownerId: dependencies.idFactory('owner'), task: input.task || input.originalTask || null,
    lastExecution: null, lastOperationId: null, recordingIncomplete: false, continuation: false,
    manifest: null, parentAttemptId: null, handoffSummary: input.handoffSummary ?? null, automaticRequestIds: [] };
}
async function initial(context, payloadDigest) {
  const { binding, previews } = await prepareBindings({ input: context.input, policy: context.policy,
    dbPath: context.dbPath, dryRun: false, dependencies: context.dependencies });
  context.previews = previews;
  const chosen = evaluateInitialRoute({ policy: context.policy, requirements: context.input.requirements,
    availability: execution.scopedAvailability(context.policy, context.store.getAvailability()), now: context.now() });
  const route = chosen.pendingClassifier ? null : { ...chosen.route, runtimeSetDigest: binding.runtimeSetDigest };
  const capsule = context.dependencies.buildTaskCapsule({ enabled: context.policy.continuation.enabled,
    task: context.task, requirementsDigest: binding.requirementsDigest, policyDigest: binding.policyDigest,
    contextSetDigest: binding.contextSetDigest, runtimeSetDigest: binding.runtimeSetDigest });
  context.store.claimInitial({ requestId: context.input.requestId, payloadDigest, identity: context.identity,
    ownerId: context.ownerId, now: context.now(), policy: context.policy, binding, route, attemptId: context.id('attempt'), capsule,
    previousClosureAcknowledgement: context.input.previousClosureAcknowledgement,
    automaticContinuationAcknowledgement: context.input.automaticContinuationAcknowledgement });
  if (chosen.pendingClassifier) await execution.chooseRoute(context, { ...chosen.route, runtimeSetDigest: binding.runtimeSetDigest }, chosen.pendingClassifier);
}
async function saved(context, operation, payloadDigest) {
  const revision = snapshot(context);
  if (operation === 'resume') {
    const material = context.store.getContinuationMaterial(context.identity);
    context.task = material.capsule.originalTask; context.manifest = material.workspaceManifest;
    context.continuation = true; context.parentAttemptId = context.input.parentAttemptId;
  }
  await prepareSaved({ revision, task: context.task, policy: context.policy, dbPath: context.dbPath, dependencies: context.dependencies });
  if (context.manifest) context.dependencies.assertWorkspaceManifest({ repoRoot: revision.binding.repoRoot, manifest: context.manifest });
  const { schemaVersion: _schema, ...fields } = context.input;
  if (operation === 'next') {
    const { originalTask, handoffSummary: _summary, ...next } = fields;
    context.store.claimNext({ ...next, payloadDigest, taskDigest: canonicalDigest(originalTask), ownerId: context.ownerId, now: context.now() });
    context.parentAttemptId = context.input.parentAttemptId;
    if (context.policy.continuation.enabled) {
      // Capability retries also carry accepted progress. Capture the safely stopped
      // workspace at the explicit acknowledgement boundary without changing notes.
      context.manifest = context.dependencies.captureWorkspaceManifest({ repoRoot: revision.binding.repoRoot });
      context.continuation = true;
    }
  } else context.store.claimResume({ ...fields, payloadDigest, ownerId: context.ownerId, now: context.now() });
}
async function launch(context, operation, payloadDigest) {
  if (operation === 'run') await initial(context, payloadDigest);
  else await saved(context, operation, payloadDigest);
  for (let index = 0; index <= context.policy.continuation.maxSwitches; index++) {
    let revision = snapshot(context);
    if (['deciding', 'active'].includes(revision.taskState) && revision.route?.allocationId) await execution.executeTask(context);
    if (!await execution.continueAutomatic(context)) break;
    if (index === context.policy.continuation.maxSwitches) fail('SWITCH_BUDGET_EXHAUSTED', 'Provider continuation budget is exhausted', 1);
  }
}
function finish(context, code) {
  const revision = snapshot(context);
  const ids = [context.input.requestId, ...context.automaticRequestIds];
  for (const receiptId of ids) {
    context.store.finishRequest({ receiptId, identity: context.identity, ownerId: context.ownerId,
      expectedFrontier: revision.frontier, outcomeCode: code, now: context.now() });
  }
  return context.store.getReceipt(context.input.requestId);
}
async function preview({ input, policy, dbPath, dependencies }) {
  const { binding } = await prepareBindings({ input, policy, dbPath, dryRun: true, dependencies });
  const chosen = evaluateInitialRoute({ policy, requirements: input.requirements, availability: [],
    now: new Date(dependencies.clock()).toISOString() });
  return resultFor({ operation: 'run', input, route: { ...chosen.route, runtimeSetDigest: binding.runtimeSetDigest },
    code: 'ECC_ALLOCATION_PROPOSED', status: 'proposed' });
}
async function readStatus({ input, dbPath, dependencies }) {
  const store = await dependencies.openAllocationSnapshot({ dbPath });
  try {
    let identity = input.identity;
    if (!identity) {
      const operation = store.getOperation(input.operationId);
      if (!operation) fail('CONFLICT', 'No matching operation exists', 3);
      identity = operation.identity;
    }
    const revision = store.getRevision(identity);
    return resultFor({ operation: 'status', input: { ...input, identity }, revision, status: 'read', operationId: input.operationId });
  } finally { store.close(); }
}
async function runAllocationOperation(options, overrides = {}) {
  const dependencies = defaults(overrides); let input = null; let store = null; let context = null; let result;
  const operation = options.operation;
  try {
    input = normalizeOperationInput(operation, options.input);
    const needsPolicy = ['run', 'next', 'resume'].includes(operation);
    const policy = needsPolicy ? normalizePolicy(options.policy) : null;
    if (options.dryRun) {
      if (operation !== 'run') fail('INVALID_INPUT', 'Only run supports dry-run');
      return await preview({ input, policy, dbPath: options.dbPath, dependencies });
    }
    if (options.dbPath !== ':memory:' && !path.isAbsolute(options.dbPath || '')) fail('INVALID_INPUT', 'Use an explicit absolute database path');
    if (options.dbPath === ':memory:' && !dependencies.allowInMemory) fail('INVALID_INPUT', 'In-memory databases are test-only');
    if (operation === 'status') return await readStatus({ input, dbPath: options.dbPath, dependencies });
    store = await dependencies.createAllocationStore({ dbPath: options.dbPath });
    const identity = identityOf(input);
    context = makeContext({ store, input, policy, dbPath: options.dbPath, dependencies, identity });
    const payloadDigest = canonicalDigest({ operation, input, ...(policy ? { policyDigest: canonicalDigest(policy) } : {}) });
    const replay = store.getReceipt(requestId(input), payloadDigest);
    if (replay) {
      const revision = snapshot(context);
      const code = replay.finalized === false ? ['active', 'deciding'].includes(revision.taskState)
        ? 'ECC_ALLOCATION_BUSY' : 'ECC_ALLOCATION_RECOVERY_REQUIRED' : replay.outcomeCode;
      return resultFor({ operation, input, revision, receipt: replay, code, replayed: true });
    }
    if (needsPolicy) {
      await launch(context, operation, payloadDigest);
      const revision = snapshot(context); const code = stateCode(revision.taskState);
      const receipt = finish(context, code);
      result = resultFor({ operation, input, revision, receipt, code, execution: context.lastExecution });
    } else {
      const receipt = mutate({ operation, input, store, payloadDigest, now: context.now, id: context.id, dependencies });
      result = resultFor({ operation, input, revision: snapshot(context), receipt, code: receipt.outcomeCode });
    }
  } catch (error) {
    let revision = null;
    if (context) {
      try { revision = snapshot(context); } catch { /* The durable intent remains recoverable when storage returns. */ }
    }
    const code = context?.recordingIncomplete ? 'ECC_ALLOCATION_PERSISTENCE_FAILED' : safeCode(error);
    if (context && revision && ['run', 'next', 'resume'].includes(operation) && !context.recordingIncomplete) {
      try { finish(context, code); } catch { context.recordingIncomplete = Boolean(context.lastOperationId); }
    }
    result = resultFor({ operation, input, revision, execution: context?.lastExecution || null,
      operationId: context?.lastOperationId || null, code: context?.recordingIncomplete ? 'ECC_ALLOCATION_PERSISTENCE_FAILED' : code,
      status: context?.recordingIncomplete ? 'ran-recording-incomplete' : 'rejected' });
  } finally {
    if (store) {
      try { store.close(); } catch {
        if (result) result = { ...result, success: false, code: 'ECC_ALLOCATION_PERSISTENCE_FAILED',
          status: context?.lastOperationId ? 'ran-recording-incomplete' : 'rejected' };
      }
    }
  }
  return result;
}
module.exports = { runAllocationOperation };
