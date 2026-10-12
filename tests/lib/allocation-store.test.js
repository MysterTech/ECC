'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const fixture = require('./helpers/allocation-fixture');
const { createAllocationStore, openAllocationSnapshot, createStateStore } = require('../../scripts/lib/state-store');
const { canonicalDigest, normalizePolicy, normalizeRequirements } = require('../../scripts/lib/allocation/validation');
const { evaluateInitialRoute } = require('../../scripts/lib/allocation/policy');
const { startOwnedChild, withOwnedChildren } = require('./helpers/state-store-worker');

async function withStore(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-allocation-store-'));
  const dbPath = path.join(root, 'private', 'state.db');
  let store;
  try { store = await createAllocationStore({ dbPath }); await callback(store, dbPath, root); }
  finally { if (store) store.close(); fs.rmSync(root, { recursive: true, force: true }); }
}

function initial(overrides = {}) {
  const policy = normalizePolicy(fixture.policy());
  const requirements = normalizeRequirements(fixture.requirements(), fixture.task());
  const run = fixture.runInput();
  const runtimeBindings = Object.fromEntries(policy.providers.map(provider => [provider.id, { runtimeDigest: canonicalDigest(provider) }]));
  const contextSourceBindings = Object.fromEntries(['codex', 'claude'].map(id => [id,
    { metadataDigest: fixture.DIGEST, registryIdentityDigest: fixture.DIGEST }]));
  const binding = {
    taskDigest: canonicalDigest(fixture.task()), queryDigest: canonicalDigest(fixture.task().query),
    requirementsDigest: canonicalDigest(requirements), policyDigest: canonicalDigest(policy),
    contextSetDigest: canonicalDigest({ contexts: run.contexts, contextSourceBindings }), runtimeSetDigest: canonicalDigest(runtimeBindings),
    repoIdentityDigest: fixture.DIGEST, repoRoot: run.repoRoot, cwd: run.cwd,
    contexts: run.contexts, contextSourceBindings, runtimeBindings, requirements,
  };
  const route = evaluateInitialRoute({ policy, requirements, availability: [], now: fixture.TIMESTAMP }).route;
  return {
    requestId: 'request', payloadDigest: fixture.DIGEST, identity: fixture.identity(), ownerId: 'owner',
    now: fixture.TIMESTAMP, policy, binding, route, attemptId: 'attempt',
    capsule: { schemaVersion: 'ecc.task-capsule.v1', identity: fixture.identity(), originalTask: fixture.task(),
      requirementsDigest: binding.requirementsDigest, policyDigest: binding.policyDigest,
      contextSetDigest: binding.contextSetDigest, runtimeSetDigest: binding.runtimeSetDigest,
      journalVersion: 0, journal: { plan: [], decisions: [], completed: [], pending: [] }, workspaceManifestDigest: null },
    previousClosureAcknowledgement: null, automaticContinuationAcknowledgement: null, ...overrides,
  };
}

function intent(overrides = {}) {
  const runtimeDigest = canonicalDigest(normalizePolicy(fixture.policy()).providers.find(provider => provider.id === 'codex'));
  return { operationId: 'operation', attemptId: 'attempt', phase: 'task', providerId: 'codex',
    tierId: 'routine', allocationId: 'routine-codex', runtimeDigest,
    requested: { modelId: 'fixture-model-0', effort: 'low', runtimeDigest },
    finalContextDigest: fixture.DIGEST, workspaceManifestDigest: null, inputDigest: fixture.DIGEST, ...overrides };
}
function scope(overrides = {}) {
  return { identity: fixture.identity(), expectedFrontier: 0, ownerId: 'owner', now: fixture.TIMESTAMP, ...overrides };
}
function completion(overrides = {}) {
  return { result: fixture.result(overrides), observed: { backendId: null, modelId: null, effort: null,
    nativeContextTokens: null, childUsageTokens: null, source: 'unavailable' }, metrics: [] };
}
function runTask(store, overrides = {}) {
  store.reserveOperation({ ...scope(), operation: intent() });
  store.claimOperationLaunch({ ...scope(), operationId: 'operation', finalContextDigest: fixture.DIGEST,
    workspaceManifestDigest: null, inputDigest: fixture.DIGEST });
  return store.recordOperationCompletion({ ...scope(), operationId: 'operation', completion: completion(overrides), automaticTransition: null });
}

test('allocation claims are atomic, globally replay-safe and private across reopen', async () => {
  await withStore(async (store, dbPath) => {
    const input = initial();
    const receipt = store.claimInitial(input);
    assert.equal(receipt.frontier, 0);
    assert.equal(receipt.taskState, 'deciding');
    assert.equal(store.claimInitial(input).replayed, true);
    assert.throws(() => store.claimInitial({ ...input, payloadDigest: 'b'.repeat(64) }), { code: 'ECC_ALLOCATION_CONFLICT' });
    assert.throws(() => store.claimInitial({ ...input, requestId: 'new-request' }), { code: 'ECC_ALLOCATION_CONFLICT' });
    const reopened = await createAllocationStore({ dbPath });
    try {
      assert.equal(reopened.getRevision(fixture.identity(), { private: true }).capsule.originalTask.query, fixture.task().query);
      assert(!JSON.stringify(reopened.getRevision(fixture.identity())).includes(fixture.task().query));
      assert.equal(fs.statSync(dbPath).mode & 0o777, 0o600);
    } finally { reopened.close(); }
  });
});

test('root launch CAS prevents duplicate owners and completion remains immutable', async () => {
  await withStore(async store => {
    store.claimInitial(initial());
    store.reserveOperation({ ...scope(), operation: intent() });
    assert.throws(() => store.reserveOperation({ ...scope(), operation: intent({ operationId: 'other' }) }), { code: 'ECC_ALLOCATION_BUSY' });
    const launch = { ...scope(), operationId: 'operation', finalContextDigest: fixture.DIGEST,
      workspaceManifestDigest: null, inputDigest: fixture.DIGEST };
    assert.throws(() => store.claimOperationLaunch({ ...launch, ownerId: 'stranger' }), { code: 'ECC_ALLOCATION_CONFLICT' });
    store.claimOperationLaunch(launch);
    assert.throws(() => store.claimOperationLaunch(launch), { code: 'ECC_ALLOCATION_BUSY' });
    store.recordOperationCompletion({ ...scope(), operationId: 'operation', completion: completion(), automaticTransition: null });
    assert.equal(store.getRevision(fixture.identity()).taskState, 'awaiting-checkpoint');
    assert.throws(() => store.recordOperationCompletion({ ...scope(), operationId: 'operation', completion: completion({ exitStatus: 1 }), automaticTransition: null }), { code: 'ECC_ALLOCATION_CONFLICT' });
  });
});

test('journal CAS keeps notes private and rejects stale updates', async () => {
  await withStore(async store => {
    store.claimInitial(initial()); runTask(store);
    const update = { progressId: 'progress', payloadDigest: fixture.DIGEST, identity: fixture.identity(),
      attemptId: 'attempt', expectedFrontier: 0, expectedJournalVersion: 0,
      journal: { plan: ['Private work note'], decisions: [], completed: [], pending: [] }, now: fixture.TIMESTAMP };
    assert.equal(store.recordProgress(update).journalVersion, 1);
    assert.equal(store.recordProgress(update).replayed, true);
    assert.throws(() => store.recordProgress({ ...update, progressId: 'other' }), { code: 'ECC_ALLOCATION_CONFLICT' });
    assert(!JSON.stringify(store.getRevision(fixture.identity())).includes('Private work note'));
  });
});

test('read-only snapshot never creates, migrates, locks or rewrites', async () => {
  await withStore(async (store, dbPath, root) => {
    store.claimInitial(initial());
    const before = fs.statSync(dbPath).mtimeMs;
    const snapshot = await openAllocationSnapshot({ dbPath });
    try { assert.equal(snapshot.getRevision(fixture.identity()).frontier, 0); }
    finally { snapshot.close(); }
    assert.equal(fs.statSync(dbPath).mtimeMs, before);
    assert(!fs.existsSync(`${dbPath}.lock`));
    const missing = path.join(root, 'missing', 'state.db');
    await assert.rejects(openAllocationSnapshot({ dbPath: missing }));
    assert(!fs.existsSync(path.dirname(missing)));
  });
});

test('additive migration preserves existing ordinary session snapshots', async () => {
  await withStore(async (store, dbPath) => {
    const ordinary = await createStateStore({ dbPath });
    try {
      ordinary.upsertSession({ id: 'ordinary', adapterId: 'fixture', harness: 'claude', state: 'active',
        repoRoot: null, startedAt: fixture.TIMESTAMP, endedAt: null, snapshot: { retained: true } });
      store.claimInitial(initial());
      assert.deepEqual(ordinary.getSessionById('ordinary').snapshot, { retained: true });
      assert.throws(() => store.claimInitial(initial({ requestId: 'conflict', identity: { ...fixture.identity(), sessionId: 'ordinary' } })), { code: 'ECC_ALLOCATION_CONFLICT' });
    } finally { ordinary.close(); }
  });
});

module.exports = { initial, intent, scope, completion, runTask, withStore };

function evidence(result = 'pass') {
  return { assertionOrigin: 'human', assertedBy: 'operator', timestamp: fixture.TIMESTAMP, artifactDigest: fixture.DIGEST,
    workspaceBinding: { head: null, artifactDigest: fixture.DIGEST, source: 'caller-asserted' },
    checks: [{ checkId: 'lint', method: 'static', result, evidenceDigest: fixture.DIGEST, referenceId: null }], references: [] };
}
function workspace() {
  const excludedScope = ['build-output', 'dependency-output', 'git-ignored', 'git-metadata', 'private-harness', 'test-cache'];
  const body = { schemaVersion: 'ecc.workspace-manifest.v1', repoIdentityDigest: fixture.DIGEST,
    head: null, indexDigest: null, entries: [], exclusionSetDigest: canonicalDigest(excludedScope), excludedScope };
  return { ...body, digest: canonicalDigest(body) };
}
function switchInput(overrides = {}) {
  return { switchId: 'switch', payloadDigest: fixture.DIGEST, identity: fixture.identity(), attemptId: 'attempt',
    sourceOperationId: 'operation', expectedFrontier: 0, expectedJournalVersion: 0, destinationAllocationId: null,
    transitionId: 'transition', successorAttemptId: 'successor', effectAcknowledgement: fixture.effectAcknowledgement(),
    workspaceManifest: workspace(), now: fixture.TIMESTAMP, ...overrides };
}
function resumeInput(initialInput, overrides = {}) {
  return { requestId: 'resume-request', payloadDigest: fixture.DIGEST, identity: fixture.identity(), attemptId: 'successor',
    parentAttemptId: 'attempt', transitionId: 'transition', expectedFrontier: 1, expectedJournalVersion: 0,
    policyDigest: initialInput.binding.policyDigest, runtimeSetDigest: initialInput.binding.runtimeSetDigest,
    ownerId: 'next-owner', now: fixture.TIMESTAMP, ...overrides };
}
function recoveryInput(overrides = {}) {
  return { recoveryId: 'recovery', payloadDigest: fixture.DIGEST, identity: fixture.identity(), operationId: 'operation',
    expectedFrontier: 0, action: 'attach-task-completion', recoveryEvidence: { assertedBy: 'operator', timestamp: fixture.TIMESTAMP,
      oldOwnerCannotLaunch: true, relevantWorkStopped: true, effectsDisposition: 'retained', references: [], summaryDigest: null },
    observedCompletion: fixture.result({ observationOrigin: 'recovery-asserted', cessation: 'caller-reconciled' }), now: fixture.TIMESTAMP, ...overrides };
}

test('manual switch reserves one same-tier alternative and resume claims it exactly once', async () => {
  await withStore(async (store, dbPath) => {
    const input = initial(); store.claimInitial(input); runTask(store);
    const switched = store.reserveProviderSwitch(switchInput());
    assert.equal(switched.frontier, 1);
    assert.equal(store.getRevision(fixture.identity()).switchCount, 1);
    assert.equal(store.reserveProviderSwitch(switchInput()).replayed, true);
    assert.throws(() => store.reserveProviderSwitch(switchInput({ switchId: 'another' })), { code: 'ECC_ALLOCATION_CONFLICT' });
    const reopened = await createAllocationStore({ dbPath });
    try {
      const saved = reopened.getContinuationMaterial(fixture.identity());
      assert.equal(saved.workspaceManifest.digest, workspace().digest);
      assert.equal(saved.capsule.workspaceManifestDigest, workspace().digest);
      assert.equal(reopened.claimResume(resumeInput(input)).attemptId, 'successor');
      assert.equal(reopened.claimResume(resumeInput(input)).replayed, true);
      assert.throws(() => reopened.claimResume(resumeInput(input, { requestId: 'duplicate' })), { code: 'ECC_ALLOCATION_CONFLICT' });
      assert.equal(reopened.getRevision(fixture.identity()).route.allocationId, 'routine-claude');
    } finally { reopened.close(); }
  });
});

test('checkpoint verification and capability reservation share one guarded frontier', async () => {
  await withStore(async store => {
    const input = initial(); store.claimInitial(input); runTask(store);
    const checkpoint = { checkpointId: 'checkpoint', payloadDigest: fixture.DIGEST, identity: fixture.identity(),
      attemptId: 'attempt', expectedFrontier: 0, supersedesCheckpointId: null, kind: 'verified-success', cause: 'none',
      evidence: evidence('fail'), successorAttemptId: null, now: fixture.TIMESTAMP };
    assert.throws(() => store.acceptCheckpointAndReserveSuccessor(checkpoint), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
    const reserved = store.acceptCheckpointAndReserveSuccessor({ ...checkpoint, kind: 'verification-failure', cause: 'capability', successorAttemptId: 'cap-attempt' });
    assert.equal(reserved.taskState, 'successor-reserved');
    const saved = store.getRevision(fixture.identity());
    assert.equal(saved.transitions[0].tierId, 'standard');
    assert.throws(() => store.claimNext({ requestId: 'next', payloadDigest: fixture.DIGEST, identity: fixture.identity(),
      attemptId: 'cap-attempt', parentAttemptId: 'attempt', checkpointId: 'checkpoint', expectedFrontier: 1,
      policyDigest: input.binding.policyDigest, runtimeSetDigest: input.binding.runtimeSetDigest, taskDigest: fixture.DIGEST,
      ownerId: 'next-owner', effectAcknowledgement: fixture.effectAcknowledgement(), now: fixture.TIMESTAMP }), { code: 'ECC_ALLOCATION_CONFLICT' });
    const next = { requestId: 'next', payloadDigest: fixture.DIGEST, identity: fixture.identity(), attemptId: 'cap-attempt',
      parentAttemptId: 'attempt', checkpointId: 'checkpoint', expectedFrontier: 1, policyDigest: input.binding.policyDigest,
      runtimeSetDigest: input.binding.runtimeSetDigest, taskDigest: input.binding.taskDigest, ownerId: 'next-owner',
      effectAcknowledgement: fixture.effectAcknowledgement(), now: fixture.TIMESTAMP };
    assert.equal(store.claimNext(next).attemptId, 'cap-attempt');
    assert.equal(store.claimNext(next).replayed, true);
    assert.equal(store.getRevision(fixture.identity()).route.tierId, 'standard');
  });
});

test('lost result recovery preserves observed abnormal facts and enables acknowledged manual switch', async () => {
  await withStore(async store => {
    store.claimInitial(initial()); runTask(store, { exitStatus: null, signal: 'SIGTERM', category: 'cancelled', rootCompletion: 'unknown', cessation: 'unknown', toolQuiescence: 'unknown' });
    assert.equal(store.getRevision(fixture.identity()).taskState, 'recovery-required');
    assert.throws(() => store.reserveProviderSwitch(switchInput()), { code: 'ECC_ALLOCATION_RECOVERY_REQUIRED' });
    const observed = fixture.result({ exitStatus: null, signal: 'SIGTERM', category: 'cancelled', rootCompletion: 'unknown',
      cessation: 'caller-reconciled', observationOrigin: 'recovery-asserted', toolQuiescence: 'unknown' });
    assert.equal(store.reconcileOperation(recoveryInput({ observedCompletion: observed })).taskState, 'blocked');
    assert.equal(store.getOperation('operation').result.category, 'cancelled');
    assert.equal(store.getOperation('operation').result.cessation, 'unknown');
    const reserved = store.reserveProviderSwitch(switchInput({ expectedFrontier: 1 }));
    assert.equal(reserved.taskState, 'successor-reserved');
    assert.equal(store.getOperation('operation').result.signal, 'SIGTERM');
  });
});

test('quota observation, cooldown and automatic successor commit atomically', async () => {
  await withStore(async store => {
    const input = initial();
    const policy = normalizePolicy({ ...input.policy, continuation: { ...input.policy.continuation, automaticOnUsageLimit: true } });
    const policyDigest = canonicalDigest(policy);
    const configured = { ...input, policy, automaticContinuationAcknowledgement: fixture.automaticAcknowledgement(),
      binding: { ...input.binding, policyDigest }, route: { ...input.route, policyDigest }, capsule: { ...input.capsule, policyDigest } };
    store.claimInitial(configured);
    store.reserveOperation({ ...scope(), operation: intent() });
    store.claimOperationLaunch({ ...scope(), operationId: 'operation', finalContextDigest: fixture.DIGEST, workspaceManifestDigest: null, inputDigest: fixture.DIGEST });
    const quota = { source: 'typed-native', providerId: 'codex', signalId: 'usageLimitExceeded', scope: 'subscription',
      observedAt: fixture.TIMESTAMP, resetAt: null, mappingVersion: 'codex-app-server-0.155.1-usage-limit-v1' };
    const request = { ...scope(), operationId: 'operation', completion: completion({ category: 'usage-limit', nativeErrorCode: 'usageLimitExceeded', quotaObservation: quota }),
      automaticTransition: { transitionId: 'transition', successorAttemptId: 'successor', destinationAllocationId: null,
        expectedJournalVersion: 0, workspaceManifest: workspace(), acceptedRoute: null } };
    assert.throws(() => store.recordOperationCompletion({ ...request, completion: { ...request.completion,
      result: { ...request.completion.result, toolQuiescence: 'pending' } } }), { code: 'ECC_ALLOCATION_RECOVERY_REQUIRED' });
    assert.throws(() => store.recordOperationCompletion({ ...request, completion: { ...request.completion,
      result: { ...request.completion.result, exitStatus: 1 } } }), { code: 'ECC_ALLOCATION_RECOVERY_REQUIRED' });
    assert.equal(store.getOperation('operation').state, 'launch-initiated');
    assert.equal(store.getAvailability().length, 0);
    assert.equal(store.recordOperationCompletion(request).taskState, 'successor-reserved');
    const saved = store.getRevision(fixture.identity());
    assert.equal(saved.transitions[0].allocationId, 'routine-claude');
    assert.equal(saved.availability[0].holdoffUntil, '2026-10-11T00:00:01.000Z');
    assert.equal(saved.switchCount, 1);
  });
});

test('read-only validation refuses corrupted persisted entities without mutating bytes', async () => {
  await withStore(async (store, dbPath) => {
    store.claimInitial(initial());
    const ordinary = await createStateStore({ dbPath });
    try { ordinary._database.prepare('UPDATE allocation_frontiers SET data = @data').run({ data: JSON.stringify({ forged: true }) }); }
    finally { ordinary.close(); }
    const before = fs.readFileSync(dbPath);
    await assert.rejects(openAllocationSnapshot({ dbPath }), { code: 'ECC_ALLOCATION_PERSISTENCE_FAILED' });
    await assert.rejects(createAllocationStore({ dbPath }), { code: 'ECC_ALLOCATION_PERSISTENCE_FAILED' });
    assert.deepEqual(fs.readFileSync(dbPath), before);
  });
});

function rebindInitial(rawPolicy, rawRequirements = fixture.requirements(), rawTask = fixture.task()) {
  const input = initial(); const policy = normalizePolicy(rawPolicy); const requirements = normalizeRequirements(rawRequirements, rawTask);
  const runtimeBindings = Object.fromEntries(policy.providers.map(provider => [provider.id, { runtimeDigest: canonicalDigest(provider) }]));
  const binding = { ...input.binding, policyDigest: canonicalDigest(policy), requirementsDigest: canonicalDigest(requirements), requirements,
    taskDigest: canonicalDigest(rawTask), queryDigest: canonicalDigest(rawTask.query), runtimeBindings, runtimeSetDigest: canonicalDigest(runtimeBindings) };
  const selected = evaluateInitialRoute({ policy, requirements, availability: [], now: fixture.TIMESTAMP }).route;
  return { ...input, identity: { ...fixture.identity(), revision: rawTask.revision }, policy, binding,
    route: selected.tierId === null ? null : selected, capsule: { ...input.capsule, identity: { ...fixture.identity(), revision: rawTask.revision },
      originalTask: rawTask, requirementsDigest: binding.requirementsDigest, policyDigest: binding.policyDigest, runtimeSetDigest: binding.runtimeSetDigest } };
}

test('classifier route independently rejects an incompatible or held-off alternative', async () => {
  await withStore(async store => {
    const rawPolicy = fixture.policy();
    const input = rebindInitial({ ...rawPolicy, classifier: { mode: 'inherited-authority', allocationId: 'routine-codex', authorityAcknowledged: true },
      allocations: rawPolicy.allocations.map(allocation => allocation.id === 'standard-codex' ? { ...allocation, capabilities: [] } : allocation) },
    { ...fixture.requirements(), ambiguity: 'bounded', requiredCapabilities: ['code'] });
    store.claimInitial(input);
    store.reserveOperation({ ...scope(), operation: intent({ phase: 'classifier', tierId: null, finalContextDigest: null }) });
    store.claimOperationLaunch({ ...scope(), operationId: 'operation', finalContextDigest: null, workspaceManifestDigest: null, inputDigest: fixture.DIGEST });
    store.recordOperationCompletion({ ...scope(), operationId: 'operation', completion: completion(), automaticTransition: null });
    const expected = evaluateInitialRoute({ policy: input.policy, requirements: input.binding.requirements, availability: [], now: fixture.TIMESTAMP }).route;
    const route = { ...expected, source: 'classifier', classifierStatus: 'completed', reasonCode: 'classifier-selection',
      classifierReasonCode: 'requirements-match', tierId: 'standard', allocationId: 'standard-codex' };
    assert.throws(() => store.acceptRoute({ ...scope(), route }), { code: 'ECC_ALLOCATION_INCOMPATIBLE' });
    store.recordProviderAvailability({ availability: { providerId: 'claude', runtimeDigest: input.binding.runtimeBindings.claude.runtimeDigest,
      reason: 'local-holdoff', observedAt: fixture.TIMESTAMP, resetAt: null, holdoffUntil: '2026-10-11T00:00:01.000Z' }, now: fixture.TIMESTAMP });
    assert.throws(() => store.acceptRoute({ ...scope(), route: { ...route, allocationId: 'standard-claude' } }), { code: 'ECC_ALLOCATION_PROVIDER_PAUSED' });
  });
});

test('cessation-only recovery preserves a known quota observation without certifying another one', async () => {
  await withStore(async store => {
    store.claimInitial(initial());
    const quota = { source: 'typed-native', providerId: 'codex', signalId: 'usageLimitExceeded', scope: 'subscription',
      observedAt: fixture.TIMESTAMP, resetAt: null, mappingVersion: 'codex-app-server-0.155.1-usage-limit-v1' };
    runTask(store, { category: 'usage-limit', nativeErrorCode: 'usageLimitExceeded', quotaObservation: quota,
      rootCompletion: 'unknown', cessation: 'unknown', toolQuiescence: 'unknown' });
    store.reconcileOperation(recoveryInput({ observedCompletion: null }));
    assert.deepEqual(store.getOperation('operation').result.quotaObservation, quota);
    assert.equal(store.getOperation('operation').result.observationOrigin, 'controller-observed');
    assert.equal(store.reserveProviderSwitch(switchInput({ expectedFrontier: 1 })).taskState, 'successor-reserved');
  });
});

test('an abandoned launch marker still requires explicit closure acknowledgement for a new revision', async () => {
  await withStore(async store => {
    store.claimInitial(initial());
    store.reserveOperation({ ...scope(), operation: intent() });
    store.claimOperationLaunch({ ...scope(), operationId: 'operation', finalContextDigest: fixture.DIGEST,
      workspaceManifestDigest: null, inputDigest: fixture.DIGEST });
    store.reconcileOperation(recoveryInput({ action: 'abandon', observedCompletion: null }));
    const next = rebindInitial(fixture.policy(), { ...fixture.requirements(), revision: 2 }, { ...fixture.task(), revision: 2 });
    next.requestId = 'new-revision'; next.attemptId = 'new-attempt';
    assert.throws(() => store.claimInitial(next), { code: 'ECC_ALLOCATION_CONFLICT' });
    assert.equal(store.claimInitial({ ...next, previousClosureAcknowledgement: { revision: 1, expectedFrontier: 1,
      effectAcknowledgement: fixture.effectAcknowledgement() } }).frontier, 0);
  });
});

test('independent handles and owned processes cannot duplicate a root launch or revision', async () => {
  await withStore(async (store, dbPath) => {
    const workerPath = path.join(__dirname, 'helpers', 'allocation-store-worker.js');
    const start = async () => {
      const child = startOwnedChild(workerPath); await child.waitFor(message => message.ready);
      const opening = child.waitFor(message => message.id === 'open'); child.send({ id: 'open', action: 'open', dbPath });
      assert.equal((await opening).ok, true); return child;
    };
    await withOwnedChildren(2, start, async children => {
      const requests = children.map((child, index) => {
        const response = child.waitFor(message => message.id === 'claim');
        child.send({ id: 'claim', action: 'claim', input: { ...initial(), requestId: `claim-${index}` } }); return response;
      });
      const results = await Promise.all(requests);
      assert.equal(results.filter(result => result.ok).length, 1);
      assert.equal(results.find(result => !result.ok).code, 'ECC_ALLOCATION_CONFLICT');
      store.reserveOperation({ ...scope(), operation: intent() });
      const launch = { ...scope(), operationId: 'operation', finalContextDigest: fixture.DIGEST,
        workspaceManifestDigest: null, inputDigest: fixture.DIGEST };
      const results2 = await Promise.all(children.map(child => {
        const response = child.waitFor(message => message.id === 'launch'); child.send({ id: 'launch', action: 'launch', input: launch }); return response;
      }));
      assert.equal(results2.filter(result => result.ok).length, 1);
      assert.equal(results2.find(result => !result.ok).code, 'ECC_ALLOCATION_BUSY');
      assert.equal(store.getRevision(fixture.identity()).operations.length, 1);
    });
    const reopened = await createAllocationStore({ dbPath });
    try { assert.throws(() => reopened.claimOperationLaunch({ ...scope(), operationId: 'operation', finalContextDigest: fixture.DIGEST,
      workspaceManifestDigest: null, inputDigest: fixture.DIGEST }), { code: 'ECC_ALLOCATION_BUSY' }); }
    finally { reopened.close(); }
  });
});

test('publication ambiguity preserves the atomic claim and identical replay after a lost response', async () => {
  await withStore(async store => {
    const rename = fs.renameSync;
    fs.renameSync = (...args) => { rename(...args); throw new Error('Fixture lost response after publication'); };
    try { assert.throws(() => store.claimInitial(initial()), /Fixture lost response/); }
    finally { fs.renameSync = rename; }
    assert.equal(store.claimInitial(initial()).replayed, true);
    assert.equal(store.getRevision(fixture.identity()).attempts.length, 1);
  });
});

test('request finalization retains original failure outcome across subsequent recovery', async () => {
  await withStore(async store => {
    store.claimInitial(initial()); runTask(store, { exitStatus: 1, category: 'provider-error' });
    assert.equal(store.getReceipt('request').finalized, false);
    assert.equal(store.getReceipt('missing'), null);
    assert.throws(() => store.getReceipt('request', 'b'.repeat(64)), { code: 'ECC_ALLOCATION_CONFLICT' });
    const finalize = { receiptId: 'request', identity: fixture.identity(), ownerId: 'owner', expectedFrontier: 0,
      outcomeCode: 'ECC_ALLOCATION_PROCESS_FAILED', now: fixture.TIMESTAMP };
    assert.throws(() => store.finishRequest({ ...finalize, ownerId: 'other' }), { code: 'ECC_ALLOCATION_CONFLICT' });
    store.finishRequest(finalize);
    assert.equal(store.getReceipt('request').finalized, true);
    assert.equal(store.finishRequest(finalize).replayed, true);
    assert.throws(() => store.finishRequest({ ...finalize, outcomeCode: 'ECC_ALLOCATION_OK' }), { code: 'ECC_ALLOCATION_CONFLICT' });
    store.reconcileOperation(recoveryInput({ action: 'abandon', observedCompletion: null }));
    assert.equal(store.claimInitial(initial()).outcomeCode, 'ECC_ALLOCATION_PROCESS_FAILED');
    assert.equal(store.statusDTO({ operationId: 'operation' }).result.category, 'provider-error');
  });
});

test('disabled continuation stores no prose and rejects portable operations', async () => {
  await withStore(async store => {
    const rawPolicy = fixture.policy();
    const input = rebindInitial({ ...rawPolicy, continuation: { ...rawPolicy.continuation, enabled: false, maxSwitches: 0 } });
    input.capsule = null;
    store.claimInitial(input); runTask(store);
    assert.equal(store.getRevision(fixture.identity(), { private: true }).capsule, null);
    assert.throws(() => store.getContinuationMaterial(fixture.identity()), { code: 'ECC_ALLOCATION_CAPSULE_UNAVAILABLE' });
    assert.throws(() => store.recordProgress({ progressId: 'progress', payloadDigest: fixture.DIGEST, identity: fixture.identity(),
      attemptId: 'attempt', expectedFrontier: 0, expectedJournalVersion: 0, journal: { plan: [], decisions: [], completed: [], pending: [] }, now: fixture.TIMESTAMP }), { code: 'ECC_ALLOCATION_CAPSULE_UNAVAILABLE' });
    assert.throws(() => store.reserveProviderSwitch(switchInput({ expectedJournalVersion: null })), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
  });
});

test('provisional verification can be replaced exactly once by complete success evidence', async () => {
  await withStore(async store => {
    store.claimInitial(initial()); runTask(store);
    const checkpoint = { checkpointId: 'unverified', payloadDigest: fixture.DIGEST, identity: fixture.identity(), attemptId: 'attempt',
      expectedFrontier: 0, supersedesCheckpointId: null, kind: 'unverified-completion', cause: 'none', evidence: evidence(), successorAttemptId: null, now: fixture.TIMESTAMP };
    assert.equal(store.acceptCheckpointAndReserveSuccessor(checkpoint).taskState, 'awaiting-verification');
    assert.equal(store.acceptCheckpointAndReserveSuccessor(checkpoint).replayed, true);
    assert.throws(() => store.acceptCheckpointAndReserveSuccessor({ ...checkpoint, checkpointId: 'bad', expectedFrontier: 1, kind: 'verified-success' }), { code: 'ECC_ALLOCATION_CONFLICT' });
    const success = { ...checkpoint, checkpointId: 'verified', expectedFrontier: 1, supersedesCheckpointId: 'unverified', kind: 'verified-success' };
    assert.equal(store.acceptCheckpointAndReserveSuccessor(success).taskState, 'asserted-success');
    assert.throws(() => store.recordProgress({ progressId: 'terminal-progress', payloadDigest: fixture.DIGEST, identity: fixture.identity(),
      attemptId: 'attempt', expectedFrontier: 2, expectedJournalVersion: 0, journal: { plan: [], decisions: [], completed: [], pending: [] }, now: fixture.TIMESTAMP }), { code: 'ECC_ALLOCATION_CONFLICT' });
    assert.throws(() => store.acceptCheckpointAndReserveSuccessor({ ...success, checkpointId: 'late', expectedFrontier: 2 }), { code: 'ECC_ALLOCATION_CONFLICT' });
  });
});

test('private path and snapshot guards refuse unsafe files and historic schema without creation', async () => {
  await withStore(async (store, dbPath, root) => {
    store.claimInitial(initial());
    const linked = path.join(root, 'linked.db'); fs.symlinkSync(dbPath, linked);
    await assert.rejects(openAllocationSnapshot({ dbPath: linked }), { code: 'ECC_ALLOCATION_PERSISTENCE_FAILED' });
    fs.chmodSync(dbPath, 0o644);
    await assert.rejects(createAllocationStore({ dbPath }), { code: 'ECC_ALLOCATION_PERSISTENCE_FAILED' });
    fs.chmodSync(dbPath, 0o600);
    const snapshot = await openAllocationSnapshot({ dbPath });
    assert.throws(() => snapshot.getRevision(fixture.identity(), { private: true }), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
    assert.throws(() => snapshot.getContinuationMaterial(fixture.identity()), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
    assert.equal(snapshot.getOperation('missing'), null);
    snapshot.close(); snapshot.close();
    assert.throws(() => snapshot.getRevision(fixture.identity()), { code: 'ECC_ALLOCATION_PERSISTENCE_FAILED' });
    const historic = path.join(root, 'historic.db');
    const ordinary = await createStateStore({ dbPath: historic });
    try { ordinary._database.exec('DELETE FROM schema_migrations WHERE version = 3'); }
    finally { ordinary.close(); }
    const before = fs.readFileSync(historic);
    await assert.rejects(openAllocationSnapshot({ dbPath: historic }), { code: 'ECC_ALLOCATION_PERSISTENCE_FAILED' });
    assert.deepEqual(fs.readFileSync(historic), before);
  });
});

test('cooldown never shortens under clock rollback and mismatched runtime scopes are ignored', async () => {
  await withStore(async store => {
    const input = initial(); store.claimInitial(input);
    const availability = { providerId: 'codex', runtimeDigest: input.binding.runtimeBindings.codex.runtimeDigest,
      reason: 'local-holdoff', observedAt: fixture.TIMESTAMP, resetAt: null, holdoffUntil: '2026-10-11T00:00:10.000Z' };
    store.recordProviderAvailability({ availability, now: fixture.TIMESTAMP });
    const saved = store.recordProviderAvailability({ availability: { ...availability, observedAt: '2026-10-10T00:00:00.000Z',
      holdoffUntil: '2026-10-10T00:00:01.000Z' }, now: fixture.TIMESTAMP });
    assert.equal(saved.holdoffUntil, '2026-10-11T00:00:10.000Z');
    assert.throws(() => store.recordProviderAvailability({ availability: { ...availability, reason: 'confirmed-usage-limit' }, now: fixture.TIMESTAMP }), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
    assert.throws(() => store.recordProviderAvailability({ availability: { ...availability, runtimeDigest: fixture.DIGEST }, now: fixture.TIMESTAMP }), { code: 'ECC_ALLOCATION_BINDING_CHANGED' });
  });
});

test('reopen validates archived private journal shapes and exact operation tuples', async () => {
  await withStore(async (store, dbPath) => {
    store.claimInitial(initial()); runTask(store);
    store.recordProgress({ progressId: 'progress', payloadDigest: fixture.DIGEST, identity: fixture.identity(), attemptId: 'attempt',
      expectedFrontier: 0, expectedJournalVersion: 0, journal: { plan: [], decisions: [], completed: [], pending: [] }, now: fixture.TIMESTAMP });
    const ordinary = await createStateStore({ dbPath });
    try {
      const current = JSON.parse(ordinary._database.prepare('SELECT data FROM allocation_progress WHERE id = ?').get('progress').data);
      ordinary._database.prepare('UPDATE allocation_progress SET data = @data WHERE id = @id')
        .run({ id: 'progress', data: JSON.stringify({ ...current, journal: { ...current.journal, hiddenTranscript: 'must be rejected' } }) });
    } finally { ordinary.close(); }
    await assert.rejects(openAllocationSnapshot({ dbPath }), { code: 'ECC_ALLOCATION_PERSISTENCE_FAILED' });
  });
});

test('persistence rejects prose hidden in context bindings even with matching caller digests', async () => {
  await withStore(async store => {
    const input = initial();
    const contexts = { ...input.binding.contexts, codex: { ...input.binding.contexts.codex, rawTranscript: 'must not persist' } };
    const contextSetDigest = canonicalDigest({ contexts, contextSourceBindings: input.binding.contextSourceBindings });
    assert.throws(() => store.claimInitial({ ...input, binding: { ...input.binding, contexts, contextSetDigest },
      capsule: { ...input.capsule, contextSetDigest } }), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
    assert.equal(store.getReceipt('request'), null);
  });
});

test('native observations and pricing remain typed, attributable and internally consistent', async () => {
  await withStore(async store => {
    store.claimInitial(initial()); store.reserveOperation({ ...scope(), operation: intent() });
    store.claimOperationLaunch({ ...scope(), operationId: 'operation', finalContextDigest: fixture.DIGEST, workspaceManifestDigest: null, inputDigest: fixture.DIGEST });
    const metric = (name, value, overrides = {}) => ({ name, value, scope: 'root', series: 'observed', currency: null,
      source: 'provider-observed', pricing: null, ...overrides });
    const native = { ...completion(), observed: { backendId: 'openai', modelId: 'fixture/model-0', effort: 'low',
      nativeContextTokens: 4096, childUsageTokens: 10, source: 'provider-observed' }, metrics: [metric('inputTokens', 100), metric('cachedInputTokens', 20),
      metric('outputTokens', 10), metric('durationMs', 1000, { source: 'controller-observed' }),
      metric('costMicros', null, { series: 'cash', currency: null, source: 'unavailable' }), metric('costMicros', 3, {
        series: 'API-equivalent', currency: 'USD', source: 'API-equivalent-estimated', pricing: { sourceId: 'fixture-price', version: 'v1',
          timestamp: fixture.TIMESTAMP, rounding: 'nearest-micro-half-up' } })] };
    const complete = value => store.recordOperationCompletion({ ...scope(), operationId: 'operation', completion: value, automaticTransition: null });
    assert.throws(() => complete({ ...native, metrics: [metric('inputTokens', 10), metric('cachedInputTokens', 20)] }), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
    assert.throws(() => complete({ ...native, metrics: [metric('costMicros', 10)] }), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
    assert.throws(() => complete({ ...native, metrics: [metric('costMicros', 10, { currency: 'USD', source: 'API-equivalent-estimated' })] }), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
    assert.throws(() => complete({ ...native, rawOutput: 'do not store' }), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
    complete(native);
    assert.deepEqual(store.getOperation('operation').observed, native.observed);
    assert.equal(store.getOperation('operation').metrics.length, 6);
  });
});

test('safe manifests retain deletion/untracked observations and refuse private or traversal paths', async () => {
  await withStore(async store => {
    store.claimInitial(initial()); runTask(store);
    const entries = [{ path: 'src/new.js', kind: 'file', digest: fixture.DIGEST, bytes: 100, tracking: 'untracked' },
      { path: 'src/removed.js', kind: 'deleted', digest: null, bytes: null, tracking: 'tracked' }];
    const manifestFor = entries => {
      const { digest: _old, ...body } = workspace(); const changed = { ...body, entries }; return { ...changed, digest: canonicalDigest(changed) };
    };
    for (const unsafe of ['../outside', '.ecc-state/state.db', 'src/line\nbreak']) {
      assert.throws(() => store.reserveProviderSwitch(switchInput({ workspaceManifest: manifestFor([{ ...entries[0], path: unsafe }]) })), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
    }
    assert.throws(() => store.reserveProviderSwitch(switchInput({ workspaceManifest: manifestFor([{ ...entries[0], bytes: 16 * 1024 * 1024 + 1 }]) })), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
    store.reserveProviderSwitch(switchInput({ workspaceManifest: manifestFor(entries) }));
    assert.deepEqual(store.getContinuationMaterial(fixture.identity()).workspaceManifest.entries, entries);
    assert(!JSON.stringify(store.getRevision(fixture.identity())).includes('src/new.js'));
  });
});

test('actual provider unknown-usage metrics persist as unknown rather than invented cash', async () => {
  await withStore(async store => {
    const { usageMetrics } = require('../../scripts/lib/allocation/provider-common');
    store.claimInitial(initial()); store.reserveOperation({ ...scope(), operation: intent() });
    store.claimOperationLaunch({ ...scope(), operationId: 'operation', finalContextDigest: fixture.DIGEST, workspaceManifestDigest: null, inputDigest: fixture.DIGEST });
    const native = { ...completion(), metrics: usageMetrics(null, 1000) };
    store.recordOperationCompletion({ ...scope(), operationId: 'operation', completion: native, automaticTransition: null });
    const cash = store.getOperation('operation').metrics.find(metric => metric.name === 'costMicros');
    assert.equal(cash.value, null); assert.equal(cash.currency, null); assert.equal(cash.source, 'unavailable');
  });
});

test('classifier no-spawn fallback and confirmed-quota fallback keep required tier floors', async () => {
  await withStore(async store => {
    const raw = fixture.policy();
    const input = rebindInitial({ ...raw, classifier: { mode: 'inherited-authority', allocationId: 'routine-codex', authorityAcknowledged: true } },
      { ...fixture.requirements(), complexity: 'unknown' });
    store.claimInitial(input); store.reserveOperation({ ...scope(), operation: intent({ phase: 'classifier', tierId: null, finalContextDigest: null }) });
    store.recordOperationCompletion({ ...scope(), operationId: 'operation', completion: completion({ spawnState: 'not-started',
      exitStatus: null, category: 'spawn-error', rootCompletion: 'unknown', cessation: 'unknown', toolQuiescence: 'not-supported' }), automaticTransition: null });
    const route = evaluateInitialRoute({ policy: input.policy, requirements: input.binding.requirements, availability: [], now: fixture.TIMESTAMP }).route;
    const fallback = { ...route, source: 'fallback', reasonCode: 'classifier-no-spawn', classifierStatus: 'failed', tierId: 'demanding', allocationId: 'demanding-codex' };
    store.acceptRoute({ ...scope(), route: fallback });
    assert.equal(store.getRevision(fixture.identity()).route.tierId, 'demanding');
  });
  await withStore(async store => {
    const raw = fixture.policy();
    const input = rebindInitial({ ...raw, classifier: { mode: 'inherited-authority', allocationId: 'routine-codex', authorityAcknowledged: true },
      continuation: { ...raw.continuation, automaticOnUsageLimit: true } }, { ...fixture.requirements(), complexity: 'unknown' });
    input.automaticContinuationAcknowledgement = fixture.automaticAcknowledgement();
    store.claimInitial(input); store.reserveOperation({ ...scope(), operation: intent({ phase: 'classifier', tierId: null, finalContextDigest: null }) });
    store.claimOperationLaunch({ ...scope(), operationId: 'operation', finalContextDigest: null, workspaceManifestDigest: null, inputDigest: fixture.DIGEST });
    const pending = evaluateInitialRoute({ policy: input.policy, requirements: input.binding.requirements, availability: [], now: fixture.TIMESTAMP }).route;
    const quota = { source: 'typed-native', providerId: 'codex', signalId: 'usageLimitExceeded', scope: 'subscription',
      observedAt: fixture.TIMESTAMP, resetAt: '2026-10-11T01:00:00.000Z', mappingVersion: 'codex-app-server-0.155.1-usage-limit-v1' };
    const automaticTransition = { transitionId: 'transition', successorAttemptId: 'successor', destinationAllocationId: null,
      expectedJournalVersion: 0, workspaceManifest: workspace(), acceptedRoute: { ...pending, source: 'fallback', reasonCode: 'classifier-quota',
        classifierStatus: 'quota-limited', tierId: 'demanding', allocationId: 'demanding-codex' } };
    store.recordOperationCompletion({ ...scope(), operationId: 'operation', completion: completion({ category: 'usage-limit',
      nativeErrorCode: 'usageLimitExceeded', quotaObservation: quota }), automaticTransition });
    const saved = store.getRevision(fixture.identity());
    assert.equal(saved.transitions[0].tierId, 'demanding'); assert.equal(saved.transitions[0].allocationId, 'demanding-claude');
    assert.equal(saved.availability[0].holdoffUntil, quota.resetAt);
  });
});

test('last-tier capability failure exhausts while environmental blockers stay provisional', async () => {
  await withStore(async store => {
    const input = rebindInitial(fixture.policy(), { ...fixture.requirements(), complexity: 'complex' });
    store.claimInitial(input);
    store.reserveOperation({ ...scope(), operation: intent({ tierId: 'demanding', allocationId: 'demanding-codex',
      requested: { modelId: 'fixture-model-2', effort: 'high', runtimeDigest: input.binding.runtimeBindings.codex.runtimeDigest } }) });
    store.claimOperationLaunch({ ...scope(), operationId: 'operation', finalContextDigest: fixture.DIGEST, workspaceManifestDigest: null, inputDigest: fixture.DIGEST });
    store.recordOperationCompletion({ ...scope(), operationId: 'operation', completion: completion(), automaticTransition: null });
    const checkpoint = { checkpointId: 'environment', payloadDigest: fixture.DIGEST, identity: fixture.identity(), attemptId: 'attempt',
      expectedFrontier: 0, supersedesCheckpointId: null, kind: 'verification-failure', cause: 'environment', evidence: evidence('fail'), successorAttemptId: null, now: fixture.TIMESTAMP };
    assert.equal(store.acceptCheckpointAndReserveSuccessor(checkpoint).taskState, 'blocked');
    assert.equal(store.acceptCheckpointAndReserveSuccessor({ ...checkpoint, checkpointId: 'capability', expectedFrontier: 1,
      supersedesCheckpointId: 'environment', cause: 'capability' }).taskState, 'exhausted');
    assert.throws(() => store.reserveProviderSwitch(switchInput({ expectedFrontier: 2 })), { code: 'ECC_ALLOCATION_CONFLICT' });
  });
});

test('lost task completion can be asserted, while an unlaunched successor is safely abandoned', async () => {
  await withStore(async store => {
    store.claimInitial(initial()); store.reserveOperation({ ...scope(), operation: intent() });
    store.claimOperationLaunch({ ...scope(), operationId: 'operation', finalContextDigest: fixture.DIGEST, workspaceManifestDigest: null, inputDigest: fixture.DIGEST });
    assert.throws(() => store.reconcileOperation(recoveryInput({ observedCompletion: null })), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
    assert.throws(() => store.reconcileOperation(recoveryInput({ recoveryEvidence: { ...recoveryInput().recoveryEvidence, oldOwnerCannotLaunch: false } })), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
    assert.equal(store.reconcileOperation(recoveryInput()).taskState, 'awaiting-checkpoint');
    assert.equal(store.getOperation('operation').result.observationOrigin, 'recovery-asserted');
    store.reserveProviderSwitch(switchInput({ expectedFrontier: 1 }));
    const closed = store.reconcileOperation(recoveryInput({ recoveryId: 'abandon', expectedFrontier: 2, action: 'abandon', observedCompletion: null }));
    assert.equal(closed.taskState, 'abandoned');
    assert.equal(store.getRevision(fixture.identity()).attempts.find(attempt => attempt.attemptId === 'successor').state, 'abandoned');
    assert.equal(store.getRevision(fixture.identity(), { private: true }).successorId, null);
  });
});

test('proposal roots record separately and managed context bindings stay strict', async () => {
  await withStore(async (store, dbPath) => {
    const raw = fixture.policy(); const input = rebindInitial({ ...raw, contextProposals: { ...raw.contextProposals,
      codex: { allocationId: 'routine-codex', authorityAcknowledged: true } } });
    const contexts = { ...input.binding.contexts, codex: { mode: 'managed', stateRoot: '/fixture/state', nativeRoot: null, expectedReceiptDigest: fixture.DIGEST } };
    const contextSetDigest = canonicalDigest({ contexts, contextSourceBindings: input.binding.contextSourceBindings });
    const configured = { ...input, binding: { ...input.binding, contexts, contextSetDigest }, capsule: { ...input.capsule, contextSetDigest } };
    store.claimInitial(configured);
    store.reserveOperation({ ...scope(), operation: intent({ phase: 'proposal', finalContextDigest: null }) });
    store.claimOperationLaunch({ ...scope(), operationId: 'operation', finalContextDigest: null, workspaceManifestDigest: null, inputDigest: fixture.DIGEST });
    store.recordOperationCompletion({ ...scope(), operationId: 'operation', completion: completion(), automaticTransition: null });
    store.reserveOperation({ ...scope(), operation: intent({ operationId: 'task-operation' }) });
    assert.equal(store.getRevision(fixture.identity()).operations.length, 2);
    const reopened = await createAllocationStore({ dbPath });
    try { assert.equal(reopened.getRevision(fixture.identity()).operations[0].phase, 'proposal'); }
    finally { reopened.close(); }
  });
});

test('both-provider holdoff preserves the initial capsule and permits explicit no-operation closure', async () => {
  await withStore(async store => {
    const first = initial(); store.claimInitial(first);
    for (const providerId of ['codex', 'claude']) store.recordProviderAvailability({ availability: { providerId,
      runtimeDigest: first.binding.runtimeBindings[providerId].runtimeDigest, reason: 'local-holdoff', observedAt: fixture.TIMESTAMP,
      resetAt: null, holdoffUntil: '2026-10-11T00:00:10.000Z' }, now: fixture.TIMESTAMP });
    store.reconcileOperation(recoveryInput({ operationId: null, action: 'abandon', observedCompletion: null }));
    const input = rebindInitial(fixture.policy(), { ...fixture.requirements(), revision: 2 }, { ...fixture.task(), revision: 2 });
    input.requestId = 'paused-request'; input.attemptId = 'paused-attempt';
    input.route = evaluateInitialRoute({ policy: input.policy, requirements: input.binding.requirements,
      availability: store.getAvailability(), now: fixture.TIMESTAMP }).route;
    assert.equal(store.claimInitial(input).taskState, 'provider-paused');
    assert.equal(store.getRevision(input.identity).operations.length, 0);
    assert.equal(store.getRevision(input.identity, { private: true }).capsule.originalTask.query, fixture.task().query);
    assert.equal(store.reconcileOperation(recoveryInput({ identity: input.identity, recoveryId: 'close-paused', operationId: null,
      action: 'abandon', observedCompletion: null })).taskState, 'abandoned');
  });
});

test('audit capacity stops new root reservation while status and safe recovery remain available', async () => {
  await withStore(async (store, dbPath) => {
    store.claimInitial(initial());
    const ordinary = await createStateStore({ dbPath });
    try { ordinary._database.exec(`WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM n WHERE value < 100000)
      INSERT INTO allocation_events(revision_key,data) SELECT NULL,'{"kind":"fixture","receiptId":"capacity-fixture","payload":{}}' FROM n`); }
    finally { ordinary.close(); }
    assert.throws(() => store.reserveOperation({ ...scope(), operation: intent() }), { code: 'ECC_ALLOCATION_STORAGE_CAPACITY' });
    assert.equal(store.getRevision(fixture.identity()).operations.length, 0);
    assert.equal(store.reconcileOperation(recoveryInput({ operationId: null, action: 'abandon', observedCompletion: null })).taskState, 'abandoned');
    const snapshot = await openAllocationSnapshot({ dbPath });
    try { assert.equal(snapshot.getRevision(fixture.identity()).taskState, 'abandoned'); }
    finally { snapshot.close(); }
  });
});
