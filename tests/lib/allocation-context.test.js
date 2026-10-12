'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { withFixture, write, update } = require('./helpers/context-fixture');
const fixture = require('./helpers/allocation-fixture');
const { resolveContextPreview, revalidateContext, resolveContextProposal, assembleTaskInput, contextBindingReceipt } = require('../../scripts/lib/allocation/context');
const store = require('../../scripts/lib/context-profile-store');
const native = require('../../scripts/lib/context-profile-native');

function withContext(fn) {
  return withFixture(registry => {
    const workingRepoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-allocation-working-')));
    try { return fn(fs.realpathSync(registry), workingRepoRoot); } finally { fs.rmSync(workingRepoRoot, { recursive: true, force: true }); }
  });
}
const explicit = { mode: 'explicit', profileId: 'lean@1', selectionMode: 'manual', include: [], exclude: [] };
function preview(registryRoot, workingRepoRoot, overrides = {}) {
  return resolveContextPreview({ registryRoot, workingRepoRoot, provider: fixture.provider('codex'),
    task: { ...fixture.task(), explicitIds: ['skill:feature'] }, context: explicit, ...overrides });
}

test('preview resolves ECC from installation registry, keeps working cwd separate and never loads bodies', () => withContext((registry, working) => {
  const value = preview(registry, working);
  assert.equal(value.registryRoot, registry);
  assert.equal(value.workingRepoRoot, working);
  assert.deepEqual(value.selection.selectedIds, ['skill:feature']);
  assert.deepEqual(value.selection.resources, []);
  assert.equal(value.proposalRequired, false);
  const receipt = contextBindingReceipt(value);
  assert.equal(JSON.stringify(receipt).includes(fixture.task().query), false);
  const loaded = revalidateContext(value, { load: true });
  assert.match(loaded.selection.resources[0].content, /# feature/);
  assert.equal(value.selection.resources.length, 0);
}));

test('destination target has its own receipt and source drift rejects before loading', () => withContext((registry, working) => {
  const codex = preview(registry, working); const claude = preview(registry, working, { provider: fixture.provider('claude') });
  assert.notEqual(codex.metadataDigest, claude.metadataDigest);
  assert.equal(claude.selection.target, 'claude');
  write(registry, 'skills/feature/SKILL.md', '---\nname: feature\ndescription: Changed\n---\n# changed\n');
  assert.throws(() => revalidateContext(codex, { load: true }), error => error.code === 'ECC_ALLOCATION_BINDING_CHANGED');
}));

test('bounded proposal honors empty decline and rejects malformed/out-of-candidate responses', () => withContext((registry, working) => {
  const value = preview(registry, working, { task: { ...fixture.task(), query: 'Help with feature' }, context: { ...explicit, selectionMode: 'auto' } });
  assert.equal(value.proposalRequired, true);
  const declined = resolveContextProposal({ binding: value, response: '{"selectedIds":[]}' });
  assert.equal(declined.selection.reason, 'agent-declined-selection');
  assert.deepEqual(revalidateContext(declined, { load: true }).selection.loadedIds, []);
  const chosen = resolveContextProposal({ binding: value, response: { selectedIds: ['skill:feature'] } });
  assert.deepEqual(revalidateContext(chosen, { load: true }).selection.loadedIds, ['skill:feature']);
  for (const response of ['invalid', { selectedIds: ['skill:unknown'] }, { selectedIds: ['skill:feature', 'skill:shared'] }, { selectedIds: [], extra: true }]) {
    assert.throws(() => resolveContextProposal({ binding: value, response }));
  }
}));

test('managed preview verifies immutable source/store receipts and provider target', () => withContext((registry, working) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-allocation-managed-')); const stateRoot = path.join(fs.realpathSync(parent), 'managed');
  try {
    const applied = store.applyStore({ repoRoot: registry, stateRoot, profileId: 'lean@1', target: 'codex', selectionMode: 'manual' });
    const context = { mode: 'managed', stateRoot, nativeRoot: null, expectedReceiptDigest: applied.receiptDigest };
    const value = preview(registry, working, { context });
    assert.equal(value.managedBinding.receiptDigest, applied.receiptDigest);
    revalidateContext(value, { load: true });
    assert.throws(() => preview(registry, working, { context, provider: fixture.provider('claude') }));
    assert.throws(() => preview(registry, working, { context: { ...context, expectedReceiptDigest: 'a'.repeat(64) } }));
    store.applyStore({ repoRoot: registry, stateRoot, profileId: 'full@1', target: 'codex', selectionMode: 'manual' });
    assert.throws(() => revalidateContext(value));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
}));

test('task assembly enforces total actual bytes, loaded receipt and reference-only continuation', () => withContext((registry, working) => {
  const binding = preview(registry, working); const loaded = revalidateContext(binding, { load: true });
  const assembled = assembleTaskInput({ task: binding.task, selection: loaded.selection, maxSubmittedBytes: 65536 });
  assert.ok(assembled.input.includes(binding.task.query));
  assert.ok(assembled.input.includes('reference data'));
  assert.match(assembled.inputDigest, /^[a-f0-9]{64}$/);
  assert.equal(assembled.finalContextDigest, loaded.selection.receipt.receiptDigest);
  assert.equal(assembled.bytes, Buffer.byteLength(assembled.input));
  assert.throws(() => assembleTaskInput({ task: binding.task, selection: binding.selection, maxSubmittedBytes: 65536 }));
  assert.throws(() => assembleTaskInput({ task: binding.task, selection: loaded.selection, maxSubmittedBytes: 8192,
    continuation: { input: 'x'.repeat(8192) } }));
  const noWorkflow = revalidateContext(preview(registry, working, { task: { ...fixture.task(), noWorkflow: true } }), { load: true });
  assert.deepEqual(noWorkflow.selection.loadedIds, []);
  assert.ok(assembleTaskInput({ task: noWorkflow.task, selection: noWorkflow.selection, maxSubmittedBytes: 8192 }).input.includes('Update'));
  assert.throws(() => assembleTaskInput({ task: binding.task, selection: { ...loaded.selection, resources: [] }, maxSubmittedBytes: 8192 }));
  assert.throws(() => assembleTaskInput({ task: binding.task, selection: { ...loaded.selection,
    resources: loaded.selection.resources.map(resource => ({ ...resource, content: 'forged' })) }, maxSubmittedBytes: 8192 }));
  assert.throws(() => assembleTaskInput({ task: binding.task, selection: loaded.selection, continuation: { input: 10 }, maxSubmittedBytes: 8192 }));
}));

test('context boundaries reject unsafe roots, unsupported targets, malformed descriptors and pending context assembly', () => withContext((registry, working) => {
  const link = path.join(working, 'registry-link'); fs.symlinkSync(registry, link, 'dir');
  assert.throws(() => preview(link, working));
  fs.mkdirSync(path.join(registry, 'nested'));
  assert.throws(() => preview(path.join(link, 'nested'), working));
  assert.throws(() => preview(registry, working, { provider: { ...fixture.provider('codex'), target: 'other' } }));
  assert.throws(() => preview(registry, working, { context: { ...explicit, profileId: 'bad/path' } }));
  assert.throws(() => preview(registry, working, { provider: { ...fixture.provider('codex'), environmentMode: 'isolated-native' } }));
  const value = preview(registry, working);
  assert.throws(() => resolveContextProposal({ binding: value, response: { selectedIds: [] } }));
  const pending = preview(registry, working, { task: { ...fixture.task(), query: 'Help with feature' }, context: { ...explicit, selectionMode: 'auto' } });
  assert.throws(() => assembleTaskInput({ task: pending.task, selection: pending.selection, maxSubmittedBytes: 65536 }));
}));

test('context excludes admit nine valid IDs within the public 32 limit and reject 33', () => withContext((registry, working) => {
  const names = Array.from({ length: 9 }, (_, index) => `excluded-${index}`);
  for (const name of names) write(registry, `skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Fixture ${name}.\n---\n# ${name}\n`);
  update(registry, 'manifests/install-modules.json', manifest => ({ ...manifest,
    modules: manifest.modules.map((module, index) => index === 0 ? { ...module, paths: [...module.paths, ...names.map(name => `skills/${name}`)] } : module) }));
  const exclude = names.map(name => `skill:${name}`);
  const value = preview(registry, working, { context: { ...explicit, exclude } });
  assert.deepEqual(value.context.exclude, exclude);
  assert.deepEqual(revalidateContext(value, { load: true }).selection.loadedIds, ['skill:feature']);
  assert.throws(() => preview(registry, working, { context: { ...explicit,
    exclude: Array.from({ length: 33 }, (_, index) => `skill:excluded-${index}`) } }), error => error.code === 'ECC_ALLOCATION_INVALID_INPUT');
}));

test('isolated native context validates generation, managed carrier and provider executable bindings', () => withContext((registry, working) => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-allocation-native-')));
  const stateRoot = path.join(parent, 'managed'); const nativeRoot = path.join(parent, 'native');
  try {
    const applied = store.applyStore({ repoRoot: registry, stateRoot, target: 'codex', selectionMode: 'manual' });
    const observation = native.prepareNativeProfile({ stateRoot, nativeRoot, codexPath: process.execPath }, {
      execute(_command, args, options) {
        if (args[0] === '--version') return { status: 0, stdout: 'codex-cli 0.154.0\n' };
        if (args[0] === 'plugin' && args[1] === 'add') {
          const base = path.dirname(options.env.HOME);
          const marketplace = JSON.parse(fs.readFileSync(path.join(base, 'marketplace/.agents/plugins/marketplace.json')));
          const cache = path.join(options.env.CODEX_HOME, 'plugins/cache', marketplace.name, 'ecc-context-carrier/local');
          fs.mkdirSync(path.dirname(cache), { recursive: true }); fs.cpSync(path.join(base, 'marketplace/carrier'), cache, { recursive: true });
        }
        return { status: 0, stdout: '{}' };
      },
      discover(_command, options) {
        const base = path.dirname(options.env.HOME);
        const marketplace = JSON.parse(fs.readFileSync(path.join(base, 'marketplace/.agents/plugins/marketplace.json')));
        const cache = path.join(options.env.CODEX_HOME, 'plugins/cache', marketplace.name, 'ecc-context-carrier/local');
        const skills = fs.readdirSync(path.join(cache, 'skills')).map(name => ({ name: `ecc-context-carrier:${name}`,
          pluginId: `ecc-context-carrier@${marketplace.name}`, enabled: true, scope: 'user', path: path.join(cache, 'skills', name, 'SKILL.md') }));
        return { data: [{ cwd: options.cwd, errors: [], skills }] };
      },
    });
    const state = JSON.parse(fs.readFileSync(path.join(nativeRoot, 'state.json')));
    const nativeBinding = { target: 'codex', stateRoot, nativeRoot, revision: observation.revision,
      receiptDigest: state.receiptDigest, generationId: state.generationId, generationReceiptDigest: state.generationReceiptDigest,
      executable: observation.executable, executableDigest: observation.executableDigest };
    const provider = { ...fixture.provider('codex'), environmentMode: 'isolated-native', nativeBinding };
    const context = { mode: 'managed', stateRoot, nativeRoot, expectedReceiptDigest: applied.receiptDigest };
    const value = preview(registry, working, { provider, context });
    assert.deepEqual(value.nativeBinding, nativeBinding);
    revalidateContext(value, { load: true });
    assert.throws(() => preview(registry, working, { context }));
    assert.throws(() => preview(registry, working, { context, provider: { ...provider, nativeBinding: { ...nativeBinding, revision: 2 } } }));
    assert.throws(() => preview(registry, working, { context, provider: { ...provider, nativeBinding: { ...nativeBinding, generationId: 'other' } } }));
    assert.throws(() => preview(registry, working, { context, provider: { ...provider, nativeBinding: null } }));
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
}));
