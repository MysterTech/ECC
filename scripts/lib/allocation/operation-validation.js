'use strict';

const v = require('./validation-primitives');
const e = require('./evidence-validation');

const FIELDS = {
  run: ['requestId', 'task', 'requirements', 'repoRoot', 'cwd', 'contexts', 'runtimeBindings', 'previousClosureAcknowledgement', 'automaticContinuationAcknowledgement'],
  progress: ['progressId', 'identity', 'attemptId', 'expectedFrontier', 'expectedJournalVersion', 'journal'],
  checkpoint: ['checkpointId', 'identity', 'attemptId', 'expectedFrontier', 'supersedesCheckpointId', 'kind', 'cause', 'evidence'],
  next: ['requestId', 'identity', 'originalTask', 'attemptId', 'parentAttemptId', 'checkpointId', 'expectedFrontier', 'policyDigest', 'runtimeSetDigest', 'effectAcknowledgement', 'handoffSummary'],
  switch: ['switchId', 'identity', 'attemptId', 'sourceOperationId', 'expectedFrontier', 'expectedJournalVersion', 'destinationAllocationId', 'effectAcknowledgement'],
  resume: ['requestId', 'identity', 'attemptId', 'parentAttemptId', 'transitionId', 'expectedFrontier', 'expectedJournalVersion', 'policyDigest', 'runtimeSetDigest'],
  status: ['identity', 'operationId'],
  recover: ['recoveryId', 'identity', 'operationId', 'expectedFrontier', 'action', 'recoveryEvidence', 'observedCompletion'],
};
const OPTIONAL = ['supersedesCheckpointId', 'handoffSummary', 'previousClosureAcknowledgement'];
function context(raw) {
  if (raw && raw.mode === 'managed') {
    v.object(raw, ['mode', 'stateRoot', 'nativeRoot', 'expectedReceiptDigest']);
    return { mode: 'managed', stateRoot: v.absolute(raw.stateRoot), nativeRoot: v.nullable(raw.nativeRoot, v.absolute), expectedReceiptDigest: v.digest(raw.expectedReceiptDigest) };
  }
  v.object(raw, ['mode', 'profileId', 'selectionMode', 'include', 'exclude']);
  const profileId = v.text(raw.profileId, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(profileId)) v.invalid('Invalid context profile ID.');
  const include = v.array(raw.include, v.id, 0, 8); const exclude = v.array(raw.exclude, v.id, 0, 32);
  if (include.some(id => exclude.includes(id))) v.invalid('Context include and exclude conflict.');
  return { mode: v.enumeration(raw.mode, ['explicit']), profileId, selectionMode: v.enumeration(raw.selectionMode, ['manual', 'auto']), include, exclude };
}
function record(raw, normalize) {
  v.object(raw, Object.keys(raw || {}));
  const keys = Object.keys(raw);
  if (keys.length < 1 || keys.length > 2) v.invalid('Provider record has an invalid size.');
  return Object.fromEntries(keys.sort().map(key => [v.id(key), normalize(raw[key])]));
}
function previousClosure(raw) {
  if (raw === null || raw === undefined) return null;
  v.object(raw, ['revision', 'expectedFrontier', 'effectAcknowledgement']);
  return { revision: v.integer(raw.revision, 1), expectedFrontier: v.integer(raw.expectedFrontier), effectAcknowledgement: e.normalizeEffectAcknowledgement(raw.effectAcknowledgement) };
}
function normalizeRun(raw) {
  const task = e.normalizeTask(raw.task);
  if (v.canonical(Object.keys(raw.contexts || {}).sort()) !== v.canonical(Object.keys(raw.runtimeBindings || {}).sort())) v.invalid('Context and runtime provider keys differ.');
  return { requestId: v.id(raw.requestId), task, requirements: e.normalizeRequirements(raw.requirements, task), repoRoot: v.absolute(raw.repoRoot), cwd: v.absolute(raw.cwd),
    contexts: record(raw.contexts, context), runtimeBindings: record(raw.runtimeBindings, binding => {
      v.object(binding, ['runtimeDigest']); return { runtimeDigest: v.digest(binding.runtimeDigest) };
    }), previousClosureAcknowledgement: previousClosure(raw.previousClosureAcknowledgement),
    automaticContinuationAcknowledgement: e.automaticAcknowledgement(raw.automaticContinuationAcknowledgement) };
}
function normalizeCheckpoint(raw) {
  const kind = v.enumeration(raw.kind, ['verified-success', 'verification-failure', 'unresolved-ambiguity', 'stalled', 'process-failure', 'unverified-completion']);
  const cause = v.enumeration(raw.cause, ['capability', 'environment', 'requirements', 'unknown', 'none']);
  const failed = ['verification-failure', 'unresolved-ambiguity', 'stalled'].includes(kind);
  if (failed === (cause === 'none')) v.invalid('Checkpoint cause conflicts with its kind.');
  return { kind, cause, supersedesCheckpointId: raw.supersedesCheckpointId === undefined ? null : v.nullable(raw.supersedesCheckpointId, v.id), evidence: e.normalizeEvidence(raw.evidence) };
}
function normalizeRecovery(raw) {
  const action = v.enumeration(raw.action, ['attach-task-completion', 'abandon']);
  const observedCompletion = v.nullable(raw.observedCompletion, e.normalizeTypedResult);
  if (action === 'abandon' && observedCompletion !== null) v.invalid('Recovery completion conflicts with its action.');
  if (observedCompletion && (observedCompletion.observationOrigin !== 'recovery-asserted' || observedCompletion.cessation !== 'caller-reconciled')) v.invalid('Recovery completion needs explicit assertion provenance.');
  return { action, recoveryEvidence: e.recoveryEvidence(raw.recoveryEvidence), observedCompletion };
}
function normalizeField(operation, key, raw, identity) {
  if (key.startsWith('expected')) return v.integer(raw[key]);
  if (key.endsWith('Digest')) return v.digest(raw[key]);
  if (key === 'originalTask') {
    const task = e.normalizeTask(raw[key]);
    v.sameIdentity(identity, Object.fromEntries(Object.keys(identity).map(field => [field, task[field]])));
    return task;
  }
  if (key === 'effectAcknowledgement') return e.normalizeEffectAcknowledgement(raw[key]);
  if (key === 'handoffSummary') return raw[key] === undefined ? null : v.nullable(raw[key], value => v.text(value, 4096));
  if (key === 'destinationAllocationId') return v.nullable(raw[key], v.id);
  if (operation === 'recover' && key === 'operationId') {
    if (raw[key] === null && raw.action !== 'abandon') v.invalid('Only abandonment can close a no-operation pause.');
    return v.nullable(raw[key], v.id);
  }
  return v.id(raw[key]);
}
function normalizeOperationInput(operation, raw) {
  const fields = FIELDS[operation];
  if (!fields) v.invalid('Unsupported allocation operation.');
  v.bounded(raw);
  v.object(raw, ['schemaVersion', ...fields], ['schemaVersion', ...fields.filter(key => !OPTIONAL.includes(key))]);
  const schemaVersion = v.enumeration(raw.schemaVersion, [`ecc.allocation-${operation}.v2`]);
  if (operation === 'run') return { schemaVersion, ...normalizeRun(raw) };
  if (operation === 'status') {
    const identity = v.nullable(raw.identity, v.identity); const operationId = v.nullable(raw.operationId, v.id);
    if ((identity === null) === (operationId === null)) v.invalid('Status needs exactly one selector.');
    return { schemaVersion, identity, operationId };
  }
  const result = { schemaVersion, identity: v.identity(raw.identity) };
  for (const key of fields) {
    if (['identity', 'kind', 'cause', 'evidence', 'journal', 'supersedesCheckpointId', 'action', 'recoveryEvidence', 'observedCompletion'].includes(key)) continue;
    result[key] = normalizeField(operation, key, raw, result.identity);
  }
  if (operation === 'progress') result.journal = e.normalizeJournal(raw.journal);
  if (operation === 'checkpoint') return { ...result, ...normalizeCheckpoint(raw) };
  if (operation === 'recover') return { ...result, ...normalizeRecovery(raw) };
  return result;
}

module.exports = { normalizeOperationInput };
