#!/usr/bin/env node
/**
 * cc-web live tail incremental test.
 *
 * Creates a synthetic jsonl under a throwaway `~/.claude/projects/-test-…`
 * directory, imports it (which auto-attaches tail since mtime is now), then
 * appends one event at a time and asserts the matching websocket frame
 * arrives — covering every R57/R60/R61/R62/R63 tail path end-to-end.
 *
 * Everything is cleaned up after the run.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('/root/cc-web/node_modules/ws');

const PASSWORD = JSON.parse(fs.readFileSync('/root/cc-web/config/auth.json', 'utf8')).password;
const WS_URL = 'ws://127.0.0.1:8003';

// Throwaway test session lives under its own project dir so cleanup is just
// `rm -rf`. The slug encodes a cwd of /tmp/cc-web-tail-test-<rand>.
const TEST_NONCE = crypto.randomBytes(4).toString('hex');
const TEST_PROJECT_DIR = `-tmp-cc-web-tail-test-${TEST_NONCE}`;
const TEST_SID = crypto.randomUUID();
const JSONL_DIR = path.join(process.env.HOME || '/root', '.claude/projects', TEST_PROJECT_DIR);
const JSONL_PATH = path.join(JSONL_DIR, `${TEST_SID}.jsonl`);

let pass = 0, fail = 0;
const failures = [];
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; failures.push(`${label}${detail ? ' — ' + detail : ''}`); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
}
function section(name) { console.log(`\n== ${name} ==`); }

// Build jsonl line factory
function jl(obj) { return JSON.stringify(obj) + '\n'; }
const nowIso = () => new Date().toISOString();

// Seed the file with a single user row so import has something to title with.
fs.mkdirSync(JSONL_DIR, { recursive: true });
fs.writeFileSync(JSONL_PATH, jl({
  type: 'user',
  message: { role: 'user', content: '初始 live tail 测试' },
  uuid: crypto.randomUUID(),
  timestamp: nowIso(),
  cwd: `/tmp/cc-web-tail-test-${TEST_NONCE}`,
  sessionId: TEST_SID,
  gitBranch: 'main',
}));

// Bump the mtime to "now" so R60 considers the file "still being written"
// and auto-attaches tail on import.
const stat = fs.statSync(JSONL_PATH);
fs.utimesSync(JSONL_PATH, stat.atime, new Date());

// Append helper
function append(obj) { fs.appendFileSync(JSONL_PATH, jl(obj)); }

(async () => {
  const ws = new WebSocket(WS_URL);
  const inbox = [];
  function send(o) { ws.send(JSON.stringify(o)); }
  function recv(pred, timeoutMs = 6000, label = '') {
    return new Promise((resolve, reject) => {
      const matcher = typeof pred === 'string' ? (m) => m.type === pred : pred;
      const start = Date.now();
      const tick = () => {
        const i = inbox.findIndex(matcher);
        if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
        if (Date.now() - start > timeoutMs) {
          const summary = inbox.slice(-8).map(m => m.type).join(',');
          return reject(new Error(`timeout waiting for ${label || pred} — last seen: ${summary}`));
        }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.on('message', (raw) => { try { inbox.push(JSON.parse(raw)); } catch {} });

  section('1. Authenticate');
  send({ type: 'auth', password: PASSWORD });
  const auth = await recv('auth_result');
  ok('ws auth', auth.success === true);

  section('2. Import test jsonl → expect auto-attach (R60)');
  send({ type: 'import_native_session', sessionId: TEST_SID, projectDir: TEST_PROJECT_DIR });
  const sessInfo = await recv('session_info', 8000);
  const ccWebSid = sessInfo.sessionId;
  ok('import returned session_info', !!ccWebSid);
  ok('canTailExternal true', sessInfo.canTailExternal === true);
  ok('initial gitBranch=main echoed in session_info (R63)', sessInfo.gitBranch === 'main');

  const tailStarted = await recv('tail_started', 4000);
  ok('tail auto-started on import (R60)', !!tailStarted);
  ok('tail_started.reason = auto-import', tailStarted.reason === 'auto-import');

  // Pause to let the tail's first poll settle on EOF.
  await new Promise(r => setTimeout(r, 600));

  section('3. Append a brand-new user row → tail_user_message');
  append({
    type: 'user', message: { role: 'user', content: '第二条用户消息' },
    uuid: crypto.randomUUID(), timestamp: nowIso(), sessionId: TEST_SID, gitBranch: 'main',
  });
  const tum = await recv(m => m.type === 'tail_user_message' && /第二条/.test(m.text || ''), 6000, 'tail_user_message:第二条');
  ok('tail_user_message routed (R60)', /第二条/.test(tum.text));

  section('4. Append assistant turn with thinking + tool_use → text_delta + tool_start');
  const toolUseId = 'toolu_' + crypto.randomBytes(8).toString('hex');
  append({
    type: 'assistant',
    message: {
      id: 'msg_' + crypto.randomBytes(6).toString('hex'),
      type: 'message', role: 'assistant',
      content: [
        { type: 'thinking', thinking: '我要查看一下当前目录…' },
        { type: 'text', text: '我先 ls 一下。' },
        { type: 'tool_use', id: toolUseId, name: 'Bash', input: { command: 'ls /tmp', description: 'list /tmp' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 50, output_tokens: 18 },
    },
    uuid: crypto.randomUUID(), timestamp: nowIso(), sessionId: TEST_SID, gitBranch: 'main',
  });
  const thinking = await recv('thinking_delta', 6000, 'thinking_delta');
  ok('thinking_delta arrived (R57)', /查看一下当前目录/.test(thinking.text || ''));
  const td = await recv('text_delta', 6000, 'text_delta');
  ok('text_delta arrived', /先 ls 一下/.test(td.text || ''));
  const ts = await recv(m => m.type === 'tool_start' && m.toolUseId === toolUseId, 6000, 'tool_start');
  ok('tool_start arrived for Bash', ts.name === 'Bash');

  section('5. Append user row carrying tool_result → tool_end with stdout');
  append({
    type: 'user',
    message: { role: 'user', content: [
      { type: 'tool_result', tool_use_id: toolUseId, content: 'a.txt\nb.txt', is_error: false },
    ]},
    toolUseResult: { stdout: 'a.txt\nb.txt', stderr: '', interrupted: false, isImage: false },
    uuid: crypto.randomUUID(), timestamp: nowIso(), sessionId: TEST_SID, gitBranch: 'main',
  });
  const te = await recv(m => m.type === 'tool_end' && m.toolUseId === toolUseId, 6000, 'tool_end');
  ok('tool_end arrived', /a\.txt/.test(te.result || ''));
  ok('toolUseResult.stdout forwarded (R52/R63)', /a\.txt/.test(te?.toolUseResult?.stdout || ''));

  section('6. Append a second assistant turn that ends with stop_reason=end_turn → done');
  append({
    type: 'assistant',
    message: {
      id: 'msg_' + crypto.randomBytes(6).toString('hex'),
      type: 'message', role: 'assistant',
      content: [{ type: 'text', text: '看到 2 个文件。' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 20, output_tokens: 8 },
    },
    uuid: crypto.randomUUID(), timestamp: nowIso(), sessionId: TEST_SID, gitBranch: 'main',
  });
  const td2 = await recv(m => m.type === 'text_delta' && /看到 2 个/.test(m.text || ''), 6000);
  ok('second text_delta arrived', /看到/.test(td2.text));
  const done = await recv('done', 6000);
  ok('done fired after terminal stop_reason (R60)', !!done);

  section('7. Append slash command (/model opus) → system_message kind=slash-command');
  append({
    type: 'user',
    message: { role: 'user', content: '<command-name>/model</command-name>\n  <command-message>model</command-message>\n  <command-args>opus</command-args>' },
    uuid: crypto.randomUUID(), timestamp: nowIso(), sessionId: TEST_SID, gitBranch: 'main',
  });
  const sm = await recv(m => m.type === 'system_message' && m.kind === 'slash-command', 6000, 'system_message slash-command');
  ok('slash-command parsed + routed (R62)', /\/model/.test(sm.message || '') && /opus/.test(sm.message || ''));

  section('8. Append local-command-stdout (ANSI-laden) → command-output kind');
  append({
    type: 'system', subtype: 'local_command',
    content: '<local-command-stdout>Set model to [1mOpus 4.7 (1M context)[22m with [1mmax[22m effort</local-command-stdout>',
    level: 'info', timestamp: nowIso(), sessionId: TEST_SID,
  });
  const co = await recv(m => m.type === 'system_message' && m.kind === 'command-output', 6000, 'system_message command-output');
  ok('command-output rendered (R62)', !/\[1m/.test(co.message || '') && /Opus 4\.7/.test(co.message || ''));

  section('9. Append [Request interrupted by user] → tail_interrupted + done');
  // First open an assistant turn with a tool_use so the interrupt has a chip to close.
  const liveTool = 'toolu_' + crypto.randomBytes(8).toString('hex');
  append({
    type: 'assistant',
    message: {
      id: 'msg_' + crypto.randomBytes(6).toString('hex'),
      type: 'message', role: 'assistant',
      content: [{ type: 'tool_use', id: liveTool, name: 'Bash', input: { command: 'sleep 60' } }],
      stop_reason: 'tool_use',
      usage: { input_tokens: 5, output_tokens: 3 },
    },
    uuid: crypto.randomUUID(), timestamp: nowIso(), sessionId: TEST_SID, gitBranch: 'main',
  });
  await recv(m => m.type === 'tool_start' && m.toolUseId === liveTool, 6000);
  append({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    uuid: crypto.randomUUID(), timestamp: nowIso(), sessionId: TEST_SID, gitBranch: 'main',
  });
  const interrupted = await recv('tail_interrupted', 6000);
  ok('tail_interrupted emitted (R61)', interrupted.interruptedToolUseIds?.includes?.(liveTool) === true);
  const doneAfterInt = await recv('done', 3000);
  ok('synthetic done after interrupt (R61)', !!doneAfterInt);

  section('10. Append permission-mode change → permission_mode_changed');
  append({ type: 'permission-mode', permissionMode: 'plan', sessionId: TEST_SID });
  const pmc = await recv('permission_mode_changed', 6000);
  ok('permission_mode_changed fired (R63)', pmc.permissionMode === 'plan');

  section('11. Append ai-title → session_meta_updated');
  append({ type: 'ai-title', message: { title: '调试 ls /tmp' }, sessionId: TEST_SID });
  const smu = await recv('session_meta_updated', 6000);
  ok('session_meta_updated.title (R63)', smu.title === '调试 ls /tmp');

  section('12. Append pr-link → system_message info "已创建 PR"');
  append({
    type: 'pr-link', prNumber: 99,
    prUrl: 'https://github.com/cc/web/pull/99', prRepository: 'cc/web',
    sessionId: TEST_SID, timestamp: nowIso(),
  });
  const prl = await recv(m => m.type === 'system_message' && m.kind === 'info' && /PR #99/.test(m.message || ''), 6000, 'pr-link');
  ok('pr-link routed as info bubble (R63r4)', /https:\/\/github\.com\/cc\/web\/pull\/99/.test(prl.message));

  section('13. Append assistant with different gitBranch → git_branch_changed');
  append({
    type: 'assistant',
    message: {
      id: 'msg_' + crypto.randomBytes(6).toString('hex'),
      type: 'message', role: 'assistant',
      content: [{ type: 'text', text: '切到 feature 分支了。' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 5, output_tokens: 5 },
    },
    uuid: crypto.randomUUID(), timestamp: nowIso(), sessionId: TEST_SID, gitBranch: 'feature/r64',
  });
  // text_delta may arrive first; the branch event is the one we assert.
  // R63: gitBranch tracking starts from undefined per pseudo entry, so the
  // very first jsonl row with gitBranch='main' also emits a change event
  // that lands in the inbox before this step. Wait for the actual swap to
  // 'feature/r64' instead of matching the first git_branch_changed.
  const gbc = await recv(m => m.type === 'git_branch_changed' && m.gitBranch === 'feature/r64', 6000, 'git_branch_changed→feature');
  ok('git_branch_changed fired on branch swap (R63)', gbc.gitBranch === 'feature/r64');
  await recv('done', 6000);

  section('14. Append isSidechain assistant → must NOT generate events');
  // Snapshot inbox length, then append a sidechain row, wait a beat, expect no new tail events.
  const before = inbox.length;
  append({
    type: 'assistant', isSidechain: true,
    message: {
      id: 'msg_' + crypto.randomBytes(6).toString('hex'),
      type: 'message', role: 'assistant',
      content: [{ type: 'text', text: '子线流不该出现' }],
      stop_reason: 'end_turn',
      usage: {},
    },
    uuid: crypto.randomUUID(), timestamp: nowIso(), sessionId: TEST_SID, gitBranch: 'feature/r64',
  });
  await new Promise(r => setTimeout(r, 1200));
  const newEvents = inbox.slice(before).filter(m => /子线流不该出现/.test(m.text || ''));
  ok('isSidechain row produced no text_delta (R63r5)', newEvents.length === 0,
    newEvents.length ? `unexpected: ${JSON.stringify(newEvents.map(m=>m.type))}` : '');

  section('15. Detach tail → tail_stopped');
  send({ type: 'detach_tail' });
  const stopped = await recv('tail_stopped', 4000);
  ok('detach_tail → tail_stopped', !!stopped);

  section('16. Cleanup');
  send({ type: 'delete_session', sessionId: ccWebSid });
  await recv('session_list', 4000).catch(() => null);
  // R65 guarantee: jsonl must survive the cc-web copy deletion (since
  // the session was importedFrom an external project).
  ok('R65: original jsonl still on disk after delete_session', fs.existsSync(JSONL_PATH));
  // Now wipe the test dir ourselves.
  try { fs.rmSync(JSONL_DIR, { recursive: true, force: true }); } catch {}
  ok('test dir removed by test', !fs.existsSync(JSONL_DIR));

  ws.close();

  section('Summary');
  console.log(`  passed: ${pass}`);
  console.log(`  failed: ${fail}`);
  if (failures.length) {
    console.log('\nFailed:');
    for (const f of failures) console.log('  - ' + f);
  }
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('TEST CRASHED:', e);
  // Best-effort cleanup
  try { fs.rmSync(JSONL_DIR, { recursive: true, force: true }); } catch {}
  process.exit(2);
});
