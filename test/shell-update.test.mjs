// PAUpdate — the shell keeps itself on the newest build（客户端自动更新）, web/update.js (docs/adr/0026).
// The block is run against fakes in the pattern of the other shell tests (helpers-shell-dom): a
// controllable /api/build, a fake open app, a stepped clock. Then the wiring is pinned in the
// composed shell: the marker, the bar line, the ↺ highlight, the poll and the reopen after boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SHELL, ROOT, between } from './helpers-app.mjs';
import { SHELL_PARTS } from '../lib/shellhtml.mjs';

const BLOCK = between(SHELL, '/* ══ PA_UPDATE_BEGIN', 'PA_UPDATE_END ══ */');
assert.ok(BLOCK, 'the PA_UPDATE block is in the composed shell');
// Everything up to the real wiring: the constants and makeUpdate.
const CORE = BLOCK.slice(0, BLOCK.indexOf('// Which app is open'));
// eslint-disable-next-line no-new-func
const { makeUpdate, UPDATE_POLL_MS, BUSY_REPLY_MS, BUSY_QUERY, UPDATE_READY_TXT, REOPEN_KEY, RELOAD_RETRY_MS } = new Function(`${CORE}\nreturn { makeUpdate, UPDATE_POLL_MS, BUSY_REPLY_MS, BUSY_QUERY, UPDATE_READY_TXT, REOPEN_KEY, RELOAD_RETRY_MS };`)();

// A fake page: the version it loaded with, a server answer, an open app (or none) that answers
// the busy query as told, and timers the test steps.
function harness({ loaded = '管家 · v5.0.0+3 · abc1234', server = { build: 'abc1234', version: 'v5.0.0+3 · abc1234' }, app = null, held = false, shell = false } = {}) {
  const log = { reloads: 0, ready: 0, asked: [] };
  const timers = [];
  let replyFn = null;
  const d = {
    loaded: () => loaded,
    fetchJson: async () => { if (server instanceof Error) throw server; return server; },
    heldPages: () => held,
    shellBusy: () => shell,
    frameWin: () => (app ? { postMessage: (m) => { log.asked.push(m); if (app.answer !== 'silent') Promise.resolve().then(() => replyFn && replyFn({ kind: 'pa-busy', busy: app.answer })); } } : null),
    onReply: (fn) => { replyFn = fn; return () => { replyFn = null; }; },
    reload: () => { log.reloads++; },
    markReady: () => { log.ready++; },
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
  };
  const u = makeUpdate(d);
  const fireTimers = () => { for (const t of timers.splice(0)) t.fn(); };
  return { u, log, fireTimers, timers };
}

test('same build → nothing: no query to the app, no reload, no bar', async () => {
  const h = harness({ app: { answer: false } });
  assert.equal(await h.u.check(), 'same');
  assert.deepEqual(h.log, { reloads: 0, ready: 0, asked: [] });
});

test('new build, no app open → reload at once', async () => {
  const h = harness({ server: { build: 'def5678', version: 'v5.0.0+4 · def5678' } });
  assert.equal(await h.u.check(), 'reloaded');
  assert.equal(h.log.reloads, 1);
  assert.equal(h.log.ready, 0);
});

test('new build, app answers busy:false → reload, keeping the app (the reload dep remembers it)', async () => {
  const h = harness({ server: { build: 'd', version: 'v5.0.0+4 · d' }, app: { answer: false } });
  assert.equal(await h.u.check(), 'reloaded');
  assert.deepEqual(h.log.asked, [BUSY_QUERY], 'ONE query, {kind:"pa-busy?"}');
  assert.equal(h.log.reloads, 1);
});

test('new build, app busy → no reload; the bar line is shown; isReady; a later check with the app idle reloads', async () => {
  const app = { answer: true };
  const h = harness({ server: { build: 'd', version: 'v5.0.0+4 · d' }, app });
  assert.equal(await h.u.check(), 'ready');
  assert.equal(h.log.reloads, 0);
  assert.equal(h.log.ready, 1, 'markReady lights ↺ and shows the line');
  assert.equal(h.u.isReady(), true);
  assert.equal(h.timers.length, 0, 'the busy deadline was cleared on the answer');
  app.answer = false;
  assert.equal(await h.u.check(), 'reloaded', 'the user finished: the next check reloads');
});

test('a held (leaving) app frame still saving → ready, no reload, the frame is not even asked', async () => {
  const h = harness({ server: { build: 'd', version: 'v5.0.0+4 · d' }, app: { answer: false }, held: true });
  assert.equal(await h.u.check(), 'ready');
  assert.deepEqual(h.log, { reloads: 0, ready: 1, asked: [] });
});

test('no app open but the shell composer holds a draft or a turn is in flight → ready, no reload; with an idle app open too', async () => {
  const alone = harness({ server: { build: 'd', version: 'v5.0.0+4 · d' }, shell: true });
  assert.equal(await alone.u.check(), 'ready');
  assert.deepEqual(alone.log, { reloads: 0, ready: 1, asked: [] });
  const withApp = harness({ server: { build: 'd', version: 'v5.0.0+4 · d' }, app: { answer: false }, shell: true });
  assert.equal(await withApp.u.check(), 'ready', 'the shell\'s own draft is OR\'ed into the frame path');
  assert.equal(withApp.log.reloads, 0);
});

test('a draft typed into the shell composer WHILE the app was being asked counts: shellBusy is read again after the answer', async () => {
  const log = { reloads: 0, ready: 0, shellReads: 0 };
  let draft = false, deadline = null, reply = null;
  const deps = { loaded: () => '管家 · v5.0.0+3 · abc1234', fetchJson: async () => ({ build: 'd', version: 'v5.0.0+4 · d' }), heldPages: () => false,
    shellBusy: () => { log.shellReads++; return draft; }, frameWin: () => ({ postMessage: () => {} }), onReply: (fn) => { reply = fn; return () => { reply = null; }; },
    reload: () => { log.reloads++; }, markReady: () => { log.ready++; }, setTimeout: (fn) => { deadline = fn; return 1; }, clearTimeout: () => { deadline = null; } };
  // No answer from the app: the deadline fires (busy, fail closed) — the draft typed meanwhile is read too.
  const p = makeUpdate(deps).check(); await Promise.resolve(); await Promise.resolve();
  draft = true;            // the user typed while the app had BUSY_REPLY_MS to answer
  deadline();
  assert.equal(await p, 'ready');
  assert.equal(log.reloads, 0, 'never reloaded over the draft'); assert.equal(log.ready, 1);
  assert.equal(log.shellReads, 1, 'the app\'s busy already decided: the second read is not needed');
  // The app answers idle: only the SECOND shell read keeps the page (before the fix this reloaded).
  draft = false; log.shellReads = 0;
  const q = makeUpdate(deps).check(); await Promise.resolve(); await Promise.resolve();
  draft = true; reply({ kind: 'pa-busy', busy: false });
  assert.equal(await q, 'ready', 'the app said idle, the shell did not');
  assert.equal(log.reloads, 0); assert.equal(log.ready, 2); assert.equal(log.shellReads, 2, 'read before AND after the app was asked');
  // CONTROL: no draft at either read and an idle app → reload, as before.
  draft = false; log.shellReads = 0;
  const r = makeUpdate(deps).check(); await Promise.resolve(); await Promise.resolve(); reply({ kind: 'pa-busy', busy: false });
  assert.equal(await r, 'reloaded'); assert.equal(log.reloads, 1); assert.equal(log.shellReads, 2);
  assert.match(CORE, /if\(d\.shellBusy\(\)\|\|await appBusy\(\)\|\|d\.shellBusy\(\)\)/, 'pinned: the recheck after the await');
});

test('busy query with no answer within BUSY_REPLY_MS → treated busy (fail closed, R14)', async () => {
  const h = harness({ server: { build: 'd', version: 'v5.0.0+4 · d' }, app: { answer: 'silent' } });
  const p = h.u.check();
  await Promise.resolve();
  assert.equal(h.timers.length, 1, 'one deadline armed');
  assert.equal(h.timers[0].ms, BUSY_REPLY_MS);
  assert.equal(BUSY_REPLY_MS, 500);
  h.fireTimers();
  assert.equal(await p, 'ready');
  assert.equal(h.log.reloads, 0, 'an app that cannot answer is never reloaded under the user');
  assert.equal(h.log.ready, 1);
});

test('server unreachable or malformed → no reload, no bar; the next check asks again', async () => {
  const off = harness({ server: new Error('offline') });
  assert.equal(await off.u.check(), 'error');
  const odd = harness({ server: { nope: 1 } });
  assert.equal(await odd.u.check(), 'unknown');
  assert.equal(off.log.reloads + odd.log.reloads + off.log.ready + odd.log.ready, 0);
});

test('a check already in flight is not doubled (visibilitychange and the poll can coincide)', async () => {
  const h = harness({ server: { build: 'd', version: 'v5.0.0+4 · d' }, app: { answer: 'silent' } });
  const p = h.u.check();
  assert.equal(await h.u.check(), 'busy-checking');
  h.fireTimers();
  await p;
  assert.equal(h.log.asked.length, 1);
});

// The two frame deps, run as written: an app loaded by srcdoc (data-app set, no src — web/sw-client.js)
// is asked before a reload and reopened after one, exactly like an app loaded by src.
test('frameWin and frameApp read frameRef: a srcdoc app counts as open; about:blank and an empty frame do not', () => {
  const wiring = BLOCK.slice(BLOCK.indexOf('// Which app is open'));
  const frameApp = /^const frameApp=\(\)=>[^\n]*$/m.exec(wiring);
  const frameWin = /frameWin:(\(\)=>\{[^\n]*?\}),/.exec(wiring);
  const frameRef = /^const frameRef=\(\)=>[^\n]*$/m.exec(SHELL);
  assert.ok(frameApp && frameWin && frameRef, 'all three are extractable');
  const run = (src, attrs, title = 'Bible') => {
    const fr = { src, contentWindow: { tag: 'win' }, getAttribute: (n) => (n in attrs ? attrs[n] : null) };
    const $ = (sel) => (sel === '#fr' ? fr : sel === '#ftitle' ? { textContent: title } : null);
    // eslint-disable-next-line no-new-func
    return new Function('$', `${frameRef[0]}\n${frameApp[0]}\nconst frameWin=${frameWin[1]};\nreturn { app: frameApp(), win: frameWin() };`)($);
  };
  assert.deepEqual(run('/app/u1/bible/', {}), { app: { u: 'u1', s: 'bible', t: 'Bible' }, win: { tag: 'win' } }, 'src route, as before');
  assert.deepEqual(run('', { 'data-app': '/app/u1/bible/' }), { app: { u: 'u1', s: 'bible', t: 'Bible' }, win: { tag: 'win' } }, 'srcdoc route: the same answers');
  assert.deepEqual(run('about:blank', {}), { app: null, win: null }, 'a fresh frame holds nothing');
  assert.deepEqual(run('', {}), { app: null, win: null }, 'an empty frame holds nothing');
});

test('the wiring in the composed shell: polls while visible, lights ↺, one bar line outside the inert header, reopens the app after boot', () => {
  assert.ok(SHELL_PARTS.some(([m, f]) => m === '/* PA_UPDATE_JS */' && f === 'update.js'), 'update.js is a shell part');
  assert.equal(UPDATE_POLL_MS, 15 * 60 * 1000);
  assert.equal(UPDATE_READY_TXT, '有新版本 · Update ready — 点按刷新 · tap to reload');
  const wiring = BLOCK.slice(BLOCK.indexOf('const PAUpdate=makeUpdate('));
  assert.match(wiring, /document\.addEventListener\('visibilitychange',\(\)=>\{ if\(document\.visibilityState==='visible'\) PAUpdate\.check\(\); \}\);/);
  assert.match(wiring, /setInterval\(\(\)=>\{ if\(document\.visibilityState==='visible'\) PAUpdate\.check\(\); \},UPDATE_POLL_MS\);/);
  assert.match(wiring, /fetch\(p,\{cache:'no-store'\}\)/, 'the question itself is never answered from a cache');
  assert.match(wiring, /loaded:\(\)=>\{ const vl=\$\('#ver-lbl'\);/, 'the version the page loaded with is read from the footer — the ONE place the server writes it');
  assert.match(wiring, /markReady:\(\)=>\{ \$\('#reload'\)\.classList\.add\('upd'\); \$\('#reload'\)\.onclick=updateReload; const b=\$\('#updBar'\); b\.textContent=UPDATE_READY_TXT; b\.classList\.add\('on'\); b\.onclick=updateReload; \}/, 'the lit ↺ is rebound to updateReload, so it keeps the open app like the bar');
  assert.match(wiring, /heldPages:\(\)=>appFramesHeld\.size>0/, 'a leaving page held for its last save (web/app-frame.js, inlined before this block)');
  assert.ok(SHELL.indexOf('const appFramesHeld=new Set()') < SHELL.indexOf('/* ══ PA_UPDATE_BEGIN'), 'appFramesHeld is defined before PAUpdate reads it');
  assert.match(wiring, /shellBusy:\(\)=>!!\(\$\('#box'\)\.value\.trim\(\)\|\|\$\('#log'\)\.querySelector\('\.msg\.status'\)\|\|\(typeof PASync!=='undefined'&&PASync\.inFlight\(\)\)\)/, 'the shell composer\'s draft, its in-flight status row, or a queue drain in flight (web/offline-sync.js)');
  assert.match(BLOCK, /sessionStorage\.setItem\('pa_refreshing','1'\)/, 'reloads the way ↺ does: the spinner carries across');
  const raw = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(raw, /const status=add\('status',''\);/, 'the status row submitSend adds is the in-flight marker shellBusy reads');
  const header = between(raw, '<header>', '</header>');
  assert.ok(!header.includes('id="updBar"') && raw.includes('<span id="updBar" class="fs-toast"></span>'), 'the line sits outside the inert header, like the toast');
  assert.match(raw, /#reload\.upd\{ color:var\(--accent\); \}/);
  assert.match(raw, /#updBar\{ pointer-events:auto; cursor:pointer; \}/, 'tappable, unlike the toast');
  const boot = raw.slice(raw.indexOf("$('#reload').onclick="));
  assert.ok(boot.indexOf('/* PA_UPDATE_JS */') < boot.indexOf('reopenAfterUpdate();'), 'defined before boot calls it');
  assert.ok(boot.indexOf("sessionStorage.removeItem('pa_refreshing')") < boot.indexOf('reopenAfterUpdate();'), 'reopened once the boot loaders settled (apps and profile loaded)');
  assert.equal((raw.match(/id="updBar"/g) || []).length, 1, 'one line, no second surface');
});

// ── Review finding 1 (update.js): once deferred, ↺ and the bar call updateReload directly, past
// check()'s shellBusy — it must refuse under a queue drain and reload once the drain ends.
test('regression: updateReload refuses while PASync.inFlight() and re-arms; reloads once the drain ends; reloads at once with no drain', () => {
  const src = /^function updateReload\(\)\{[\s\S]*?\n\}$/m.exec(BLOCK);
  assert.ok(src, 'updateReload is extractable');
  const run = (inFlight) => {
    const log = { reloads: 0, armed: [], stored: {} };
    const PASync = { inFlight: () => inFlight.shift() };
    // eslint-disable-next-line no-new-func
    const f = new Function('PASync', 'location', 'sessionStorage', 'frameApp', 'setTimeout', 'REOPEN_KEY', 'RELOAD_RETRY_MS', `${src[0]}\nreturn updateReload;`)(
      PASync, { reload: () => { log.reloads++; } }, { setItem: (k, v) => { log.stored[k] = v; } }, () => ({ u: 'u1', s: 'notes', t: 'Notes' }),
      (fn, ms) => { log.armed.push({ fn, ms }); }, REOPEN_KEY, RELOAD_RETRY_MS);
    return { log, first: f() };
  };
  const busy = run([true, false]);
  assert.equal(busy.first, false, 'refused');
  assert.equal(busy.log.reloads, 0, 'before the fix: reloaded under the drain');
  assert.equal(busy.log.armed.length, 1, 're-armed');
  assert.equal(busy.log.armed[0].ms, RELOAD_RETRY_MS);
  busy.log.armed[0].fn();   // the drain has ended
  assert.equal(busy.log.reloads, 1, 'the kept tap reloads once the drain ends');
  assert.equal(busy.log.stored.pa_refreshing, '1');
  assert.equal(JSON.parse(busy.log.stored[REOPEN_KEY]).s, 'notes', 'the open app is remembered');
  const idle = run([false]);
  assert.equal(idle.first, true); assert.equal(idle.log.reloads, 1); assert.equal(idle.log.armed.length, 0, 'CONTROL: no drain, a plain reload');
});
