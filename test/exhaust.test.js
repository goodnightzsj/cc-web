const fs = require('fs');
const WebSocket = require('/root/cc-web/node_modules/ws');
const PASSWORD = JSON.parse(fs.readFileSync('/root/cc-web/config/auth.json', 'utf8')).password;
// R72: find the largest session at run-time (the prior hardcoded one kept
// getting deleted by other tests / R65 cleanup flows).
const SID = (() => {
  let id = null, max = 0;
  for (const f of fs.readdirSync('/root/cc-web/sessions').filter(x => x.endsWith('.json'))) {
    try {
      const s = JSON.parse(fs.readFileSync('/root/cc-web/sessions/' + f, 'utf8'));
      if ((s.messages || []).length > max) { max = s.messages.length; id = s.id; }
    } catch {}
  }
  if (!id) throw new Error('no sessions to test against');
  return id;
})();

let pass=0, fail=0;
function ok(label, cond, detail='') { if (cond) { pass++; console.log(' ✓', label); } else { fail++; console.log(' ✗', label, detail ? '— '+detail : ''); } }

(async () => {
  const ws = new WebSocket('ws://127.0.0.1:8003');
  const inbox = [];
  function send(o) { ws.send(JSON.stringify(o)); }
  function recv(t, ms=10000) { return new Promise((r,e)=>{ const s=Date.now(); const tick=()=>{
    const i=inbox.findIndex(m=>m.type===t); if(i>=0) return r(inbox.splice(i,1)[0]);
    if (Date.now()-s>ms) return e(new Error('timeout '+t));
    setTimeout(tick, 30);
  }; tick(); }); }
  await new Promise(r=>ws.once('open',r));
  ws.on('message', raw => { try { inbox.push(JSON.parse(raw)); } catch {} });
  send({ type: 'auth', password: PASSWORD });
  await recv('auth_result');

  console.log('== R70 — exhaust + cache-empty reply ==');

  // 1. Drain the entire 14630-msg session's queue, asserting remaining→0 eventually
  send({ type: 'load_session', sessionId: SID });
  const si = await recv('session_info', 30000);
  ok('session_info historyPending=true', si.historyPending === true);

  let totalChunks = 0, totalMessages = 0, lastRemaining = -1;
  while (true) {
    send({ type: 'request_older_history', sessionId: SID });
    const c = await recv('session_history_chunk', 8000);
    totalChunks++;
    totalMessages += (c.messages || []).length;
    lastRemaining = c.remaining;
    if (c.remaining === 0 && (!c.messages || c.messages.length === 0)) break;
    if (c.remaining === 0) break; // last actual chunk
    if (totalChunks > 800) { console.log('  ! safety break at 800 chunks'); break; }
  }
  ok(`drained queue (${totalChunks} chunks, ${totalMessages} msgs)`, lastRemaining === 0);

  // 2. After exhaust, request once more — server must STILL reply with empty chunk
  // (R70 fix: previously it just `break`-ed and never responded, leaving inFlight stuck).
  const t0 = Date.now();
  send({ type: 'request_older_history', sessionId: SID });
  const empty = await recv('session_history_chunk', 4000);
  ok(`R70: post-exhaust request still replied (${Date.now()-t0}ms)`, !!empty);
  ok('R70: post-exhaust messages = []', Array.isArray(empty.messages) && empty.messages.length === 0);
  ok('R70: post-exhaust remaining = 0', empty.remaining === 0);

  // 3. Request with bogus sessionId → must also reply (not break)
  send({ type: 'request_older_history', sessionId: 'no-such-session' });
  const bogus = await recv('session_history_chunk', 4000);
  ok('R70: bogus-sessionId request still replied', !!bogus);
  ok('R70: bogus reply remaining = 0', bogus.remaining === 0);

  ws.close();
  console.log(`\nSummary: passed=${pass}, failed=${fail}`);
  process.exit(fail===0 ? 0 : 1);
})().catch(e => { console.error('CRASHED:', e); process.exit(2); });
