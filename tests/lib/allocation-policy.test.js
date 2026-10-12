'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/allocation-fixture');
const { normalizePolicy, normalizeRequirements, canonicalDigest } = require('../../scripts/lib/allocation/validation');
const routing = require('../../scripts/lib/allocation/policy');
const now = fixture.TIMESTAMP;
function setup(change = () => {}) { const raw = fixture.policy(); change(raw); return normalizePolicy(raw); }
function requirements(change = () => {}) { const raw = fixture.requirements(); change(raw); return normalizeRequirements(raw); }
function initial(policy, req, availability = []) { return routing.evaluateInitialRoute({ policy, requirements: req, availability, now }); }

test('all routing combinations respect deterministic precedence and optional classifier', () => {
  const policy = setup(p => { p.classifier = { mode: 'inherited-authority', allocationId: 'routine-codex', authorityAcknowledged: true }; });
  for (const complexity of ['simple', 'moderate', 'complex', 'unknown']) {
    for (const ambiguity of ['clear', 'bounded', 'high', 'unknown']) {
      const req = requirements(r => Object.assign(r, { complexity, ambiguity }));
      const { route, pendingClassifier } = initial(policy, req);
      const tier = complexity === 'complex' || ambiguity === 'high' ? 'demanding'
        : complexity === 'simple' && ambiguity === 'clear' ? 'routine'
          : complexity === 'moderate' && ['clear', 'bounded'].includes(ambiguity) ? 'standard' : null;
      assert.equal(route.tierId, tier, `${complexity}/${ambiguity}`);
      assert.equal(Boolean(pendingClassifier), tier === null);
    }
  }
});

test('risk/phase/capability floors precede explicit and deterministic routing', () => {
  const policy = setup();
  assert.equal(initial(policy, requirements(r => { r.riskAssessment.approvedBy = null; })).route.tierId, 'standard');
  assert.equal(initial(policy, requirements(r => { r.phase = 'implement'; })).route.tierId, 'standard');
  assert.equal(initial(policy, requirements(r => { r.requiredCapabilities = ['code']; })).route.tierId, 'standard');
  assert.throws(() => initial(policy, requirements(r => { r.requiredCapabilities = ['missing']; })), { code: 'ECC_ALLOCATION_INCOMPATIBLE' });
  assert.throws(() => initial(policy, requirements(r => { r.explicitAllocation = 'routine-codex'; r.riskAssessment.approvedBy = null; })));
});

test('compatibility must form suffix and unsupported alternatives are never selected', () => {
  const policy = setup(p => { p.allocations[2].capabilities = []; });
  assert.equal(initial(policy, requirements(r => { r.requiredCapabilities = ['code']; })).route.allocationId, 'standard-claude');
  const gap = setup(p => { p.allocations[0].capabilities = ['code']; p.allocations[1].capabilities = ['code']; p.allocations[2].capabilities = []; p.allocations[3].capabilities = []; });
  assert.throws(() => initial(gap, requirements(r => { r.requiredCapabilities = ['code']; })), { code: 'ECC_ALLOCATION_INCOMPATIBLE' });
});

test('provider holdoff pauses chosen tier without downgrade or higher-tier substitution', () => {
  const policy = setup(); const req = requirements();
  const availability = ['codex', 'claude'].map(providerId => ({ providerId, runtimeDigest: canonicalDigest(policy.providers.find(provider => provider.id === providerId)),
    reason: 'confirmed-usage-limit', observedAt: now, resetAt: null, holdoffUntil: '2026-10-12T00:00:00.000Z' }));
  const { route } = initial(policy, req, availability); assert.equal(route.tierId, 'routine'); assert.equal(route.allocationId, null);
  assert.equal(routing.selectTierAlternative({ policy, tierId: 'routine', requirements: req, availability, visitedIds: [], now }).status, 'provider-paused');
  assert.throws(() => initial(policy, requirements(r => { r.explicitAllocation = 'routine-codex'; }), availability));
});

test('stale other-runtime holdoff does not suppress a newly bound same-ID provider', () => {
  const policy = setup();
  const oldBinding = [{ providerId: 'codex', runtimeDigest: fixture.DIGEST, reason: 'confirmed-usage-limit', observedAt: now,
    resetAt: null, holdoffUntil: '2026-10-12T00:00:00.000Z' }];
  assert.equal(initial(policy, requirements(), oldBinding).route.allocationId, 'routine-codex');
  const matching = [{ ...oldBinding[0], runtimeDigest: canonicalDigest(policy.providers.find(provider => provider.id === 'codex')) }];
  assert.equal(initial(policy, requirements(), matching).route.allocationId, 'routine-claude');
});

test('disabled classifier falls back, single eligible bypasses, exact classifier choice cannot lower floor', () => {
  const policy = setup(); const req = requirements(r => { r.complexity = 'unknown'; });
  assert.equal(initial(policy, req).route.tierId, 'demanding');
  const enabled = setup(p => { p.classifier = { mode: 'inherited-authority', allocationId: 'routine-codex', authorityAcknowledged: true }; p.phaseMinimums.docs = 'demanding'; });
  assert.equal(initial(enabled, req).route.reasonCode, 'sole-eligible');
  const classified = setup(p => { p.classifier = { mode: 'inherited-authority', allocationId: 'routine-codex', authorityAcknowledged: true }; });
  const pendingRoute = initial(classified, requirements(r => { r.complexity = 'unknown'; r.requiredCapabilities = ['code']; }));
  assert.throws(() => routing.validateClassifierChoice({ policy: classified, requirements: req, pendingRoute, response: { tierId: 'routine', reasonCode: 'requirements-match' } }));
  assert.deepEqual(routing.validateClassifierChoice({ policy: classified, requirements: req, pendingRoute,
    response: { tierId: 'standard', reasonCode: 'requirements-match' } }), { tierId: 'standard', reasonCode: 'requirements-match' });
});

test('capability successor advances once while unrelated failure stays blocked', () => {
  const policy = setup(); const revision = { requirements: requirements(), visitedAllocationIds: ['routine-codex'], switchCount: 0 };
  const attempt = { tierId: 'routine', allocationId: 'routine-codex' };
  assert.deepEqual(routing.planCapabilitySuccessor({ policy, revision, attempt, checkpoint: { kind: 'verification-failure', cause: 'capability' }, availability: [], now }),
    { status: 'successor', tierId: 'standard', allocationId: 'standard-codex', reason: 'capability' });
  assert.equal(routing.planCapabilitySuccessor({ policy, revision, attempt, checkpoint: { kind: 'verification-failure', cause: 'environment' }, availability: [], now }).status, 'blocked');
  assert.equal(routing.planCapabilitySuccessor({ policy, revision, attempt: { ...attempt, tierId: 'demanding' }, checkpoint: { kind: 'stalled', cause: 'capability' }, availability: [], now }).status, 'exhausted');
});

test('provider switch stays tier, consumes unvisited different provider and finite global budget', () => {
  const policy = setup(); const revision = { requirements: requirements(), visitedAllocationIds: ['routine-codex'], switchCount: 0 };
  const attempt = { tierId: 'routine', allocationId: 'routine-codex' };
  const sourceOperation = { state: 'completed', result: fixture.result() };
  const args = { policy, revision, attempt, sourceOperation, destinationAllocationId: null, availability: [], now };
  assert.deepEqual(routing.planProviderSwitch(args), { status: 'successor', tierId: 'routine', allocationId: 'routine-claude', reason: 'manual' });
  assert.throws(() => routing.planProviderSwitch({ ...args, destinationAllocationId: 'standard-claude' }));
  assert.throws(() => routing.planProviderSwitch({ ...args, sourceOperation: { state: 'execution-unknown', result: fixture.result() } }));
  assert.equal(routing.planProviderSwitch({ ...args, revision: { ...revision, visitedAllocationIds: ['routine-codex', 'routine-claude'] } }).status, 'provider-paused');
  assert.throws(() => routing.planProviderSwitch({ ...args, revision: { ...revision, switchCount: 2 } }), { code: 'ECC_ALLOCATION_SWITCH_BUDGET_EXHAUSTED' });
});

test('reconciled abnormal observations allow manual switch while preserving actual exit/signal', () => {
  const policy = setup(); const revision = { requirements: requirements(), visitedAllocationIds: ['routine-codex'], switchCount: 0 };
  const attempt = { tierId: 'routine', allocationId: 'routine-codex' };
  const observed = fixture.result({ exitStatus: null, signal: 'SIGTERM', category: 'cancelled', rootCompletion: 'unknown', cessation: 'caller-reconciled' });
  const sourceOperation = { state: 'completed', result: observed };
  const successor = routing.planProviderSwitch({ policy, revision, attempt, sourceOperation, availability: [], now });
  assert.equal(successor.allocationId, 'routine-claude');
  assert.equal(sourceOperation.result.signal, 'SIGTERM'); assert.equal(sourceOperation.result.exitStatus, null);
});
