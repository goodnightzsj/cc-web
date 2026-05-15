function createAgentRuntime(deps) {
  const {
    processEnv,
    CLAUDE_PATH,
    CODEX_PATH,
    MODEL_MAP,
    loadModelConfig,
    applyCustomTemplateToSettings,
    loadCodexConfig,
    prepareCodexCustomRuntime,
    wsSend,
    truncateObj,
    sanitizeToolInput,
    loadSession,
    saveSession,
    setRuntimeSessionId,
    getRuntimeSessionId,
    bufferReplayable,
  } = deps;

  // Wrapper: buffer event for reconnect replay AND send to current ws.
  // Skip text_delta (recoverable via fullText) — only buffer the small,
  // semantically-important events. Auto-stamps payload.sessionId from
  // entry.sessionId so cross-session race-window events on the client can be
  // dropped (extends the loop2-12 fix to all event types, not just deltas).
  function wsSendR(entry, payload, dropIfBacklogged = false) {
    if (!entry) return;
    if (entry.sessionId && payload && payload.sessionId === undefined) {
      payload.sessionId = entry.sessionId;
    }
    if (typeof bufferReplayable === 'function') bufferReplayable(entry, payload);
    if (entry.ws) wsSend(entry.ws, payload, dropIfBacklogged);
    // R33: persist system_message into session.messages so historical sessions
    // render init / rate-limit / hook / error context like the live one.
    // Previously these only lived in entry.pendingEvents (per-process buffer),
    // so once the process exited the model name + rate-limit notices were lost
    // when the user navigated back. Skip very-frequent kinds (none currently)
    // and skip when no session id is bound.
    if (payload && payload.type === 'system_message' && entry.sessionId && typeof loadSession === 'function' && typeof saveSession === 'function') {
      try {
        const sess = loadSession(entry.sessionId);
        if (sess) {
          sess.messages = Array.isArray(sess.messages) ? sess.messages : [];
          sess.messages.push({
            role: 'system',
            kind: payload.kind || null,
            content: payload.message || '',
            ts: new Date().toISOString(),
          });
          saveSession(sess);
        }
      } catch {}
    }
  }

  const MAX_FULL_TEXT_CHARS = 2 * 1024 * 1024; // 2M UTF-16 code units
  const MAX_TOOL_CALLS = 200;
  const TOOL_RESULT_LIMIT = 64 * 1024; // 64KB per tool result sent over ws

  function truncateToolResult(text, limit = TOOL_RESULT_LIMIT) {
    const s = typeof text === 'string' ? text : String(text || '');
    const totalLength = s.length;
    if (totalLength <= limit) return { text: s, truncated: false, totalLength };
    // Avoid splitting a surrogate pair
    let end = limit;
    if (s.charCodeAt(end - 1) >= 0xd800 && s.charCodeAt(end - 1) <= 0xdbff) end -= 1;
    return { text: s.slice(0, end), truncated: true, totalLength };
  }

  function appendFullText(entry, text) {
    if (!text) return;
    const remaining = MAX_FULL_TEXT_CHARS - entry.fullText.length;
    if (remaining <= 0) {
      entry.fullTextTruncated = true;
      return;
    }
    if (text.length <= remaining) {
      entry.fullText += text;
    } else {
      // Avoid splitting a surrogate pair at the boundary
      let end = remaining;
      if (text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) {
        end -= 1;
      }
      entry.fullText += text.slice(0, end);
      entry.fullTextTruncated = true;
    }
  }

  function buildClaudeSpawnSpec(session, options = {}) {
    const hasAttachments = Array.isArray(options.attachments) && options.attachments.length > 0;
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (hasAttachments) args.push('--input-format', 'stream-json');
    const permMode = session.permissionMode || 'yolo';
    switch (permMode) {
      case 'yolo':
        args.push('--dangerously-skip-permissions');
        break;
      case 'plan':
        args.push('--permission-mode', 'plan');
        break;
      case 'default':
        args.push('--permission-mode', 'default');
        break;
    }
    if (session.claudeSessionId) {
      args.push('--resume', session.claudeSessionId);
    }
    if (session.model) {
      args.push('--model', session.model);
    }

    const env = { ...processEnv };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    delete env.CC_WEB_PASSWORD;
    for (const k of Object.keys(env)) {
      if (k.startsWith('ANTHROPIC_')) delete env[k];
    }

    const modelCfg = loadModelConfig();
    if (modelCfg.mode === 'custom' && modelCfg.activeTemplate) {
      const tpl = (modelCfg.templates || []).find((t) => t.name === modelCfg.activeTemplate);
      if (tpl) applyCustomTemplateToSettings(tpl);
    }

    return {
      command: CLAUDE_PATH,
      args,
      env,
      cwd: session.cwd || processEnv.HOME || processEnv.USERPROFILE || process.cwd(),
      parser: 'claude',
      mode: permMode,
      resume: !!session.claudeSessionId,
    };
  }

  function buildCodexSpawnSpec(session, options = {}) {
    const codexConfig = loadCodexConfig();
    const runtimeConfig = prepareCodexCustomRuntime(codexConfig, session);
    if (runtimeConfig?.error) {
      return { error: runtimeConfig.error };
	    }
	    const runtimeId = getRuntimeSessionId(session);
	    const args = ['exec'];
	    args.push('--json', '--skip-git-repo-check');

	    const permMode = session.permissionMode || 'yolo';
	    // `-s/--sandbox` is an option for `codex exec`, but not for `codex exec resume`.
	    // When resuming, it must appear before the `resume` subcommand, otherwise Codex CLI errors
	    // with: "unexpected argument '-s' found".
	    if (runtimeId && permMode === 'plan') {
	      args.push('-s', 'read-only');
	    }
	    if (runtimeId) args.push('resume');
	    switch (permMode) {
	      case 'yolo':
	        args.push('--dangerously-bypass-approvals-and-sandbox');
	        break;
	      case 'plan':
	        if (!runtimeId) args.push('-s', 'read-only');
	        break;
	      case 'default':
	      default:
	        args.push('--full-auto');
        break;
    }

    const effectiveModel = session.model;
    if (effectiveModel) {
      const raw = String(effectiveModel).trim();
      // cc-web UI supports "gpt-5.4(high)" style selection, but Codex CLI expects:
      // - model: "gpt-5.4"
      // - reasoning effort: config key `model_reasoning_effort = "high"`
      const m = raw.match(/^(.*)\((medium|high|xhigh)\)\s*$/i);
      if (m) {
        const base = String(m[1] || '').trim();
        const lvl = String(m[2] || '').trim().toLowerCase();
        if (base) args.push('--model', base);
        // Use TOML string literal to avoid parsing ambiguity.
        args.push('-c', `model_reasoning_effort="${lvl}"`);
      } else {
        args.push('--model', raw);
      }
    }
    if (Array.isArray(options.attachments)) {
      for (const attachment of options.attachments) {
        if (attachment?.path) args.push('--image', attachment.path);
      }
    }
    if (runtimeId) {
      args.push(runtimeId, '-');
    } else {
      if (session.cwd) args.push('-C', session.cwd);
      args.push('-');
    }

    const env = { ...processEnv };
    delete env.CC_WEB_PASSWORD;
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE;
    if (runtimeConfig?.homeDir) {
      env.CODEX_HOME = runtimeConfig.homeDir;
    }
    if (runtimeConfig?.mode === 'custom') {
      env.OPENAI_API_KEY = runtimeConfig.apiKey;
      delete env.OPENAI_BASE_URL;
    }

    return {
      command: CODEX_PATH,
      args,
      env,
      cwd: session.cwd || processEnv.HOME || processEnv.USERPROFILE || process.cwd(),
      parser: 'codex',
      mode: permMode,
      resume: !!runtimeId,
      codexRuntimeKey: runtimeConfig?.runtimeKey || '',
      codexHomeDir: runtimeConfig?.homeDir || '',
    };
  }

  function codexToolName(item) {
    switch (item?.type) {
      case 'command_execution':
        return 'CommandExecution';
      case 'mcp_tool_call':
        return 'McpToolCall';
      case 'file_change':
        return 'FileChange';
      case 'reasoning':
        return 'Reasoning';
      default:
        return item?.type || 'CodexItem';
    }
  }

  function codexToolInput(item) {
    if (!item) return null;
    if (item.type === 'command_execution') return { command: item.command || '' };
    return truncateObj(item, 500);
  }

  function codexToolMeta(item) {
    if (!item) return null;
    switch (item.type) {
      case 'command_execution':
        return {
          kind: 'command_execution',
          title: 'Shell Command',
          subtitle: item.command || '',
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
          status: item.status || null,
        };
      case 'mcp_tool_call':
        return {
          kind: 'mcp_tool_call',
          title: 'MCP Tool',
          subtitle: item.tool_name || item.name || item.server_name || '',
          status: item.status || null,
        };
      case 'file_change':
        return {
          kind: 'file_change',
          title: 'File Change',
          subtitle: item.path || item.file_path || '',
          status: item.status || null,
        };
      case 'reasoning':
        return {
          kind: 'reasoning',
          title: 'Reasoning',
          subtitle: typeof item.text === 'string' ? item.text.slice(0, 120) : '',
          status: item.status || null,
        };
      default:
        return {
          kind: item.type || 'codex_item',
          title: codexToolName(item),
          subtitle: '',
          status: item.status || null,
        };
    }
  }

  function codexToolResult(item) {
    if (!item) return '';
    if (typeof item.aggregated_output === 'string' && item.aggregated_output) return item.aggregated_output;
    if (typeof item.text === 'string' && item.text) return item.text;
    return JSON.stringify(truncateObj(item, 1200));
  }

  function ensureCodexToolCall(entry, item) {
    let tc = entry.toolCalls.find((t) => t.id === item.id);
    if (tc) {
      tc.name = codexToolName(item);
      tc.kind = item.type || tc.kind || null;
      tc.meta = codexToolMeta(item) || tc.meta || null;
      if (tc.input == null) tc.input = codexToolInput(item);
      return tc;
    }
    tc = {
      name: codexToolName(item),
      id: item.id,
      kind: item.type || null,
      meta: codexToolMeta(item),
      input: codexToolInput(item),
      done: false,
    };
    if (entry.toolCalls.length < MAX_TOOL_CALLS) entry.toolCalls.push(tc);
    else entry.toolCallsTruncated = true;
    wsSendR(entry, {
      type: 'tool_start',
      name: tc.name,
      toolUseId: item.id,
      input: tc.input,
      kind: tc.kind,
      meta: tc.meta,
    });
    return tc;
  }

  function processClaudeEvent(entry, event, sessionId) {
    if (!event || !event.type) return;

    switch (event.type) {
      case 'system':
        if (event.session_id) {
          const session = loadSession(sessionId);
          if (session) {
            session.claudeSessionId = event.session_id;
            saveSession(session);
          }
        }
        // 透传 init banner / compact_summary 子类型
        if (event.subtype === 'init') {
          const tools = Array.isArray(event.tools) ? event.tools.length : null;
          const mcp = Array.isArray(event.mcp_servers) ? event.mcp_servers.length : null;
          const permMode = event.permissionMode || event.permission_mode || null;
          const parts = [];
          parts.push(`Claude Code 已就绪${event.model ? ' · ' + event.model : ''}`);
          if (event.cwd) parts.push(`cwd: ${event.cwd}`);
          const meta = [];
          if (tools != null) meta.push(`${tools} tools`);
          if (mcp != null) meta.push(`${mcp} MCP server${mcp === 1 ? '' : 's'}`);
          if (permMode) meta.push(permMode);
          if (meta.length) parts.push(meta.join(' · '));
          wsSendR(entry, { type: 'system_message', message: parts.join('\n'), kind: 'init' });
        } else if (event.subtype === 'compact_summary') {
          const orig = event.original_tokens || event.pre_compaction_tokens || event.input_tokens;
          const kept = event.kept_tokens || event.post_compaction_tokens || event.output_tokens;
          if (orig && kept) {
            const saved = Math.max(0, Math.round((1 - kept / orig) * 100));
            wsSendR(entry, {
              type: 'system_message',
              message: `/compact 完成：${orig.toLocaleString()} → ${kept.toLocaleString()} tokens（节省 ${saved}%）`,
              kind: 'compact',
            });
          }
          if (event.summary && typeof event.summary === 'string') {
            wsSendR(entry, { type: 'system_message', message: event.summary, kind: 'compact-summary' });
          }
        } else if (event.subtype === 'error' && event.message) {
          wsSendR(entry, { type: 'system_message', message: String(event.message), kind: 'error' });
        } else if (event.subtype === 'hook_response' || event.subtype === 'hook_started') {
          // Hook lifecycle: PreToolUse / PostToolUse / SessionStart / Stop
          // Only surface non-success outcomes (denied / blocked / error or non-zero exit)
          const outcome = event.outcome || event.status || '';
          const exitCode = typeof event.exit_code === 'number' ? event.exit_code : null;
          const stderrTxt = typeof event.stderr === 'string' ? event.stderr.trim() : '';
          const isNoteworthy = (outcome && outcome !== 'success' && outcome !== 'allowed')
            || (exitCode !== null && exitCode !== 0)
            || stderrTxt.length > 0;
          if (isNoteworthy) {
            const hookName = event.hook_event || event.hook_name || event.name || 'hook';
            const parts = [`钩子 ${hookName}: ${outcome || (exitCode != null ? `exit ${exitCode}` : 'noteworthy')}`];
            if (stderrTxt) parts.push(stderrTxt.slice(0, 500));
            wsSendR(entry, { type: 'system_message', message: parts.join('\n'), kind: 'hook' });
          }
        }
        break;

      case 'rate_limit_event': {
        // Claude rate-limit notice: status / overageStatus / resetsAt / rateLimitType
        const info = event.rate_limit_info || event;
        const status = info.status || '';
        const overage = info.overageStatus || info.overage_status || '';
        const resetsAt = info.resetsAt || info.resets_at || null;
        const limitType = info.rateLimitType || info.rate_limit_type || '';
        const isNoteworthy = (status && status !== 'allowed')
          || (overage && overage === 'rejected');
        // Dedup: only surface when status crosses
        const sig = `${status}|${overage}|${resetsAt || ''}`;
        if (isNoteworthy && entry.lastRateLimitSig !== sig) {
          entry.lastRateLimitSig = sig;
          const parts = [`Anthropic 限额提示：${status || overage}${limitType ? ` (${limitType})` : ''}`];
          if (resetsAt) {
            try {
              // resetsAt may be: ISO string, number ms, number seconds, or numeric string.
              let ts = resetsAt;
              if (typeof ts === 'string' && /^\d+$/.test(ts)) ts = Number(ts);
              // Promote unix-seconds (< 1e12 ≈ year 2001 in ms) to ms.
              if (typeof ts === 'number' && ts < 1e12) ts = ts * 1000;
              const d = new Date(ts);
              const ms = d.getTime();
              const now = Date.now();
              if (!Number.isNaN(ms) && ms > now - 86400000 && ms < now + 7 * 86400000) {
                // zh-CN 24h format matches CLI output style; relative offset
                // (e.g. "约 4h 30min 后") gives quick perception, locale-formatted
                // absolute time gives precision.
                const dateStr = d.toLocaleString('zh-CN', { hour12: false });
                const diffMin = Math.round((ms - now) / 60000);
                let relStr = '';
                if (diffMin > 0) {
                  const h = Math.floor(diffMin / 60);
                  const m = diffMin % 60;
                  relStr = h > 0 ? `（约 ${h}h${m}min 后）` : `（约 ${m}min 后）`;
                }
                parts.push(`重置时间：${dateStr}${relStr}`);
              }
            } catch {}
          }
          wsSendR(entry, { type: 'system_message', message: parts.join('\n'), kind: 'rate-limit' });
        }
        break;
      }

      case 'assistant': {
        const content = event.message?.content;
        if (!Array.isArray(content)) break;

        for (const block of content) {
          if (block.type === 'text' && block.text) {
            appendFullText(entry, block.text);
            wsSend(entry.ws, { type: 'text_delta', text: block.text, sessionId }, true);
          } else if (block.type === 'thinking' && (block.thinking || block.text)) {
            const thinkingText = block.thinking || block.text || '';
            wsSendR(entry, { type: 'thinking_delta', text: thinkingText, sessionId }, true);
          } else if (block.type === 'tool_use') {
            const toolInput = sanitizeToolInput(block.name, block.input);
            // Edit/Write/MultiEdit/NotebookEdit → 复用 file_change kind 让前端走 diff 渲染
            const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
            let kind = null;
            let meta = null;
            if (FILE_TOOLS.includes(block.name)) {
              kind = 'file_change';
              const filePath = toolInput?.file_path || toolInput?.notebook_path || '';
              meta = { kind: 'file_change', title: block.name, subtitle: filePath };
            }
            const tc = { name: block.name, id: block.id, input: toolInput, done: false, kind, meta };
            if (entry.toolCalls.length < MAX_TOOL_CALLS) entry.toolCalls.push(tc);
            else entry.toolCallsTruncated = true;
            const payload = { type: 'tool_start', name: block.name, toolUseId: block.id, input: tc.input };
            if (kind) { payload.kind = kind; payload.meta = meta; }
            wsSendR(entry, payload);
          } else if (block.type === 'tool_result') {
            const images = [];
            let resultText;
            if (typeof block.content === 'string') {
              resultText = block.content;
            } else if (Array.isArray(block.content)) {
              const textParts = [];
              for (const c of block.content) {
                if (!c || typeof c !== 'object') continue;
                if (c.type === 'text' && typeof c.text === 'string') textParts.push(c.text);
                else if (c.type === 'image' && c.source) images.push({ source: c.source });
                else if (c.type === 'tool_use') textParts.push(`[nested tool_use: ${c.name || ''}]\n${JSON.stringify(c.input || {}, null, 2)}`);
                else if (c.text) textParts.push(c.text);
              }
              resultText = textParts.join('\n');
            } else {
              resultText = JSON.stringify(block.content);
            }
            const truncated = truncateToolResult(resultText);
            const isError = !!block.is_error;
            const tc = entry.toolCalls.find((t) => t.id === block.tool_use_id);
            if (tc) {
              tc.done = true;
              tc.result = truncated.text;
              tc.resultTruncated = truncated.truncated;
              tc.resultTotalLength = truncated.totalLength;
              tc.isError = isError;
              if (images.length) tc.images = images;
            }
            const payload = {
              type: 'tool_end',
              toolUseId: block.tool_use_id,
              result: truncated.text,
              resultTruncated: truncated.truncated,
              resultTotalLength: truncated.totalLength,
              isError,
            };
            if (images.length) payload.images = images;
            wsSendR(entry, payload);
          }
        }

        if (event.session_id) {
          const session = loadSession(sessionId);
          if (session && !session.claudeSessionId) {
            session.claudeSessionId = event.session_id;
            saveSession(session);
          }
        }
        break;
      }

      case 'result': {
        const session = loadSession(sessionId);
        if (session) {
          if (event.session_id) session.claudeSessionId = event.session_id;
          if (event.total_cost_usd) session.totalCost = (session.totalCost || 0) + event.total_cost_usd;
          // result.usage is the authoritative turn-level aggregate
          const u = event.usage;
          if (u) {
            session.totalUsage = session.totalUsage || { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
            session.totalUsage.inputTokens += (u.input_tokens || 0);
            session.totalUsage.outputTokens += (u.output_tokens || 0);
            session.totalUsage.cachedInputTokens += (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
            entry.lastUsage = u;
          }
          saveSession(session);
        }
        entry.lastCost = event.total_cost_usd || null;
        if (entry.ws && event.total_cost_usd !== undefined) {
          wsSendR(entry, { type: 'cost', costUsd: session?.totalCost || 0 }, true);
        }
        if (entry.ws && event.usage && session?.totalUsage) {
          wsSendR(entry, { type: 'usage', totalUsage: session.totalUsage }, true);
        }
        // Surface terminal error subtypes (error_max_turns / error_during_execution / etc.)
        if (event.subtype && event.subtype !== 'success' && entry.ws) {
          const msg = (event.error && event.error.message) || event.message || `任务结束（${event.subtype}）`;
          wsSendR(entry, { type: 'system_message', message: msg, kind: 'error' });
        }
        break;
      }
    }
  }

  function processCodexEvent(entry, event, sessionId) {
    if (!event || !event.type) return;

    switch (event.type) {
      case 'thread.started': {
        if (!event.thread_id) break;
        const session = loadSession(sessionId);
        if (session) {
          setRuntimeSessionId(session, event.thread_id);
          if (entry.codexHomeDir) session.codexHomeDir = entry.codexHomeDir;
          if (entry.codexRuntimeKey) session.codexRuntimeKey = entry.codexRuntimeKey;
          saveSession(session);
        }
        break;
      }

      case 'item.started': {
        const item = event.item;
        if (!item || !item.id || item.type === 'agent_message') break;
        ensureCodexToolCall(entry, item);
        break;
      }

      case 'item.completed': {
        const item = event.item;
        if (!item || !item.id) break;
        if (item.type === 'agent_message') {
          if (item.text) {
            appendFullText(entry, item.text);
            wsSend(entry.ws, { type: 'text_delta', text: item.text, sessionId }, true);
          }
          break;
        }
        const tc = ensureCodexToolCall(entry, item);
        const truncated = truncateToolResult(codexToolResult(item));
        const isError = item.type === 'command_execution'
          && typeof item.exit_code === 'number' && item.exit_code !== 0;
        tc.done = true;
        tc.result = truncated.text;
        tc.resultTruncated = truncated.truncated;
        tc.resultTotalLength = truncated.totalLength;
        tc.isError = isError;
        wsSendR(entry, {
          type: 'tool_end',
          toolUseId: item.id,
          result: truncated.text,
          resultTruncated: truncated.truncated,
          resultTotalLength: truncated.totalLength,
          isError,
          kind: tc.kind,
          meta: tc.meta,
        });
        break;
      }

      case 'turn.completed': {
        const usage = event.usage || null;
        entry.lastUsage = usage;
        const session = loadSession(sessionId);
        if (session && usage) {
          session.totalUsage = {
            inputTokens: (session.totalUsage?.inputTokens || 0) + (usage.input_tokens || 0),
            cachedInputTokens: (session.totalUsage?.cachedInputTokens || 0) + (usage.cached_input_tokens || 0),
            outputTokens: (session.totalUsage?.outputTokens || 0) + (usage.output_tokens || 0),
          };
          saveSession(session);
          wsSendR(entry, { type: 'usage', totalUsage: session.totalUsage }, true);
        }
        break;
      }

      case 'turn.failed': {
        const message = event.error?.message || 'Codex 任务失败';
        entry.lastError = message;
        break;
      }

      // Codex item.failed: MCP / file_change / command 失败时发的是 failed 而非 completed；
      // 之前完全无 case 导致前端 spinner 永远停在 in-progress
      case 'item.failed': {
        const item = event.item || {};
        const errMsg = event.error?.message || item.error?.message || item.message || '工具调用失败';
        if (!item.id) {
          if (entry.ws) wsSendR(entry, { type: 'system_message', message: errMsg, kind: 'error' });
          entry.lastError = errMsg;
          break;
        }
        const tc = ensureCodexToolCall(entry, item);
        tc.done = true;
        tc.isError = true;
        tc.result = errMsg;
        wsSendR(entry, {
          type: 'tool_end',
          toolUseId: item.id,
          result: errMsg,
          isError: true,
          kind: tc.kind,
          meta: tc.meta,
        });
        break;
      }

      case 'error':
        if (event.message) {
          if (/^Reconnecting\.\.\./.test(event.message)) {
            wsSendR(entry, { type: 'system_message', message: event.message });
          } else {
            entry.lastError = event.message;
          }
        }
        break;
    }
  }

  function processRuntimeEvent(entry, event, sessionId) {
    if (entry.agent === 'codex') processCodexEvent(entry, event, sessionId);
    else processClaudeEvent(entry, event, sessionId);
  }

  return {
    buildClaudeSpawnSpec,
    buildCodexSpawnSpec,
    processClaudeEvent,
    processCodexEvent,
    processRuntimeEvent,
  };
}

module.exports = { createAgentRuntime };
