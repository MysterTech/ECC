'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { canonicalDigest } = require('./validation');
const { fail } = require('./errors');

function outside(root, candidate) {
  const relative = path.relative(root, path.resolve(candidate));
  return relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative);
}

function workspaceIdentity(root) {
  const stat = fs.lstatSync(root);
  return { repoRoot: root, device: stat.dev, inode: stat.ino, mode: stat.mode };
}

function workingRoot(input) {
  try {
    if (fs.lstatSync(input.repoRoot).isSymbolicLink() || fs.lstatSync(input.cwd).isSymbolicLink()) fail('BINDING_CHANGED', 'Repository identity is unsafe');
    const repo = fs.realpathSync(input.repoRoot);
    if (repo !== fs.realpathSync(input.cwd) || !fs.statSync(repo).isDirectory()) fail('INVALID_INPUT', 'Use the complete working repository root');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const child = spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', repo, 'rev-parse', '--show-toplevel'],
      { env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0' },
        shell: false, encoding: 'utf8', timeout: 10000, maxBuffer: 8192 });
    if (child.error || child.signal || child.status !== 0 || child.stdout.trim() !== repo) fail('INVALID_INPUT', 'Use the complete Git repository root');
    return repo;
  } catch (error) {
    if (error.code?.startsWith('ECC_ALLOCATION_')) throw error;
    fail('BINDING_CHANGED', 'The working repository cannot be verified');
  }
}

function assertDatabasePath(dbPath, repoRoot, dependencies, dryRun) {
  if (dryRun) return;
  if (dbPath === ':memory:' && dependencies.allowInMemory === true) return;
  if (!path.isAbsolute(dbPath || '') || !outside(repoRoot, dbPath)) fail('INVALID_INPUT', 'Use an explicit absolute database path outside the working repository');
}

async function prepareBindings({ input, policy, dbPath, dryRun, dependencies }) {
  const repoRoot = workingRoot(input);
  assertDatabasePath(dbPath, repoRoot, dependencies, dryRun);
  const providerIds = policy.providers.map(provider => provider.id).sort();
  for (const record of [input.contexts, input.runtimeBindings]) {
    if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(providerIds)) fail('INVALID_INPUT', 'Bind every configured provider exactly once');
  }
  if (policy.continuation.automaticOnUsageLimit && input.automaticContinuationAcknowledgement?.policyScopeId !== policy.policyVersion) {
    fail('INVALID_INPUT', 'Automatic continuation requires the explicit matching workload acknowledgement');
  }
  const previews = {}; const contextSourceBindings = {};
  for (const provider of policy.providers) {
    if (input.runtimeBindings[provider.id].runtimeDigest !== canonicalDigest(provider)) fail('BINDING_CHANGED', 'A pinned runtime descriptor changed');
    const metadata = await dependencies.inspectRuntimeMetadata({ provider, workingRepoRoot: repoRoot, context: input.contexts[provider.id] });
    if (metadata.runtimeDigest !== input.runtimeBindings[provider.id].runtimeDigest) fail('BINDING_CHANGED', 'A runtime binding changed');
    if (metadata.providerHome && !outside(repoRoot, metadata.providerHome)) fail('INVALID_CONFIG', 'Provider homes must be outside the working repository');
    const preview = dependencies.resolveContextPreview({ provider, context: input.contexts[provider.id], task: input.task,
      workingRepoRoot: repoRoot, ...(dependencies.registryRoot ? { registryRoot: dependencies.registryRoot } : {}) });
    if (preview.proposalRequired && !policy.contextProposals[provider.id]) fail('INVALID_CONFIG', 'Required context proposal allocation is missing');
    previews[provider.id] = preview;
    contextSourceBindings[provider.id] = { metadataDigest: preview.metadataDigest, registryIdentityDigest: preview.registryIdentityDigest };
  }
  const binding = { taskDigest: canonicalDigest(input.task), queryDigest: canonicalDigest(input.task.query),
    requirementsDigest: canonicalDigest(input.requirements), policyDigest: canonicalDigest(policy),
    contextSetDigest: canonicalDigest({ contexts: input.contexts, contextSourceBindings }),
    runtimeSetDigest: canonicalDigest(input.runtimeBindings), repoIdentityDigest: canonicalDigest(workspaceIdentity(repoRoot)),
    repoRoot, cwd: repoRoot, contexts: input.contexts, contextSourceBindings, runtimeBindings: input.runtimeBindings, requirements: input.requirements };
  return { binding, previews };
}

async function prepareSaved({ revision, task, policy, dbPath, dependencies }) {
  if (canonicalDigest(policy) !== revision.policyDigest) fail('BINDING_CHANGED', 'Saved policy changed');
  const { binding, previews } = await prepareBindings({ input: { task, requirements: revision.binding.requirements,
    repoRoot: revision.binding.repoRoot, cwd: revision.binding.cwd, contexts: revision.binding.contexts,
    runtimeBindings: revision.binding.runtimeBindings, automaticContinuationAcknowledgement: revision.automaticContinuationAcknowledgement },
  policy, dbPath, dryRun: false, dependencies });
  if (canonicalDigest(binding) !== canonicalDigest(revision.binding)) fail('BINDING_CHANGED', 'Saved task, context, workspace or runtime binding changed');
  return { binding, previews };
}

module.exports = { prepareBindings, prepareSaved, workingRoot, workspaceIdentity, outside };
