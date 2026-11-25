// "took 3.2s" was painted by the client when the reply settled and never stored, so reopening a
// conversation lost it — the answer was there, the timing was not. The duration is now stamped on
// the assistant message by the SERVER (one clock for every lane) and rendered from storage.
//
// The format was written three times and had already drifted: the reconnect path used a bare
// toFixed, so a reply that took three minutes printed "took 180.0s" instead of "took 3m 00s".
// One formatter per runtime now; the shell's and PAChat's are held identical here because apps are
// sandboxed and cannot share a script file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api } from './helpers-web.mjs';
import { before, after } from 'node:test';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = readShell(ROOT);
const CHAT = fs.readFileSync(path.join(ROOT, 'web', 'chat-ui.inline.html'), 'utf8');
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');

const mkEl = () => ({ className: '', textContent: '', kids: [], appendChild(c) { this.kids.push(c); return c; } });
const doc = { createElement: (tag) => Object.assign(mkEl(), { tagName: tag }) };
// Both formatters, lifted from the shipped files rather than retyped.
const shellApi = new Function('document', `${SHELL.slice(SHELL.indexOf('function took(ms){'), SHELL.indexOf('function renderMsgs'))}\nreturn {took,addTook};`)(doc);
const chatTook = new Function(`${CHAT.slice(CHAT.indexOf('const _took=(ms)=>'), CHAT.indexOf('\n', CHAT.indexOf('const _took=(ms)=>')))}\nreturn _took;`)();

test('the shell and PAChat format elapsed time identically', () => {
  for (const ms of [0, 950, 3200, 4200, 59999, 60000, 61000, 125000, 180000, 3600000]) {
    assert.equal(shellApi.took(ms), chatTook(ms), `drift at ${ms}ms`);
  }
});

test('minutes are minutes — the drifted copy printed 180.0s for a three-minute reply', () => {
  assert.equal(shellApi.took(3200), '3.2s');
  assert.equal(shellApi.took(180000), '3m 00s');
  assert.equal(shellApi.took(125000), '2m 05s', 'seconds are zero-padded');
  assert.equal(shellApi.took(59999), '60.0s', 'the switch happens at a full minute');
});

test('a missing or nonsense duration adds NOTHING, never "took NaNs"', () => {
  for (const bad of [undefined, null, NaN, -1, 'soon', {}]) {
    const el = mkEl();
    assert.equal(shellApi.addTook(el, bad), null, `${JSON.stringify(bad)} must not render`);
    assert.equal(el.kids.length, 0);
  }
  const el = mkEl();
  assert.ok(shellApi.addTook(el, 3200), 'a real duration does render');
  assert.equal(el.kids[0].className, 'pa-took');
  assert.equal(el.kids[0].textContent, 'took 3.2s');
});

test('the SERVER stamps the duration, measured from before any lane runs', () => {
  assert.match(WEB, /const startedAt = Date\.now\(\);/, 'the turn needs its own clock');
  assert.match(WEB, /const turnMs = Date\.now\(\) - startedAt;/, 'the turn duration is measured from startedAt');
  assert.match(WEB, /const mdMsg = \{ role: 'md', text: r\.text \|\| '', \.\.\.\(r\.ok === false \? \{\} : \{ ms: turnMs \}\)/,
    'an answer carries ms; a refusal does not (self-test F11)');
  // The clock must start BEFORE the lane runs, or it measures the save rather than the answer.
  assert.ok(WEB.indexOf('const startedAt = Date.now();') < WEB.indexOf('const mdMsg = {'), 'startedAt precedes the run');
});

test('both surfaces render the STORED duration on reload, not just live', () => {
  assert.match(SHELL, /addActions\(el,'response',m\.text,lastU\); addTook\(el,m\.ms,m\.by\);/,
    'the shell reload path must render m.ms');
  assert.equal((CHAT.match(/_addTook\(ae,mm\.ms,mm\.by\)/g) || []).length, 2,
    'PAChat has TWO replay paths — both must render it, or one drawer route loses the timing');
});

test('nobody keeps a private copy of the format (R3)', () => {
  assert.equal((SHELL.match(/toFixed\(1\)\+'s'/g) || []).length, 1, 'the shell formats elapsed time in ONE place');
  assert.equal((CHAT.match(/toFixed\(1\)\+'s'/g) || []).length, 1, 'PAChat formats elapsed time in ONE place');
  for (const [name, src] of [['shell', SHELL], ['PAChat', CHAT]]) {
    assert.equal((src.match(/className='pa-took'/g) || []).length, 1, `${name} builds the took line in ONE place`);
  }
});

// ── End to end: a real turn through the real server, then re-read from disk ──
// The bug was that the timing existed only in the browser. So the proof has to be that it survives
// the round trip: POST /api/chat, then GET the conversation back and find the number there.
const FAKE_CLAUDE = `#!/usr/bin/env node
let s=''; process.stdin.on('data',d=>s+=d).on('end',()=>{
  setTimeout(()=>{ process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'ANSWERED',session_id:'sid-1'})+'\\n'); }, 120);
});
`;
let port, root, web;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1 } });
  const bin = path.join(root, 'fake-claude.mjs');
  fs.writeFileSync(bin, FAKE_CLAUDE); fs.chmodSync(bin, 0o755);
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = bin;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); });

test('END TO END: the duration is stored with the reply and survives reopening the chat', async () => {
  const res = await api(port, '/api/chat', { method: 'POST', body: JSON.stringify({ message: 'hi' }) });
  assert.equal(res.status, 200);
  const events = (await res.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const done = events.find((e) => e.type === 'done');
  assert.equal(done.text, 'ANSWERED', 'the stub agent really answered');
  const id = events.find((e) => e.type === 'convo').id;

  // Re-read the conversation the way reopening it does.
  const convo = await (await api(port, '/api/convos/' + id)).json();
  const reply = convo.messages.find((m) => m.role === 'md');
  assert.ok(reply, 'the reply is stored');
  assert.equal(typeof reply.ms, 'number', `the reply must carry its duration, got ${JSON.stringify(reply)}`);
  assert.ok(reply.ms >= 100, `measured from the send, not the save: ${reply.ms}ms`);
  assert.ok(reply.ms < 60000, `sanity: ${reply.ms}ms`);
  // And it renders as a real took line rather than nothing.
  const el = mkEl();
  assert.ok(shellApi.addTook(el, reply.ms), 'the stored value renders');
  assert.match(el.kids[0].textContent, /^took \d+\.\ds$/, el.kids[0].textContent);
});

// Owner 2026-11-12: a ChatGPT pick in a confined app runs on Claude, and the answer never said so.
// The line under each answer now names the model that ACTUALLY answered (server 'done'.by / stored by).
test('the took line names the model that actually answered', () => {
  const el = { children: [], appendChild(c) { this.children.push(c); } };
  assert.equal(shellApi.addTook(el, 4700, 'Claude').textContent, 'Claude · took 4.7s');
  assert.equal(shellApi.addTook(el, 4700).textContent, 'took 4.7s', 'an old stored turn without by is unchanged');
  const WEB = fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8');
  assert.match(WEB, /const by = ml\.blocked && !\(edit && edit\.scoped\) \? '' : chosen \? \(chosen\.label \|\| 'Claude'\) : 'Claude';/, 'by is the lane that answered, after any reroute or fallback (none when no plain lane existed for a member, F4-2)');
  assert.match(WEB, /role: 'md', text: r\.text \|\| '', \.\.\.\(r\.ok === false \? \{\} : \{ ms: turnMs \}\), by,/, 'by is stored with the answer');
  assert.match(WEB, /type: 'done', ok: r\.ok, [^\n]*, by \}/, 'by is sent with done');
  assert.match(CHAT, /if\(ev\.type==='done'&&typeof ev\.by==='string'\) _doneBy=ev\.by;/, 'PAChat reads it from done');
  assert.match(CHAT, /_addTook\(thinking,Date\.now\(\)-sendTime,_doneBy\)/, 'PAChat shows it live');
});
