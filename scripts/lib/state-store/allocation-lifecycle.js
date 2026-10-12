'use strict';

const d = require('./allocation-data');
const { evaluateInitialRoute, validateClassifierChoice, compatibleAllocation, selectTierAlternative } = require('../allocation/policy');

function acceptedRoute(repository, revision, route, allowClassifier = false, quotaSource = null) {
  const availability = repository.list('availability').filter(record => revision.binding.runtimeBindings[record.providerId]
    && revision.binding.runtimeBindings[record.providerId].runtimeDigest === record.runtimeDigest);
  if (route === null) {
    const expected = evaluateInitialRoute({ policy: revision.policy, requirements: revision.binding.requirements,
      availability, now: revision.createdAt });
    if (!expected.pendingClassifier || expected.route.tierId !== null) d.fail();
    return null;
  }
  d.keys(route, ['source', 'reasonCode', 'classifierReasonCode', 'tierId', 'allocationId', 'eligibleTierIds',
    'eligibleAllocationIds', 'classifierStatus', 'policyDigest', 'runtimeSetDigest']);
  const expected = evaluateInitialRoute({ policy: revision.policy, requirements: revision.binding.requirements,
    availability, now: revision.createdAt });
  if (!expected.pendingClassifier) {
    for (const key of ['tierId', 'allocationId', 'source', 'reasonCode']) d.assertSame(route[key], expected.route[key]);
  } else {
    if (!allowClassifier) d.fail();
    if (!['classifier', 'fallback'].includes(route.source)) d.fail();
    validateClassifierChoice({ policy: revision.policy, requirements: revision.binding.requirements,
      pendingRoute: expected.route, response: { tierId: route.tierId, reasonCode: route.classifierReasonCode || 'conservative' } });
    if (route.source === 'fallback' && route.tierId !== revision.policy.fallbackTier) d.fail();
  }
  const tier = revision.policy.tiers.find(item => item.id === route.tierId);
  if (!tier || route.allocationId !== null && !tier.allocationIds.includes(route.allocationId)) d.fail('INCOMPATIBLE', 2);
  const allocation = revision.policy.allocations.find(value => value.id === route.allocationId);
  if (allocation && !compatibleAllocation(revision.policy, revision.binding.requirements, allocation)) d.fail('INCOMPATIBLE', 2);
  const sourceException = quotaSource && quotaSource.phase === 'classifier' && quotaSource.result.quotaObservation
    && quotaSource.result.category === 'usage-limit' && route.source === 'fallback' && route.reasonCode === 'classifier-quota'
    && route.tierId === revision.policy.fallbackTier && allocation && allocation.providerId === quotaSource.providerId;
  if (!sourceException && allocation && availability.some(record => record.providerId === allocation.providerId
    && Date.parse(record.holdoffUntil) > Date.parse(revision.createdAt))) d.fail('PROVIDER_PAUSED', 1);
  if (route.allocationId === null && selectTierAlternative({ policy: revision.policy, tierId: route.tierId,
    requirements: revision.binding.requirements, availability, now: revision.createdAt }).allocationId !== null) d.fail();
  d.assertSame(route.eligibleTierIds, expected.route.eligibleTierIds);
  d.assertSame(route.eligibleAllocationIds, expected.route.eligibleAllocationIds);
  if (route.policyDigest !== revision.policyDigest) d.fail();
  if (route.runtimeSetDigest !== null && route.runtimeSetDigest !== revision.binding.runtimeSetDigest) d.fail();
  return d.bounded({ ...route, runtimeSetDigest: revision.binding.runtimeSetDigest });
}

function sessionOwnership(repository, identity, repoRoot, now) {
  const db = repository.db;
  const existing = db.prepare('SELECT adapter_id,harness,repo_root,snapshot FROM sessions WHERE id = ?').get(identity.sessionId);
  if (existing) {
    if (existing.adapter_id !== 'ecc-allocation.v2' || existing.harness !== 'ecc-allocation' || existing.repo_root !== repoRoot
      || JSON.parse(existing.snapshot).schemaVersion !== 'ecc.allocation-session.v2') d.fail();
    return;
  }
  db.prepare('INSERT INTO sessions(id,adapter_id,harness,state,repo_root,started_at,ended_at,snapshot) VALUES(@id,@adapter,@harness,@state,@repo,@now,NULL,@snapshot)')
    .run({ id: identity.sessionId, adapter: 'ecc-allocation.v2', harness: 'ecc-allocation', state: 'active', repo: repoRoot,
      now, snapshot: JSON.stringify({ schemaVersion: 'ecc.allocation-session.v2' }) });
}

function checkPrevious(repository, input) {
  const previous = repository.list('revision').filter(item => item.identity.sessionId === input.identity.sessionId
    && item.identity.taskId === input.identity.taskId).sort((left, right) => right.identity.revision - left.identity.revision)[0];
  if (!previous) { if (input.previousClosureAcknowledgement !== null) d.fail(); return; }
  if (input.identity.revision <= previous.identity.revision) d.fail();
  const revision = repository.load(previous.identity);
  if (!d.TERMINAL.has(revision.taskState) || revision.successorId !== null) d.fail('BUSY', 3);
  const operations = repository.list('operation', revision.key);
  if (operations.some(operation => ['reserved', 'launch-initiated', 'execution-unknown'].includes(operation.state))) d.fail('RECOVERY_REQUIRED', 4);
  const mayHaveStarted = operations.some(operation => operation.result ? operation.result.spawnState !== 'not-started'
    : repository.db.prepare("SELECT sequence FROM allocation_events WHERE json_extract(data,'$.kind') = 'launch' AND json_extract(data,'$.receiptId') = ? LIMIT 1")
      .get(operation.operationId) !== null);
  if (mayHaveStarted) {
    const ack = input.previousClosureAcknowledgement;
    if (!ack || ack.revision !== previous.identity.revision || ack.expectedFrontier !== revision.frontier) d.fail();
    d.effect(ack.effectAcknowledgement);
  } else if (input.previousClosureAcknowledgement !== null) {
    const ack = input.previousClosureAcknowledgement;
    if (ack.revision !== previous.identity.revision || ack.expectedFrontier !== revision.frontier) d.fail();
    d.effect(ack.effectAcknowledgement);
  }
}

function newAttempt(input, route, ordinal = 0, parentAttemptId = null, transitionId = null, claimedBy = input.ownerId) {
  return { attemptId: input.attemptId, ordinal, parentAttemptId, tierId: route ? route.tierId : null,
    allocationId: route ? route.allocationId : null, state: 'deciding', checkpointId: null,
    sourceTransitionId: transitionId, createdAt: input.now, claimedBy };
}

function claimInitial(repository, input) {
  d.keys(input, ['requestId', 'payloadDigest', 'identity', 'ownerId', 'now', 'policy', 'binding', 'route', 'attemptId',
    'capsule', 'previousClosureAcknowledgement', 'automaticContinuationAcknowledgement']);
  const identity = d.normalizeIdentity(input.identity); const key = d.revisionKey(identity);
  const replay = repository.replay(input.requestId, 'run', key, input.payloadDigest); if (replay) return replay;
  repository.capacity(); d.id(input.ownerId); d.id(input.attemptId); d.timestamp(input.now);
  if (repository.read('revision', key)) d.fail();
  const policy = d.normalizePolicy(input.policy);
  const binding = d.binding(input.binding, policy, identity);
  checkPrevious(repository, { ...input, identity });
  sessionOwnership(repository, identity, binding.repoRoot, input.now);
  const revision = { identity, binding, policyDigest: binding.policyDigest, route: null, createdAt: input.now,
    automaticContinuationAcknowledgement: input.automaticContinuationAcknowledgement };
  const loaded = { ...revision, policy };
  const route = acceptedRoute(repository, loaded, input.route);
  const normalizedCapsule = d.capsule(input.capsule, loaded);
  if (normalizedCapsule && (normalizedCapsule.journalVersion !== 0 || normalizedCapsule.workspaceManifestDigest !== null
    || Object.values(normalizedCapsule.journal).some(items => items.length))) d.fail('INVALID_INPUT', 2);
  if (input.automaticContinuationAcknowledgement !== null) {
    const ack = input.automaticContinuationAcknowledgement;
    d.keys(ack, ['assertedBy', 'timestamp', 'workspaceSynchronousOnly', 'noDetachedOrExternalEffects', 'policyScopeId']);
    d.id(ack.assertedBy); d.timestamp(ack.timestamp);
    if (ack.workspaceSynchronousOnly !== true || ack.noDetachedOrExternalEffects !== true || ack.policyScopeId !== policy.policyVersion) d.fail('INVALID_INPUT', 2);
  }
  repository.register(input.requestId, 'run', key, input.payloadDigest, input.ownerId);
  repository.register(input.attemptId, 'attempt', key, d.canonicalDigest({ identity, attemptId: input.attemptId }));
  if (!repository.read('policy', binding.policyDigest)) repository.write('policy', binding.policyDigest, policy);
  repository.write('revision', key, { ...revision, route }, { session_id: identity.sessionId, task_id: identity.taskId, revision: identity.revision, phase: identity.phase });
  const frontier = { frontier: 0, currentAttemptId: input.attemptId, taskState: route && route.allocationId === null ? 'provider-paused' : 'deciding', journalVersion: normalizedCapsule ? 0 : null,
    switchCount: 0, visitedByTier: route && route.allocationId !== null ? { [route.tierId]: [route.allocationId] } : {}, successorId: null, successorKind: null, closureSafe: true };
  repository.write('frontier', key, frontier);
  repository.write('attempt', input.attemptId, newAttempt(input, route), { revision_key: key, ordinal: 0 });
  if (normalizedCapsule) repository.write('capsule', `${key}:0`, normalizedCapsule, { revision_key: key, journal_version: 0 });
  const receipt = repository.receipt({ ...frontier }, input.requestId);
  repository.event('run', key, input.requestId, { attemptId: input.attemptId, taskDigest: binding.taskDigest });
  return repository.saveReceipt(input.requestId, receipt);
}

function acceptRoute(repository, input) {
  d.keys(input, ['identity', 'expectedFrontier', 'ownerId', 'route', 'now']);
  const revision = repository.load(input.identity); repository.checkFrontier(revision, input, true); d.timestamp(input.now);
  if (revision.route !== null) { d.assertSame(revision.route, input.route); return repository.receipt(revision, revision.currentAttemptId); }
  if (revision.taskState !== 'deciding') d.fail();
  const classifiers = repository.list('operation', revision.key).filter(operation => operation.phase === 'classifier');
  if (classifiers.length !== 1 || !['completed', 'not-started'].includes(classifiers[0].state)) d.fail();
  const result = classifiers[0].result;
  if (result.spawnState !== 'not-started' && !(result.exitStatus === 0 && result.signal === null && result.category === 'none' && result.rootCompletion === 'observed')) d.fail();
  const route = acceptedRoute(repository, revision, input.route, true);
  const { identity, binding, policyDigest, createdAt, automaticContinuationAcknowledgement } = revision;
  repository.write('revision', revision.key, { identity, binding, policyDigest, route, createdAt, automaticContinuationAcknowledgement }, {}, true);
  const attempt = repository.currentAttempt(revision);
  repository.write('attempt', attempt.attemptId, { ...attempt, tierId: route.tierId, allocationId: route.allocationId }, {}, true);
  const updated = repository.updateFrontier(revision, { taskState: route.allocationId === null ? 'provider-paused' : 'deciding',
    visitedByTier: route.allocationId === null ? {} : { [route.tierId]: [route.allocationId] } });
  return repository.receipt(updated, attempt.attemptId);
}

function reserveOperation(repository, input) {
  d.keys(input, ['identity', 'expectedFrontier', 'ownerId', 'operation', 'now']);
  repository.capacity(); const revision = repository.load(input.identity); repository.checkFrontier(revision, input, true);
  if (!['deciding', 'active'].includes(revision.taskState) || revision.successorId !== null) d.fail('BUSY', 3);
  const attempt = repository.currentAttempt(revision); const operation = d.operationIntent(input.operation, revision, attempt);
  const prior = repository.list('operation', revision.key).filter(value => value.attemptId === attempt.attemptId);
  if (prior.some(value => ['reserved', 'launch-initiated', 'execution-unknown'].includes(value.state))) d.fail('BUSY', 3);
  if (prior.some(value => value.phase === operation.phase)) d.fail();
  if (prior.some(value => value.result && value.result.category !== 'none' && !(value.phase === 'classifier' && value.result.spawnState === 'not-started'))) d.fail('BLOCKED', 1);
  if (prior.some(value => value.phase === 'task')) d.fail();
  repository.register(operation.operationId, 'operation', revision.key, d.canonicalDigest(operation));
  repository.write('operation', operation.operationId, { ...operation, ownerId: input.ownerId, state: 'reserved', result: null,
    observed: null, metrics: [], createdAt: d.timestamp(input.now), completedAt: null }, { revision_key: revision.key, attempt_id: attempt.attemptId });
  repository.event('reserve-operation', revision.key, operation.operationId, { phase: operation.phase, allocationId: operation.allocationId });
  return repository.receipt(revision, operation.operationId, { operationId: operation.operationId });
}

function claimOperationLaunch(repository, input) {
  d.keys(input, ['identity', 'expectedFrontier', 'ownerId', 'operationId', 'finalContextDigest', 'workspaceManifestDigest', 'inputDigest', 'now']);
  repository.capacity(); const revision = repository.load(input.identity); repository.checkFrontier(revision, input, true);
  const operation = repository.read('operation', input.operationId);
  if (!operation || operation.attemptId !== revision.currentAttemptId || operation.ownerId !== input.ownerId) d.fail();
  if (operation.state !== 'reserved') d.fail('BUSY', 3);
  for (const field of ['inputDigest', 'finalContextDigest', 'workspaceManifestDigest']) d.assertSame(operation[field], input[field]);
  repository.write('operation', operation.operationId, { ...operation, state: 'launch-initiated' }, {}, true);
  const updated = repository.updateFrontier(revision, { taskState: 'active', closureSafe: false });
  repository.event('launch', revision.key, operation.operationId, { phase: operation.phase });
  return repository.receipt(updated, operation.operationId, { operationId: operation.operationId });
}

function recordOperationCompletion(repository, input, helpers) {
  d.keys(input, ['identity', 'expectedFrontier', 'ownerId', 'operationId', 'completion', 'automaticTransition', 'now']);
  const revision = repository.load(input.identity); repository.checkFrontier(revision, input, true);
  const operation = repository.read('operation', input.operationId);
  if (!operation || operation.attemptId !== revision.currentAttemptId || operation.ownerId !== input.ownerId) d.fail();
  const completion = d.completion(input.completion); d.timestamp(input.now);
  if (operation.result !== null) {
    d.assertSame({ result: operation.result, observed: operation.observed, metrics: operation.metrics }, completion);
    if (input.automaticTransition !== null) d.fail();
    return repository.receipt(revision, operation.operationId, { operationId: operation.operationId });
  }
  if (!['reserved', 'launch-initiated'].includes(operation.state)) d.fail();
  if (operation.state === 'reserved' && completion.result.spawnState !== 'not-started') d.fail();
  const result = completion.result;
  const uncertain = result.spawnState === 'unknown' || result.rootCompletion !== 'observed' && result.spawnState !== 'not-started'
    || ['timeout', 'output-limit', 'cancelled', 'controller-lost'].includes(result.category);
  const state = uncertain ? 'execution-unknown' : result.spawnState === 'not-started' ? 'not-started' : 'completed';
  const stored = repository.write('operation', operation.operationId, { ...operation, ...completion, state, completedAt: input.now }, {}, true);
  const taskState = uncertain ? 'recovery-required' : result.category === 'usage-limit' ? 'provider-paused'
    : operation.phase === 'classifier' && result.spawnState === 'not-started' ? 'deciding'
    : result.category !== 'none' || result.exitStatus !== 0 ? 'blocked'
      : operation.phase === 'task' ? 'awaiting-checkpoint' : 'deciding';
  let updated = repository.updateFrontier(revision, { taskState });
  if (result.quotaObservation !== null) helpers.quotaAvailability(repository, revision, stored, input.now);
  if (input.automaticTransition !== null) updated = helpers.automaticTransition(repository, updated, stored, input.automaticTransition, input.now);
  repository.event('completion', revision.key, operation.operationId, { state, result: completion.result, observed: completion.observed, metrics: completion.metrics });
  const receipt = repository.receipt(updated, operation.operationId, { operationId: operation.operationId,
    transitionId: updated.successorKind === 'provider' ? updated.successorId : null,
    outcomeCode: taskState === 'recovery-required' ? 'ECC_ALLOCATION_RECOVERY_REQUIRED' : taskState === 'provider-paused' && updated.successorId === null
      ? 'ECC_ALLOCATION_PROVIDER_PAUSED' : taskState === 'blocked' ? 'ECC_ALLOCATION_PROCESS_FAILED' : 'ECC_ALLOCATION_OK' });
  repository.saveReceipt(operation.operationId, receipt);
  return receipt;
}

module.exports = { claimInitial, acceptRoute, reserveOperation, claimOperationLaunch, recordOperationCompletion, newAttempt, acceptedRoute };
