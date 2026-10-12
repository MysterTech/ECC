'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { digestObject, failure, timestamp } = require('./provider-common');
const { admittedProvider, executeOperation } = require('./provider-process');
const { inspectConfiguration } = require('./runtime-config');
const { probe } = require('./runtime-probe');
const { assertSubscriptionEnvironment, validateSubscriptionBinding, computeSubscriptionRouteDigest } = require('./subscription-guard');

function computeRuntimeDigest(provider) { return digestObject(provider); }

function canonicalDirectory(directory) {
  try {
    if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory || !fs.statSync(directory).isDirectory()) throw new Error('path');
    return directory;
  } catch { throw failure('ECC_ALLOCATION_BINDING_CHANGED', 'Native runtime directory identity changed'); }
}

function nativeEnvironment(provider, context, dependencies) {
  const binding = provider.nativeBinding;
  const getNativeStatus = dependencies.nativeStatus || require('../context-profile-native').getNativeProfileStatus;
  let status;
  try {
    status = getNativeStatus({ stateRoot: binding.stateRoot, nativeRoot: binding.nativeRoot,
      [provider.target === 'claude' ? 'claudePath' : 'codexPath']: provider.executable });
    const state = require('../context-profile-store-fs').readJson(path.join(binding.nativeRoot, 'state.json'));
    if (!status.ready || status.target !== provider.target || status.revision !== binding.revision
      || binding.target !== provider.target || binding.executable !== provider.executable
      || binding.executableDigest !== provider.executableDigest
      || status.executable !== provider.executable || status.executableDigest !== provider.executableDigest
      || state.receiptDigest !== binding.receiptDigest || state.generationId !== binding.generationId
      || state.generationReceiptDigest !== binding.generationReceiptDigest
      || context?.stateRoot !== binding.stateRoot || context?.nativeRoot !== binding.nativeRoot) throw new Error('binding');
  } catch { throw failure('ECC_ALLOCATION_BINDING_CHANGED', 'Native ready receipt binding changed'); }
  return status;
}

function launchEnvironment(provider, status, parentEnv) {
  assertSubscriptionEnvironment(parentEnv);
  if (!status) return { ...parentEnv };
  return { PATH: parentEnv.PATH, HOME: status.home, USERPROFILE: status.home, LANG: 'C.UTF-8',
    ...(provider.target === 'codex' ? { CODEX_HOME: status.codexHome } :
      { CLAUDE_CONFIG_DIR: status.claudeConfigDir, ...require('../context-profile-native').CLAUDE_ISOLATION_ENV }),
    ...(process.platform === 'win32' && parentEnv.SystemRoot ? { SystemRoot: parentEnv.SystemRoot } : {}) };
}

function inspectRuntimeMetadata({ provider, workingRepoRoot, context }, dependencies = {}) {
  admittedProvider(provider);
  if (provider.declaredBackendId !== null && provider.declaredBackendId !== (provider.target === 'codex' ? 'openai' : 'anthropic')) {
    throw failure('ECC_ALLOCATION_SUBSCRIPTION_REQUIRED', 'Declared backend is not an admitted subscription route');
  }
  canonicalDirectory(workingRepoRoot);
  const fingerprint = dependencies.fingerprintExecutable || require('../context-profile-native-executable').fingerprintExecutable;
  let executable;
  try { executable = fingerprint(provider.executable); }
  catch { throw failure('ECC_ALLOCATION_BINDING_CHANGED', 'Native executable identity cannot be verified'); }
  if (executable.path !== provider.executable || executable.digest !== provider.executableDigest) {
    throw failure('ECC_ALLOCATION_BINDING_CHANGED', 'Native executable binding changed');
  }
  const status = provider.environmentMode === 'isolated-native' ? nativeEnvironment(provider, context, dependencies) : null;
  const env = launchEnvironment(provider, status, dependencies.env || process.env);
  const providerHome = canonicalDirectory(provider.target === 'codex' ? env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex')
    : env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude'));
  const configDigests = inspectConfiguration({ provider, providerHome, workingRepoRoot });
  return { providerId: provider.id, runtimeDigest: computeRuntimeDigest(provider), providerHome, configDigests,
    environment: env, nativeEnvironment: status, subscriptionVerified: null,
    automaticQuotaMapping: provider.transport === 'codex-app-server' ? 'codex-app-server-0.155.1-usage-limit-v1' : null };
}

async function inspectRuntime(options, dependencies = {}) {
  const { provider, workingRepoRoot } = options;
  const metadata = inspectRuntimeMetadata(options, dependencies);
  const executeProbe = dependencies.probe || probe;
  const output = await executeProbe(provider.executable, ['--version'], { cwd: workingRepoRoot, env: metadata.environment, spawn: dependencies.spawn });
  const observedVersion = provider.target === 'codex' ? /^codex-cli (\S+)\s*$/.exec(output)?.[1]
    : /^(2\.1\.\d+) \(Claude Code\)\s*$/.exec(output)?.[1];
  if (observedVersion !== provider.cliVersion) throw failure('ECC_ALLOCATION_BINDING_CHANGED', 'Native CLI version binding changed');
  const authentication = await readAuthentication(provider, workingRepoRoot, metadata, dependencies);
  const observation = { target: provider.target, transport: provider.transport, cliVersion: observedVersion,
    executableDigest: provider.executableDigest, providerHome: metadata.providerHome, configDigests: metadata.configDigests,
    method: provider.authRoute.method, authenticated: authentication.authenticated,
    backendId: provider.target === 'codex' ? 'openai' : 'anthropic', paidExtraUsageDisabled: provider.authRoute.paidExtraUsageDisabled,
    overageObserved: false, observedAt: timestamp(dependencies.clock) };
  const { routeDigest } = validateSubscriptionBinding({ provider, observation });
  return { ...metadata, routeDigest, observation, subscriptionVerified: true, subscription: {
    method: observation.method, authenticated: true } };
}

async function readAuthentication(provider, cwd, metadata, dependencies) {
  if (provider.target === 'codex') {
    if (provider.cliVersion !== '0.155.1') throw failure('ECC_ALLOCATION_AUTH_ROUTE_UNVERIFIED', 'Native subscription account schema is not admitted for this version');
    const result = await executeOperation({ command: provider.executable, args: ['app-server', '--listen', 'stdio://'], cwd,
      env: metadata.environment, input: '', provider: { ...provider, transport: 'codex-app-server' },
      allocation: null, phase: 'classifier', purpose: 'auth', timeoutMs: 5000,
      maxOutputBytes: 65536, maxLineBytes: 65536, maxEvents: 64, shutdownTimeoutMs: 1000 }, { spawn: dependencies.spawn });
    return { authenticated: result.accountClass === 'chatgpt' && result.result.category === 'none' };
  }
  const output = await (dependencies.probe || probe)(provider.executable, ['auth', 'status', '--json'], {
    cwd, env: metadata.environment, spawn: dependencies.spawn });
  let result;
  try { result = JSON.parse(output); } catch { throw failure('ECC_ALLOCATION_AUTH_ROUTE_UNVERIFIED', 'Native subscription authentication response is invalid'); }
  // Authentication metadata stays transient; identifiers and emails are discarded.
  return { authenticated: result.loggedIn === true && result.authMethod === 'claude.ai'
    && result.apiProvider === 'firstParty' && ['pro', 'max', 'team', 'enterprise'].includes(result.subscriptionType) };
}

module.exports = { inspectRuntime, inspectRuntimeMetadata, computeRuntimeDigest, computeSubscriptionRouteDigest };
