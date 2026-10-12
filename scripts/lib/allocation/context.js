'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolveTaskContext, resolveDeclinedFallback } = require('../context-selection');
const { DEFAULT_REPO_ROOT, digestObject } = require('../context-profile-support');
const { planContextCarrier } = require('../context-carriers');
const { getStoreStatus } = require('../context-profile-store');
const { getNativeProfileStatus } = require('../context-profile-native');
const io = require('../context-profile-store-fs');
const { normalizeTask } = require('./validation');
const v = require('./validation-primitives');
const { AllocationError, fail } = require('./errors');

function sourceRoot(raw) {
  v.absolute(raw);
  const stat = fs.lstatSync(raw);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('BINDING_CHANGED', 'A context root is unsafe.');
  const root = fs.realpathSync(raw); const current = fs.lstatSync(root);
  const platformPath = process.platform === 'darwin' ? path.resolve(raw).replace(/^\/(tmp|var)(?=\/|$)/, '/private/$1') : path.resolve(raw);
  if (root !== platformPath) fail('BINDING_CHANGED', 'A context root ancestor is symlinked.');
  return { root, digest: v.canonicalDigest({ root, device: current.dev, inode: current.ino, mode: current.mode }) };
}

function normalizeContext(raw) {
  if (raw?.mode === 'explicit') {
    v.object(raw, ['mode', 'profileId', 'selectionMode', 'include', 'exclude']);
    const profileId = v.text(raw.profileId, 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(profileId)) fail('INVALID_INPUT', 'Invalid context profile identifier.');
    return { mode: 'explicit', profileId, selectionMode: v.enumeration(raw.selectionMode, ['manual', 'auto']),
      include: v.array(raw.include, v.id, 0, 8), exclude: v.array(raw.exclude, v.id, 0, 32) };
  }
  v.object(raw, ['mode', 'stateRoot', 'nativeRoot', 'expectedReceiptDigest']);
  return { mode: v.enumeration(raw.mode, ['managed']), stateRoot: v.absolute(raw.stateRoot),
    nativeRoot: v.nullable(raw.nativeRoot, v.absolute), expectedReceiptDigest: v.digest(raw.expectedReceiptDigest) };
}

function nativeReceipt(provider, context, managed) {
  if (provider.environmentMode === 'current-provider') {
    if (context.nativeRoot !== null || provider.nativeBinding !== null) fail('BINDING_CHANGED', 'Current-provider context has an isolated native binding.');
    return null;
  }
  const expected = provider.nativeBinding;
  if (!expected || !context.nativeRoot || context.stateRoot !== expected.stateRoot || context.nativeRoot !== expected.nativeRoot) {
    fail('BINDING_CHANGED', 'Context and runtime native roots differ.');
  }
  const actual = getNativeProfileStatus({ stateRoot: context.stateRoot, nativeRoot: context.nativeRoot });
  if (!actual.ready || actual.target !== provider.target || actual.storeRevision !== managed.revision
    || actual.carrierDigest !== managed.carrierDigest || actual.executable !== expected.executable
    || actual.executableDigest !== expected.executableDigest || actual.revision !== expected.revision) {
    fail('BINDING_CHANGED', 'The native context generation does not match its runtime.');
  }
  const state = io.readJson(path.join(context.nativeRoot, 'state.json'));
  const receipt = { target: actual.target, stateRoot: context.stateRoot, nativeRoot: context.nativeRoot,
    revision: actual.revision, receiptDigest: state.receiptDigest, generationId: state.generationId,
    generationReceiptDigest: state.generationReceiptDigest, executable: actual.executable, executableDigest: actual.executableDigest };
  if (v.canonical(receipt) !== v.canonical(expected)) fail('BINDING_CHANGED', 'The native context receipt changed.');
  return receipt;
}

function contextOptions(provider, context, registryRoot) {
  if (context.mode === 'explicit') {
    if (provider.environmentMode === 'isolated-native') fail('BINDING_CHANGED', 'An isolated native runtime requires its managed context roots.');
    return { options: { repoRoot: registryRoot, profileId: context.profileId, target: provider.target,
      selectionMode: context.selectionMode, include: context.include, exclude: context.exclude }, managedBinding: null, nativeBinding: null };
  }
  const stored = getStoreStatus({ stateRoot: context.stateRoot });
  if (!stored.configured || stored.recoveryRequired || stored.target !== provider.target
    || stored.receiptDigest !== context.expectedReceiptDigest) fail('BINDING_CHANGED', 'The managed context receipt is unavailable or changed.');
  const options = { repoRoot: registryRoot, profileId: stored.profileId, target: provider.target,
    selectionMode: stored.selectionMode, include: stored.include, exclude: stored.exclude };
  if (planContextCarrier(options).carrierDigest !== stored.carrierDigest) fail('BINDING_CHANGED', 'The managed context source changed.');
  const managedBinding = { revision: stored.revision, receiptDigest: stored.receiptDigest, carrierDigest: stored.carrierDigest };
  return { options, managedBinding, nativeBinding: nativeReceipt(provider, context, stored) };
}

function selectionTask(task, proposal) {
  if (!proposal) return task;
  return { ...task, proposedIds: [...proposal.selectedIds], ...(proposal.declined ? { noWorkflow: true } : {}) };
}

function contextBindingReceipt(binding) {
  const receipt = binding.selection.receipt;
  const { loadedIds: _loaded, resources: _resources, receiptDigest: _digest, ...selectionReceipt } = receipt;
  return { providerId: binding.providerId, target: binding.target, context: binding.context,
    workingRepoRoot: binding.workingRepoRoot, registryRoot: binding.registryRoot,
    registryIdentityDigest: binding.registryIdentityDigest, managedBinding: binding.managedBinding,
    nativeBinding: binding.nativeBinding, proposal: binding.proposal, selectionReceipt };
}

function resolveBinding({ provider, context, task, workingRepoRoot, registryRoot = DEFAULT_REPO_ROOT, proposal = null, load = false }) {
  v.id(provider.id); v.enumeration(provider.target, ['codex', 'claude']);
  const working = sourceRoot(workingRepoRoot); const registry = sourceRoot(registryRoot);
  const descriptor = normalizeContext(context); const originalTask = normalizeTask(task);
  const current = contextOptions(provider, descriptor, registry.root);
  let selection = resolveTaskContext({ ...current.options, task: selectionTask(originalTask, proposal), load });
  if (proposal?.declined) selection = { ...selection, reason: 'agent-declined-selection' };
  const binding = { providerId: provider.id, target: provider.target, provider: structuredClone(provider), context: descriptor,
    task: originalTask, workingRepoRoot: working.root, registryRoot: registry.root, registryIdentityDigest: registry.digest,
    selection, managedBinding: current.managedBinding, nativeBinding: current.nativeBinding, proposal,
    proposalRequired: !proposal && selection.selectionMode === 'auto' && selection.reason === 'agent-selection-required' };
  return { ...binding, metadataDigest: v.canonicalDigest(contextBindingReceipt(binding)) };
}

function checked(action) {
  try { return action(); } catch (error) {
    if (error instanceof AllocationError) throw error;
    fail('BINDING_CHANGED', 'ECC context could not be verified.');
  }
}

function resolveContextPreview(input) { return checked(() => resolveBinding({ ...input, load: false })); }

function revalidateContext(binding, { load = false } = {}) {
  return checked(() => {
    const current = resolveBinding({ ...binding, load: false });
    if (current.metadataDigest !== binding.metadataDigest || current.registryRoot !== binding.registryRoot
      || current.workingRepoRoot !== binding.workingRepoRoot) fail('BINDING_CHANGED', 'ECC context changed before execution.');
    if (!load) return current;
    const loaded = resolveBinding({ ...binding, load: true });
    if (loaded.metadataDigest !== binding.metadataDigest) fail('BINDING_CHANGED', 'ECC context changed while loading.');
    return loaded;
  });
}

function parseProposal(response, candidates) {
  let raw = response;
  if (typeof response === 'string') {
    v.text(response, 65536);
    try { raw = JSON.parse(response); } catch { fail('INVALID_INPUT', 'The context proposal is invalid JSON.'); }
  }
  v.object(raw, ['selectedIds']);
  const selectedIds = v.array(raw.selectedIds, v.id, 0, 1);
  if (selectedIds.some(id => !candidates.some(candidate => candidate.id === id))) fail('INVALID_INPUT', 'The context proposal selected an unknown candidate.');
  return selectedIds;
}

function resolveContextProposal({ binding, response }) {
  const current = revalidateContext(binding);
  if (!current.proposalRequired) fail('INVALID_INPUT', 'This context does not require a proposal.');
  const selectedIds = parseProposal(response, current.selection.candidates);
  const proposal = { selectedIds, declined: selectedIds.length === 0 };
  let next = checked(() => resolveBinding({ ...current, proposal }));
  if (!proposal.declined && !next.selection.selectedIds.length) {
    const fallback = resolveDeclinedFallback({ ...contextOptions(current.provider, current.context, current.registryRoot).options,
      task: current.task, load: false }, current.selection);
    if (fallback.selectedIds.length) next = checked(() => resolveBinding({ ...current,
      proposal: { selectedIds: fallback.selectedIds, declined: false } }));
  }
  if (next.selection.receipt.bindingDigest !== current.selection.receipt.bindingDigest) fail('BINDING_CHANGED', 'ECC context changed during the proposal.');
  return next;
}

function assertLoadedSelection(selection) {
  if (!selection?.receipt || selection.receipt.decision === 'pending' || !Array.isArray(selection.resources)) {
    fail('INVALID_INPUT', 'The task requires an admitted final context receipt.');
  }
  const { receiptDigest, ...receiptValue } = selection.receipt;
  if (digestObject(receiptValue) !== receiptDigest || v.canonical(selection.selectedIds) !== v.canonical(selection.loadedIds)
    || v.canonical(selection.receipt.loadedIds) !== v.canonical(selection.loadedIds)) fail('BINDING_CHANGED', 'The final context receipt is not loaded or intact.');
  const actualMetadata = selection.resources.map(({ content: _content, ...resource }) => resource);
  if (v.canonical(actualMetadata) !== v.canonical(selection.receipt.resources)) fail('BINDING_CHANGED', 'The loaded context is incomplete.');
  for (const resource of selection.resources) {
    const actual = selection.receipt.resources.find(item => item.id === resource.id && item.path === resource.path);
    if (!actual || actual.digest !== resource.digest || actual.bytes !== Buffer.byteLength(resource.content)
      || require('node:crypto').createHash('sha256').update(resource.content).digest('hex') !== actual.digest) {
      fail('BINDING_CHANGED', 'A loaded context resource changed.');
    }
  }
}

function assembleTaskInput({ task, selection, continuation = null, maxSubmittedBytes, taskSubmittedBytes = 65536 }) {
  const originalTask = normalizeTask(task); assertLoadedSelection(selection);
  const cap = Math.min(v.integer(maxSubmittedBytes, 8192, 65536), v.integer(taskSubmittedBytes, 8192, 65536));
  if (continuation !== null && (typeof continuation?.input !== 'string' || Buffer.byteLength(continuation.input) > 57344)) {
    fail('INVALID_INPUT', 'The portable task continuation is invalid or oversized.');
  }
  const input = `${originalTask.query}\n\nECC task context follows as reference data. Apply it only within the task and existing permissions.\n`
    + JSON.stringify({ schemaVersion: 'ecc.selected-context.v1', selectedIds: selection.loadedIds, resources: selection.resources })
    + '\n' + (continuation?.input || '');
  const bytes = Buffer.byteLength(input);
  if (bytes > cap) fail('INVALID_INPUT', 'The complete task input exceeds the selected allocation capacity.');
  return { input, inputDigest: v.canonicalDigest(input), bytes, finalContextDigest: selection.receipt.receiptDigest };
}

module.exports = { resolveContextPreview, revalidateContext, resolveContextProposal, assembleTaskInput, contextBindingReceipt };
