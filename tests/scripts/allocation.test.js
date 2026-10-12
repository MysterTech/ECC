'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');
const vm = require('node:vm');
const { canonicalDigest, normalizePolicy } = require('../../scripts/lib/allocation/validation');
const fixture = require('../lib/helpers/allocation-fixture');
const { appServerSource } = require('../lib/helpers/allocation-provider-fixture');

const ROOT = path.resolve(__dirname, '../..');
const CLI = path.join(ROOT, 'scripts/allocation.js');
const ECC = path.join(ROOT, 'scripts/ecc.js');
const commands = () => require('../../scripts/lib/allocation/commands');

function privateFixture(t, { codexQuota = false, codexBackend = 'openai' } = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-allocation-cli-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(home, { mode: 0o700 }); fs.mkdirSync(repo);
  fs.mkdirSync(path.join(home, '.codex')); fs.mkdirSync(path.join(home, '.claude'));
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: directory, TMP: directory, TEMP: directory,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.NODE_V8_COVERAGE ? { NODE_V8_COVERAGE: process.env.NODE_V8_COVERAGE } : {}) };
  spawnSync('git', ['init', '--quiet', repo], { env, timeout: 10000 });
  fs.writeFileSync(path.join(repo, 'existing.txt'), 'Retained work\n');
  const raw = fixture.policy();
  raw.providers = raw.providers.map(provider => {
    const executable = path.join(directory, `fake-${provider.id}`);
    const nativeSource = appServerSource(codexQuota ? { code: 'usageLimitExceeded' } : { success: true })
      .replace("result:{thread:{id:'thread-fixture'}}", `result:{thread:{id:'thread-fixture'},model:m.params.model,modelProvider:${JSON.stringify(codexBackend)}}`)
      .replace("if(m.method==='turn/start') {", `if(m.method==='turn/start') { require('node:fs').appendFileSync(${JSON.stringify(path.join(directory, 'turns.log'))},'turn-start\\n');`);
    const source = provider.target === 'codex'
      ? `if(process.argv.includes('--version')) { console.log('codex-cli 0.155.1'); process.exit(0); }\n${nativeSource}`
      : `if(process.argv.includes('--version')) { console.log('2.1.261 (Claude Code)'); process.exit(0); }
if(process.argv[2]==='auth') { console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'pro'})); process.exit(0); }
process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,num_turns:1,result:'Completed fixture work.',session_id:'fixture-session',usage:{input_tokens:12,output_tokens:3}})));`;
    const script = `${executable}.js`; const cFile = `${executable}.c`;
    fs.writeFileSync(script, `require('node:fs').appendFileSync(${JSON.stringify(path.join(directory, 'calls.log'))},${JSON.stringify(`${provider.id}\n`)});\n${source}`);
    fs.writeFileSync(cFile, `#include <unistd.h>\n#include <stdlib.h>\nint main(int argc,char **argv){char **next=calloc(argc+2,sizeof(char*)); if(!next)return 125; next[0]=${JSON.stringify(process.execPath)}; next[1]=${JSON.stringify(script)}; for(int i=1;i<argc;i++)next[i+1]=argv[i]; execv(next[0],next); return 126;}\n`);
    const compiled = spawnSync('cc', [cFile, '-o', executable], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(compiled.status, 0, `Native CLI fixture compiler is required: ${compiled.stderr || compiled.error || ''}`);
    return { ...provider, executable,
      executableDigest: require('node:crypto').createHash('sha256').update(fs.readFileSync(executable)).digest('hex') };
  });
  const { inspectRuntimeMetadata, computeSubscriptionRouteDigest } = require('../../scripts/lib/allocation/runtime');
  raw.providers = raw.providers.map(provider => {
    const metadata = inspectRuntimeMetadata({ provider, workingRepoRoot: repo }, { env });
    return { ...provider, authRoute: { ...provider.authRoute, expectedRouteDigest: computeSubscriptionRouteDigest({ provider,
      observation: { method: provider.authRoute.method, executableDigest: provider.executableDigest,
        providerHome: metadata.providerHome, configDigests: metadata.configDigests } }) } };
  });
  const policy = normalizePolicy(raw);
  const input = { ...fixture.runInput(), repoRoot: repo, cwd: repo,
    task: { ...fixture.task(), query: 'Private task notes must never appear in CLI status.' },
    runtimeBindings: Object.fromEntries(policy.providers.map(provider => [provider.id, { runtimeDigest: canonicalDigest(provider) }])) };
  const config = path.join(directory, 'policy.json');
  fs.writeFileSync(config, JSON.stringify(policy));
  const dbPath = path.join(directory, 'state', 'allocation.db');
  const run = (operation, envelope, extra = [], outer = false, overrideEnv = {}) => spawnSync(process.execPath,
    [outer ? ECC : CLI, ...(outer ? ['allocation'] : []), operation,
      ...(['run', 'next', 'resume'].includes(operation) ? ['--config', config] : []),
      '--db', dbPath, '--input', '-', '--json', ...extra],
    { cwd: repo, input: JSON.stringify(envelope), encoding: 'utf8', env: { ...env, ...overrideEnv },
      timeout: 45000, maxBuffer: 1024 * 1024 });
  return { directory, home, repo, config, dbPath, policy, input, env, run };
}

test('strict CLI accepts operation flags and rejects duplicate, unknown and conflicting input', () => {
  const { parseArgs } = commands();
  assert.deepEqual(parseArgs(['run', '--config', 'policy.json', '--input', '-', '--dry-run', '--json']),
    { operation: 'run', configPath: 'policy.json', inputPath: '-', dbPath: null, dryRun: true, json: true, help: false });
  for (const args of [[], ['unknown'], ['run'], ['run', '--config', 'x', '--input', '-', '--db', 'relative'],
    ['status', '--input', '-', '--db', '/tmp/state', '--config', 'x'], ['run', '--config', 'x', '--input', '-', '--db', '/tmp/state', '--dry-run', '--dry-run'],
    ['status', '--input', '-', '--db', '/tmp/state', '--dry-run'], ['run', '--config', 'x', '--input', '-', '--db', '/tmp/state', '--extra'],
    ['run', '--config=x', '--input', '-', '--dry-run'], ['run', '--config', '--input', '-', '--dry-run'],
    ['run', '--config', 'x', '--input', '-', '--db', ':memory:'], ['run', '--config', 'x', '--input', '-', '--dry-run', 'extra'],
    ['run', '--config', '-', '--input', '-', '--dry-run'], ['run', '--config', 'x', '--input', '\u001b', '--dry-run'],
    ['run', '--config', '', '--input', '-', '--dry-run'], ['run', '--config', 'x', '--input', 'x'.repeat(4097), '--dry-run']]) {
    assert.throws(() => parseArgs(args), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
  }
  assert.equal(parseArgs(['--help']).help, true);
  assert.equal(parseArgs(['run', '--help']).help, true);
  assert.throws(() => parseArgs(null), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
  assert.throws(() => parseArgs([123]), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
  for (const flag of ['constructor', '__proto__', 'toString']) {
    assert.throws(() => parseArgs(['run', '--config', 'x', '--input', '-', '--dry-run', flag, 'value']),
      { code: 'ECC_ALLOCATION_INVALID_INPUT' });
  }
});

test('bounded JSON readers reject invalid UTF-8, controls, overflow, malformed JSON and linked files', async t => {
  const { readOperationInput } = commands();
  assert.deepEqual(await readOperationInput('-', { stdin: Readable.from(['{\n"value":"prose\\nline"\n}']) }), { value: 'prose\nline' });
  for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from('{"value":"\u001b"}'), Buffer.from('{'), Buffer.alloc(65537, 32)]) {
    await assert.rejects(readOperationInput('-', { stdin: Readable.from([bytes]) }), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
  }
  const f = privateFixture(t);
  const file = path.join(f.directory, 'input.json'); fs.writeFileSync(file, '{"value":1}');
  assert.deepEqual(await readOperationInput(file), { value: 1 });
  fs.writeFileSync(file, Buffer.alloc(65537, 32));
  await assert.rejects(readOperationInput(file), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
  fs.symlinkSync(file, path.join(f.directory, 'linked.json'));
  await assert.rejects(readOperationInput(path.join(f.directory, 'linked.json')), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
  await assert.rejects(readOperationInput(f.directory), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
  await assert.rejects(readOperationInput(path.join(f.directory, 'absent.json')), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
  fs.writeFileSync(file, '{"value":"π"}');
  assert.deepEqual(await readOperationInput(file), { value: 'π' });
  const linkedDir = path.join(f.directory, 'linked-directory'); fs.symlinkSync(f.home, linkedDir);
  fs.writeFileSync(path.join(f.home, 'input.json'), '{}');
  await assert.rejects(readOperationInput(path.join(linkedDir, 'input.json')), { code: 'ECC_ALLOCATION_INVALID_INPUT' });
});

test('module main awaits controller and prints one exact safe JSON result without progress', async () => {
  const { main } = commands(); let stdout = ''; let stderr = ''; let completed = false;
  const result = require('../../scripts/lib/allocation/controller-results').resultFor({ operation: 'status', input: null });
  const code = await main(['status', '--db', '/tmp/fixture-allocation.db', '--input', '-', '--json'], {
    stdin: Readable.from(['{"schemaVersion":"ecc.allocation-status.v2","identity":null,"operationId":"fixture"}']),
    stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } },
    runAllocationOperation: async (_options, dependencies) => {
      dependencies.onProgress({ stage: 'task-starting', providerId: 'fixture', identity: fixture.identity() });
      await new Promise(resolve => setTimeout(resolve, 5)); completed = true; return result;
    } });
  assert.equal(completed, true); assert.equal(code, 0); assert.equal(stderr, '');
  assert.equal(stdout, `${JSON.stringify(result)}\n`);
});

test('packaged entrypoint awaits main and sanitizes an unexpected rejected promise', async () => {
  const script = fs.readFileSync(CLI, 'utf8'); let message = ''; const childProcess = { exitCode: null,
    stderr: { write: value => { message += value; } } };
  const code = new vm.Script(script, { filename: CLI });
  code.runInNewContext({ require: () => ({ main: () => Promise.resolve(3) }), process: childProcess });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(childProcess.exitCode, 3);
  code.runInNewContext({ require: () => ({ main: () => Promise.reject(new Error('private unexpected provider body')) }), process: childProcess });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(childProcess.exitCode, 4);
  assert.match(message, /could not finish recording/); assert.ok(!message.includes('private unexpected'));
});

test('CLI preview and outer explicit dry-run preserve DB absence and do not call native providers', t => {
  const f = privateFixture(t);
  const result = f.run('run', f.input, ['--dry-run'], true);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(JSON.parse(result.stdout).status, 'proposed'); assert.equal(fs.existsSync(f.dbPath), false);
  const outer = spawnSync(process.execPath, [ECC, '--dry-run', 'allocation', 'run', '--config', f.config, '--input', '-', '--json'],
    { cwd: f.repo, input: JSON.stringify(f.input), encoding: 'utf8', env: f.env, timeout: 30000 });
  assert.equal(outer.status, 0, outer.stderr || outer.stdout);
  assert.equal(JSON.parse(outer.stdout).status, 'proposed'); assert.equal(fs.existsSync(f.dbPath), false);
  assert.equal(fs.existsSync(path.join(f.directory, 'calls.log')), false);
});

test('module main sanitizes rejections and formats human progress and terminal next actions', async t => {
  const { main } = commands(); let stdout = ''; let stderr = '';
  const dependencies = { stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } };
  assert.equal(await main(['unknown', '--json'], dependencies), 2);
  assert.equal(JSON.parse(stdout).operation, null); assert.equal(stderr, '');
  stdout = '';
  assert.equal(await main(['--help'], dependencies), 0); assert.match(stdout, /switch/);
  stdout = '';
  const f = privateFixture(t); fs.writeFileSync(f.config, '{bad-private-content');
  assert.equal(await main(['run', '--config', f.config, '--input', '-', '--dry-run', '--json'], {
    ...dependencies, stdin: Readable.from(['{}']) }), 2);
  assert.equal(JSON.parse(stdout).code, 'ECC_ALLOCATION_INVALID_CONFIG'); assert.ok(!stdout.includes('bad-private'));
  stdout = '';
  const payload = require('../../scripts/lib/allocation/controller-results').resultFor({ operation: 'status', input: null,
    revision: { identity: fixture.identity(), operations: [], taskState: 'blocked', route: { tierId: 'routine', allocationId: null } } });
  assert.equal(await main(['status', '--db', '/tmp/fixture-allocation.db', '--input', '-'], {
    ...dependencies, stdin: Readable.from(['{}']), runAllocationOperation: async (_options, injected) => {
      injected.onProgress({ stage: 'task-starting', providerId: 'codex', identity: fixture.identity() });
      injected.onProgress({ stage: 'unknown-private-stage', providerId: '\u001bprivate', identity: fixture.identity() });
      return payload;
    } }), 0);
  assert.match(stderr, /Starting task \(codex\)/); assert.ok(!stderr.includes('private'));
  assert.match(stdout, /Task state: blocked/); assert.match(stdout, /allocation: pending/); assert.match(stdout, /Next actions/);
  stdout = '';
  assert.equal(await main(['status', '--db', '/tmp/fixture-allocation.db', '--input', '-'], {
    ...dependencies, stdin: Readable.from(['{}']), runAllocationOperation: async () => { throw new Error('private-body'); } }), 2);
  assert.ok(!stdout.includes('private-body'));
});

test('typed Codex quota automatically continues once with Claude through the actual outer CLI', t => {
  const f = privateFixture(t, { codexQuota: true });
  const policy = { ...f.policy, continuation: { ...f.policy.continuation, automaticOnUsageLimit: true } };
  fs.writeFileSync(f.config, JSON.stringify(policy));
  const input = { ...f.input, automaticContinuationAcknowledgement: fixture.automaticAcknowledgement() };
  const result = f.run('run', input, [], true);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.taskState, 'awaiting-checkpoint'); assert.equal(payload.route.allocationId, 'routine-claude');
  assert.equal(payload.operations.length, 2); assert.equal(payload.operations[0].result.category, 'usage-limit');
  assert.equal(payload.operations[1].providerId, 'claude'); assert.equal(payload.availability.length, 1);
});

test('effective app-server backend drift stops before a task turn or automatic alternative', t => {
  const f = privateFixture(t, { codexQuota: true, codexBackend: 'custom-provider' });
  const policy = { ...f.policy, continuation: { ...f.policy.continuation, automaticOnUsageLimit: true } };
  fs.writeFileSync(f.config, JSON.stringify(policy));
  const result = f.run('run', { ...f.input, automaticContinuationAcknowledgement: fixture.automaticAcknowledgement() }, [], true);
  assert.notEqual(result.status, 0);
  const payload = JSON.parse(result.stdout); assert.equal(payload.operations.length, 1);
  assert.equal(payload.execution.quotaObservation, null);
  assert.ok(!fs.readFileSync(path.join(f.directory, 'calls.log'), 'utf8').includes('claude'));
  assert.equal(fs.existsSync(path.join(f.directory, 'turns.log')), false);
});

test('outer dispatcher forwards stdin, ignores inherited dry-run, and replay/status preserve private prose', t => {
  const f = privateFixture(t);
  const first = f.run('run', f.input, [], true, { ECC_DRY_RUN: '1' });
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const payload = JSON.parse(first.stdout); assert.equal(payload.taskState, 'awaiting-checkpoint');
  assert.equal(payload.execution.exitStatus, 0); assert.equal(fs.existsSync(f.dbPath), true);
  const replay = JSON.parse(f.run('run', f.input).stdout); assert.equal(replay.replayed, true);
  const before = fs.readFileSync(f.dbPath);
  const status = f.run('status', { schemaVersion: 'ecc.allocation-status.v2', identity: fixture.identity(), operationId: null });
  assert.equal(status.status, 0, status.stderr || status.stdout);
  assert.ok(!status.stdout.includes(f.input.task.query)); assert.deepEqual(fs.readFileSync(f.dbPath), before);
  const missing = f.run('status', { schemaVersion: 'ecc.allocation-status.v2', identity: { ...fixture.identity(), revision: 2 }, operationId: null });
  assert.notEqual(missing.status, 0);
});

test('manual switch reserves a fresh Claude session and resume retains the same tier and workspace', t => {
  const f = privateFixture(t); const firstRun = f.run('run', f.input);
  assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
  const first = JSON.parse(firstRun.stdout);
  const switching = f.run('switch', { schemaVersion: 'ecc.allocation-switch.v2', switchId: 'manual-switch', identity: fixture.identity(),
    attemptId: first.attemptId, sourceOperationId: first.operationId, expectedFrontier: first.frontier,
    expectedJournalVersion: first.journalVersion, destinationAllocationId: null, effectAcknowledgement: fixture.effectAcknowledgement() });
  assert.equal(switching.status, 0, switching.stderr || switching.stdout); const switched = JSON.parse(switching.stdout);
  assert.equal(switched.taskState, 'successor-reserved');
  const resume = f.run('resume', { schemaVersion: 'ecc.allocation-resume.v2', requestId: 'manual-resume', identity: fixture.identity(),
    attemptId: switched.attemptId, parentAttemptId: first.attemptId, transitionId: switched.transitionId,
    expectedFrontier: switched.frontier, expectedJournalVersion: switched.journalVersion,
    policyDigest: canonicalDigest(f.policy), runtimeSetDigest: first.route.runtimeSetDigest });
  assert.equal(resume.status, 0, resume.stderr || resume.stdout);
  const continued = JSON.parse(resume.stdout);
  assert.equal(continued.route.tierId, first.route.tierId); assert.equal(continued.route.allocationId, 'routine-claude');
  assert.equal(continued.taskState, 'awaiting-checkpoint'); assert.equal(continued.operations.length, 2);
  assert.equal(fs.readFileSync(path.join(f.repo, 'existing.txt'), 'utf8'), 'Retained work\n');
});

test('manual Claude to Codex continuation uses the saved successor without a model override', t => {
  const f = privateFixture(t); const input = { ...f.input, requirements: { ...f.input.requirements, explicitAllocation: 'routine-claude' } };
  const starting = f.run('run', input); assert.equal(starting.status, 0, starting.stderr || starting.stdout);
  const first = JSON.parse(starting.stdout); assert.equal(first.operations[0].providerId, 'claude');
  const switching = f.run('switch', { schemaVersion: 'ecc.allocation-switch.v2', switchId: 'reverse-switch', identity: fixture.identity(),
    attemptId: first.attemptId, sourceOperationId: first.operationId, expectedFrontier: first.frontier,
    expectedJournalVersion: first.journalVersion, destinationAllocationId: 'routine-codex', effectAcknowledgement: fixture.effectAcknowledgement() });
  assert.equal(switching.status, 0, switching.stderr || switching.stdout); const switched = JSON.parse(switching.stdout);
  const envelope = { schemaVersion: 'ecc.allocation-resume.v2', requestId: 'reverse-resume', identity: fixture.identity(),
    attemptId: switched.attemptId, parentAttemptId: first.attemptId, transitionId: switched.transitionId,
    expectedFrontier: switched.frontier, expectedJournalVersion: switched.journalVersion,
    policyDigest: canonicalDigest(f.policy), runtimeSetDigest: first.route.runtimeSetDigest };
  const rejected = f.run('resume', { ...envelope, modelId: 'unapproved-model' });
  assert.equal(rejected.status, 2); assert.equal(JSON.parse(rejected.stdout).code, 'ECC_ALLOCATION_INVALID_INPUT');
  const resumed = f.run('resume', envelope); assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
  const result = JSON.parse(resumed.stdout); assert.equal(result.route.allocationId, 'routine-codex');
  assert.equal(result.route.tierId, first.route.tierId); assert.equal(result.operations.length, 2);
});
