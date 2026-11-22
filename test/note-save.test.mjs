// PANote save durability — the user-flow harness for the 2026-09-02 handwriting DATA-LOSS scar.
//
// WHY THIS FILE EXISTS AND WHY IT LOOKS LIKE THIS
// The previous "verification" of stroke saving used an in-memory Map with NO size cap and no
// failure shapes. That harness could not fail the way production failed, so it passed while the
// real app silently dropped a page of Apple Pencil strokes. Standing rule: a mock MUST replicate
// the real system's guards. So this harness does not mock the server at all — it runs a real
// node:http server that:
//   * reads bodies with the REPO'S OWN readBody (lib/webutil.mjs), cap included;
//   * reproduces web.mjs's /api/save-data handler and its catch-all, which answers a
//     BODY_TOO_LARGE with 400 text/plain "error" — NOT JSON, NOT 413;
//   * is driven through a relay that is a verbatim copy of the shell's two-line save-data path
//     (web/index.html), so the app sees the exact `{ok:false,error:"Unexpected token ..."}` that
//     production produces. test "harness fidelity" below pins that copy against the real file.
// The cap the harness enforces is IMPORTED from lib/webutil.mjs, so it can never drift below
// the server's, and every failure test runs under BOTH server reply shapes (see SHAPES).
//
// R14: nothing here may pass vacuously. The first two tests prove the harness itself rejects an
// oversize body and that the extraction found real code; if either fails, every later assertion
// is meaningless and the suite says so instead of going green.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appDataFile } from '../lib/appdata.mjs';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
// The shared stripper, not a second one written here: comment removal that disagrees between two
// tests is how a source-pin passes in one file and fails in another (R3).
import { stripComments } from './helpers-app.mjs';
import { fileURLToPath } from 'node:url';
import { APP_SRC } from './helpers-app.mjs';
import { readBody, BODY_TOO_LARGE, BODY_LIMITS } from '../lib/webutil.mjs';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined
import { rmTemp } from './helpers-tmp.mjs';   // TODO(R4 seam): this file is over budget; split by test group (one describe per file)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');
const SHELL = readShell(ROOT);
const OFFLINE_CLIENT = fs.readFileSync(path.join(ROOT, 'web', 'offline-client.js'), 'utf8');
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');

// ── The real app-data cap, imported (not copied) so the harness cannot be laxer than prod ──
const CAP = BODY_LIMITS.appData;

// The server's reply shape for a rejected write is a MOVING TARGET, and the client has to be
// correct under every one of them:
//   'legacy'  — what shipped during the incident: the catch-all answers 400 text/plain "error",
//               so the shell's r.json() THROWS and the app sees {ok:false,error:"Unexpected …"}.
//               Not machine-readable — which is precisely why nobody ever handled it.
//   'json'    — the hardened route: 400/500 application/json {ok:false,error,code}.
// Every failure test below runs under both. A client that only survives the tidy shape would be
// a fake pass (R14).
const SHAPES = {
  legacy: { code: 400, type: 'text/plain', body: 'error' },
  json: { code: 500, type: 'application/json', body: JSON.stringify({ ok: false, error: 'save failed · 保存失败', code: 'write_failed' }) },
};

// ── Extract the DOM-free save core out of the engine and run the REAL code ──
function loadGuardModule() {
  const from = ENGINE.indexOf('  const SAVE_TIMEOUT_MS=');
  const to = ENGINE.indexOf('\n  function Note(host, opts){');
  assert.ok(from > 0 && to > from, 'makeSaveGuard must stay a DOM-free block above function Note()');
  const src = ENGINE.slice(from, to);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn {makeSaveGuard,census,pickRicher,outcomeOf,SAVE_TXT,SAVE_RETRY_MS,SAVE_DEBOUNCE_MS,SAVE_TIMEOUT_MS};`)();
}
const G = loadGuardModule();

// ── A real server: repo readBody + web.mjs's save-data handler + its catch-all ──
// `fault` lets a test take the store offline mid-session the way the broker/server really can.
// `fault` = {shape, only?} — `only` is a substring, so a test can fail ONE file the way a real
// per-file error does (bad target, atomic-write failure, oversize notebook) while the rest of the
// store still works. Omitting `only` is a TOTAL outage, which is a genuinely different case.
function startServer({ cap = CAP, dir }) {
  const state = { fault: null, writes: {}, count: 0 };
  const failing = (rel) => state.fault && (!state.fault.only || rel.includes(state.fault.only));
  const srv = http.createServer(async (req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    try {
      if (req.method !== 'POST' || req.url !== '/api/save-data') return send(404, 'text/plain', 'not found');
      const b = await readBody(req, cap);                       // REAL reader, REAL cap, REAL BODY_TOO_LARGE
      const rel = String(b.path || '');
      if (failing(rel)) { const s2 = state.fault.shape || state.fault; return send(s2.code, s2.type, s2.body); }
      const f = appDataFile(dir, rel, { namespace: false });   // REAL path rule; this stand-in relay sends bare paths
      if (!f) return send(400, 'application/json', '{"error":"bad path"}');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, typeof b.data === 'string' ? b.data : JSON.stringify(b.data));
      state.writes[rel] = (state.writes[rel] || 0) + 1; state.count++;
      return send(200, 'application/json', '{"ok":true}');
    } catch (e) {
      // web.mjs's catch-all, verbatim in behaviour: BODY_TOO_LARGE → 400 text/plain "error".
      if (!res.headersSent) send(e.message === 'bad JSON' || e.message === BODY_TOO_LARGE ? 400 : 500, 'text/plain', 'error');
      else if (!res.writableEnded) res.end();
    }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, port: srv.address().port })));
}

// The shell's save-data relay, copied from web/index.html. `r.json()` on a text/plain "error"
// THROWS, and the outer catch turns that into {ok:false,error:<parse message>} — which is exactly
// why an oversize failure was indistinguishable from a crash and why nobody ever handled it.
async function shellRelay(port, msg) {
  try {
    if (typeof msg.path !== 'string' || msg.path.includes('..') || !msg.path.endsWith('.json')) return { ok: false, error: 'bad path' };
    const r = await fetch(`http://127.0.0.1:${port}/api/save-data`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: msg.path, data: msg.data }),
    });
    const j = await r.json();
    return j;
  } catch (err) { return { ok: false, error: err.message }; }
}
// The app's paSave: relay reply → outcome, through the engine's OWN outcomeOf (R3).
const paSave = (port, p, data) => shellRelay(port, { path: p, data }).then(G.outcomeOf);

// ── Notebook fixtures at the density measured on live data (21.2 bytes/point) ──
let pid = 0;
const freshPage = () => ({ id: 'p' + (++pid), strokes: [], pageHtml: '', images: [] });
const freshNotebook = () => ({ v: 2, id: 'nb', pages: [freshPage()] });
const stroke = (pts = 120) => ({ c: '#141414', w: 0.004, p: Array.from({ length: pts }, (_, i) => [0.1 + i * 1e-4, 0.2 + i * 1e-4, 0.5]) });
const fill = (nb, n, page = 0) => { for (let i = 0; i < n; i++) nb.pages[page].strokes.push(stroke()); return nb; };
const strokesOf = (nb) => nb.pages.reduce((a, p) => a + p.strokes.length, 0);
const onDisk = (dir, rel) => { try { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); } catch { return null; } };

// Controllable timers: retry backoff is exercised deterministically, never by sleeping.
function fakeClock() {
  const jobs = new Map(); let id = 0;
  return {
    setTimer: (fn, ms) => { const k = ++id; jobs.set(k, { fn, ms }); return k; },
    clearTimer: (k) => jobs.delete(k),
    pending: () => [...jobs.values()],
    async fire() { const all = [...jobs.entries()]; jobs.clear(); for (const [, j] of all) await j.fn(); },
  };
}

// One pad = the guard wired the way an app wires it. ROUND 5: there is no second store and no
// second layout — ONE atomic write of the whole notebook, plus the retry ladder, and unconfirmed
// work lives in the notebook object the pad is still drawing into. `noteKey` is threaded through
// because the guard's failure bookkeeping is keyed to it (F2).
function mountPad({ port, dir, main, clock, noteKey }) {
  const nb = freshNotebook();
  const seen = [];
  const wrote = [];
  const guard = G.makeSaveGuard({
    serialize: () => nb,
    write: (n) => { wrote.push(strokesOf(n)); return paSave(port, main, JSON.stringify(n)); },
    noteKey: () => (noteKey ? noteKey() : main),
    onState: (s) => seen.push(s),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  // ROUND 2 (V1): the guard now starts LOCKED and only a LOAD that reported an outcome unlocks it,
  // so a pad that was never loaded cannot be written at all. The real lifecycle is mount → load →
  // seed, and a harness that skipped the load would be exercising a pad that cannot exist. This is
  // the "the file is there and we read it" case; the failed-load cases live in
  // test/note-load-safety.test.mjs, which drives the same guard through real 401/500/socket-drop
  // reads and asserts that NOTHING is written.
  guard.seed(nb, true);
  // Drawing goes through the SAME path endStroke() uses (push the stroke, then scheduleSave). A
  // helper that mutated the notebook without telling the guard would let flush() short-circuit, and
  // every assertion below would be about a code path the app never takes (R14).
  const drawN = (n = 1, page = 0) => { fill(nb, n, page); guard.schedule(); };
  return { nb, guard, seen, draw: drawN, wrote,
    banner: () => (seen.length ? seen[seen.length - 1].text : ''),
    disk: () => onDisk(dir, main) };
}

async function withServer(t, opts, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-note-save-'));   // throwaway only — never live workspace data
  const s = await startServer({ ...opts, dir });
  try { await fn({ ...s, dir }); } finally { s.srv.close(); rmTemp(dir); }
}

// ── R14 controls: prove the harness can fail before trusting anything it says ──────────────────

test('harness fidelity: the fake server enforces the REAL cap and answers the REAL failure shape', async (t) => {
  assert.equal(CAP, BODY_LIMITS.appData, 'the harness must track the REAL cap, not a literal that drifts from it');
  await withServer(t, {}, async ({ port, dir }) => {
    // Under the cap: stored, 200 ok:true.
    assert.deepEqual(await paSave(port, 'ok.json', JSON.stringify({ a: 1 })), { ok: true });
    assert.deepEqual(onDisk(dir, 'ok.json'), { a: 1 });
    // Over the REAL 8MB cap: the production shape — 400 text/plain "error" → r.json() throws →
    // the shell relays a JSON-parse message. Not a 413, not machine-readable. That is the bug the
    // client now has to survive, so the harness must reproduce it exactly, not a tidy 413.
    const huge = 'x'.repeat(CAP + 1024);
    const raw = await shellRelay(port, { path: 'huge.json', data: huge });
    assert.equal(raw.ok, false, 'an oversize body must never look like a success');
    assert.match(String(raw.error), /JSON/i, 'the shell surfaces the r.json() parse failure verbatim — the app cannot tell "too large" from "crashed"');
    assert.equal(onDisk(dir, 'huge.json'), null, 'nothing was written');
    // …and the engine's own mapper turns that into a failure rather than a silent success.
    assert.equal(G.outcomeOf(raw).ok, false);
  });
});

test('harness fidelity: the extracted save core is real code, not a stub', () => {
  assert.equal(typeof G.makeSaveGuard, 'function');
  assert.equal(typeof G.census, 'function');
  assert.deepEqual(G.SAVE_RETRY_MS[0] > 0, true);
  assert.match(G.SAVE_TXT.retry, /Not saved · 未保存/, 'the banner text is bilingual');
  assert.equal(G.outcomeOf(undefined).ok, false, 'a fire-and-forget closure returning undefined counts as FAILURE');
  assert.equal(G.outcomeOf({ ok: true }).ok, true);
});

// ── The incident, replayed ─────────────────────────────────────────────────────────────────────

for (const [shapeName, shape] of Object.entries(SHAPES)) {
test(`mid-session failure (${shapeName} server reply): strokes keep accumulating, the banner appears, recovery persists EVERYTHING`, async (t) => {
  await withServer(t, {}, async ({ port, dir, state }) => {
    const clock = fakeClock();
    const pad = mountPad({ port, dir, main: 'entry-a.json', clock });

    pad.draw(2, 0);
    assert.deepEqual(await pad.guard.flush(), { ok: true });
    assert.equal(strokesOf(pad.disk()), 2, 'baseline is on disk');
    assert.equal(pad.banner(), '', 'no banner while healthy');

    // This entry's own file starts failing mid-session — a per-file error (the shape the draft
    // path exists for). The total-outage case is its own test below, with its own honest limits.
    state.fault = { shape, only: 'entry-a.json' };

    pad.draw(1, 0);
    const r = await pad.guard.flush();
    assert.equal(r.ok, false, 'the failure is RETURNED, not swallowed');
    assert.match(pad.banner(), /Not saved · 未保存/, 'a visible bilingual banner appears');

    // The user keeps writing through the outage. Nothing is dropped from memory, and the last
    // good file on disk is untouched. ROUND 4: there is no second store to absorb it — the
    // notebook object the pad is still drawing into IS the copy, and it is never taken away from
    // the caller, which is what makes the retry below able to land everything at once.
    pad.draw(3, 0);
    await pad.guard.flush();
    pad.draw(4, 0);
    await pad.guard.flush();
    assert.equal(strokesOf(pad.nb), 10, 'in-memory notebook keeps every stroke drawn during the outage');
    assert.equal(strokesOf(pad.disk()), 2, 'the last CONFIRMED file is left intact');
    assert.match(pad.banner(), /Not saved · 未保存/, 'the banner is still up — it does not self-clear');

    // A retry is armed with backoff (not a busy loop).
    assert.ok(clock.pending().some((j) => G.SAVE_RETRY_MS.includes(j.ms)), 'a backoff retry is scheduled');

    // The store comes back; the scheduled retry alone recovers everything.
    state.fault = null;
    await clock.fire();
    assert.equal(strokesOf(pad.disk()), 10, 'every stroke drawn during the outage is persisted');
    assert.equal(pad.banner(), '', 'the banner clears ONLY on a confirmed successful save');
    // …and the write that finally landed carried EVERYTHING, because the payload is always the
    // whole notebook: nothing drawn during the outage was left behind by a narrower retry.
    assert.equal(pad.wrote[pad.wrote.length - 1], 10, 'the retry wrote the whole notebook, all 10 strokes');
  });
});

test(`the flush latch is gone (${shapeName} server reply): after a failed save, every later flush still writes`, async (t) => {
  await withServer(t, {}, async ({ port, dir, state }) => {
    const clock = fakeClock();
    const pad = mountPad({ port, dir, main: 'entry-b.json', clock });
    pad.draw(1, 0);
    await pad.guard.flush();
    const before = state.count;

    state.fault = { shape, only: 'entry-b.json' };
    pad.draw(1, 0);
    await pad.guard.flush();                                   // fails; the OLD code left saveTimer=0 here
    state.fault = null;

    // No new stroke, no timer pending — the old flushSave() would have done nothing at all, and
    // the note would have stayed frozen at its last successful save forever.
    const r = await pad.guard.flush();
    assert.equal(r.ok, true);
    assert.ok(state.count > before, 'the recovery flush actually issued a write');
    assert.equal(strokesOf(pad.disk()), 2);
    assert.equal(pad.banner(), '');
  });
});
}

test('a failed write never takes the newest content away from the pad', async (t) => {
  // What the deleted draft mechanism was for, and what replaces it: the guard NEVER copies the
  // notebook away from the caller, so a rejected write leaves every stroke exactly where the pad
  // is still drawing into it, and the retry ladder writes all of them at once when the store
  // returns. No second file, no second thing that can be emptied.
  await withServer(t, {}, async ({ port, dir, state }) => {
    const clock = fakeClock();
    const pad = mountPad({ port, dir, main: 'entry-c.json', clock });
    pad.draw(1, 0);
    await pad.guard.flush();

    state.fault = { shape: SHAPES.json, only: 'entry-c.json' };
    pad.draw(5, 0);
    await pad.guard.flushDurable();                            // what pagehide/visibilitychange run
    assert.equal(strokesOf(pad.disk()), 1, 'the good file was never overwritten by the failing write');
    assert.equal(strokesOf(pad.nb), 6, 'and the pad still holds all six strokes');
    assert.equal(pad.guard.state().unsaved, true, 'the guard knows they are unconfirmed');
    assert.ok(!fs.existsSync(path.join(dir, 'entry-c.draft.json')), 'and nothing was written to a second path');

    state.fault = null;
    await clock.fire();
    assert.equal(strokesOf(pad.disk()), 6, 'the retry lands every one of them');
  });
});

test('pickRicher: a re-read can only ever ADD — the poorer copy never wins', async (t) => {
  // The one piece of the old draft machinery that survived, because its job survived: when a load
  // succeeds while the pad already holds unsaved work, the richer copy wins and the pad stays
  // dirty. It is the reason a successful re-read cannot silently discard strokes.
  await withServer(t, {}, async () => {
    const good = fill(freshNotebook(), 9);
    const poor = fill(freshNotebook(), 2);
    assert.equal(G.pickRicher(good, poor), good, 'the richer copy wins');
    assert.equal(G.pickRicher(good, null), good);
    assert.equal(G.pickRicher(good, { v: 1, pages: [] }), good, 'an empty candidate is never preferred');
    assert.equal(G.pickRicher(poor, good), good, 'in either argument order');
    assert.equal(strokesOf(G.pickRicher(null, poor)), 2, 'and something beats nothing');
  });
});

test('partial-save guard: an emptier notebook is REFUSED and the good file survives', async (t) => {
  await withServer(t, {}, async ({ port, dir, state }) => {
    const clock = fakeClock();
    const pad = mountPad({ port, dir, main: 'entry-d.json', clock });
    pad.draw(6, 0);
    await pad.guard.flush();
    assert.equal(strokesOf(pad.disk()), 6);

    // The failure mode this guards: the in-memory state goes momentarily empty (load race, an
    // exception before hydration, a page-switch bug) and autosaves that. PROVEN against the real
    // server: it replaces the file and answers 200 {"ok":true} — the server CANNOT catch this.
    const before = state.writes['entry-d.json'];
    pad.nb.pages[0].strokes = []; pad.guard.touch();          // an autosave fired from a degenerate in-memory state
    const r = await pad.guard.flush();
    assert.equal(r.ok, false, 'the write is refused');
    assert.match(r.error, /笔迹变少|refused/, 'and says why, bilingually');
    assert.equal(state.writes['entry-d.json'], before, 'the real file was never even asked to change');
    assert.equal(strokesOf(pad.disk()), 6, 'the good file on disk is untouched');
    assert.match(pad.banner(), /Not saved · 未保存/, 'and the user is told');

    // A notebook with no pages at all — the `null` / `{}` degenerate write — is refused too.
    pad.nb.pages = []; pad.guard.touch();
    assert.equal((await pad.guard.flush()).ok, false);
    assert.equal(strokesOf(pad.disk()), 6);
  });
});

test('partial-save guard: a deliberate erase is allowed straight through', async (t) => {
  await withServer(t, {}, async ({ port, dir }) => {
    const clock = fakeClock();
    const pad = mountPad({ port, dir, main: 'entry-e.json', clock });
    pad.draw(4, 0);
    await pad.guard.flush();
    pad.nb.pages[0].strokes.splice(0, 2);
    pad.guard.allowShrink(); pad.guard.touch();                // what the eraser / delete-selection / undo do
    assert.equal((await pad.guard.flush()).ok, true, 'the user removing content is not a regression');
    assert.equal(strokesOf(pad.disk()), 2);
    // The permission is one-shot: it re-arms on the next confirmed save.
    pad.nb.pages[0].strokes = []; pad.guard.touch();
    assert.equal((await pad.guard.flush()).ok, false, 'the guard is armed again after the confirmed write');
  });
});

test('an oversize notebook fails LOUDLY instead of freezing the note (the original 64KB cliff)', async (t) => {
  await withServer(t, { cap: 64 * 1024 }, async ({ port, dir, state }) => {   // the exact pre-fix ceiling
    const clock = fakeClock();
    const pad = mountPad({ port, dir, main: 'entry-f.json', clock });
    pad.draw(1, 0);
    await pad.guard.flush();

    // Grow past the cap the way a page of Pencil strokes does (~21 bytes/point on live data).
    while (JSON.stringify(pad.nb).length < 70 * 1024) pad.draw(4, 0);
    const r = await pad.guard.flush();
    assert.equal(r.ok, false, 'the 413/400 is seen, not discarded');
    assert.match(pad.banner(), /Not saved · 未保存/, 'the banner is the thing that was missing in the incident');
    assert.equal(strokesOf(pad.disk()), 1, 'the last good file is intact — the note is frozen, but visibly so');
    assert.ok(strokesOf(pad.nb) > 1, 'and nothing was dropped from memory');
    // Raising the cap (what the stop-gap commit did) lets the queued retry drain the backlog.
    state.fault = null;
    const big = await startServer({ cap: CAP, dir });
    try {
      const drained = await paSave(big.port, 'entry-f.json', JSON.stringify(pad.nb));
      assert.equal(drained.ok, true);
      assert.equal(strokesOf(onDisk(dir, 'entry-f.json')), strokesOf(pad.nb));
    } finally { big.srv.close(); }
  });
});

test('writes are serialized: overlapping saves never race for the same file', async (t) => {
  await withServer(t, {}, async ({ port, dir }) => {
    const clock = fakeClock();
    const pad = mountPad({ port, dir, main: 'entry-g.json', clock });
    pad.draw(1, 0);
    const a = pad.guard.flush();
    pad.draw(1, 0);
    const b = pad.guard.flush();
    pad.draw(1, 0);
    const c = pad.guard.flush();
    await Promise.all([a, b, c]);
    // Whatever the interleaving, the LAST content wins and nothing is lost.
    assert.equal(strokesOf(pad.disk()), 3, 'completion order cannot decide the winner');
    assert.equal(pad.guard.state().unsaved, false);
  });
});

test('a carried-over failure is not hidden by the next note saving fine', async (t) => {
  await withServer(t, {}, async ({ port, dir, state }) => {
    const clock = fakeClock();
    // A REAL note switch changes the key the app reports, which is what the guard files failures
    // against (F2). The old harness kept one fixed key, so it could not tell "note A's failure" and
    // "note B's failure" apart — the very confusion the bug was made of.
    let key = 'A';
    const pad = mountPad({ port, dir, main: 'entry-h.json', clock, noteKey: () => key });
    state.fault = { shape: SHAPES.legacy, only: 'entry-h.json' };
    pad.draw(2, 0);
    await pad.guard.flush();
    assert.match(pad.banner(), /Not saved · 未保存/);

    state.fault = null;
    pad.guard.reset();                                          // what reload() does on a note switch
    key = 'B';                                                  // …and the app repoints its closures
    pad.guard.seed(pad.nb, true);                               // the incoming note loaded
    assert.match(pad.banner(), /之前的笔记未保存/, 'the previous note\'s failure stays on screen');
    pad.draw(1, 0);
    await pad.guard.flush();
    assert.match(pad.banner(), /之前的笔记未保存/, 'a healthy save of the NEW note does not clear it');
    assert.equal(pad.guard.state().outstanding, false, 'and it is NOT reported as note B\'s own problem');
    pad.guard.clearCarried();
    assert.equal(pad.banner(), '', 'only the user dismisses it');

    // Back to A: the write that never landed is A's, and A is where the user meets it again.
    pad.guard.reset(); key = 'A'; pad.guard.seed(pad.nb, true);
    assert.equal(pad.guard.state().outstanding, true, 'returning to A surfaces A\'s outstanding write');
    assert.match(pad.banner(), /之前的改动未保存/, 'in A\'s own words: ' + pad.banner());
  });
});

test('TOTAL outage: nothing lands — this documents the honest limit', async (t) => {
  await withServer(t, {}, async ({ port, dir, state }) => {
    const clock = fakeClock();
    const pad = mountPad({ port, dir, main: 'entry-i.json', clock });
    pad.draw(2);
    await pad.guard.flush();

    state.fault = { shape: SHAPES.legacy };                    // no `only` ⇒ EVERY path fails, drafts included
    pad.draw(7);
    await pad.guard.flushDurable();

    // What is NOT true: nothing new reached the store, so a reload here loses the 7 new strokes.
    // No client-side fallback can change that — the sandbox's opaque origin makes localStorage,
    // sessionStorage, IndexedDB and cookies all throw (verified 2026-09-02), and the broker is
    // the only writable surface an app has. Claiming otherwise would be the fake part, and it is
    // exactly what three rounds of draft machinery claimed: a second file on the SAME broker
    // cannot survive an outage of that broker.
    assert.equal(strokesOf(pad.disk()), 2, 'the last good file is still intact');

    // What IS true, and is the whole point: nothing is lost while the pad is open, the user is
    // told, and recovery is automatic the moment the store returns.
    assert.equal(strokesOf(pad.nb), 9, 'every stroke is still in memory');
    assert.match(pad.banner(), /Not saved · 未保存/, 'and the user has been told, continuously');
    state.fault = null;
    await clock.fire();
    assert.equal(strokesOf(pad.disk()), 9, 'the queued retry drains the whole backlog on recovery');
    assert.equal(pad.banner(), '');
  });
});

// ── Wiring assertions: the engine/app source must keep the awaited surfaces ────────────────────
// (These catch a regression that the unit tests above cannot see, because the guard is correct
// but nobody calls it — which is exactly how the original bug survived review.)

test('every surface transition awaits the flush', () => {
  const must = [
    [/reload:async\(applyScope\)=>\{[\s\S]{0,300}?const r=await flushSave\(\);[\s\S]{0,120}?guard\.reset\(\);[\s\S]{0,140}?if\(applyScope\) await applyScope\(\);[\s\S]{0,140}?await pull\(true\)/,
      'reload(): flush the OLD scope → reset → let the app repoint its closures → pull. The order is structural, not a comment.'],
    [/open:async\(applyScope\)=>\{ show\(\); return api\.reload\(applyScope\); \}/, 'fullscreen open() hands applyScope through'],
    [/NB\.pages\.push\(np\); NB\.updated=Date\.now\(\);\s*\n\s*guard\.touch\(\);/,
      'addPage marks the notebook dirty — without it the flushes that follow short-circuit as clean'],
    [/const touchPage=\(\)=>\{ page\(\)\.updated=Date\.now\(\); \};/,
      'touchPage stamps the page mtime and nothing else — there is no per-page write to aim'],
    [/markDirty:\(\)=>guard\.touch\(\)/, 'an app whose load returned more than the file holds can mark the pad dirty'],
    [/async function flipTo\(target\)\{[\s\S]{0,400}?await flushSave\(\);/, 'flipTo awaits the outgoing page write'],
    [/async function addPage\(\)\{\s*\n\s*await flushSave\(\);/, 'addPage lands the outgoing page first'],
    [/async function setTool\(t\)\{[\s\S]{0,200}?await flushSave\(\);/, 'a tool change (incl. leaving the T tool) awaits'],
    [/const hide=\(\)=>\{ ov\.classList\.remove\('on'\); return api\.flush\(\); \}/, 'fullscreen hide() RETURNS the flush'],
    [/onClose:async\(\)=>\{ await hide\(\);/, 'the ✕ awaits the flush before the app is told'],
    [/window\.addEventListener\('pagehide',onPageHide\)/, 'pagehide runs the durable flush, not the old timer-gated one'],
    [/window\.addEventListener\('beforeunload',onBeforeUnload\)/, 'an unsaved-work warning is registered'],
    [/document\.addEventListener\('visibilitychange',onHide\)/, 'visibilitychange runs the durable flush'],
  ];
  for (const [re, why] of must) assert.match(ENGINE, re, why);
  // The exact defects the audit found must not come back.
  assert.ok(!/if\(saveTimer\)\{ clearTimeout\(saveTimer\); saveTimer=0; return save\(\); \}/.test(ENGINE), 'the timer-gated flushSave latch is gone');
  assert.ok(!/catch\(_\)\{ \/\* app broker down: kept in memory, retried on next change \*\/ \}/.test(ENGINE), 'the dead catch that claimed a retry that did not exist is gone');
});

test('the shell relay this harness copies is still AT LEAST as harsh as the shell relay', () => {
  // If web/index.html's save-data path changes shape, this suite risks proving something
  // about a system that no longer exists (R14). It changed in round 2: the relay now maps
  // every failure through ONE helper (relayCall → relayHttpFail) and answers a machine-
  // readable code — see test/broker-relay.test.mjs, which drives that mapper against a
  // real server. `shellRelay` above still reproduces the PRE-round-2 shape, where an
  // oversize 400 text/plain made r.json() throw and the app received
  // {ok:false,error:'Unexpected token …'}. That is strictly HARSHER than what the shell
  // now produces ({ok:false,code:'too-large',limit,…}) — both are ok:false with an error
  // string, so every engine assertion below still holds, on the worse of the two inputs.
  // A LENIENT copy would be the fidelity bug; a harsher one is not.
  // Offline-first (web/offline-client.js §2) wrapped the call: PAOffline.write runs the SAME
  // relayCall and only queues {ok:true,offline:true} on code:'network' — which relayNetFail
  // alone produces, on a THROWN fetch. A 4xx/5xx goes through relayHttpFail, whose codes are
  // never 'network', so it reaches the app as the same ok:false it always did. `shellRelay`
  // above has no store (PAOffline.write with no db → call() straight through) and turns a thrown
  // fetch into ok:false: still the harsher input on every branch.
  assert.match(SHELL, /reply\(await PAOffline\.write\(appSlug,m\.path,m\.data,\(\)=>relayCall\('\/api\/save-data',\{method:'POST'[^)]*\},'raw'\)\)/,
    'shell save-data relay: one mapper, and the 200 body (size telemetry) is still relayed verbatim');
  assert.match(OFFLINE_CLIENT, /async function write\(slug,path,data,call\)\{\s*if\(!d\.db\) return call\(\);[\s\S]{0,200}?if\(!r\|\|r\.code!=='network'\) return r;/,
    'the offline queue is reached ONLY on code:network — a 4xx/5xx answer is relayed as the failure it is');
  assert.equal((SHELL.match(/return \{ok:false,code:'network'/g) || []).length, 1, "code:'network' has ONE producer in the shell (the reply-contract comment is not one)");
  assert.match(SHELL, /function relayNetFail\(err,where,signal\)\{[\s\S]{0,200}?code:'network'/, 'that producer is relayNetFail — the thrown-fetch path, never an HTTP status');
  assert.doesNotMatch(SHELL.slice(SHELL.indexOf('async function relayHttpFail'), SHELL.indexOf('async function relayHttpFail') + 1500), /code:'network'/, 'relayHttpFail never answers code:network');
  assert.match(SHELL, /code:'relay-error'/, 'the broker catch-all answers a code — never a bare {ok:false}');
  // "no kind may answer a bare not-found again" is audited in ONE place, over code with
  // comments stripped: test/broker-relay.test.mjs (R3 — this file must not keep a second,
  // weaker copy of that rule).
});

test('both apps return save outcomes and check them', () => {
  // Was a hardcoded pair including workspace/apps — the owner's gitignored LIVE set, absent on a
  // fresh clone, so this threw ENOENT there and the published repo failed its own suite. APP_SRC
  // resolves each app to its live copy or its tracked template (R3).
  const entries = Object.entries(APP_SRC).filter(([k]) => k.startsWith('notes'));
  assert.ok(entries.length >= 1, 'CONTROL: there is a notes source to check, so this cannot pass empty');
  for (const [rel, src] of entries) {
    assert.match(src, /res\(PANote\.saveOutcome\(m\)\)/, `${rel}: paSave resolves an OUTCOME`);
    assert.match(src, /save timed out · 保存超时/, `${rel}: paSave has a deadline — a reply that never comes is a failure`);
    // The helper was renamed paSave -> DATA.write when the apps grew a read-failure gate (round 2);
    // both spellings are accepted, and what is pinned is unchanged: the content write is awaited
    // and CONFIRMED before the drawer's timestamp/preview describe it.
    assert.match(src, /const r=await writeNote\(e\.id,nb\);\s*\n\s*if\(!r\.ok\) return r;/,
      `${rel}: the index is stamped only AFTER the ONE content write is confirmed`);
    // ROUND 4: the draft mechanism is DELETED, in the engine and in every app. Asserted as an
    // absence rather than trusted, because a second store of the user's work is exactly the thing
    // that came back twice already.
    assert.ok(!/saveDraft|draftPath|noteDraftRead|draftSlots/.test(src), `${rel}: no draft path is wired any more`);
    assert.match(src, /pad\.reload\(\(\)=>\{ curId=id; \}\)/, `${rel}: curId is repointed INSIDE reload's callback, after the outgoing entry is flushed`);
    assert.ok(!/curId=id;[\s\S]{0,120}await pad\.reload\(\)/.test(src), `${rel}: the switch-then-reload order that writes the old note under the new id is gone`);
    assert.match(src, /const idx=await writeIndexNow\(\);\s*\n\s*if\(!idx\.ok\)/, `${rel}: delete dereferences first and verifies`);
    assert.ok(!/try\{ await paSave\(entryPath\(e\.id\), JSON\.stringify\(nb\)\); \}catch\(_\)/.test(src), `${rel}: the dead try/catch around paSave is gone`);
  }
  const bible = fs.readFileSync(path.join(ROOT, 'workspace.example/apps/bible/index.html'), 'utf8');
  assert.match(bible, /async function saveAnn\(\)\{/, 'bible: saveAnn returns an outcome');
  // Round 2 renamed ANN_CORRUPT -> ANN_BLOCKED (a bilingual reason string, '' = writable) because
  // the flag now covers EVERY read failure, not only unparsable JSON — a 401/500/offline chapter
  // must block writes for the same reason a corrupt one does (V1). Both spellings accepted; the
  // pinned behaviour is unchanged: an unreadable chapter refuses the write instead of wiping it.
  assert.match(bible, /if\(ANN_(?:CORRUPT|BLOCKED)\)[\s\S]{0,160}?return \{ok:false/, 'bible: an unreadable chapter file blocks writes instead of being overwritten with {}');
  // Comments stripped first: the app now carries a SCAR comment quoting this exact fallback to
  // explain why it must never come back, and a raw source match trips over the warning instead of
  // the defect. Same trap as the --fg audit — prose that names the thing it forbids.
  assert.ok(!/let obj=\{\}; try\{ obj=JSON\.parse\(rd\.text\)\|\|\{\}; \}catch\{\}/.test(stripComments(bible)),
    'bible: the empty-object fallback that wiped a chapter is gone');
});

// ── ROUND-4 LEFTOVER 1: a failure notice survives everything except a success on ITS OWN path ──
// A verified leftover of round 3: a successful LOAD retired a SAVE failure it had not covered.
// seed() cleared failed/blocked/error/attempt unconditionally, and pull() passed `replaced:true`
// even when the pad had just KEPT its own richer copy — so a re-read of a note whose write was
// still failing wiped the banner AND the retry ladder, and the unsaved strokes sat under a green
// pill. The app-side half of the same rule (one message PER PATH) is proved in
// test/app-load.test.mjs; this is the engine half.

test('a successful RE-READ does not retire a save failure it did not cover', async (t) => {
  await withServer(t, {}, async ({ port, dir, state }) => {
    const clock = fakeClock();
    const pad = mountPad({ port, dir, main: 'entry-r.json', clock });
    pad.draw(2, 0);
    assert.equal((await pad.guard.flush()).ok, true, 'a baseline is on disk');

    state.fault = { shape: SHAPES.json, only: 'entry-r.json' };
    pad.draw(5, 0);
    assert.equal((await pad.guard.flush()).ok, false, 'the next write is rejected');
    assert.match(pad.banner(), /Not saved · 未保存/, 'and the banner is up');
    const attempts = pad.guard.state().attempt;
    assert.ok(attempts > 0, 'with a retry ladder running');

    // A re-read now succeeds and returns the OLD file — 2 strokes, while the pad holds 7. The pad
    // keeps its richer copy, so this read proves nothing about the write that failed.
    const stored = onDisk(dir, 'entry-r.json');
    assert.equal(strokesOf(stored), 2, 'the store really is behind the pad');
    pad.guard.seed(pad.nb, false);                     // replaced:false — memory was kept
    assert.match(pad.banner(), /Not saved · 未保存/, 'the failure report SURVIVES the successful read');
    assert.equal(pad.guard.state().failed !== false, true, 'and so does the failed state');
    assert.equal(pad.guard.state().unsaved, true, 'the pad still knows the work is unconfirmed');

    // CONTROL (R14): a read that genuinely REPLACES the notebook — i.e. the store now holds what
    // the pad holds — is allowed to retire it, or the pill would never go green again.
    state.fault = null;
    assert.equal((await pad.guard.flush()).ok, true, 'the retry lands');
    assert.equal(strokesOf(pad.disk()), 7);
    assert.equal(pad.banner(), '', 'and only then is the report retired');
  });
});

test('the engine passes `replaced` honestly — the pin for the leftover above', () => {
  assert.match(ENGINE, /guard\.seed\(NB,\(!!clean&&!keptMemory\)\|\|\(!clean&&!!reset\)\);/,
    'pull() says "the in-memory notebook IS the stored one" only when it actually is');
  assert.match(ENGINE, /seed\(nb,replaced\)\{ locked=''; lockCode=''; base=census\(nb\); shrinkOk=false;\s*\n\s*if\(replaced\)\{ dirty=false; again=false; failed=false; blocked=false; error=''; attempt=0;/,
    'and seed() only retires the failure state when it was');
  // MUTATION: restore the unconditional clear and the report vanishes on any load at all.
  const mutated = ENGINE.replace("seed(nb,replaced){ locked=''; lockCode=''; base=census(nb); shrinkOk=false;\n        if(replaced){ dirty=false; again=false; failed=false; blocked=false; error=''; attempt=0;\n          clrT(retryT); retryT=0; }",
    "seed(nb,replaced){ locked=''; lockCode=''; base=census(nb); shrinkOk=false;\n        failed=false; blocked=false; error=''; attempt=0; if(replaced){ dirty=false; again=false; }\n        clrT(retryT); retryT=0;");
  assert.notEqual(mutated, ENGINE, 'the mutation matched — otherwise it would prove nothing');
  const from = mutated.indexOf('  const SAVE_TIMEOUT_MS='), to = mutated.indexOf('\n  function Note(host, opts){');
  // eslint-disable-next-line no-new-func
  const M = new Function(`${mutated.slice(from, to)}\nreturn {makeSaveGuard};`)();
  const broken = M.makeSaveGuard({ serialize: () => ({ v: 2, pages: [{ id: 'p0', strokes: [{ p: [[1, 1]] }] }] }), write: async () => ({ ok: false, error: 'x' }), startLocked: false });
  broken.touch();                                     // nothing is unconfirmed until something is
  return broken.flush().then(() => {
    assert.equal(broken.state().unsaved, true, 'the mutated guard did fail');
    broken.seed({ v: 2, pages: [{ id: 'p0', strokes: [] }] }, false);
    // The mutation retires the FAILURE and its retry ladder on a read that replaced nothing —
    // which is what the real engine must not do. (The per-note OUTSTANDING record is a second,
    // independent barrier the mutation does not touch, so the pill is not empty; what is asserted
    // is precisely the thing the mutation broke: the "retrying" state is gone.)
    assert.ok(!/重试中/.test(broken.state().text),
      'the MUTATED engine erases the save failure + ladder on a read that replaced nothing: ' + broken.state().text);
    assert.equal(broken.state().attempt, 0, 'and resets the attempt count with it');
    broken.stop();
  });
});
