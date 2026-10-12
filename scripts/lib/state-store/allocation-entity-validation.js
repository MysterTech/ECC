'use strict';

const d = require('./allocation-data');

function validateStoredIdentity(kind, value, key) {
  const identifier = { attempt: 'attemptId', operation: 'operationId', checkpoint: 'checkpointId', recovery: 'recoveryId',
    transition: 'transitionId', progress: 'progressId', manifest: 'digest' }[kind];
  if (identifier) d.assertSame(value[identifier], key);
  if (kind === 'policy') d.assertSame(d.canonicalDigest(value), key);
  if (kind === 'revision') d.assertSame(d.revisionKey(value.identity), key);
  if (kind === 'capsule') d.assertSame(`${d.revisionKey(value.identity)}:${value.journalVersion}`, key);
}

function validateStoredEntity(kind, value) {
  if (kind === 'policy') d.assertSame(d.normalizePolicy(value), value);
  if (kind === 'progress') {
    d.assertSame(d.normalizeJournal(value.journal), value.journal);
    d.assertSame(d.canonicalDigest(value.journal), value.journalDigest);
  }
  if (kind === 'checkpoint') d.assertSame(d.normalizeEvidence(value.evidence), value.evidence);
  if (kind === 'operation' && value.result !== null) d.completion({ result: value.result, observed: value.observed, metrics: value.metrics });
  for (const [key, field] of Object.entries(value)) {
    if (key.endsWith('Digest') && field !== null) d.digest(field);
    if (key.endsWith('At') && field !== null) d.timestamp(field);
    if (['frontier', 'journalVersion', 'switchCount', 'ordinal'].includes(key) && field !== null) d.integer(field);
    if (['attemptId', 'operationId', 'checkpointId', 'recoveryId', 'transitionId', 'progressId', 'parentAttemptId',
      'successorAttemptId', 'currentAttemptId', 'sourceOperationId', 'sourceTransitionId', 'providerId', 'tierId', 'allocationId', 'claimedBy'].includes(key)
      && field !== null) d.id(field);
  }
  if (kind === 'availability') {
    d.timestamp(value.holdoffUntil); if (value.resetAt !== null) d.timestamp(value.resetAt);
    if (Date.parse(value.holdoffUntil) < Date.parse(value.observedAt)) d.fail('PERSISTENCE_FAILED', 4);
  }
}

function validateStoredOperation(operation, attempt, revision) {
  const allocation = revision.policy.allocations.find(value => value.id === operation.allocationId);
  if (!allocation || operation.providerId !== allocation.providerId || operation.attemptId !== attempt.attemptId) d.fail('PERSISTENCE_FAILED', 4);
  d.assertSame(operation.runtimeDigest, revision.binding.runtimeBindings[operation.providerId].runtimeDigest);
  d.assertSame(operation.requested, { modelId: allocation.modelId, effort: allocation.effort, runtimeDigest: operation.runtimeDigest });
  d.digest(operation.inputDigest); d.id(operation.ownerId);
  if (operation.phase === 'task') {
    if (operation.allocationId !== attempt.allocationId || operation.tierId !== attempt.tierId || operation.finalContextDigest === null
      || !require('../allocation/policy').compatibleAllocation(revision.policy, revision.binding.requirements, allocation)) d.fail('PERSISTENCE_FAILED', 4);
  } else if (operation.phase === 'classifier') {
    if (operation.tierId !== null || revision.policy.classifier.allocationId !== operation.allocationId) d.fail('PERSISTENCE_FAILED', 4);
  } else {
    const proposal = revision.policy.contextProposals[operation.providerId];
    if (!proposal || proposal.allocationId !== operation.allocationId || operation.tierId !== attempt.tierId) d.fail('PERSISTENCE_FAILED', 4);
  }
}

module.exports = { validateStoredIdentity, validateStoredEntity, validateStoredOperation };
