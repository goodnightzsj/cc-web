#!/usr/bin/env node
const fs = require('fs');
const WebSocket = require('/root/cc-web/node_modules/ws');

const PASSWORD = JSON.parse(fs.readFileSync('/root/cc-web/config/auth.json', 'utf8')).password;
const SID = '0b2d858f-2be8-4b2b-8061-d17c00c7a1c5';  // the 34MB session

let pass=0, fail=0;
function ok(label, cond, detail='') {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail?' — '+detail:''}`); }
}

(async () => {
  const ws = new WebSocket('ws://127.0.0.1:8003');
  const inbox = [];
  function send(o) { ws.send(JSON.stringify(o)); }
  function recv(pred, timeoutMs=8000) {
    return new Promise((resolve, reject) => {
      const matcher = typeof pred === 'string' ? m => m.type === pred : pred;
      const start = Date.now();
      const tick = () => {
        const i = inbox.findIndex(matcher);
        if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
        if (Date.now()-start > timeoutMs) return reject(new Error('timeout for ' + pred));
        setTimeout(tick, 50);
      };
      tick();
    });
  }
  await new Promise((r,e)=>{ ws.once('open', r); ws.once('error', e); });
  ws.on('message', raw => { try { inbox.push(JSON.parse(raw)); } catch {} });

  console.log('== R68 lazy-load ws-level test ==');
  send({ type: 'auth', password: PASSWORD });
  const auth = await recv('auth_result');
  ok('auth success', auth.success === true);

  const t0 = Date.now();
  send({ type: 'load_session', sessionId: SID });
  const sessInfo = await recv('session_info', 30000);
  const tInfo = Date.now() - t0;
  ok(`session_info arrived (${tInfo}ms)`, tInfo < 8000, `expected <8000ms; got ${tInfo}ms`);
  ok('session_info.messages count = INITIAL_HISTORY_COUNT (12)', sessInfo.messages?.length === 12,
     `got ${sessInfo.messages?.length}`);
  ok('session_info.historyPending = true', sessInfo.historyPending === true);
  ok('session_info.historyTotal > 100', sessInfo.historyTotal > 100, `got ${sessInfo.historyTotal}`);

  // Should NOT receive any session_history_chunk without explicit request.
  let stragglerChunk = null;
  try {
    stragglerChunk = await recv('session_history_chunk', 1500);
  } catch {}
  ok('NO unsolicited session_history_chunk (R68)', !stragglerChunk,
     stragglerChunk ? `got chunk with ${stragglerChunk.messages?.length} msgs` : '');

  // Now request one chunk explicitly.
  const tChunk0 = Date.now();
  send({ type: 'request_older_history', sessionId: SID });
  const chunk = await recv('session_history_chunk', 5000);
  const tChunk = Date.now() - tChunk0;
  ok(`first request_older_history reply (${tChunk}ms)`, tChunk < 1000, `expected <1s; got ${tChunk}ms`);
  ok('chunk has messages', Array.isArray(chunk.messages) && chunk.messages.length > 0,
     `got ${chunk.messages?.length}`);
  ok('chunk.remaining is a number', typeof chunk.remaining === 'number',
     `got ${chunk.remaining}`);

  // Drain a couple more to confirm queue draining.
  send({ type: 'request_older_history', sessionId: SID });
  const chunk2 = await recv('session_history_chunk', 3000);
  ok('second chunk also arrives', Array.isArray(chunk2.messages));
  ok('remaining decremented', chunk2.remaining < chunk.remaining,
     `was ${chunk.remaining}, now ${chunk2.remaining}`);

  ws.close();
  console.log(`\nSummary: passed=${pass}, failed=${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('CRASHED:', e); process.exit(2); });
