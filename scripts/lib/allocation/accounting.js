'use strict';
const { fail } = require('./errors');
const NAMES = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'durationMs'];

function safeValue(value) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) fail('INVALID_INPUT', 'Invalid accounting observation');
  return value;
}

function sum(values) {
  return values.reduce((total, value) => {
    const next = total + safeValue(value);
    if (!Number.isSafeInteger(next)) fail('INVALID_INPUT', 'Accounting overflow');
    return next;
  }, 0);
}

function key(metric) { return JSON.stringify([metric.name, metric.series, metric.currency]); }

function row(group, observations, population, scope) {
  const known = observations.filter(value => value !== null);
  const subtotal = known.length ? sum(known) : null;
  const missing = population === null ? null : population - known.length;
  return { ...group, scope, observedOperations: population === null ? null : known.length,
    missingOperations: missing, knownSubtotal: subtotal,
    completeTotal: population !== null && population > 0 && missing === 0 ? subtotal : null,
    completeness: !known.length ? 'unavailable' : missing === 0 ? 'complete' : 'known-subtotal' };
}

function observationsFor(operation) {
  const entries = (operation.metrics || []).map(metric => {
    if (![...NAMES, 'costMicros'].includes(metric.name)
      || !['observed', 'cash', 'API-equivalent'].includes(metric.series)
      || !(metric.currency === null || /^[A-Z]{3}$/.test(metric.currency))) fail('INVALID_INPUT', 'Invalid accounting metric');
    safeValue(metric.value);
    if (metric.name === 'costMicros' && metric.value !== null && metric.currency === null) fail('INVALID_INPUT', 'Observed cost requires currency');
    return [key(metric), metric.value];
  });
  if (new Set(entries.map(([id]) => id)).size !== entries.length) fail('INVALID_INPUT', 'Duplicate accounting observation');
  return new Map(entries);
}

function summarizeAccounting({ operations, timingObservations = [] }) {
  if (!Array.isArray(operations) || !Array.isArray(timingObservations)) fail('INVALID_INPUT', 'Invalid accounting population');
  const invoked = operations.filter(operation => operation.state !== 'reserved' && operation.result?.spawnState !== 'not-started');
  const groups = new Map(NAMES.map(name => {
    const group = { name, series: 'observed', currency: null }; return [key(group), group];
  }));
  const observations = invoked.map(operation => {
    for (const metric of operation.metrics || []) groups.set(key(metric), { name: metric.name, series: metric.series, currency: metric.currency });
    return observationsFor(operation);
  });
  const roots = [...groups].map(([id, group]) => row(group, observations.map(map => map.get(id) ?? null), invoked.length, 'root'));
  const whole = [...groups.values()].map(group => row(group, [], null, 'whole-task'));
  const times = ['verification', 'human', 'recovery'].map(scope => {
    const matching = timingObservations.filter(observation => observation.scope === scope);
    matching.forEach(observation => safeValue(observation.value));
    return row({ name: 'durationMs', series: 'observed', currency: null }, matching.map(observation => observation.value),
      matching.length ? matching.length : null, scope);
  });
  return [...roots, ...whole, ...times];
}
module.exports = { summarizeAccounting };
