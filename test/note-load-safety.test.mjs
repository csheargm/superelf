// PANote LOAD safety + the oversize cliff + markdown paste — the 2026-09-02 DATA-LOSS scar.
//
// WHY THIS FILE EXISTS
//   V1 — every READ failure was indistinguishable from "the file does not exist". A 401 after a
//        restarted server, a 500, a dropped Wi-Fi handoff and a 1.5s deadline all reached the pad
//        as "no data"; the pad opened a blank notebook; the next autosave wrote that blank over a
//        40-page note and the server answered 200 {"ok":true}. Measured by the refutation:
//        800 strokes / 40 pages / 47,076 bytes → 1 stroke / 1 page / 198 bytes.
//   V5 — the "draft backup" was a SECOND STORE of the user's work on the SAME broker behind the
//        SAME cap, so in the one case it existed for (a size rejection) it was rejected too.
//        Rounds 2 and 3 made it smaller and more careful; round 4 DELETED it, because a second
//        store is a second thing that can be emptied (measured: 40 strokes lost through one draft
//        path and 84 through another). What is asserted here now is the honest replacement: an
//        oversize write fails LOUDLY, nothing is written over and the work stays in the pad.
//   V7 — round 4's structural answer, PER-PAGE storage, was itself reverted in round 5: it lost
//        work in ordinary flows (a flush that reported success mid-write, a failure re-armed
//        against the wrong note, a tombstone written to the wrong layout). A note is ONE atomic
//        file again — see test/note-whole-file.test.mjs.
//
// HARNESS FIDELITY (the standing rule — a lenient mock is what caused the incident):
//   * a REAL node:http server, the REPO'S OWN readBody and the REAL BODY_LIMITS.appData cap;
//   * the real /api/save-data reply shapes, INCLUDING the legacy 400 text/plain "error";
//   * reads answer the real shapes too: 200 body, 404, 401, 500, and a destroyed socket;
//   * the client half is not a copy — the shell's RELAY-CORE block is EXTRACTED from
//     web/index.html and the engine's load/save core is EXTRACTED from web/note-ui.inline.html,
//     so this suite exercises the two shipped halves against each other.
//
// R14: nothing here may pass vacuously. The controls at the top prove the harness can fail, and
// the mutation tests at the bottom prove each guard is what stops the loss (disable it and the
// same script destroys the note).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appDataFile } from '../lib/appdata.mjs';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBody, BODY_TOO_LARGE, BODY_LIMITS } from '../lib/webutil.mjs';
import { loadRelayCore } from './helpers-shell-broker.mjs';
import { rmTemp } from './helpers-tmp.mjs';   // TODO(R4 seam): this file is over budget; split by test group (one describe per file)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');
const CAP = BODY_LIMITS.appData;

// ── Extract the engine's DOM-free core (the REAL code, not a re-implementation) ────────────────
function loadEngineCore() {
  const from = ENGINE.indexOf('  const SCHEMA=');
  const to = ENGINE.indexOf('\n  function Note(host, opts){');
  assert.ok(from > 0 && to > from, 'the engine core must stay a DOM-free block above function Note()');
  const src = ENGINE.slice(from, to);
  // eslint-disable-next-line no-new-func
  return new Function(`${src}
    return {makeSaveGuard,census,pickRicher,outcomeOf,SAVE_TXT,LOAD,LOAD_TXT,LOAD_STATUS,
            mdToHtml,looksLikeMarkdown,plainToHtml,sanitize,
            PHOTO_TXT,UPLOAD_MAX_BYTES,SAVE_RETRY_MS,HTML_TAGS,STYLE_OK};`)();
}
const G = loadEngineCore();

// ── The shell's request-failure mapping (owned by the shell half; consumed here) ──────────────
// loadRelayCore (helpers-shell-broker.mjs) runs it. If this ever stops composing with
// PANote.LOAD.fromBroker, THAT is the bug — the whole point of the contract is that the two halves
// agree on what "there is nothing there" means.

// ── A real server: repo readBody + web.mjs's save-data handler + real read failures ───────────
// `fault` = {code:'unauthorized'|'server-error'|'network'|'legacy', only?} — `only` is a substring
// so a test can fail ONE path the way a real per-file error does.
function startServer({ cap = CAP, dir }) {
  const state = { fault: null, readFault: null, writes: {}, count: 0, slow: 0 };
  const hit = (f, rel) => f && (!f.only || rel.includes(f.only));
  const srv = http.createServer(async (req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname.startsWith('/api/data/')) {
        const rel = decodeURIComponent(url.pathname.slice('/api/data/'.length));
        const f = state.readFault;
        if (hit(f, rel)) {
          if (f.code === 'network') { req.socket.destroy(); return; }              // dropped Wi-Fi / sleeping tunnel
          if (f.code === 'unauthorized') return send(401, 'application/json', '{"error":"bad token"}');  // web.mjs:651 verbatim
          if (f.code === 'server-error') return send(500, 'text/plain', 'error');   // sendFile's non-ENOENT answer
          if (f.code === 'corrupt') return send(200, 'application/json', '{"pages":[{"strokes":[1,2');
        }
        let data; try { data = fs.readFileSync(path.join(dir, rel), 'utf8'); }
        catch { return send(404, 'text/plain', 'not found'); }                      // the REAL absence shape
        return send(200, 'application/json', data);
      }
      if (req.method !== 'POST' || url.pathname !== '/api/save-data') return send(404, 'text/plain', 'not found');
      const b = await readBody(req, cap);                                           // REAL reader, REAL cap
      const rel = String(b.path || '');
      if (hit(state.fault, rel)) {
        if (state.fault.code === 'network') { req.socket.destroy(); return; }
        if (state.fault.code === 'legacy') return send(400, 'text/plain', 'error'); // the shape that shipped during the incident
        return send(500, 'application/json', '{"ok":false,"error":"保存失败 · save failed","code":"write_failed"}');
      }
      const f = appDataFile(dir, rel, { namespace: false });   // REAL path rule; this stand-in relay sends bare paths
      if (!f) return send(400, 'application/json', '{"error":"bad path"}');
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const body = typeof b.data === 'string' ? b.data : JSON.stringify(b.data);
      // A slow write models the real asymmetry: an MB-sized notebook is in flight for a long
      // time while a 300KB delta lands immediately. `slowOnly` names the path that is slow.
      if (state.slow && (!state.slowOnly || rel.includes(state.slowOnly))) await new Promise((r) => setTimeout(r, state.slow));
      fs.writeFileSync(f, body);
      state.writes[rel] = (state.writes[rel] || 0) + 1; state.count++;
      return send(200, 'application/json', JSON.stringify({ ok: true, bytes: body.length }));
    } catch (e) {
      if (!res.headersSent) send(e.message === 'bad JSON' || e.message === BODY_TOO_LARGE ? 400 : 500, 'text/plain', 'error');
      else if (!res.writableEnded) res.end();
    }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, state, port: srv.address().port })));
}

// The app's two broker helpers, built from the SHIPPED halves: the shell's relay maps the failure,
// PANote's own LOAD.fromBroker / saveOutcome decide what it means. No copies.
function brokerFor(port) {
  const relay = loadRelayCore((u, o) => fetch(`http://127.0.0.1:${port}${u}`, o));
  return {
    load: async (p) => G.LOAD.fromBroker(await relay.relayCall(`/api/data/${encodeURIComponent(p)}`, undefined, 'text')),
    save: async (p, data) => G.outcomeOf(await relay.relayCall('/api/save-data',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p, data }) }, 'raw')),
    raw: relay,
  };
}

// ── Fixtures at the density measured on live data (~21 bytes/point) ───────────────────────────
let pid = 0;
const freshPage = () => ({ id: 'p' + (++pid), strokes: [], pageHtml: '', images: [] });
const freshNotebook = (pages = 1) => ({ v: 2, id: 'nb', pages: Array.from({ length: pages }, freshPage) });
const stroke = (pts = 120) => ({ c: '#141414', w: 0.004, p: Array.from({ length: pts }, (_, i) => [0.1 + i * 1e-4, 0.2 + i * 1e-4, 0.5]) });
const fill = (nb, n, page = 0, pts = 120) => { for (let i = 0; i < n; i++) nb.pages[page].strokes.push(stroke(pts)); return nb; };
// The measured victim: 40 pages x 20 strokes = 800 strokes (47KB at the density seen on live data).
const fillAll = (nb, n, pts = 12) => { nb.pages.forEach((_, i) => fill(nb, n, i, pts)); return nb; };
const strokesOf = (nb) => (nb && nb.pages ? nb.pages.reduce((a, p) => a + ((p.strokes && p.strokes.length) || 0), 0) : 0);
const onDisk = (dir, rel) => { try { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); } catch { return null; } };
const bytesOnDisk = (dir, rel) => { try { return fs.statSync(path.join(dir, rel)).size; } catch { return 0; } };

function fakeClock() {
  const jobs = new Map(); let id = 0;
  return {
    setTimer: (fn, ms) => { const k = ++id; jobs.set(k, { fn, ms }); return k; },
    clearTimer: (k) => jobs.delete(k),
    pending: () => [...jobs.values()],
    async fire() { const all = [...jobs.entries()]; jobs.clear(); for (const [, j] of all) await j.fn(); },
  };
}

// One pad, wired the way PANote wires it: the guard starts LOCKED and only a load outcome that
// PROVES what is on the server unlocks it. `open()` is the harness's stand-in for pull(); the
// engine's own pull() is pinned by the wiring test at the bottom, and was also driven for real in
// a browser against this same server (the whole engine mounted in a live DOM, a 401 read, the
// curtain up, zero writes issued, the 12-page note byte-identical afterwards).
function mountPad({ port, dir, main, clock, startLocked = true }) {
  const bk = brokerFor(port);
  const seen = [];
  const pad = { nb: freshNotebook() };
  pad.guard = G.makeSaveGuard({
    serialize: () => pad.nb,
    write: (n) => bk.save(main, JSON.stringify(n)),
    onState: (s) => seen.push(s),
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    startLocked,
  });
  pad.open = async (rel) => {                                  // = PANote.pull(): load → seed | lock
    const out = G.LOAD.normalize(await bk.load(rel || main));
    if (out.status === G.LOAD_STATUS.failed) { pad.guard.lock(out.error, out.code); return out; }
    if (out.data) { pad.nb = out.data; pad.guard.seed(pad.nb, true); } else { pad.guard.seed(pad.nb, false); }
    return out;
  };
  pad.draw = (n = 1, page = 0) => { fill(pad.nb, n, page); pad.guard.schedule(); };
  pad.state = () => (seen.length ? seen[seen.length - 1] : pad.guard.state());
  pad.banner = () => pad.state().text || '';
  pad.disk = () => onDisk(dir, main);
  return pad;
}

async function withServer(t, opts, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-note-load-'));   // throwaway only — never live workspace data
  const s = await startServer({ ...opts, dir });
  try { await fn({ ...s, dir }); } finally { s.srv.close(); rmTemp(dir); }
}

// ── R14 CONTROLS: prove the harness can fail before trusting anything it says ─────────────────

test('control: the harness enforces the REAL cap and reproduces the REAL read failures', async (t) => {
  assert.equal(CAP, BODY_LIMITS.appData, 'the harness must track the REAL cap, not a literal that drifts from it');
  await withServer(t, {}, async ({ port, dir, state }) => {
    const bk = brokerFor(port);
    assert.deepEqual(await bk.save('ok.json', JSON.stringify({ a: 1 })), { ok: true });
    assert.deepEqual(onDisk(dir, 'ok.json'), { a: 1 });
    // Over the REAL 8MB cap the write is refused with the production shape.
    const over = await bk.save('huge.json', 'x'.repeat(CAP + 1024));
    assert.equal(over.ok, false, 'an oversize body must never look like a success');
    assert.equal(onDisk(dir, 'huge.json'), null, 'and nothing is written');
    // Every read failure the incident produced, through the SHELL's own mapping:
    assert.equal((await bk.load('missing.json')).status, 'absent', '404 → a PROVEN absence');
    state.readFault = { code: 'unauthorized' };
    assert.equal((await bk.load('ok.json')).status, 'failed', '401 (restarted server) → failed, NOT absent');
    state.readFault = { code: 'server-error' };
    assert.equal((await bk.load('ok.json')).status, 'failed', '500 → failed, NOT absent');
    state.readFault = { code: 'network' };
    assert.equal((await bk.load('ok.json')).status, 'failed', 'a dropped socket → failed, NOT absent');
    state.readFault = { code: 'corrupt' };
    const c = await bk.load('ok.json');
    assert.equal(c.status, 'failed', 'unparseable JSON → failed: "corrupt" is not "empty"');
    assert.equal(c.code, 'corrupt');
    state.readFault = null;
    assert.equal((await bk.load('ok.json')).status, 'loaded');
  });
});

test('control: the extracted halves are real code, and they compose', () => {
  assert.equal(typeof G.makeSaveGuard, 'function');
  assert.equal(typeof G.mdToHtml, 'function');
  assert.equal(typeof G.sanitize, 'function');
  assert.match(G.LOAD_TXT.locked, /无法打开 · Could not open/, 'the locked-note message is bilingual');
  // The one mapping the whole class turns on: the incident's reply must NOT be an absence.
  assert.equal(G.LOAD.fromBroker({ ok: false, error: 'not found' }).status, 'failed',
    'a code-less "not found" is exactly what a 401/500/network drop used to look like — it may never mean "empty"');
  assert.equal(G.LOAD.fromBroker({ ok: false, code: 'not-found', status: 404, error: 'not found' }).status, 'absent',
    'only the shell\'s explicit not-found code is an absence');
  for (const code of ['unauthorized', 'server-error', 'network', 'too-large', 'bad-request', 'relay-error'])
    assert.equal(G.LOAD.fromBroker({ ok: false, code, error: 'x' }).status, 'failed', `${code} must never open a blank note`);
  assert.equal(G.LOAD.normalize(null).status, 'failed', 'a bare null cannot prove absence, so it is a failure');
  assert.equal(G.LOAD.normalize(undefined).status, 'failed');
  assert.equal(G.LOAD.normalize({ pages: [] }).status, 'loaded', 'a bare notebook is unambiguous: the content is in hand');
});

// ── V1: an unread notebook can never become an empty one ──────────────────────────────────────

test('V1: a note that was never loaded CANNOT be written — not even once', async (t) => {
  await withServer(t, {}, async ({ port, dir, state }) => {
    const clock = fakeClock();
    const good = fillAll(freshNotebook(40), 20);                  // the user's real note, already on disk
    fs.writeFileSync(path.join(dir, 'entry-x.json'), JSON.stringify(good));
    const before = bytesOnDisk(dir, 'entry-x.json');

    const pad = mountPad({ port, dir, main: 'entry-x.json', clock });
    pad.draw(1, 0);                                             // a stroke lands before any load resolved
    const r = await pad.guard.flush();
    assert.equal(r.ok, false, 'the write is refused');
    assert.equal(r.locked, true, 'and it is refused for the RIGHT reason: the note is not loaded');
    assert.equal(state.count, 0, 'the server was never even asked to change anything');
    assert.equal(strokesOf(pad.disk()), 800, 'the good note is untouched');
    assert.equal(bytesOnDisk(dir, 'entry-x.json'), before);
    assert.equal(fs.readdirSync(dir).length, 1, 'and NOTHING else was written anywhere — a locked note writes nothing at all');
  });
});

for (const fault of ['unauthorized', 'server-error', 'network', 'corrupt']) {
test(`V1: a ${fault} load LOCKS the pad — the refutation's chain cannot complete`, async (t) => {
  await withServer(t, {}, async ({ port, dir, state }) => {
    const clock = fakeClock();
    const good = fillAll(freshNotebook(40), 20);                  // 40 pages, 800 strokes — the measured victim
    fs.writeFileSync(path.join(dir, 'entry-y.json'), JSON.stringify(good));
    const pad = mountPad({ port, dir, main: 'entry-y.json', clock });

    state.readFault = { code: fault };
    const out = await pad.open();
    assert.equal(out.status, 'failed', 'the load did not succeed and says so');
    assert.equal(pad.guard.state().locked, true, 'the pad is LOCKED');

    // The chain from the refutation, step for step: the user draws, autosave fires, retries fire.
    pad.draw(1, 0);
    assert.equal((await pad.guard.flush()).ok, false);
    pad.draw(3, 0);
    assert.equal((await pad.guard.flush()).ok, false);
    await clock.fire();                                          // any queued timer
    assert.equal(state.count, 0, 'NOT ONE write was issued for a note that could not be read');
    assert.equal(strokesOf(pad.disk()), 800, 'the 40-page note is intact (it was 1 stroke / 1 page after the old code)');

    // Recovery: the store comes back, the SAME pad retries the load, and only then can it write.
    state.readFault = null;
    const back = await pad.open();
    assert.equal(back.status, 'loaded');
    assert.equal(pad.guard.state().locked, false, 'a successful load is the ONLY thing that unlocks it');
    assert.equal(strokesOf(pad.nb), 800, 'and the pad now holds the real note, not a blank page');
    pad.draw(1, 0);
    assert.equal((await pad.guard.flush()).ok, true, 'writing works again');
    assert.equal(strokesOf(pad.disk()), 801);
  });
});
}

test('V1: the shrink floor is seeded from the LOAD, so the FIRST write after a switch is guarded', async (t) => {
  await withServer(t, {}, async ({ port, dir, state }) => {
    const clock = fakeClock();
    fs.writeFileSync(path.join(dir, 'entry-z.json'), JSON.stringify(fillAll(freshNotebook(40), 20)));
    const pad = mountPad({ port, dir, main: 'entry-z.json', clock });
    await pad.open();
    assert.equal(strokesOf(pad.nb), 800);

    // The exact refutation: a degenerate in-memory state autosaves BEFORE this pad has ever
    // written anything. `base` used to be null until the first CONFIRMED write, so this went
    // through and answered 200 ok:true.
    pad.nb = freshNotebook(1); fill(pad.nb, 1, 0); pad.guard.touch();
    const r = await pad.guard.flush();
    assert.equal(r.ok, false, 'refused');
    assert.match(r.error, /页数变少|笔迹变少|refused/, 'and says why, bilingually');
    assert.equal(state.writes['entry-z.json'], undefined, 'the file was never asked to change');
    assert.equal(strokesOf(pad.disk()), 800);
  });
});

test('V1: reset() re-locks, so the gap between a note switch and its load cannot be written', async (t) => {
  await withServer(t, {}, async ({ port, dir, state }) => {
    const clock = fakeClock();
    fs.writeFileSync(path.join(dir, 'entry-a.json'), JSON.stringify(fillAll(freshNotebook(3), 5)));
    fs.writeFileSync(path.join(dir, 'entry-b.json'), JSON.stringify(fillAll(freshNotebook(9), 7)));
    const pad = mountPad({ port, dir, main: 'entry-a.json', clock });
    await pad.open();
    pad.draw(1, 0);
    assert.equal((await pad.guard.flush()).ok, true);

    pad.guard.reset();                                           // what reload() does on a note switch
    assert.equal(pad.guard.state().locked, true, 'the pad is locked again until the NEXT note loads');
    pad.nb = freshNotebook(1); pad.guard.touch();                // the blank the old code would have written
    assert.equal((await pad.guard.flush()).ok, false);
    const writes = state.count;
    await clock.fire();
    assert.equal(state.count, writes, 'no timer can sneak a write into the gap either');
    assert.equal(strokesOf(onDisk(dir, 'entry-a.json')), 16, 'entry A survives the switch');
    assert.equal(strokesOf(onDisk(dir, 'entry-b.json')), 63, 'and entry B was never touched by A\'s pad');
  });
});

test('V1 MUTATION: disable the lock and the SAME script destroys the note', async (t) => {
  await withServer(t, {}, async ({ port, dir }) => {
    const clock = fakeClock();
    fs.writeFileSync(path.join(dir, 'entry-m.json'), JSON.stringify(fillAll(freshNotebook(40), 20)));
    // startLocked:false + no seed() = round 1's behaviour exactly (base null, writes allowed).
    const pad = mountPad({ port, dir, main: 'entry-m.json', clock, startLocked: false });
    pad.draw(1, 0);
    const r = await pad.guard.flush();
    assert.equal(r.ok, true, 'the unguarded pad happily writes…');
    assert.equal(strokesOf(pad.disk()), 1, '…and 800 strokes across 40 pages become 1 — this is the bug, reproduced');
    assert.equal(pad.disk().pages.length, 1);
  });
});

// ── The oversize cliff: REAL, BOUNDED and LOUD (round 5: it is not designed away) ─────────────

test('an oversize notebook is rejected LOUDLY and destroys nothing', async (t) => {
  await withServer(t, {}, async ({ port, dir, state }) => {
    const clock = fakeClock();
    const pad = mountPad({ port, dir, main: 'entry-big.json', clock });
    await pad.open();
    pad.draw(40, 0);
    assert.equal((await pad.guard.flush()).ok, true, 'baseline lands');
    assert.equal(strokesOf(pad.disk()), 40);

    // Grow past the REAL 8MB cap the way a long session of a LEGACY whole-file note does.
    while (JSON.stringify(pad.nb).length < CAP + 32 * 1024) pad.draw(50, 0);
    const size = JSON.stringify(pad.nb).length;
    assert.ok(size > CAP, `the notebook (${size} bytes) is over the ${CAP} cap`);

    const r = await pad.guard.flush();
    assert.equal(r.ok, false, 'the write is rejected for its size');
    assert.match(pad.banner(), /未保存 · Not saved/, 'and the user is told — the thing that was missing in the incident');
    assert.equal(strokesOf(pad.disk()), 40, 'the last good file is frozen but intact');
    assert.ok(strokesOf(pad.nb) > 40, 'and nothing was dropped from the pad');
    assert.equal(fs.readdirSync(dir).length, 1, 'nothing was written to any second path either');

    // THE HONEST STATEMENT (round 5). A second copy of this payload on the SAME broker is rejected
    // for the SAME reason — which is what three rounds of draft machinery kept rediscovering, and
    // it is why there is no second store. Splitting the payload was tried instead (per-page) and
    // was itself reverted for losing work in ordinary flows (see test/note-whole-file.test.mjs).
    // So the cliff is not designed away: it is BOUNDED (~135 dense pages inside the 8MB cap),
    // VISIBLE (the banner above), and non-destructive (the last good file is intact, the work is
    // still in the pad, and the retry ladder keeps trying).
    const asSecondCopy = await brokerFor(port).save('entry-big.copy.json', JSON.stringify(pad.nb));
    assert.equal(asSecondCopy.ok, false, 'a second whole-notebook write is rejected identically');
    assert.equal(onDisk(dir, 'entry-big.copy.json'), null, 'a backup that dies with the thing it backs up is not a backup');
    assert.equal(fs.readdirSync(dir).length, 1, 'and still nothing anywhere else on disk');
    // The measured headroom the cliff sits behind, asserted rather than asserted-in-a-comment.
    const densestPageBytes = 60.4 * 1024;
    assert.ok(CAP / densestPageBytes > 130, `the cap holds ~${Math.floor(CAP / densestPageBytes)} of the densest measured real page`);
  });
});

test('the whole draft mechanism is GONE from the engine — asserted as an absence', () => {
  // R1/R9: a deleted mechanism that leaves its scaffolding behind grows back. These names were the
  // scaffolding, and the grep runs on CODE, not on the comment that records why they went.
  const code = ENGINE.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  for (const gone of ['parkDraft', 'parkClear', 'putClear', 'clearDrafts', 'writeDraft', 'slotFor',
    'draftDelta', 'trimDraft', 'mergeDelta', 'richerInfo', 'DRAFT_STORE', 'draftProvenRedundant',
    'draftCovers', 'deltaContained', 'noteDraftRead', 'loadDraft', 'saveDraft', 'draftSlots',
    'DRAFT_KIND', 'DRAFT_MAX_BYTES', 'DRAFT_AHEAD_STROKES'])
    assert.ok(!code.includes(gone), `the engine still carries ${gone}`);
  // …and the state machine no longer reports a draft at all.
  const guard = G.makeSaveGuard({ serialize: () => freshNotebook(), write: async () => ({ ok: true }), startLocked: false });
  for (const k of ['draftFailed', 'draftStale', 'draftKept', 'draftState', 'draftPinned'])
    assert.ok(!(k in guard.state()), `the guard state still reports ${k}`);
});

// ── The text half of the shrink guard (V3 amplifier) ──────────────────────────────────────────

test('text regression: a page whose text vanishes on its own is REFUSED', async (t) => {
  await withServer(t, {}, async ({ port, dir }) => {
    const clock = fakeClock();
    const pad = mountPad({ port, dir, main: 'entry-h.json', clock });
    await pad.open();
    pad.nb.pages[0].pageHtml = '<div>' + 'a'.repeat(400) + '</div>';
    pad.guard.touch();
    assert.equal((await pad.guard.flush()).ok, true);

    pad.nb.pages[0].pageHtml = '';                               // the load-race shape: text gone, nobody typed
    pad.guard.touch();
    const r = await pad.guard.flush();
    assert.equal(r.ok, false, 'refused');
    assert.match(r.error, /文字变少/, 'bilingually');
    assert.equal(onDisk(dir, 'entry-h.json').pages[0].pageHtml.length, 411, 'the typed page survives');

    // …but a real edit that shortens the text (which arms allowShrink, as commitPageHtml does) saves.
    pad.nb.pages[0].pageHtml = '<div>shorter</div>';
    pad.guard.allowShrink(); pad.guard.touch();
    assert.equal((await pad.guard.flush()).ok, true, 'the user deleting their own text is not a regression');
    assert.equal(onDisk(dir, 'entry-h.json').pages[0].pageHtml, '<div>shorter</div>');
  });
});

// ── V3: markdown pasted into a note becomes formatted text, not literal punctuation ───────────

test('V3: markdown on paste converts to the sanitizer\'s OWN subset', () => {
  const answer = [
    '## 恩典 grace',
    '',
    'The key idea is **faith** and *trust* — see [John 3:16](https://ex.org/j316).',
    '',
    '- one 一',
    '- two 二',
    '',
    '| Term | Greek |',
    '|---|---|',
    '| grace 恩典 | charis |',
    '| faith 信心 | pistis |',
  ].join('\n');
  assert.equal(G.looksLikeMarkdown(answer), true);
  const html = G.mdToHtml(answer);
  // Every tag it emits is in HTML_TAGS and every style property is in STYLE_OK — i.e. it emits
  // ONLY what survives, which is what makes sanitizeHtml a fixpoint over it (proved in the DOM by
  // the browser e2e).
  const tags = [...html.matchAll(/<([a-z]+)[\s>]/g)].map((m) => m[1].toUpperCase());
  assert.ok(tags.length > 5, 'it produced real markup');
  for (const t of tags) assert.ok(G.HTML_TAGS[t], `<${t.toLowerCase()}> must be allow-listed`);
  for (const m of html.matchAll(/style="([^"]+)"/g))
    for (const decl of m[1].split(';').filter(Boolean)) {
      const prop = decl.split(':')[0].trim();
      assert.ok(G.STYLE_OK[prop], `style ${prop} must be allow-listed`);
    }
  // The user-visible complaint, gone: no raw markers survive.
  assert.ok(!/\*\*|^##\s|^\|/m.test(html.replace(/<[^>]+>/g, '')), 'no literal **, ## or | is left in the text');
  assert.match(html, /<strong>faith<\/strong>/, 'bold renders');
  assert.match(html, /<em>trust<\/em>/, 'italic renders');
  assert.match(html, /<ul><li>one 一<\/li><li>two 二<\/li><\/ul>/, 'the list renders as a list');
  assert.match(html, /font-size:24px/, 'the heading is downgraded to a sized+bold div (no H2 in the allow-list)');
  assert.match(html, /grace 恩典 · charis/, 'table cells stay separated instead of collapsing into one run');
  assert.match(html, /John 3:16 \(https:\/\/ex\.org\/j316\)/, 'the href survives as readable text (no A tag exists here)');
});

test('V3: plain text stays plain — no formatting is invented', () => {
  for (const s of ['just a sentence', 'a * b * c', 'cost is 5*3', 'snake_case_name', 'ratio 1/2', '2026-09-02 10:00'])
    assert.equal(G.looksLikeMarkdown(s), false, `"${s}" is not markdown`);
  assert.equal(G.plainToHtml('hello <b>x</b>'), 'hello &lt;b&gt;x&lt;/b&gt;', 'and it is escaped, not interpreted');
  assert.equal(G.plainToHtml('a\nb'), '<div>a</div><div>b</div>');
  assert.equal(G.mdToHtml('a **b** c'), 'a <strong>b</strong> c', 'a single line flows at the caret (no block wrapper)');
});

// ── Wiring: the engine source must keep the surfaces these guarantees depend on ────────────────

test('the engine wires the load contract, the lock and the paste path', () => {
  const must = [
    [/if\(locked\) return \{ok:false,error:locked,locked:true,code:lockCode\};/, 'run() refuses a locked note BEFORE serialize/regression/draft'],
    [/out=opts\.load\?LOAD\.normalize\(await opts\.load\(\)\):LOAD\.absent\(\);/, 'pull() normalises the load outcome — null can no longer mean "empty"'],
    [/if\(out\.status===LOAD_STATUS\.failed\)\{[\s\S]{0,320}?guard\.lock\(out\.error,out\.code\);/, 'a failed load LOCKS the pad'],
    [/guard\.seed\(NB,\(!!clean&&!keptMemory\)\|\|\(!clean&&!!reset\)\);/,
      'a successful load seeds the shrink floor from what was READ — and says honestly whether the in-memory notebook IS the stored one'],
    [/if\(txtEdit\) exitTextMode\(\);\s*\n[\s\S]{0,300}?renderLock\(guard\.state\(\)\);/,
      'pull() leaves the text region before NB can be replaced, and arms the "still opening" curtain BEFORE awaiting the load (a load that never resolves must not look like a blank page)'],
    [/startLocked:true,/, 'the pad starts locked — before a load there is no way to know what a write would destroy'],
    [/locked=LOAD_TXT\.pending; lockCode='not_loaded'; emit\(\);/, 'reset() re-locks across a note switch'],
    [/textLayer\.addEventListener\('paste',onPaste\)/, 'the paste path is registered with the text region'],
    [/if\(txt&&looksLikeMarkdown\(txt\)\) html=sanitizeHtml\(mdToHtml\(txt\)\);/, 'pasted markdown is converted and re-sanitized'],
    [/if\(html\.length<was\.length\) guard\.allowShrink\(\);/, 'a text edit that shortens the page arms the shrink guard'],
    [/const who=keyOf\(\);/, 'the note a write belongs to is captured in the SAME synchronous step as the census (F2)'],
    [/OUTSTANDING\.set\(who,r\.error\);/, 'a failed write is filed against THAT note, never against whichever note is open later'],
    [/OUTSTANDING\.delete\(who\);/, 'and only a CONFIRMED write of that same note clears it'],
  ];
  for (const [re, why] of must) assert.match(ENGINE, re, why);
  // ROUND 5: the per-page store is DELETED from the engine. Asserted as an absence, because a
  // second place the user's work can live is exactly the thing that has now come back twice.
  // Run over CODE, not comments: the scar above deliberately names what was deleted, and a grep
  // that cannot tell the two apart would fail on the documentation (or pass because someone
  // deleted it).
  const code = ENGINE.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const gone of [/dirtyPlan/, /rearmDirty/, /drawFailedPage/, /page_failed/, /pageFailed/, /pageKept/, /SAVE_TXT\.partial/, /\bidxPath\b/, /page-'\+/])
    assert.ok(!gone.test(code), `the per-page plumbing is gone from the engine: ${gone}`);
  // The exact defects the refutations found must not come back.
  assert.ok(!/async function writeDraft\(nb\)\{ if\(!cfg\.draft\) return; try\{ await cfg\.draft\(nb\); \}catch\(_\)\{[^}]*\} \}/.test(ENGINE),
    'the swallow-the-draft-failure one-liner is gone');
  assert.ok(!/try\{ if\(opts\.load\) data=await opts\.load\(\); \}catch\(_\)\{/.test(ENGINE),
    'the load catch that silently kept a blank notebook is gone');
  assert.ok(!/opts\.saveDraft/.test(ENGINE), 'the engine no longer has a draft hook at all');
});
