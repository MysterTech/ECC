'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const fixture = require('./allocation-fixture');
const { canonicalDigest, normalizePolicy } = require('../../../scripts/lib/allocation/validation');

async function withTask(callback) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-allocation-controller-')));
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '--quiet', repo], { env: { PATH: process.env.PATH, HOME: directory } });
  fs.writeFileSync(path.join(repo, 'example.md'), 'Original example\n');
  const policy = normalizePolicy(fixture.policy());
  const input = { ...fixture.runInput(), repoRoot: repo, cwd: repo,
    runtimeBindings: Object.fromEntries(policy.providers.map(provider => [provider.id, { runtimeDigest: canonicalDigest(provider) }])) };
  let sequence = 0;
  const calls = [];
  const receiptValue = { bindingDigest: fixture.DIGEST, decision: 'selected', loadedIds: [], resources: [] };
  const dependencies = { clock: () => new Date(fixture.TIMESTAMP), idFactory: prefix => `${prefix}-${++sequence}`,
    inspectRuntimeMetadata: async ({ provider }) => ({ runtimeDigest: canonicalDigest(provider) }),
    inspectRuntime: async ({ provider }) => ({ runtimeDigest: canonicalDigest(provider), routeDigest: provider.authRoute.expectedRouteDigest,
      subscriptionVerified: true, observedAt: fixture.TIMESTAMP, provenance: {} }),
    resolveContextPreview: ({ provider }) => ({ providerId: provider.id, target: provider.target,
      metadataDigest: fixture.DIGEST, registryIdentityDigest: fixture.DIGEST, proposalRequired: false,
      selection: { selectedIds: [], loadedIds: [], resources: [],
        receipt: { ...receiptValue, receiptDigest: canonicalDigest(receiptValue) } } }),
    revalidateContext: binding => binding,
    buildOperationRequest: request => request,
    executeOperation: async (request, { beforeSpawn }) => {
      await beforeSpawn(); calls.push(request);
      return { result: fixture.result(), observed: { backendId: null, modelId: null, effort: null,
        nativeContextTokens: null, childUsageTokens: null, source: 'unavailable' }, metrics: [], finalText: 'Done' };
    } };
  try { return await callback({ directory, repo, policy, input, dependencies, calls, dbPath: path.join(directory, 'state', 'allocation.db') }); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

module.exports = { withTask };
