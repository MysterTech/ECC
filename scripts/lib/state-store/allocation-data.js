'use strict';

const { normalizePolicy, normalizeRequirements, normalizeIdentity, normalizeTypedResult,
  normalizeJournal, normalizeEvidence, normalizeEffectAcknowledgement, normalizeTask, canonicalDigest } = require('../allocation/validation');
const { AllocationError } = require('../allocation/errors');
const primitives = require('../allocation/validation-primitives');

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const TERMINAL = new Set(['asserted-success', 'exhausted', 'abandoned']);
const RESULT_FIELDS = ['result', 'observed', 'metrics'];

function fail(code = 'CONFLICT', exitCode = 3) {
  throw new AllocationError(`ECC_ALLOCATION_${code}`, exitCode, `Allocation ${code.toLowerCase().replaceAll('_', ' ')}.`);
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function keys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', 2);
  if (Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) fail('INVALID_INPUT', 2);
}
function id(value) { if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_INPUT', 2); return value; }
function digest(value) { if (typeof value !== 'string' || !DIGEST.test(value)) fail('INVALID_INPUT', 2); return value; }
function integer(value) { if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_INPUT', 2); return value; }
function timestamp(value) {
  return primitives.timestamp(value);
}
function bounded(value, cap = 16384) {
  function walk(item) {
    if (typeof item === 'string') primitives.text(item, cap, true);
    else if (Array.isArray(item)) item.forEach(walk);
    else if (item && typeof item === 'object') { Object.keys(item).forEach(walk); Object.values(item).forEach(walk); }
  }
  primitives.bounded(value, cap); walk(value);
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > cap) fail('INVALID_INPUT', 2);
  return clone(value);
}
function revisionKey(identity) {
  return canonicalDigest(normalizeIdentity(identity));
}
function same(left, right) { return canonicalDigest(left) === canonicalDigest(right); }
function assertSame(left, right) { if (!same(left, right)) fail(); }
function effect(value) { return normalizeEffectAcknowledgement(value); }
function assertIdentity(identity, requirements) {
  for (const key of ['sessionId', 'taskId', 'revision', 'phase']) if (identity[key] !== requirements[key]) fail();
}

function context(value) {
  if (value.mode === 'managed') {
    keys(value, ['mode', 'stateRoot', 'nativeRoot', 'expectedReceiptDigest']);
    primitives.absolute(value.stateRoot); if (value.nativeRoot !== null) primitives.absolute(value.nativeRoot);
    digest(value.expectedReceiptDigest); return;
  }
  keys(value, ['mode', 'profileId', 'selectionMode', 'include', 'exclude']);
  if (value.mode !== 'explicit' || !['manual', 'auto'].includes(value.selectionMode)
    || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/.test(value.profileId)) fail('INVALID_INPUT', 2);
  const include = primitives.array(value.include, primitives.id, 0, 8);
  const exclude = primitives.array(value.exclude, primitives.id, 0, 32);
  if (include.some(item => exclude.includes(item))) fail('INVALID_INPUT', 2);
  assertSame(include, value.include); assertSame(exclude, value.exclude);
}

function binding(value, policy, identity) {
  keys(value, ['taskDigest', 'queryDigest', 'requirementsDigest', 'policyDigest', 'contextSetDigest',
    'runtimeSetDigest', 'repoIdentityDigest', 'repoRoot', 'cwd', 'contexts', 'contextSourceBindings', 'runtimeBindings', 'requirements']);
  for (const key of Object.keys(value).filter(key => key.endsWith('Digest'))) digest(value[key]);
  if (typeof value.repoRoot !== 'string' || !value.repoRoot.startsWith('/') || value.cwd !== value.repoRoot) fail('INVALID_INPUT', 2);
  const requirements = normalizeRequirements(value.requirements);
  assertIdentity(identity, requirements);
  assertSame(value.requirementsDigest, canonicalDigest(requirements));
  assertSame(value.policyDigest, canonicalDigest(policy));
  assertSame(value.contextSetDigest, canonicalDigest({ contexts: value.contexts, contextSourceBindings: value.contextSourceBindings }));
  assertSame(value.runtimeSetDigest, canonicalDigest(value.runtimeBindings));
  const providerIds = policy.providers.map(provider => provider.id);
  for (const collection of [value.contexts, value.contextSourceBindings, value.runtimeBindings]) keys(collection, providerIds);
  Object.values(value.contexts).forEach(context);
  for (const source of Object.values(value.contextSourceBindings)) {
    keys(source, ['metadataDigest', 'registryIdentityDigest']); digest(source.metadataDigest); digest(source.registryIdentityDigest);
  }
  for (const runtime of Object.values(value.runtimeBindings)) { keys(runtime, ['runtimeDigest']); digest(runtime.runtimeDigest); }
  for (const provider of policy.providers) assertSame(value.runtimeBindings[provider.id].runtimeDigest, canonicalDigest(provider));
  return bounded({ ...value, requirements }, 65536);
}

function capsule(value, revision) {
  if (!revision.policy.continuation.enabled) { if (value !== null) fail('INVALID_INPUT', 2); return null; }
  if (value === null) fail('CAPSULE_UNAVAILABLE', 4);
  keys(value, ['schemaVersion', 'identity', 'originalTask', 'requirementsDigest', 'policyDigest', 'contextSetDigest',
    'runtimeSetDigest', 'journalVersion', 'journal', 'workspaceManifestDigest']);
  if (value.schemaVersion !== 'ecc.task-capsule.v1') fail('INVALID_INPUT', 2);
  assertSame(value.identity, revision.identity);
  assertSame(value.originalTask, normalizeTask(value.originalTask));
  assertSame(canonicalDigest(value.originalTask), revision.binding.taskDigest);
  assertSame(canonicalDigest(value.originalTask.query), revision.binding.queryDigest);
  if (typeof value.originalTask.query !== 'string' || Buffer.byteLength(value.originalTask.query) > 8192) fail('INVALID_INPUT', 2);
  for (const key of ['requirementsDigest', 'policyDigest', 'contextSetDigest', 'runtimeSetDigest']) assertSame(value[key], revision.binding[key]);
  integer(value.journalVersion);
  if (value.workspaceManifestDigest !== null) digest(value.workspaceManifestDigest);
  return bounded({ ...value, journal: normalizeJournal(value.journal) }, 49152);
}

function completion(value) {
  keys(value, RESULT_FIELDS);
  const result = normalizeTypedResult(value.result);
  keys(value.observed, ['backendId', 'modelId', 'effort', 'nativeContextTokens', 'childUsageTokens', 'source']);
  for (const key of ['backendId', 'effort']) if (value.observed[key] !== null) id(value.observed[key]);
  if (value.observed.modelId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.observed.modelId)) fail('INVALID_INPUT', 2);
  for (const key of ['nativeContextTokens', 'childUsageTokens']) if (value.observed[key] !== null) integer(value.observed[key]);
  if (!['provider-observed', 'caller-asserted', 'unavailable'].includes(value.observed.source)) fail('INVALID_INPUT', 2);
  if (value.observed.source === 'unavailable' && Object.entries(value.observed).some(([key, item]) => key !== 'source' && item !== null)) fail('INVALID_INPUT', 2);
  if (!Array.isArray(value.metrics) || value.metrics.length > 16) fail('INVALID_INPUT', 2);
  const metricKeys = value.metrics.map(metric => `${metric.name}:${metric.series}:${metric.currency}`);
  if (new Set(metricKeys).size !== metricKeys.length) fail('INVALID_INPUT', 2);
  for (const metric of value.metrics) {
    keys(metric, ['name', 'value', 'scope', 'series', 'currency', 'source', 'pricing']);
    if (!['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'durationMs', 'costMicros'].includes(metric.name)
      || metric.scope !== 'root' || !['observed', 'cash', 'API-equivalent'].includes(metric.series)
      || !['provider-observed', 'controller-observed', 'API-equivalent-estimated', 'unavailable'].includes(metric.source)) fail('INVALID_INPUT', 2);
    if (metric.value !== null) integer(metric.value);
    if (metric.currency !== null && !/^[A-Z]{3}$/.test(metric.currency)) fail('INVALID_INPUT', 2);
    if (metric.name === 'costMicros' && metric.value !== null && metric.currency === null) fail('INVALID_INPUT', 2);
    if (metric.pricing !== null) {
      keys(metric.pricing, ['sourceId', 'version', 'timestamp', 'rounding']);
      id(metric.pricing.sourceId); id(metric.pricing.version); timestamp(metric.pricing.timestamp);
      if (metric.pricing.rounding !== 'nearest-micro-half-up') fail('INVALID_INPUT', 2);
    }
    if (metric.source === 'API-equivalent-estimated' && metric.pricing === null) fail('INVALID_INPUT', 2);
  }
  for (const cached of value.metrics.filter(metric => metric.name === 'cachedInputTokens')) {
    const input = value.metrics.find(metric => metric.name === 'inputTokens' && metric.series === cached.series && metric.currency === cached.currency);
    if (cached.value !== null && input && input.value !== null && cached.value > input.value) fail('INVALID_INPUT', 2);
  }
  return bounded({ ...value, result });
}

function operationIntent(value, revision, attempt) {
  keys(value, ['operationId', 'attemptId', 'phase', 'providerId', 'tierId', 'allocationId', 'runtimeDigest',
    'requested', 'finalContextDigest', 'workspaceManifestDigest', 'inputDigest']);
  id(value.operationId); assertSame(value.attemptId, attempt.attemptId);
  if (!['classifier', 'proposal', 'task'].includes(value.phase)) fail('INVALID_INPUT', 2);
  const allocation = revision.policy.allocations.find(item => item.id === value.allocationId);
  if (!allocation || allocation.providerId !== value.providerId) fail('INCOMPATIBLE', 2);
  keys(value.requested, ['modelId', 'effort', 'runtimeDigest']);
  assertSame(value.requested, { modelId: allocation.modelId, effort: allocation.effort, runtimeDigest: value.runtimeDigest });
  assertSame(value.runtimeDigest, revision.binding.runtimeBindings[value.providerId].runtimeDigest);
  if (value.phase === 'classifier') {
    if (revision.route !== null || revision.policy.classifier.mode === 'disabled'
      || revision.policy.classifier.allocationId !== value.allocationId || value.tierId !== null) fail();
  } else {
    if (!revision.route || value.tierId !== attempt.tierId) fail();
    if (value.phase === 'task' && value.allocationId !== attempt.allocationId) fail();
    if (value.phase === 'task' && !require('../allocation/policy').compatibleAllocation(revision.policy, revision.binding.requirements, allocation)) fail('INCOMPATIBLE', 2);
    if (value.phase === 'proposal') {
      const proposal = revision.policy.contextProposals[value.providerId];
      if (!proposal || proposal.allocationId !== value.allocationId
        || revision.policy.allocations.find(item => item.id === attempt.allocationId).providerId !== value.providerId) fail();
    }
  }
  for (const key of ['finalContextDigest', 'workspaceManifestDigest']) if (value[key] !== null) digest(value[key]);
  digest(value.inputDigest);
  if (value.phase === 'task' && value.finalContextDigest === null) fail('BINDING_CHANGED', 2);
  return bounded(value);
}

function unsafeWorkspacePath(relative) {
  const excludedParts = new Set(['.git', 'build', 'dist', 'coverage', 'node_modules', '.venv', 'venv',
    '__pycache__', '.pytest_cache', '.cache', '.ecc-allocation', '.ecc-state']);
  return [...relative].some(character => character.codePointAt(0) < 32 || character.codePointAt(0) >= 127 && character.codePointAt(0) <= 159)
    || relative.split('/').some(part => excludedParts.has(part))
    || /(?:^|\/)\.(?:codex|claude)\/(?:auth\.json|\.?credentials(?:\.json)?)(?:\/|$)/.test(relative);
}

function manifest(value, revision) {
  keys(value, ['schemaVersion', 'repoIdentityDigest', 'head', 'indexDigest', 'entries', 'exclusionSetDigest', 'excludedScope', 'digest']);
  if (value.schemaVersion !== 'ecc.workspace-manifest.v1') fail('INVALID_INPUT', 2);
  assertSame(value.repoIdentityDigest, revision.binding.repoIdentityDigest);
  digest(value.exclusionSetDigest); digest(value.digest);
  if (value.indexDigest !== null) digest(value.indexDigest);
  if (value.head !== null && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.head)) fail('INVALID_INPUT', 2);
  if (!Array.isArray(value.entries) || value.entries.length > 10000 || !Array.isArray(value.excludedScope)) fail('INVALID_INPUT', 2);
  value.excludedScope.forEach(id);
  const compiledExclusions = ['build-output', 'dependency-output', 'git-ignored', 'git-metadata', 'private-harness', 'test-cache'];
  assertSame(value.excludedScope, compiledExclusions);
  assertSame(value.exclusionSetDigest, canonicalDigest(compiledExclusions));
  let previous = ''; let bytes = 0;
  for (const entry of value.entries) {
    keys(entry, ['path', 'kind', 'digest', 'bytes', 'tracking']);
    if (typeof entry.path !== 'string' || entry.path <= previous || Buffer.byteLength(entry.path) > 1024
      || entry.path.startsWith('/') || entry.path.includes('\\') || entry.path.split('/').some(part => !part || ['.', '..', '.git'].includes(part))
      || unsafeWorkspacePath(entry.path)
      || !['file', 'deleted'].includes(entry.kind) || !['tracked', 'untracked'].includes(entry.tracking)) fail('INVALID_INPUT', 2);
    previous = entry.path;
    if (entry.kind === 'deleted') { if (entry.digest !== null || entry.bytes !== null) fail('INVALID_INPUT', 2); }
    else { digest(entry.digest); integer(entry.bytes); if (entry.bytes > 16 * 1024 * 1024) fail('INVALID_INPUT', 2); bytes += entry.bytes; }
  }
  if (bytes > 128 * 1024 * 1024) fail('INVALID_INPUT', 2);
  const { digest: _digest, ...body } = value;
  assertSame(canonicalDigest(body), value.digest);
  return bounded(value, 2 * 1024 * 1024);
}

module.exports = { fail, clone, keys, id, digest, integer, timestamp, bounded, revisionKey, same, assertSame,
  effect, assertIdentity, binding, capsule, completion, operationIntent, manifest, TERMINAL,
  normalizePolicy, normalizeRequirements, normalizeIdentity, normalizeTypedResult, normalizeJournal, normalizeEvidence, canonicalDigest };
