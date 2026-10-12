'use strict';

const d = require('./allocation-data');
const { createAllocationRepository } = require('./allocation-repository');
const lifecycle = require('./allocation-lifecycle');
const transitions = require('./allocation-transitions');
const recovery = require('./allocation-recovery');

function createAllocationReadApi(repository, allowPrivate = false) {
  function getRevision(identity, options = {}) {
    const revision = repository.load(identity);
    const publicRecord = repository.publicRevision(revision);
    if (!options.private) return publicRecord;
    if (!allowPrivate) d.fail('INVALID_INPUT', 2);
    const capsule = repository.latestCapsule(revision);
    const current = repository.currentAttempt(revision);
    const transitionId = revision.successorId || current.sourceTransitionId;
    const transition = transitionId ? repository.read('transition', transitionId) : null;
    const workspaceManifest = transition && transition.workspaceManifestDigest ? repository.read('manifest', transition.workspaceManifestDigest) : null;
    return d.clone({ ...revision, ...publicRecord, capsule, workspaceManifest,
      operations: repository.list('operation', revision.key) });
  }
  function getOperation(operationId) {
    d.id(operationId); const operation = repository.read('operation', operationId);
    if (!operation) return null;
    const row = repository.db.prepare('SELECT revision_key FROM allocation_operations WHERE id = ?').get(operationId);
    const revision = repository.read('revision', row.revision_key);
    return { identity: revision.identity, ...repository.publicRevision(repository.load(revision.identity)).operations
      .find(value => value.operationId === operationId) };
  }
  function getReceipt(receiptId, payloadDigest = null) {
    d.id(receiptId);
    const row = repository.db.prepare('SELECT * FROM allocation_ids WHERE id = ?').get(receiptId);
    if (!row) return null;
    if (payloadDigest !== null && row.payload_digest !== d.digest(payloadDigest)) d.fail();
    if (!row.receipt) return null;
    return { ...JSON.parse(row.receipt), finalized: row.finalized === 1 };
  }
  function getContinuationMaterial(identity) {
    if (!allowPrivate) d.fail('INVALID_INPUT', 2);
    const revision = getRevision(identity, { private: true });
    if (!revision.capsule) d.fail('CAPSULE_UNAVAILABLE', 4);
    const attempt = revision.attempts.find(value => value.attemptId === revision.currentAttemptId);
    const transition = revision.transitions.find(value => value.transitionId === (revision.successorId || attempt.sourceTransitionId)) || null;
    if (transition && revision.successorId !== null && transition.capsuleDigest !== d.canonicalDigest(revision.capsule)) d.fail('CAPSULE_UNAVAILABLE', 4);
    return d.clone({ capsule: { ...revision.capsule, workspaceManifestDigest: revision.workspaceManifest ? revision.workspaceManifest.digest : null },
      workspaceManifest: revision.workspaceManifest, transition, attempt,
      parentAttempt: transition ? revision.attempts.find(value => value.attemptId === transition.parentAttemptId) : null });
  }
  return { getRevision, getOperation, getReceipt, getContinuationMaterial,
    getAvailability: () => repository.list('availability'),
    statusDTO: ({ identity = null, operationId = null }) => identity ? getRevision(identity) : getOperation(operationId) };
}

function finishRequest(repository, input) {
  d.keys(input, ['receiptId', 'identity', 'ownerId', 'expectedFrontier', 'outcomeCode', 'now']);
  const revision = repository.load(input.identity); repository.checkFrontier(revision, input); d.timestamp(input.now);
  const row = repository.db.prepare('SELECT * FROM allocation_ids WHERE id = ?').get(input.receiptId);
  if (!row || !['run', 'next', 'resume'].includes(row.kind) || row.scope !== revision.key || !row.receipt) d.fail();
  const original = JSON.parse(row.receipt);
  if (row.owner_id !== input.ownerId) d.fail();
  if (row.finalized === 1) { if (original.outcomeCode !== input.outcomeCode) d.fail(); return { ...original, replayed: true }; }
  if (!/^ECC_ALLOCATION_[A-Z_]+$/.test(input.outcomeCode)) d.fail('INVALID_INPUT', 2);
  const operations = repository.list('operation', revision.key);
  const lastOperation = operations.at(-1);
  const attempt = repository.currentAttempt(revision);
  const receipt = repository.receipt(revision, input.receiptId, { outcomeCode: input.outcomeCode,
    operationId: lastOperation ? lastOperation.operationId : null, transitionId: revision.successorId || attempt.sourceTransitionId,
    checkpointId: attempt.checkpointId });
  repository.saveReceipt(input.receiptId, receipt);
  repository.db.prepare('UPDATE allocation_ids SET finalized = 1 WHERE id = @id').run({ id: input.receiptId });
  return receipt;
}

function createAllocationQueryApi(db, dbPath) {
  const repository = createAllocationRepository(db, dbPath);
  const reads = createAllocationReadApi(repository, true);
  const helpers = { quotaAvailability: transitions.quotaAvailability, automaticTransition: transitions.automaticTransition };
  const operations = {
    claimInitial: input => lifecycle.claimInitial(repository, input),
    acceptRoute: input => lifecycle.acceptRoute(repository, input),
    reserveOperation: input => lifecycle.reserveOperation(repository, input),
    claimOperationLaunch: input => lifecycle.claimOperationLaunch(repository, input),
    recordOperationCompletion: input => lifecycle.recordOperationCompletion(repository, input, helpers),
    recordProgress: input => recovery.recordProgress(repository, input),
    acceptCheckpointAndReserveSuccessor: input => transitions.acceptCheckpointAndReserveSuccessor(repository, input),
    reserveProviderSwitch: input => transitions.reserveProviderSwitch(repository, input),
    claimNext: input => transitions.claimSavedSuccessor(repository, input, 'capability'),
    claimResume: input => transitions.claimSavedSuccessor(repository, input, 'provider'),
    recordProviderAvailability: input => recovery.recordProviderAvailability(repository, input),
    reconcileOperation: input => recovery.reconcileOperation(repository, input),
    finishRequest: input => finishRequest(repository, input),
  };
  const mutations = Object.fromEntries(Object.entries(operations).map(([name, operation]) => [name,
    input => db.transaction(() => operation(input))()]));
  return { ...Object.fromEntries(Object.entries(reads).map(([name, read]) => [name, (...args) => db.withSnapshot(() => read(...args))])), ...mutations };
}

module.exports = { createAllocationQueryApi, createAllocationReadApi };
