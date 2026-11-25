// oneShot + chat-cancel — the CLIENT half: PAChat.complete and the shell's chat relay.
//
// SCAR (measured 2026-10-12, real CLI): the Journal's "AI设计 · Design with AI" went through
// PAChat.complete → the shell's chat relay → /api/chat → `claude -p --model sonnet`. With extended
// thinking on, Sonnet drafted the whole SVG inside its thinking, hit the 32,000-token output cap
// with no text and never answered (4 runs of 4). The studio gave up after 5 minutes with a
// Promise.race that cancelled nothing, the shell never aborted its fetch, and retries piled up
// three concurrent claude processes. The pieces pinned here:
//   * PAChat.complete marks its one request oneShot:true (the server then answers without
//     thinking) and, when its caller's AbortSignal fires, sends ONE chat-cancel naming it;
//   * the shell forwards oneShot only as the literal true, and chat-cancel aborts THAT relay's
//     fetch — the connection close is what the server kills the job on;
//   * the composer (a conversation, not a component's answer) never sends oneShot (control).
// FIDELITY (R14): the shell's api(), RELAY-CORE (with the app-origin helper) and whole broker
// block are EXTRACTED from the shell as served and RUN (test/helpers-shell-broker.mjs); PAChat runs through loadComplete (its own
// broker head + complete()). The far end is a real node:http server, so "the server saw the
// connection close" is a socket event, not a flag the harness sets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, loadComplete } from './helpers-stationery.mjs';
import { SHELL, loadShellBroker } from './helpers-shell-broker.mjs';

const CHAT = fs.readFileSync(path.join(ROOT, 'web', 'chat-ui.inline.html'), 'utf8');
const T = { timeout: 15000 };   // a relay that never ends must fail this file, not hang it
const until = async (pred, what, ms = 5000) => { const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 5)); } };
const within = (p, what, ms = 5000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms))]);

// /api/chat as the shape web.mjs streams: NDJSON, a convo line first. The message picks a script:
// 'hold…' streams the convo line and waits for finish(); 'hold-headers' never answers at all;
// 'drop' destroys the socket mid-stream (a dead connection that NOBODY cancelled); else answers.
async function withShell(fn) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const hit = { body: JSON.parse(raw || '{}'), headers: req.headers, closedEarly: false };
      seen.push(hit);
      res.on('close', () => { hit.closedEarly = !res.writableEnded; });
      const msg = String(hit.body.message);
      if (msg === 'hold-headers') return;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ type: 'convo', id: 'cv-' + msg }) + '\n');
      if (msg === 'drop') { req.socket.destroy(); return; }
      const finish = () => res.end(JSON.stringify({ type: 'done', ok: true, text: 'answer to ' + msg }) + '\n');
      if (msg.startsWith('hold')) hit.finish = finish; else finish();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try { await fn({ B: loadShellBroker(base), seen }); } finally { srv.closeAllConnections(); srv.close(); }
}
const NETWORK_SENTENCE = /Connection failed|连接失败|never left this device|network unreachable/;

// ── (1) the shell forwards oneShot only as the literal true ─────────────────────────────────
test('the chat relay forwards oneShot ONLY as the literal true — any other value never reaches the server', T, async () => {
  await withShell(async ({ B, seen }) => {
    const cases = [[true, true], ['true', undefined], [1, undefined], [{}, undefined], [false, undefined], [undefined, undefined]];
    for (const [i, [given, want]] of cases.entries()) {
      await within(B.post({ id: 'p' + i, kind: 'chat', message: 'quick', oneShot: given }), `relay ${i}`);
      const body = seen.at(-1).body;
      assert.equal(body.oneShot, want, `oneShot:${JSON.stringify(given)} must arrive as ${want}`);
      if (want === undefined) assert.ok(!('oneShot' in body), `oneShot:${JSON.stringify(given)} sends no key at all`);
      assert.ok(B.done('p' + i) && B.done('p' + i).ok !== false, `CONTROL: relay ${i} completed normally`);
    }
    assert.equal(seen.length, cases.length, 'CONTROL: every case really reached the server');
    assert.equal(seen[0].headers['x-superelf-origin'], 'app', 'CONTROL: through the app-origin helper, as production sends it');
    assert.equal(seen[0].body.app, 'journal');
  });
});

// ── (2) chat-cancel stops the right relay, and says so ──────────────────────────────────────
test('chat-cancel aborts the RIGHT in-flight fetch: the server sees that connection close, the chat ends "cancelled"', T, async () => {
  await withShell(async ({ B, seen }) => {
    const a = B.post({ id: 'pac1', kind: 'chat', message: 'hold-a', oneShot: true });
    const b = B.post({ id: 'pac2', kind: 'chat', message: 'hold-b', oneShot: true });
    await until(() => ['pac1', 'pac2'].every((id) => B.out.some((x) => x.id === id && x.ev && x.ev.type === 'convo')), 'both relays streaming');
    const [hitA, hitB] = ['hold-a', 'hold-b'].map((msg) => seen.find((h) => h.body.message === msg));
    // Two cancels back to back, the second BEFORE the aborted relay has wound down: it must still
    // report that nothing was left to cancel (harmless and idempotent, like notify-cancel).
    const c1 = B.post({ id: 'pac3', kind: 'chat-cancel', chatId: 'pac1' });
    const c2 = B.post({ id: 'pac4', kind: 'chat-cancel', chatId: 'pac1' });
    await within(Promise.all([c1, c2]), 'the cancels');
    assert.deepEqual(B.reply('pac3'), { pa: 'res', id: 'pac3', ok: true, chatId: 'pac1', cancelled: true });
    assert.deepEqual(B.reply('pac4'), { pa: 'res', id: 'pac4', ok: true, chatId: 'pac1', cancelled: false });
    await within(a, 'the cancelled relay ends');
    await until(() => hitA.closedEarly, 'the server to see A close');
    const doneA = B.done('pac1');
    assert.equal(doneA.ok, false);
    assert.equal(doneA.code, 'cancelled');
    assert.equal(doneA.error, '已取消 · Cancelled');
    assert.doesNotMatch(B.said('pac1'), NETWORK_SENTENCE, 'a Cancel is never reported as a broken connection');
    // A cancel of an id that was never sent is the same harmless no-op.
    await B.post({ id: 'pac5', kind: 'chat-cancel', chatId: 'pac99' });
    assert.equal(B.reply('pac5').cancelled, false);
    // CONTROL: the other relay was untouched and still finishes with its answer…
    assert.equal(hitB.closedEarly, false, 'B is still open');
    hitB.finish(); await within(b, 'B ends');
    assert.equal(B.done('pac2').ok, undefined, 'B ended as a success');
    assert.match(B.said('pac2'), /answer to hold-b/);
    // …and a relay that ended by itself is no longer cancellable.
    await B.post({ id: 'pac6', kind: 'chat-cancel', chatId: 'pac2' });
    assert.equal(B.reply('pac6').cancelled, false);
    // A cancel that names nothing is refused with a code, rendered like every broker failure.
    await B.post({ id: 'pac7', kind: 'chat-cancel' });
    assert.equal(B.reply('pac7').code, 'bad-request');
    assert.equal(typeof B.reply('pac7').text, 'string');
  });
});

test('a cancel that lands before the server has answered at all also ends "cancelled", and closes the request', T, async () => {
  await withShell(async ({ B, seen }) => {
    const a = B.post({ id: 'pac1', kind: 'chat', message: 'hold-headers', oneShot: true });
    await until(() => seen.length === 1, 'the request to reach the server');
    await B.post({ id: 'pac2', kind: 'chat-cancel', chatId: 'pac1' });
    assert.equal(B.reply('pac2').cancelled, true);
    await within(a, 'the relay ends');
    await until(() => seen[0].closedEarly, 'the server to see the close');
    assert.equal(B.done('pac1').code, 'cancelled');
    assert.doesNotMatch(B.said('pac1'), NETWORK_SENTENCE);
  });
});

test('CONTROL: a connection that dies with NOBODY cancelling is still "network" — cancelled is not a catch-all', T, async () => {
  await withShell(async ({ B }) => {
    await within(B.post({ id: 'pac1', kind: 'chat', message: 'drop', oneShot: true }), 'the dropped relay ends');
    assert.equal(B.done('pac1').code, 'network');
    assert.match(B.said('pac1'), NETWORK_SENTENCE);
  });
});

// ── (3) PAChat.complete, end to end over the real broker ────────────────────────────────────
const keys = (r) => Object.keys(r).sort().join(',');
const SHAPE = 'convoId,error,ok,text';

test('PAChat.complete over the REAL broker: oneShot sent, ONE chat-cancel on abort, the server sees the close', T, async () => {
  await withShell(async ({ B, seen }) => {
    const { complete, posted } = loadComplete((m, reply) => B.route(m, reply));
    const ac = new AbortController();
    const p = complete('hold-design', { label: '信纸 · Stationery', signal: ac.signal });
    await until(() => B.out.some((x) => x.ev && x.ev.type === 'convo'), 'the answer to start streaming');
    assert.equal(posted[0].kind, 'chat');
    assert.equal(posted[0].oneShot, true, 'complete() always marks its request one-shot');
    assert.equal(seen[0].body.oneShot, true, 'and the shell carried it to the server');
    ac.abort(); ac.abort();
    const r = await within(p, 'complete() to answer the cancel');
    assert.deepEqual(r, { ok: false, text: '', error: '已取消 · Cancelled', convoId: 'cv-hold-design' });
    assert.equal(keys(r), SHAPE, 'exactly the four fields');
    const cancels = posted.filter((m) => m.kind === 'chat-cancel');
    assert.equal(cancels.length, 1, 'exactly one chat-cancel, however often the signal is poked');
    assert.equal(cancels[0].chatId, posted[0].id, 'naming THIS request by its broker id');
    assert.notEqual(cancels[0].id, posted[0].id, 'while carrying an id of its own');
    await until(() => seen[0].closedEarly, 'the server to see the connection close');
    await until(() => B.reply(cancels[0].id), 'the shell to answer the cancel');
    assert.equal(B.reply(cancels[0].id).cancelled, true);
    assert.equal(B.done(posted[0].id).error, r.error, 'R3: the shell and the component say the same words');
  });
});

test('PAChat.complete with an ALREADY-aborted signal posts nothing and answers the four fields', T, async () => {
  const { complete, posted } = loadComplete(() => {});   // a shell that never answers: only `posted` matters
  const ac = new AbortController(); ac.abort();
  const r = await within(complete('design it', { signal: ac.signal }), 'complete() to answer without the shell', 1000);
  assert.deepEqual(r, { ok: false, text: '', error: '已取消 · Cancelled', convoId: null });
  assert.equal(posted.length, 0, 'no chat — a job that is cancelled on arrival still starts claude');
});

test('PAChat.complete answers an abort AT ONCE, even from a shell that never winds the relay down', T, async () => {
  // A shell with no chat-cancel (or a relay stuck before its first byte) must not keep the
  // caller's busy state alive: the studio's Cancel ends the wait, not the relay.
  const { complete, posted } = loadComplete((m, send) => { if (m.kind === 'chat') send({ ev: { type: 'convo', id: 'cv1' } }); });
  const ac = new AbortController();
  const p = complete('hold', { signal: ac.signal });
  await until(() => posted.length === 1, 'the chat to be posted');
  await new Promise((r) => setTimeout(r, 0));
  ac.abort();
  assert.deepEqual(await within(p, 'complete() to answer the abort', 1000), { ok: false, text: '', error: '已取消 · Cancelled', convoId: 'cv1' });
  assert.deepEqual(posted.map((m) => m.kind), ['chat', 'chat-cancel']);
});

test('PAChat.complete: an answer that arrived is kept; aborting AFTERWARDS posts no cancel (control)', T, async () => {
  await withShell(async ({ B }) => {
    const { complete, posted } = loadComplete((m, reply) => B.route(m, reply));
    const ac = new AbortController();
    const r = await within(complete('quick', { signal: ac.signal }), 'the answer');
    assert.deepEqual(r, { ok: true, text: 'answer to quick', error: '', convoId: 'cv-quick' });
    ac.abort(); await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(posted.map((m) => m.kind), ['chat'], 'a finished request is never cancelled after the fact');
    // Without a signal at all, complete() is still one-shot and still answers the same shape.
    const r2 = await within(complete('quick'), 'the unsignalled answer');
    assert.equal(keys(r2), SHAPE);
    assert.equal(posted.at(-1).oneShot, true);
  });
});

// ── (4) CONTROL: the composer is a conversation — it never sends oneShot ───────────────────
test('CONTROL: the interactive composer\'s own reqChat call never marks oneShot', async () => {
  // The call's tail since the summary-images merge: assess, oneShot and onId are passed as explicit
  // `undefined` so the per-turn `model` (the 10th argument) can follow them. oneShot is STILL never
  // a value here — that is what this control pins.
  const a = CHAT.indexOf('const r=await reqChat(msg,'), end = '}, attRefs, lbl, sys, verifyOn, undefined, undefined, (o&&o.model)||undefined)';
  const b = CHAT.indexOf(end, a);
  assert.ok(a > 0 && b > a, "the composer's reqChat call is findable in send()");
  const call = CHAT.slice(a + 'const r=await '.length, b + end.length);
  const head = CHAT.slice(CHAT.indexOf('  let _cid=0;'), CHAT.indexOf('  /* ── Size limits'));
  assert.ok(head.includes('const reqChat='), 'the broker head is findable');
  const posted = [];
  const window = { addEventListener: () => {} };
  const parent = { postMessage: (m) => posted.push(m) };
  // eslint-disable-next-line no-new-func
  // The shell has pushed its model list (no lane chosen yet): a composer turn waits for that list
  // (chat-empty-lane.test.mjs), and this control is about the call's shape, not that wait.
  const run = new Function('window', 'parent', `${head}\nPAC_MODELS.push({ id: 'lane' });\nreturn (msg,cid,attRefs,lbl,sys,verifyOn,o)=>${call};`)(window, parent);
  run('hello', 'c1', [], 'Notes', undefined, false, undefined);
  assert.equal(posted.length, 1, 'CONTROL: the shipped call really posted');
  assert.equal(posted[0].kind, 'chat');
  assert.equal(posted[0].message, 'hello');
  assert.ok(!('oneShot' in posted[0]) || posted[0].oneShot === undefined, 'a conversation turn is never one-shot');
  assert.ok(!('model' in posted[0]) || posted[0].model === undefined, 'and with no host options the chooser\'s lane is used, not a pinned one');
});

// ── R3: one sentence, three runtimes ───────────────────────────────────────────────────────
// The shell, PAChat and the server (which STORES it as the cancelled turn's reply) cannot import
// one another — this test is the link. The studio's copy is pinned to PAC_CANCELLED in
// test/stationery-flow.test.mjs.
test('R3: the shell, PAChat and the server declare the cancelled sentence once each, identically', () => {
  const WEB = fs.readFileSync(path.join(ROOT, 'lib', 'turn-stop.mjs'), 'utf8');   // the server's one copy (web.mjs and the app-edit lane import it)
  const shell = [...SHELL.matchAll(/const RELAY_CANCELLED='([^']+)'/g)], pac = [...CHAT.matchAll(/const PAC_CANCELLED='([^']+)'/g)];
  const server = [...WEB.matchAll(/export const CANCELLED_TEXT = '([^']+)';/g)];
  assert.equal(shell.length, 1); assert.equal(pac.length, 1); assert.equal(server.length, 1);
  assert.equal(shell[0][1], pac[0][1], 'shell == PAChat');
  assert.equal(server[0][1], pac[0][1], 'server == PAChat: what is stored is what the page said');
  assert.match(shell[0][1], /[A-Za-z]/); assert.match(shell[0][1], /[一-鿿]/);
});
