'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { fixture } = require('./helpers/allocation-provider-fixture');
const { validateSubscriptionBinding, computeSubscriptionRouteDigest, assertSubscriptionEnvironment } = require('../../scripts/lib/allocation/subscription-guard');
const { computeRuntimeDigest, inspectRuntime, inspectRuntimeMetadata } = require('../../scripts/lib/allocation/runtime');
const { appServerSource } = require('./helpers/allocation-provider-fixture');

function runtimeFixture(t, target = 'codex') {
  const f = fixture(t, target, target === 'codex' ? 'codex-app-server' : 'claude-stream-json');
  f.providerHome = path.join(f.home, target === 'codex' ? '.codex' : '.claude');
  fs.mkdirSync(f.providerHome);
  f.dependencies = { env: { HOME: f.home, PATH: process.env.PATH },
    fingerprintExecutable: executable => ({ path: executable, digest: f.provider.executableDigest }) };
  const o = { ...observation(f), providerHome: f.providerHome, backendId: target === 'codex' ? 'openai' : 'anthropic' };
  f.provider.authRoute.expectedRouteDigest = computeSubscriptionRouteDigest({ provider: f.provider, observation: o });
  f.options = { provider: f.provider, workingRepoRoot: f.root, context: {} };
  return f;
}

function bindConfig(f, relative, body, normalization = 'raw') {
  const file = path.join(f.providerHome, relative);
  fs.writeFileSync(file, body);
  f.provider.knownConfigBindings = [{ path: file, normalization,
    digest: crypto.createHash('sha256').update(body).digest('hex') }];
  return file;
}

test('static metadata verifies pinned config and executable without native commands', t => {
  const f = runtimeFixture(t); let invoked = false;
  const metadata = inspectRuntimeMetadata(f.options, { ...f.dependencies, spawn() { invoked = true; } });
  assert.equal(metadata.subscriptionVerified, null);
  assert.equal(metadata.providerHome, f.providerHome);
  assert.equal(invoked, false);
});

test('actual auth inspection does read-only app-server account handshake without creating a turn', async t => {
  const f = runtimeFixture(t);
  f.executable(`if(process.argv.includes('--version')){console.log('codex-cli 0.155.1');process.exit(0);}\n${appServerSource()}`);
  const result = await inspectRuntime(f.options, f.dependencies);
  assert.equal(result.subscriptionVerified, true);
  assert.equal(result.routeDigest, f.provider.authRoute.expectedRouteDigest);
  assert.equal(JSON.stringify(result.observation).includes('email'), false);
});

test('Claude strict native auth metadata excludes account identifiers', async t => {
  const f = runtimeFixture(t, 'claude');
  f.executable(`if(process.argv.includes('--version'))console.log('2.1.261 (Claude Code)');else console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max',email:'private@example.invalid'}));`);
  const result = await inspectRuntime(f.options, f.dependencies);
  assert.equal(result.subscriptionVerified, true);
  assert.equal(JSON.stringify(result.observation).includes('private@example'), false);
});

test('unknown Claude auth fields and supported-exec older auth schema fail closed', async t => {
  const claude = runtimeFixture(t, 'claude');
  claude.executable(`if(process.argv.includes('--version'))console.log('2.1.261 (Claude Code)');else console.log('{}');`);
  await assert.rejects(inspectRuntime(claude.options, claude.dependencies), /subscription|route/i);
  const codex = runtimeFixture(t);
  codex.provider.transport = 'codex-exec'; codex.provider.adapterVersion = 'ecc.codex-allocation.v1'; codex.provider.cliVersion = '0.154.0';
  codex.executable(`console.log('codex-cli 0.154.0');`);
  await assert.rejects(inspectRuntime(codex.options, codex.dependencies), /schema|subscription|route/i);
});

for (const config of ['model_provider="thirdparty"\n', '[model_providers.openai]\nbase_url="https://example.invalid"\n',
  'forced_login_method="api"\n']) {
  test(`reject pinned Codex backend override ${config.split('\n')[0]}`, t => {
    const f = runtimeFixture(t); bindConfig(f, 'config.toml', config);
    assert.throws(() => inspectRuntimeMetadata(f.options, f.dependencies), /billing|route/i);
  });
}

test('route-bearing configuration must be pinned; edited/symlinked bindings reject', t => {
  const f = runtimeFixture(t);
  const file = bindConfig(f, 'config.toml', 'model_provider="openai"\n');
  const records = f.provider.knownConfigBindings; f.provider.knownConfigBindings = [];
  assert.throws(() => inspectRuntimeMetadata(f.options, f.dependencies), /pinned/i);
  f.provider.knownConfigBindings = records; fs.appendFileSync(file, '# drift\n');
  assert.throws(() => inspectRuntimeMetadata(f.options, f.dependencies), /binding/i);
  fs.unlinkSync(file); fs.symlinkSync(path.join(f.root, 'missing'), file);
  assert.throws(() => inspectRuntimeMetadata(f.options, f.dependencies), /binding|safely/i);
});

test('declared immutable nonconfig inputs hash as raw rather than being parsed as JSON', t => {
  const f = runtimeFixture(t); bindConfig(f, 'AGENTS.md', 'Native instruction context\n');
  assert.equal(inspectRuntimeMetadata(f.options, f.dependencies).configDigests.length, 1);
});

test('config unknown normalization, malformed route metadata and executable drift reject safely', t => {
  const f = runtimeFixture(t, 'claude');
  bindConfig(f, 'settings.json', '{}', 'claude-provider-bookkeeping-v1');
  assert.throws(() => inspectRuntimeMetadata(f.options, f.dependencies), /normalization/i);
  bindConfig(f, 'settings.json', '{malformed');
  assert.throws(() => inspectRuntimeMetadata(f.options, f.dependencies), /configuration/i);
  assert.throws(() => inspectRuntimeMetadata(f.options, { ...f.dependencies, fingerprintExecutable: () => ({path:f.provider.executable,digest:'f'.repeat(64)}) }), /executable/i);
});

test('declared backend cannot relabel native subscription as an alternate API route', t => {
  const f = runtimeFixture(t); f.provider.declaredBackendId = 'custom-provider';
  assert.throws(() => inspectRuntimeMetadata(f.options, f.dependencies), /backend|route/i);
});

test('isolated native metadata binds ready target/generation/context without preparing or copying credentials', t => {
  const f = runtimeFixture(t, 'claude');
  const nativeRoot = path.join(f.root, 'native'); const stateRoot = path.join(f.root, 'state');
  fs.mkdirSync(nativeRoot); fs.mkdirSync(stateRoot);
  const state = { receiptDigest: '1'.repeat(64), generationId: 'generation-fixture', generationReceiptDigest: '2'.repeat(64) };
  fs.writeFileSync(path.join(nativeRoot, 'state.json'), JSON.stringify(state));
  f.provider.environmentMode = 'isolated-native'; f.provider.cliVersion = '2.1.292';
  f.provider.nativeBinding = { ...state, nativeRoot, stateRoot, revision: 1, target: 'claude',
    executable: f.provider.executable, executableDigest: f.provider.executableDigest };
  f.options.context = { nativeRoot, stateRoot };
  const status = { ready: true, target: 'claude', revision: 1, executable: f.provider.executable,
    executableDigest: f.provider.executableDigest, home: f.home, claudeConfigDir: f.providerHome, pluginDir: path.join(f.root,'plugin') };
  const deps = { ...f.dependencies, nativeStatus: () => status };
  const result = inspectRuntimeMetadata(f.options, deps);
  assert.equal(result.environment.CLAUDE_CONFIG_DIR, f.providerHome);
  assert.equal(result.environment.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
  assert.equal(result.nativeEnvironment.pluginDir, status.pluginDir);
  assert.throws(() => inspectRuntimeMetadata({ ...f.options, context: { stateRoot, nativeRoot: '/tmp/changed' } }, deps), /receipt/i);
  assert.throws(() => inspectRuntimeMetadata(f.options, { ...deps, nativeStatus: () => ({ ...status, ready: false }) }), /receipt/i);
});

test('normalized Codex bookkeeping is scoped while meaningful config and provider home identity remain bound', t => {
  const f = runtimeFixture(t);
  const file = bindConfig(f, 'config.toml', 'model_provider="openai"\n[projects.fixture]\ntrust_level="trusted"\n', 'codex-provider-bookkeeping-v1');
  f.provider.knownConfigBindings[0].digest = require('../../scripts/lib/context-profile-support').digestObject({model_provider:'openai'});
  assert.equal(inspectRuntimeMetadata(f.options, f.dependencies).configDigests.length, 1);
  fs.appendFileSync(file, '\nmodel="new-model"\n'); // Still within bookkeeping projects.fixture; intentionally ignored.
  assert.equal(inspectRuntimeMetadata(f.options, f.dependencies).configDigests.length, 1);
  const alias = path.join(f.root, 'home-alias'); fs.symlinkSync(f.providerHome, alias);
  assert.throws(() => inspectRuntimeMetadata(f.options, { ...f.dependencies, env: { ...f.dependencies.env, CODEX_HOME: alias } }), /directory/i);
});

test('auth metadata rejects CLI drift, malformed observations and native probe failure with safe messages', async t => {
  const f = runtimeFixture(t, 'claude');
  for (const source of ["console.log('2.1.999 (Claude Code)');", "if(process.argv.includes('--version'))console.log('2.1.261 (Claude Code)');else console.log('private malformed auth');",
    "if(process.argv.includes('--version'))console.log('2.1.261 (Claude Code)');else process.exit(1);"]) {
    f.executable(source);
    await assert.rejects(inspectRuntime(f.options, f.dependencies), error => !error.message.includes('private malformed auth'));
  }
  await assert.rejects(inspectRuntime(f.options, { ...f.dependencies, fingerprintExecutable() { throw new Error('private filesystem path'); } }), /executable/i);
});

test('provider probe bounds output/UTF-8, catches synchronous and evented spawn failures', async t => {
  const f = runtimeFixture(t, 'claude'); const { probe } = require('../../scripts/lib/allocation/runtime-probe');
  const opts = { cwd: f.root, env: f.dependencies.env };
  for (const source of ["process.stdout.write('x'.repeat(70000));setInterval(()=>{},1000);", "process.stdout.write(Buffer.from([0xff]));"]) {
    f.executable(source); await assert.rejects(probe(f.provider.executable, [], opts), /observation/i);
  }
  await assert.rejects(probe(path.join(f.root,'absent'), [], opts), /observation/i);
  await assert.rejects(probe(f.provider.executable, [], { ...opts, spawn() { throw new Error('private error'); } }), /observation/i);
});

test('Claude pinned settings cannot inject API helpers or per-process backend selectors', t => {
  const f = runtimeFixture(t, 'claude');
  for (const doc of [{apiKeyHelper:'private helper'}, {env:{ANTHROPIC_API_KEY:'private value'}}, {modelProvider:'custom'}]) {
    bindConfig(f, 'settings.json', JSON.stringify(doc));
    assert.throws(() => inspectRuntimeMetadata(f.options, f.dependencies), error => !error.message.includes('private'));
  }
});

test('native route configs reject deeply nested or invalid UTF-8 metadata safely', t => {
  const f=runtimeFixture(t,'claude');
  bindConfig(f,'settings.json',`${'{"nested":'.repeat(70)}1${'}'.repeat(70)}`);
  assert.throws(()=>inspectRuntimeMetadata(f.options,f.dependencies),/configuration|bound/i);
  bindConfig(f,'settings.json',Buffer.from([0x7b,0x22,0x78,0x22,0x3a,0x22,0xff,0x22,0x7d]));
  assert.throws(()=>inspectRuntimeMetadata(f.options,f.dependencies),/configuration|bound/i);
});

test('read-only probe bounds inherited stdio even after owned root already exited', async () => {
  const { EventEmitter }=require('node:events'); const { PassThrough }=require('node:stream');
  const { probe }=require('../../scripts/lib/allocation/runtime-probe');
  let alarm;
  const bound=new Promise((_,reject)=>{alarm=setTimeout(()=>reject(new Error('probe failed its bounded-stop contract')),2500);});
  const pending=probe('/fixture/provider',[],{cwd:'/tmp',env:{},spawn(){
    const child=new EventEmitter(); child.stdout=new PassThrough(); child.stderr=new PassThrough(); child.kill=()=>false;
    setImmediate(()=>{child.emit('exit',0,null);child.stdout.write(Buffer.from([0xff]));}); return child;
  }});
  try { await assert.rejects(Promise.race([pending,bound]),/observation/i); } finally { clearTimeout(alarm); }
});

function observation(f) {
  return { target: f.provider.target, transport: f.provider.transport, cliVersion: f.provider.cliVersion,
    executableDigest: f.provider.executableDigest, providerHome: f.home, configDigests: [],
    method: f.provider.authRoute.method, authenticated: true, backendId: 'openai',
    paidExtraUsageDisabled: true, overageObserved: false, observedAt: '2026-10-11T00:00:00.000Z' };
}

test('auth route digest omits observation time and expected digest circularity', t => {
  const f = fixture(t); const o = observation(f);
  const first = computeSubscriptionRouteDigest({ provider: f.provider, observation: o });
  const second = computeSubscriptionRouteDigest({ provider: { ...f.provider,
    authRoute: { ...f.provider.authRoute, expectedRouteDigest: 'e'.repeat(64) } },
    observation: { ...o, observedAt: '2026-10-12T00:00:00.000Z' } });
  assert.equal(first, second);
  f.provider.authRoute.expectedRouteDigest = first;
  assert.doesNotThrow(() => validateSubscriptionBinding({ provider: f.provider, observation: o }));
});

test('canonical runtime digest preserves full pinned provider and ignores object key ordering', t => {
  const f = fixture(t); const reordered = Object.fromEntries(Object.entries(f.provider).reverse());
  assert.equal(computeRuntimeDigest(f.provider), computeRuntimeDigest(reordered));
  assert.notEqual(computeRuntimeDigest(f.provider), computeRuntimeDigest({ ...f.provider, cliVersion: '0.154.0' }));
});

for (const change of [ { authenticated: false }, { method: 'api-key' }, { backendId: 'custom-api' },
  { overageObserved: true }, { paidExtraUsageDisabled: false } ]) {
  test(`reject subscription contradiction ${JSON.stringify(change)}`, t => {
    const f = fixture(t); const o = observation(f);
    f.provider.authRoute.expectedRouteDigest = computeSubscriptionRouteDigest({ provider: f.provider, observation: o });
    assert.throws(() => validateSubscriptionBinding({ provider: f.provider, observation: { ...o, ...change } }), /subscription|route|billing|binding/i);
  });
}

test('route mutation invalidates digest', t => {
  const f = fixture(t); const o = observation(f);
  f.provider.authRoute.expectedRouteDigest = computeSubscriptionRouteDigest({ provider: f.provider, observation: o });
  assert.throws(() => validateSubscriptionBinding({ provider: f.provider, observation: { ...o, providerHome: '/tmp/another-provider-home' } }), /binding|route/i);
});

for (const selector of ['OPENAI_API_KEY','OPENAI_BASE_URL','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','ANTHROPIC_BASE_URL','CODEX_CA_ROOT_CERT']) {
  test(`credential/backend selector ${selector} rejects without revealing its value`, () => {
    assert.throws(() => assertSubscriptionEnvironment({ [selector]: 'private-credential' }), error => !error.message.includes('private-credential'));
  });
}
