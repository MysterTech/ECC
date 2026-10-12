'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { captureWorkspaceManifest, assertWorkspaceManifest, COMPILED_EXCLUSIONS } = require('../../scripts/lib/allocation/workspace');

function withRepo(fn) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-allocation-workspace-')));
  const git = args => { const result = spawnSync('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '-C', root, ...args],
    { encoding: 'utf8', shell: false }); assert.equal(result.status, 0, result.stderr); };
  try {
    git(['init', '-q']); fs.writeFileSync(path.join(root, 'tracked.txt'), 'original');
    fs.writeFileSync(path.join(root, 'deleted.txt'), 'old');
    fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\nnode_modules/\n');
    git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
    return fn(root, git);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test('manifest hashes tracked and nonignored untracked files, records deletions and excludes ignored files', () => withRepo(root => {
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'changed'); fs.unlinkSync(path.join(root, 'deleted.txt'));
  fs.writeFileSync(path.join(root, 'new.txt'), 'new'); fs.writeFileSync(path.join(root, 'ignored.txt'), 'ignored');
  const manifest = captureWorkspaceManifest({ repoRoot: root });
  assert.equal(manifest.schemaVersion, 'ecc.workspace-manifest.v1');
  assert.match(manifest.head, /^[a-f0-9]{40,64}$/);
  assert.deepEqual(manifest.entries.find(entry => entry.path === 'deleted.txt'), { path: 'deleted.txt', kind: 'deleted', digest: null, bytes: null, tracking: 'tracked' });
  assert.equal(manifest.entries.find(entry => entry.path === 'new.txt').tracking, 'untracked');
  assert.equal(manifest.entries.some(entry => entry.path === 'ignored.txt'), false);
  assert.deepEqual(manifest.excludedScope, COMPILED_EXCLUSIONS);
  assert.match(manifest.digest, /^[a-f0-9]{64}$/);
  assertWorkspaceManifest({ repoRoot: root, manifest });
}));

test('resume rejects changed file, new untracked file, changed index/head and forged manifest', () => withRepo((root, git) => {
  const manifest = captureWorkspaceManifest({ repoRoot: root });
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'different');
  assert.throws(() => assertWorkspaceManifest({ repoRoot: root, manifest }), error => error.code === 'ECC_ALLOCATION_WORKSPACE_CHANGED');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original');
  fs.writeFileSync(path.join(root, 'new.txt'), 'new');
  assert.throws(() => assertWorkspaceManifest({ repoRoot: root, manifest }));
  fs.unlinkSync(path.join(root, 'new.txt'));
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'staged'); git(['add', 'tracked.txt']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'original');
  assert.throws(() => assertWorkspaceManifest({ repoRoot: root, manifest }));
  git(['reset', '-q']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'new head']);
  assert.throws(() => assertWorkspaceManifest({ repoRoot: root, manifest }));
  assert.throws(() => assertWorkspaceManifest({ repoRoot: root, manifest: { ...manifest, digest: 'a'.repeat(64) } }));
}));

test('manifest rejects symlink files and ancestors without following them', () => withRepo(root => {
  fs.symlinkSync('tracked.txt', path.join(root, 'link.txt'));
  assert.throws(() => captureWorkspaceManifest({ repoRoot: root }));
  fs.unlinkSync(path.join(root, 'link.txt'));
  fs.mkdirSync(path.join(root, 'folder')); fs.writeFileSync(path.join(root, 'folder', 'child.txt'), 'child');
  const manifest = captureWorkspaceManifest({ repoRoot: root });
  fs.renameSync(path.join(root, 'folder'), path.join(root, 'other'));
  fs.symlinkSync('other', path.join(root, 'folder'));
  assert.throws(() => assertWorkspaceManifest({ repoRoot: root, manifest }));
}));

test('capture rejects nonrepositories, custom exclusions, unsafe tracked names and file-byte overflow', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-allocation-no-repo-'));
  try { assert.throws(() => captureWorkspaceManifest({ repoRoot: directory })); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  withRepo((root, git) => {
    assert.throws(() => captureWorkspaceManifest({ repoRoot: root, exclusions: ['private-path'] }));
    fs.writeFileSync(path.join(root, 'bad\nname'), 'unsafe'); git(['add', 'bad\nname']);
    assert.throws(() => captureWorkspaceManifest({ repoRoot: root }));
    fs.unlinkSync(path.join(root, 'bad\nname')); git(['reset', '-q']);
    const descriptor = fs.openSync(path.join(root, 'large.bin'), 'w'); fs.ftruncateSync(descriptor, 16 * 1024 * 1024 + 1); fs.closeSync(descriptor);
    assert.throws(() => captureWorkspaceManifest({ repoRoot: root }), error => error.code === 'ECC_ALLOCATION_STORAGE_CAPACITY');
  });
});

test('unborn repositories preserve null HEAD/index, and fixed excluded scope omits build and private harness bodies', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-allocation-unborn-')));
  try {
    assert.equal(spawnSync('git', ['-C', root, 'init', '-q']).status, 0);
    for (const directory of ['build', 'dist', 'node_modules', '.ecc-state', '.pytest_cache']) {
      fs.mkdirSync(path.join(root, directory)); fs.writeFileSync(path.join(root, directory, 'data.txt'), 'outside claimed scope');
    }
    fs.writeFileSync(path.join(root, 'new.txt'), 'work');
    const manifest = captureWorkspaceManifest({ repoRoot: root });
    assert.equal(manifest.head, null); assert.equal(manifest.indexDigest, null);
    assert.deepEqual(manifest.entries.map(entry => entry.path), ['new.txt']);
    fs.mkdirSync(path.join(root, 'nested'));
    assert.throws(() => captureWorkspaceManifest({ repoRoot: path.join(root, 'nested') }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('capture rejects races during hashing and files recreated after a deletion observation', () => withRepo(root => {
  const before = fs.readSync; const target = path.join(root, 'tracked.txt'); const inode = fs.statSync(target).ino; let changed = false;
  try {
    fs.readSync = (descriptor, ...args) => {
      const bytes = before(descriptor, ...args);
      if (!changed && fs.fstatSync(descriptor).ino === inode) { changed = true; fs.writeFileSync(target, 'mutation'); }
      return bytes;
    };
    assert.throws(() => captureWorkspaceManifest({ repoRoot: root }), error => error.code === 'ECC_ALLOCATION_WORKSPACE_CHANGED');
  } finally { fs.readSync = before; }
  fs.unlinkSync(path.join(root, 'deleted.txt')); changed = false;
  try {
    fs.readSync = (descriptor, ...args) => {
      const bytes = before(descriptor, ...args);
      if (!changed && fs.fstatSync(descriptor).ino === inode) { changed = true; fs.writeFileSync(path.join(root, 'deleted.txt'), 'recreated'); }
      return bytes;
    };
    assert.throws(() => captureWorkspaceManifest({ repoRoot: root }), error => error.code === 'ECC_ALLOCATION_WORKSPACE_CHANGED');
  } finally { fs.readSync = before; }
}));

test('workspace root aliases and Git metadata symlinks reject rather than follow outside repositories', () => withRepo(root => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-allocation-alias-')); const alias = path.join(parent, 'alias');
  try {
    fs.symlinkSync(root, alias, 'dir'); assert.throws(() => captureWorkspaceManifest({ repoRoot: alias }));
    fs.mkdirSync(path.join(root, 'nested')); assert.throws(() => captureWorkspaceManifest({ repoRoot: path.join(alias, 'nested') }));
    fs.renameSync(path.join(root, '.git'), path.join(root, 'metadata')); fs.symlinkSync('metadata', path.join(root, '.git'), 'dir');
    assert.throws(() => captureWorkspaceManifest({ repoRoot: root }));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
}));
