'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fixture(t, target = 'codex', transport = 'codex-app-server') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-allocation-provider-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const provider = { id: target, target, transport,
    adapterVersion: target === 'claude' ? 'ecc.claude-allocation.v1' : transport === 'codex-exec'
      ? 'ecc.codex-allocation.v1' : 'ecc.codex-app-server-allocation.v1',
    cliVersion: target === 'claude' ? '2.1.261' : '0.155.1', executable: path.join(root, 'provider'),
    executableDigest: 'a'.repeat(64), environmentMode: 'current-provider', declaredBackendId: null,
    knownConfigBindings: [], nativeBinding: null,
    authRoute: { mode: 'subscription-only', method: target === 'claude' ? 'claude-oauth' : 'codex-chatgpt',
      expectedRouteDigest: 'b'.repeat(64), observedAt: '2026-10-11T00:00:00.000Z', paidExtraUsageDisabled: true } };
  const allocation = { id: `${target}-high`, providerId: target, modelId: target === 'claude' ? 'sonnet' : 'gpt-5.4',
    effort: 'high', descriptor: 'fixture', capabilities: [], maxSubmittedBytes: 65536 };
  const contextBinding = { environment: { PATH: process.env.PATH, HOME: home },
    runtimeDigest: 'c'.repeat(64), subscription: { method: provider.authRoute.method, authenticated: true } };
  function executable(source) {
    fs.writeFileSync(provider.executable, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  }
  return { root, home, provider, allocation, contextBinding, executable };
}

function appServerSource({ code = null, pending = false, wrongTurn = false, retry = false,
  approval = false, apiAccount = false, success = false, shutdownSignal = false } = {}) {
  return `
const rl = require('node:readline').createInterface({input:process.stdin});
const emit = value => process.stdout.write(JSON.stringify(value)+'\\n');
rl.on('line', line => {
 const m=JSON.parse(line);
 if(m.method==='initialize') emit({id:m.id,result:{userAgent:'fixture'}});
 if(m.method==='account/read') emit({id:m.id,result:{requiresOpenaiAuth:true,account:${JSON.stringify(apiAccount ? {type:'apiKey'} : {type:'chatgpt',email:null,planType:'plus'})}}});
 if(m.method==='thread/start') emit({id:m.id,result:{thread:{id:'thread-fixture'},model:m.params.model,modelProvider:'openai'}});
 if(m.method==='turn/start') {
  emit({id:m.id,result:{turn:{id:'turn-fixture',items:[],status:'inProgress'}}});
  ${pending ? "emit({method:'item/started',params:{threadId:'thread-fixture',turnId:'turn-fixture',startedAtMs:1,item:{id:'tool-fixture',type:'commandExecution',status:'inProgress'}}});" : ''}
  ${approval ? "emit({id:99,method:'item/commandExecution/requestApproval',params:{threadId:'thread-fixture',turnId:'turn-fixture'}});" : ''}
  ${retry ? "emit({method:'error',params:{threadId:'thread-fixture',turnId:'turn-fixture',willRetry:true,error:{codexErrorInfo:'usageLimitExceeded',message:'fixture'}}});" : ''}
  emit({method:'turn/completed',params:{threadId:'thread-fixture',turn:{id:${JSON.stringify(wrongTurn ? 'other-turn' : 'turn-fixture')},items:${JSON.stringify(success ? [{type:'agentMessage',id:'message',text:'{"tierId":"strong","reasonCode":"conservative"}'}] : [])},status:${JSON.stringify(success ? 'completed' : 'failed')},error:${JSON.stringify(success ? null : {codexErrorInfo:code,message:'private fixture detail'})}}}});
 }
});
rl.on('close',()=>${shutdownSignal ? "process.kill(process.pid,'SIGTERM')" : 'process.exit(0)'});
`;
}

module.exports = { fixture, appServerSource };
