'use strict';

const { fail } = require('./errors');
const v = require('./validation-primitives');
const { canonicalDigest } = require('./validation');

function requiredTags(requirements) {
  return [...new Set([...requirements.requiredCapabilities,
    ...requirements.expectedVerification.flatMap(check => check.requiredCapabilities)])];
}
function compatibleAllocation(policy, requirements, allocation) {
  return allocation.maxSubmittedBytes >= policy.limits.taskSubmittedBytes
    && requiredTags(requirements).every(tag => allocation.capabilities.includes(tag));
}
function compatibility(policy, requirements) {
  const entries = policy.taskLadder.map(tierId => {
    const tier = policy.tiers.find(item => item.id === tierId);
    return { tierId, allocationIds: tier.allocationIds.filter(id => compatibleAllocation(policy, requirements,
      policy.allocations.find(allocation => allocation.id === id))) };
  });
  const first = entries.findIndex(entry => entry.allocationIds.length > 0);
  if (first < 0 || entries.slice(first).some(entry => entry.allocationIds.length === 0)) {
    fail('INCOMPATIBLE', 'Task compatibility must form a nonempty ladder suffix.');
  }
  const risk = requirements.riskAssessment?.approvedBy ? requirements.riskAssessment.level : 'high';
  const floor = Math.max(first, policy.taskLadder.indexOf(policy.riskMinimums[risk]), policy.taskLadder.indexOf(policy.phaseMinimums[requirements.phase]));
  return { entries, eligibleTierIds: policy.taskLadder.slice(floor), floor };
}
function unavailable(policy, providerId, availability, now) {
  const provider = policy.providers.find(item => item.id === providerId);
  const runtimeDigest = canonicalDigest(provider);
  return availability.some(record => record.providerId === providerId && record.runtimeDigest === runtimeDigest
    && Date.parse(record.holdoffUntil) > Date.parse(now));
}
function selectTierAlternative({ policy, tierId, requirements, availability = [], visitedIds = [], now }) {
  v.timestamp(now);
  const compatible = compatibility(policy, requirements);
  if (!compatible.eligibleTierIds.includes(tierId)) fail('INCOMPATIBLE', 'Selected tier is below the task minimum.');
  const eligibleAllocationIds = compatible.entries.find(entry => entry.tierId === tierId).allocationIds;
  const allocationId = eligibleAllocationIds.find(id => !visitedIds.includes(id)
    && !unavailable(policy, policy.allocations.find(allocation => allocation.id === id).providerId, availability, now)) || null;
  return { status: allocationId ? 'selected' : 'provider-paused', allocationId, eligibleAllocationIds: [...eligibleAllocationIds] };
}
function routeRecord(policy, compatible) {
  return { source: null, reasonCode: null, classifierReasonCode: null, tierId: null, allocationId: null,
    eligibleTierIds: [...compatible.eligibleTierIds], eligibleAllocationIds: compatible.entries
      .filter(entry => compatible.eligibleTierIds.includes(entry.tierId)).flatMap(entry => entry.allocationIds),
    classifierStatus: 'not-needed', policyDigest: canonicalDigest(policy), runtimeSetDigest: null };
}
function band(requirements) {
  if (requirements.complexity === 'complex' || requirements.ambiguity === 'high') return 'demanding';
  if (requirements.complexity === 'simple' && requirements.ambiguity === 'clear') return 'routine';
  if (requirements.complexity === 'moderate' && ['clear', 'bounded'].includes(requirements.ambiguity)) return 'standard';
  return null;
}
function selectedRoute(args, route, tierId, source, reasonCode, classifierStatus = 'not-needed') {
  const choice = selectTierAlternative({ ...args, tierId, visitedIds: [] });
  return { route: { ...route, source, reasonCode, tierId, allocationId: choice.allocationId, classifierStatus }, pendingClassifier: null };
}
function explicitRoute(args, route, compatible) {
  const { policy, requirements, availability, now } = args;
  const allocation = policy.allocations.find(item => item.id === requirements.explicitAllocation);
  const tier = policy.tiers.find(item => item.allocationIds.includes(requirements.explicitAllocation));
  if (!allocation || !tier || !compatible.eligibleTierIds.includes(tier.id)
    || !compatibleAllocation(policy, requirements, allocation)) fail('INCOMPATIBLE', 'Explicit allocation does not satisfy the task requirements.');
  if (unavailable(policy, allocation.providerId, availability, now)) fail('PROVIDER_PAUSED', 'Explicit provider is within its holdoff.', 1);
  return { route: { ...route, source: 'explicit', reasonCode: 'explicit-choice', tierId: tier.id, allocationId: allocation.id }, pendingClassifier: null };
}
function evaluateInitialRoute({ policy, requirements, availability = [], now }) {
  v.timestamp(now);
  const args = { policy, requirements, availability, now };
  const compatible = compatibility(policy, requirements);
  const route = routeRecord(policy, compatible);
  if (requirements.explicitAllocation) return explicitRoute(args, route, compatible);
  const selectedBand = band(requirements);
  if (selectedBand) {
    const index = Math.max(compatible.floor, policy.taskLadder.indexOf(policy.bands[selectedBand]));
    return selectedRoute(args, route, policy.taskLadder[index], 'deterministic', `${selectedBand}-band`);
  }
  if (compatible.eligibleTierIds.length === 1) return selectedRoute(args, route, compatible.eligibleTierIds[0], 'deterministic', 'sole-eligible');
  if (policy.classifier.mode === 'disabled') return selectedRoute(args, route, policy.fallbackTier, 'fallback', 'classifier-disabled', 'disabled');
  return { route: { ...route, classifierStatus: 'would-call' },
    pendingClassifier: { allocationId: policy.classifier.allocationId, eligibleTierIds: [...compatible.eligibleTierIds] } };
}
function validateClassifierChoice({ policy, requirements, pendingRoute, response }) {
  v.object(response, ['tierId', 'reasonCode']);
  const tierId = v.id(response.tierId);
  const reasonCode = v.enumeration(response.reasonCode, ['requirements-match', 'conservative', 'uncertain']);
  const route = pendingRoute.route || pendingRoute;
  if (!compatibility(policy, requirements).eligibleTierIds.includes(tierId)
    || !route.eligibleTierIds.includes(tierId) || route.classifierStatus !== 'would-call') {
    fail('INCOMPATIBLE', 'Classifier selected an ineligible task tier.');
  }
  return { tierId, reasonCode };
}
function transition(status, tierId, allocationId, reason) { return { status, tierId, allocationId, reason }; }
function planCapabilitySuccessor({ policy, revision, attempt, checkpoint, availability = [], now }) {
  const current = policy.taskLadder.indexOf(attempt.tierId);
  if (current < 0) fail('INCOMPATIBLE', 'Attempt has an unknown tier.');
  if (!['verification-failure', 'unresolved-ambiguity', 'stalled'].includes(checkpoint.kind) || checkpoint.cause !== 'capability') {
    return transition('blocked', attempt.tierId, null, 'non-capability');
  }
  if (current === policy.taskLadder.length - 1) return transition('exhausted', attempt.tierId, null, 'capability');
  const tierId = policy.taskLadder[current + 1];
  const choice = selectTierAlternative({ policy, tierId, requirements: revision.requirements, availability, visitedIds: [], now });
  return transition(choice.status === 'selected' ? 'successor' : 'provider-paused', tierId, choice.allocationId, 'capability');
}
function sourceIsCeased(sourceOperation) {
  if (!['completed', 'not-started'].includes(sourceOperation.state) || !sourceOperation.result) return false;
  const result = sourceOperation.result;
  if (result.spawnState === 'not-started') return true;
  if (result.cessation === 'caller-reconciled') return true;
  return result.spawnState === 'started' && result.rootCompletion === 'observed' && result.exitStatus !== null && result.signal === null
    && !['timeout', 'output-limit', 'cancelled', 'controller-lost'].includes(result.category);
}
function switchCandidates(policy, revision, attempt, availability, now) {
  const source = policy.allocations.find(item => item.id === attempt.allocationId);
  const choice = selectTierAlternative({ policy, tierId: attempt.tierId, requirements: revision.requirements,
    availability, visitedIds: revision.visitedAllocationIds || [], now });
  return choice.eligibleAllocationIds.filter(id => {
    const allocation = policy.allocations.find(item => item.id === id);
    return allocation.providerId !== source.providerId && !(revision.visitedAllocationIds || []).includes(id)
      && !unavailable(policy, allocation.providerId, availability, now);
  });
}
function planProviderSwitch({ policy, revision, attempt, sourceOperation, destinationAllocationId = null, availability = [], now }) {
  if (!policy.continuation.enabled) fail('INVALID_INPUT', 'Portable provider continuation is disabled.');
  if (['asserted-success', 'exhausted', 'abandoned', 'recovery-required', 'successor-reserved', 'active'].includes(revision.taskState)) {
    fail('CONFLICT', 'The current task frontier cannot switch providers.', 3);
  }
  if (!sourceIsCeased(sourceOperation)) fail('RECOVERY_REQUIRED', 'Relevant source work must be stopped and reconciled.', 4);
  if ((revision.switchCount || 0) >= policy.continuation.maxSwitches) fail('SWITCH_BUDGET_EXHAUSTED', 'The provider switch budget is exhausted.', 1);
  const tier = policy.tiers.find(item => item.id === attempt.tierId);
  if (!tier || !tier.allocationIds.includes(attempt.allocationId)) fail('INCOMPATIBLE', 'Attempt allocation does not belong to its tier.');
  const candidates = switchCandidates(policy, revision, attempt, availability, now);
  if (destinationAllocationId !== null && !candidates.includes(destinationAllocationId)) fail('INCOMPATIBLE', 'Requested destination is unavailable, visited or outside the accepted tier.');
  const allocationId = destinationAllocationId || candidates[0] || null;
  const reason = sourceOperation.result.category === 'usage-limit' && policy.continuation.automaticOnUsageLimit ? 'usage-limit' : 'manual';
  return transition(allocationId ? 'successor' : 'provider-paused', attempt.tierId, allocationId, reason);
}

module.exports = { evaluateInitialRoute, validateClassifierChoice, selectTierAlternative,
  planCapabilitySuccessor, planProviderSwitch, compatibility, compatibleAllocation, sourceIsCeased };
