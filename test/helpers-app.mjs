// Shared fixture for the app-level suites — EXTRACTED, not re-implemented.
//
// WHY THIS FILE EXISTS (R3/R8): test/app-load.test.mjs and test/note-whole-file.test.mjs both
// need the same thing — the FOUR shipped app files, run for real, against a real node:http server
// that uses the repo's own readBody / BODY_LIMITS / saveAppData, through the shell's own broker
// extracted from web/index.html, with the ENGINE'S OWN save guard rather than an imitation of it.
// Two copies of that fixture would drift, and a fixture that drifts from production is what let the
// 2026-09-02 data loss through review. It lives here once.
//
// Nothing in here decides an outcome. Every rule under test — the load contract, the save guard,
// the data core, the app's own closures — is EXTRACTED from the shipped source and executed; the
// only things stubbed are the DOM and the two sibling UI components.
// TODO(R4): over budget. Split seams: the engine extractions (engineModule, guardModule, coreModule,
// titleApi) | the real server and relay (startServer, makeRelay, startHarness) | runApp and its fake DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBody, safeJoin, BODY_LIMITS, bodyErrorResponse } from '../lib/webutil.mjs';
import { saveAppData, appDataFile } from '../lib/appdata.mjs';
import { SHELL, loadShellBroker } from './helpers-shell-broker.mjs';
import { settle, until, deferred } from './helpers-timing.mjs';   // re-exported below for the app suites

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const ENGINE = read('web', 'note-ui.inline.html');
// SHELL is the shell AS SERVED (helpers-shell-broker.mjs, via lib/shellhtml.mjs readShell): index
// .html with the settings dialog and settings JS inlined. Reading the raw index.html instead would
// silently stop guarding everything that has been extracted out of it.
const CHAT = read('web', 'chat-ui.inline.html');
const SPLIT = read('web', 'split-ui.inline.html');
const PRINT = read('web', 'print-ui.inline.html');

// The four app files this harness owns. Template + live for both apps: the live Bible is a
// NEWER shape (PANote draw pad, notes listing, markdown paste) and is hardened in its own shape,
// so both shapes must be proved, not just the tidy one.
// workspace/ is the user's LIVE data and is gitignored, so a fresh clone has no live apps at
// all. `read` throws on a missing file, which made helpers-app.mjs fail to IMPORT there — and
// with it the entire suite, not just the tests that care. A live app now falls back to its
// tracked template: on a developer's machine the live copy is read as before, and on a clone the
// tests still have something real to assert against.
const APPS = {
  'notes (template)': 'workspace.example/apps/notes/index.html',
  'notes (live)': 'workspace/apps/notes/index.html',
  'bible (template)': 'workspace.example/apps/bible/index.html',
  'bible (live)': 'workspace/apps/bible/index.html',
};
const TEMPLATE_OF = { 'notes (live)': 'notes (template)', 'bible (live)': 'bible (template)' };
const APP_SRC = {};
for (const [k, rel] of Object.entries(APPS)) {
  try { APP_SRC[k] = read(...rel.split('/')); }
  catch { APP_SRC[k] = null; }                      // filled in below, once the templates are read
}
for (const [live, tpl] of Object.entries(TEMPLATE_OF)) if (APP_SRC[live] == null) APP_SRC[live] = APP_SRC[tpl];
for (const k of Object.keys(APP_SRC)) if (APP_SRC[k] == null) throw new Error(`missing tracked app source: ${APPS[k]}`);

const between = (src, a, b) => {
  const i = src.indexOf(a);
  if (i < 0) return null;
  const j = src.indexOf(b, i + a.length);
  if (j < 0) return null;
  return src.slice(i, j + b.length);
};
// Comments are documentation, not code. Every "this pattern is gone" check below runs on the
// stripped source: the SCAR comments deliberately quote the deleted code (`withTimeout(...,1500)`,
// `catch{}`, `window.PANote`), and a grep that cannot tell a comment from a statement would either
// fail on the documentation or, worse, pass because someone deleted the comment.
// Only WHOLE-LINE `//` comments are dropped. Block comments are deliberately kept: an R5
// justification lives inside its catch (`catch(_){ /* why silence is correct */ }`) and the
// empty-catch check below must be able to see the difference between that and `catch(_){}`.
const stripComments = (code) => code.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
const scriptOf = (html) => {
  const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
  const m = [...noComments.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].filter((x) => x[1].trim());
  assert.equal(m.length, 1, 'each app has exactly one executable inline script');
  return m[0][1];
};
// An app's script AS SERVED: web.mjs (sendAppHtml) puts PATwoTap, PAStore and PALeave ahead of the first
// script of every app page, so a test that RUNS an app runs them first. scriptOf stays the app's own, for scans.
const EVERY_PAGE = [read('web', 'two-tap.inline.html'), read('web', 'store.inline.html'), read('web', 'leave.inline.html'), read('web', 'busy.inline.html')];
// PAVerseMarks (web/verse-marks.inline.html): the Bible carries its marker, so the served page has it
// ahead of the app's script. runApp runs the REAL component against the sandbox's window/document
// (no selection, no layout) unless a test hands its own through `globals` (verse-marks.test.mjs).
const VERSE_MARKS_MARKER = '<!--PA_VERSE_MARKS_UI-->';
const VERSE_MARKS = read('web', 'verse-marks.inline.html');
// PAInkAnchor (web/ink-anchor.inline.html): the Bible carries its marker too; it needs PANote.ink.
const INK_ANCHOR_MARKER = '<!--PA_INK_ANCHOR_UI-->';
const INK_ANCHOR = read('web', 'ink-anchor.inline.html');
const INK_FRAME = read('web', 'ink-frame.inline.html');   // PAInkFrame: inlined in front of PAInkAnchor (its marker heads that file)
// PAInkPen (web/ink-pen.inline.html): the verse ink's pen sheet, after PAInkAnchor; it reads PANote.palette.
const INK_PEN_MARKER = '<!--PA_INK_PEN_UI-->';
const INK_PEN = read('web', 'ink-pen.inline.html');
// PAReadingHistory (web/reading-history.inline.html): the Bible carries its marker; it reads/writes reading.json through DATA.
const READING_HISTORY_MARKER = '<!--PA_READING_HISTORY_UI-->';
const READING_HISTORY = read('web', 'reading-history.inline.html');
const APP_PREFS_SRC = scriptOf(read('web', 'app-prefs.inline.html'));   // PAAppPrefs, the page's one prefs chain
const servedScriptOf = (html) => [...EVERY_PAGE, html].map(scriptOf).join('\n');

// ── The engine's own rules, extracted (never restated) ───────────────────────────────────────
// Mutation testing only: `mutate` rewrites shipped source before it runs. It must change something,
// or the "mutation" would test the unmutated code and prove nothing. Used here and by the note-proto
// suites. TODO(R3): the same check is still inline at 23 sites: helpers-stationery (4),
// helpers-panote-routing (3), helpers-flip-settle (2), chat-pill-reserve (4), note-whole-file (3),
// stationery-panote (2), app-bar-peek (2), photo-component, note-save and chat-image-lane. Move them here
// in a refactor-only session (R8). A check that the target is PRESENT before replacing it is a
// different rule, and is not listed.
const mutated = (src, mutate, what = 'source') => {
  if (!mutate) return src;
  const out = mutate(src);
  assert.notEqual(out, src, `${what}: the mutation matched nothing — it would prove nothing`);
  return out;
};
function engineModule(mutate) {
  // The SAME slice test/note-save.test.mjs extracts (R3: one extraction boundary, not two): the
  // DOM-free block that holds the LOAD contract, outcomeOf, census and richer.
  const block = mutated(between(ENGINE, '  const SAVE_TIMEOUT_MS=', '\n  function makeSaveGuard(cfg){'), mutate, 'engine');
  assert.ok(block && block.includes('fromBroker'), 'the engine still carries the LOAD contract');
  assert.ok(block && block.includes('function pickRicher'), 'the engine still carries outcomeOf/census/pickRicher');
  const src = block.replace(/\n\s*function makeSaveGuard\(cfg\)\{$/, '') + '\n';
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn {LOAD,LOAD_TXT,LOAD_STATUS,outcomeOf,notSavedText,RETRYING,pickRicher,census,SAVE_TXT,PHOTO_TXT,UPLOAD_MAX_BYTES,SAVE_TIMEOUT_MS};`)();
}
const ENG = engineModule();
// PANote.ink, the module-scope stroke renderer + Pencil guard, lifted VERBATIM from the engine (the
// slice just above window.PANote) — the same no-retype rule as titleApi below.
function inkModule() {
  const block = between(ENGINE, '  // ── THE PENCIL GUARD（防误触）', '\n  window.PANote={');
  assert.ok(block && block.includes('function drawStroke') && block.includes('function guardInk'), 'the engine still carries the hoisted stroke renderer + guard');
  const src = block.replace(/\n\s*window\.PANote=\{$/, '');
  // eslint-disable-next-line no-new-func
  return new Function(`const TAU=Math.PI*2, HILITE_ALPHA=0.30, MAX_CANVAS_PX=16e6, mid=(a,b)=>({x:(a.x+b.x)/2,y:(a.y+b.y)/2});\n${src}\nreturn Object.freeze({drawStroke,drawFlat,segTo,segWidth,guardInk,MAX_CANVAS_PX,HILITE_ALPHA});`)();
}
const ENG_INK = inkModule();
// PANote.palette (colours, tools, icons, sizes, swatch markup), lifted VERBATIM from the engine: the slice
// from COLORS to palette(), evaluated as written (the same no-retype rule as inkModule).
function paletteModule() {
  const block = between(ENGINE, '  const COLORS=[', '\n  const INKS=');
  assert.ok(block && block.includes('function palette(){ return Object.freeze(') && block.includes('function swatchesHtml'), 'the engine still carries the shared palette');
  // eslint-disable-next-line no-new-func
  return new Function(`${block.replace(/\n\s*const INKS=$/, "")}\nreturn palette();`)();
}
const ENG_PALETTE = paletteModule();

// The DEFAULT-TITLE members of window.PANote, lifted VERBATIM from the component rather than
// retyped here. A hand-written copy is exactly how this stub came to be missing defaultTitle
// while every app called it: the suite went green and the app threw on mount. Slicing the real
// source means the stub cannot drift from what apps actually call.
const titleApi = () => {
  const block = between(ENGINE, '    NEW_NOTE_LABEL:', '\n    // \u2500\u2500 Shared save vocabulary');
  assert.ok(block && block.includes('defaultTitle:'), 'PANote still exports the default-title members');
  const body = block.replace(/\n\s*\/\/ \u2500\u2500 Shared save vocabulary$/, '');
  // eslint-disable-next-line no-new-func
  return new Function(`const window={};window.PANote={${body}};return window.PANote;`)();
};
const TITLE_API = titleApi();
// The engine's REAL save guard. Extracted at the SAME boundary test/note-save.test.mjs uses
// (R3: one extraction rule, three files now) — makeSaveGuard must stay DOM-free above
// function Note(). `mutate` (mutation testing only) rewrites the engine's OWN source before it
// runs, so a guard can be removed and the assertion it protects shown to go red; it must match
// something, or the "mutation" would be testing the unmutated code and proving nothing.
function guardModule(mutate) {
  const from = ENGINE.indexOf('  const SAVE_TIMEOUT_MS=');
  const to = ENGINE.indexOf('\n  function Note(host, opts){');
  assert.ok(from > 0 && to > from, 'makeSaveGuard must stay a DOM-free block above function Note()');
  assert.ok(/function makeSaveGuard\(cfg\)\{/.test(ENGINE.slice(from, to)), 'the extraction found the real guard');
  const src = mutated(ENGINE.slice(from, to), mutate, 'guard');
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn {makeSaveGuard,census,pickRicher,outcomeOf,contentPrint,SAVE_TXT};`)();
}
const GUARD = guardModule();

// ── The DOM-free data core, extracted from an app and run for real ───────────────────────────
// `panote` is window.PANote as the page has it. Leave it out for a page without note-ui: the core
// then runs with no PANote binding at all, as a script on such a page would.
function coreModule(appKey, panote) {
  const src = between(APP_SRC[appKey], '// ══ PA_DATA_CORE_BEGIN', 'PA_DATA_CORE_END ══');
  assert.ok(src && src.includes('function makeReader'), `${appKey} still carries the data core`);
  assert.ok(!/\bdocument\.|\bwindow\.|\bdocument\b\s*\[/.test(stripComments(src)),
    `${appKey}'s data core must stay DOM-free`);
  // eslint-disable-next-line no-new-func
  const body = `${src}\nreturn {makeReader,PA_LOAD,LOAD_TIMEOUT_MS};`;
  return arguments.length > 1 ? new Function('PANote', body)(panote) : new Function(body)();
}

// ═══ 2. REAL SERVER + REAL RELAY + REAL APP ══════════════════════════════════════════════════

// web.mjs's two routes, reproduced with the repo's own reader/writer. `fault` takes the store
// down the way production does — per path or totally — with a REAL status code, not a flag.
function startServer({ dir }) {
  const state = { fault: null, gets: [], puts: [], encodings: [] };
  // `on` is load-bearing, not a convenience. A fault that also blocks WRITES would let a test pass
  // because the SERVER refused, never proving the APP refused — the file survives either way and
  // the assertion is vacuous (R14). The V1 tests therefore fail only the READ ('get'), so a client
  // that treats the failed read as "empty" WOULD succeed in overwriting the file, and the harness
  // can tell the two apart. (Caught by mutation-testing this file: with a read+write fault, an app
  // that bypassed its own write block still passed.)
  const hit = (rel, method) => state.fault
    && (!state.fault.only || rel.includes(state.fault.only))
    && (!state.fault.on || state.fault.on === method);
  const srv = http.createServer(async (req, res) => {
    const send = (code, type, body) => { res.writeHead(code, { 'content-type': type }); res.end(body); };
    try {
      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname.startsWith('/api/data/')) {
        let rel;
        try { rel = decodeURIComponent(url.pathname.slice('/api/data/'.length)); }
        catch { return send(400, 'text/plain', 'bad path'); /* web.mjs: safeJoin refuses a malformed escape */ }
        state.gets.push(rel);
        if (hit(rel, 'get')) return send(state.fault.status, 'text/plain', state.fault.body || 'error');
        const f = safeJoin(dir, url.pathname.slice('/api/data/'.length));          // REAL path gate, as web.mjs
        if (!f) return send(400, 'text/plain', 'bad path');
        if (!fs.existsSync(f)) return send(404, 'text/plain', 'not found');       // web.mjs sendFile
        return send(200, 'application/json', fs.readFileSync(f, 'utf8'));
      }
      if (req.method === 'POST' && url.pathname === '/api/save-data') {
        state.encodings.push(req.headers['content-encoding'] || 'identity');       // what the client sent
        const b = (await readBody(req, BODY_LIMITS.appData)) || {};               // REAL reader, REAL cap
        const rel = String(b.path || '');
        state.puts.push(rel);
        if (hit(rel, 'put')) return send(state.fault.status, 'text/plain', state.fault.body || 'error');
        const f = appDataFile(dir, rel);                                          // REAL path rule
        if (!f) return send(400, 'application/json', '{"ok":false,"error":"bad path","code":"bad_path"}');
        let r;
        try { r = saveAppData(f, b.data); }                                       // REAL writer + validation
        catch (e) {
          if (e.code === 'bad_data') return send(400, 'application/json', JSON.stringify({ ok: false, error: e.message, code: 'bad_data' }));
          return send(500, 'application/json', '{"ok":false,"error":"save failed","code":"write_failed"}');
        }
        return send(200, 'application/json', JSON.stringify(r));
      }
      if (req.method === 'GET' && url.pathname === '/api/notes') return send(200, 'application/json', JSON.stringify(state.notes || []));
      return send(404, 'text/plain', 'not found');
    } catch (e) {
      const r = bodyErrorResponse(e);                                             // REAL 413/400/408 mapping
      if (!res.headersSent) send(r.status, 'application/json', r.body);
    }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, state, port: srv.address().port })));
}

// web/index.html's broker, RUN (test/helpers-shell-broker.mjs loadShellBroker): api(), RELAY-CORE and
// the whole message handler, so a request takes the shell's own branch, kind → noun mapping, catch
// and reply(). Every {ok:false} for a served kind carries the shell's rendered `text`, a save is
// gzipped, and a refused save names its uncompressed size, exactly as a real app receives them.
// Only these kinds go to it (bible and bible-search reach the server's 404). The others get this
// file's stubs, as before: the server has no renderer, agent, chat stream or notification store.
const SERVED = new Set(['data', 'save-data', 'notes-list', 'bible', 'bible-search']);
// The broker's catch: the one place a branch's throw becomes a reply. Pinned, so the fault check in
// makeRelay cannot go quiet if the shell renames its code.
assert.ok(SHELL.includes("reply({ok:false,code:'relay-error',error:'外壳中转出错 · shell relay error: '"),
  "the broker's catch still answers code 'relay-error'");

function makeRelay(port, slug) {
  assert.ok(slug, "the broker namespaces app data by the slug in the app frame's URL");
  const broker = loadShellBroker(`http://127.0.0.1:${port}`, { app: slug });
  // What the real shell would not have answered as the harness did. startHarness's stop() fails the
  // test that owns the harness on any of them, so a flow can never pass on a harness gap (R14).
  const faults = [];
  let seq = 0;
  const relay = async function relay(m) {
    if (!SERVED.has(m.kind)) return m.kind === 'render-md' ? { ok: true, html: '<p>md</p>' } : { ok: false, code: 'bad-request', error: 'unknown' };
    // The shell ignores a request whose id is neither a number nor a string: no app may send one.
    if (m.id !== undefined && typeof m.id !== 'number' && typeof m.id !== 'string') faults.push(`'${m.kind}' carried id ${String(m.id)}, which the shell ignores`);
    // An id of its own per request: a test calls relay() without one, and an app's may repeat.
    const id = `relay${++seq}`;
    const msg = await new Promise((done) => broker.route({ ...m, id }, done));
    // The catch answered: a branch threw — here, on a name the harness does not supply. The app still
    // gets that reply, as from the real shell, so nothing waits for ever.
    if (msg.code === 'relay-error') faults.push(`the shell's broker threw on '${m.kind}': ${msg.error}`);
    return { ...msg, id: m.id };
  };
  return Object.assign(relay, { faults });
}

async function startHarness(slug = 'notes') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-appload-'));
  const { srv, state, port } = await startServer({ dir });
  const relay = makeRelay(port, slug);
  return {
    dir, state, relay, port,
    file: (rel) => path.join(dir, 'data', slug, rel),
    put: (rel, obj) => { const f = path.join(dir, 'data', slug, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; },
    stop: () => new Promise((r) => srv.close(r)).then(() => assert.deepEqual(relay.faults, [], 'the shell broker answered every request cleanly')),
  };
}

// ── DOM + component stubs (UI only — every rule that decides an outcome is the real one) ──────
const fakeCtx = () => new Proxy({}, { get: (t, k) => (k in t ? t[k] : (t[k] = () => {})), set: (t, k, v) => { t[k] = v; return true; } });
// ── media queries, evaluated for real ─────────────────────────────────────────────────────
// A `matchMedia` stub that always answers `true` (or always `false`) would make every
// viewport-gated assertion pass without testing anything — the R14 vacuous-success shape, and
// exactly the trap for a feature whose whole contract is "this must NOT appear on a phone".
// So this parses the subset the app actually uses and ANSWERS FROM THE GIVEN VIEWPORT.
// Unsupported syntax throws rather than guessing: a query this cannot parse must fail loudly,
// not silently report a convenient answer.
const MQ_FEATURE = /^\(\s*(min|max)-(width|height)\s*:\s*(\d+(?:\.\d+)?)px\s*\)$/;
// `(pointer: coarse|fine)` — what the PRIMARY pointer is. Answered from an explicit harness
// input, never inferred from the viewport: a narrow window on a laptop is still a mouse, and a
// large tablet is still a finger, so deriving one from the other would make the very distinction
// under test unobservable.
const MQ_POINTER = /^\(\s*pointer\s*:\s*(coarse|fine|none)\s*\)$/;
function mediaMatches(query, w, h, pointer = 'fine') {
  const q = String(query || '').trim();
  if (!q) throw new Error('matchMedia: empty query');
  return q.split(/\s+and\s+/).every((partRaw) => {
    const part = partRaw.trim();
    const p = MQ_POINTER.exec(part);
    if (p) return p[1] === pointer;
    const m = MQ_FEATURE.exec(part);
    if (!m) throw new Error(`matchMedia: unsupported query part ${JSON.stringify(part)} — teach helpers-app.mjs this feature rather than letting it answer by accident`);
    const [, bound, axis, nRaw] = m;
    const n = Number(nRaw), actual = axis === 'width' ? w : h;
    return bound === 'min' ? actual >= n : actual <= n;
  });
}

function fakeEl(id) {
  const cls = new Set();
  return {
    id, textContent: '', innerHTML: '', value: '', style: {}, dataset: {}, children: [], childNodes: [], _cls: cls,
    classList: {
      add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)),
      contains: (c) => cls.has(c),
      toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; if (want) cls.add(c); else cls.delete(c); return want; },
    },
    appendChild() {}, removeChild() {}, remove() {}, focus() {}, scrollIntoView() {}, dispatchEvent() {},
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null,
    querySelector: () => null, querySelectorAll: () => [], closest: () => null, cloneNode: () => fakeEl(id),
    getContext: () => fakeCtx(), getBoundingClientRect: () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 320, height: 480 }),
    insertAdjacentHTML() {}, matches: () => false,
  };
}
function scopeProxy(obj) {
  return new Proxy(obj, {
    has: () => true,
    get: (t, k) => (k === Symbol.unscopables ? undefined : (k in t ? t[k] : globalThis[k])),
    set: (t, k, v) => { t[k] = v; return true; },
  });
}

// Run one app for real. `exports` is the list of names the test needs back out of its scope.
// `mutate` (mutation testing only) rewrites the app's OWN source before it runs, to re-introduce a
// defect and prove the assertions around it can fail. It must actually change something.
const CLAMP_LONG_MS = 5000;      // at or above this a timer is a DEADLINE, not a debounce
// Deadlines are shortened too — a test that proves "a reply that never comes is a FAILURE"
// must not sit through the production 20s — but to 1.5s, not 40ms. 40ms made a save that
// merely took 60ms under the 74-file parallel suite look like a timeout (13 spurious
// failures that all passed when the file ran alone). A local round-trip is tens of ms, so
// this keeps ~25x headroom while cutting each deadline wait from 20s to 1.5s.
const CLAMP_DEADLINE_MS = 1500;
// viewportWidth/Height drive innerWidth/innerHeight AND matchMedia together, so a test cannot
// accidentally assert a gate against one while the app reads the other. Default 1024x768 =
// iPad landscape: wide enough that a viewport-gated feature is ON unless a test says otherwise,
// which keeps an unreachable branch visible instead of silently never running.
// `pointer` defaults to 'fine' (a mouse). An app that behaves differently on touch must be run
// again with pointer:'coarse' — the default is the desktop case so a touch-only branch cannot
// pass by accident under a viewport that merely looks tablet-sized.
function runApp(appKey, relay, exports, { clampTimers = false, mutate = null, viewportWidth = 1024, viewportHeight = 768, pointer = 'fine', globals = {} } = {}) {
  const src = mutated(scriptOf(APP_SRC[appKey]), mutate, appKey);
  const els = new Map();
  const getEl = (id) => { if (!els.has(id)) els.set(id, fakeEl(id)); return els.get(id); };
  // prefs: the device prefs a host reads through PANote.prefs() (openAi, default false, as the
  // engine's own PREFS starts). A test flips captured.prefs.openAi to play the shell's push.
  const captured = { pads: [], chats: [], drawers: [], panels: [], splits: [], notice: getEl('pa-notice'), prefs: { openAi: false } };
  // Every 'message' listener, as a real window keeps them: the app's broker AND a component's (PAInkAnchor
  // listens for the shell's fontScale push). One slot here let the last registration eat the broker's replies.
  const onMessages = [];
  const PANoteStub = {
    LOAD: ENG.LOAD, LOAD_TXT: ENG.LOAD_TXT, saveOutcome: ENG.outcomeOf, pickRicher: ENG.pickRicher,
    contentSize: ENG.census, SAVE_TIMEOUT_MS: ENG.SAVE_TIMEOUT_MS, SAVE_TXT: ENG.SAVE_TXT,
    PHOTO_TXT: ENG.PHOTO_TXT, UPLOAD_MAX_BYTES: ENG.UPLOAD_MAX_BYTES,
    NOT_SAVED: ENG.SAVE_TXT.notSaved, notSavedText: ENG.notSavedText,
    NEW_NOTE_LABEL: TITLE_API.NEW_NOTE_LABEL, stamp: TITLE_API.stamp, defaultTitle: TITLE_API.defaultTitle,
    prefs: () => ({ ...captured.prefs }),
    ink: ENG_INK, palette: ENG_PALETTE,
    // The UI is stubbed; the SAVE GUARD is the engine's real one, wired exactly as
    // web/note-ui.inline.html wires it (write→opts.save(nb) with the WHOLE notebook, noteKey from
    // the app's own closure, startLocked). reload() mirrors the engine's pull(): flush the OUTGOING
    // note, reset, let the app repoint its closures, load, then lock on `failed` and seed otherwise.
    fullscreen(opts) {
      const states = [];
      const guard = GUARD.makeSaveGuard({
        serialize: () => pad.nb,
        write: (nb) => (opts.save ? opts.save(nb) : { ok: true }),
        noteKey: () => (opts.noteKey ? String(opts.noteKey() || '') : ''),
        startLocked: true,
        onState: (s) => { states.push(s); },
      });
      let pullSeq = 0;                                       // mirrors the engine's own pull sequence
      const pad = {
        opts, guard, states, lastLoad: null,
        nb: null,
        touchPage: () => { guard.touch(); },
        async reload(applyScope) {
          const flushed = await guard.flush();                 // the OUTGOING note, under its OLD scope
          guard.reset();
          if (applyScope) await applyScope();
          // Claim this pull exactly where the engine's pull() does (`const seq=++pullSeq`).
          // OVERLAPPING PULLS ARE ORDINARY, not exotic: boot sets S.entries and only THEN awaits
          // pad.open(), so anything that opens a note while boot is still loading — a test, or a
          // user tapping the drawer — has two loads in flight. The engine settles that with
          // `if(seq!==pullSeq) return out`: the NEWEST pull owns the pad, whatever order the
          // responses come back in. Without that guard here the OLDER response won and replaced
          // pad.nb with pre-edit content, so a test would see strokes it had already saved to disk
          // missing from memory — a failure the shipped engine cannot produce. That was the
          // ~1-in-6 suite flake in note-whole-file (d). A mock that drops a real guard invents
          // bugs as readily as it hides them.
          const seq = ++pullSeq;
          let out;
          try { out = ENG.LOAD.normalize(opts.load ? await opts.load() : ENG.LOAD.absent()); }
          catch (e) { out = ENG.LOAD.failed(e, 'load_threw'); }
          if (seq !== pullSeq) return flushed;                  // a newer pull owns the pad now
          pad.lastLoad = out;
          if (out.status === 'failed') { guard.lock(out.error, out.code); return flushed; }
          // The same shape freshNotebook() produces in the engine (template + bgColor included):
          // a stub notebook missing them would make every file this app writes look wrong.
          pad.nb = (out.data && Array.isArray(out.data.pages) && out.data.pages.length) ? out.data
            : { v: 2, id: 'nb', created: 1, updated: 1, template: 'ruled', bgColor: '#fdfdfb', pages: [{ id: 'p0', created: 1, updated: 1, strokes: [], pageHtml: '', images: [] }] };
          guard.seed(pad.nb, true);
          return flushed;
        },
        async open(applyScope) { return pad.reload(applyScope); },
        async hide() { return guard.flush(); },
        async flush() { return guard.flush(); },
        isOpen: () => false, setTitle() {}, flash() {}, redraw() {}, resize() {},
        reveals: [], reveal(at) { pad.reveals.push(at); return Promise.resolve(true); },   // a search hit's {page,boxes,terms}: recorded, so a host test can prove it was forwarded (phase 3)
        markDirty: () => guard.touch(),
        saveState: () => guard.state(), loadState: () => ({ status: pad.lastLoad && pad.lastLoad.status, locked: guard.state().locked }),
        retryLoad: () => pad.reload(),
        // The real guard retries a failed write for as long as the pad lives. A test that leaves
        // one failing must stop it, or its timers keep the runner alive for ever (the engine's own
        // destroy() ends with guard.stop() for the same reason).
        destroy: () => guard.flushDurable().finally(() => guard.stop()),
        stopGuard: () => guard.stop(),
      };
      captured.pads.push(pad);
      return pad;
    },
    // panel(): the SAME pad, hosted in a split slot instead of a full-screen overlay. It shares
    // fullscreen()'s engine wiring deliberately — the save guard is the part that must not diverge
    // between hosts (a second, laxer stub is how a lost-update bug would hide). `host` is recorded
    // so a test can prove which slot the pad was mounted into.
    panel(opts) { const pad = PANoteStub.fullscreen(opts); pad.hosted = 'panel'; captured.panels.push({ kind: 'note', pad, opts }); return pad; },
    mount(host, opts) { return PANoteStub.fullscreen(opts); },
  };
  const PAChatStub = {
    fullscreen(opts) { const c = { opts, open() {}, hide() {}, showList() {}, closeList() {}, setActiveNote() {}, getConvo: () => null, openConvo() {}, remeasure() {} }; captured.chats.push(c); return c; },
    // panel(): counts remeasure() calls, because the ONE thing a resizable host must do and a
    // fixed overlay need not is re-measure — note-ui.inline.html:2272 shows the ResizeObserver
    // returns early on the zero reading BEFORE updating lastW/lastH, so a collapse-and-return to
    // the same width observes nothing. A test asserts this counter moves on expand.
    panel(opts) {
      const c = { opts, hosted: 'panel', remeasures: 0, sent: [],
        open(k) { c.openedKey = k; }, openConvo(id) { c.openedConvo = id; }, newChat() {}, hide() {}, show() {},
        showList() {}, showListOnly() {}, closeList() {}, setActiveNote() {}, getConvo: () => null,
        send(t) { c.sent.push(t); }, prefill(t) { c.prefilled = t; },
        remeasure() { c.remeasures++; } };
      captured.chats.push(c); captured.panels.push({ kind: 'chat', chat: c, opts }); return c;
    },
    listDrawer(opts) { const d = { opts, open() {}, isOpen: () => false, refresh() {}, setActive() {} }; captured.drawers.push(d); return d; },
  };
  // PASplit stub: records the rail's state machine. Every expand/drag-end MUST re-measure its
  // slots, so this forwards to whatever api a slot registered rather than pretending it happened.
  const PASplitStub = {
    _rail: null,
    open(opts) {
      const slots = (opts && opts.slots) || [];
      const rail = {
        opts, slots, ratio: (opts && opts.ratio) || 0.32, opened: true,
        collapsed: new Set(slots.filter((sl) => sl.collapsed).map((sl) => sl.key)),
        hosts: Object.fromEntries(slots.map((sl) => [sl.key, fakeEl('slot-' + sl.key)])),
        apis: {},
        register(key, api) { rail.apis[key] = api; },
        // Unconditional: see note-ui.inline.html:2272 — returning to a previously-seen width is
        // scored as "no real change" by the observer, so the host must not rely on it.
        remeasure(key) { const a = rail.apis[key]; if (!a) return; if (a.resize) a.resize(); if (a.remeasure) a.remeasure(); },
        expand(key) { rail.collapsed.delete(key); rail.remeasure(key); },
        collapse(key) { rail.collapsed.add(key); },
        isCollapsed: (key) => rail.collapsed.has(key),
        setTitle(key, t) { rail.titles = { ...rail.titles, [key]: String(t || '') }; },   // the real rail's pane title
        setRatio(r) { rail.ratio = r; Object.keys(rail.apis).forEach((k) => rail.remeasure(k)); },
        open() { rail.opened = true; },          // the real rail's open(): the Journal calls it before expanding a slot
        close() { rail.opened = false; },
        isOpen: () => rail.opened,
      };
      slots.forEach((sl) => { if (sl.mount) sl.mount(rail.hosts[sl.key], rail); });
      PASplitStub._rail = rail; captured.splits.push(rail); return rail;
    },
    close() { if (PASplitStub._rail) PASplitStub._rail.close(); },
    isOpen: () => !!(PASplitStub._rail && PASplitStub._rail.opened),
  };
  const sandbox = {
    PANote: PANoteStub, PAChat: PAChatStub, PASplit: PASplitStub,
    document: {
      getElementById: getEl, createElement: (t) => fakeEl(t), createTextNode: () => ({}),
      querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
      body: fakeEl('body'), createRange: () => ({ createContextualFragment: () => ({}) }),
      createTreeWalker: () => ({ nextNode: () => null }), execCommand: () => true,
      implementation: { createHTMLDocument: () => ({ body: fakeEl('doc') }) },
      visibilityState: 'visible',
      documentElement: fakeEl('html'),
    },
    window: {
      addEventListener: (t, f) => { if (t === 'message') onMessages.push(f); },
      removeEventListener() {}, visualViewport: null, getSelection: () => null,
      innerWidth: viewportWidth, innerHeight: viewportHeight,
      // Answers from the viewport this run was given (see mediaMatches). An always-true stub here
      // would make "the rail must not appear on a phone" pass on a phone.
      matchMedia: (q) => ({ media: q, matches: mediaMatches(q, viewportWidth, viewportHeight, pointer),
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    },
    parent: {
      postMessage: (m) => {   // only a request is answered, as the shell's broker answers only pa:'req'
        if (m && m.pa === 'req') Promise.resolve(relay(m)).then((r) => { for (const f of onMessages) f({ data: { pa: 'res', id: m.id, ...r } }); });
      },
    },
    // Bare `innerWidth` / `matchMedia` resolve through scopeProxy to globalThis otherwise, which is
    // Node's real global — a viewport the test never chose. Shadow them at sandbox level too.
    innerWidth: viewportWidth, innerHeight: viewportHeight,
    matchMedia: (q) => ({ media: q, matches: mediaMatches(q, viewportWidth, viewportHeight, pointer),
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    location: { hash: '' }, navigator: { userAgent: 'node' }, devicePixelRatio: 1,
    FileReader: class { readAsDataURL() { this.onload && this.onload(); } },
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    Event: class { constructor(t) { this.type = t; } },
    // The deadline VALUE is asserted separately (see "the load deadline is defensible"); clamping
    // only makes the SAME Promise.race resolve sooner so a 20s timeout is testable in a suite.
    // Clamp SHORT timers only — debounces and UI delays. A LONG timer is a deadline
    // (SAVE_TIMEOUT_MS = 20s), and compressing that to 40ms makes a save that merely took
    // 60ms on a loaded machine look like a timeout: it passed when the file ran alone and
    // failed 13 tests under the 74-file parallel suite. Leaving deadlines alone is free now
    // that the data core clears its timer when the load wins the race.
    setTimeout: clampTimers
      ? ((fn, ms, ...a) => setTimeout(fn, (ms || 0) >= CLAMP_LONG_MS ? CLAMP_DEADLINE_MS : Math.min(ms || 0, 40), ...a))
      : setTimeout,
  };
  if (APP_SRC[appKey].includes(VERSE_MARKS_MARKER) && !globals.PAVerseMarks) {
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'setTimeout', scriptOf(VERSE_MARKS))(sandbox.window, sandbox.document, sandbox.setTimeout);
    sandbox.PAVerseMarks = sandbox.window.PAVerseMarks;
  }
  if (APP_SRC[appKey].includes(INK_ANCHOR_MARKER) && !globals.PAInkAnchor) {
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'setTimeout', scriptOf(INK_FRAME) + '\n' + scriptOf(INK_ANCHOR))(sandbox.window, sandbox.document, sandbox.setTimeout);
    sandbox.PAInkAnchor = sandbox.window.PAInkAnchor;
  }
  if (APP_SRC[appKey].includes(INK_PEN_MARKER) && !globals.PAInkPen) {
    // Its own view of the window that carries PANote (the palette, the save deadline), as the served page's does.
    const win = Object.assign(Object.create(sandbox.window), { PANote: PANoteStub });
    // eslint-disable-next-line no-new-func
    // PAAppPrefs first: chat-ui (the Bible carries PA_CHAT_UI) carries its marker, and the pen keeps its choice through it.
    // eslint-disable-next-line no-new-func
    new Function('window', 'parent', 'setTimeout', 'clearTimeout', APP_PREFS_SRC)(win, sandbox.parent, sandbox.setTimeout, clearTimeout);
    new Function('window', 'document', 'setTimeout', 'parent', scriptOf(INK_PEN))(win, sandbox.document, sandbox.setTimeout, sandbox.parent);
    sandbox.PAInkPen = win.PAInkPen;
  }
  if (APP_SRC[appKey].includes(READING_HISTORY_MARKER) && !globals.PAReadingHistory) {
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', scriptOf(READING_HISTORY))(sandbox.window, sandbox.document);
    sandbox.PAReadingHistory = sandbox.window.PAReadingHistory;
  }
  Object.assign(sandbox, globals);
  // eslint-disable-next-line no-new-func
  const fn = new Function('__scope', `with(__scope){${src}\n;return {${exports.join(',')}};}`);
  const out = fn(scopeProxy(sandbox));
  // defineProperties, NOT {...out}: spreading INVOKES every getter once and copies the value, so
  // a `get ANN_BLOCKED(){…}` export would freeze at its boot-time value and every assertion about
  // it would read a stale snapshot. (That mistake made this harness pass a test it should fail.)
  return Object.defineProperties(out, {
    captured: { value: captured },
    // TODO: a test that fails before calling stopPads() leaves a pad's write retry running, and with it
    // the file's process (seen in app-load under a broker that throws); register pads for an after() hook.
    stopPads: { value: () => captured.pads.forEach((p) => p.stopGuard()) },
    els: { value: els },
    noticeText: { value: () => captured.notice.textContent },
    noticeOn: { value: () => captured.notice.classList.contains('on') },
  });
}

export { ROOT, ENGINE, SHELL, CHAT, SPLIT, PRINT, APPS, APP_SRC, between, stripComments, scriptOf, servedScriptOf, mediaMatches,
  ENG, ENG_INK, ENG_PALETTE, engineModule, inkModule, mutated, TITLE_API, GUARD, guardModule, coreModule, startServer, makeRelay, startHarness, settle, until, deferred, runApp,
  fakeEl, scopeProxy };
