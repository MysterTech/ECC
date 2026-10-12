'use strict';

const v = require('./validation-primitives');
const METHODS = ['unit', 'integration', 'e2e', 'static', 'human-review'];

function normalizeTask(raw) {
  v.object(raw, ['sessionId', 'taskId', 'revision', 'phase', 'query', 'explicitIds', 'proposedIds', 'noWorkflow'],
    ['sessionId', 'taskId', 'revision', 'phase', 'query']);
  const identity = v.identity(Object.fromEntries(['sessionId', 'taskId', 'revision', 'phase'].map(key => [key, raw[key]])));
  const normalized = { ...identity, query: v.text(raw.query, 8192) };
  for (const key of ['explicitIds', 'proposedIds']) if (Object.hasOwn(raw, key)) normalized[key] = v.array(raw[key], v.id, 0, 8);
  if (Object.hasOwn(raw, 'noWorkflow')) normalized.noWorkflow = v.boolean(raw.noWorkflow);
  if (normalized.noWorkflow && ((normalized.explicitIds || []).length || (normalized.proposedIds || []).length)) v.invalid('No-workflow conflicts with selected context.');
  return normalized;
}
function expectedCheck(raw) {
  v.object(raw, ['checkId', 'method', 'requiredCapabilities']);
  return { checkId: v.id(raw.checkId), method: v.enumeration(raw.method, METHODS), requiredCapabilities: v.array(raw.requiredCapabilities, v.id) };
}
function risk(raw) {
  if (raw === undefined || raw === null) return null;
  v.object(raw, ['level', 'source', 'assessmentId', 'approvedBy']);
  return { level: v.enumeration(raw.level, ['low', 'medium', 'high']),
    source: v.enumeration(raw.source, ['user', 'operator-policy', 'agent-proposal']), assessmentId: v.id(raw.assessmentId),
    approvedBy: v.nullable(raw.approvedBy, v.id) };
}
function normalizeRequirements(raw, task = null) {
  v.object(raw, ['sessionId', 'taskId', 'revision', 'phase', 'complexity', 'ambiguity', 'riskAssessment',
    'requiredCapabilities', 'expectedVerification', 'explicitAllocation'],
  ['sessionId', 'taskId', 'revision', 'phase', 'expectedVerification']);
  const identity = v.identity(Object.fromEntries(['sessionId', 'taskId', 'revision', 'phase'].map(key => [key, raw[key]])));
  if (task) v.sameIdentity(identity, Object.fromEntries(Object.keys(identity).map(key => [key, task[key]])));
  const expectedVerification = v.array(raw.expectedVerification, expectedCheck, 1, 16, true)
    .sort((a, b) => a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0);
  if (new Set(expectedVerification.map(item => item.checkId)).size !== expectedVerification.length) v.invalid('Verification check IDs must be unique.');
  const requiredCapabilities = raw.requiredCapabilities === undefined ? [] : v.array(raw.requiredCapabilities, v.id);
  const union = new Set([...requiredCapabilities, ...expectedVerification.flatMap(check => check.requiredCapabilities)]);
  if (union.size > 16) v.invalid('Required capability union exceeds its limit.');
  return { ...identity, complexity: v.enumeration(raw.complexity === undefined ? 'unknown' : raw.complexity, ['simple', 'moderate', 'complex', 'unknown']),
    ambiguity: v.enumeration(raw.ambiguity === undefined ? 'unknown' : raw.ambiguity, ['clear', 'bounded', 'high', 'unknown']),
    riskAssessment: risk(raw.riskAssessment), requiredCapabilities, expectedVerification,
    explicitAllocation: raw.explicitAllocation === undefined ? null : v.nullable(raw.explicitAllocation, v.id) };
}
function normalizeJournal(raw) {
  v.object(raw, ['plan', 'decisions', 'completed', 'pending']);
  const result = Object.fromEntries(['plan', 'decisions', 'completed', 'pending'].map(key => {
    if (!Array.isArray(raw[key]) || raw[key].length > 24) v.invalid('Invalid journal array length.');
    return [key, raw[key].map(journalText)];
  }));
  v.bounded(result, 32768);
  return result;
}
function journalText(raw) {
  const value = v.text(raw, 1024);
  const credentialedUrl = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]+@/u;
  const knownToken = /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~-]{16,})/u;
  if (credentialedUrl.test(value) || knownToken.test(value)) v.invalid('Journal must not contain recognizable credentials.');
  return value;
}
function normalizeEffectAcknowledgement(raw) {
  v.object(raw, ['assertedBy', 'timestamp', 'relevantWorkStopped', 'effectsDisposition', 'references']);
  return { assertedBy: v.id(raw.assertedBy), timestamp: v.timestamp(raw.timestamp), relevantWorkStopped: v.asserted(raw.relevantWorkStopped),
    effectsDisposition: v.enumeration(raw.effectsDisposition, ['none', 'retained', 'reconciled']), references: v.array(raw.references, v.id) };
}
function automaticAcknowledgement(raw) {
  if (raw === null) return null;
  v.object(raw, ['assertedBy', 'timestamp', 'workspaceSynchronousOnly', 'noDetachedOrExternalEffects', 'policyScopeId']);
  return { assertedBy: v.id(raw.assertedBy), timestamp: v.timestamp(raw.timestamp),
    workspaceSynchronousOnly: v.asserted(raw.workspaceSynchronousOnly), noDetachedOrExternalEffects: v.asserted(raw.noDetachedOrExternalEffects),
    policyScopeId: v.id(raw.policyScopeId) };
}
function evidenceCheck(raw) {
  v.object(raw, ['checkId', 'method', 'result', 'evidenceDigest', 'referenceId']);
  const evidenceDigest = v.nullable(raw.evidenceDigest, v.digest);
  const referenceId = v.nullable(raw.referenceId, v.id);
  if (evidenceDigest === null && referenceId === null) v.invalid('A verification reference or digest is required.');
  return { checkId: v.id(raw.checkId), method: v.enumeration(raw.method, METHODS), result: v.enumeration(raw.result, ['pass', 'fail', 'unavailable']), evidenceDigest, referenceId };
}
function workspaceBinding(raw) {
  v.object(raw, ['head', 'artifactDigest', 'source']);
  const head = v.nullable(raw.head, value => {
    v.text(value, 64); if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) v.invalid('Invalid commit ID.'); return value;
  });
  return { head, artifactDigest: v.digest(raw.artifactDigest), source: v.enumeration(raw.source, ['caller-asserted']) };
}
function normalizeEvidence(raw) {
  v.object(raw, ['assertionOrigin', 'assertedBy', 'timestamp', 'artifactDigest', 'workspaceBinding', 'checks', 'references']);
  const checks = v.array(raw.checks, evidenceCheck, 0, 16, true)
    .sort((a, b) => a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0);
  if (new Set(checks.map(check => check.checkId)).size !== checks.length) v.invalid('Evidence check IDs must be unique.');
  return { assertionOrigin: v.enumeration(raw.assertionOrigin, ['human', 'agent', 'external-runner']), assertedBy: v.id(raw.assertedBy),
    timestamp: v.timestamp(raw.timestamp), artifactDigest: v.digest(raw.artifactDigest), workspaceBinding: workspaceBinding(raw.workspaceBinding),
    checks, references: v.array(raw.references, v.id) };
}
function quota(raw) {
  if (raw === null) return null;
  v.object(raw, ['source', 'providerId', 'signalId', 'scope', 'observedAt', 'resetAt', 'mappingVersion']);
  return { source: v.enumeration(raw.source, ['typed-native']), providerId: v.id(raw.providerId),
    signalId: v.enumeration(raw.signalId, ['usageLimitExceeded']), scope: v.enumeration(raw.scope, ['subscription', 'five-hour', 'seven-day']),
    observedAt: v.timestamp(raw.observedAt), resetAt: v.nullable(raw.resetAt, v.timestamp),
    mappingVersion: v.enumeration(raw.mappingVersion, ['codex-app-server-0.155.1-usage-limit-v1']) };
}
function normalizeTypedResult(raw) {
  v.object(raw, ['spawnState', 'exitStatus', 'signal', 'category', 'rootCompletion', 'cessation', 'observationOrigin',
    'nativeErrorCode', 'quotaObservation', 'toolQuiescence']);
  const result = { spawnState: v.enumeration(raw.spawnState, ['not-started', 'started', 'unknown']),
    exitStatus: v.nullable(raw.exitStatus, value => v.integer(value)), signal: v.nullable(raw.signal, v.id),
    category: v.enumeration(raw.category, ['none', 'spawn-error', 'auth-error', 'model-unavailable', 'provider-error', 'protocol-error',
      'usage-limit', 'timeout', 'output-limit', 'cancelled', 'controller-lost']),
    rootCompletion: v.enumeration(raw.rootCompletion, ['observed', 'unknown']), cessation: v.enumeration(raw.cessation, ['root-only', 'caller-reconciled', 'scoped-automatic', 'unknown']),
    observationOrigin: v.enumeration(raw.observationOrigin, ['controller-observed', 'recovery-asserted']),
    nativeErrorCode: v.nullable(raw.nativeErrorCode, v.id), quotaObservation: quota(raw.quotaObservation),
    toolQuiescence: v.enumeration(raw.toolQuiescence, ['observed-clear', 'pending', 'unknown', 'not-supported']) };
  if ((result.category === 'usage-limit') !== (result.quotaObservation !== null)) v.invalid('Quota category requires its certified observation.');
  if (result.quotaObservation && result.observationOrigin !== 'controller-observed') v.invalid('Recovery assertions cannot certify native quota.');
  return result;
}
function recoveryEvidence(raw) {
  v.object(raw, ['assertedBy', 'timestamp', 'oldOwnerCannotLaunch', 'relevantWorkStopped', 'effectsDisposition', 'references', 'summary']);
  return { assertedBy: v.id(raw.assertedBy), timestamp: v.timestamp(raw.timestamp), oldOwnerCannotLaunch: v.asserted(raw.oldOwnerCannotLaunch),
    relevantWorkStopped: v.asserted(raw.relevantWorkStopped), effectsDisposition: v.enumeration(raw.effectsDisposition, ['none', 'retained', 'reconciled']),
    references: v.array(raw.references, v.id), summary: v.nullable(raw.summary, value => v.text(value, 4096)) };
}

module.exports = { normalizeTask, normalizeRequirements, normalizeJournal, normalizeEffectAcknowledgement,
  automaticAcknowledgement, normalizeEvidence, normalizeTypedResult, recoveryEvidence };
