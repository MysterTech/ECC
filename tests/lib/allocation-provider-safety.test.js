'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { fixture, appServerSource } = require('./helpers/allocation-provider-fixture');
const { buildOperationRequest, executeOperation } = require('../../scripts/lib/allocation/provider-process');

for (const [label, transform] of [
  ['different backend', source => source.replace("modelProvider:'openai'", "modelProvider:'custom-provider'")],
  ['missing backend', source => source.replace(",modelProvider:'openai'", '')],
  ['different model', source => source.replace('model:m.params.model', "model:'different-model'")],
  ['missing model', source => source.replace('model:m.params.model,', '')],
]) {
  test(`app-server rejects ${label} before starting a native task turn`, async t => {
    const f = fixture(t); const turnLog = path.join(f.root, 'turn-started');
    const baseline = appServerSource({ code: 'usageLimitExceeded' }).replace("{thread:{id:'thread-fixture'}}",
      "{thread:{id:'thread-fixture'},model:m.params.model,modelProvider:'openai'}");
    f.executable(transform(baseline).replace("if(m.method==='turn/start') {",
      `if(m.method==='turn/start') { require('node:fs').writeFileSync(${JSON.stringify(turnLog)},'started');`));
    const request = buildOperationRequest({ phase: 'task', ...f, cwd: f.root, input: { text: 'Task', timeoutMs: 2000 } });
    const output = await executeOperation(request);
    assert.equal(fs.existsSync(turnLog), false);
    assert.equal(output.result.quotaObservation, null);
    assert.notEqual(output.result.category, 'none');
  });
}

test('a process error after successful spawn cannot become a no-spawn fallback', async t => {
  const f = fixture(t, 'codex', 'codex-exec');
  const request = buildOperationRequest({ phase: 'classifier', ...f, cwd: f.root, input: { text: 'Classify', timeoutMs: 100 } });
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => false;
  const started = Date.now();
  const output = await executeOperation(request, { spawn() {
    setImmediate(() => { child.emit('spawn'); child.emit('error', new Error('private post-launch error')); });
    return child;
  } });
  assert.ok(Date.now() - started < 2500);
  assert.notEqual(output.result.spawnState, 'not-started');
  assert.equal(output.result.rootCompletion, 'unknown');
  assert.equal(output.result.cessation, 'unknown');
  assert.equal(output.result.exitStatus, null);
  assert.equal(output.result.quotaObservation, null);
});
