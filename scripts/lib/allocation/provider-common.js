'use strict';

const { digestObject } = require('../context-profile-support');
const { performance } = require('node:perf_hooks');

function failure(code, message, exitCode = 2) {
  const { AllocationError } = require('./errors');
  return new AllocationError(code, exitCode, message);
}

function safeId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value) ? value : null;
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function timestamp(clock) {
  const raw = typeof clock === 'function' ? clock() : clock?.now?.() ?? new Date();
  const value = new Date(raw);
  return Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString();
}

function monotonic(clock) {
  return typeof clock?.monotonic === 'function' ? clock.monotonic() : performance.now();
}

function baseResult() {
  return { spawnState: 'not-started', exitStatus: null, signal: null, category: 'none',
    rootCompletion: 'unknown', cessation: 'unknown', observationOrigin: 'controller-observed',
    nativeErrorCode: null, quotaObservation: null, toolQuiescence: 'unknown' };
}

function baseObserved() {
  return { backendId: null, modelId: null, effort: null, nativeContextTokens: null,
    childUsageTokens: null, source: 'unavailable' };
}

function metric(name, value, source = 'provider-observed') {
  return { name, value: count(value), scope: 'root', series: name === 'costMicros' ? 'cash' : 'observed',
    currency: null, source: count(value) === null ? 'unavailable' : source, pricing: null };
}

function usageMetrics(usage, durationMs) {
  const input = count(usage?.inputTokens);
  const cached = count(usage?.cachedInputTokens);
  return [metric('inputTokens', input), metric('cachedInputTokens', input !== null && cached !== null && cached <= input ? cached : null),
    metric('outputTokens', usage?.outputTokens), metric('reasoningTokens', usage?.reasoningTokens),
    metric('durationMs', durationMs, 'controller-observed'), metric('costMicros', null)];
}

module.exports = { digestObject, failure, safeId, count, timestamp, monotonic, baseResult, baseObserved, usageMetrics };
