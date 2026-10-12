'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture, appServerSource } = require('./helpers/allocation-provider-fixture');
const { buildOperationRequest, executeOperation } = require('../../scripts/lib/allocation/provider-process');

function request(f, phase = 'task') {
  return buildOperationRequest({ phase, ...f, input: { text: 'Continue the test task', timeoutMs: 1500 }, cwd: f.root });
}

test('exact requests preserve model, effort and task native policy', t => {
  for (const [target, transport] of [['codex','codex-exec'], ['codex','codex-app-server'], ['claude','claude-stream-json']]) {
    const f = fixture(t, target, transport);
    const r = request(f);
    assert.equal(r.command, f.provider.executable);
    assert.equal(r.shell, false);
    assert.equal(r.allocation.effort, 'high');
    assert.equal(r.allocation.modelId, f.allocation.modelId);
    assert.equal(r.args.includes('--bare'), false);
    assert.equal(r.args.includes('--dangerously-skip-permissions'), false);
    assert.equal(r.args.includes('--sandbox'), false);
    assert.equal(r.args.includes('--approval-policy'), false);
    if (transport !== 'codex-app-server') assert.ok(r.args.includes(f.allocation.modelId));
    if (target === 'claude') assert.ok(r.args.includes('--verbose'));
  }
});

test('classification/proposal use constrained exact native framing', t => {
  const codex = request(fixture(t, 'codex', 'codex-exec'), 'classifier');
  assert.ok(codex.args.includes('read-only'));
  assert.ok(codex.args.includes('--ephemeral'));
  const claude = request(fixture(t, 'claude', 'claude-stream-json'), 'proposal');
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], '');
  assert.ok(claude.args.includes('--no-session-persistence'));
});

test('beforeSpawn rejection prevents all invocation', async t => {
  const f = fixture(t);
  let called = false;
  await assert.rejects(executeOperation(request(f), { spawn() { called = true; }, beforeSpawn() { throw new Error('changed'); } }), /changed/);
  assert.equal(called, false);
});

test('actual stdio app-server driver confirms only correlated typed quota after normal shutdown', async t => {
  const f = fixture(t); f.executable(appServerSource({ code: 'usageLimitExceeded' }));
  const output = await executeOperation(request(f));
  assert.equal(output.result.category, 'usage-limit');
  assert.equal(output.result.exitStatus, 0);
  assert.equal(output.result.signal, null);
  assert.equal(output.result.toolQuiescence, 'observed-clear');
  assert.equal(output.result.quotaObservation.mappingVersion, 'codex-app-server-0.155.1-usage-limit-v1');
  assert.equal(output.result.quotaObservation.scope, 'subscription');
  assert.equal(JSON.stringify(output).includes('private fixture detail'), false);
});

for (const [label, changes] of [
  ['generic 429/rate limit', { code: 'rateLimitExceeded' }],
  ['unknown code', { code: 'other' }], ['wrong turn', { code: 'usageLimitExceeded', wrongTurn: true }],
  ['pending tool', { code: 'usageLimitExceeded', pending: true }],
  ['retry still active', { code: 'usageLimitExceeded', retry: true }],
  ['unhandled approval', { code: 'usageLimitExceeded', approval: true }],
  ['API authentication', { code: 'usageLimitExceeded', apiAccount: true }],
  ['forced server exit', { code: 'usageLimitExceeded', shutdownSignal: true }]
]) test(`automatic quota not manufactured for ${label}`, async t => {
  const f = fixture(t); f.executable(appServerSource(changes));
  const output = await executeOperation(request(f));
  assert.equal(output.result.quotaObservation, null);
  assert.notEqual(output.result.category, 'usage-limit');
});

test('app-server final text transiently exposes only completed agent message', async t => {
  const f = fixture(t); f.executable(appServerSource({ success: true }));
  const output = await executeOperation(request(f, 'classifier'));
  assert.equal(output.result.category, 'none');
  assert.equal(output.finalText, '{"tierId":"strong","reasonCode":"conservative"}');
});

test('Claude is_error dominates exit zero and success subtype; rate limit telemetry is manual-only', async t => {
  const f = fixture(t, 'claude', 'claude-stream-json');
  f.executable(`process.stdin.resume();process.stdin.on('end',()=>{
    console.log(JSON.stringify({type:'rate_limit_event',rate_limit_info:{status:'rejected',rateLimitType:'five_hour',isUsingOverage:false}}));
    console.log(JSON.stringify({type:'result',subtype:'success',is_error:true,result:'private quota-like prose'}));
  });`);
  const output = await executeOperation(request(f));
  assert.equal(output.result.category, 'provider-error');
  assert.equal(output.result.exitStatus, 0);
  assert.equal(output.result.quotaObservation, null);
  assert.equal(output.finalText, '');
});

test('Codex exec prose never certifies quota', async t => {
  const f = fixture(t, 'codex', 'codex-exec');
  f.executable(`process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({type:'error',message:'usageLimitExceeded'})));`);
  const output = await executeOperation(request(f));
  assert.equal(output.result.category, 'provider-error');
  assert.equal(output.result.quotaObservation, null);
});

test('bounded malformed framing retains protocol failure without leaked raw output', async t => {
  const f = fixture(t, 'claude', 'claude-stream-json');
  f.executable(`process.stdin.resume();process.stdin.on('end',()=>console.log('private malformed frame'));`);
  const output = await executeOperation(request(f));
  assert.equal(output.result.category, 'protocol-error');
  assert.equal(JSON.stringify(output).includes('private malformed'), false);
});

test('timeout and cancellation preserve actual signal and unknown execution', async t => {
  const f = fixture(t, 'claude', 'claude-stream-json'); f.executable('process.stdin.resume();setInterval(()=>{},1000);');
  const r = { ...request(f), timeoutMs: 80 };
  const output = await executeOperation(r);
  assert.equal(output.result.category, 'timeout');
  assert.equal(output.result.exitStatus, null);
  assert.ok(output.result.signal);
  assert.equal(output.result.rootCompletion, 'unknown');
});

test('request byte reservation rejects overflow rather than truncating', t => {
  const f = fixture(t);
  assert.throws(() => buildOperationRequest({ ...f, phase: 'classifier', cwd: f.root, input: 'x'.repeat(32769) }), /input|bound|capacity/i);
});

test('request rejects lone surrogates and terminal controls', t => {
  const f = fixture(t);
  for (const text of ['task\ud800', 'task\u001b[0m']) {
    assert.throws(() => buildOperationRequest({ ...f, phase: 'task', cwd: f.root, input: text }), /input|bound|allocation/i);
  }
});

test('output overflow and invalid UTF-8 stop bounded owned process', async t => {
  const f = fixture(t, 'claude', 'claude-stream-json');
  f.executable("process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('x'.repeat(70000))); ");
  const output = await executeOperation(request(f, 'classifier'));
  assert.equal(output.result.category, 'output-limit');
  f.executable("process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(Buffer.from([0xff,10])));");
  assert.equal((await executeOperation(request(f))).result.category, 'protocol-error');
});

test('spawn error remains proven not-started; aborted-before-launch has zero calls', async t => {
  const f = fixture(t, 'claude', 'claude-stream-json');
  const output = await executeOperation(request(f));
  assert.equal(output.result.spawnState, 'not-started');
  assert.equal(output.result.category, 'spawn-error');
  const abort = new AbortController(); abort.abort();
  let calls = 0;
  const cancelled = await executeOperation(request(f), { signal: abort.signal, spawn() { calls++; } });
  assert.equal(cancelled.result.category, 'cancelled');
  assert.equal(calls, 0);
});

test('unknown app-server notifications and failed-model fallback cannot manufacture tool-clear quota', async t => {
  const f = fixture(t);
  const source = appServerSource({ code: 'usageLimitExceeded' }).replace("emit({method:'turn/completed'", "emit({method:'item/customTool/started',params:{threadId:'thread-fixture',turnId:'turn-fixture'}});emit({method:'turn/completed'");
  f.executable(source);
  const result = await executeOperation(request(f));
  assert.equal(result.result.quotaObservation, null);
  assert.equal(result.result.toolQuiescence, 'unknown');
});

function ndjsonExecutable(f, messages) {
  f.executable(`process.stdin.resume();process.stdin.on('end',()=>${JSON.stringify(messages)}.forEach(m=>console.log(JSON.stringify(m))));`);
}

test('Claude complete attributed tool lifecycle yields clear observation and attributable root usage', async t => {
  const f = fixture(t, 'claude', 'claude-stream-json'); const events = [];
  ndjsonExecutable(f, [
    { type:'assistant', session_id:'session-fixture', message:{model:'claude-sonnet-4-6', content:[{type:'tool_use',id:'call-1',name:'Read'}]} },
    { type:'user', session_id:'session-fixture', message:{content:[{type:'tool_result',tool_use_id:'call-1',content:'private tool body'}]} },
    { type:'result', session_id:'session-fixture', subtype:'success', is_error:false, result:'done',
      usage:{input_tokens:10,cache_read_input_tokens:3,cache_creation_input_tokens:2,output_tokens:4} }
  ]);
  const output = await executeOperation(request(f), { onEvent:event=>events.push(event) });
  assert.equal(output.result.category, 'none'); assert.equal(output.result.toolQuiescence,'observed-clear');
  assert.equal(output.observed.modelId,'claude-sonnet-4-6');
  assert.equal(output.metrics.find(m=>m.name==='inputTokens').value,15);
  assert.equal(output.metrics.find(m=>m.name==='cachedInputTokens').value,3);
  assert.equal(output.metrics.find(m=>m.name==='costMicros').value,null);
  assert.equal(JSON.stringify(output).includes('private tool body'),false);
  assert.deepEqual(events.map(e=>e.type),['tool-started','tool-completed']);
});

for (const [label, messages, category, quiescence] of [
  ['pending tool',[{type:'assistant',message:{content:[{type:'tool_use',id:'call-1',name:'Read'}]}}],'none','pending'],
  ['unknown completion',[{type:'user',message:{content:[{type:'tool_result',tool_use_id:'unknown'}]}}],'none','unknown'],
  ['duplicate start',[{type:'assistant',message:{content:[{type:'tool_use',id:'call-1'},{type:'tool_use',id:'call-1'}]}}],'protocol-error','pending'],
  ['nested task',[{type:'system',subtype:'task_started'}],'none','unknown'],
  ['unknown event',[{type:'unrecognized-effect'}],'none','unknown'],
  ['observed overage',[{type:'rate_limit_event',rate_limit_info:{isUsingOverage:true}}],'auth-error','observed-clear'],
  ['conflicting session',[{type:'system',session_id:'first'},{type:'assistant',session_id:'second'}],'protocol-error','observed-clear'],
  ['malformed result',[{type:'result',subtype:'success'}],'protocol-error','observed-clear']
]) test(`Claude observation preserves ${label}`, async t => {
  const f = fixture(t,'claude','claude-stream-json');
  ndjsonExecutable(f,[...messages,{type:'result',subtype:'success',is_error:false,result:'done'}]);
  const output = await executeOperation(request(f));
  assert.equal(output.result.category,category); assert.equal(output.result.toolQuiescence,quiescence);
  assert.equal(output.result.quotaObservation,null);
});

test('Codex exec completed ordinary root preserves nullable usage without child/cash inventions', async t => {
  const f = fixture(t,'codex','codex-exec');
  ndjsonExecutable(f,[{type:'thread.started',thread_id:'private-session'},{type:'turn.started'},
    {type:'item.completed',item:{id:'msg-1',type:'agent_message',text:'done'}},
    {type:'turn.completed',usage:{input_tokens:6,cached_input_tokens:7,output_tokens:2}}]);
  const output=await executeOperation(request(f),{clock:{now:()=>new Date('2026-10-11T01:00:00.000Z'),monotonic:()=>20}});
  assert.equal(output.result.category,'none'); assert.equal(output.finalText,'done');
  assert.equal(output.metrics.find(m=>m.name==='cachedInputTokens').value,null);
  assert.equal(output.metrics.find(m=>m.name==='durationMs').value,0);
});

test('app-server completed paired tools permit quota while unknown item/status projection blocks it', async t => {
  const f=fixture(t); const base=appServerSource({code:'usageLimitExceeded',pending:true});
  const completed="emit({method:'item/completed',params:{threadId:'thread-fixture',turnId:'turn-fixture',completedAtMs:2,item:{id:'tool-fixture',type:'commandExecution',status:'completed'}}});";
  f.executable(base.replace("emit({method:'turn/completed'",completed+"emit({method:'turn/completed'"));
  assert.equal((await executeOperation(request(f))).result.category,'usage-limit');
  f.executable(base.replace("type:'commandExecution'","type:'collabAgentToolCall'"));
  assert.equal((await executeOperation(request(f))).result.toolQuiescence,'unknown');
});

test('app-server final response correlates errors, preserves effective model and root usage', async t => {
  const f=fixture(t); let source=appServerSource({success:true});
  source=source.replace("result:{thread:{id:'thread-fixture'}}","result:{thread:{id:'thread-fixture'},model:'gpt-5.4',modelProvider:'openai'}")
    .replace("emit({method:'turn/completed'","emit({method:'thread/tokenUsage/updated',params:{threadId:'thread-fixture',turnId:'turn-fixture',tokenUsage:{total:{inputTokens:4,cachedInputTokens:2,outputTokens:3,reasoningOutputTokens:1}}}});emit({method:'turn/completed'");
  f.executable(source); const output=await executeOperation(request(f));
  assert.equal(output.observed.modelId,'gpt-5.4'); assert.equal(output.observed.effort,null);
  assert.equal(output.metrics.find(m=>m.name==='reasoningTokens').value,1);
  assert.equal(output.metrics.find(m=>m.name==='inputTokens').value,4);
});

test('aborted after preflight prevents invocation and callback failure preserves controller-lost', async t => {
  const f=fixture(t); const abort=new AbortController(); let calls=0;
  const output=await executeOperation(request(f),{signal:abort.signal,beforeSpawn:()=>abort.abort(),spawn:()=>{calls++;}});
  assert.equal(output.result.category,'cancelled'); assert.equal(calls,0);
  f.executable(appServerSource({code:'usageLimitExceeded',pending:true}));
  const lost=await executeOperation(request(f),{onEvent(){throw new Error('private callback body');}});
  assert.equal(lost.result.category,'controller-lost'); assert.equal(lost.result.rootCompletion,'unknown');
  assert.equal(JSON.stringify(lost).includes('private callback body'),false);
});

test('request refuses unsupported target/version/effort/capacity and exact timeout boundaries', t => {
  const f=fixture(t);
  for(const change of [{provider:{...f.provider,cliVersion:'0.999.0'}},{provider:{...f.provider,adapterVersion:'custom'}},
    {allocation:{...f.allocation,effort:'unsupported'}},{input:{text:'task',timeoutMs:-1}}]) {
    assert.throws(()=>buildOperationRequest({...f,phase:'task',cwd:f.root,input:'task',...change}),/runtime|input|allocation|timeout/i);
  }
  assert.equal(buildOperationRequest({...f,phase:'task',cwd:f.root,input:'task'}).timeoutMs,300000);
  assert.equal(buildOperationRequest({...f,phase:'proposal',cwd:f.root,input:'task'}).timeoutMs,30000);
});

test('bounded cleanup preserves observed exit when owned root exits but inherited stdio never closes', async t => {
  const { EventEmitter }=require('node:events'); const { PassThrough }=require('node:stream');
  const f=fixture(t,'claude','claude-stream-json'); let child;
  const output=await executeOperation({...request(f),timeoutMs:20},{spawn(){
    child=new EventEmitter(); child.stdin=new PassThrough(); child.stdout=new PassThrough(); child.stderr=new PassThrough();
    child.kill=()=>false; setImmediate(()=>child.emit('exit',0,null)); return child;
  }});
  assert.equal(output.result.category,'timeout'); assert.equal(output.result.exitStatus,0);
  assert.equal(output.result.signal,null); assert.equal(output.result.rootCompletion,'unknown');
  assert.equal(child.stdout.destroyed,true);
});

test('ordinary Codex advisory multiple turns permits invalid-response fallback while task remains ordinary', async t => {
  const f=fixture(t,'codex','codex-exec');
  ndjsonExecutable(f,[{type:'turn.started'},{type:'item.completed',item:{id:'msg-1',type:'agent_message',text:'one'}},{type:'turn.completed'},
    {type:'turn.started'},{type:'item.completed',item:{id:'msg-2',type:'agent_message',text:'two'}},{type:'turn.completed'}]);
  const classifier=await executeOperation(request(f,'classifier'));
  assert.equal(classifier.result.category,'none'); assert.equal(classifier.responseFraming,'invalid-multiple-turns');
  assert.equal(classifier.finalText,'');
  const task=await executeOperation(request(f));
  assert.equal(task.result.category,'none'); assert.equal(task.finalText,'two');
});

test('Claude advisory must observe exactly one native turn and never guesses missing num_turns', async t => {
  const f=fixture(t,'claude','claude-stream-json');
  for(const [numTurns,framing,text] of [[1,'single-turn','choice'],[2,'invalid-multiple-turns',''],[undefined,'unobserved','']]) {
    ndjsonExecutable(f,[{type:'result',subtype:'success',is_error:false,result:'choice',num_turns:numTurns}]);
    const output=await executeOperation(request(f,'classifier'));
    assert.equal(output.result.category,'none'); assert.equal(output.responseFraming,framing); assert.equal(output.finalText,text);
  }
});

test('app-server normal started notification and matching nonretry quota notification remain attributable', async t => {
  const f=fixture(t);
  const notify="emit({method:'turn/started',params:{threadId:'thread-fixture',turn:{id:'turn-fixture',items:[],status:'inProgress'}}});emit({method:'error',params:{threadId:'thread-fixture',turnId:'turn-fixture',willRetry:false,error:{codexErrorInfo:'usageLimitExceeded',message:'fixture'}}});";
  f.executable(appServerSource({code:'usageLimitExceeded'}).replace("emit({method:'turn/completed'",notify+"emit({method:'turn/completed'"));
  const output=await executeOperation(request(f),{clock:()=>new Date('2026-10-11T00:00:00.000Z')});
  assert.equal(output.result.category,'usage-limit'); assert.equal(output.result.quotaObservation.observedAt,'2026-10-11T00:00:00.000Z');
});

for(const [name,transform] of [
  ['wrong initialize ID',s=>s.replace("id:m.id,result:{userAgent","id:99,result:{userAgent")],
  ['RPC error',s=>s.replace("result:{userAgent:'fixture'}","error:{message:'private rpc failure'}")],
  ['missing thread ID',s=>s.replace("id:'thread-fixture'}}","id:null}}")],
  ['missing turn ID',s=>s.replace("id:'turn-fixture',items:[],status:'inProgress'","id:null,items:[],status:'inProgress'")],
  ['conflicting quota error',s=>s.replace("emit({method:'turn/completed'","emit({method:'error',params:{threadId:'thread-fixture',turnId:'turn-fixture',willRetry:false,error:{codexErrorInfo:'unauthorized',message:'fixture'}}});emit({method:'turn/completed'")],
  ['wrong item completion',s=>s.replace("emit({method:'turn/completed'","emit({method:'item/completed',params:{threadId:'thread-fixture',turnId:'turn-fixture',item:{id:'unknown',type:'commandExecution',status:'completed'}}});emit({method:'turn/completed'")]
]) test(`app-server strict negative ${name}`,async t=>{
  const f=fixture(t); f.executable(transform(appServerSource({code:'usageLimitExceeded'})));
  const output=await executeOperation(request(f)); assert.equal(output.result.quotaObservation,null);
});

test('Codex exec tool lifecycle includes unknown, pending, completed and failed root states',async t=>{
  const f=fixture(t,'codex','codex-exec');
  for(const [items,quiescence] of [
    [[{type:'item.started',item:{id:'cmd',type:'command_execution'}}],'pending'],
    [[{type:'item.started',item:{id:'cmd',type:'command_execution'}},{type:'item.completed',item:{id:'cmd',type:'command_execution'}}],'observed-clear'],
    [[{type:'item.completed',item:{id:'cmd',type:'command_execution'}}],'unknown'],
    [[{type:'item.started',item:{id:'cmd',type:'delegated_unknown'}}],'unknown']
  ]) {
    ndjsonExecutable(f,[{type:'turn.started'},...items,{type:'turn.completed'}]);
    assert.equal((await executeOperation(request(f))).result.toolQuiescence,quiescence);
  }
  ndjsonExecutable(f,[{type:'turn.started'},{type:'turn.failed',error:{message:'private failure'}}]);
  assert.equal((await executeOperation(request(f))).result.category,'provider-error');
});
