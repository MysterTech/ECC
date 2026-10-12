'use strict';
const { canonicalDigest } = require('./validation');

function mutate({ operation, input, store, payloadDigest, now, id, dependencies }) {
  const common = { identity: input.identity, payloadDigest, now: now() };
  if (operation === 'progress') {
    const { schemaVersion: _schema, ...fields } = input;
    return store.recordProgress({ ...fields, ...common });
  }
  if (operation === 'checkpoint') {
    const { schemaVersion: _schema, ...fields } = input;
    const revision = store.getRevision(input.identity, { private: true });
    const attempt = revision.attempts.find(value => value.attemptId === input.attemptId);
    const planned = require('./policy').planCapabilitySuccessor({ policy: revision.policy,
      revision: { ...revision, requirements: revision.binding.requirements }, attempt, checkpoint: input,
      availability: revision.availability, now: now() });
    return store.acceptCheckpointAndReserveSuccessor({ ...fields, ...common,
      successorAttemptId: planned.status === 'successor' ? id('attempt') : null });
  }
  if (operation === 'recover') {
    const { schemaVersion: _schema, recoveryEvidence, ...fields } = input;
    const { summary, ...evidence } = recoveryEvidence;
    return store.reconcileOperation({ ...fields, ...common,
      recoveryEvidence: { ...evidence, summaryDigest: summary === null ? null : canonicalDigest(summary) } });
  }
  const revision = store.getRevision(input.identity, { private: true });
  const workspaceManifest = dependencies.captureWorkspaceManifest({ repoRoot: revision.binding.repoRoot });
  const { schemaVersion: _schema, ...fields } = input;
  return store.reserveProviderSwitch({ ...fields, ...common, transitionId: id('transition'), successorAttemptId: id('attempt'), workspaceManifest });
}

module.exports = { mutate };
