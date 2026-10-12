'use strict';
const { summarizeAccounting } = require('./accounting');

const EXITS = { OK: 0, PROPOSED: 0, INVALID_INPUT: 2, INVALID_CONFIG: 2, INCOMPATIBLE: 2,
  BINDING_CHANGED: 2, AUTH_ROUTE_UNVERIFIED: 2, SUBSCRIPTION_REQUIRED: 2, AUTOMATIC_UNSUPPORTED: 2,
  CONFLICT: 3, BUSY: 3, PROCESS_FAILED: 1, BLOCKED: 1, PROVIDER_PAUSED: 1, SWITCH_BUDGET_EXHAUSTED: 1,
  CAPSULE_UNAVAILABLE: 4, WORKSPACE_CHANGED: 4, EXHAUSTED: 1, PERSISTENCE_FAILED: 4, RECOVERY_REQUIRED: 4, STORAGE_CAPACITY: 4 };
function exitCode(result) { return EXITS[result.code?.replace(/^ECC_ALLOCATION_/, '')] ?? 4; }
function actions(revision) {
  if (!revision) return ['inspect'];
  const { taskState: state } = revision;
  if (state === 'recovery-required') return ['inspect', 'recover'];
  if (state === 'successor-reserved') {
    const kind = revision.successorKind || revision.transitions?.find(transition => !transition.claimed)?.kind;
    return ['inspect', kind === 'provider' ? 'resume' : 'next'];
  }
  if (['asserted-success', 'exhausted', 'abandoned'].includes(state)) return ['inspect', 'new-revision'];
  if (state === 'active') return ['inspect', 'progress'];
  const choices = ['inspect'];
  if (['awaiting-checkpoint', 'awaiting-verification', 'blocked'].includes(state)) choices.push('checkpoint');
  const continuation = revision.policy?.continuation.enabled ?? (revision.journalVersion !== null);
  if (continuation && revision.route?.allocationId && revision.currentAttemptId) choices.push('switch');
  if (['awaiting-checkpoint', 'awaiting-verification'].includes(state) && continuation) choices.push('progress');
  choices.push('abandon');
  return choices;
}
function operationSummary(operation) {
  return { operationId: operation.operationId, attemptId: operation.attemptId, phase: operation.phase,
    providerId: operation.providerId, tierId: operation.tierId, allocationId: operation.allocationId,
    state: operation.state, result: operation.result ?? null, requested: operation.requested,
    observed: operation.observed ?? { backendId: null, modelId: null, effort: null, nativeContextTokens: null,
      childUsageTokens: null, source: 'unavailable' }, metrics: operation.metrics || [] };
}
function resultFor({ operation, input, revision = null, receipt = null, route = null, execution = null,
  code = 'ECC_ALLOCATION_OK', status = 'recorded', replayed = false, operationId = null }) {
  const state = receipt?.taskState ?? revision?.taskState ?? null;
  const transition = state === 'successor-reserved' ? revision?.transitions?.find(value => value.transitionId ===
    (receipt?.transitionId || revision.successorId)) || revision?.transitions?.find(value => !value.claimed) : null;
  const savedAttempt = replayed && receipt?.attemptId ? revision?.attempts?.find(value => value.attemptId === receipt.attemptId) : null;
  const operations = (revision?.operations || []).filter(value => !savedAttempt ||
    revision.attempts.find(attempt => attempt.attemptId === value.attemptId)?.ordinal <= savedAttempt.ordinal).slice(-64).map(operationSummary);
  const last = operations.at(-1);
  let selectedRoute = route || revision?.route || { source: null, reasonCode: null, classifierReasonCode: null,
    tierId: null, allocationId: null, eligibleTierIds: [], eligibleAllocationIds: [], classifierStatus: 'not-needed', policyDigest: null, runtimeSetDigest: null };
  if (transition) selectedRoute = { ...selectedRoute, source: transition.kind === 'provider' ? 'provider-switch' : 'persisted',
    reasonCode: transition.kind === 'provider' ? `${transition.reason}-switch` : 'saved-successor',
    tierId: transition.tierId, allocationId: transition.allocationId };
  else if (savedAttempt) selectedRoute = { ...selectedRoute, source: 'persisted', reasonCode: 'saved-successor',
    tierId: savedAttempt.tierId, allocationId: savedAttempt.allocationId };
  return { schemaVersion: 'ecc.allocation-result.v2', success: exitCode({ code }) === 0,
    operation: ['run', 'progress', 'checkpoint', 'next', 'switch', 'resume', 'status', 'recover'].includes(operation) ? operation : null,
    status, code, replayed, identity: revision?.identity || input?.identity || (input?.task ?
      Object.fromEntries(['sessionId', 'taskId', 'revision', 'phase'].map(key => [key, input.task[key]])) : null),
    requestId: input?.requestId ?? null, progressId: input?.progressId ?? null, checkpointId: input?.checkpointId ?? null,
    switchId: input?.switchId ?? null, recoveryId: input?.recoveryId ?? null, transitionId: receipt?.transitionId ?? transition?.transitionId ?? null,
    operationId: operationId || receipt?.operationId || last?.operationId || null,
    attemptId: transition?.successorAttemptId ?? receipt?.attemptId ?? revision?.currentAttemptId ?? null, frontier: receipt?.frontier ?? revision?.frontier ?? null,
    journalVersion: receipt?.journalVersion ?? revision?.journalVersion ?? null, taskState: receipt?.taskState ?? revision?.taskState ?? null,
    route: selectedRoute, execution: execution || operations.find(value => value.operationId === receipt?.operationId)?.result || last?.result || null, operations,
    availability: (revision?.availability || []).map(({ providerId, runtimeDigest, reason, observedAt, resetAt, holdoffUntil }) =>
      ({ providerId, runtimeDigest, reason, observedAt, resetAt, holdoffUntil })),
    accounting: summarizeAccounting({ operations }), nextActions: status === 'proposed' ? [] : actions(revision) };
}

module.exports = { exitCode, actions, resultFor, operationSummary };
