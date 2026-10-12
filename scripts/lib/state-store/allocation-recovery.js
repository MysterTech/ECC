'use strict';

const d = require('./allocation-data');

function recordProgress(repository, input) {
  d.keys(input, ['progressId', 'payloadDigest', 'identity', 'attemptId', 'expectedFrontier', 'expectedJournalVersion', 'journal', 'now']);
  const key = d.revisionKey(input.identity);
  const replay = repository.replay(input.progressId, 'progress', key, input.payloadDigest); if (replay) return replay;
  const revision = repository.load(input.identity); repository.checkFrontier(revision, input);
  if (!revision.policy.continuation.enabled) d.fail('CAPSULE_UNAVAILABLE', 4);
  if (revision.currentAttemptId !== input.attemptId || revision.journalVersion !== input.expectedJournalVersion
    || revision.successorId !== null || !['deciding', 'active', 'awaiting-checkpoint', 'awaiting-verification'].includes(revision.taskState)) d.fail();
  const journal = d.normalizeJournal(input.journal); d.timestamp(input.now);
  const capsule = repository.latestCapsule(revision); const journalVersion = revision.journalVersion + 1;
  const nextCapsule = d.capsule({ ...capsule, journalVersion, journal }, revision);
  repository.register(input.progressId, 'progress', key, input.payloadDigest);
  repository.write('capsule', `${key}:${journalVersion}`, nextCapsule, { revision_key: key, journal_version: journalVersion });
  repository.write('progress', input.progressId, { progressId: input.progressId, attemptId: input.attemptId,
    journalVersion, journal, journalDigest: d.canonicalDigest(journal), createdAt: input.now }, { revision_key: key, journal_version: journalVersion });
  const updated = repository.updateFrontier(revision, { journalVersion });
  repository.event('progress', key, input.progressId, { journalVersion, journalDigest: d.canonicalDigest(journal) });
  return repository.saveReceipt(input.progressId, repository.receipt(updated, input.progressId));
}

function recordProviderAvailability(repository, input) {
  d.keys(input, ['availability', 'now']); d.timestamp(input.now);
  const value = input.availability;
  d.keys(value, ['providerId', 'runtimeDigest', 'reason', 'observedAt', 'resetAt', 'holdoffUntil']);
  d.id(value.providerId); d.digest(value.runtimeDigest); d.timestamp(value.observedAt); d.timestamp(value.holdoffUntil);
  if (value.resetAt !== null) d.timestamp(value.resetAt);
  if (value.reason !== 'local-holdoff' || Date.parse(value.holdoffUntil) < Date.parse(value.observedAt)) d.fail('INVALID_INPUT', 2);
  const revisions = repository.list('revision').map(revision => repository.load(revision.identity));
  const revision = revisions.find(item => item.binding.runtimeBindings[value.providerId]
    && item.binding.runtimeBindings[value.providerId].runtimeDigest === value.runtimeDigest);
  if (!revision) d.fail('BINDING_CHANGED', 2);
  const provider = revision.policy.providers.find(item => item.id === value.providerId);
  const key = d.canonicalDigest({ providerId: provider.id, runtimeDigest: value.runtimeDigest, authRouteDigest: provider.authRoute.expectedRouteDigest });
  const previous = repository.read('availability', key);
  const updated = { ...value, holdoffUntil: new Date(Math.max(Date.parse(value.holdoffUntil), previous ? Date.parse(previous.holdoffUntil) : 0)).toISOString() };
  repository.write('availability', key, updated, {}, previous !== null);
  return d.clone(updated);
}

function recoveryEvidence(value) {
  d.keys(value, ['assertedBy', 'timestamp', 'oldOwnerCannotLaunch', 'relevantWorkStopped', 'effectsDisposition', 'references', 'summaryDigest']);
  d.id(value.assertedBy); d.timestamp(value.timestamp);
  if (value.oldOwnerCannotLaunch !== true || value.relevantWorkStopped !== true
    || !['none', 'retained', 'reconciled'].includes(value.effectsDisposition) || !Array.isArray(value.references)
    || value.references.length > 16 || new Set(value.references).size !== value.references.length) d.fail('INVALID_INPUT', 2);
  value.references.forEach(d.id); if (value.summaryDigest !== null) d.digest(value.summaryDigest);
  return d.bounded(value);
}

function validateObservedRecovery(original, observed) {
  if (observed.observationOrigin !== 'recovery-asserted' || observed.cessation !== 'caller-reconciled'
    || observed.quotaObservation !== null) d.fail('INVALID_INPUT', 2);
  if (!original) return;
  for (const field of ['spawnState', 'exitStatus', 'signal', 'category', 'rootCompletion', 'nativeErrorCode']) {
    if (original[field] !== null && observed[field] !== null && original[field] !== observed[field]) d.fail();
  }
}

function effectiveSourceOperation(repository, operation) {
  const recoveries = repository.list('recovery').filter(record => record.operationId === operation.operationId
    && record.action === 'attach-task-completion');
  if (!recoveries.length || !operation.result) return operation;
  return { ...operation, result: { ...operation.result, cessation: 'caller-reconciled' } };
}

function reconcileOperation(repository, input) {
  d.keys(input, ['recoveryId', 'payloadDigest', 'identity', 'operationId', 'expectedFrontier', 'action', 'recoveryEvidence', 'observedCompletion', 'now']);
  const key = d.revisionKey(input.identity);
  const replay = repository.replay(input.recoveryId, 'recover', key, input.payloadDigest); if (replay) return replay;
  const revision = repository.load(input.identity); repository.checkFrontier(revision, input);
  if (d.TERMINAL.has(revision.taskState)) d.fail();
  const evidence = recoveryEvidence(input.recoveryEvidence); d.timestamp(input.now);
  if (!['attach-task-completion', 'abandon'].includes(input.action)) d.fail('INVALID_INPUT', 2);
  const operations = repository.list('operation', key);
  const operation = input.operationId === null ? null : repository.read('operation', input.operationId);
  if (input.operationId !== null && (!operation || !operations.some(value => value.operationId === input.operationId))) d.fail();
  if (input.operationId === null && (input.action !== 'abandon' || operations.some(value => ['reserved', 'launch-initiated', 'execution-unknown'].includes(value.state)))) d.fail();
  let observed = null;
  if (input.action === 'attach-task-completion') {
    if (!operation || operation.phase !== 'task' || operation.attemptId !== revision.currentAttemptId) d.fail();
    if (input.observedCompletion === null) {
      if (!operation.result) d.fail('INVALID_INPUT', 2);
    } else {
      observed = d.normalizeTypedResult(input.observedCompletion);
      validateObservedRecovery(operation.result, observed);
    }
  } else if (input.observedCompletion !== null) d.fail('INVALID_INPUT', 2);
  repository.register(input.recoveryId, 'recover', key, input.payloadDigest);
  repository.write('recovery', input.recoveryId, { recoveryId: input.recoveryId, operationId: input.operationId,
    action: input.action, recoveryEvidence: evidence, observedCompletion: observed, createdAt: input.now }, { revision_key: key });
  let taskState = 'abandoned';
  if (operation) {
    const immutableResult = operation.result || observed;
    const state = immutableResult && immutableResult.spawnState === 'not-started' ? 'not-started' : 'completed';
    repository.write('operation', operation.operationId, { ...operation, state,
      result: immutableResult, observed: operation.observed || (observed ? { backendId: null, modelId: null, effort: null,
        nativeContextTokens: null, childUsageTokens: null, source: 'unavailable' } : null), completedAt: operation.completedAt || input.now }, {}, true);
    if (input.action === 'attach-task-completion') taskState = immutableResult.spawnState === 'started'
      && immutableResult.exitStatus === 0 && immutableResult.signal === null && immutableResult.category === 'none'
      && immutableResult.rootCompletion === 'observed' ? 'awaiting-checkpoint' : 'blocked';
  }
  if (input.action === 'abandon') {
    for (const uncertain of operations.filter(value => ['reserved', 'launch-initiated', 'execution-unknown'].includes(value.state))) {
      repository.write('operation', uncertain.operationId, { ...uncertain, state: uncertain.result && uncertain.result.spawnState === 'not-started'
        ? 'not-started' : 'completed', completedAt: uncertain.completedAt || input.now }, {}, true);
    }
    if (revision.successorId) {
      const transition = repository.read('transition', revision.successorId);
      const successor = repository.read('attempt', transition.successorAttemptId);
      repository.write('attempt', successor.attemptId, { ...successor, state: 'abandoned' }, {}, true);
    }
  }
  const updated = repository.updateFrontier(revision, { frontier: revision.frontier + 1, taskState,
    successorId: null, successorKind: null, closureSafe: true });
  repository.event('recover', key, input.recoveryId, { action: input.action, recoveryEvidence: evidence, operationId: input.operationId });
  return repository.saveReceipt(input.recoveryId, repository.receipt(updated, input.recoveryId, { operationId: input.operationId }));
}

module.exports = { recordProgress, recordProviderAvailability, reconcileOperation, effectiveSourceOperation };
