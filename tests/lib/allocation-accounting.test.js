'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeAccounting } = require('../../scripts/lib/allocation/accounting');
const metric = value => ({ name: 'inputTokens', value, scope: 'root', series: 'observed', currency: null,
  source: value === null ? 'unavailable' : 'provider-observed', pricing: null });
const operation = (id, value, spawnState = 'started') => ({ operationId: id,
  result: { spawnState }, metrics: [metric(value)] });
test('root totals include both providers and exclude proven no-spawn work', () => {
  const results = summarizeAccounting({ operations: [operation('codex', 3), operation('claude', 5), operation('no-spawn', null, 'not-started')] });
  const input = results.find(row => row.name === 'inputTokens' && row.scope === 'root');
  assert.equal(input.completeTotal, 8);
  assert.equal(input.observedOperations, 2);
  assert.equal(input.completeness, 'complete');
});
test('missing constituents produce a known subtotal and unknown child populations remain unknown', () => {
  const results = summarizeAccounting({ operations: [operation('a', 3), operation('b', null)] });
  const root = results.find(row => row.name === 'inputTokens' && row.scope === 'root');
  assert.equal(root.knownSubtotal, 3);
  assert.equal(root.completeTotal, null);
  assert.equal(root.missingOperations, 1);
  assert.equal(root.completeness, 'known-subtotal');
  const whole = results.find(row => row.name === 'inputTokens' && row.scope === 'whole-task');
  assert.equal(whole.observedOperations, null);
  assert.equal(whole.completeTotal, null);
  assert.equal(whole.completeness, 'unavailable');
});
test('empty populations have unavailable totals and overflow is not silently rounded', () => {
  const empty = summarizeAccounting({ operations: [] }).find(row => row.name === 'inputTokens' && row.scope === 'root');
  assert.equal(empty.knownSubtotal, null);
  assert.equal(empty.completeTotal, null);
  assert.equal(empty.completeness, 'unavailable');
  assert.throws(() => summarizeAccounting({ operations: [operation('a', Number.MAX_SAFE_INTEGER), operation('b', 1)] }), /overflow/i);
});
