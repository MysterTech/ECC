'use strict';

const v = require('./validation-primitives');
const { AllocationError, fail } = require('./errors');
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'max'];

function authRoute(raw, target) {
  v.object(raw, ['mode', 'method', 'expectedRouteDigest', 'observedAt', 'paidExtraUsageDisabled']);
  return { mode: v.enumeration(raw.mode, ['subscription-only']),
    method: v.enumeration(raw.method, [target === 'codex' ? 'codex-chatgpt' : 'claude-oauth']),
    expectedRouteDigest: v.digest(raw.expectedRouteDigest), observedAt: v.timestamp(raw.observedAt),
    paidExtraUsageDisabled: v.asserted(raw.paidExtraUsageDisabled) };
}
function nativeBinding(raw, provider) {
  if (provider.environmentMode === 'current-provider') {
    if (raw !== null) v.invalid('Current-provider mode must not supply a native binding.');
    return null;
  }
  v.object(raw, ['target', 'stateRoot', 'nativeRoot', 'revision', 'receiptDigest', 'generationId',
    'generationReceiptDigest', 'executable', 'executableDigest']);
  const normalized = { target: v.enumeration(raw.target, [provider.target]), stateRoot: v.absolute(raw.stateRoot),
    nativeRoot: v.absolute(raw.nativeRoot), revision: v.integer(raw.revision, 1), receiptDigest: v.digest(raw.receiptDigest),
    generationId: v.id(raw.generationId), generationReceiptDigest: v.digest(raw.generationReceiptDigest),
    executable: v.absolute(raw.executable), executableDigest: v.digest(raw.executableDigest) };
  if (normalized.executable !== provider.executable || normalized.executableDigest !== provider.executableDigest) v.invalid('Native executable binding differs.');
  return normalized;
}
function configBinding(raw) {
  v.object(raw, ['path', 'digest', 'normalization']);
  return { path: v.absolute(raw.path), digest: v.digest(raw.digest), normalization: v.enumeration(raw.normalization,
    ['raw', 'codex-provider-bookkeeping-v1', 'claude-provider-bookkeeping-v1']) };
}
function admittedProvider(provider) {
  const { target, transport, adapterVersion, cliVersion, environmentMode } = provider;
  const codexExec = target === 'codex' && transport === 'codex-exec' && adapterVersion === 'ecc.codex-allocation.v1'
    && ['0.154.0', '0.155.1'].includes(cliVersion);
  const codexServer = target === 'codex' && transport === 'codex-app-server'
    && adapterVersion === 'ecc.codex-app-server-allocation.v1' && cliVersion === '0.155.1';
  const claudeVersion = environmentMode === 'current-provider' ? cliVersion === '2.1.261'
    : /^2\.1\.\d+$/.test(cliVersion) && Number.isSafeInteger(Number(cliVersion.split('.')[2])) && Number(cliVersion.split('.')[2]) >= 292;
  const claude = target === 'claude' && transport === 'claude-stream-json'
    && adapterVersion === 'ecc.claude-allocation.v1' && claudeVersion;
  if (!codexExec && !codexServer && !claude) v.invalid('Runtime transport and version are not admitted.');
}
function provider(raw) {
  v.object(raw, ['id', 'target', 'transport', 'adapterVersion', 'cliVersion', 'executable', 'executableDigest',
    'environmentMode', 'declaredBackendId', 'knownConfigBindings', 'nativeBinding', 'authRoute']);
  const normalized = { id: v.id(raw.id), target: v.enumeration(raw.target, ['codex', 'claude']),
    transport: v.enumeration(raw.transport, ['codex-exec', 'codex-app-server', 'claude-stream-json']),
    adapterVersion: v.id(raw.adapterVersion), cliVersion: v.text(raw.cliVersion), executable: v.absolute(raw.executable),
    executableDigest: v.digest(raw.executableDigest), environmentMode: v.enumeration(raw.environmentMode, ['current-provider', 'isolated-native']),
    declaredBackendId: v.nullable(raw.declaredBackendId, v.id), knownConfigBindings: v.array(raw.knownConfigBindings, configBinding),
    nativeBinding: null, authRoute: authRoute(raw.authRoute, raw.target) };
  if (new Set(normalized.knownConfigBindings.map(binding => binding.path)).size !== normalized.knownConfigBindings.length) v.invalid('Duplicate configuration path.');
  admittedProvider(normalized);
  return { ...normalized, nativeBinding: nativeBinding(raw.nativeBinding, normalized) };
}
function allocation(raw, providers) {
  v.object(raw, ['id', 'providerId', 'modelId', 'effort', 'descriptor', 'capabilities', 'maxSubmittedBytes']);
  const native = providers.find(item => item.id === raw.providerId);
  if (!native) v.invalid('Allocation refers to unknown provider.');
  const modelId = v.text(raw.modelId, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(modelId)) v.invalid('Invalid model identifier.');
  return { id: v.id(raw.id), providerId: v.id(raw.providerId), modelId,
    effort: v.enumeration(raw.effort, native.target === 'codex' ? CODEX_EFFORTS : CLAUDE_EFFORTS),
    descriptor: v.text(raw.descriptor, 512), capabilities: v.array(raw.capabilities, v.id),
    maxSubmittedBytes: v.integer(raw.maxSubmittedBytes, 8192, 65536) };
}
function selection(raw, allocations, providerId = null) {
  if (raw === null) return null;
  v.object(raw, ['allocationId', 'authorityAcknowledged']);
  const allocationId = v.id(raw.allocationId);
  const selected = allocations.find(item => item.id === allocationId);
  if (!selected || (providerId !== null && selected.providerId !== providerId)) v.invalid('Selection refers to an incompatible allocation.');
  return { allocationId, authorityAcknowledged: v.asserted(raw.authorityAcknowledged) };
}
function classifier(raw, allocations) {
  v.object(raw, ['mode', 'allocationId', 'authorityAcknowledged'], ['mode']);
  if (raw.mode === 'disabled') { v.object(raw, ['mode']); return { mode: 'disabled' }; }
  v.enumeration(raw.mode, ['inherited-authority']);
  const selected = selection({ allocationId: raw.allocationId, authorityAcknowledged: raw.authorityAcknowledged }, allocations);
  return { mode: 'inherited-authority', ...selected };
}
function referenceMap(raw, keys, ladder) {
  v.object(raw, keys);
  return Object.fromEntries(keys.map(key => [key, v.enumeration(raw[key], ladder)]));
}
function tiers(raw, allocations, providers) {
  const normalized = v.array(raw, entry => {
    v.object(entry, ['id', 'allocationIds']);
    const ids = v.array(entry.allocationIds, v.id, 1, 2, true);
    const selected = ids.map(id => allocations.find(item => item.id === id));
    if (selected.some(item => !item)) v.invalid('Tier refers to an unknown allocation.');
    const targets = selected.map(item => providers.find(native => native.id === item.providerId).target);
    if (new Set(targets).size !== targets.length) v.invalid('Tier alternatives must use distinct targets.');
    return { id: v.id(entry.id), allocationIds: ids };
  }, 2, 8, true);
  unique(normalized);
  const ids = normalized.flatMap(tier => tier.allocationIds);
  if (new Set(ids).size !== ids.length) v.invalid('Task allocation belongs to multiple tiers.');
  return sortedRecords(normalized);
}
function sortedRecords(records) { return [...records].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0); }
function unique(records) { if (new Set(records.map(record => record.id)).size !== records.length) v.invalid('Duplicate record identifier.'); }
function continuation(raw, providers) {
  v.object(raw, ['enabled', 'automaticOnUsageLimit', 'maxSwitches', 'cooldownMs']);
  const normalized = { enabled: v.boolean(raw.enabled), automaticOnUsageLimit: v.boolean(raw.automaticOnUsageLimit),
    maxSwitches: v.integer(raw.maxSwitches, 0, 4), cooldownMs: v.integer(raw.cooldownMs, 1000, 86400000) };
  if ((!normalized.enabled && (normalized.automaticOnUsageLimit || normalized.maxSwitches !== 0))
    || (normalized.automaticOnUsageLimit && (!normalized.enabled || providers.length !== 2 || normalized.maxSwitches === 0))) v.invalid('Invalid continuation consent or budget.');
  if (normalized.automaticOnUsageLimit && !providers.some(item => item.transport === 'codex-app-server' && item.cliVersion === '0.155.1')) {
    fail('AUTOMATIC_UNSUPPORTED', 'No admitted automatic usage-limit source exists.');
  }
  return normalized;
}
function limits(raw) {
  v.object(raw, ['classifierTimeoutMs', 'proposalTimeoutMs', 'taskTimeoutMs', 'taskSubmittedBytes'], ['taskSubmittedBytes']);
  return { classifierTimeoutMs: v.integer(raw.classifierTimeoutMs === undefined ? 30000 : raw.classifierTimeoutMs, 1000, 60000),
    proposalTimeoutMs: v.integer(raw.proposalTimeoutMs === undefined ? 30000 : raw.proposalTimeoutMs, 1000, 60000),
    taskTimeoutMs: v.integer(raw.taskTimeoutMs === undefined ? 300000 : raw.taskTimeoutMs, 5000, 1800000),
    taskSubmittedBytes: v.integer(raw.taskSubmittedBytes, 8192, 65536) };
}
function normalizePolicy(raw) {
  try { return normalizePolicyInternal(raw); } catch (error) {
    if (error instanceof AllocationError && error.code === 'ECC_ALLOCATION_INVALID_INPUT') {
      throw new AllocationError('INVALID_CONFIG', 2, error.message);
    }
    throw error;
  }
}
function normalizePolicyInternal(raw) {
  v.bounded(raw);
  v.object(raw, ['schemaVersion', 'policyVersion', 'providers', 'allocations', 'tiers', 'taskLadder', 'bands',
    'riskMinimums', 'phaseMinimums', 'fallbackTier', 'classifier', 'contextProposals', 'continuation', 'limits']);
  v.enumeration(raw.schemaVersion, ['ecc.allocation-policy.v2']);
  const providers = sortedRecords(v.array(raw.providers, provider, 1, 2, true)); unique(providers);
  if (new Set(providers.map(item => item.target)).size !== providers.length) v.invalid('Provider targets must differ.');
  const allocations = sortedRecords(v.array(raw.allocations, entry => allocation(entry, providers), 2, 32, true)); unique(allocations);
  const normalizedTiers = tiers(raw.tiers, allocations, providers);
  const taskLadder = v.array(raw.taskLadder, v.id, normalizedTiers.length, normalizedTiers.length, true);
  if (taskLadder.some(id => !normalizedTiers.some(tier => tier.id === id))) v.invalid('Task ladder must contain every tier.');
  const bands = referenceMap(raw.bands, ['routine', 'standard', 'demanding'], taskLadder);
  if (bands.routine !== taskLadder[0] || bands.demanding !== taskLadder.at(-1)) v.invalid('Routing bands must bind ladder endpoints.');
  const riskMinimums = referenceMap(raw.riskMinimums, ['low', 'medium', 'high'], taskLadder);
  if (taskLadder.indexOf(riskMinimums.low) > taskLadder.indexOf(riskMinimums.medium)
    || taskLadder.indexOf(riskMinimums.medium) > taskLadder.indexOf(riskMinimums.high)) v.invalid('Risk floors must be nondecreasing.');
  if (raw.fallbackTier !== taskLadder.at(-1)) v.invalid('Fallback tier must be last.');
  v.object(raw.contextProposals, providers.map(item => item.id));
  const contextProposals = Object.fromEntries(providers.map(item => [item.id, selection(raw.contextProposals[item.id], allocations, item.id)]));
  const used = new Set(normalizedTiers.flatMap(tier => tier.allocationIds));
  const normalizedClassifier = classifier(raw.classifier, allocations);
  if (normalizedClassifier.mode !== 'disabled') used.add(normalizedClassifier.allocationId);
  for (const proposal of Object.values(contextProposals)) if (proposal) used.add(proposal.allocationId);
  if (allocations.some(item => !used.has(item.id))) v.invalid('Allocation has no declared purpose.');
  return { schemaVersion: raw.schemaVersion, policyVersion: v.id(raw.policyVersion), providers, allocations, tiers: normalizedTiers,
    taskLadder, bands, riskMinimums, phaseMinimums: referenceMap(raw.phaseMinimums, v.PHASES, taskLadder),
    fallbackTier: raw.fallbackTier, classifier: normalizedClassifier, contextProposals,
    continuation: continuation(raw.continuation, providers), limits: limits(raw.limits) };
}

module.exports = { normalizePolicy, admittedProvider };
