'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { validateRelativePath } = require('../context-profile-support');
const v = require('./validation-primitives');
const { AllocationError, fail } = require('./errors');

const COMPILED_EXCLUSIONS = Object.freeze(['build-output', 'dependency-output', 'git-ignored',
  'git-metadata', 'private-harness', 'test-cache']);
const BUILD = new Set(['build', 'dist', 'coverage']);
const DEPENDENCIES = new Set(['node_modules', '.venv', 'venv']);
const CACHE = new Set(['__pycache__', '.pytest_cache', '.cache']);
const PRIVATE = new Set(['.ecc-allocation', '.ecc-state']);
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function canonicalRoot(raw) {
  v.absolute(raw);
  const initial = fs.lstatSync(raw);
  if (!initial.isDirectory() || initial.isSymbolicLink()) fail('BINDING_CHANGED', 'The workspace root is unsafe.');
  const root = fs.realpathSync(raw); const stat = fs.lstatSync(root);
  const platformPath = process.platform === 'darwin' ? path.resolve(raw).replace(/^\/(tmp|var)(?=\/|$)/, '/private/$1') : path.resolve(raw);
  if (root !== platformPath) fail('BINDING_CHANGED', 'A workspace root ancestor is symlinked.');
  return { root, identity: { repoRoot: root, device: stat.dev, inode: stat.ino, mode: stat.mode } };
}

function gitEnvironment() {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

function safeGit(root, args, nullable = false) {
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', root, ...args], {
    shell: false, encoding: 'buffer', timeout: 10000, maxBuffer: MAX_MANIFEST_BYTES, env: gitEnvironment() });
  if (nullable && result.status === 128 && !result.error) return null;
  if (result.status !== 0 || result.error || result.signal || !Buffer.isBuffer(result.stdout)) {
    fail('WORKSPACE_CHANGED', 'The workspace Git metadata could not be read safely.');
  }
  const text = result.stdout.toString('utf8');
  if (!Buffer.from(text).equals(result.stdout)) fail('WORKSPACE_CHANGED', 'The workspace contains invalid filename encoding.');
  return text;
}

function excluded(relative) {
  const parts = relative.split('/');
  return parts.some(part => part === '.git' || BUILD.has(part) || DEPENDENCIES.has(part) || CACHE.has(part) || PRIVATE.has(part))
    || /(?:^|\/)\.(?:codex|claude)\/(?:auth\.json|\.?credentials(?:\.json)?)(?:\/|$)/.test(relative);
}

function names(root) {
  const tracked = safeGit(root, ['ls-files', '--cached', '-z', '--']).split('\0').filter(Boolean);
  const untracked = safeGit(root, ['ls-files', '--others', '--exclude-standard', '-z', '--']).split('\0').filter(Boolean);
  if (tracked.length + untracked.length > 10000) fail('STORAGE_CAPACITY', 'The workspace path limit was exceeded.', 4);
  const known = new Set(tracked);
  return [...new Set([...tracked, ...untracked])].sort().map(relative => {
    validateRelativePath(relative);
    if (Buffer.byteLength(relative) > 1024) fail('STORAGE_CAPACITY', 'The workspace filename limit was exceeded.', 4);
    return { path: relative, tracking: known.has(relative) ? 'tracked' : 'untracked' };
  }).filter(entry => !excluded(entry.path));
}

function inspectChain(root, relative) {
  const segments = relative.split('/'); const chain = []; let current = root;
  const ancestors = [root, ...segments.map(segment => { current = path.join(current, segment); return current; })];
  for (let index = 0; index < ancestors.length; index++) {
    const stat = fs.lstatSync(ancestors[index], { throwIfNoEntry: false });
    if (!stat) return { chain, missing: true, file: ancestors[ancestors.length - 1] };
    if (stat.isSymbolicLink() || (index < ancestors.length - 1 && !stat.isDirectory())) {
      fail('WORKSPACE_CHANGED', 'A workspace file or ancestor is unsafe.');
    }
    chain.push({ path: ancestors[index], stat });
  }
  return { chain, missing: false, file: ancestors[ancestors.length - 1] };
}

function sameStat(left, right, content = false) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && (!content || (left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs));
}

function assertChain(chain) {
  for (const entry of chain) {
    const actual = fs.lstatSync(entry.path, { throwIfNoEntry: false });
    if (!actual || actual.isSymbolicLink() || !sameStat(entry.stat, actual)) fail('WORKSPACE_CHANGED', 'The workspace changed during capture.');
  }
}

function fileEntry(root, entry, budget) {
  const inspected = inspectChain(root, entry.path);
  if (inspected.missing) {
    assertChain(inspected.chain);
    if (entry.tracking !== 'tracked') fail('WORKSPACE_CHANGED', 'An untracked file disappeared during capture.');
    return { entry: { ...entry, kind: 'deleted', digest: null, bytes: null }, inspected, before: null };
  }
  const before = inspected.chain[inspected.chain.length - 1].stat;
  if (!before.isFile()) fail('WORKSPACE_CHANGED', 'Workspace capture requires regular files.');
  if (before.size > MAX_FILE_BYTES || budget.bytes + before.size > MAX_TOTAL_BYTES) {
    fail('STORAGE_CAPACITY', 'The workspace byte limit was exceeded.', 4);
  }
  const descriptor = fs.openSync(inspected.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  try {
    assertChain(inspected.chain); const opened = fs.fstatSync(descriptor);
    if (!sameStat(before, opened, true)) fail('WORKSPACE_CHANGED', 'A workspace file changed before hashing.');
    const body = Buffer.alloc(before.size + 1); let bytes = 0;
    while (bytes < body.length) {
      const count = fs.readSync(descriptor, body, bytes, body.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    assertChain(inspected.chain);
    if (bytes !== before.size || !sameStat(before, fs.fstatSync(descriptor), true)) {
      fail('WORKSPACE_CHANGED', 'A workspace file changed during hashing.');
    }
    budget.bytes += bytes;
    return { entry: { ...entry, kind: 'file', digest: hash(body.subarray(0, bytes)), bytes }, inspected, before };
  } finally { fs.closeSync(descriptor); }
}

function gitSnapshot(root) {
  const metadata = fs.lstatSync(path.join(root, '.git'), { throwIfNoEntry: false });
  if (!metadata || metadata.isSymbolicLink()) fail('WORKSPACE_CHANGED', 'The workspace Git directory is unsafe.');
  const head = safeGit(root, ['rev-parse', '--verify', 'HEAD'], true);
  if (head !== null && !/^[a-f0-9]{40,64}\n$/.test(head)) fail('WORKSPACE_CHANGED', 'The workspace HEAD is invalid.');
  const index = path.resolve(root, safeGit(root, ['rev-parse', '--git-path', 'index']).trim());
  const stat = fs.lstatSync(index, { throwIfNoEntry: false });
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES)) fail('WORKSPACE_CHANGED', 'The workspace Git index is unsafe.');
  const indexDigest = stat ? hash(fs.readFileSync(index)) : null;
  if (stat && !sameStat(stat, fs.lstatSync(index), true)) fail('WORKSPACE_CHANGED', 'The workspace Git index changed during capture.');
  return { head: head === null ? null : head.trim(), indexDigest };
}

function recheckFiles(captured) {
  for (const { inspected, before } of captured) {
    assertChain(inspected.chain);
    const current = fs.lstatSync(inspected.file, { throwIfNoEntry: false });
    if (before === null ? Boolean(current) : !current || !sameStat(before, current, true)) {
      fail('WORKSPACE_CHANGED', 'A workspace file changed before capture completed.');
    }
  }
}

function captureManifest({ repoRoot, exclusions = COMPILED_EXCLUSIONS }) {
  if (v.canonical(exclusions) !== v.canonical(COMPILED_EXCLUSIONS)) fail('INVALID_INPUT', 'Only the fixed workspace exclusion scope is supported.');
  const { root, identity } = canonicalRoot(repoRoot);
  if (safeGit(root, ['rev-parse', '--show-toplevel']).trim() !== root) fail('INVALID_INPUT', 'The complete working repository root is required.');
  const before = gitSnapshot(root); const inventory = names(root); const budget = { bytes: 0 };
  const captured = inventory.map(entry => fileEntry(root, entry, budget));
  const entries = captured.map(item => item.entry);
  recheckFiles(captured);
  const after = gitSnapshot(root);
  if (v.canonical(before) !== v.canonical(after) || v.canonical(inventory) !== v.canonical(names(root))
    || v.canonical(identity) !== v.canonical(canonicalRoot(root).identity)) fail('WORKSPACE_CHANGED', 'The workspace changed during capture.');
  const value = { schemaVersion: 'ecc.workspace-manifest.v1', repoIdentityDigest: v.canonicalDigest(identity),
    head: before.head, indexDigest: before.indexDigest, entries,
    exclusionSetDigest: v.canonicalDigest(COMPILED_EXCLUSIONS), excludedScope: [...COMPILED_EXCLUSIONS] };
  const manifest = { ...value, digest: v.canonicalDigest(value) };
  if (Buffer.byteLength(v.canonical(manifest)) > MAX_MANIFEST_BYTES) fail('STORAGE_CAPACITY', 'The workspace manifest limit was exceeded.', 4);
  return manifest;
}

function captureWorkspaceManifest(input) {
  try { return captureManifest(input); } catch (error) {
    if (error instanceof AllocationError) throw error;
    fail('WORKSPACE_CHANGED', 'The workspace could not be captured safely.');
  }
}

function assertWorkspaceManifest({ repoRoot, manifest }) {
  v.object(manifest, ['schemaVersion', 'repoIdentityDigest', 'head', 'indexDigest', 'entries', 'exclusionSetDigest', 'excludedScope', 'digest']);
  const { digest, ...value } = manifest;
  if (v.digest(digest) !== v.canonicalDigest(value)) fail('WORKSPACE_CHANGED', 'The saved workspace manifest is invalid.');
  const actual = captureWorkspaceManifest({ repoRoot });
  if (v.canonical(manifest) !== v.canonical(actual)) fail('WORKSPACE_CHANGED', 'The workspace changed after handoff capture.');
  return actual;
}

module.exports = { captureWorkspaceManifest, assertWorkspaceManifest, COMPILED_EXCLUSIONS };
