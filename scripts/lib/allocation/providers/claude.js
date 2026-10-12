'use strict';

const { safeId, baseObserved } = require('../provider-common');

function claudeArgs(_provider, allocation, phase, contextBinding) {
  return [...(contextBinding?.nativeEnvironment?.pluginDir ? ['--plugin-dir', contextBinding.nativeEnvironment.pluginDir] : []),
    '--print', '--output-format', 'stream-json', '--verbose', '--model', allocation.modelId, '--effort', allocation.effort,
    ...(phase === 'task' ? [] : ['--tools', '', '--no-session-persistence'])];
}

function claudeAdapter(request) {
  let terminal = null; let finalText = ''; let usage = null; let unknown = false; let overage = false;
  let sessionId = null; let observed = baseObserved(); const pending = new Set();

  function correlate(message, channel) {
    if (message.session_id !== undefined) {
      if (!safeId(message.session_id) || (sessionId && sessionId !== message.session_id)) { channel.fail('protocol-error'); return false; }
      sessionId = message.session_id;
    }
    return true;
  }

  function tools(message, channel) {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    for (const item of content) {
      if (item.type === 'tool_use') {
        if (message.type !== 'assistant' || !safeId(item.id) || pending.has(item.id)) return channel.fail('protocol-error');
        pending.add(item.id); channel.event({ type: 'tool-started', toolKind: safeId(item.name) || 'unknown' });
      }
      if (item.type === 'tool_result') {
        if (message.type !== 'user' || !pending.delete(item.tool_use_id)) unknown = true;
        channel.event({ type: 'tool-completed', toolKind: 'native-tool' });
      }
    }
  }

  function resultEvent(message, channel) {
      if (typeof message.is_error !== 'boolean' || typeof message.subtype !== 'string') return channel.fail('protocol-error');
      terminal = { isError: message.is_error, subtype: message.subtype, turnCount: message.num_turns };
      finalText = !message.is_error && typeof message.result === 'string'
        && (request.phase === 'task' || message.num_turns === 1) ? message.result : '';
      const u = message.usage;
      usage = u ? { inputTokens: Number.isSafeInteger(u.input_tokens) && Number.isSafeInteger(u.cache_read_input_tokens || 0)
        && Number.isSafeInteger(u.cache_creation_input_tokens || 0)
        ? u.input_tokens + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : null,
      cachedInputTokens: u.cache_read_input_tokens, outputTokens: u.output_tokens } : null;
  }

  function event(message, channel) {
    if (typeof message.type !== 'string' || !correlate(message, channel)) return channel.fail('protocol-error');
    if (terminal && ['result', 'assistant', 'user'].includes(message.type)) return channel.fail('protocol-error');
    if (message.type === 'result') resultEvent(message, channel);
    if (message.type === 'assistant' || message.type === 'user') {
      tools(message, channel);
      const modelId = safeId(message.message?.model);
      if (modelId) observed = { ...observed, modelId, source: 'provider-observed' };
    }
    if (message.type === 'rate_limit_event' && message.rate_limit_info?.isUsingOverage === true) overage = true;
    if (message.type === 'system' && ['task_started', 'task_progress'].includes(message.subtype)) unknown = true;
    if (!['system', 'assistant', 'user', 'result', 'rate_limit_event', 'stream_event', 'tool_progress', 'tool_use_summary', 'auth_status'].includes(message.type)) unknown = true;
  }

  return { event, finish: () => ({ terminal: terminal !== null,
    category: overage ? 'auth-error' : !terminal ? 'protocol-error' : terminal.isError || terminal.subtype !== 'success' ? 'provider-error' : 'none',
    nativeErrorCode: null, toolQuiescence: unknown ? 'unknown' : pending.size ? 'pending' : 'observed-clear',
    quotaCandidate: false, finalText: overage ? '' : finalText, usage, observed,
    responseFraming: terminal?.turnCount === 1 ? 'single-turn' : Number.isSafeInteger(terminal?.turnCount)
      && terminal.turnCount > 1 ? 'invalid-multiple-turns' : 'unobserved' }) };
}

module.exports = { claudeArgs, claudeAdapter };
