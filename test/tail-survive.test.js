#!/usr/bin/env node
// R74: tail must survive a same-sessionId reload (was previously killed
// by handleLoadSession's unconditional prevTail.stop()).
const fs = require('fs');
const WebSocket = require('/root/cc-web/node_modules/ws');
const PASSWORD = JSON.parse(fs.readFileSync('/root/cc-web/config/auth.json', 'utf8')).password;

const SID = (() => {
  for (const f of fs.readdirSync('/root/cc-web/sessions').filter(x => x.endsWith('.json'))) {
    try {
      const s = JSON.parse(fs.readFileSync('/root/cc-web/sessions/' + f, 'utf8'));
      if (s.claudeSessionId && (s.messages || []).length > 100) return s.id;
    } catch {}
  }
  throw new Error('no eligible session');
})();

let pass=0, fail=0;
function ok(l, c, d='') { if (c) { pass++; console.log(' ✓', l); } else { fail++; console.log(' ✗', l, d?'— '+d:''); } }

(async () => {
  const ws = new WebSocket('ws://127.0.0.1:8003');
  const inbox = [];
  function send(o) { ws.send(JSON.stringify(o)); }
  function recv(t, ms=5000) { return new Promise((r,e)=>{ const s=Date.now(); const tick=()=>{
    const i=inbox.findIndex(typeof t==='string'?m=>m.type===t:t);
    if(i>=0) return r(inbox.splice(i,1)[0]);
    if(Date.now()-s>ms) return e(new Error('timeout '+t));
    setTimeout(tick, 50);
  }; tick(); }); }
  await new Promise(r=>ws.once('open',r));
  ws.on('message', raw => { try { inbox.push(JSON.parse(raw)); } catch {} });
  send({ type: 'auth', password: PASSWORD });
  await recv('auth_result');

  console.log('== R74 — tail must survive same-sessionId reload ==');

  send({ type: 'load_session', sessionId: SID });
  await recv('session_info', 10000);

  send({ type: 'attach_tail', sessionId: SID });
  const started = await recv('tail_started');
  ok('attach_tail succeeded', !!started);

  // Same-session reload — must NOT emit tail_stopped (would mean tail was killed).
  send({ type: 'load_session', sessionId: SID });
  await recv('session_info', 10000);
  let stopped = null;
  try { stopped = await recv('tail_stopped', 1500); } catch {}
  ok('R74: same-session reload did NOT emit tail_stopped', !stopped);

  // Confirm tail still alive by detaching explicitly — should now stop cleanly.
  send({ type: 'detach_tail' });
  const stoppedAfterDetach = await recv('tail_stopped', 2000);
  ok('explicit detach_tail still works after the reload', !!stoppedAfterDetach);

  ws.close();
  console.log(`\nSummary: passed=${pass}, failed=${fail}`);
  process.exit(fail===0?0:1);
})().catch(e=>{console.error(e);process.exit(2);});
