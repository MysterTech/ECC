'use strict';

const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const d = require('./allocation-data');
const { TABLES, createAllocationRepository } = require('./allocation-repository');
const { createAllocationReadApi } = require('./allocation-queries');
const { validateStoredOperation } = require('./allocation-entity-validation');

function assertPrivatePath(dbPath, requireFile = true) {
  if (process.platform === 'win32') d.fail('PERSISTENCE_FAILED', 4);
  if (typeof dbPath !== 'string' || !path.isAbsolute(dbPath) || dbPath === ':memory:') d.fail('INVALID_INPUT', 2);
  const parsed = path.parse(dbPath); let current = parsed.root;
  const pieces = dbPath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < pieces.length; index += 1) {
    current = path.join(current, pieces[index]);
    let stats;
    try { stats = fs.lstatSync(current); }
    catch (error) { if (!requireFile && error.code === 'ENOENT') return; throw error; }
    const allowed = process.platform === 'darwin' && stats.uid === 0
      && new Map([['/tmp', '/private/tmp'], ['/var', '/private/var'], ['/etc', '/private/etc']]).get(current) === fs.realpathSync(current);
    if (stats.isSymbolicLink() && !allowed) d.fail('PERSISTENCE_FAILED', 4);
    if (index < pieces.length - 1 && !stats.isDirectory() && !allowed) d.fail('PERSISTENCE_FAILED', 4);
    if (index >= pieces.length - 2 && process.platform !== 'win32'
      && ((stats.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stats.uid !== process.getuid())) d.fail('PERSISTENCE_FAILED', 4);
    if (index === pieces.length - 1 && !stats.isFile()) d.fail('PERSISTENCE_FAILED', 4);
  }
}

function validatePublishedRecords(repository) {
  for (const kind of Object.keys(TABLES)) repository.list(kind);
  for (const stored of repository.list('revision')) {
    const revision = repository.load(stored.identity);
    const attempts = repository.list('attempt', revision.key);
    if (!attempts.some(attempt => attempt.attemptId === revision.currentAttemptId)) d.fail('PERSISTENCE_FAILED', 4);
    if (revision.policy.continuation.enabled) repository.latestCapsule(revision);
    for (const capsule of repository.list('capsule', revision.key)) d.capsule(capsule, revision);
    for (const operation of repository.list('operation', revision.key)) {
      const attempt = attempts.find(attempt => attempt.attemptId === operation.attemptId);
      if (!attempt) d.fail('PERSISTENCE_FAILED', 4);
      try { validateStoredOperation(operation, attempt, revision); } catch (_error) { d.fail('PERSISTENCE_FAILED', 4); }
    }
    for (const transition of repository.list('transition', revision.key)) {
      if (transition.workspaceManifestDigest) {
        const workspace = repository.read('manifest', transition.workspaceManifestDigest);
        if (!workspace) d.fail('PERSISTENCE_FAILED', 4);
        d.manifest(workspace, revision);
      }
    }
  }
}

function validatePublished(repository) {
  try { validatePublishedRecords(repository); }
  catch (_error) { d.fail('PERSISTENCE_FAILED', 4); }
}

async function openAllocationSnapshot({ dbPath }) {
  assertPrivatePath(dbPath);
  const descriptor = fs.openSync(dbPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || process.platform !== 'win32' && (stats.mode & 0o077) !== 0) d.fail('PERSISTENCE_FAILED', 4);
    bytes = fs.readFileSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  const SQL = await initSqlJs(); const raw = new SQL.Database(bytes);
  let closed = false;
  const db = { prepare(sql) {
    return { all(...args) { return query(sql, args, false); }, get(...args) { return query(sql, args, true); } };
  } };
  function query(sql, args, first) {
    if (closed) d.fail('PERSISTENCE_FAILED', 4);
    const statement = raw.prepare(sql);
    try { statement.bind(args); const result = []; while (statement.step()) {
      const row = statement.getAsObject(); if (first) return row; result.push(row);
    } return first ? null : result; } finally { statement.free(); }
  }
  try {
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version = 3').get()) d.fail('PERSISTENCE_FAILED', 4);
    const repository = createAllocationRepository(db, dbPath); validatePublished(repository);
    return { ...createAllocationReadApi(repository), close() { if (!closed) { closed = true; raw.close(); } } };
  } catch (error) { raw.close(); throw error; }
}

module.exports = { openAllocationSnapshot, assertPrivatePath, validatePublished };
