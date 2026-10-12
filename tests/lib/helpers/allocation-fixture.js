'use strict';

const DIGEST = 'a'.repeat(64);
const TIMESTAMP = '2026-10-11T00:00:00.000Z';
const PHASES = ['explore', 'plan', 'implement', 'debug', 'review', 'verify', 'docs', 'maintenance'];

function provider(target) {
  return {
    id: target, target,
    transport: target === 'codex' ? 'codex-app-server' : 'claude-stream-json',
    adapterVersion: target === 'codex' ? 'ecc.codex-app-server-allocation.v1' : 'ecc.claude-allocation.v1',
    cliVersion: target === 'codex' ? '0.155.1' : '2.1.261',
    executable: `/fixture/${target}`, executableDigest: DIGEST, environmentMode: 'current-provider',
    declaredBackendId: target === 'codex' ? 'openai' : null, knownConfigBindings: [], nativeBinding: null,
    authRoute: { mode: 'subscription-only', method: target === 'codex' ? 'codex-chatgpt' : 'claude-oauth',
      expectedRouteDigest: DIGEST, observedAt: TIMESTAMP, paidExtraUsageDisabled: true },
  };
}

function policy() {
  const tiers = ['routine', 'standard', 'demanding'];
  return {
    schemaVersion: 'ecc.allocation-policy.v2', policyVersion: 'fixture-policy',
    providers: [provider('codex'), provider('claude')],
    allocations: tiers.flatMap((tier, index) => ['codex', 'claude'].map(target => ({
      id: `${tier}-${target}`, providerId: target, modelId: `fixture-model-${index}`,
      effort: ['low', 'medium', 'high'][index], descriptor: `${tier} fixture allocation`,
      capabilities: index === 0 ? [] : ['code', 'verify'], maxSubmittedBytes: 65536,
    }))),
    tiers: tiers.map(id => ({ id, allocationIds: [`${id}-codex`, `${id}-claude`] })),
    taskLadder: tiers,
    bands: { routine: 'routine', standard: 'standard', demanding: 'demanding' },
    riskMinimums: { low: 'routine', medium: 'standard', high: 'standard' },
    phaseMinimums: Object.fromEntries(PHASES.map(phase => [phase, ['docs', 'maintenance'].includes(phase) ? 'routine' : 'standard'])),
    fallbackTier: 'demanding', classifier: { mode: 'disabled' },
    contextProposals: { codex: null, claude: null },
    continuation: { enabled: true, automaticOnUsageLimit: false, maxSwitches: 2, cooldownMs: 1000 },
    limits: { taskSubmittedBytes: 65536 },
  };
}

function identity() { return { sessionId: 'session', taskId: 'task', revision: 1, phase: 'docs' }; }
function task() { return { ...identity(), query: 'Update the documented example.' }; }
function requirements() {
  return { ...identity(), complexity: 'simple', ambiguity: 'clear',
    riskAssessment: { level: 'low', source: 'user', assessmentId: 'risk', approvedBy: 'operator' },
    expectedVerification: [{ checkId: 'lint', method: 'static', requiredCapabilities: [] }] };
}
function effectAcknowledgement() {
  return { assertedBy: 'operator', timestamp: TIMESTAMP, relevantWorkStopped: true,
    effectsDisposition: 'retained', references: [] };
}
function automaticAcknowledgement() {
  return { assertedBy: 'operator', timestamp: TIMESTAMP, workspaceSynchronousOnly: true,
    noDetachedOrExternalEffects: true, policyScopeId: 'fixture-policy' };
}
function runInput() {
  return { schemaVersion: 'ecc.allocation-run.v2', requestId: 'request', task: task(),
    requirements: requirements(), repoRoot: '/fixture/workspace', cwd: '/fixture/workspace',
    contexts: Object.fromEntries(['codex', 'claude'].map(id => [id, { mode: 'explicit', profileId: 'lean@1',
      selectionMode: 'manual', include: [], exclude: [] }])),
    runtimeBindings: { codex: { runtimeDigest: DIGEST }, claude: { runtimeDigest: DIGEST } },
    previousClosureAcknowledgement: null, automaticContinuationAcknowledgement: null };
}
function result(overrides = {}) {
  return { spawnState: 'started', exitStatus: 0, signal: null, category: 'none',
    rootCompletion: 'observed', cessation: 'root-only', observationOrigin: 'controller-observed',
    nativeErrorCode: null, quotaObservation: null, toolQuiescence: 'observed-clear', ...overrides };
}

module.exports = { DIGEST, TIMESTAMP, PHASES, provider, policy, identity, task, requirements,
  effectAcknowledgement, automaticAcknowledgement, runInput, result };
