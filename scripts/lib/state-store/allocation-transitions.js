'use strict';

const d = require('./allocation-data');
const { planCapabilitySuccessor, planProviderSwitch, sourceIsCeased } = require('../allocation/policy');
const { newAttempt, acceptedRoute } = require('./allocation-lifecycle');
const { effectiveSourceOperation } = require('./allocation-recovery');

function availabilityFor(repository, revision) {
  return repository.list('availability').filter(record => revision.binding.runtimeBindings[record.providerId]
    && revision.binding.runtimeBindings[record.providerId].runtimeDigest === record.runtimeDigest);
}
function reserveSuccessor(repository, revision, attempt, proposal, input, kind, operationId = null, ack = null, workspace = null) {
  if (revision.successorId !== null) d.fail();
  d.id(input.successorAttemptId); d.id(input.transitionId);
  const existingCapsule = repository.latestCapsule(revision);
  const transition = {
    transitionId: input.transitionId, parentAttemptId: attempt.attemptId, successorAttemptId: input.successorAttemptId,
    sourceOperationId: operationId, kind, reason: kind === 'capability' ? 'capability' : input.reason,
    tierId: proposal.tierId, allocationId: proposal.allocationId, journalVersion: revision.journalVersion,
    capsuleDigest: existingCapsule ? d.canonicalDigest(existingCapsule) : null,
    workspaceManifestDigest: workspace ? workspace.digest : null, checkpointId: input.checkpointId || null,
    effectAcknowledgement: ack, createdAt: input.now, claimed: false,
  };
  repository.register(input.transitionId, 'transition', revision.key, d.canonicalDigest(transition));
  repository.register(input.successorAttemptId, 'attempt', revision.key, d.canonicalDigest({ transitionId: input.transitionId, attemptId: input.successorAttemptId }));
  repository.write('attempt', input.successorAttemptId, { ...newAttempt({ attemptId: input.successorAttemptId, now: input.now },
    proposal, attempt.ordinal + 1, attempt.attemptId, input.transitionId, null), state: 'reserved' },
  { revision_key: revision.key, ordinal: attempt.ordinal + 1 });
  if (workspace && !repository.read('manifest', workspace.digest)) repository.write('manifest', workspace.digest, workspace);
  repository.write('transition', input.transitionId, transition, { revision_key: revision.key, parent_attempt_id: attempt.attemptId, successor_attempt_id: input.successorAttemptId });
  const visited = revision.visitedByTier[proposal.tierId] || [];
  return repository.updateFrontier(revision, { frontier: revision.frontier + 1, taskState: 'successor-reserved',
    successorId: input.transitionId, successorKind: kind, switchCount: revision.switchCount + (kind === 'provider' ? 1 : 0),
    visitedByTier: { ...revision.visitedByTier, [proposal.tierId]: [...new Set([...visited, proposal.allocationId])] } });
}

function quotaAvailability(repository, revision, operation, now) {
  const quota = operation.result.quotaObservation;
  if (!quota || quota.providerId !== operation.providerId || quota.mappingVersion !== 'codex-app-server-0.155.1-usage-limit-v1'
    || quota.source !== 'typed-native' || quota.scope !== 'subscription') d.fail('AUTOMATIC_UNSUPPORTED', 2);
  const provider = revision.policy.providers.find(item => item.id === operation.providerId);
  if (!provider || provider.target !== 'codex' || provider.transport !== 'codex-app-server' || provider.cliVersion !== '0.155.1'
    || operation.result.category !== 'usage-limit' || operation.result.observationOrigin !== 'controller-observed') d.fail('AUTOMATIC_UNSUPPORTED', 2);
  const local = Date.parse(quota.observedAt) + revision.policy.continuation.cooldownMs;
  const holdoff = Math.max(local, quota.resetAt === null ? 0 : Date.parse(quota.resetAt));
  const key = d.canonicalDigest({ providerId: provider.id, runtimeDigest: operation.runtimeDigest,
    authRouteDigest: provider.authRoute.expectedRouteDigest });
  const previous = repository.read('availability', key);
  const holdoffUntil = new Date(Math.max(holdoff, previous ? Date.parse(previous.holdoffUntil) : 0)).toISOString();
  const availability = { providerId: provider.id, runtimeDigest: operation.runtimeDigest, reason: 'confirmed-usage-limit',
    observedAt: quota.observedAt, resetAt: quota.resetAt, holdoffUntil };
  repository.write('availability', key, availability, {}, previous !== null);
  d.timestamp(now);
}

function automaticTransition(repository, revision, operation, input, now) {
  d.keys(input, ['transitionId', 'successorAttemptId', 'destinationAllocationId', 'expectedJournalVersion', 'workspaceManifest', 'acceptedRoute']);
  const policy = revision.policy;
  const ack = revision.automaticContinuationAcknowledgement;
  if (!policy.continuation.enabled || !policy.continuation.automaticOnUsageLimit || !ack
    || ack.policyScopeId !== policy.policyVersion || ack.workspaceSynchronousOnly !== true || ack.noDetachedOrExternalEffects !== true
    || !operation.result.quotaObservation || operation.result.category !== 'usage-limit'
    || operation.result.spawnState !== 'started' || operation.result.exitStatus !== 0 || operation.result.signal !== null
    || operation.result.rootCompletion !== 'observed' || !sourceIsCeased(operation)
    || operation.result.toolQuiescence !== 'observed-clear' || operation.result.observationOrigin !== 'controller-observed'
    || !['scoped-automatic', 'root-only'].includes(operation.result.cessation)
    || revision.journalVersion !== input.expectedJournalVersion) d.fail('RECOVERY_REQUIRED', 4);
  let attempt = repository.currentAttempt(revision);
  if (revision.route === null) {
    if (operation.phase !== 'classifier' || !input.acceptedRoute || input.acceptedRoute.tierId !== policy.fallbackTier
      || input.acceptedRoute.source !== 'fallback' || input.acceptedRoute.reasonCode !== 'classifier-quota') d.fail();
    const route = acceptedRoute(repository, revision, input.acceptedRoute, true, operation);
    const { identity, binding, policyDigest, createdAt, automaticContinuationAcknowledgement } = revision;
    repository.write('revision', revision.key, { identity, binding, policyDigest, route, createdAt, automaticContinuationAcknowledgement }, {}, true);
    attempt = repository.write('attempt', attempt.attemptId, { ...attempt, tierId: route.tierId, allocationId: route.allocationId }, {}, true);
    revision = repository.updateFrontier({ ...revision, route }, { visitedByTier: { [route.tierId]: [route.allocationId] } });
  } else if (input.acceptedRoute !== null) d.fail();
  const workspace = d.manifest(input.workspaceManifest, revision);
  const proposal = planProviderSwitch({ policy, revision: { ...revision, requirements: revision.binding.requirements,
    visitedAllocationIds: revision.visitedByTier[attempt.tierId] || [] }, attempt, sourceOperation: operation,
    destinationAllocationId: input.destinationAllocationId, availability: availabilityFor(repository, revision), now });
  if (proposal.status !== 'successor') return revision;
  return reserveSuccessor(repository, revision, attempt, proposal, { ...input, now, reason: 'usage-limit' }, 'provider', operation.operationId, null, workspace);
}

function reserveProviderSwitch(repository, input) {
  d.keys(input, ['switchId', 'payloadDigest', 'identity', 'attemptId', 'sourceOperationId', 'expectedFrontier',
    'expectedJournalVersion', 'destinationAllocationId', 'transitionId', 'successorAttemptId', 'effectAcknowledgement', 'workspaceManifest', 'now']);
  const key = d.revisionKey(input.identity);
  const replay = repository.replay(input.switchId, 'switch', key, input.payloadDigest); if (replay) return replay;
  repository.capacity(); const revision = repository.load(input.identity); repository.checkFrontier(revision, input);
  if (revision.journalVersion !== input.expectedJournalVersion || revision.currentAttemptId !== input.attemptId) d.fail();
  const attempt = repository.currentAttempt(revision); const operation = repository.read('operation', input.sourceOperationId);
  if (!operation || operation.attemptId !== attempt.attemptId || !revision.route
    || repository.list('operation', key).some(item => item.attemptId === attempt.attemptId
      && ['reserved', 'launch-initiated', 'execution-unknown'].includes(item.state))) d.fail('RECOVERY_REQUIRED', 4);
  const ack = d.effect(input.effectAcknowledgement); const workspace = d.manifest(input.workspaceManifest, revision);
  repository.latestCapsule(revision);
  const proposal = planProviderSwitch({ policy: revision.policy, revision: { ...revision, requirements: revision.binding.requirements,
    visitedAllocationIds: revision.visitedByTier[attempt.tierId] || [] }, attempt, sourceOperation: effectiveSourceOperation(repository, operation),
    destinationAllocationId: input.destinationAllocationId, availability: availabilityFor(repository, revision), now: input.now });
  repository.register(input.switchId, 'switch', key, input.payloadDigest);
  let updated = revision;
  if (proposal.status === 'successor') updated = reserveSuccessor(repository, revision, attempt, proposal,
    { ...input, reason: 'manual' }, 'provider', input.sourceOperationId, ack, workspace);
  else updated = repository.updateFrontier(revision, { taskState: 'provider-paused' });
  const receipt = repository.receipt(updated, input.switchId, { transitionId: updated.successorId,
    outcomeCode: proposal.status === 'successor' ? 'ECC_ALLOCATION_OK' : 'ECC_ALLOCATION_PROVIDER_PAUSED' });
  repository.event('switch', key, input.switchId, { destinationAllocationId: proposal.allocationId, workspaceManifestDigest: workspace.digest });
  return repository.saveReceipt(input.switchId, receipt);
}

function checkEvidence(revision, kind, evidence) {
  if (kind !== 'verified-success') return;
  for (const expected of revision.binding.requirements.expectedVerification) {
    const check = evidence.checks.find(value => value.checkId === expected.checkId);
    if (!check || check.method !== expected.method || check.result !== 'pass') d.fail('INVALID_INPUT', 2);
  }
}

function acceptCheckpointAndReserveSuccessor(repository, input) {
  d.keys(input, ['checkpointId', 'payloadDigest', 'identity', 'attemptId', 'expectedFrontier', 'supersedesCheckpointId',
    'kind', 'cause', 'evidence', 'successorAttemptId', 'now']);
  const key = d.revisionKey(input.identity);
  const replay = repository.replay(input.checkpointId, 'checkpoint', key, input.payloadDigest); if (replay) return replay;
  const revision = repository.load(input.identity); repository.checkFrontier(revision, input);
  const attempt = repository.currentAttempt(revision);
  if (attempt.attemptId !== input.attemptId || revision.successorId !== null
    || !['awaiting-checkpoint', 'awaiting-verification', 'blocked'].includes(revision.taskState)) d.fail();
  const task = repository.list('operation', key).find(item => item.attemptId === attempt.attemptId && item.phase === 'task');
  if (!task || !['completed', 'not-started'].includes(task.state) || !task.result
    || (task.state === 'not-started' && input.kind !== 'process-failure')) d.fail();
  const failed = ['verification-failure', 'unresolved-ambiguity', 'stalled'].includes(input.kind);
  if (!['verified-success', 'verification-failure', 'unresolved-ambiguity', 'stalled', 'process-failure', 'unverified-completion'].includes(input.kind)
    || !['capability', 'environment', 'requirements', 'unknown', 'none'].includes(input.cause) || failed === (input.cause === 'none')) d.fail('INVALID_INPUT', 2);
  if (input.kind !== 'process-failure' && (task.result.exitStatus !== 0 || task.result.signal !== null || task.result.category !== 'none')) d.fail();
  if (attempt.checkpointId !== null) {
    const prior = repository.read('checkpoint', attempt.checkpointId);
    if (input.supersedesCheckpointId !== attempt.checkpointId
      || !(prior.kind === 'unverified-completion' || ['environment', 'requirements', 'unknown'].includes(prior.cause))) d.fail();
  } else if (input.supersedesCheckpointId !== null) d.fail();
  const evidence = d.normalizeEvidence(input.evidence); checkEvidence(revision, input.kind, evidence); d.timestamp(input.now);
  repository.register(input.checkpointId, 'checkpoint', key, input.payloadDigest);
  repository.write('checkpoint', input.checkpointId, { checkpointId: input.checkpointId, attemptId: input.attemptId,
    supersedesCheckpointId: input.supersedesCheckpointId, kind: input.kind, cause: input.cause, evidence, createdAt: input.now },
  { revision_key: key, attempt_id: attempt.attemptId });
  repository.write('attempt', attempt.attemptId, { ...attempt, checkpointId: input.checkpointId }, {}, true);
  const proposal = planCapabilitySuccessor({ policy: revision.policy, revision: { requirements: revision.binding.requirements },
    attempt, checkpoint: input, availability: availabilityFor(repository, revision), now: input.now });
  let updated;
  if (proposal.status === 'successor') {
    repository.capacity();
    updated = reserveSuccessor(repository, revision, attempt, proposal, { ...input,
      transitionId: `cap-${d.canonicalDigest({ checkpointId: input.checkpointId, key })}` }, 'capability');
  } else {
    if (input.successorAttemptId !== null) d.fail('INVALID_INPUT', 2);
    const taskState = input.kind === 'verified-success' ? 'asserted-success' : input.kind === 'unverified-completion' ? 'awaiting-verification'
      : proposal.status === 'exhausted' ? 'exhausted' : proposal.status === 'provider-paused' ? 'provider-paused' : 'blocked';
    updated = repository.updateFrontier(revision, { frontier: revision.frontier + 1, taskState });
  }
  const code = updated.taskState === 'exhausted' ? 'ECC_ALLOCATION_EXHAUSTED' : updated.taskState === 'blocked' ? 'ECC_ALLOCATION_BLOCKED'
    : updated.taskState === 'provider-paused' ? 'ECC_ALLOCATION_PROVIDER_PAUSED' : 'ECC_ALLOCATION_OK';
  const receipt = repository.receipt(updated, input.checkpointId, { checkpointId: input.checkpointId,
    transitionId: updated.successorId, outcomeCode: code });
  repository.event('checkpoint', key, input.checkpointId, { kind: input.kind, cause: input.cause, evidence });
  return repository.saveReceipt(input.checkpointId, receipt);
}

function claimSavedSuccessor(repository, input, kind) {
  const required = ['requestId', 'payloadDigest', 'identity', 'attemptId', 'parentAttemptId', 'expectedFrontier',
    'policyDigest', 'runtimeSetDigest', 'ownerId', 'now'];
  d.keys(input, [...required, ...(kind === 'provider' ? ['transitionId', 'expectedJournalVersion'] : ['checkpointId', 'taskDigest', 'effectAcknowledgement'])]);
  const key = d.revisionKey(input.identity);
  const replay = repository.replay(input.requestId, kind === 'provider' ? 'resume' : 'next', key, input.payloadDigest); if (replay) return replay;
  repository.capacity(); const revision = repository.load(input.identity); repository.checkFrontier(revision, input);
  if (revision.successorKind !== kind || revision.taskState !== 'successor-reserved') d.fail();
  const transition = repository.read('transition', revision.successorId);
  if (!transition || transition.claimed || transition.successorAttemptId !== input.attemptId || transition.parentAttemptId !== input.parentAttemptId) d.fail();
  d.assertSame(input.policyDigest, revision.policyDigest); d.assertSame(input.runtimeSetDigest, revision.binding.runtimeSetDigest);
  if (kind === 'provider') {
    if (input.transitionId !== transition.transitionId || input.expectedJournalVersion !== revision.journalVersion
      || transition.journalVersion !== revision.journalVersion) d.fail();
    d.assertSame(transition.capsuleDigest, d.canonicalDigest(repository.latestCapsule(revision)));
    if (!repository.read('manifest', transition.workspaceManifestDigest)) d.fail('WORKSPACE_CHANGED', 4);
  } else {
    if (input.checkpointId !== transition.checkpointId) d.fail();
    d.assertSame(input.taskDigest, revision.binding.taskDigest); d.effect(input.effectAcknowledgement);
  }
  d.id(input.ownerId); d.timestamp(input.now);
  repository.register(input.requestId, kind === 'provider' ? 'resume' : 'next', key, input.payloadDigest, input.ownerId);
  const attempt = repository.read('attempt', input.attemptId);
  if (!attempt || attempt.state !== 'reserved' || attempt.claimedBy !== null) d.fail();
  repository.write('attempt', input.attemptId, { ...attempt, state: 'deciding', claimedBy: input.ownerId }, {}, true);
  repository.write('transition', transition.transitionId, { ...transition, claimed: true,
    effectAcknowledgement: kind === 'capability' ? input.effectAcknowledgement : transition.effectAcknowledgement }, {}, true);
  const updated = repository.updateFrontier(revision, { currentAttemptId: input.attemptId, taskState: 'deciding', successorId: null, successorKind: null });
  const route = { ...revision.route, source: kind === 'provider' ? 'provider-switch' : 'persisted', reasonCode: 'saved-successor',
    tierId: transition.tierId, allocationId: transition.allocationId };
  const { identity, binding, policyDigest, createdAt, automaticContinuationAcknowledgement } = revision;
  repository.write('revision', key, { identity, binding, policyDigest, route, createdAt, automaticContinuationAcknowledgement }, {}, true);
  const receipt = repository.receipt(updated, input.requestId, { transitionId: transition.transitionId, checkpointId: transition.checkpointId });
  repository.event(kind === 'provider' ? 'resume' : 'next', key, input.requestId, { attemptId: input.attemptId });
  return repository.saveReceipt(input.requestId, receipt);
}

module.exports = { reserveProviderSwitch, acceptCheckpointAndReserveSuccessor, claimSavedSuccessor,
  quotaAvailability, automaticTransition, availabilityFor };
