'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixture = require('./helpers/allocation-fixture');
const { withTask } = require('./helpers/allocation-controller-fixture');
const { canonicalDigest } = require('../../scripts/lib/allocation/validation');
const { createAllocationStore } = require('../../scripts/lib/state-store');
const { runAllocationOperation } = require('../../scripts/lib/allocation/controller');

const OBSERVED = { backendId: null, modelId: null, effort: null, nativeContextTokens: null,
  childUsageTokens: null, source: 'unavailable' };
const JOURNAL = { plan: ['Privately update the example'], decisions: ['Keep the existing format'],
  completed: ['Read the example'], pending: ['Run the expected lint check'] };

function invoke(context, operation, input, dependencies = context.dependencies, policy = context.policy) {
  return runAllocationOperation({ operation, input, dbPath: context.dbPath,
    ...(['run', 'next', 'resume'].includes(operation) ? { policy } : {}) }, dependencies);
}
function envelope(operation, fields) { return { schemaVersion: `ecc.allocation-${operation}.v2`, ...fields }; }
function statusInput(identity = fixture.identity()) { return envelope('status', { identity, operationId: null }); }
function switchInput(result, overrides = {}) {
  return envelope('switch', { switchId: 'switch', identity: result.identity, attemptId: result.attemptId,
    sourceOperationId: result.operationId, expectedFrontier: result.frontier,
    expectedJournalVersion: result.journalVersion, destinationAllocationId: null,
    effectAcknowledgement: fixture.effectAcknowledgement(), ...overrides });
}
function resumeInput(switched, parentAttemptId, overrides = {}) {
  return envelope('resume', { requestId: 'resume', identity: switched.identity, attemptId: switched.attemptId,
    parentAttemptId, transitionId: switched.transitionId, expectedFrontier: switched.frontier,
    expectedJournalVersion: switched.journalVersion, policyDigest: switched.route.policyDigest,
    runtimeSetDigest: switched.route.runtimeSetDigest, ...overrides });
}
function progressInput(result, overrides = {}) {
  return envelope('progress', { progressId: 'progress', identity: result.identity, attemptId: result.attemptId,
    expectedFrontier: result.frontier, expectedJournalVersion: result.journalVersion, journal: JOURNAL, ...overrides });
}
function evidence(result = 'pass', overrides = {}) {
  return { assertionOrigin: 'external-runner', assertedBy: 'fixture-runner', timestamp: fixture.TIMESTAMP,
    artifactDigest: fixture.DIGEST, workspaceBinding: { head: null, artifactDigest: fixture.DIGEST,
      source: 'caller-asserted' }, checks: [{ checkId: 'lint', method: 'static', result,
      evidenceDigest: fixture.DIGEST, referenceId: null }], references: [], ...overrides };
}
function checkpointInput(result, overrides = {}) {
  return envelope('checkpoint', { checkpointId: 'checkpoint', identity: result.identity,
    attemptId: result.attemptId, expectedFrontier: result.frontier, supersedesCheckpointId: null,
    kind: 'verified-success', cause: 'none', evidence: evidence(), ...overrides });
}
function nextInput(checkpoint, parentAttemptId, task, overrides = {}) {
  return envelope('next', { requestId: 'next', identity: checkpoint.identity, originalTask: task,
    attemptId: checkpoint.attemptId, parentAttemptId, checkpointId: checkpoint.checkpointId,
    expectedFrontier: checkpoint.frontier, policyDigest: checkpoint.route.policyDigest,
    runtimeSetDigest: checkpoint.route.runtimeSetDigest, effectAcknowledgement: fixture.effectAcknowledgement(),
    handoffSummary: null, ...overrides });
}
function recoveryInput(result, overrides = {}) {
  return envelope('recover', { recoveryId: 'recover', identity: result.identity, operationId: result.operationId,
    expectedFrontier: result.frontier, action: 'attach-task-completion', recoveryEvidence: {
      assertedBy: 'operator', timestamp: fixture.TIMESTAMP, oldOwnerCannotLaunch: true,
      relevantWorkStopped: true, effectsDisposition: 'retained', references: [], summary: 'Private recovery note' },
    observedCompletion: null, ...overrides });
}
function execution(result = fixture.result(), finalText = 'Done', responseFraming = 'single-turn') {
  return { result, observed: OBSERVED, metrics: [], finalText, responseFraming, eventCount: 1 };
}
function scriptExecution(context, replies, changes = {}) {
  return { ...context.dependencies, ...changes, executeOperation: async (request, { beforeSpawn }) => {
    const reply = replies[context.calls.length];
    if (reply instanceof Error) throw reply;
    await beforeSpawn(); context.calls.push(request);
    return typeof reply === 'function' ? reply(request) : reply || execution();
  } };
}
function quotaResult(overrides = {}) {
  return fixture.result({ category: 'usage-limit', nativeErrorCode: 'usageLimitExceeded', quotaObservation: {
    source: 'typed-native', providerId: 'codex', signalId: 'usageLimitExceeded', scope: 'subscription',
    observedAt: fixture.TIMESTAMP, resetAt: null, mappingVersion: 'codex-app-server-0.155.1-usage-limit-v1' }, ...overrides });
}
function automaticPolicy(context) {
  return { ...context.policy, continuation: { ...context.policy.continuation, automaticOnUsageLimit: true } };
}
function classifierPolicy(context) {
  return { ...context.policy, classifier: { mode: 'inherited-authority', allocationId: 'routine-codex',
    authorityAcknowledged: true } };
}
function classifierInput(context) {
  return { ...context.input, requirements: { ...context.input.requirements, ambiguity: 'bounded' } };
}
async function holdProviders(context, providerIds) {
  const store = await createAllocationStore({ dbPath: context.dbPath });
  try {
    for (const providerId of providerIds) store.recordProviderAvailability({ now: fixture.TIMESTAMP,
      availability: { providerId, runtimeDigest: canonicalDigest(context.policy.providers.find(provider => provider.id === providerId)),
        reason: 'local-holdoff', observedAt: fixture.TIMESTAMP, resetAt: null, holdoffUntil: '2026-10-11T00:00:01.000Z' } });
  } finally { store.close(); }
}

for (const source of ['codex', 'claude']) {
  test(`manual ${source} handoff preserves accepted progress, privacy and idempotent resume`, () => withTask(async context => {
    const target = source === 'codex' ? 'claude' : 'codex';
    const input = { ...context.input, requirements: { ...context.input.requirements, explicitAllocation: `routine-${source}` } };
    const first = await invoke(context, 'run', input);
    assert.equal(first.route.allocationId, `routine-${source}`);
    const progress = await invoke(context, 'progress', progressInput(first));
    assert.equal(progress.journalVersion, 1);
    assert.equal((await invoke(context, 'progress', progressInput(first))).replayed, true);
    const stale = await invoke(context, 'progress', progressInput(first, { progressId: 'stale' }));
    assert.equal(stale.code, 'ECC_ALLOCATION_CONFLICT');
    const switched = await invoke(context, 'switch', switchInput({ ...first, journalVersion: 1 }));
    assert.equal(switched.taskState, 'successor-reserved');
    assert.equal(switched.route.tierId, first.route.tierId);
    assert.equal(switched.route.allocationId, `routine-${target}`);
    assert.equal(context.calls.length, 1);
    const resume = resumeInput(switched, first.attemptId);
    const resumed = await invoke(context, 'resume', resume);
    assert.equal(resumed.taskState, 'awaiting-checkpoint');
    assert.equal(context.calls.length, 2);
    assert.equal(context.calls[1].provider.id, target);
    assert.ok(context.calls[1].input.text.includes(JOURNAL.plan[0]));
    assert.ok(context.calls[1].input.text.includes(input.task.query));
    assert.equal((await invoke(context, 'resume', resume)).replayed, true);
    assert.equal(context.calls.length, 2);
    const status = await invoke(context, 'status', statusInput());
    for (const secret of [input.task.query, ...Object.values(JOURNAL).flat(), context.repo]) {
      assert.ok(!JSON.stringify(status).includes(secret));
      assert.ok(!JSON.stringify(resumed).includes(secret));
    }
    const pingPong = await invoke(context, 'switch', switchInput(resumed, { switchId: 'switch-back' }));
    assert.equal(pingPong.code, 'ECC_ALLOCATION_PROVIDER_PAUSED');
    assert.equal(context.calls.length, 2);
  }));
}

test('automatic typed Codex quota switches once to Claude without changing accepted tier', () => withTask(async context => {
  const policy = automaticPolicy(context);
  const input = { ...context.input, automaticContinuationAcknowledgement: fixture.automaticAcknowledgement() };
  const updates = [];
  const dependencies = scriptExecution(context, [execution(quotaResult()), execution()], { onProgress: value => updates.push(value) });
  const first = await invoke(context, 'run', input, dependencies, policy);
  assert.equal(first.taskState, 'awaiting-checkpoint');
  assert.equal(first.route.tierId, 'routine');
  assert.equal(first.route.allocationId, 'routine-claude');
  assert.deepEqual(context.calls.map(call => call.provider.id), ['codex', 'claude']);
  assert.equal(first.operations[0].result.quotaObservation.signalId, 'usageLimitExceeded');
  assert.equal(first.availability[0].holdoffUntil, '2026-10-11T00:00:01.000Z');
  assert.ok(updates.some(update => update.stage === 'provider-switch' && update.providerId === 'claude'));
  const replay = await invoke(context, 'run', input, dependencies, policy);
  assert.equal(replay.replayed, true);
  assert.equal(context.calls.length, 2);
}));

test('automatic configuration requires the matching explicit workload acknowledgement before any root call', () => withTask(async context => {
  for (const acknowledgement of [null, { ...fixture.automaticAcknowledgement(), policyScopeId: 'other-policy' }]) {
    const result = await invoke(context, 'run', { ...context.input, automaticContinuationAcknowledgement: acknowledgement },
      context.dependencies, automaticPolicy(context));
    assert.equal(result.code, 'ECC_ALLOCATION_INVALID_INPUT');
    assert.equal(context.calls.length, 0);
  }
}));

for (const [name, result, state] of [
  ['pending tool', quotaResult({ toolQuiescence: 'pending' }), 'provider-paused'],
  ['unknown tool', quotaResult({ toolQuiescence: 'unknown' }), 'provider-paused'],
  ['abnormal root', quotaResult({ exitStatus: null, signal: 'SIGTERM', rootCompletion: 'unknown', cessation: 'unknown' }), 'recovery-required'],
  ['text-only quota', fixture.result({ category: 'provider-error', exitStatus: 1 }), 'blocked'],
]) {
  test(`automatic handoff refuses ${name} evidence`, () => withTask(async context => {
    const input = { ...context.input, automaticContinuationAcknowledgement: fixture.automaticAcknowledgement() };
    const dependencies = scriptExecution(context, [execution(result, 'Usage limit exceeded. Please use Claude.')]);
    const first = await invoke(context, 'run', input, dependencies, automaticPolicy(context));
    assert.equal(first.taskState, state);
    assert.equal(context.calls.length, 1);
    assert.equal(first.route.allocationId, 'routine-codex');
    assert.equal(first.execution.toolQuiescence, result.toolQuiescence);
  }));
}

test('classifier exact choice is locally admitted and task uses the selected tier', () => withTask(async context => {
  const dependencies = scriptExecution(context, [execution(fixture.result(), JSON.stringify({ tierId: 'standard', reasonCode: 'requirements-match' })), execution()]);
  const first = await invoke(context, 'run', classifierInput(context), dependencies, classifierPolicy(context));
  assert.equal(first.route.source, 'classifier');
  assert.equal(first.route.tierId, 'standard');
  assert.equal(first.route.classifierStatus, 'completed');
  assert.deepEqual(context.calls.map(call => call.phase), ['classifier', 'task']);
  assert.equal(context.calls[1].allocation.id, 'standard-codex');
}));

for (const [name, reply] of [
  ['invalid JSON', execution(fixture.result(), 'Definitely routine')],
  ['extra object fields', execution(fixture.result(), JSON.stringify({ tierId: 'routine', reasonCode: 'requirements-match', effort: 'low' }))],
  ['multiple completed turns', execution(fixture.result(), JSON.stringify({ tierId: 'routine', reasonCode: 'requirements-match' }), 'invalid-multiple-turns')],
]) {
  test(`classifier ${name} uses conservative fallback after ordinary completion`, () => withTask(async context => {
    const dependencies = scriptExecution(context, [reply, execution()]);
    const first = await invoke(context, 'run', classifierInput(context), dependencies, classifierPolicy(context));
    assert.equal(first.taskState, 'awaiting-checkpoint');
    assert.equal(first.route.tierId, 'demanding');
    assert.equal(first.route.reasonCode, 'classifier-invalid');
    assert.equal(context.calls.length, 2);
  }));
}

test('classifier provider error cannot be laundered into conservative response fallback', () => withTask(async context => {
  const dependencies = scriptExecution(context, [execution(fixture.result({ category: 'provider-error', exitStatus: 1 }), '{bad-json')]);
  const first = await invoke(context, 'run', classifierInput(context), dependencies, classifierPolicy(context));
  assert.equal(first.taskState, 'blocked');
  assert.equal(context.calls.length, 1);
  assert.equal(first.route.tierId, null);
}));

test('classifier no-spawn result can fall back without recording a provider invocation', () => withTask(async context => {
  let classifierCalls = 0;
  const dependencies = { ...context.dependencies, executeOperation: async (request, options) => {
    if (request.phase === 'classifier') { classifierCalls++; return execution(fixture.result({
      spawnState: 'not-started', exitStatus: null, category: 'spawn-error', rootCompletion: 'unknown',
      cessation: 'unknown', toolQuiescence: 'not-supported' }), null, 'unobserved'); }
    return context.dependencies.executeOperation(request, options);
  } };
  const first = await invoke(context, 'run', classifierInput(context), dependencies, classifierPolicy(context));
  assert.equal(first.route.reasonCode, 'classifier-no-spawn');
  assert.equal(first.route.tierId, 'demanding');
  assert.equal(first.taskState, 'awaiting-checkpoint');
  assert.equal(classifierCalls, 1);
  assert.equal(context.calls.length, 1);
  assert.equal(first.operations[0].result.spawnState, 'not-started');
}));

test('classifier quota establishes conservative tier and switches before first task', () => withTask(async context => {
  const policy = { ...classifierPolicy(context), continuation: automaticPolicy(context).continuation };
  const input = { ...classifierInput(context), automaticContinuationAcknowledgement: fixture.automaticAcknowledgement() };
  const dependencies = scriptExecution(context, [execution(quotaResult()), execution()]);
  const first = await invoke(context, 'run', input, dependencies, policy);
  assert.equal(first.taskState, 'awaiting-checkpoint');
  assert.equal(first.route.tierId, 'demanding');
  assert.equal(first.route.allocationId, 'demanding-claude');
  assert.deepEqual(context.calls.map(call => [call.phase, call.provider.id]), [['classifier', 'codex'], ['task', 'claude']]);
}));

test('provider-specific context proposals are resolved again after pre-task quota handoff', () => withTask(async context => {
  const policy = { ...automaticPolicy(context), contextProposals: Object.fromEntries(['codex', 'claude'].map(id =>
    [id, { allocationId: `routine-${id}`, authorityAcknowledged: true }])) };
  const input = { ...context.input, automaticContinuationAcknowledgement: fixture.automaticAcknowledgement() };
  const proposals = [];
  const dependencies = scriptExecution(context, [execution(quotaResult()),
    execution(fixture.result(), JSON.stringify({ selectedIds: [] })), execution()], {
    resolveContextPreview: args => ({ ...context.dependencies.resolveContextPreview(args), proposalRequired: true,
      selection: { ...context.dependencies.resolveContextPreview(args).selection, candidates: [{ id: 'fixture-context' }] } }),
    resolveContextProposal: ({ binding, response }) => {
      assert.deepEqual(JSON.parse(response), { selectedIds: [] }); proposals.push(binding.providerId); return binding;
    },
  });
  const result = await invoke(context, 'run', input, dependencies, policy);
  assert.equal(result.taskState, 'awaiting-checkpoint');
  assert.deepEqual(context.calls.map(call => [call.phase, call.provider.id]),
    [['proposal', 'codex'], ['proposal', 'claude'], ['task', 'claude']]);
  assert.deepEqual(proposals, ['claude']);
  assert.equal(result.route.tierId, 'routine');
}));

test('missing required proposal configuration rejects before any provider call', () => withTask(async context => {
  const dependencies = { ...context.dependencies, resolveContextPreview: args =>
    ({ ...context.dependencies.resolveContextPreview(args), proposalRequired: true }) };
  const result = await invoke(context, 'run', context.input, dependencies);
  assert.equal(result.code, 'ECC_ALLOCATION_INVALID_CONFIG');
  assert.equal(context.calls.length, 0);
}));

test('invalid proposal framing blocks without falling back or launching the task', () => withTask(async context => {
  const policy = { ...context.policy, contextProposals: { ...context.policy.contextProposals,
    codex: { allocationId: 'routine-codex', authorityAcknowledged: true } } };
  const dependencies = scriptExecution(context, [execution(fixture.result(), '{"selectedIds":[]}', 'invalid-multiple-turns')], {
    resolveContextPreview: args => ({ ...context.dependencies.resolveContextPreview(args), proposalRequired: args.provider.id === 'codex' }),
    resolveContextProposal: () => assert.fail('multiple-turn proposal must not be admitted'),
  });
  const result = await invoke(context, 'run', context.input, dependencies, policy);
  assert.equal(result.code, 'ECC_ALLOCATION_PROCESS_FAILED');
  assert.equal(context.calls.length, 1);
  assert.equal(context.calls[0].phase, 'proposal');
  assert.equal(result.nextActions.includes('resume'), false);
}));

for (const driftedProvider of ['codex', 'claude']) {
  test(`saved continuation rejects ${driftedProvider} context source drift before claiming or launching`, () => withTask(async context => {
    const first = await invoke(context, 'run', context.input);
    const switched = await invoke(context, 'switch', switchInput(first));
    const dependencies = { ...context.dependencies, resolveContextPreview: args => ({
      ...context.dependencies.resolveContextPreview(args),
      metadataDigest: args.provider.id === driftedProvider ? 'b'.repeat(64) : fixture.DIGEST,
    }) };
    const result = await invoke(context, 'resume', resumeInput(switched, first.attemptId), dependencies);
    assert.equal(result.code, 'ECC_ALLOCATION_BINDING_CHANGED');
    assert.equal(result.taskState, 'successor-reserved');
    assert.equal(context.calls.length, 1);
  }));
}

test('runtime descriptor drift and changed saved policy reject before destination launch', () => withTask(async context => {
  const first = await invoke(context, 'run', context.input);
  const switched = await invoke(context, 'switch', switchInput(first));
  const dependencies = { ...context.dependencies, inspectRuntimeMetadata: async ({ provider }) =>
    ({ runtimeDigest: provider.id === 'claude' ? 'b'.repeat(64) : canonicalDigest(provider) }) };
  const metadataDrift = await invoke(context, 'resume', resumeInput(switched, first.attemptId), dependencies);
  assert.equal(metadataDrift.code, 'ECC_ALLOCATION_BINDING_CHANGED');
  const changedPolicy = { ...context.policy, policyVersion: 'changed-policy' };
  const policyDrift = await invoke(context, 'resume', resumeInput(switched, first.attemptId), context.dependencies, changedPolicy);
  assert.equal(policyDrift.code, 'ECC_ALLOCATION_BINDING_CHANGED');
  assert.equal(context.calls.length, 1);
}));

test('workspace mutation after saved switch blocks continuation and preserves reserved successor', () => withTask(async context => {
  const first = await invoke(context, 'run', context.input);
  const switched = await invoke(context, 'switch', switchInput(first));
  fs.writeFileSync(path.join(context.repo, 'example.md'), 'Changed by another editor\n');
  const result = await invoke(context, 'resume', resumeInput(switched, first.attemptId));
  assert.equal(result.code, 'ECC_ALLOCATION_WORKSPACE_CHANGED');
  assert.equal(result.taskState, 'successor-reserved');
  assert.equal(context.calls.length, 1);
}));

test('workspace mutation between resume preflight and beforeSpawn never invokes destination', () => withTask(async context => {
  const first = await invoke(context, 'run', context.input);
  const switched = await invoke(context, 'switch', switchInput(first));
  const dependencies = { ...context.dependencies, executeOperation: async (request, { beforeSpawn }) => {
    fs.writeFileSync(path.join(context.repo, 'example.md'), 'Late mutation\n');
    await beforeSpawn(); assert.fail('changed workspace must fail the final launch guard');
  } };
  const result = await invoke(context, 'resume', resumeInput(switched, first.attemptId), dependencies);
  assert.equal(result.code, 'ECC_ALLOCATION_WORKSPACE_CHANGED');
  assert.equal(result.execution.spawnState, 'not-started');
  assert.equal(context.calls.length, 1);
}));

test('provisional completion requires matching expected checks before asserted success', () => withTask(async context => {
  const first = await invoke(context, 'run', context.input);
  for (const badEvidence of [evidence('fail'), evidence('pass', { checks: [] }),
    evidence('pass', { checks: [{ ...evidence().checks[0], method: 'unit' }] })]) {
    const result = await invoke(context, 'checkpoint', checkpointInput(first, { evidence: badEvidence }));
    assert.equal(result.code, 'ECC_ALLOCATION_INVALID_INPUT');
    assert.equal(result.taskState, 'awaiting-checkpoint');
  }
  const pendingInput = checkpointInput(first, { checkpointId: 'provisional', kind: 'unverified-completion' });
  const pending = await invoke(context, 'checkpoint', pendingInput);
  assert.equal(pending.taskState, 'awaiting-verification');
  assert.equal((await invoke(context, 'checkpoint', pendingInput)).replayed, true);
  const successInput = checkpointInput({ ...first, frontier: pending.frontier }, { checkpointId: 'verified', supersedesCheckpointId: 'provisional' });
  const success = await invoke(context, 'checkpoint', successInput);
  assert.equal(success.taskState, 'asserted-success');
  assert.deepEqual(success.nextActions, ['inspect', 'new-revision']);
  assert.equal(context.calls.length, 1);
  assert.equal((await invoke(context, 'switch', switchInput(success))).code, 'ECC_ALLOCATION_CONFLICT');
  assert.equal((await invoke(context, 'progress', progressInput(success))).code, 'ECC_ALLOCATION_CONFLICT');
}));

test('capability checkpoint reserves exactly next tier and next reuses original scope and progress', () => withTask(async context => {
  const first = await invoke(context, 'run', context.input);
  const progress = await invoke(context, 'progress', progressInput(first));
  assert.equal(progress.journalVersion, 1);
  const checkpoint = await invoke(context, 'checkpoint', checkpointInput(first, { kind: 'verification-failure',
    cause: 'capability', evidence: evidence('fail') }));
  assert.equal(checkpoint.taskState, 'successor-reserved');
  assert.equal(checkpoint.route.tierId, 'standard');
  assert.equal(context.calls.length, 1);
  const badTask = { ...context.input.task, query: 'Different task scope' };
  const mismatch = await invoke(context, 'next', nextInput(checkpoint, first.attemptId, badTask));
  assert.equal(mismatch.code, 'ECC_ALLOCATION_BINDING_CHANGED');
  assert.equal(context.calls.length, 1);
  const next = nextInput(checkpoint, first.attemptId, context.input.task, { handoffSummary: 'Accepted public handoff note' });
  const result = await invoke(context, 'next', next);
  assert.equal(result.taskState, 'awaiting-checkpoint');
  assert.equal(result.route.tierId, 'standard');
  assert.equal(context.calls.length, 2);
  assert.ok(context.calls[1].input.text.includes(JOURNAL.pending[0]));
  assert.ok(context.calls[1].input.text.includes('Accepted public handoff note'));
  assert.equal((await invoke(context, 'next', next)).replayed, true);
  assert.equal(context.calls.length, 2);
}));

test('top tier capability failure exhausts without another provider launch', () => withTask(async context => {
  const input = { ...context.input, requirements: { ...context.input.requirements, complexity: 'complex' } };
  const first = await invoke(context, 'run', input);
  const result = await invoke(context, 'checkpoint', checkpointInput(first, { kind: 'stalled', cause: 'capability', evidence: evidence('unavailable') }));
  assert.equal(result.taskState, 'exhausted');
  assert.equal(result.code, 'ECC_ALLOCATION_EXHAUSTED');
  assert.equal(context.calls.length, 1);
}));

test('environment checkpoint blocks escalation and can be superseded by new matching evidence', () => withTask(async context => {
  const first = await invoke(context, 'run', context.input);
  const blocked = await invoke(context, 'checkpoint', checkpointInput(first, { kind: 'verification-failure', cause: 'environment', evidence: evidence('unavailable') }));
  assert.equal(blocked.taskState, 'blocked');
  assert.equal(blocked.route.tierId, 'routine');
  assert.equal(context.calls.length, 1);
  const verified = await invoke(context, 'checkpoint', checkpointInput({ ...first, frontier: blocked.frontier },
    { checkpointId: 'resolved', supersedesCheckpointId: 'checkpoint' }));
  assert.equal(verified.taskState, 'asserted-success');
}));

test('known abnormal completion needs cessation recovery before manual continuation and retains original result', () => withTask(async context => {
  const abnormal = fixture.result({ exitStatus: null, signal: 'SIGTERM', category: 'cancelled', rootCompletion: 'unknown',
    cessation: 'unknown', toolQuiescence: 'unknown' });
  const dependencies = scriptExecution(context, [execution(abnormal), execution()]);
  const first = await invoke(context, 'run', context.input, dependencies);
  assert.equal(first.taskState, 'recovery-required');
  assert.equal((await invoke(context, 'switch', switchInput(first))).code, 'ECC_ALLOCATION_RECOVERY_REQUIRED');
  const recovery = recoveryInput(first);
  const recovered = await invoke(context, 'recover', recovery);
  assert.equal(recovered.taskState, 'blocked');
  assert.equal((await invoke(context, 'recover', recovery)).replayed, true);
  assert.deepEqual(recovered.execution, abnormal);
  assert.ok(!JSON.stringify(recovered).includes('Private recovery note'));
  const switched = await invoke(context, 'switch', switchInput(recovered));
  assert.equal(switched.taskState, 'successor-reserved');
  const resumed = await invoke(context, 'resume', resumeInput(switched, first.attemptId), dependencies);
  assert.equal(resumed.taskState, 'awaiting-checkpoint');
  assert.equal(context.calls.length, 2);
  assert.deepEqual(resumed.operations[0].result, abnormal);
}));

test('lost completion recording can be attached explicitly without replaying native work', () => withTask(async context => {
  const dependencies = { ...context.dependencies, createAllocationStore: async options => {
    const store = await createAllocationStore(options);
    return { ...store, recordOperationCompletion() { throw new Error('Private SQL failure'); } };
  } };
  const first = await invoke(context, 'run', context.input, dependencies);
  assert.equal(first.status, 'ran-recording-incomplete');
  assert.equal(first.execution.exitStatus, 0);
  const replay = await invoke(context, 'run', context.input);
  assert.equal(replay.replayed, true);
  assert.equal(context.calls.length, 1);
  const rejected = await invoke(context, 'recover', recoveryInput(first));
  assert.equal(rejected.code, 'ECC_ALLOCATION_INVALID_INPUT');
  const recovery = recoveryInput(first, { recoveryId: 'attach-observation', observedCompletion:
    fixture.result({ observationOrigin: 'recovery-asserted', cessation: 'caller-reconciled' }) });
  const recovered = await invoke(context, 'recover', recovery);
  assert.equal(recovered.taskState, 'awaiting-checkpoint');
  assert.equal(recovered.execution.observationOrigin, 'recovery-asserted');
  assert.equal(context.calls.length, 1);
  assert.ok(!JSON.stringify(first).includes('Private SQL failure'));
}));

test('abandonment permits a new revision only with precise closure acknowledgement', () => withTask(async context => {
  const dependencies = scriptExecution(context, [execution(fixture.result({ category: 'provider-error', exitStatus: 1 })), execution()]);
  const first = await invoke(context, 'run', context.input, dependencies);
  const abandoned = await invoke(context, 'recover', recoveryInput(first, { action: 'abandon' }));
  assert.equal(abandoned.taskState, 'abandoned');
  const nextRevision = { ...context.input, requestId: 'new-revision', task: { ...context.input.task, revision: 2 },
    requirements: { ...context.input.requirements, revision: 2 } };
  const missingAck = await invoke(context, 'run', nextRevision, dependencies);
  assert.equal(missingAck.code, 'ECC_ALLOCATION_CONFLICT');
  assert.equal(context.calls.length, 1);
  const next = await invoke(context, 'run', { ...nextRevision, previousClosureAcknowledgement: {
    revision: 1, expectedFrontier: abandoned.frontier, effectAcknowledgement: fixture.effectAcknowledgement() } }, dependencies);
  assert.equal(next.taskState, 'awaiting-checkpoint');
  assert.equal(next.identity.revision, 2);
  assert.equal(context.calls.length, 2);
}));

test('simultaneous handles cannot duplicate the root invocation and active work rejects manual switching', () => withTask(async context => {
  let notifyStarted;
  const started = new Promise(resolve => { notifyStarted = resolve; });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const dependencies = { ...context.dependencies, executeOperation: async (request, { beforeSpawn }) => {
    await beforeSpawn(); context.calls.push(request); notifyStarted(); await pending; return execution();
  } };
  const first = invoke(context, 'run', context.input, dependencies);
  await started;
  try {
    const active = await invoke(context, 'status', statusInput());
    assert.equal(active.taskState, 'active');
    const duplicate = await invoke(context, 'run', context.input, dependencies);
    assert.equal(duplicate.code, 'ECC_ALLOCATION_BUSY');
    assert.equal(duplicate.replayed, true);
    const newRequest = await invoke(context, 'run', { ...context.input, requestId: 'different-request' }, dependencies);
    assert.equal(newRequest.code, 'ECC_ALLOCATION_CONFLICT');
    const newRevision = await invoke(context, 'run', { ...context.input, requestId: 'premature-revision',
      task: { ...context.input.task, revision: 2 }, requirements: { ...context.input.requirements, revision: 2 } }, dependencies);
    assert.equal(newRevision.code, 'ECC_ALLOCATION_CONFLICT');
    const switched = await invoke(context, 'switch', switchInput(active));
    assert.equal(switched.code, 'ECC_ALLOCATION_RECOVERY_REQUIRED');
    assert.equal(context.calls.length, 1);
  } finally { release(); }
  const done = await first;
  assert.equal(done.taskState, 'awaiting-checkpoint');
  assert.equal(context.calls.length, 1);
}));

test('capability escalation keeps next tier when preferred provider is unavailable', () => withTask(async context => {
  const first = await invoke(context, 'run', context.input);
  await holdProviders(context, ['codex']);
  const checkpoint = await invoke(context, 'checkpoint', checkpointInput(first,
    { kind: 'verification-failure', cause: 'capability', evidence: evidence('fail') }));
  assert.equal(checkpoint.route.tierId, 'standard');
  assert.equal(checkpoint.route.allocationId, 'standard-claude');
  const next = await invoke(context, 'next', nextInput(checkpoint, first.attemptId, context.input.task));
  assert.equal(next.taskState, 'awaiting-checkpoint');
  assert.equal(next.route.allocationId, 'standard-claude');
  assert.deepEqual(context.calls.map(call => call.provider.id), ['codex', 'claude']);
}));

test('no available provider pauses capability escalation without changing floors or launching', () => withTask(async context => {
  const first = await invoke(context, 'run', context.input);
  await holdProviders(context, ['codex', 'claude']);
  const checkpoint = await invoke(context, 'checkpoint', checkpointInput(first,
    { kind: 'verification-failure', cause: 'capability', evidence: evidence('fail') }));
  assert.equal(checkpoint.taskState, 'provider-paused');
  assert.equal(checkpoint.code, 'ECC_ALLOCATION_PROVIDER_PAUSED');
  assert.equal(checkpoint.transitionId, null);
  assert.equal(context.calls.length, 1);
}));

test('status by operation uses a passive snapshot and omits private task material', () => withTask(async context => {
  const first = await invoke(context, 'run', context.input);
  const before = fs.statSync(context.dbPath).mtimeMs;
  const forbidden = { ...context.dependencies, createAllocationStore: () => assert.fail('status must not open mutable DB'),
    inspectRuntime: () => assert.fail('status must not inspect auth'), executeOperation: () => assert.fail('status must not execute') };
  const status = await invoke(context, 'status', envelope('status', { identity: null, operationId: first.operationId }), forbidden);
  assert.deepEqual(status.identity, fixture.identity());
  assert.equal(status.taskState, 'awaiting-checkpoint');
  assert.equal(fs.statSync(context.dbPath).mtimeMs, before);
  assert.ok(!JSON.stringify(status).includes(context.input.task.query));
  const missing = await invoke(context, 'status', envelope('status', { identity: null, operationId: 'missing' }), forbidden);
  assert.equal(missing.code, 'ECC_ALLOCATION_CONFLICT');
}));

test('continuation disabled launches normally but journal/switch operations reject', () => withTask(async context => {
  const policy = { ...context.policy, continuation: { ...context.policy.continuation, enabled: false, maxSwitches: 0 } };
  const first = await invoke(context, 'run', context.input, context.dependencies, policy);
  assert.equal(first.taskState, 'awaiting-checkpoint');
  assert.equal(first.journalVersion, null);
  const progress = await invoke(context, 'progress', progressInput(first, { expectedJournalVersion: 0 }));
  assert.equal(progress.code, 'ECC_ALLOCATION_CAPSULE_UNAVAILABLE');
  const switched = await invoke(context, 'switch', switchInput(first, { expectedJournalVersion: 0 }));
  assert.notEqual(switched.code, 'ECC_ALLOCATION_OK');
  assert.equal(context.calls.length, 1);
  assert.equal(first.nextActions.includes('switch'), false);
}));

test('fresh pre-spawn authentication mismatch records a no-spawn failure without task invocation', () => withTask(async context => {
  let authCalls = 0;
  const dependencies = { ...context.dependencies, inspectRuntime: async args => {
    const observed = await context.dependencies.inspectRuntime(args); authCalls++;
    return { ...observed, routeDigest: authCalls === 1 ? observed.routeDigest : 'b'.repeat(64) };
  } };
  const result = await invoke(context, 'run', context.input, dependencies);
  assert.equal(result.code, 'ECC_ALLOCATION_AUTH_ROUTE_UNVERIFIED');
  assert.equal(result.execution.spawnState, 'not-started');
  assert.equal(result.taskState, 'blocked');
  assert.equal(context.calls.length, 0);
}));

test('exception after actual launch is execution-unknown and requires explicit recovery', () => withTask(async context => {
  const dependencies = { ...context.dependencies, executeOperation: async (request, { beforeSpawn }) => {
    await beforeSpawn(); context.calls.push(request); throw new Error('Private controller transport failure');
  } };
  const first = await invoke(context, 'run', context.input, dependencies);
  assert.equal(first.taskState, 'recovery-required');
  assert.equal(first.execution.category, 'controller-lost');
  assert.equal(first.execution.spawnState, 'unknown');
  assert.ok(!JSON.stringify(first).includes('Private controller transport failure'));
  const replay = await invoke(context, 'run', context.input);
  assert.equal(replay.replayed, true);
  assert.equal(context.calls.length, 1);
  const abandoned = await invoke(context, 'recover', recoveryInput(first, { action: 'abandon' }));
  assert.equal(abandoned.taskState, 'abandoned');
}));

test('working repository identities reject symlinks, missing roots, subdirectories and non-Git directories', () => withTask(async context => {
  const linked = path.join(context.directory, 'linked');
  fs.symlinkSync(context.repo, linked);
  const subdirectory = path.join(context.repo, 'subdirectory'); fs.mkdirSync(subdirectory);
  const nonGit = path.join(context.directory, 'non-git'); fs.mkdirSync(nonGit);
  for (const [repoRoot, cwd, code] of [
    [linked, linked, 'ECC_ALLOCATION_BINDING_CHANGED'],
    [path.join(context.directory, 'missing'), path.join(context.directory, 'missing'), 'ECC_ALLOCATION_BINDING_CHANGED'],
    [context.repo, subdirectory, 'ECC_ALLOCATION_INVALID_INPUT'],
    [nonGit, nonGit, 'ECC_ALLOCATION_INVALID_INPUT'],
  ]) {
    const result = await invoke(context, 'run', { ...context.input, repoRoot, cwd });
    assert.equal(result.code, code);
    assert.equal(context.calls.length, 0);
  }
}));

test('all-provider preflight rejects missing source keys and runtime metadata before inference', () => withTask(async context => {
  const missing = await invoke(context, 'run', { ...context.input,
    contexts: { codex: context.input.contexts.codex }, runtimeBindings: { codex: context.input.runtimeBindings.codex } });
  assert.equal(missing.code, 'ECC_ALLOCATION_INVALID_INPUT');
  const suppliedDrift = await invoke(context, 'run', { ...context.input, runtimeBindings: {
    ...context.input.runtimeBindings, claude: { runtimeDigest: 'b'.repeat(64) } } });
  assert.equal(suppliedDrift.code, 'ECC_ALLOCATION_BINDING_CHANGED');
  const metadataDrift = await invoke(context, 'run', context.input, { ...context.dependencies,
    inspectRuntimeMetadata: async () => ({ runtimeDigest: 'b'.repeat(64) }) });
  assert.equal(metadataDrift.code, 'ECC_ALLOCATION_BINDING_CHANGED');
  const insideHome = await invoke(context, 'run', context.input, { ...context.dependencies,
    inspectRuntimeMetadata: async ({ provider }) => ({ runtimeDigest: canonicalDigest(provider), providerHome: context.repo }) });
  assert.equal(insideHome.code, 'ECC_ALLOCATION_INVALID_CONFIG');
  assert.equal(context.calls.length, 0);
}));

test('database path admission rejects workspace storage, relative paths and untrusted in-memory use', () => withTask(async context => {
  // A private repository directory must still fail the workspace exclusion,
  // rather than rely on the database permission guard to reject a public one.
  fs.chmodSync(context.repo, 0o700);
  for (const dbPath of [path.join(context.repo, 'state.db'), 'relative.db', ':memory:']) {
    const result = await runAllocationOperation({ operation: 'run', input: context.input, policy: context.policy, dbPath }, context.dependencies);
    assert.equal(result.code, 'ECC_ALLOCATION_INVALID_INPUT');
  }
  assert.equal(context.calls.length, 0);
  assert.equal(fs.existsSync(path.join(context.repo, 'state.db')), false);
}));

test('explicit fixture in-memory opt-in retains full isolated task lifecycle', () => withTask(async context => {
  const result = await runAllocationOperation({ operation: 'run', input: context.input, policy: context.policy, dbPath: ':memory:' },
    { ...context.dependencies, allowInMemory: true });
  assert.equal(result.taskState, 'awaiting-checkpoint');
  assert.equal(context.calls.length, 1);
  assert.equal(fs.existsSync(context.dbPath), false);
}));

test('rolling progress is accepted while the provider is active and survives its later quota handoff', () => withTask(async context => {
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const input = { ...context.input, automaticContinuationAcknowledgement: fixture.automaticAcknowledgement() };
  const dependencies = { ...context.dependencies, executeOperation: async (request, { beforeSpawn }) => {
    await beforeSpawn(); context.calls.push(request);
    if (context.calls.length === 1) { signalStarted(); await pending; return execution(quotaResult()); }
    return execution();
  } };
  const first = invoke(context, 'run', input, dependencies, automaticPolicy(context));
  await started;
  try {
    const active = await invoke(context, 'status', statusInput());
    assert.equal(active.taskState, 'active');
    const progress = await invoke(context, 'progress', progressInput(active));
    assert.equal(progress.journalVersion, 1);
    assert.equal(progress.taskState, 'active');
    assert.equal(context.calls.length, 1);
    assert.ok(!JSON.stringify(progress).includes(JOURNAL.pending[0]));
  } finally { release(); }
  const completed = await first;
  assert.equal(completed.taskState, 'awaiting-checkpoint');
  assert.equal(completed.journalVersion, 1);
  assert.equal(context.calls.length, 2);
  assert.ok(context.calls[1].input.text.includes(JOURNAL.completed[0]));
  assert.equal(completed.route.tierId, 'routine');
}));
