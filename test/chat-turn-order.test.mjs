// One turn at a time per conversation · 同一对话按顺序执行 (lib/convo-lock.mjs)
//
// THE BUG (measured 2026-11-13 on a throwaway node, report scenario A/B): a follow-up sent into a
// conversation whose turn was still running ran AT ONCE beside it. It had no session to resume,
// and whichever turn finished last saved its own copy of the conversation over the other — the
// follow-up's message and reply were lost, and the slow first run overwrote the follow-up's app.
//
// END TO END (R6): the real web.mjs on an ephemeral port with a FAKE `claude` that records each
// spawn (argv, stdin, its session id) and its finish. Controls (R14): two DIFFERENT conversations
// still overlap, so the ordering asserted below is the lock's doing, not a slow harness.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { APP_ORIGIN_HEADER, APP_ORIGIN_VALUE } from '../lib/agent-origin.mjs';
import { QUEUED_TURN_TEXT } from '../lib/convo-lock.mjs';

const APP = 'journal';
const APP_HDR = { [APP_ORIGIN_HEADER]: APP_ORIGIN_VALUE };
// FAKE-SLOW <ms>: answer after <ms>. FAKE-FAIL: print an error and exit 1 (a failed turn).
// Only the CURRENT message instructs it (the history block replays old turns), as for the real CLI.
const fakeClaude = (log) => `#!/usr/bin/env node
import fs from 'node:fs'; import crypto from 'node:crypto';
const rec = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ t: Date.now(), ...o }) + '\\n');
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const argv = process.argv.slice(2), sid = crypto.randomUUID();
  const cur = s.includes('[Current message:]') ? s.slice(s.lastIndexOf('[Current message:]')) : s;
  const resume = argv.includes('--resume') ? argv[argv.indexOf('--resume') + 1] : null;
  rec({ ev: 'spawn', sid, resume, cur });
  if (cur.includes('FAKE-FAIL')) { rec({ ev: 'finished', sid, cur }); process.stderr.write('boom\\n'); process.exitCode = 1; return; }
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }) + '\\n');
  const slow = /FAKE-SLOW (\\d+)/.exec(cur);
  setTimeout(() => {
    rec({ ev: 'finished', sid, cur });
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ANSWERED ' + sid, session_id: sid }) + '\\n');
  }, slow ? Number(slow[1]) : 0);
});
`;

let port, root, web, log, ollama, seq = 0;
const panelAnswered = [];   // when the fake Ollama answered the Verify panel
before(async () => {
  port = await freePort();
  // A fake Ollama for the Verify panel's one model: it answers after 300 ms, in Ollama's NDJSON shape.
  ollama = http.createServer((req, res) => setTimeout(() => panelAnswered.push(Date.now()) && res.end(JSON.stringify({ message: { content: 'panel says yes' }, done: true }) + '\n'), 300));
  await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, max_concurrent: 4, assess_models: ['glm'],
    ollama_url: `http://127.0.0.1:${ollama.address().port}` } });
  log = path.join(root, 'spawns.jsonl');
  const bin = path.join(root, 'fakebin');
  fs.mkdirSync(bin);
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = writeFakeCli(bin, 'claude', fakeClaude(log));
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  web = startWeb(root);
  await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); ollama?.close(); if (root) rmTemp(root); });

const tag = (name) => `T-${name}-${++seq}-${Date.now()}`;
const records = (t, ev) => {
  let txt = ''; try { txt = fs.readFileSync(log, 'utf8'); } catch { /* nothing spawned yet — an empty list, asserted on by callers */ }
  return txt.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.ev === ev && r.cur.includes(t));
};

// One /api/chat request; resolves with every NDJSON event once the stream ends.
async function turn(body) {
  const res = await api(port, '/api/chat', { method: 'POST',
    headers: { authorization: `Bearer ${OWNER_TOKEN}`, ...APP_HDR }, body: JSON.stringify({ app: APP, ...body }) });
  assert.equal(res.status, 200);
  const txt = await res.text();
  return txt.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}
const convoOf = (events) => events.find((e) => e.type === 'convo').id;
const stored = async (id) => (await api(port, `/api/convos/${id}`)).json();

test('two back-to-back turns in ONE conversation: the second waits, resumes the first\'s session, and all 4 messages are stored in order', async () => {
  const a = tag('a'), b = tag('b');
  const first = await turn({ message: `make a counter app FAKE-SLOW 50 ${a}` });
  const id = convoOf(first);
  // Now the real race: turn 1 runs slow, turn 2 goes in 100 ms later with the same id.
  const one = turn({ message: `again FAKE-SLOW 1500 ${a}-2`, convoId: id });
  await new Promise((r) => setTimeout(r, 100));
  const two = turn({ message: `add reset, big and blue ${b}`, convoId: id });
  const [ev1, ev2] = await Promise.all([one, two]);
  assert.equal(convoOf(ev2), id, 'the follow-up stayed in the same conversation');
  assert.ok(ev2.some((e) => e.type === 'status' && e.text === QUEUED_TURN_TEXT), `the follow-up said it was queued: ${JSON.stringify(ev2)}`);
  assert.ok(!ev1.some((e) => e.type === 'status' && e.text === QUEUED_TURN_TEXT), 'CONTROL: the running turn was not queued');
  const [f1] = records(`${a}-2`, 'finished');
  const [s2] = records(b, 'spawn');
  assert.ok(f1 && s2, 'both turns ran');
  assert.ok(s2.t >= f1.t, `the follow-up started only after the running turn finished (${s2.t} vs ${f1.t})`);
  assert.equal(s2.resume, f1.sid, 'and it resumed the session the running turn produced');
  const c = await stored(id);
  const texts = c.messages.map((m) => m.text);
  assert.equal(c.messages.length, 6, `every message is kept: ${JSON.stringify(texts)}`);
  assert.deepEqual(c.messages.slice(2).map((m) => m.role), ['me', 'md', 'me', 'md'], 'question, answer, question, answer');
  assert.match(texts[2], new RegExp(`${a}-2`)); assert.equal(texts[3], `ANSWERED ${f1.sid}`);
  assert.match(texts[4], new RegExp(b)); assert.equal(texts[5], `ANSWERED ${s2.sid}`);
  assert.equal(c.sessionId, s2.sid, 'the newest session is the conversation\'s');
});

test('a follow-up to a NEW conversation (id learned from the convo line) queues behind the turn that created it', async () => {
  const a = tag('new'), b = tag('new-b');
  const res = await api(port, '/api/chat', { method: 'POST',
    headers: { authorization: `Bearer ${OWNER_TOKEN}`, ...APP_HDR }, body: JSON.stringify({ app: APP, message: `first FAKE-SLOW 1000 ${a}` }) });
  const reader = res.body.getReader();
  let buf = '';
  while (!buf.includes('\n')) buf += new TextDecoder().decode((await reader.read()).value);
  const id = JSON.parse(buf.slice(0, buf.indexOf('\n'))).id;
  const ev2 = await turn({ message: `follow ${b}`, convoId: id });
  while (!(await reader.read()).done) { /* drain the first stream to its end */ }
  assert.ok(ev2.some((e) => e.type === 'status' && e.text === QUEUED_TURN_TEXT), 'queued behind the creating turn');
  assert.equal(records(b, 'spawn')[0].resume, records(a, 'finished')[0].sid, 'resumed the creating turn\'s session');
  assert.equal((await stored(id)).messages.length, 4);
});

test('a FAILING first turn releases the lock: the next turn in that conversation still runs', async () => {
  const a = tag('fail'), b = tag('after');
  const first = await turn({ message: `start ${a}-0` });
  const id = convoOf(first);
  const one = turn({ message: `FAKE-FAIL ${a}`, convoId: id });
  await new Promise((r) => setTimeout(r, 50));
  const ev2 = await turn({ message: `next FAKE-SLOW 10 ${b}`, convoId: id });
  await one;
  assert.ok(ev2.some((e) => e.type === 'done'), `the turn after a failure finished: ${JSON.stringify(ev2)}`);
  assert.equal(records(b, 'spawn').length, 1);
  assert.equal((await stored(id)).messages.length, 6, 'the failed turn and the next one are both kept');
});

test('CONTROL: two DIFFERENT conversations run concurrently — neither waits for the other', async () => {
  const a = tag('p1'), b = tag('p2');
  const [c1, c2] = await Promise.all([turn({ message: `x seed-${seq}a` }), turn({ message: `y seed-${seq}b` })]);
  const [e1, e2] = await Promise.all([
    turn({ message: `FAKE-SLOW 800 ${a}`, convoId: convoOf(c1) }),
    turn({ message: `FAKE-SLOW 800 ${b}`, convoId: convoOf(c2) })]);
  for (const ev of [e1, e2]) assert.ok(!ev.some((e) => e.text === QUEUED_TURN_TEXT), 'no queue across conversations');
  const s1 = records(a, 'spawn')[0], s2 = records(b, 'spawn')[0], f1 = records(a, 'finished')[0], f2 = records(b, 'finished')[0];
  assert.ok(s2.t < f1.t && s1.t < f2.t, 'the two runs overlapped in time');
});

test('a Verify verdict that lands DURING the next turn is kept: its save waits for the lock and reloads', async () => {
  const a = tag('verify'), b = tag('verify-next');
  const ev1 = await turn({ message: `question ${a}`, assess: true });
  const id = convoOf(ev1), aid = ev1.find((e) => e.type === 'assess').aid;
  // The panel's fake Ollama answers in 300 ms; this turn holds the conversation for 1500 ms.
  const ev2 = await turn({ message: `FAKE-SLOW 1500 ${b}`, convoId: id });
  assert.ok(ev2.some((e) => e.type === 'done'));
  const [f2] = records(b, 'finished');
  assert.ok(panelAnswered.length && panelAnswered.at(-1) < f2.t, 'CONTROL: the verdict arrived while the next turn was still running');
  const until = Date.now() + 10000;
  let m;
  do { m = (await stored(id)).messages.find((x) => x.aid === aid); if (m?.assess && m.assess.state !== 'pending' && m.assess.state !== 'started') break; await new Promise((r) => setTimeout(r, 100)); } while (Date.now() < until);
  assert.equal(m?.assess?.state, 'done', `the verdict survived the turn that ran while it was saved: ${JSON.stringify(m?.assess)}`);
  assert.equal((await stored(id)).messages.length, 4, 'and the newer turn survived too');
});

test('a QUEUED oneShot whose caller left before the lock freed never saves or spawns', async () => {
  const a = tag('hold'), b = tag('gone'), s0 = tag('seed');
  const id = convoOf(await turn({ message: `seed ${s0}` }));
  const one = turn({ message: `FAKE-SLOW 1200 ${a}`, convoId: id });
  await new Promise((r) => setTimeout(r, 100));
  const ac = new AbortController();
  const res = await api(port, '/api/chat', { method: 'POST', signal: ac.signal,
    headers: { authorization: `Bearer ${OWNER_TOKEN}`, ...APP_HDR }, body: JSON.stringify({ app: APP, oneShot: true, convoId: id, message: `short ${b}` }) });
  const reader = res.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /Queued/, 'it was queued');
  ac.abort();
  await one;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(records(b, 'spawn').length, 0, 'the abandoned oneShot never spawned');
  assert.ok(!(await stored(id)).messages.some((m) => m.text.includes(b)), 'and its message was never saved');
  assert.equal(records(a, 'spawn').length, 1, 'CONTROL: the running turn did run');
});
