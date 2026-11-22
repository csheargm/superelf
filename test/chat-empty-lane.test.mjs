// Ask AI answered "No response — try rephrasing." (owner, 2026-11-12, Bible app, live).
//
// MEASURED on a throwaway node with the live chat_models: the stored fast answers (95/104 chars in
// 786/864 ms) match DeepSeek — chat_models[0] — on the same Explain prompt (0.5-1.0 s, 86-136
// chars); the Claude agent lane took 5.8-7.9 s on every run. Three defects, each tested here over
// the REAL chat-ui (reqChat + its prefs handler, extracted), the REAL shell broker (extracted) and
// the REAL web.mjs, with only Ollama and the claude CLI faked:
//   1. a turn sent before the model list arrived carried no model, so the server's default lane
//      answered while the chip named another; and a frame first given the list with no remembered
//      lane kept PAC_MODELS[0] (DeepSeek) after the remembered one arrived;
//   2. a blank answer was stored as { role:'md', text:'' } and painted as "No response";
//   3. nothing in the node log said which lane ran.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor, api, OWNER_TOKEN } from './helpers-web.mjs';
import { loadShellBroker } from './helpers-shell-broker.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { CHAT } from './helpers-app.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const FAST_EMPTY = 'FAST-EMPTY', CLAUDE_BLANK = 'CLAUDE-BLANK';
const MODELS = [
  { id: 'deepseek', label: 'DeepSeek', group: 'Fast', provider: 'ollama', model: 'fake-fast' },
  { id: 'claude', label: 'Claude', group: 'Agent', provider: 'claude', model: null },
];

// Ollama /api/chat, streamed as the real one: content chunks then done. FAST-EMPTY in the last
// user turn → a stream that completes with no content at all (what the live blank turns stored).
function startOllamaStub() {
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }).on('end', () => {
      const msgs = JSON.parse(b).messages; const last = msgs[msgs.length - 1].content;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (!last.includes(FAST_EMPTY)) res.write(JSON.stringify({ message: { role: 'assistant', content: 'FAST-ANSWER' }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
// The claude CLI's stream-json result line. CLAUDE-BLANK in the CURRENT message → result ''.
const fakeClaude = (log) => `#!/usr/bin/env node
import fs from 'node:fs';let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({stdin:s})+'\\n');
  const cur=s.includes('[Current message:]')?s.slice(s.lastIndexOf('[Current message:]')):s;
  process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:cur.includes('${CLAUDE_BLANK}')?'':'ANSWERED',session_id:'0f8fad5b-d9cb-469f-a165-70867728950e'})+'\\n');
});
`;

let ollama, web, root, port, spawnLog, seq = 0;
before(async () => {
  ollama = await startOllamaStub();
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { ollama_url: `http://127.0.0.1:${ollama.address().port}`, chat_models: MODELS, task_timeout_minutes: 1 } });
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  spawnLog = path.join(root, 'spawns.jsonl');
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = writeFakeCli(bin, 'claude', fakeClaude(spawnLog));
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  web = startWeb(root); await waitReady(port);
});
after(async () => { await stopWeb(web); ollama.close(); rmTemp(root); });

const tag = (n) => `T-${n}-${++seq}-${Date.now()}`;
const claudeSpawns = (t) => { let s = ''; try { s = fs.readFileSync(spawnLog, 'utf8'); } catch { /* no spawn yet: none */ }
  return s.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.stdin.includes(t)); };
const chatLines = (log) => log.split('\n').filter((l) => l.startsWith('[chat] '));
async function chat(body) {
  const r = await api(port, '/api/chat', { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
  assert.equal(r.status, 200);
  return (await r.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
async function stored(convoId) {
  const r = await api(port, `/api/convos/${convoId}`, { headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
  return (await r.json()).messages;
}

// PAChat's reqChat and its prefs handler, EXTRACTED from web/chat-ui.inline.html and run against the
// shell's broker (extracted from the served shell), which relays to the real web.mjs above.
function loadChatUi(broker) {
  const head = CHAT.slice(CHAT.indexOf('  let _cid=0;'), CHAT.indexOf('  /* ── Size limits'));
  const prefs = CHAT.slice(CHAT.indexOf('  // Apply global font scale pushed by the shell'), CHAT.indexOf('  // ── PANewDot'));
  assert.ok(head.includes('const reqChat=') && prefs.includes("m.pa==='prefs'"), 'reqChat and the prefs handler are findable');
  const listeners = [], posted = [];
  const window = { addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); }, PANewDot: { _loaded: true } };
  const toPage = (data) => listeners.forEach((fn) => fn({ data }));
  const parent = { postMessage: (m) => { posted.push(m); broker.route(m, toPage); } };
  // eslint-disable-next-line no-new-func
  const ui = new Function('window', 'parent', `${head}\n${prefs}\nreturn { reqChat, chip:()=>{ const c=PAC_MODELS.find(x=>x.id===PAC_CURMODEL)||PAC_MODELS[0]; return c?c.id:null; } };`)(window, parent);
  const send = (message) => { const evs = []; return ui.reqChat(message, null, (ev) => evs.push(ev)).then((done) => ({ done, evs })); };
  return { ...ui, send, prefs: (m) => toPage({ pa: 'prefs', ...m }), posted };
}
const pub = MODELS.map(({ id, label, group }) => ({ id, label, group }));

test('Explain fired before the model list loads is answered by the lane the chip then shows', async () => {
  const ui = loadChatUi(loadShellBroker(`http://127.0.0.1:${port}`, { token: OWNER_TOKEN, app: 'bible' }));
  const t = tag('early');
  const turn = ui.send(`释经 Explain — John 3:5 ${t}`);   // the rail opened: no list yet
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ui.posted.filter((m) => m.kind === 'chat').length, 0, 'nothing is sent while the lane is unknown');
  ui.prefs({ models: pub, wantModel: 'deepseek' });   // the remembered lane for this app
  const { done, evs } = await turn;
  assert.equal(ui.chip(), 'deepseek');
  assert.equal(ui.posted.find((m) => m.kind === 'chat').model, 'deepseek', 'the turn names the chip lane');
  assert.equal(claudeSpawns(t).length, 0, 'the server default (Claude) did not answer it');
  assert.ok(done.done && evs.some((e) => e.type === 'done' && e.text === 'FAST-ANSWER'), 'the chip lane answered');
});

test('a remembered lane that arrives after a defaulted list replaces the default', async () => {
  const ui = loadChatUi(loadShellBroker(`http://127.0.0.1:${port}`, { token: OWNER_TOKEN, app: 'bible' }));
  ui.prefs({ models: pub });                       // profile not loaded yet: no wantModel
  assert.equal(ui.chip(), 'deepseek');
  ui.prefs({ models: pub, wantModel: 'claude' });  // the profile arrived
  assert.equal(ui.chip(), 'claude');
  const t = tag('late');
  const { evs } = await ui.send(`释经 Explain — John 3:6 ${t}`);
  assert.equal(ui.posted.find((m) => m.kind === 'chat').model, 'claude');
  assert.equal(claudeSpawns(t).length, 1);
  assert.ok(evs.some((e) => e.type === 'done' && e.text === 'ANSWERED'));
});

test('an empty answer is not stored blank: it names the lane that failed (composer turn, no fallback)', async () => {
  const t = tag('blank');
  const lines = await chat({ message: `${FAST_EMPTY} ${t}`, model: 'deepseek' });
  const err = lines.find((l) => l.type === 'error'), done = lines.find((l) => l.type === 'done');
  assert.ok(err && /^DeepSeek gave no answer/.test(err.text) && /empty answer/.test(err.text), `the failure names the lane: ${err && err.text}`);
  assert.equal(done.ok, false); assert.equal(done.text, '', 'the failure is not dressed up as the answer');
  assert.equal(claudeSpawns(t).length, 0, 'a composer turn is not rerouted');
  const md = (await stored(lines[0].id)).filter((m) => m.role === 'md');
  assert.equal(md.length, 1); assert.equal(md[0].failed, true); assert.match(md[0].text, /^DeepSeek gave no answer/);
});

test('an empty fast-lane answer to an app turn falls back ONCE to Claude, with a status line', async () => {
  const t = tag('fb');
  const lines = await chat({ message: `${FAST_EMPTY} ${t}`, model: 'deepseek', app: 'bible' });
  assert.ok(lines.some((l) => l.type === 'status' && /DeepSeek returned an empty answer — asking Claude/.test(l.text)));
  assert.equal(lines.find((l) => l.type === 'done').text, 'ANSWERED');
  assert.equal(claudeSpawns(t).length, 1);
  const md = (await stored(lines[0].id)).filter((m) => m.role === 'md');
  assert.deepEqual(md.map((m) => [m.text, !!m.failed]), [['ANSWERED', false]]);
  // Claude blank too: still one Claude run, and the failure names Claude.
  const t2 = tag('fb2');
  const l2 = await chat({ message: `${FAST_EMPTY} ${CLAUDE_BLANK} ${t2}`, model: 'deepseek', app: 'bible' });
  assert.equal(claudeSpawns(t2).length, 1, 'one fallback, never a loop');
  assert.match(l2.find((l) => l.type === 'error').text, /^Claude gave no answer/);
});

test('one log line per lane run: lane, model, ok, length, duration, code — never content', async () => {
  const t = tag('log');
  await chat({ message: `${FAST_EMPTY} ${t}`, model: 'deepseek', app: 'bible' });
  await waitFor(() => chatLines(web.log()).some((l) => /fallback=1/.test(l)), 'the fallback log line');
  const log = web.log();
  assert.ok(!log.includes(t), 'no message text in the node log');
  const mine = chatLines(log).slice(-2);
  assert.match(mine[0], /^\[chat\] app=bible lane=deepseek model=fake-fast ok=0 len=0 ms=\d+ code=empty$/);
  assert.match(mine[1], /^\[chat\] app=bible lane=claude model=default ok=1 len=8 ms=\d+ code=- fallback=1$/);
});
