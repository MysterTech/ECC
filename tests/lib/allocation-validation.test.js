'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/allocation-fixture');
const validation = require('../../scripts/lib/allocation/validation');

test('policy normalization materializes declared defaults without mutating input', () => {
  const raw = fixture.policy(); const before = structuredClone(raw);
  const normalized = validation.normalizePolicy(raw);
  assert.deepEqual(raw, before);
  assert.equal(normalized.limits.classifierTimeoutMs, 30000);
  assert.equal(normalized.limits.proposalTimeoutMs, 30000);
  assert.equal(normalized.limits.taskTimeoutMs, 300000);
  assert.deepEqual(normalized.taskLadder, raw.taskLadder);
});

test('policy rejects unknown recursive fields, invalid references, duplicate targets, unsupported efforts and transports', () => {
  const changes = [
    p => { p.extra = true; }, p => { p.providers[0].authRoute.extra = true; },
    p => { p.allocations[0].effort = 'minimum'; }, p => { p.allocations[1].effort = 'ultra'; },
    p => { p.providers[0].cliVersion = '0.156.0'; }, p => { p.providers[1].target = 'codex'; },
    p => { p.tiers[0].allocationIds[0] = 'missing'; }, p => { p.taskLadder.push('routine'); },
    p => { p.tiers[1].allocationIds[0] = p.tiers[0].allocationIds[0]; },
    p => { p.riskMinimums.low = 'demanding'; }, p => { p.fallbackTier = 'standard'; },
    p => { p.allocations[0].descriptor = 'bad\u001b[2J'; },
    p => { p.providers[0].authRoute.paidExtraUsageDisabled = false; },
    p => { p.contextProposals.claude = { allocationId: 'routine-codex', authorityAcknowledged: true }; },
    p => { p.continuation.enabled = false; }, p => { p.limits.taskSubmittedBytes = 8191; },
  ];
  for (const change of changes) {
    const raw = fixture.policy(); change(raw);
    assert.throws(() => validation.normalizePolicy(raw), { code: 'ECC_ALLOCATION_INVALID_CONFIG' });
  }
});

test('requirements resolve unknowns, preserve risk provenance, and bind task identity', () => {
  const raw = fixture.requirements(); delete raw.complexity; delete raw.ambiguity; delete raw.riskAssessment;
  const normalized = validation.normalizeRequirements(raw, fixture.task());
  assert.equal(normalized.complexity, 'unknown'); assert.equal(normalized.ambiguity, 'unknown');
  assert.equal(normalized.riskAssessment, null); assert.deepEqual(normalized.requiredCapabilities, []);
  assert.equal(normalized.explicitAllocation, null);
  assert.throws(() => validation.normalizeRequirements({ ...raw, revision: 2 }, fixture.task()));
  assert.throws(() => validation.normalizeRequirements({ ...raw, expectedVerification: [] }));
  assert.throws(() => validation.normalizeRequirements({ ...raw, complexity: null }));
});

test('canonical digest ignores object key and unordered capability order but preserves preference order', () => {
  const raw = fixture.policy(); const normalized = validation.normalizePolicy(raw);
  const reordered = fixture.policy(); reordered.allocations[2].capabilities.reverse();
  assert.equal(validation.canonicalDigest(normalized), validation.canonicalDigest(validation.normalizePolicy(reordered)));
  const different = fixture.policy(); different.tiers[0].allocationIds.reverse();
  assert.notEqual(validation.canonicalDigest(normalized), validation.canonicalDigest(validation.normalizePolicy(different)));
  assert.equal(validation.canonicalDigest({ b: 1, a: 2 }), validation.canonicalDigest({ a: 2, b: 1 }));
});

test('run validates every nested context/runtime/acknowledgement and mandatory query', () => {
  const input = validation.normalizeOperationInput('run', fixture.runInput());
  assert.equal(input.task.query, fixture.task().query);
  for (const change of [r => { r.task.query = ' '; }, r => { r.task.query = '\ud800'; },
    r => { r.contexts.codex.extra = true; }, r => { r.runtimeBindings.codex.runtimeDigest = 'oops'; },
    r => { delete r.automaticContinuationAcknowledgement; }, r => { r.requirements.phase = 'debug'; },
    r => { r.repoRoot = 'relative'; }, r => { r.requestId = 'contains spaces'; }]) {
    const raw = fixture.runInput(); change(raw);
    assert.throws(() => validation.normalizeOperationInput('run', raw), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
  }
});

test('typed observations preserve null/actual failure values and require exact certified quota shape', () => {
  const raw = fixture.result({ exitStatus: null, signal: 'SIGTERM', category: 'cancelled', rootCompletion: 'unknown' });
  assert.deepEqual(validation.normalizeTypedResult(raw), raw);
  assert.throws(() => validation.normalizeTypedResult(fixture.result({ category: 'usage-limit' })));
  assert.throws(() => validation.normalizeTypedResult(fixture.result({ exitStatus: -1 })));
  const quota = { source: 'typed-native', providerId: 'codex', signalId: 'usageLimitExceeded', scope: 'subscription',
    observedAt: fixture.TIMESTAMP, resetAt: null, mappingVersion: 'codex-app-server-0.155.1-usage-limit-v1' };
  assert.deepEqual(validation.normalizeTypedResult(fixture.result({ category: 'usage-limit', quotaObservation: quota })).quotaObservation, quota);
  assert.throws(() => validation.normalizeTypedResult(fixture.result({ category: 'usage-limit', quotaObservation: { ...quota, source: 'regex' } })));
});

test('journal/evidence/effect assertions are bounded and recursively strict', () => {
  const journal = { plan: ['Do work'], decisions: [], completed: [], pending: [] };
  assert.deepEqual(validation.normalizeJournal(journal), journal);
  assert.throws(() => validation.normalizeJournal({ ...journal, secret: 'value' }));
  assert.throws(() => validation.normalizeJournal({ ...journal, plan: Array(25).fill('work') }));
  assert.throws(() => validation.normalizeEffectAcknowledgement({ ...fixture.effectAcknowledgement(), relevantWorkStopped: false }));
  const evidence = { assertionOrigin: 'human', assertedBy: 'operator', timestamp: fixture.TIMESTAMP,
    artifactDigest: fixture.DIGEST, workspaceBinding: { head: null, artifactDigest: fixture.DIGEST, source: 'caller-asserted' },
    checks: [{ checkId: 'lint', method: 'static', result: 'pass', evidenceDigest: fixture.DIGEST, referenceId: null }], references: [] };
  assert.deepEqual(validation.normalizeEvidence(evidence), evidence);
  assert.throws(() => validation.normalizeEvidence({ ...evidence, checks: [{ ...evidence.checks[0], evidenceDigest: null }] }));
});

function evidence() {
  return { assertionOrigin: 'human', assertedBy: 'operator', timestamp: fixture.TIMESTAMP,
    artifactDigest: fixture.DIGEST, workspaceBinding: { head: null, artifactDigest: fixture.DIGEST, source: 'caller-asserted' },
    checks: [{ checkId: 'lint', method: 'static', result: 'pass', evidenceDigest: fixture.DIGEST, referenceId: null }], references: [] };
}
function envelopes() {
  const common = { identity: fixture.identity(), attemptId: 'attempt', expectedFrontier: 0 };
  return {
    progress: { ...common, progressId: 'progress', expectedJournalVersion: 0, journal: { plan: [], decisions: [], completed: [], pending: [] } },
    checkpoint: { ...common, checkpointId: 'checkpoint', kind: 'verified-success', cause: 'none', evidence: evidence() },
    next: { ...common, requestId: 'next', originalTask: fixture.task(), parentAttemptId: 'parent', checkpointId: 'checkpoint',
      policyDigest: fixture.DIGEST, runtimeSetDigest: fixture.DIGEST, effectAcknowledgement: fixture.effectAcknowledgement() },
    switch: { ...common, switchId: 'switch', sourceOperationId: 'operation', expectedJournalVersion: 0,
      destinationAllocationId: null, effectAcknowledgement: fixture.effectAcknowledgement() },
    resume: { ...common, requestId: 'resume', parentAttemptId: 'parent', transitionId: 'transition', expectedJournalVersion: 0,
      policyDigest: fixture.DIGEST, runtimeSetDigest: fixture.DIGEST },
    status: { identity: fixture.identity(), operationId: null },
    recover: { identity: fixture.identity(), operationId: 'operation', expectedFrontier: 0, recoveryId: 'recovery', action: 'abandon',
      recoveryEvidence: { assertedBy: 'operator', timestamp: fixture.TIMESTAMP, oldOwnerCannotLaunch: true, relevantWorkStopped: true,
        effectsDisposition: 'retained', references: [], summary: null }, observedCompletion: null },
  };
}

test('all public envelopes round-trip and reject unknown, missing, cross-identity and contradictory fields', () => {
  for (const [operation, payload] of Object.entries(envelopes())) {
    const raw = { schemaVersion: `ecc.allocation-${operation}.v2`, ...payload };
    const normalized = validation.normalizeOperationInput(operation, raw);
    assert.deepEqual(validation.normalizeOperationInput(operation, normalized), normalized);
    assert.throws(() => validation.normalizeOperationInput(operation, { ...raw, unexpected: true }));
    assert.throws(() => validation.normalizeOperationInput(operation, { ...raw, schemaVersion: 'wrong' }));
  }
  const map = envelopes();
  assert.throws(() => validation.normalizeOperationInput('status', { schemaVersion: 'ecc.allocation-status.v2', identity: null, operationId: null }));
  assert.equal(validation.normalizeOperationInput('status', { schemaVersion: 'ecc.allocation-status.v2', identity: null, operationId: 'operation' }).operationId, 'operation');
  assert.throws(() => validation.normalizeOperationInput('next', { schemaVersion: 'ecc.allocation-next.v2', ...map.next, originalTask: { ...fixture.task(), revision: 2 } }));
  assert.throws(() => validation.normalizeOperationInput('checkpoint', { schemaVersion: 'ecc.allocation-checkpoint.v2', ...map.checkpoint, cause: 'capability' }));
  assert.throws(() => validation.normalizeOperationInput('unknown', {}));
  const attached = { schemaVersion: 'ecc.allocation-recover.v2', ...map.recover, action: 'attach-task-completion',
    observedCompletion: fixture.result({ observationOrigin: 'recovery-asserted', cessation: 'caller-reconciled' }) };
  assert.equal(validation.normalizeOperationInput('recover', attached).observedCompletion.observationOrigin, 'recovery-asserted');
  assert.throws(() => validation.normalizeOperationInput('recover', { ...attached, observedCompletion: fixture.result() }));
  assert.equal(validation.normalizeOperationInput('recover', { ...attached, observedCompletion: null }).observedCompletion, null);
});

test('run accepts explicit acknowledged closure, managed contexts and optional resolver controls with strict conflicts', () => {
  const raw = fixture.runInput();
  raw.previousClosureAcknowledgement = { revision: 1, expectedFrontier: 0, effectAcknowledgement: fixture.effectAcknowledgement() };
  raw.automaticContinuationAcknowledgement = fixture.automaticAcknowledgement();
  raw.task.explicitIds = ['skill:feature']; raw.task.proposedIds = []; raw.task.noWorkflow = false;
  raw.contexts.codex = { mode: 'managed', stateRoot: '/fixture/context', nativeRoot: null, expectedReceiptDigest: fixture.DIGEST };
  const normalized = validation.normalizeOperationInput('run', raw);
  assert.deepEqual(validation.normalizeOperationInput('run', normalized), normalized);
  assert.throws(() => validation.normalizeOperationInput('run', { ...raw, task: { ...raw.task, noWorkflow: true } }));
  assert.throws(() => validation.normalizeOperationInput('run', { ...raw, runtimeBindings: { codex: raw.runtimeBindings.codex } }));
  assert.throws(() => validation.normalizeOperationInput('run', { ...raw, automaticContinuationAcknowledgement: { ...fixture.automaticAcknowledgement(), noDetachedOrExternalEffects: false } }));
});

test('normalized requirements are idempotent and set unions/check IDs remain bounded', () => {
  const normalized = validation.normalizeRequirements({ ...fixture.identity(), expectedVerification: fixture.requirements().expectedVerification });
  assert.deepEqual(validation.normalizeRequirements(normalized), normalized);
  assert.throws(() => validation.normalizeRequirements({ ...fixture.requirements(), expectedVerification: [fixture.requirements().expectedVerification[0], fixture.requirements().expectedVerification[0]] }));
  assert.throws(() => validation.normalizeRequirements({ ...fixture.requirements(), requiredCapabilities: Array.from({ length: 16 }, (_, n) => `cap${n}`),
    expectedVerification: [{ checkId: 'check', method: 'unit', requiredCapabilities: ['seventeenth'] }] }));
  assert.throws(() => validation.normalizeIdentity({ ...fixture.identity(), revision: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => validation.normalizeIdentity({ ...fixture.identity(), phase: 'other' }));
});

test('isolated runtime binding, classifier/proposal selection and automatic admission validate exact versions', () => {
  const raw = fixture.policy();
  raw.providers[1].environmentMode = 'isolated-native'; raw.providers[1].cliVersion = '2.1.292';
  raw.providers[1].knownConfigBindings = [{ path: '/fixture/config.json', digest: fixture.DIGEST, normalization: 'raw' }];
  raw.providers[1].nativeBinding = { target: 'claude', stateRoot: '/fixture/state', nativeRoot: '/fixture/native', revision: 1,
    receiptDigest: fixture.DIGEST, generationId: 'generation', generationReceiptDigest: fixture.DIGEST,
    executable: '/fixture/claude', executableDigest: fixture.DIGEST };
  raw.classifier = { mode: 'inherited-authority', allocationId: 'routine-codex', authorityAcknowledged: true };
  raw.contextProposals.claude = { allocationId: 'routine-claude', authorityAcknowledged: true };
  raw.continuation.automaticOnUsageLimit = true;
  assert.deepEqual(validation.normalizePolicy(validation.normalizePolicy(raw)), validation.normalizePolicy(raw));
  assert.throws(() => validation.normalizePolicy({ ...raw, providers: raw.providers.map(p => p.id === 'claude' ? { ...p, cliVersion: '2.1.261' } : p) }));
  const unsupported = fixture.policy(); unsupported.providers[0].transport = 'codex-exec'; unsupported.providers[0].adapterVersion = 'ecc.codex-allocation.v1';
  unsupported.continuation.automaticOnUsageLimit = true;
  assert.throws(() => validation.normalizePolicy(unsupported), { code: 'ECC_ALLOCATION_AUTOMATIC_UNSUPPORTED' });
  unsupported.continuation.automaticOnUsageLimit = false; unsupported.continuation.enabled = false; unsupported.continuation.maxSwitches = 0;
  assert.equal(validation.normalizePolicy(unsupported).continuation.enabled, false);
});

test('text and serialization limits fail safely without echoing input bodies', () => {
  for (const query of ['x'.repeat(8193), '\u0000', '\u001b[31m', '\udc00']) {
    assert.throws(() => validation.normalizeTask({ ...fixture.task(), query }), error => error.code === 'ECC_ALLOCATION_INVALID_INPUT' && !error.message.includes(query));
  }
  assert.throws(() => validation.normalizeJournal({ plan: Array(24).fill('x'.repeat(1024)), decisions: Array(24).fill('x'.repeat(1024)), completed: [], pending: [] }));
  assert.throws(() => validation.normalizePolicy({ ...fixture.policy(), policyVersion: 'x'.repeat(65536) }));
  assert.throws(() => validation.canonicalDigest({ value: undefined }));
  assert.throws(() => validation.normalizeEvidence({ ...evidence(), timestamp: '2026-02-30T00:00:00Z' }));
  assert.equal(validation.normalizeEvidence({ ...evidence(), workspaceBinding: { ...evidence().workspaceBinding, head: 'b'.repeat(40) } }).workspaceBinding.head, 'b'.repeat(40));
});

test('public typed error codes remain stable with prefixed and short constructors', () => {
  const { AllocationError } = require('../../scripts/lib/allocation/errors');
  assert.equal(new AllocationError('ECC_ALLOCATION_INVALID_INPUT', 2, 'Invalid input.').code, 'ECC_ALLOCATION_INVALID_INPUT');
  assert.equal(new AllocationError('INVALID_INPUT', 2, 'Invalid input.').exitCode, 2);
});

test('safe no-operation pause can abandon with null operation ID, but cannot attach completion', () => {
  const raw = { schemaVersion: 'ecc.allocation-recover.v2', ...envelopes().recover, operationId: null };
  assert.equal(validation.normalizeOperationInput('recover', raw).operationId, null);
  assert.throws(() => validation.normalizeOperationInput('recover', { ...raw, action: 'attach-task-completion',
    observedCompletion: fixture.result({ observationOrigin: 'recovery-asserted', cessation: 'caller-reconciled' }) }));
});

test('record collections normalize by ID while declared preference and journal order remain significant', () => {
  const raw = fixture.policy(); const reversed = fixture.policy();
  reversed.providers.reverse(); reversed.allocations.reverse(); reversed.tiers.reverse();
  assert.equal(validation.canonicalDigest(validation.normalizePolicy(raw)), validation.canonicalDigest(validation.normalizePolicy(reversed)));
  const req = fixture.requirements(); req.expectedVerification.push({ checkId: 'aaa', method: 'unit', requiredCapabilities: [] });
  const reordered = structuredClone(req); reordered.expectedVerification.reverse();
  assert.equal(validation.canonicalDigest(validation.normalizeRequirements(req)), validation.canonicalDigest(validation.normalizeRequirements(reordered)));
  assert.notEqual(validation.canonicalDigest(validation.normalizeJournal({ plan: ['A', 'B'], decisions: [], completed: [], pending: [] })),
    validation.canonicalDigest(validation.normalizeJournal({ plan: ['B', 'A'], decisions: [], completed: [], pending: [] })));
});

test('filesystem paths reject every ASCII control while multiline task prose remains valid', () => {
  assert.equal(validation.normalizeTask({ ...fixture.task(), query: 'First line\nSecond line\tIndented' }).query.includes('\n'), true);
  for (const control of ['\n', '\r', '\t', '\u007f', '\u001b']) {
    const raw = fixture.policy(); raw.providers[0].executable = `/fixture/${control}binary`;
    assert.throws(() => validation.normalizePolicy(raw), { code: 'ECC_ALLOCATION_INVALID_CONFIG' });
    assert.throws(() => validation.normalizeOperationInput('run', { ...fixture.runInput(), cwd: `/fixture/${control}workspace` }));
  }
});

test('journal rejects obvious credentialed URLs and recognizable secret tokens without echoing them', () => {
  for (const secret of ['https://username:password@example.com', `sk-proj-${'a'.repeat(32)}`,
    `ghp_${'A'.repeat(36)}`, `Authorization: Bearer ${'b'.repeat(24)}`, `AKIA${'A'.repeat(16)}`]) {
    const journal = { plan: [secret], decisions: [], completed: [], pending: [] };
    assert.throws(() => validation.normalizeJournal(journal), error => error.code === 'ECC_ALLOCATION_INVALID_INPUT' && !error.message.includes(secret));
  }
  assert.equal(validation.normalizeJournal({ plan: ['Document the public https://example.com/docs link.'], decisions: [], completed: [], pending: [] }).plan.length, 1);
});
