// Leaving an app keeps its last save · 离开应用不丢最后一次保存 (docs/adr/0018).
//
// SCAR (measured 2026-10-13, Chrome and WebKit): a stroke drawn in Notes less than 700 ms before
// "← Home" was lost. goHome blanked the frame first, so the pad's pagehide save came from a page the
// shell no longer served. Chrome delivered it with e.source null and the broker dropped it. WebKit
// delivered it from a frame that no longer named the app; the broker then had no slug, and before
// 2bbb18f wrote it at the WORKSPACE ROOT.
//
// Now the shell holds the leaving page (web/app-frame.js), PALeave runs its pagehide handlers while
// it is still served (web/leave.inline.html, pinned by test/leave.test.mjs), and the broker serves
// each page as itself. Pinned here: the shell's broker and app-frame block, extracted as served,
// against a real web.mjs — a save after leaving lands in the app's folder (CONTROL: the old order
// loses it, in both engines' ways); replies reach only the page that asked; the hold ends on the
// rules the ADR states; a page with no slug gets every kind refused before the network — and the
// real openApp and goHome on the shell's own markup.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { ROOT } from './helpers-app.mjs';
import { SHELL, loadShellBroker, appFrameConstant as constant, repliedTo as replyTo } from './helpers-shell-broker.mjs';
import { fakeClock } from './helpers-sandbox-app.mjs';
import { runShellNav } from './helpers-shell-dom.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

// ── The shell: its broker and app-frame block, as served, against a real web.mjs ────────────────
let port, root, web, base;
before(async () => { port = await freePort(); root = mkWebRoot({ port }); web = startWeb(root); await waitReady(port); base = `http://127.0.0.1:${port}`; });
after(async () => { await stopWeb(web); rmTemp(root); });
const ws = (rel) => path.join(root, 'workspace', rel);
const readOr = (rel) => { try { return fs.readFileSync(ws(rel), 'utf8'); } catch { return null; /* absent: compared as null */ } };
// Every .json under workspace/ that is not app data in its own folder: where a lost slug would scatter.
// Spelled with '/' whatever the OS: readdirSync joins with path.sep, and 'data\\notes' is app data too.
const scatter = () => fs.readdirSync(ws(''), { recursive: true }).map((f) => f.split(path.sep).join('/')).filter((f) => f.endsWith('.json') && !f.startsWith('data/'));
const ACK = constant('APP_LEAVE_ACK_MS'), QUIET = constant('APP_LEAVE_QUIET_MS'), MAX = constant('APP_LEAVE_MAX_MS');
const SAVE = (id) => ({ pa: 'req', id, kind: 'save-data', path: 'entry.json', data: '{}' });
const NO_APP = '请求被拒绝 · Rejected — 未打开应用 · no app in view。';
const broker = (app, { clock = fakeClock() } = {}) => loadShellBroker(base, { token: OWNER_TOKEN, app, timers: clock });
// PALeave's hello, which every app page sends as it runs: until then the page has run none of its
// own code, and leaving removes it at once instead of holding it (pinned below). Nothing else: the
// USER FLOW below is an app that never posts until its pagehide save, and that save must land.
const booted = (B, el = B.live()) => B.deliver(el.win, { pa: 'here' });

test('USER FLOW: a save the page posts after ← Home lands in its own folder, and its reply reaches that page only', async () => {
  const B = broker('notes');
  const notes = B.live();
  const before = scatter();
  await booted(B);
  B.leave();
  // The page is held, not blanked: hidden, out of the #fr role, still at its URL (not reloaded).
  assert.equal(notes.id, '', 'the leaving page no longer answers to #fr');
  assert.equal(notes.style.display, 'none');
  assert.match(notes.src, /\/app\/u1\/notes\/$/, 'and was not navigated');
  assert.deepEqual(notes.got.filter((x) => x.pa !== 'res'), [{ pa: 'leaving' }], 'it was told it is leaving');
  const fresh = B.live();
  assert.notEqual(fresh, notes, 'a fresh frame took #fr');
  assert.equal(fresh.srcAtInsert, 'about:blank', 'blank BEFORE it was inserted, so it never starts loading the app again');
  // PALeave runs the pad's pagehide handler now; its save arrives from the held page.
  await B.post({ id: 1, kind: 'save-data', path: 'entry-x.json', data: '{"strokes":2}' }, notes);
  assert.equal(replyTo(notes, 1)?.ok, true, B.said(1));
  assert.equal(readOr('data/notes/entry-x.json'), '{"strokes":2}', 'the stroke landed in data/notes/');
  // The next app opens in the fresh frame while the old page is still held: each is filed as itself.
  fresh.src = `${base}/app/u1/bible/`;
  await B.post({ id: 1, kind: 'save-data', path: 'entry-x.json', data: '{"bible":1}' });
  assert.equal(replyTo(fresh, 1)?.ok, true, B.said(1));
  assert.equal(readOr('data/bible/entry-x.json'), '{"bible":1}', 'the next app writes its own folder');
  assert.equal(readOr('data/notes/entry-x.json'), '{"strokes":2}', 'and not the one the held page writes');
  const replies = (el) => el.got.filter((x) => x.pa === 'res' && x.id === 1).length;
  assert.equal(replies(notes), 1, 'the held page got its own reply only');
  assert.equal(replies(fresh), 1, 'and the next app its own only, though both used id 1');
  assert.deepEqual(scatter(), before, 'nothing outside data/<slug>/');
});

test('CONTROL (R14): in the old order — the frame blanked first — that save is refused (WebKit) or dropped (Chrome)', async () => {
  const B = broker('notes');
  const notes = B.live();
  const before = scatter();
  notes.src = 'about:blank';   // what goHome did before ADR 0018, on the same element
  // WebKit: the gone page's message still carries the frame's window, and the frame names no app.
  await B.post({ id: 1, kind: 'save-data', path: 'entry-y.json', data: '{"strokes":2}' }, notes);
  assert.equal(replyTo(notes, 1)?.text, NO_APP, B.said(1));
  // Chrome: the same message arrives with e.source null.
  await B.deliver(null, { pa: 'req', id: 2, kind: 'save-data', path: 'entry-y.json', data: '{"strokes":2}' });
  assert.equal(B.said(2), '', 'no reply: there is no page to answer');
  assert.equal(readOr('data/notes/entry-y.json'), null, 'the stroke is lost either way — the bug this file pins');
  assert.deepEqual(scatter(), before, 'and, since 2bbb18f, not scattered');
});

test('the hold ends only when the page has answered and has had nothing in flight for APP_LEAVE_QUIET_MS', async () => {
  const clock = fakeClock();
  const B = broker('notes', { clock });
  const notes = B.live();
  await booted(B);
  B.leave();
  clock.advance(ACK - 1);
  assert.equal(B.held.size, 1, 'still held: no answer yet');
  await B.deliver(notes.win, { pa: 'left' });
  clock.advance(QUIET - 1);
  assert.equal(B.held.size, 1, 'still held: not quiet for long enough');
  // A save that waits for the reply to the one before it (Notes: the entry, then the index).
  const inFlight = B.post({ id: 7, kind: 'save-data', path: 'journal.json', data: '{"entries":[]}' }, notes);
  clock.advance(QUIET * 10);
  assert.equal(B.held.size, 1, 'never removed while a request is in flight');
  await inFlight;
  assert.equal(readOr('data/notes/journal.json'), '{"entries":[]}');
  clock.advance(QUIET - 1);
  assert.equal(B.held.size, 1, 'the quiet starts again from the reply');
  clock.advance(1);
  assert.equal(B.held.size, 0, 'then the page is removed');
  assert.equal(notes.removed, true);
  // What the removed page posts while it unloads is nobody's: WebKit (its old window) and Chrome (null).
  const before = scatter();
  await B.deliver(notes.win, SAVE(8));
  await B.deliver(null, SAVE(9));
  assert.equal(B.said(8) + B.said(9), '', 'no reply to either');
  assert.equal(readOr('data/notes/entry.json'), null, 'nothing written for the removed page');
  assert.deepEqual(scatter(), before, 'nor anywhere else');
  assert.equal(B.live().got.length, 0, 'and nothing reached the frame in #fr');
});

test('a page that never answers is removed after APP_LEAVE_ACK_MS + APP_LEAVE_QUIET_MS', async () => {
  const clock = fakeClock();
  const B = broker('notes', { clock });
  await booted(B);
  B.leave();
  clock.advance(ACK);                 // no answer by now: treated as answered, and the quiet starts
  assert.equal(B.held.size, 1);
  clock.advance(QUIET - 1);
  assert.equal(B.held.size, 1);
  clock.advance(1);
  assert.equal(B.held.size, 0);
});

test('a page with a request that never comes back is removed after APP_LEAVE_MAX_MS', async () => {
  const hang = http.createServer(() => { /* never answers: the request stays in flight */ });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  try {
    const clock = fakeClock();
    const B = loadShellBroker(`http://127.0.0.1:${hang.address().port}`, { app: 'notes', timers: clock });
    const notes = B.live();
    await booted(B);
    B.leave();
    await B.deliver(notes.win, { pa: 'left' });
    B.post({ id: 1, kind: 'data', path: 'journal.json' }, notes);   // never settles
    await new Promise((r) => setTimeout(r, 50));   // the request reaches the server
    clock.advance(MAX - 1);
    assert.equal(B.held.size, 1, 'held while the request is in flight');
    clock.advance(1);
    assert.equal(B.held.size, 0, 'and removed at the cap');
  } finally { hang.closeAllConnections(); hang.close(); }
});

test('leaving with no app in #fr does nothing, and the fresh frame carries the old one\'s handlers', async () => {
  const blank = broker('');
  blank.leave();
  assert.equal(blank.frames.length, 1, 'no app: nothing held, no new frame');
  assert.equal(blank.held.size, 0);
  const B = broker('notes');
  const old = B.live();
  old.onload = () => 'onload'; old.onfocus = () => 'onfocus';
  await booted(B);
  B.leave();
  assert.deepEqual(B.frames.map((f) => f.id), ['fr', ''], 'the fresh frame goes in BEFORE the held one, which is not moved');
  assert.equal(B.live().onload, old.onload, 'the prefs push on load');
  assert.equal(B.live().onfocus, old.onfocus, 'the bar retracting on focus');
});

test('a page that has posted nothing, not even PALeave\'s hello, runs no code yet: leaving removes it at once', () => {
  const B = broker('notes');
  const loading = B.live();
  B.leave();
  assert.equal(loading.removed, true, 'its load is cancelled, as about:blank cancelled it');
  assert.equal(B.held.size, 0, 'not held');
  assert.equal(loading.got.length, 0, 'and not told it is leaving: nothing there can answer');
  assert.deepEqual(B.frames.map((f) => f.id), ['fr'], 'the fresh frame is in #fr on its own');
});

test('the hold\'s cap is PANote\'s own save deadline: a save still waiting then is given up on by the pad too', () => {
  const pad = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');
  const m = /const SAVE_TIMEOUT_MS=(\d+);/.exec(pad);
  assert.ok(m, "PANote's SAVE_TIMEOUT_MS is findable");
  assert.equal(MAX, Number(m[1]));
});

test('with no app slug, EVERY kind is refused in the shell\'s words, and none reaches the server', async () => {
  const hits = [];
  const srv = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const b = `http://127.0.0.1:${srv.address().port}`;
    const block = SHELL.slice(SHELL.indexOf('/* ── Broker (for sandboxed apps) ── */'), SHELL.indexOf('/* ── Chat log helpers ── */'));
    const kinds = [...new Set([...block.matchAll(/m\.kind==='([a-z-]+)'/g)].map((m) => m[1]))];
    assert.ok(kinds.length >= 30, `CONTROL: the broker's kinds are found (${kinds.length})`);
    const B = loadShellBroker(b, { app: '' });
    for (const kind of kinds) {
      await B.post({ id: kind, kind, path: 'x.json', data: '{}', message: 'hi', q: 'x', convoId: 'c', chatId: 1, tag: 't' });
      const r = B.reply(kind) || B.done(kind);
      assert.equal(r && r.ok, false, `${kind}: refused — ${B.said(kind)}`);
      assert.equal(r.text, NO_APP, `${kind}: in the shell's words`);
    }
    assert.deepEqual(hits, [], 'nothing reached the server');
    const C = loadShellBroker(b, { app: 'notes' });
    await C.post({ id: 1, kind: 'data', path: 'x.json' });
    assert.deepEqual(hits, ['/api/data/data/notes/x.json'], 'CONTROL: with a slug the same request goes out, namespaced');
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('a window that is neither #fr nor a held page gets nothing', async () => {
  const B = broker('notes');
  const stranger = { got: [], postMessage(m) { this.got.push(m); } };
  await B.deliver(stranger, SAVE(1));
  await B.deliver(null, SAVE(2));
  assert.deepEqual(stranger.got, []);
  assert.equal(B.out.length, 0);
});

test('USER FLOW (the shell\'s own markup): open Notes, ← Home, open Bible — Notes is held in place, then removed', () => {
  const s = runShellNav();
  const boots = (el) => { for (const fn of s.messages) fn({ source: el.contentWindow, data: { pa: 'here' } }); };   // PALeave ran
  s.openApp('u1', 'notes', 'Journal');
  const notes = s.byId('fr');
  boots(notes);
  s.goHome();
  const fresh = s.byId('fr');
  assert.notEqual(fresh, notes, 'Home put a fresh frame in #fr');
  assert.equal(fresh.srcAtInsert, 'about:blank', 'blank before it was inserted');
  assert.equal(notes.parent, fresh.parent, 'the held frame stays where it was: moving an iframe reloads it');
  assert.equal(fresh.parent.children.indexOf(fresh) + 1, fresh.parent.children.indexOf(notes), 'and the fresh one sits just before it');
  assert.equal(notes.style.display, 'none');
  assert.match(notes.src, /\/app\/u1\/notes\/$/, 'not navigated');
  assert.deepEqual(s.posted.map((p) => p.m), [{ pa: 'leaving' }], 'Notes was told it is leaving');
  s.openApp('u1', 'bible', 'Bible');
  assert.equal(s.byId('fr'), fresh, 'the next app loads into the fresh frame');
  assert.match(fresh.src, /\/app\/u1\/bible\/$/);
  assert.equal(s.held.size, 1, 'while Notes is still held');
  for (const fn of s.messages) fn({ source: notes.contentWindow, data: { pa: 'left' } });
  s.clock.advance(QUIET);
  assert.equal(s.held.size, 0);
  assert.equal(notes.parent, null, 'then Notes is removed from the page');
  boots(fresh);
  s.goHome();
  assert.deepEqual(fresh.posted.map((p) => p.m), [{ pa: 'leaving' }], 'and Home leaves Bible the same way');
});

test('a chat stream that outlives the leave keeps going to the page that asked, never to the next app', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const srv = http.createServer(async (req, res) => {
    if (req.url !== '/api/chat') { res.writeHead(404); res.end(); return; }
    req.resume();
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ type: 'delta', text: 'one' }) + '\n');
    await gate;   // the rest comes after the user has left and the next app has opened
    res.end(JSON.stringify({ type: 'delta', text: 'two' }) + '\n');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const b = `http://127.0.0.1:${srv.address().port}`;
    const B = loadShellBroker(b, { app: 'notes', timers: fakeClock() });
    const notes = B.live();
    const chat = B.post({ id: 'pac1', kind: 'chat', message: 'hi' });
    for (let i = 0; i < 300 && !notes.got.some((x) => x.ev); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(notes.got.some((x) => x.ev), 'CONTROL: the stream started before the leave');
    B.leave();
    const fresh = B.live();
    fresh.src = `${b}/app/u1/bible/`;
    release(); await chat;
    const of = (el) => el.got.filter((x) => x.id === 'pac1').map((x) => (x.done ? 'done' : x.ev.text));
    assert.deepEqual(of(notes), ['one', 'two', 'done'], 'the held page got the whole stream');
    assert.deepEqual(of(fresh), [], 'the next app, whose PAChat also counts from pac1, got none of it');
  } finally { srv.closeAllConnections(); srv.close(); }
});

test('the broker posts only to the window that asked: nothing goes to #fr by name', () => {
  const block = SHELL.slice(SHELL.indexOf('/* ── Broker (for sandboxed apps) ── */'), SHELL.indexOf('/* ── Chat log helpers ── */'));
  assert.equal((block.match(/\$\('#fr'\)/g) || []).length, 0, 'no reply, stream or lookup through #fr inside the broker');
  assert.equal((block.match(/e\.source\.postMessage\(/g) || []).length, 2, "reply() and the chat stream's send()");
});

test('openApp and goHome leave through appFrameLeave, and nothing else loads or blanks #fr', () => {
  const code = SHELL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const open = /function openApp\(uid,slug,title\)\{.*$/m.exec(code)[0];
  assert.ok(open.indexOf('appFrameLeave();') >= 0 && open.indexOf('appFrameLeave();') < open.indexOf('PASW.frameLoad(uid,slug);'),
    'openApp leaves the app in #fr before it loads the next one (through PASW, web/sw-client.js: src, or srcdoc offline)');
  const home = code.slice(code.indexOf('function goHome()'), code.indexOf('\n}', code.indexOf('function goHome()')));
  assert.match(home, /appFrameLeave\(\);/, 'goHome leaves');
  // Enumerated, not trusted: every assignment to a frame's src in the shell.
  const sets = [...code.matchAll(/(?:\$\('#fr'\)|\bnu|\bfr|\bel)\.src=[^;]*;/g)].map((m) => m[0]).sort();
  assert.deepEqual(sets, ['fr.src=url;', "nu.src='about:blank';"].sort(),
    'only PASW.frameLoad (openApp\'s one call) loads an app, and only the fresh frame starts blank');
});
