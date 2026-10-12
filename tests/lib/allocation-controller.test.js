'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./helpers/allocation-fixture');
const { withTask } = require('./helpers/allocation-controller-fixture');
const { runAllocationOperation } = require('../../scripts/lib/allocation/controller');

test('pure preview reports deterministic choice without DB, auth, execution or selected-body loading', () => withTask(async context => {
  const dependencies = { ...context.dependencies,
    createAllocationStore: () => assert.fail('preview must not open DB'),
    inspectRuntime: () => assert.fail('preview must not inspect auth'),
    executeOperation: () => assert.fail('preview must not execute'),
    revalidateContext: () => assert.fail('preview must not load selected bodies') };
  const result = await runAllocationOperation({ operation: 'run', input: context.input, policy: context.policy, dryRun: true }, dependencies);
  assert.equal(result.status, 'proposed');
  assert.equal(result.route.tierId, 'routine');
  assert.equal(result.frontier, null);
  assert.equal(result.operations.length, 0);
}));

test('task completion stays unverified, replay cannot execute and status omits private prose', () => withTask(async context => {
  const options = { operation: 'run', input: context.input, policy: context.policy, dbPath: context.dbPath };
  const first = await runAllocationOperation(options, context.dependencies);
  assert.equal(first.taskState, 'awaiting-checkpoint');
  assert.equal(context.calls.length, 1);
  assert.equal(first.execution.exitStatus, 0);
  const replay = await runAllocationOperation(options, context.dependencies);
  assert.equal(replay.replayed, true);
  assert.equal(context.calls.length, 1);
  const status = await runAllocationOperation({ operation: 'status', dbPath: context.dbPath,
    input: { schemaVersion: 'ecc.allocation-status.v2', identity: fixture.identity(), operationId: null } }, context.dependencies);
  assert.equal(status.status, 'read');
  assert.equal(status.taskState, 'awaiting-checkpoint');
  assert.ok(!JSON.stringify(status).includes(context.input.task.query));
}));

test('ambiguous provider errors never start an alternative automatically', () => withTask(async context => {
  const policy = { ...context.policy, continuation: { ...context.policy.continuation, automaticOnUsageLimit: true } };
  const input = { ...context.input, automaticContinuationAcknowledgement: fixture.automaticAcknowledgement() };
  const dependencies = { ...context.dependencies, executeOperation: async (request, { beforeSpawn }) => {
    await beforeSpawn(); context.calls.push(request);
    return { result: fixture.result({ exitStatus: 1, category: 'provider-error' }),
      observed: { backendId: null, modelId: null, effort: null, nativeContextTokens: null, childUsageTokens: null, source: 'unavailable' },
      metrics: [], finalText: 'Usage limit exceeded' };
  } };
  const result = await runAllocationOperation({ operation: 'run', input, policy, dbPath: context.dbPath }, dependencies);
  assert.equal(context.calls.length, 1);
  assert.equal(result.taskState, 'blocked');
  assert.equal(result.execution.quotaObservation, null);
}));

test('recording failure after execution reports incomplete recording without retry', () => withTask(async context => {
  const { createAllocationStore } = require('../../scripts/lib/state-store');
  const dependencies = { ...context.dependencies, createAllocationStore: async options => {
    const store = await createAllocationStore(options);
    return { ...store, recordOperationCompletion() { throw new Error('private failure detail'); } };
  } };
  const result = await runAllocationOperation({ operation: 'run', input: context.input, policy: context.policy, dbPath: context.dbPath }, dependencies);
  assert.equal(result.status, 'ran-recording-incomplete');
  assert.equal(result.code, 'ECC_ALLOCATION_PERSISTENCE_FAILED');
  assert.equal(context.calls.length, 1);
  assert.ok(!JSON.stringify(result).includes('private failure detail'));
}));

module.exports = { withTask };
