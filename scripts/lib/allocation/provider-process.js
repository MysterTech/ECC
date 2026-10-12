'use strict';

const path = require('node:path');
const { spawn: nativeSpawn } = require('node:child_process');
const { TextDecoder } = require('node:util');
const { codexArgs, appServerAdapter, execAdapter, QUOTA_MAPPING } = require('./providers/codex');
const { claudeArgs, claudeAdapter } = require('./providers/claude');
const { assertSubscriptionEnvironment } = require('./subscription-guard');
const { failure, baseResult, baseObserved, usageMetrics, monotonic, timestamp, safeId } = require('./provider-common');

function admittedProvider(provider) {
  const transports = {
    'codex-exec': { target: 'codex', adapter: 'ecc.codex-allocation.v1', versions: ['0.154.0', '0.155.1'] },
    'codex-app-server': { target: 'codex', adapter: 'ecc.codex-app-server-allocation.v1', versions: ['0.155.1'] },
    'claude-stream-json': { target: 'claude', adapter: 'ecc.claude-allocation.v1', versions: ['2.1.261'] }
  };
  const rule = transports[provider?.transport];
  const laterClaude = provider?.target === 'claude' && provider.environmentMode === 'isolated-native'
    && /^2\.1\.(\d+)$/.test(provider.cliVersion) && Number(provider.cliVersion.split('.')[2]) >= 292;
  if (!rule || rule.target !== provider.target || rule.adapter !== provider.adapterVersion
    || (!laterClaude && !rule.versions.includes(provider.cliVersion))
    || (provider.target === 'claude' && provider.environmentMode === 'isolated-native' && !laterClaude)) {
    throw failure('ECC_ALLOCATION_INCOMPATIBLE', 'Unsupported native runtime transport');
  }
}

function buildOperationRequest({ phase, provider, allocation, input, cwd, contextBinding }) {
  admittedProvider(provider);
  const text = typeof input === 'string' ? input : input?.text;
  const maxInputBytes = Math.min(allocation?.maxSubmittedBytes || 0, phase === 'task' ? 65536 : 32768);
  validateRequestInput({ phase, provider, allocation, text, maxInputBytes, cwd });
  const env = { ...(contextBinding?.environment || process.env) };
  assertSubscriptionEnvironment(env);
  const timeoutMs = typeof input === 'object' ? input.timeoutMs ?? (phase === 'task' ? 300000 : 30000)
    : phase === 'task' ? 300000 : 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1800000) {
    throw failure('ECC_ALLOCATION_INVALID_INPUT', 'Invalid provider timeout');
  }
  return { command: provider.executable, args: provider.target === 'codex' ? codexArgs(provider, allocation, phase)
    : claudeArgs(provider, allocation, phase, contextBinding), cwd, env, shell: false,
  input: text, phase, provider: structuredClone(provider), allocation: structuredClone(allocation),
  contextBinding: structuredClone(contextBinding || {}), timeoutMs, maxOutputBytes: phase === 'task' ? 1048576 : 65536,
  maxLineBytes: 65536, maxEvents: 4096, shutdownTimeoutMs: 1000 };
}

function validateRequestInput({ phase, provider, allocation, text, maxInputBytes, cwd }) {
  const effort = provider.target === 'codex' ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : ['low', 'medium', 'high', 'max'];
  if (!['classifier', 'proposal', 'task'].includes(phase) || typeof text !== 'string' || !text.trim()
    || hasControls(text)
    || Buffer.from(text).toString('utf8') !== text || Buffer.byteLength(text) > maxInputBytes || !path.isAbsolute(cwd || '')
    || !path.isAbsolute(provider.executable || '') || allocation?.providerId !== provider.id
    || !safeId(allocation.modelId) || !effort.includes(allocation.effort)) {
    throw failure('ECC_ALLOCATION_INVALID_INPUT', 'Provider input exceeds its bound or supported allocation');
  }
}

function hasControls(text) {
  return [...text].some(char => {
    const code = char.codePointAt(0);
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || (code >= 127 && code <= 159);
  });
}

function adapterFor(request) {
  return request.provider.transport === 'codex-app-server' ? appServerAdapter(request)
    : request.provider.target === 'codex' ? execAdapter(request) : claudeAdapter(request);
}

function completedObservation(request, transport, processObservation, durationMs, clock) {
  const ordinary = processObservation.exitStatus === 0 && processObservation.signal === null && !processObservation.failure;
  const category = processObservation.failure || (processObservation.exitStatus !== 0 || processObservation.signal
    ? 'provider-error' : transport.category);
  const rootObserved = processObservation.spawnState === 'started' && processObservation.signal === null && !processObservation.failure;
  const result = { ...baseResult(), spawnState: processObservation.spawnState,
    exitStatus: processObservation.exitStatus, signal: processObservation.signal, category,
    rootCompletion: rootObserved ? 'observed' : 'unknown', cessation: rootObserved ? 'root-only' : 'unknown',
    nativeErrorCode: safeId(transport.nativeErrorCode), toolQuiescence: transport.toolQuiescence };
  if (ordinary && transport.quotaCandidate && result.toolQuiescence === 'observed-clear') {
    result.quotaObservation = { source: 'typed-native', providerId: request.provider.id, signalId: 'usageLimitExceeded',
      scope: 'subscription', observedAt: timestamp(clock), resetAt: null, mappingVersion: QUOTA_MAPPING };
  } else if (category === 'usage-limit') result.category = 'provider-error';
  return { result, observed: transport.observed || baseObserved(),
    metrics: usageMetrics(transport.usage, durationMs), finalText: ordinary && transport.category === 'none' ? transport.finalText : '',
    eventCount: processObservation.eventCount, responseFraming: transport.responseFraming || 'unobserved',
    ...(request.purpose === 'auth' ? { accountClass: ordinary ? transport.accountClass : null } : {}) };
}

async function executeOperation(request, { spawn = nativeSpawn, clock, signal, onEvent, beforeSpawn } = {}) {
  if (signal?.aborted) return { result: { ...baseResult(), category: 'cancelled' }, observed: baseObserved(),
    metrics: usageMetrics(null, null), finalText: '', eventCount: 0, responseFraming: 'unobserved' };
  if (beforeSpawn) await beforeSpawn();
  if (signal?.aborted) return { result: { ...baseResult(), category: 'cancelled' }, observed: baseObserved(),
    metrics: usageMetrics(null, null), finalText: '', eventCount: 0, responseFraming: 'unobserved' };
  return new Promise(resolve => {
    const startedAt = monotonic(clock); const adapter = adapterFor(request);
    let child; let failureCategory = null; let closed = false; let normalShutdown = false;
    let bytes = 0; let eventCount = 0; let buffer = ''; let killTimer; let shutdownTimer; let reapTimer;
    let observedExit = null; let observedSignal = null; let spawned = false;
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const stop = category => {
      if (closed || failureCategory) return;
      failureCategory = category;
      try { child?.kill('SIGTERM'); } catch { /* Reaping remains bounded and execution uncertain. */ }
      killTimer = setTimeout(() => { if (!closed) { try { child?.kill('SIGKILL'); } catch { /* No cessation proof. */ } } }, 500);
      reapTimer = setTimeout(() => {
        if (closed) return;
        child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
        finish(observedExit, observedSignal);
      }, 1500);
    };
    const timeout = setTimeout(() => stop('timeout'), request.timeoutMs);
    const onAbort = () => stop('cancelled');
    signal?.addEventListener('abort', onAbort, { once: true });

    function finish(exitStatus, exitSignal, spawnState = 'started') {
      if (closed) return;
      closed = true; clearTimeout(timeout); clearTimeout(killTimer); clearTimeout(shutdownTimer); clearTimeout(reapTimer);
      signal?.removeEventListener('abort', onAbort);
      if (buffer.trim() && !failureCategory) failureCategory = 'protocol-error';
      const transport = adapter.finish();
      const durationMs = Math.max(0, Math.round(monotonic(clock) - startedAt));
      resolve(completedObservation(request, transport, { exitStatus, signal: exitSignal,
        spawnState, failure: failureCategory, eventCount }, durationMs, clock));
    }

    function send(value) {
      if (closed || normalShutdown || failureCategory) return;
      try { child.stdin.write(`${JSON.stringify(value)}\n`); } catch { stop('protocol-error'); }
    }
    const channel = { send, fail: stop, event(value) {
      if (!onEvent) return;
      try { onEvent(value); } catch { stop('controller-lost'); }
    }, finish() {
      if (normalShutdown) return stop('protocol-error');
      normalShutdown = true; child.stdin.end();
      shutdownTimer = setTimeout(() => stop('timeout'), request.shutdownTimeoutMs);
    } };

    function frame(line) {
      if (failureCategory) return;
      if (Buffer.byteLength(line) > request.maxLineBytes || ++eventCount > request.maxEvents) return stop('output-limit');
      let message;
      try { message = JSON.parse(line); } catch { return stop('protocol-error'); }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return stop('protocol-error');
      try { adapter.event(message, channel); } catch { stop('protocol-error'); }
    }

    function data(chunk, stdout) {
      bytes += chunk.length;
      if (bytes > request.maxOutputBytes) return stop('output-limit');
      if (!stdout || failureCategory) return;
      try { buffer += decoder.decode(chunk, { stream: true }); } catch { return stop('protocol-error'); }
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line.trim()) frame(line);
      }
      if (Buffer.byteLength(buffer) > request.maxLineBytes) stop('output-limit');
    }

    try {
      child = spawn(request.command, request.args, { cwd: request.cwd, env: request.env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      failureCategory = 'spawn-error'; finish(null, null, 'not-started'); return;
    }
    child.once('spawn', () => { spawned = true; });
    child.on('error', () => {
      if (!spawned && !Number.isSafeInteger(child.pid)) {
        failureCategory = 'spawn-error'; finish(null, null, 'not-started');
      } else stop('controller-lost');
    });
    child.on('exit', (code, nativeSignal) => {
      observedExit = Number.isSafeInteger(code) && code >= 0 ? code : null; observedSignal = safeId(nativeSignal);
    });
    child.on('close', (code, nativeSignal) => finish(Number.isSafeInteger(code) && code >= 0 ? code : null, safeId(nativeSignal)));
    child.stdout.on('data', chunk => data(chunk, true));
    child.stderr.on('data', chunk => data(chunk, false));
    child.stdout.on('end', () => { try { decoder.decode(); } catch { stop('protocol-error'); } });
    child.stdin.on('error', () => { if (!normalShutdown && !failureCategory) stop('protocol-error'); });
    if (adapter.initial) send(adapter.initial);
    else { normalShutdown = true; child.stdin.end(request.input); }
  });
}

module.exports = { buildOperationRequest, executeOperation, admittedProvider };
