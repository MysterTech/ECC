'use strict';

const { safeId, baseObserved } = require('../provider-common');

const PASSIVE = new Set(['userMessage', 'agentMessage', 'reasoning', 'plan', 'hookPrompt',
  'contextCompaction', 'enteredReviewMode', 'exitedReviewMode']);
const EFFECT = new Set(['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall',
  'webSearch', 'imageView', 'sleep', 'imageGeneration']);
const COMPLETED = new Set(['completed', 'failed', 'declined']);
const QUOTA_MAPPING = 'codex-app-server-0.155.1-usage-limit-v1';

function codexArgs(provider, allocation, phase) {
  if (provider.transport === 'codex-app-server') return ['app-server', '--listen', 'stdio://'];
  return ['exec', '--json', '--model', allocation.modelId, '-c', `model_reasoning_effort=${JSON.stringify(allocation.effort)}`,
    ...(phase === 'task' ? [] : ['--sandbox', 'read-only', '--ephemeral']), '-'];
}

function appServerAdapter(request) {
  let stage = 'initialize'; let threadId = null; let turnId = null; let terminal = null;
  let errorCode = null; let retry = false; let unknown = false; let accountClass = null;
  let finalText = ''; let usage = null; let observed = baseObserved();
  const pending = new Map(); const completed = new Map();
  const rpc = (id, method, params) => ({ id, method, params });
  const initial = rpc(1, 'initialize', { clientInfo: { name: 'ecc-allocation', version: '1.0.0' }, capabilities: { experimentalApi: true } });

  function accountResponse(result, channel) {
    const account = result.account;
    // Usage-based enterprise plans are not subscription-only admission.
    if (result.requiresOpenaiAuth !== true || account?.type !== 'chatgpt'
      || !['plus', 'pro', 'prolite', 'team', 'business', 'enterprise', 'edu', 'edu_plus', 'edu_pro'].includes(account.planType)) {
      return channel.fail('auth-error');
    }
    accountClass = 'chatgpt';
    if (request.purpose === 'auth') { stage = 'finished'; channel.finish(); return; }
    stage = 'thread';
    channel.send(rpc(3, 'thread/start', { cwd: request.cwd, model: request.allocation.modelId,
      ephemeral: true, allowProviderModelFallback: false,
      ...(request.phase === 'task' ? {} : { sandbox: 'read-only' }) }));
  }

  function response(message, channel) {
    if (message.error || !message.result || typeof message.result !== 'object') return channel.fail('protocol-error');
    if (stage === 'initialize' && message.id === 1) {
      stage = 'account'; channel.send({ method: 'initialized' }); channel.send(rpc(2, 'account/read', {})); return;
    }
    if (stage === 'account' && message.id === 2) return accountResponse(message.result, channel);
    if (stage === 'thread' && message.id === 3) {
      threadId = safeId(message.result.thread?.id);
      if (!threadId) return channel.fail('protocol-error');
      if (message.result.modelProvider !== 'openai') return channel.fail('auth-error');
      if (message.result.model !== request.allocation.modelId) return channel.fail('model-unavailable');
      observed = { ...observed, modelId: safeId(message.result.model), backendId: safeId(message.result.modelProvider),
        source: message.result.model || message.result.modelProvider ? 'provider-observed' : 'unavailable' };
      stage = 'turn';
      channel.send(rpc(4, 'turn/start', { threadId, input: [{ type: 'text', text: request.input }],
        model: request.allocation.modelId, effort: request.allocation.effort })); return;
    }
    if (stage === 'turn' && message.id === 4) {
      turnId = safeId(message.result.turn?.id);
      if (!turnId || message.result.turn?.status !== 'inProgress') return channel.fail('protocol-error');
      stage = 'running'; return;
    }
    channel.fail('protocol-error');
  }

  function correlated(params) {
    return stage === 'running' && params?.threadId === threadId && params.turnId === turnId;
  }

  function itemEvent(method, params, channel) {
    if (!correlated(params) || !safeId(params.item?.id) || typeof params.item.type !== 'string') return channel.fail('protocol-error');
    const item = params.item;
    if (PASSIVE.has(item.type)) return;
    if (!EFFECT.has(item.type)) { unknown = true; return; }
    if (method === 'item/started') {
      if (pending.has(item.id) || completed.has(item.id)) return channel.fail('protocol-error');
      pending.set(item.id, item.type); channel.event({ type: 'tool-started', toolKind: item.type });
    } else {
      if (pending.get(item.id) !== item.type || (item.status && !COMPLETED.has(item.status))) { unknown = true; return; }
      pending.delete(item.id); completed.set(item.id, item.type); channel.event({ type: 'tool-completed', toolKind: item.type });
    }
  }

  function terminalEvent(params, channel) {
    if (stage !== 'running' || params?.threadId !== threadId || params.turn?.id !== turnId || terminal
      || !Array.isArray(params.turn.items) || !['completed', 'failed', 'interrupted'].includes(params.turn.status)) return channel.fail('protocol-error');
    for (const item of params.turn.items) {
      if (!safeId(item?.id) || (!PASSIVE.has(item.type) && completed.get(item.id) !== item.type)) unknown = true;
    }
    terminal = { status: params.turn.status, errorCode: safeId(params.turn.error?.codexErrorInfo) };
    if (terminal.status === 'completed' && params.turn.error) return channel.fail('protocol-error');
    const texts = params.turn.items.filter(item => item.type === 'agentMessage').map(item => item.text);
    if (texts.some(value => typeof value !== 'string')) return channel.fail('protocol-error');
    finalText = texts.join('\n');
    stage = 'finished'; channel.finish();
  }

  function event(message, channel) {
    if (Object.hasOwn(message, 'id') && Object.hasOwn(message, 'method')) return channel.fail('protocol-error');
    if (Object.hasOwn(message, 'id')) return response(message, channel);
    const { method, params } = message;
    if (typeof method !== 'string') return channel.fail('protocol-error');
    if (stage === 'finished' && ['turn/started', 'turn/completed', 'error', 'item/started'].includes(method)) return channel.fail('protocol-error');
    if (method === 'item/started' || method === 'item/completed') return itemEvent(method, params, channel);
    if (method === 'turn/completed') return terminalEvent(params, channel);
    if (method === 'error') return errorEvent(params, channel);
    if (method === 'thread/tokenUsage/updated') return usageEvent(params, channel);
    if (method === 'turn/started') return startedEvent(params, channel);
    // Notifications carry no implicit approvals, new turns, tools or account changes.
    if (/^account\//.test(method) || /^item\/.+\/(?:started|completed)$/.test(method)
      || (method.startsWith('turn/') && !['turn/plan/updated', 'turn/diff/updated'].includes(method))) unknown = true;
  }

  function startedEvent(params, channel) {
      if (stage !== 'running' || params?.threadId !== threadId || params.turn?.id !== turnId || params.turn?.status !== 'inProgress') {
        return channel.fail('protocol-error');
      }
      return;
  }

  function errorEvent(params, channel) {
      if (!correlated(params) || typeof params.willRetry !== 'boolean') return channel.fail('protocol-error');
      const code = safeId(params.error?.codexErrorInfo);
      if (!code || (errorCode && errorCode !== code)) unknown = true;
      errorCode = code; retry = retry || params.willRetry; return;
  }

  function usageEvent(params, channel) {
      if (!correlated(params)) return channel.fail('protocol-error');
      const total = params.tokenUsage?.total;
      usage = total ? { inputTokens: total.inputTokens, cachedInputTokens: total.cachedInputTokens,
        outputTokens: total.outputTokens, reasoningTokens: total.reasoningOutputTokens } : null;
  }

  function finish() {
    const toolQuiescence = unknown || retry ? 'unknown' : pending.size ? 'pending' : 'observed-clear';
    const contradictory = errorCode && errorCode !== terminal?.errorCode;
    const confirmed = request.purpose !== 'auth' && terminal?.status === 'failed'
      && terminal.errorCode === 'usageLimitExceeded' && accountClass === 'chatgpt'
      && !contradictory && toolQuiescence === 'observed-clear';
    const category = terminalCategory(confirmed);
    return { terminal: request.purpose === 'auth' ? accountClass === 'chatgpt' : terminal !== null,
      category,
      nativeErrorCode: terminal?.errorCode ?? errorCode, toolQuiescence, quotaCandidate: confirmed,
      finalText: terminal?.status === 'completed' ? finalText : '', usage, observed, accountClass,
      responseFraming: terminal ? 'single-turn' : 'unobserved' };
  }

  function terminalCategory(confirmed) {
    if (!terminal) return request.purpose === 'auth' && accountClass ? 'none' : 'protocol-error';
    if (terminal.status === 'completed' && !errorCode) return 'none';
    return confirmed ? 'usage-limit' : 'provider-error';
  }
  return { initial, event, finish };
}

function execAdapter(request) {
  let terminal = false; let error = false; let finalText = ''; let usage = null; let turnCount = 0; let inTurn = false;
  const pending = new Set(); let unknown = false;
  function itemEvent(message, channel) {
    const item = message.item;
    if (!safeId(item?.id)) return channel.fail('protocol-error');
    if (item.type === 'agent_message' && message.type === 'item.completed') finalText = typeof item.text === 'string' ? item.text : '';
    else if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(item.type)) {
      if (message.type === 'item.started') pending.add(item.id);
      else if (!pending.delete(item.id)) unknown = true;
    } else if (!['reasoning', 'agent_message', 'todo_list'].includes(item.type)) unknown = true;
  }
  function event(message, channel) {
    if (typeof message.type !== 'string') return channel.fail('protocol-error');
    if (message.type === 'turn.started') {
      if (inTurn) return channel.fail('protocol-error');
      inTurn = true; terminal = false;
    }
    if (message.type === 'error' || message.type === 'turn.failed') error = true;
    if (message.type === 'turn.failed') terminal = true;
    if (message.type === 'turn.completed') {
      if (!inTurn) return channel.fail('protocol-error');
      inTurn = false; terminal = true; turnCount++;
      usage = turnCount === 1 && message.usage ? {
      inputTokens: message.usage.input_tokens, cachedInputTokens: message.usage.cached_input_tokens,
      outputTokens: message.usage.output_tokens } : null; }
    if (message.type === 'item.started' || message.type === 'item.completed') itemEvent(message, channel);
  }
  return { event, finish: () => ({ terminal: terminal || error, category: error ? 'provider-error' : terminal ? 'none' : 'protocol-error',
    nativeErrorCode: null, toolQuiescence: unknown ? 'unknown' : pending.size ? 'pending' : 'observed-clear',
    quotaCandidate: false, finalText: error || (request.phase !== 'task' && turnCount !== 1) ? '' : finalText, usage, observed: baseObserved(),
    responseFraming: turnCount === 1 ? 'single-turn' : turnCount > 1 ? 'invalid-multiple-turns' : 'unobserved' }) };
}

module.exports = { codexArgs, appServerAdapter, execAdapter, QUOTA_MAPPING };
