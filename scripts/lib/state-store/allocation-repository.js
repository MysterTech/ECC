'use strict';

const fs = require('fs');
const { assertValidEntity } = require('./schema');
const data = require('./allocation-data');
const { validateStoredEntity, validateStoredIdentity } = require('./allocation-entity-validation');

const TABLES = {
  policy: 'allocation_policies', revision: 'allocation_revisions', frontier: 'allocation_frontiers',
  attempt: 'allocation_attempts', operation: 'allocation_operations', checkpoint: 'allocation_checkpoints',
  recovery: 'allocation_recoveries', transition: 'allocation_transitions', availability: 'allocation_availability',
  capsule: 'allocation_capsules', progress: 'allocation_progress', manifest: 'allocation_workspace_manifests',
};
const ENTITY = Object.fromEntries(Object.keys(TABLES).map(key => [key, `allocation${key[0].toUpperCase()}${key.slice(1)}`]));
const CAPS = { policy: 65536, revision: 65536, capsule: 49152, progress: 49152, manifest: 2 * 1024 * 1024 };

function validate(kind, value, key = null) {
  data.bounded(value, CAPS[kind] || 16384);
  assertValidEntity(ENTITY[kind], value);
  validateStoredEntity(kind, value);
  if (key !== null) validateStoredIdentity(kind, value, key);
  return data.clone(value);
}

function createAllocationRepository(db, dbPath) {
  function read(kind, key) {
    const row = db.prepare(`SELECT id,data FROM ${TABLES[kind]} WHERE id = ?`).get(key);
    if (!row) return null;
    try { return validate(kind, JSON.parse(row.data), row.id); }
    catch (_error) { data.fail('PERSISTENCE_FAILED', 4); }
  }
  function list(kind, revision = null) {
    const query = `SELECT id,data FROM ${TABLES[kind]}${revision === null ? '' : ' WHERE revision_key = ?'} ORDER BY rowid`;
    const rows = revision === null ? db.prepare(query).all() : db.prepare(query).all(revision);
    return rows.map(row => {
      try { return validate(kind, JSON.parse(row.data), row.id); }
      catch (_error) { data.fail('PERSISTENCE_FAILED', 4); }
    });
  }
  function write(kind, key, value, columns = {}, update = false) {
    const normalized = validate(kind, value, key);
    const fields = { id: key, ...columns, data: JSON.stringify(normalized) };
    if (update) {
      db.prepare(`UPDATE ${TABLES[kind]} SET data = @data WHERE id = @id`).run({ id: key, data: fields.data });
      if (!read(kind, key)) data.fail('PERSISTENCE_FAILED', 4);
    } else {
      const names = Object.keys(fields);
      db.prepare(`INSERT INTO ${TABLES[kind]} (${names.join(',')}) VALUES (${names.map(name => `@${name}`).join(',')})`).run(fields);
    }
    return normalized;
  }
  function register(id, kind, scope, payloadDigest, ownerId = null) {
    data.id(id); data.digest(payloadDigest);
    if (db.prepare('SELECT id FROM allocation_ids WHERE id = ?').get(id)) data.fail();
    db.prepare('INSERT INTO allocation_ids(id,kind,scope,payload_digest,owner_id,receipt) VALUES(@id,@kind,@scope,@payloadDigest,@ownerId,NULL)')
      .run({ id, kind, scope, payloadDigest, ownerId });
  }
  function replay(id, kind, scope, payloadDigest) {
    const row = db.prepare('SELECT * FROM allocation_ids WHERE id = ?').get(id);
    if (!row) return null;
    if (row.kind !== kind || row.scope !== scope || row.payload_digest !== payloadDigest) data.fail();
    if (!row.receipt) data.fail('BUSY', 3);
    const receipt = JSON.parse(row.receipt);
    assertValidEntity('allocationReceipt', receipt);
    return { ...receipt, replayed: true };
  }
  function saveReceipt(id, receipt) {
    assertValidEntity('allocationReceipt', receipt);
    db.prepare('UPDATE allocation_ids SET receipt = @receipt WHERE id = @id').run({ id, receipt: JSON.stringify(receipt) });
    db.prepare("UPDATE allocation_ids SET finalized = 1 WHERE id = @id AND kind NOT IN ('run','next','resume')").run({ id });
    return data.clone(receipt);
  }
  function event(kind, revision, receiptId, payload) {
    const record = data.bounded({ kind, receiptId, payload });
    db.prepare('INSERT INTO allocation_events(revision_key,data) VALUES(@revision,@data)').run({ revision, data: JSON.stringify(record) });
  }
  function capacity() {
    const count = db.prepare('SELECT COUNT(*) AS count FROM allocation_events').get().count;
    if (count >= 100000 || (dbPath !== ':memory:' && fs.statSync(dbPath).size >= 64 * 1024 * 1024)) data.fail('STORAGE_CAPACITY', 4);
  }
  function load(identity) {
    const key = data.revisionKey(identity);
    const revision = read('revision', key);
    if (!revision) data.fail('CONFLICT', 3);
    const frontier = read('frontier', key);
    const policy = read('policy', revision.policyDigest);
    if (!frontier || !policy) data.fail('PERSISTENCE_FAILED', 4);
    const loaded = { ...revision, ...frontier, policy, key };
    try { data.binding(revision.binding, policy, revision.identity); } catch (_error) { data.fail('PERSISTENCE_FAILED', 4); }
    return loaded;
  }
  function updateFrontier(revision, changes) {
    const current = read('frontier', revision.key);
    const updated = write('frontier', revision.key, { ...current, ...changes }, {}, true);
    if (changes.taskState) {
      const attempt = read('attempt', updated.currentAttemptId);
      if (attempt) write('attempt', updated.currentAttemptId, { ...attempt, state: changes.taskState }, {}, true);
    }
    return { ...revision, ...updated };
  }
  function currentAttempt(revision, attemptId = revision.currentAttemptId) {
    const attempt = read('attempt', attemptId);
    if (!attempt || !list('attempt', revision.key).some(value => value.attemptId === attemptId)) data.fail();
    return attempt;
  }
  function checkFrontier(revision, input, owner = false) {
    if (revision.frontier !== input.expectedFrontier) data.fail();
    if (owner && currentAttempt(revision).claimedBy !== input.ownerId) data.fail();
  }
  function receipt(revision, receiptId, fields = {}) {
    return { replayed: false, receiptId, outcomeCode: 'ECC_ALLOCATION_OK', frontier: revision.frontier,
      journalVersion: revision.journalVersion, taskState: revision.taskState, attemptId: revision.currentAttemptId,
      operationId: null, transitionId: null, checkpointId: null, ...fields };
  }
  function latestCapsule(revision) {
    if (!revision.policy.continuation.enabled) return null;
    const value = read('capsule', `${revision.key}:${revision.journalVersion}`);
    if (!value) data.fail('CAPSULE_UNAVAILABLE', 4);
    return data.capsule(value, revision);
  }
  function publicRevision(revision) {
    const operations = list('operation', revision.key).map(({ ownerId: _owner, createdAt: _created,
      completedAt: _completed, inputDigest: _input, finalContextDigest: _context,
      workspaceManifestDigest: _workspace, runtimeDigest: _runtime, ...operation }) => operation);
    return { identity: revision.identity, frontier: revision.frontier, journalVersion: revision.journalVersion,
      taskState: revision.taskState, currentAttemptId: revision.currentAttemptId, route: revision.route,
      policyDigest: revision.policyDigest, runtimeSetDigest: revision.binding.runtimeSetDigest,
      switchCount: revision.switchCount, attempts: list('attempt', revision.key), operations,
      transitions: list('transition', revision.key), checkpoints: list('checkpoint', revision.key),
      availability: list('availability').filter(value => revision.policy.providers.some(provider => provider.id === value.providerId)
        && revision.binding.runtimeBindings[value.providerId].runtimeDigest === value.runtimeDigest) };
  }
  return { db, dbPath, read, list, write, register, replay, saveReceipt, event, capacity, load, updateFrontier,
    currentAttempt, checkFrontier, receipt, latestCapsule, publicRevision };
}

module.exports = { createAllocationRepository, TABLES, validate };
