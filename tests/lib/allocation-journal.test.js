'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/allocation-fixture');
const { buildTaskCapsule, normalizeJournalUpdate, buildPortableContinuation, validateTaskCapsule } = require('../../scripts/lib/allocation/journal');

function capsule() {
  return buildTaskCapsule({ enabled: true, task: fixture.task(), requirementsDigest: fixture.DIGEST,
    policyDigest: fixture.DIGEST, contextSetDigest: fixture.DIGEST, runtimeSetDigest: fixture.DIGEST });
}

test('disabled continuation returns no task capsule or prose', () => {
  assert.equal(buildTaskCapsule({ enabled: false }), null);
});

test('initial capsule retains exact task bindings and empty visible notes without mutating input', () => {
  const task = fixture.task(); const before = structuredClone(task); const value = capsule();
  assert.deepEqual(task, before);
  assert.equal(value.schemaVersion, 'ecc.task-capsule.v1');
  assert.deepEqual(value.originalTask, task);
  assert.deepEqual(value.journal, { plan: [], decisions: [], completed: [], pending: [] });
  assert.equal(value.journalVersion, 0);
  assert.equal(value.workspaceManifestDigest, null);
  assert.deepEqual(validateTaskCapsule(value), value);
});

test('progress replaces the complete journal with a new version and checks the expected version', () => {
  const initial = capsule(); const notes = { plan: ['Change one example'], decisions: [], completed: ['Read docs'], pending: ['Run lint'] };
  const update = normalizeJournalUpdate({ capsule: initial, journal: notes, expectedJournalVersion: 0 });
  assert.equal(update.capsule.journalVersion, 1);
  assert.deepEqual(update.capsule.journal, notes);
  assert.match(update.capsuleDigest, /^[a-f0-9]{64}$/);
  assert.equal(initial.journalVersion, 0);
  notes.plan.push('Later change');
  assert.equal(update.capsule.journal.plan.length, 1);
  assert.throws(() => normalizeJournalUpdate({ capsule: initial, journal: notes, expectedJournalVersion: 1 }), error => error.code === 'ECC_ALLOCATION_CONFLICT');
  assert.equal(normalizeJournalUpdate({ capsule: initial, journal: notes, expectedJournalVersion: 0,
    workspaceManifestDigest: fixture.DIGEST }).capsule.workspaceManifestDigest, fixture.DIGEST);
});

test('journal rejects unknown fields, controls, non-UTF8, oversized notes and aggregate overflow', () => {
  const initial = capsule();
  const bad = [ { plan: [], decisions: [], completed: [], pending: [], secret: 'secret' },
    { plan: ['bad\u001btext'], decisions: [], completed: [], pending: [] },
    { plan: ['\ud800'], decisions: [], completed: [], pending: [] },
    { plan: ['x'.repeat(1025)], decisions: [], completed: [], pending: [] },
    { plan: Array(25).fill('note'), decisions: [], completed: [], pending: [] },
    Object.fromEntries(['plan', 'decisions', 'completed', 'pending'].map(key => [key, Array(24).fill('x'.repeat(1024))])) ];
  for (const journal of bad) assert.throws(() => normalizeJournalUpdate({ capsule: initial, journal, expectedJournalVersion: 0 }));
});

test('capsules reject extra/native session fields, inconsistent identities and missing digests', () => {
  const initial = capsule();
  for (const value of [{ ...initial, nativeSessionId: 'private' }, { ...initial, identity: { ...initial.identity, taskId: 'different' } },
    { ...initial, originalTask: { ...initial.originalTask, query: ' ' } }, { ...initial, policyDigest: null }]) {
    assert.throws(() => validateTaskCapsule(value));
  }
});

test('portable continuation is bounded reference data with original query and claims marked untrusted', () => {
  const value = buildPortableContinuation({ capsule: capsule(), parentAttemptId: 'attempt', parentAllocationId: 'routine-codex',
    outcome: 'usage-limit', verificationIds: ['lint'], workspaceManifestDigest: fixture.DIGEST, summary: 'Continue from current files.' });
  assert.ok(value.input.includes(fixture.task().query));
  assert.ok(value.input.includes('untrusted'));
  assert.ok(value.input.includes(fixture.DIGEST));
  assert.ok(Buffer.byteLength(value.input) <= 8192);
  assert.throws(() => buildPortableContinuation({ capsule: null, parentAttemptId: 'attempt', parentAllocationId: 'tuple',
    outcome: 'usage-limit', verificationIds: [], workspaceManifestDigest: fixture.DIGEST }));
  assert.throws(() => buildPortableContinuation({ capsule: capsule(), parentAttemptId: 'attempt', parentAllocationId: 'tuple',
    outcome: 'usage-limit', verificationIds: [], workspaceManifestDigest: fixture.DIGEST, summary: 'x'.repeat(4097) }));
});
