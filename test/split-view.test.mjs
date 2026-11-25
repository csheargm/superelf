// PASplit — the shared right-hand rail (split view · 分屏).
//
// The rail exists so an app can put a chat BESIDE its content instead of over it. Three
// properties carry real risk and each is tested behaviourally, by running the component, not by
// grepping its source:
//   1. it must NEVER appear on a phone — in either orientation (the whole user requirement);
//   2. expanding a collapsed slot must RE-MEASURE it, because the note engine's ResizeObserver
//      provably will not (note-ui.inline.html:2272 returns on the zero reading BEFORE updating
//      lastW/lastH, so collapse→expand back to the same width observes nothing);
//   3. it must touch no client-side storage — an app runs at an opaque origin where all of it
//      throws (verified 2026-09-02, note-ui.inline.html:2284-2290).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, mediaMatches, stripComments } from './helpers-app.mjs';

const SRC = fs.readFileSync(path.join(ROOT, 'web', 'split-ui.inline.html'), 'utf8');
const JS = /<script>([\s\S]*)<\/script>/.exec(SRC)[1];
// The push and the window CSS live in PAWin since ADR 0043; PASplit itself has no stylesheet.
const PAW = fs.readFileSync(path.join(ROOT, 'web', 'panel-window.inline.html'), 'utf8');
const CSS = /<style id="paw-style">([\s\S]*?)<\/style>/.exec(PAW)[1];

// ── a DOM just real enough to run the component ──────────────────────────────────────────────
function mkDom({ width = 1366, height = 768 } = {}) {
  const made = [];
  const el = (tag) => {
    const cls = new Set();
    const node = {
      tag, textContent: '', type: '', dataset: {}, style: {
        _p: {}, setProperty(k, v) { this._p[k] = v; }, removeProperty(k) { delete this._p[k]; },
      },
      children: [], attrs: {}, _handlers: {},
      classList: {
        add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)),
        contains: (c) => cls.has(c),
        toggle: (c, on) => { const want = on === undefined ? !cls.has(c) : !!on; if (want) cls.add(c); else cls.delete(c); return want; },
      },
      appendChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); node.children.push(c); c.parentNode = node; return c; },
      // The rail re-parents slots between zones and rebuilds its dividers, so the fake DOM needs
      // the moving parts too — without them a docking test fails as "not a function" rather than
      // on anything about docking.
      insertBefore(c, ref) { const i = node.children.indexOf(ref); node.children.splice(i < 0 ? node.children.length : i, 0, c); c.parentNode = node; return c; },
      removeChild(c) { const i = node.children.indexOf(c); if (i >= 0) node.children.splice(i, 1); c.parentNode = null; return c; },
      setAttribute(k, v) { node.attrs[k] = String(v); },
      getAttribute: (k) => (k in node.attrs ? node.attrs[k] : null),
      addEventListener(t, f) { (node._handlers[t] = node._handlers[t] || []).push(f); },
      removeEventListener(t, f) { node._handlers[t] = (node._handlers[t] || []).filter((x) => x !== f); },
      // A real DOM dispatches BOTH the addEventListener handlers and the on<type> property.
      // Omitting the latter made a working close button look broken, because this codebase
      // assigns `.onclick=` throughout.
      fire(t, ev) {
        const e = { preventDefault() {}, stopPropagation() {}, ...ev };
        (node._handlers[t] || []).slice().forEach((f) => f(e));
        const prop = node['on' + t];
        if (typeof prop === 'function') prop(e);
      },
      parentNode: null,
      setPointerCapture() {}, getBoundingClientRect: () => ({ width: 380, height: 700, left: 0, top: 0 }),
      querySelectorAll: () => [],
    };
    // className and classList are ONE state, as in a real DOM. Keeping them separate (the first
    // version did) meant `el.className='pas-rail'` left classList.contains('pas-rail') false, and
    // tests asserted against whichever half the component happened not to use.
    Object.defineProperty(node, 'className', {
      get: () => [...cls].join(' '),
      set: (v) => { cls.clear(); String(v || '').split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
      enumerable: true,
    });
    made.push(node);
    return node;
  };
  const docEl = el('html');
  const body = el('body');
  const docKeys = {};
  let frontmost = null;   // what document.querySelector('.pac-lb.on, dialog[open]') finds
  const listeners = {};
  // Every MediaQueryList handed out is kept, so a test can ask how many of them are actually
  // LISTENED to — the R3 question ("is the gate watched once?") is about subscriptions, not about
  // how many times matchMedia was called (gateOpen() calls it on every read and subscribes to
  // nothing). `matches` is a live getter: a rotation must change the answer, which is the whole
  // behaviour under test here.
  const mqls = [];
  const win = {
    innerWidth: width, innerHeight: height,
    matchMedia: (q) => {
      const m = {
        media: q, _subs: [],
        get matches() { return mediaMatches(q, win.innerWidth, win.innerHeight); },
        addEventListener(t, f) { if (t === 'change') m._subs.push(f); },
        addListener(f) { m._subs.push(f); },
      };
      mqls.push(m);
      return m;
    },
    addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
    // destroy() takes its resize handler back off. Without this the fake DOM fails with
    // "removeEventListener is not a function", which says nothing about the teardown.
    removeEventListener(t, f) { listeners[t] = (listeners[t] || []).filter((x) => x !== f); },
  };
  return {
    made, docEl, body, win, mqls,
    sandbox: { window: win, document: {
      documentElement: docEl, body, createElement: el,
      // The rail registers an Escape handler while open and asks whether a lightbox/dialog is
      // in front of it before acting on the key.
      _keys: docKeys,
      addEventListener(t, f) { (docKeys[t] = docKeys[t] || []).push(f); },
      removeEventListener(t, f) { docKeys[t] = (docKeys[t] || []).filter((x) => x !== f); },
      querySelector: () => frontmost,
    }, ...win },
    key: (k) => (docKeys.keydown || []).slice().forEach((f) => f({ key: k })),
    setFrontmost: (v) => { frontmost = v; },
    fire: (t, ev) => (listeners[t] || []).forEach((f) => f(ev || {})),
    // How many window listeners of a type are REGISTERED. Needed because onResize starts with
    // `if(!isOpen()) return`, so a leaked listener on a destroyed rail is observably inert —
    // firing resize and counting re-measures passes whether or not it was ever removed. Each
    // rotation would leak another closure over a rail that is no longer in the document.
    winListeners: (t) => (listeners[t] || []).length,
    // A REAL rotation: the viewport changes, window resize fires, and every watched media query
    // re-evaluates. Resize goes first so a gate subscriber that throws cannot mask it.
    rotate: (w, h) => {
      win.innerWidth = w; win.innerHeight = h;
      (listeners.resize || []).slice().forEach((f) => f({}));
      mqls.forEach((m) => m._subs.slice().forEach((f) => f(m)));
    },
  };
}

// A PAWin stand-in that records what the rail asks of each window (the real windows are driven in
// test/panel-window.test.mjs and test/panel-window-e2e.test.mjs).
function fakePAWin(dom) {
  const made = [];
  return { made, create(o) {
    const s = { open: false, min: false, max: false, where: o.dock, title: o.title };
    const w = { o, s, body: dom.sandbox.document.createElement('div'),
      open() { const was = s.open && !s.min; s.open = true; s.min = false; if (!was && o.onVisible) o.onVisible(true); },
      close() { if (!s.open) return; s.open = false; if (o.onVisible) o.onVisible(false); },
      minimize() { s.min = true; if (o.onVisible) o.onVisible(false); },
      maximize() { s.max = true; }, restore() { s.max = false; s.min = false; },
      dock(z) { s.where = z; }, setTitle(t) { s.title = String(t || ''); },
      isVisible: () => s.open && !s.min, state: () => ({ ...s }), destroy() { w.destroyed = true; } };
    made.push(w); return w; } };
}

function loadSplit(dom) {
  if (!dom.win.PAWin) dom.win.PAWin = fakePAWin(dom);
  // `window.PASplit` is how the component publishes itself; give it a real object to attach to.
  new Function('window', 'document', 'matchMedia', JS)(dom.win, dom.sandbox.document, dom.win.matchMedia);
  return dom.win.PASplit;
}

// ── 1. R14 CONTROL — prove this file can fail before trusting anything it asserts ────────────
test('R14 control: the component loads, publishes PASplit, and these tests can actually fail', () => {
  const dom = mkDom();
  const PASplit = loadSplit(dom);
  assert.ok(PASplit, 'PASplit must be published on window — every test below is vacuous otherwise');
  assert.equal(typeof PASplit.open, 'function');
  // The control: a deliberately broken component must NOT satisfy the same assertion.
  const brokenDom = mkDom();
  new Function('window', 'document', JS.replace('window.PASplit={', 'window.NOPE={'))(brokenDom.win, brokenDom.sandbox.document);
  assert.equal(brokenDom.win.PASplit, undefined, 'a component that fails to publish must be observable as such');
});

// ── 2. the phone guarantee ───────────────────────────────────────────────────────────────────
test('the rail NEVER opens on a phone — portrait or landscape', () => {
  const PHONE = [['iPhone portrait', 375, 812], ['iPhone landscape', 852, 393], ['iPad portrait', 768, 1024]];
  const RAIL = [['iPad landscape', 1024, 768], ['laptop', 1366, 768], ['desktop', 1920, 1080]];
  for (const [name, w, h] of PHONE) {
    const dom = mkDom({ width: w, height: h });
    const rail = loadSplit(dom).open({ slots: [{ key: 'chat', mount: () => ({}) }] });
    assert.equal(rail.open(), false, `${name} (${w}x${h}) must be refused`);
    assert.equal(rail.isOpen(), false, `${name}: refused means CLOSED, not merely "returned false"`);
    assert.equal(dom.docEl.classList.contains('pas-open'), false, `${name}: the push class must not be set`);
  }
  for (const [name, w, h] of RAIL) {
    const dom = mkDom({ width: w, height: h });
    const rail = loadSplit(dom).open({ slots: [{ key: 'chat', mount: () => ({}) }] });
    assert.equal(rail.open(), true, `${name} (${w}x${h}) must be admitted`);
    assert.equal(rail.isOpen(), true, `${name}: admitted means open`);
  }
});

// ── 2b. the gate is WATCHED, not read once at boot ───────────────────────────────────────────
// The bug: an app picks its surface at boot with `if(splitOn())`. An iPad booted in portrait
// therefore never gains the rail when it is rotated into landscape — nothing is listening, so the
// decision stands until a reload. The rail already watched the gate to CLOSE itself; an app with
// no rail yet had nothing to watch, and could not add a watch of its own without restating GATE
// (R3). These tests drive real rotations through a live-`matches` media query.
test('an app can watch the gate WITHOUT owning a rail — the boot decision is not final', () => {
  const dom = mkDom({ width: 768, height: 1024 });        // iPad portrait: no rail at boot
  const PASplit = loadSplit(dom);
  assert.equal(PASplit.gateOpen(), false, 'portrait starts below the gate');
  const seen = [];
  const off = PASplit.onGate((on) => seen.push(on));
  dom.rotate(1024, 768);
  assert.deepEqual(seen, [true], 'rotating to landscape reports the gate OPENED');
  dom.rotate(768, 1024);
  assert.deepEqual(seen, [true, false], 'and back to portrait reports it CLOSED');
  off();
  dom.rotate(1024, 768);
  assert.deepEqual(seen, [true, false], 'unsubscribing really stops it — a torn-down host is not told');
});

test('every viewport the user rotates through is reported the same way gateOpen() answers', () => {
  // The four the requirement names. A subscriber that disagreed with gateOpen() would have the app
  // building a rail the rail itself refuses to open.
  for (const [w, h, want] of [[375, 812, false], [852, 393, false], [768, 1024, false], [1024, 768, true]]) {
    const dom = mkDom({ width: 1366, height: 768 });
    const PASplit = loadSplit(dom);
    let last = null;
    PASplit.onGate((on) => { last = on; });
    dom.rotate(w, h);
    assert.equal(PASplit.gateOpen(), want, `${w}x${h}: gateOpen()`);
    assert.equal(last, want, `${w}x${h}: the subscriber is told exactly what gateOpen() answers`);
  }
});

test('ONE matchMedia listener on the gate, however many rails and apps ask (R3)', () => {
  const dom = mkDom({ width: 1366, height: 768 });
  const PASplit = loadSplit(dom);
  PASplit.onGate(() => {});
  PASplit.open({ slots: [{ key: 'a', mount: () => ({}) }] }).open();
  PASplit.open({ slots: [{ key: 'b', mount: () => ({}) }] }).open();
  const watched = dom.mqls.filter((m) => m._subs.length);
  assert.equal(watched.length, 1, `the gate must be watched ONCE; found ${watched.length} listeners`);
  assert.equal(watched[0].media, PASplit.GATE, 'and it is the GATE that is watched, not a lookalike');
});

test('a throwing gate subscriber does not strand the ones after it, and is not swallowed', () => {
  const dom = mkDom({ width: 768, height: 1024 });
  const PASplit = loadSplit(dom);
  const after = [];
  PASplit.onGate(() => { throw new Error('app blew up'); });
  PASplit.onGate((on) => after.push(on));
  assert.throws(() => dom.rotate(1024, 768), /app blew up/,
    'the failure still reaches the page error handler (R5) — it is re-thrown, not logged and dropped');
  assert.deepEqual(after, [true],
    'but every later subscriber ran first: a rail that never hears "closed" keeps pushing the app aside');
});

test("the rail's gate is its OWN, not the drawer dock's 640px", () => {
  // 640 admits iPhone landscape (852 wide) — reusing it would silently put the rail on the phone,
  // which is the one thing this feature must not do. Pinned so a later "simplification" that
  // shares the dock's gate fails here with the reason.
  const PASplit = loadSplit(mkDom());
  assert.ok(!/\b640\b/.test(PASplit.GATE), `the rail must not reuse the 640px dock gate: ${PASplit.GATE}`);
  assert.equal(mediaMatches(PASplit.GATE, 852, 393), false, 'iPhone landscape must fail the gate');
  assert.equal(mediaMatches(PASplit.GATE, 1024, 768), true, 'iPad landscape must pass the gate');
});

// ── 3. the re-measure contract ───────────────────────────────────────────────────────────────
// ── 4. structural guarantees the serve path depends on ───────────────────────────────────────
test('no client-side storage anywhere — it all throws at an opaque origin', () => {
  const code = JS + CSS;
  for (const api of ['localStorage', 'sessionStorage', 'indexedDB', 'document.cookie']) {
    assert.ok(!code.includes(api), `${api} throws SecurityError in a sandboxed app (note-ui.inline.html:2284-2290)`);
  }
});

test('the component never writes its own marker in the replaceable form', () => {
  // web.mjs:507 replaces EVERY occurrence, so a literal <!--PA_SPLIT_UI--> inside this file would
  // be substituted with the file itself. chat-ui and note-ui write theirs bare for the same reason.
  for (const m of ['<!--PA_SPLIT_UI-->', '<!--PA_CHAT_UI-->', '<!--PA_NOTE_UI-->']) {
    assert.ok(!SRC.includes(m), `split-ui must not contain the literal marker ${m}`);
  }
  assert.ok(SRC.includes('PA_SPLIT_UI'), 'but it must still name its marker, bare, for a reader');
});

test('web.mjs serves the component, and appends it LAST', () => {
  const web = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  assert.match(web, /const PA_SPLIT_MARKER = '<!--PA_SPLIT_UI-->';/);
  const list = /const PA_COMPONENTS = \[([\s\S]*?)\];/.exec(web)[1];
  const order = [...list.matchAll(/file: '([^']+)'/g)].map((m) => m[1]);
  // The inlining loop re-tests ALREADY-INLINED html for each remaining marker, so a component
  // whose source contains a later component's marker would pull it in. Appending makes that
  // impossible. split-ui must therefore stay ahead of everything added after it, and this list
  // grows at the END — never in the middle.
  assert.deepEqual(order.slice(0, 3), ['chat-ui.inline.html', 'note-ui.inline.html', 'split-ui.inline.html'],
    'the first three are in their established order');
  // Which component is currently last is pinned by THAT component's own test, not here. Naming it
  // in this file meant every legitimately appended component failed an unrelated suite on its
  // first commit — the assertion tested the calendar, not the invariant.
  assert.equal(order.indexOf('split-ui.inline.html'), 2,
    'split-ui never moves: the list grows at the END, never in the middle');
  // The ordering constraint that is actually load-bearing, not just conventional: chat-ui now
  // CARRIES the PAPhoto marker, and the loop resolves each marker against the already-inlined
  // html. Register photo-ui before chat-ui and it is never reached — the component is not served
  // and the marker survives as a dead comment (verified by composing the real Bible page both
  // ways). Any future component that another component references must obey the same rule.
  assert.ok(order.indexOf('photo-ui.inline.html') > order.indexOf('chat-ui.inline.html'),
    'photo-ui must come AFTER chat-ui, which carries its marker');
});

test('an empty rail is refused rather than pushing the app aside for nothing', () => {
  const PASplit = loadSplit(mkDom());
  assert.throws(() => PASplit.open({ slots: [] }), /no slots/);
});

// ── PAChat.panel() / PANote.panel() ──────────────────────────────────────────────────────────
// Extracted and RUN, not grepped — the same technique test/chat-pill-reserve.test.mjs uses on
// fullscreen(). A factory that is only source-matched can be structurally present and still hand
// back an object that does nothing.
const CHAT_SRC = fs.readFileSync(path.join(ROOT, 'web', 'chat-ui.inline.html'), 'utf8');
const NOTE_SRC = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');

function loadPanel(src, engineName, engine) {
  const from = src.indexOf(`    panel:(opts)=>{`);
  assert.ok(from > 0, 'panel() must stay one contiguous block');
  const to = src.indexOf('\n    }\n  };', from);
  const body = src.slice(from, to + '\n    }'.length);
  const mkEl = () => ({
    className: '', style: { cssText: '' }, children: [],
    appendChild(c) { this.children.push(c); return c; },
  });
  const doc = { createElement: mkEl };
  // eslint-disable-next-line no-new-func
  return new Function('document', engineName, `return ({${body}}).panel;`)(doc, engine);
}

test('panel() refuses to mount with no host instead of silently rendering nothing', () => {
  // The R14 shape: a factory that returns a working-looking object while painting nowhere.
  for (const [src, name] of [[CHAT_SRC, 'Chat'], [NOTE_SRC, 'Note']]) {
    const panel = loadPanel(src, name, () => ({}));
    assert.throws(() => panel({}), /no host/, `${name}.panel must reject a missing host`);
  }
});

test('PAChat.panel gives its host a resolved box — .pac is height:100% and nothing else supplies it', () => {
  let gotHost = null;
  const panel = loadPanel(CHAT_SRC, 'Chat', (host) => { gotHost = host; return { open: () => {}, remeasure: () => {} }; });
  const slot = { children: [], appendChild(c) { this.children.push(c); return c; } };
  panel({ host: slot });
  assert.equal(slot.children.length, 1, 'the panel mounts INTO the slot it was given');
  assert.match(gotHost.style.cssText, /position:absolute/);
  assert.match(gotHost.style.cssText, /inset:0/);
  assert.match(gotHost.style.cssText, /background:/, 'opaque: .pac-fs supplies the background for fullscreen, nothing does for a panel');
});

test('PAChat.panel RETURNS its open promise — the rail auto-sends after opening and must await it', () => {
  // fullscreen() drops these promises (`open:(k)=>{ show(); api.open(k); }`), which is survivable
  // for a surface a human just tapped. It is not survivable for an auto-send.
  const opened = [];
  const panel = loadPanel(CHAT_SRC, 'Chat', () => ({
    open: (k) => { opened.push(k); return Promise.resolve('opened:' + k); },
    openConvo: (id) => Promise.resolve('convo:' + id),
    newChat: () => Promise.resolve('new'),
    showList: () => {}, remeasure: () => {},
  }));
  const p = panel({ host: { appendChild() {} } });
  assert.equal(typeof p.open('v3').then, 'function', 'open() must return a thenable');
  assert.equal(typeof p.openConvo('c1').then, 'function', 'openConvo() must return a thenable');
  assert.equal(typeof p.newChat().then, 'function', 'newChat() must return a thenable');
  assert.deepEqual(opened, ['v3']);
});

test('PAChat.panel re-exposes remeasure and showListOnly', () => {
  let remeasured = 0, listed = 0;
  const panel = loadPanel(CHAT_SRC, 'Chat', () => ({
    open: () => {}, showList: () => { listed++; }, remeasure: () => { remeasured++; },
  }));
  const p = panel({ host: { appendChild() {} } });
  assert.equal(typeof p.remeasure, 'function', 'a resizable host MUST be able to re-measure; a fixed overlay never needs to');
  p.remeasure(); assert.equal(remeasured, 1);
  // showListOnly opens the ☰ drawer WITHOUT revealing a chat surface. test/drawer-selection.test.mjs
  // forbids an app calling .showList() for exactly that reason (the drawer-opens-a-new-chat bug).
  assert.equal(typeof p.showListOnly, 'function');
  p.showListOnly(); assert.equal(listed, 1);
});

test('PANote.panel re-measures on open and on show, and hide() still flushes', async () => {
  let resizes = 0; const flushes = [];
  const panel = loadPanel(NOTE_SRC, 'Note', () => ({
    reload: async () => 'reloaded', resize: () => { resizes++; },
    flush: async () => { flushes.push(1); return 'flushed'; },
  }));
  const p = panel({ host: { appendChild() {} } });
  assert.equal(await p.open(), 'reloaded');
  assert.equal(resizes, 1, 'open() re-measures — a pad mounted into a collapsed slot measured 0');
  p.show(); assert.equal(resizes, 2, 'show() re-measures too');
  assert.equal(await p.hide(), 'flushed', 'hide() is "I am stepping away" — it must make the work durable');
  assert.equal(flushes.length, 1);
});

test('panel() sits OUTSIDE the window chat-pill-reserve slices and evaluates', () => {
  // That test slices from `fullscreen:(opts)=>{` to the listDrawer comment and runs the result
  // with new Function. Anything landing between them is silently executed as part of fullscreen.
  const from = CHAT_SRC.indexOf('    fullscreen:(opts)=>{');
  const to = CHAT_SRC.indexOf('// A STANDALONE slide-in list drawer', from);
  assert.ok(from > 0 && to > from, 'the slice window still exists');
  assert.ok(!CHAT_SRC.slice(from, to).includes('panel:(opts)=>{'),
    'panel() must not be inside the fullscreen slice window');
  assert.ok(CHAT_SRC.indexOf('    panel:(opts)=>{') > to, 'panel() belongs after the listDrawer block');
});

// ── the Bible's wiring ───────────────────────────────────────────────────────────────────────
// Read from the COMMITTED template, not the live app: workspace/ is gitignored (.gitignore:14),
// so a fresh clone has no live app and a test that read it would fail there for a reason that has
// nothing to do with the code under review. Several existing tests solve this with `catch{return}`
// — which passes VACUOUSLY on any machine without the live workspace, i.e. the reviewer's.
//
// The live app is checked TOO where it exists, so the two cannot drift; it is simply not the
// source of truth for whether the suite can run.
const BIBLE = fs.readFileSync(path.join(ROOT, 'workspace.example', 'apps', 'bible', 'index.html'), 'utf8');
const LIVE_BIBLE_PATH = path.join(ROOT, 'workspace', 'apps', 'bible', 'index.html');
const LIVE_BIBLE = fs.existsSync(LIVE_BIBLE_PATH) ? fs.readFileSync(LIVE_BIBLE_PATH, 'utf8') : null;

test('the live Bible carries the same split wiring as the template, where it exists', () => {
  if (!LIVE_BIBLE) {
    // Not a silent skip: say so, and assert the reason is the one we expect rather than a typo.
    assert.ok(!fs.existsSync(path.join(ROOT, 'workspace', 'apps')),
      'workspace/apps exists but the bible app is missing — that is a real problem, not an absent workspace');
    return;
  }
  for (const needle of ['function convoIdFor(k)', 'function shouldExplain(k,force)', 'async function askAI(opts)',
                        'const splitOn=', 'PASplit.open(', '<!--PA_SPLIT_UI-->', 'EXPLAIN_PROMPT',
                        'function longPressVerse(n,el)', 'LONG_PRESS_MS']) {
    assert.ok(LIVE_BIBLE.includes(needle), `the live Bible is missing ${needle} — it has drifted from the template`);
  }
});

test('"does this verse already have a thread?" has exactly ONE definition', () => {
  // Two copies of this expression is how the rail would re-ask over an existing conversation, or
  // stay silent on a genuinely new one. PAChat consumes it as getConvoId; the auto-explain
  // consumes it to decide freshness. Both must read the same source.
  const defs = BIBLE.match(/k==='general' \? GEN\.chat : \(ANN\.chat\|\|\{\}\)\[k\]/g) || [];
  assert.equal(defs.length, 1, 'the convo-id expression must appear once, in convoIdFor');
  assert.match(BIBLE, /function convoIdFor\(k\)\{ return k==='general' \? GEN\.chat : \(ANN\.chat\|\|\{\}\)\[k\]; \}/);
  assert.match(BIBLE, /getConvoId:convoIdFor,/, 'getConvoId delegates rather than restating it');
  assert.match(BIBLE, /!convoIdFor\(k\)/, 'and freshness is decided by the same function');
});

test('the explain prompt is auto-sent ONLY for a genuinely fresh thread', () => {
  const fn = /function shouldExplain\(k,force\)\{([\s\S]*?)\n\}/.exec(BIBLE);
  assert.ok(fn, 'shouldExplain exists as a named, testable unit');
  const body = fn[1];
  // Each of these is a distinct way the auto-send would fire when it must not.
  assert.match(body, /_booted/, 'not before the boot load resolves — ANN.chat is empty until then');
  assert.match(body, /!ANN_BLOCKED/, 'not on an unreadable chapter — a failed READ is not a fresh thread (R14)');
  assert.match(body, /!selV\.size/, 'not with no verse selected — there is nothing to explain');
  assert.match(body, /!convoIdFor\(k\)/, 'and never over an existing conversation');
  // _booted must actually be set by the boot path, or the guard is permanently closed.
  assert.match(BIBLE, /load\(\)\.then\(ok=>\{ _booted=true;/, '_booted is set when the chapter load resolves');
  assert.match(BIBLE, /let rail=null, railChat=null, _booted=false;/, 'and starts false');
});

test('a discarded auto-send is REPORTED, not rendered as an empty pane', () => {
  // PAChat drops a send while a turn is streaming. Programmatic sends have no human watching the
  // composer, so an unreported drop looks exactly like the model answering with nothing (R5).
  assert.match(BIBLE, /await railChat\.send\(msg\)===false/, 'the result is AWAITED and checked');
  assert.match(BIBLE, /正在回答中 · Still answering/, 'and the user is told why nothing appeared');
  // The contract that makes the check meaningful lives in the component.
  assert.match(CHAT_SRC, /if\(sending\) return false;/, 'send() reports a refusal');
  assert.match(CHAT_SRC, /return true;\s*\/\/ the turn RAN/, 'and reports a delivery');
});

test('below the gate the Bible takes TODAY\'s path, with no rail code in it', () => {
  const fn = /async function askAI\(opts\)\{([\s\S]*?)\n\}/.exec(BIBLE);
  assert.ok(fn, 'askAI exists');
  const early = fn[1].slice(0, fn[1].indexOf('ensureRail'));
  assert.match(early, /if\(!splitOn\(\)\)\{ aiChat\.open\(k\); return; \}/,
    'the narrow path is one line and returns BEFORE anything rail-related runs');
  assert.match(BIBLE, /const splitOn=\(\)=>!!\(window\.PASplit&&PASplit\.available&&PASplit\.gateOpen\(\)\)/,
    'and it is guarded on PASplit existing at all, for an app page served without the marker');
});

test('the rail never receives the full-screen SURFACE hooks', () => {
  // onShow tears down the draw pad because a full-screen chat COVERS it. In a split view the pad
  // is a sibling and dismissing it is simply wrong — this is the bug the data/surface split exists
  // to prevent, so it is asserted rather than left to review.
  const railMount = /mount:\(host,r\)=>\{([\s\S]*?)return railChat;/.exec(BIBLE);
  assert.ok(railMount, 'the rail mounts a chat panel');
  // Comments stripped first: the block carries a comment EXPLAINING why onShow/onClose are absent,
  // and a bare text search matched that explanation and called it a violation.
  const code = stripComments(railMount[1]);
  // The rail has its OWN onShow (it expands the chat slot when a ☰ row is tapped). What it must
  // never carry is the FULL-SCREEN body, which dismisses the draw pad — correct when the chat
  // covers the app, wrong when the pad is sitting beside it.
  assert.match(code, /onShow:\(\)=>\{ r\.open\(\); r\.expand\('chat'\); \}/, 'the rail reveals its own chat slot');
  assert.ok(!/drawPad\.hide\(\)/.test(code), 'and never the full-screen onShow body');
  // onClose IS supplied here, and deliberately so: the rail's version closes the RAIL, while the
  // full-screen version re-asserts the active note behind a closing overlay. Same hook name,
  // genuinely different jobs — which is the whole reason surface hooks are written per host
  // rather than shared. What must never happen is the full-screen body being reused.
  assert.ok(!/setActiveNote/.test(code), 'and not the full-screen onClose body');
  // Either shape: the rail's onClose acts on the RAIL, whether that means closing it or
  // collapsing its chat slot. The live app now collapses — which reveals PAChat's own ✕ — and a
  // sibling assertion in this file already accepts both. What must never appear here is the
  // FULL-SCREEN onClose body, which is the line below.
  assert.match(code, /onClose:\(\)=>r\.(close\(\)|collapse\('chat'\))/, 'the rail closes or collapses ITSELF');
  assert.match(code, /chatData/, 'but it DOES share every data hook (R3)');
  // And the shared object is a real single source, not a copy.
  assert.match(BIBLE, /const chatData=\{/);
  assert.match(BIBLE, /PAChat\.fullscreen\(Object\.assign\(\{\}, chatData, \{/, 'the full-screen host builds from the same object');
});

test('the Bible mounts exactly ONE PANote — two would lose each other\'s handwriting', () => {
  // _drawScope is a single app-level variable read by the save closure WHEN IT RUNS, and a save
  // writes the whole chapter. Two pads cannot show different notes and their independent debounces
  // race.
  // AT MOST one, not exactly one: zero is not a defect for this rule. Both the template and the
  // live app carry the PA_NOTE_UI marker and mount one, PANote.panel or PANote.fullscreen, one per
  // mountHost(). Two is the defect, in either file.
  for (const [label, src] of [['template', BIBLE], ['live', LIVE_BIBLE]]) {
    if (!src) continue;
    const mounts = (src.match(/PANote\.(fullscreen|panel|mount)\s*\(/g) || []);
    // Two CALLS are fine; two PADS are not. The app names both hosts, in the two branches of one
    // if/else on splitOn(), so exactly one ever runs. Counting occurrences in the source would
    // either fail on correct code (as it first did) or, loosened to <=2, stop catching a genuine
    // second pad — so assert the STRUCTURE that makes them exclusive.
    if (mounts.length > 1) {
      // The fork moved INSIDE mountHost(wide) when the host stopped being a boot-time decision
      // (an iPad rotated into landscape has to gain the rail). The shape that matters is unchanged
      // and is what this asserts: one if/else, one pad in each arm, none anywhere else.
      const host = /\nfunction mountHost\(wide\)\{\n([\s\S]*?)\n\}\n/.exec(src);
      assert.ok(host, `${label}: ${mounts.length} PANote hosts but no mountHost() to make them exclusive`);
      const fork = /if\(wide\)\{([\s\S]*?)\n  \} else \{([\s\S]*?)\n  \}/.exec(host[1]);
      assert.ok(fork, `${label}: mountHost has no if/else fork — the two pads are not exclusive`);
      // …and the arm that runs is chosen by the GATE, not by anything else.
      assert.match(src, /_wide=splitOn\(\);\s*\n\s*mountHost\(_wide\);/,
        `${label}: the boot mount must be driven by splitOn()`);
      const [, wide, narrow] = fork;
      assert.match(wide, /PANote\.panel\s*\(/, `${label}: the wide branch mounts the pad in the rail`);
      assert.match(narrow, /PANote\.fullscreen\s*\(/, `${label}: the narrow branch mounts it full screen`);
      assert.equal((wide.match(/PANote\.(fullscreen|panel|mount)\s*\(/g) || []).length, 1, `${label}: one pad in the wide branch`);
      assert.equal((narrow.match(/PANote\.(fullscreen|panel|mount)\s*\(/g) || []).length, 1, `${label}: one pad in the narrow branch`);
      // …and none anywhere else, which is what "exactly one pad exists" really means.
      assert.equal(mounts.length, 2, `${label}: ${mounts.length} PANote hosts — more than the two exclusive branches`);
    }
    const slots = /slots:\[([\s\S]*?)\],\s*\}\);/.exec(src);
    assert.ok(slots, `${label}: the rail declares its slots`);
    // A PANote in a rail slot is now expected (the note lives there). What must stay true is the
    // COUNT above: one pad, whichever host it lands in.
    const inSlot = (slots[1].match(/PANote\.panel\s*\(/g) || []).length;
    assert.ok(inSlot <= 1, `${label}: at most one pad in the rail, found ${inSlot}`);
  }
});

// ── the host follows the screen ──────────────────────────────────────────────────────────────
// Live-only: the committed template has no note engine at all (its Draw pane is a plain raster
// canvas) and builds its rail LAZILY from askAI, which re-reads splitOn() on every call — so the
// template never had the boot-time bug and needs none of this. The live app picked its host once,
// at boot, which is the reported defect.
test('the live Bible rebuilds its host on a gate crossing instead of deciding once at boot', () => {
  if (!LIVE_BIBLE) return;
  const code = stripComments(LIVE_BIBLE);
  assert.match(code, /PASplit\.onGate\(/, 'it subscribes to the component gate');
  // Not a second matchMedia: GATE is a critical string and two readers of it can disagree (R3).
  assert.ok(!/matchMedia/.test(code), 'and opens no media query of its own');
  assert.match(code, /function swapHost\(wide\)\{/, 'the crossing is a named, reviewable unit');
  assert.match(code, /if\(wide===_wide\) return;/,
    'a media query can fire without the gate actually crossing — re-swapping would rebuild the pad for nothing');
});

test('a gate crossing FLUSHES the pad, then destroys it, before the next one is built', () => {
  if (!LIVE_BIBLE) return;
  // The data-loss scars (2026-09-02, 2026-09-04): _drawScope is ONE app-level variable and every
  // save writes the WHOLE chapter, so two live pads overwrite each other. The ORDER is the whole
  // guarantee, so the order is what is asserted — not merely that the calls are present.
  const fn = /async function unmountHost\(\)\{([\s\S]*?)\n\}/.exec(LIVE_BIBLE);
  assert.ok(fn, 'unmountHost exists as a named unit');
  const body = stripComments(fn[1]);
  const flush = body.indexOf('await drawPad.flush()');
  const destroy = body.indexOf('await drawPad.destroy()');
  const railDown = body.indexOf('rail.destroy()');
  assert.ok(flush > 0, 'the outgoing pad is flushed');
  assert.ok(destroy > flush, 'and only destroyed AFTER the flush has settled — both are awaited');
  assert.match(body, /drawPad=null;/, 'and the handle is cleared, so nothing addresses a dead pad');
  assert.ok(railDown > destroy,
    'the RAIL comes down last: when it is the host the pad lives inside it, so destroying it first would take the pad DOM away mid-write');
  assert.match(body, /railChat=null;/, 'railChat is cleared too, or chatUI() keeps addressing a chat that is gone');
  // And the rebuild happens only after the teardown resolves.
  const swap = /async function swapHost\(wide\)\{([\s\S]*?)\n\}/.exec(LIVE_BIBLE)[1];
  const un = swap.indexOf('await unmountHost()');
  assert.ok(un > 0 && swap.indexOf('mountHost(wide)') > un,
    'the incoming host is built only after the outgoing one is fully down');
});

test('two fast rotations cannot run two swaps at once, and a failed swap is reported', () => {
  if (!LIVE_BIBLE) return;
  // Concurrency is how a second pad gets constructed while the first is still flushing — the
  // "exactly one PANote" invariant is a promise about instants, not about source lines.
  assert.match(LIVE_BIBLE, /_swapping=_swapping\.then\(\(\)=>swapHost\(on\)\)/,
    'crossings are serialised on one chain');
  assert.match(LIVE_BIBLE, /\.catch\(e=>\{\s*\n\s*annNotice\('布局切换失败 · Layout change failed/,
    'and a swap that fails is REPORTED — the screen is then in a state no later rotation repairs (R5)');
});

test('every app that USES a shared component also carries its MARKER', () => {
  // The scar: the Bible's split-view wiring shipped complete and dead. web.mjs skips a marker it
  // cannot find (`if (!html.includes(c.marker)) continue;`) with no error and a 200 response, so
  // window.PASplit was simply never defined, splitOn() answered false for ever, and every
  // source-level test still passed. Nothing connected the code to the marker that delivers it.
  //
  // Enumerated across ALL apps, not just the Bible — patching the one site that bit invites the
  // same report from the next app.
  // The signal is MOUNTING, not merely naming. You cannot mount a component that was never
  // inlined, so a mount call without its marker is always a defect. A guarded READ is not (e.g.
  // `window.PAChat&&PAChat.complete`). No app this test scans has a guarded PANote read today: the
  // Notes and Bible apps' guarded `PANote.LOAD` fallback was deleted because it could never run (ADR
  // 0015, amendment). The shelf's copies in shared-apps/ keep it until the owner's next promote.
  //
  // A looser "does it name the global at all" rule is not merely noisy, it is WRONG for this
  // scar: the Bible's dead rail was itself behind a `window.PASplit &&` guard, so a rule that
  // exempts guarded references would have exempted the very bug this test exists to catch.
  const USES = [
    { marker: '<!--PA_CHAT_UI-->', needle: /\bPAChat\.(?:fullscreen|panel|mount|listDrawer)\s*\(/ },
    { marker: '<!--PA_NOTE_UI-->', needle: /\bPANote\.(?:fullscreen|panel|mount)\s*\(/ },
    { marker: '<!--PA_SPLIT_UI-->', needle: /\bPASplit\.open\s*\(/ },
    { marker: '<!--PA_SETTINGS_UI-->', needle: /\bPASettings\.attach\s*\(/ },
  ];
  const dirs = [['workspace', 'apps'], ['workspace.example', 'apps']]
    .map((d) => path.join(ROOT, ...d)).filter((d) => fs.existsSync(d));
  assert.ok(dirs.length, 'no app directories found — this test would pass vacuously');
  let checked = 0;
  for (const dir of dirs) {
    for (const app of fs.readdirSync(dir)) {
      const file = path.join(dir, app, 'index.html');
      if (!fs.existsSync(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      const code = stripComments(src);
      checked++;
      for (const { marker, needle } of USES) {
        if (!needle.test(code)) continue;
        assert.ok(src.includes(marker),
          `${path.relative(ROOT, file)} uses ${needle.source} but is missing ${marker} — web.mjs would serve it 200 with the component silently absent`);
      }
    }
  }
  assert.ok(checked >= 2, `expected several apps, checked ${checked}`);
});

// ── closing the rail, and the long-press gesture ─────────────────────────────────────────────
test('closing is exposed to whatever is mounted — the rail owns no chrome of its own', () => {
  // Reported twice. First: "collapsible really means closeable — there is no way to close it."
  // Then, of the title bar that fixed it: "a wasted horizontal bar — can it be combined into the
  // chat box title, or just add a close button beside the ＋?"
  // It could, and the mechanism already existed: chat-ui carries a hidden .pac-close in its own
  // header and reveals it the moment a host passes onClose. So the rail renders NO bar and simply
  // hands close() to the slot.
  const dom = mkDom();
  let railHandle = null;
  const rail = loadSplit(dom).open({
    slots: [{ key: 'chat', mount: (host, r) => { railHandle = r; return {}; } }],
  });
  assert.equal(rail.open(), true);
  assert.ok(railHandle, 'the slot receives the rail handle');
  assert.equal(typeof railHandle.close, 'function', 'and can close the rail from its own chrome');
  railHandle.close();
  assert.equal(rail.isOpen(), false, 'which really closes it');
  assert.equal(dom.docEl.classList.contains('pas-open'), false, 'and releases the push, so the text reflows');
  assert.equal(dom.docEl.style._p['--pa-split'], undefined, 'and clears the width variable');
});

test('the rail renders no title bar of its own', () => {
  // A rail-level bar repeats what the mounted surface already says. Asserted so it cannot creep
  // back: PAChat's header is the title.
  assert.ok(!/pas-bar/.test(CSS), 'no title-bar CSS');
  assert.ok(!/pas-bar/.test(JS), 'and nothing builds one');
  assert.ok(!/pas-x\b/.test(JS), 'nor a rail-level close button');
  const dom = mkDom();
  loadSplit(dom).open({ slots: [{ key: 'chat', mount: () => ({}) }] }).open();
  assert.ok(!dom.made.some((n) => n.classList.contains('pas-bar')), 'and none is created at runtime');
});

test('the ✕ that closes the rail lives in the chat header, beside ＋', () => {
  // The button and its reveal are chat-ui's, not new UI: it is hidden until a host supplies
  // onClose. Both Bibles supply one that closes the rail.
  assert.match(CHAT_SRC, /<button class="pac-new pac-close" title="Close" style="display:none">✕<\/button>/,
    'the header carries a ✕ next to ＋, hidden by default');
  assert.match(CHAT_SRC, /if\(opts\.onClose\) el\.closes\.forEach\(b=>\{ b\.style\.display=''/,
    'and a host that passes onClose reveals it');
  for (const [label, src] of [['template', BIBLE], ['live', LIVE_BIBLE]]) {
    if (!src) continue;
    const mount = /mount:\(host,r\)=>\{?([\s\S]*?)return railChat;/.exec(src);
    assert.ok(mount, `${label}: the rail slot mounts a chat panel`);
    // The chat's ✕ closes the CHAT, not the whole split — it used to take the note down with it.
    assert.match(stripComments(mount[1]), /onClose:\(\)=>r\.(collapse\('chat'\)|close\(\))/,
      `${label}: the panel's onClose is what puts the ✕ on screen`);
    if (label === 'live') {
      assert.match(stripComments(mount[1]), /onClose:\(\)=>r\.collapse\('chat'\)/,
        'and it collapses only the chat, leaving the note open');
    }
  }
});

test('a closed rail reopens, and reopening does not stack Escape listeners', () => {
  const dom = mkDom();
  const rail = loadSplit(dom).open({ slots: [{ key: 'chat', mount: () => ({}) }] });
  rail.open(); rail.close();
  assert.equal(rail.open(), true, 'Ask AI can bring it back');
  assert.equal(rail.open(), true, 'and open() is idempotent');
  assert.equal(rail.isOpen(), true);
});

test('long-press on a verse asks about THAT verse, replacing the selection', () => {
  const fn = /function longPressVerse\(n,el\)\{([\s\S]*?)\n\}/.exec(BIBLE);
  assert.ok(fn, 'longPressVerse exists as a named unit');
  const body = fn[1];
  assert.match(body, /selV\.clear\(\)/, 'holding a second verse must not ask about both');
  assert.match(body, /selV\.add\(n\)/, 'the held verse becomes the scope');
  assert.match(body, /askAI\(\{force:true\}\)/, 'and it asks with force');
  assert.match(body, /removeAllRanges/, 'any iOS word-selection started by the press is cleared');
});

test('force re-asks over an existing thread — but never before the chapter has loaded', () => {
  const fn = /function shouldExplain\(k,force\)\{([\s\S]*?)\n\}/.exec(BIBLE);
  assert.ok(fn, 'shouldExplain takes the force flag');
  const body = fn[1];
  assert.match(body, /if\(!_booted \|\| !selV\.size\) return false;/,
    '_booted still gates force: before the load we cannot tell which thread a reply belongs to, so a forced ask would duplicate the conversation');
  assert.match(body, /if\(force\) return true;/, 'an explicit hold re-asks even when a thread exists');
  assert.match(body, /return !ANN_BLOCKED && !convoIdFor\(k\);/, 'the unforced path is unchanged');
  assert.match(BIBLE, /askAI\(opts\)/, 'askAI takes the flag');
  assert.match(BIBLE, /shouldExplain\(k,force\)/, 'and passes it through');
});

test('the gesture is delegated, movement-cancelled, and swallows exactly one click', () => {
  // Delegation: verse nodes are rebuilt every chapter load, so per-node handlers would leak.
  assert.match(BIBLE, /wrap\.addEventListener\('pointerdown'/, 'bound on the container, not each verse');
  assert.match(BIBLE, /LONG_PRESS_SLOP/, 'finger drift cancels the press — otherwise scrolling fires it');
  assert.match(BIBLE, /wrap\.addEventListener\('pointercancel',lpCancel/, 'and a cancelled pointer cancels it');
  // The click that follows a long press would run selectVerse and toggle the selection back OFF.
  const click = /wrap\.addEventListener\('click',function\(e\)\{([\s\S]*?)\},true\)/.exec(BIBLE);
  assert.ok(click, 'the click suppressor is registered in the CAPTURE phase');
  assert.match(click[1], /_lpFired=false/, 'and consumes the flag, so only ONE click is swallowed');
  assert.match(BIBLE, /lpCancel\(\); _lpFired=false;/,
    'the flag is also cleared on the next press — a hold that never produced a click must not swallow a later one');
  assert.match(BIBLE, /-webkit-touch-callout:none/, "iOS's own Copy/Look Up bubble is suppressed on verses");
});

// ── one note surface, opened for typing ──────────────────────────────────────────────────────
test('PANote opens in the tool and on the paper its host asks for', () => {
  const NOTE = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');
  assert.match(NOTE, /const VALID_TOOL=[^;\n]*Object\.fromEntries\(TOOLS\.map/,
    'valid tools are DERIVED from TOOLS — a second hand-kept list would drift the day a tool is added');
  assert.match(NOTE, /const OPEN_TOOL=\(opts&&typeof opts\.tool==='string'&&VALID_TOOL\[opts\.tool\]\)\?opts\.tool:'pen';/,
    'an unknown tool falls back to the pen rather than leaving no tool selected');
  // Pinned as the INVARIANT, not as the literal it happened to be: a host-supplied valid template
  // wins, and anything else falls to the NAMED default. The old form spelled 'ruled' inline, so
  // changing the product decision (new notes now start plain) failed a test whose own message says
  // it is about the host winning. What that default IS belongs to test/note-default-template.mjs.
  assert.match(NOTE, /const freshNotebook=\(tpl\)=>\{[^}]*template:\(typeof tpl==='string'&&VALID_TPL\[tpl\]\?tpl:DEFAULT_TPL\)/,
    'the host picks the paper for notebooks it CREATES; otherwise the named default applies');
  // The race this fixes: setTool is async and awaits a flush before assigning, and setColor/setSize
  // each call setTool('pen') when the current tool is erase/select/text — so seeding the opening
  // tool through setTool left an in-flight 'pen' that landed afterwards and undid it. Measured in a
  // browser: the T button stayed unlit and the page was not editable.
  assert.match(NOTE, /let NB=freshNotebook\(opts&&opts\.template\), cur=0, tool='pen'/,
    "tool starts on the pen so setColor/setSize never fire their flip");
  const seed = NOTE.indexOf('tool=OPEN_TOOL;');
  const seedColor = NOTE.indexOf('setColor(COLORS[0]); setSize(SIZE_DEF);');
  assert.ok(seed > 0 && seedColor > 0 && seed > seedColor, 'and the opening tool is applied AFTER them');
  assert.match(NOTE, /tool=OPEN_TOOL;\s*\n\s*toolBtns\.forEach/, 'applied synchronously, not through async setTool');
});

test('the Bible has ONE note surface — the Text/Draw tabs and Save button are gone', () => {
  if (!LIVE_BIBLE) return;
  // The pad has a text tool, so a verse note was one thing rendered two ways. The Save button went
  // with them: the pad autosaves, and a Save button that silently closes a sheet is what made a
  // working save look broken.
  // Comments stripped: the file carries a comment RECORDING the deletion, which names every symbol
  // it removed — a bare text search matches that record and calls the cleanup a failure.
  const code = stripComments(LIVE_BIBLE);
  for (const gone of ['id="note-ta"', 'id="note-save"', 'id="panel"', 'switchPane', 'loadNote()', 'closePanel']) {
    assert.ok(!code.includes(gone), `${gone} should have been deleted with the sheet`);
  }
  assert.match(LIVE_BIBLE, /tool:'text', template:'plain'/, 'the pad opens for typing, on unruled paper');
  assert.match(LIVE_BIBLE, /const NOTE_OPTS=\{/, 'one options object shared by both hosts');
});

test('a legacy text note is carried INTO the notebook, never dropped', () => {
  if (!LIVE_BIBLE) return;
  // This is the data-safety half of the merge. The save deletes ANN.notes[k], so the load must
  // ALWAYS carry the text across — an earlier version skipped when the page already had text,
  // which deleted a note the user never saw moved.
  const fn = /function legacyMerged\(nb,k\)\{([\s\S]*?)\n\}/.exec(LIVE_BIBLE);
  assert.ok(fn, 'legacyMerged exists');
  assert.match(fn[1], /pageHasText\(p\) \? \(p\.pageHtml\+'<br>'\+add\) : add/,
    'it APPENDS to a page that already has text rather than skipping');
  assert.ok(!/pages\.some\(pageHasText\)\) return nb/.test(fn[1]), 'the skip-and-lose branch is gone');
  assert.match(LIVE_BIBLE, /if\(ANN\.notes&&\(k in ANN\.notes\)\) delete ANN\.notes\[k\];/,
    'and the save completes the one-way merge');
  // A verse with only text and no notebook must still open with its text.
  assert.match(LIVE_BIBLE, /return legacy \? DATA\.LOAD\.loaded\(legacyNotebook\(legacy\)\) : DATA\.LOAD\.absent\(\);/,
    'a text-only verse synthesises a notebook instead of reporting absent');
});

// ── dock zones ───────────────────────────────────────────────────────────────────────────────
test('no transition on the push — it left the margin computing to 0', () => {
  // The regression this pins: `transition:margin-right .2s` on the pushed children left
  // #verses/#nav at margin-right 0 while the identical rule resolved on a display:none sibling,
  // so the rail overlaid the text. Measured three times in a browser before the cause was clear.
  assert.ok(!/transition:margin/.test(CSS), 'the pushed children must not transition their margin');
});

// ── a note is named by what is in it, and its ✕ closes it ────────────────────────────────────
test("the pad's ✕ closes the note — it used to only flush", () => {
  if (!LIVE_BIBLE) return;
  // Reported: "note close button is not closing, but collapse button closes the note view."
  // onClose flushed and cleared the drawer highlight, so the pane stayed exactly where it was.
  // Anchored inside NOTE_OPTS: the file has several onClose handlers and a bare match found the
  // chat's, which says nothing about the pad.
  const opts = /const NOTE_OPTS=\{([\s\S]*?)\n\};/.exec(LIVE_BIBLE);
  assert.ok(opts, 'NOTE_OPTS is one block');
  const fn = /onClose:\(\)=>\{([\s\S]*?)\n  \},/.exec(opts[1]);
  assert.ok(fn, "the pad has an onClose");
  assert.match(fn[1], /rail\.collapse\('note'\)/, 'in the rail it collapses the note slot');
  assert.match(fn[1], /drawPad&&drawPad\.hide/, 'and full-screen it hides the pad');
});

test('a note is titled by its first line, recomputed on every save', () => {
  if (!LIVE_BIBLE) return;
  // Reported: "if I type something in the note, the title should change accordingly… I've done
  // this in journal's note app." Same rule, same shape — not a second dialect.
  assert.match(LIVE_BIBLE, /function derivedTitleOf\(nb\)\{/, 'the deriver exists');
  assert.match(LIVE_BIBLE, /\.split\('\\n'\)\.map\(s=>s\.trim\(\)\)\.find\(Boolean\)/, 'first non-empty line wins');
  assert.match(LIVE_BIBLE, /function noteTitleFor\(k,nb\)\{/, 'and one function decides the whole fallback chain');
  const chain = /function noteTitleFor\(k,nb\)\{([\s\S]*?)\n\}/.exec(LIVE_BIBLE)[1];
  assert.match(chain, /if\(derived\) return derived;/, 'content first');
  assert.match(chain, /freeNoteTitle\(k\)/, 'then the timestamped default for a free note');
  assert.match(chain, /scopeTitle\(\)/, 'then the verse it belongs to');
  // ONE painter, so the slot header and the pad bar cannot disagree — they are two places the
  // same note is named.
  assert.match(LIVE_BIBLE, /function paintNoteTitle\(t\)\{[\s\S]*?rail\.setTitle\('note',t\)[\s\S]*?drawPad\.setTitle\(t\)/,
    'and one painter updates both surfaces');
  assert.match(LIVE_BIBLE, /paintNoteTitle\(noteTitleFor\(k,nb\)\);/, 'the save retitles');
});

test('a note that becomes real shows up in the ☰ list', () => {
  if (!LIVE_BIBLE) return;
  // Reported: "if I type something in the note, this becomes a new note and should appear in the
  // drawer, currently it's not."
  assert.match(LIVE_BIBLE, /const c=chatUI\(\); if\(c&&c\.refreshList\) c\.refreshList\(\);/,
    'the save refreshes the list — on the chat that is on screen, not a hidden twin');
  const save = /save:async\(nb\)=>\{([\s\S]*?)\n  \},/.exec(LIVE_BIBLE)[1];
  assert.match(save, /if\(r&&r\.ok\)\{/, 'but only after a SUCCESSFUL write — the list must not advertise a note the disk does not have');
  // And the refresh is cheap: a pad autosaves on a debounce, so refreshing a closed drawer would
  // be an /api/notes round trip per keystroke burst for a list nobody is looking at.
  assert.match(CHAT_SRC, /refreshList:\(\)=>\{ if\(drawer\.isOpen&&drawer\.isOpen\(\)\) return drawer\.refresh\(\); \}/,
    'refreshList is a no-op while the drawer is closed');
});

test('list operations go to the chat that is ON SCREEN, not a hidden twin', () => {
  if (!LIVE_BIBLE) return;
  // The Bible builds TWO Chat instances — the full-screen one and the rail panel — and each
  // builds its OWN ☰ drawer. Addressing `aiChat` directly for list work opened the hidden
  // instance's drawer: the app's content was pushed aside for a panel that never appeared.
  const code = stripComments(LIVE_BIBLE);
  assert.match(code, /const chatUI=\(\)=>railChat\|\|aiChat;/, 'one accessor names the visible chat');
  for (const op of ['setActiveNote', 'closeList', 'showListOnly', 'refreshList']) {
    assert.ok(!new RegExp(`aiChat\\.${op}\\b`).test(code),
      `${op} must go through chatUI(), or it addresses whichever instance happens to be first`);
  }
  // open/hide are surface operations and stay on the full-screen instance deliberately.
  assert.match(code, /aiChat\.open\(k\)/, 'the narrow path still opens the full-screen chat directly');
});

test('opening a NOTE does not reveal an empty chat', () => {
  if (!LIVE_BIBLE) return;
  const slots = /slots:\[([\s\S]*?)\],\s*\}\);/.exec(LIVE_BIBLE)[1];
  const chat = slots.slice(slots.indexOf("key:'chat'"), slots.indexOf("key:'note'"));
  assert.match(chat, /collapsed:true/, 'the chat slot starts collapsed');
  assert.match(LIVE_BIBLE, /rail\.open\(\); rail\.expand\('chat'\);/, 'and only Ask AI expands it');
  // Measured in a browser: after openPanel('note') the rail is not rendered at all and only the
  // bottom zone shows — an empty zone stops pushing, so the reading column keeps its width.
});

test('tapping a chat row in the ☰ list reveals the chat panel', () => {
  // The chat slot starts collapsed, so opening a conversation had nothing to reveal it: the
  // thread loaded into a panel nobody could see. PAChat already calls opts.onShow() before
  // openConvo and before a new chat — the rail just had to supply one.
  assert.match(CHAT_SRC, /onOpen:\(\)=>\{ if\(opts\.onShow\) opts\.onShow\(\); openConvo\(c\.id,c\); \}/,
    'a drawer chat row asks its host to reveal itself first');
  assert.match(CHAT_SRC, /if\(opts\.onShow\) opts\.onShow\(\);\s+\/\/ a new chat must be on a VISIBLE surface/,
    'and so does a new chat');
  for (const [label, src] of [['template', BIBLE], ['live', LIVE_BIBLE]]) {
    if (!src) continue;
    const mount = /mount:\(host,r\)=>\{?([\s\S]*?)return railChat;/.exec(src);
    assert.match(stripComments(mount[1]), /onShow:\(\)=>\{ r\.open\(\); r\.expand\('chat'\); \}/,
      `${label}: the rail opens and expands its chat slot`);
  }
  // Measured in a browser: chat collapsed + rail not rendered → click a row → rail rendered,
  // chat expanded.
});

// ── ADR 0043: every slot is its OWN PAWin window ─────────────────────────────────────────────
test('each slot is an independent window: expanding one never shows another', () => {
  const dom = mkDom(); const PASplit = loadSplit(dom);
  const toggles = [];
  const rail = PASplit.open({ onToggle: (k, v) => toggles.push(k + ':' + v), slots: [
    { key: 'chat', title: '问一问 · Ask AI', mount: () => ({}) }, { key: 'note', title: '笔记 · Note', zone: 'bottom', mount: () => ({}) }] });
  const [chat, note] = dom.win.PAWin.made;
  assert.equal(chat.o.dock, 'right'); assert.equal(note.o.dock, 'bottom', 'a bottom-zone slot starts docked at the bottom');
  assert.ok(rail.isCollapsed('chat') && rail.isCollapsed('note'), 'both start closed');
  rail.open(); rail.expand('chat');
  assert.equal(rail.isCollapsed('chat'), false); assert.equal(rail.isCollapsed('note'), true, 'Ask AI opens ONLY Ask AI');
  rail.expand('note'); assert.equal(rail.isCollapsed('note'), false, 'Note opens on its own');
  rail.collapse('chat'); assert.equal(rail.isCollapsed('chat'), true); assert.equal(rail.isCollapsed('note'), false, 'closing one leaves the other');
  note.minimize(); assert.equal(rail.isCollapsed('note'), true, 'a minimised window counts as not on screen');
  rail.expand('note'); assert.equal(note.s.min, false, 'expand restores a minimised window');
  assert.deepEqual(toggles.slice(0, 3), ['chat:true', 'note:true', 'chat:false'], 'the host hears every visibility change');
});

test('expanding a window RE-MEASURES its surface, even when it was already open', () => {
  const dom = mkDom(); let resizes = 0;
  const rail = loadSplit(dom).open({ slots: [{ key: 'note', mount: () => ({ resize: () => { resizes++; } }) }] });
  assert.equal(resizes, 0, 'a closed window is not measured');
  rail.expand('note'); assert.equal(resizes, 1);
  rail.expand('note'); assert.equal(resizes, 2, 'a redundant expand still re-measures (note-ui:2272 stale-canvas scar)');
  dom.win.PAWin.made[0].o.onResize(); assert.equal(resizes, 3, 'a window resize re-measures too');
});

test('the window ✕ runs the surface\'s own close (PAChat / PANote ✕), and the rail forwards title and maximise', () => {
  const dom = mkDom(); const rail = loadSplit(dom).open({ slots: [{ key: 'chat', mount: () => ({}) }] });
  const w = dom.win.PAWin.made[0];
  assert.equal(w.o.closeSel, '.pac-top .pac-close,.pan-hx');
  rail.setTitle('chat', 'John 3'); assert.equal(w.s.title, 'John 3');
  rail.toggleMax('chat'); assert.ok(rail.isMaxed('chat')); rail.toggleMax('chat'); assert.ok(!rail.isMaxed('chat'));
});

test('destroy() ENDS a rail — windows gone, gate unsubscribed', () => {
  const dom = mkDom({ width: 1366, height: 768 }); const rail = loadSplit(dom).open({ slots: [{ key: 'a', mount: () => ({}) }] });
  rail.open(); rail.expand('a'); rail.destroy();
  assert.ok(dom.win.PAWin.made[0].destroyed, 'the window is destroyed');
  assert.equal(rail.isOpen(), false);
  dom.rotate(768, 1024); dom.rotate(1366, 768);
  assert.equal(dom.win.PAWin.made[0].s.open, false, 'a gate crossing never reopens it');
});

test('crossing the gate closes every window (a rotation to a narrow screen hands over to the sheet)', () => {
  const dom = mkDom({ width: 1366, height: 768 }); let gone = 0;
  const rail = loadSplit(dom).open({ onGateClose: () => { gone++; }, slots: [{ key: 'a', mount: () => ({}) }] });
  rail.open(); rail.expand('a'); dom.rotate(390, 844);
  assert.equal(rail.isCollapsed('a'), true); assert.equal(gone, 1);
});

test('panel-window CSS: literal z-index under the ceilings, fixed windows, pushes never move windows, drawer or lightbox', () => {
  const z = [...CSS.matchAll(/z-index:\s*([^;}]+)/g)].map((m) => m[1].trim());
  assert.ok(z.length >= 3);
  for (const v of z) { assert.ok(/^\d+$/.test(v), `literal z-index, got ${v}`); assert.ok(Number(v) < 50, `${v} stays below .pac-fs/.pan-fs (50)`); }
  assert.match(CSS, /\.paw-win\{[^}]*position:fixed/);
  for (const side of ['right', 'left']) {
    const rule = new RegExp(`html\\.paw-p${side[0]}>body>\\*([^{]*)\\{margin-${side}:var\\(--paw-${side[0]}\\)\\}`).exec(CSS);
    assert.ok(rule, `the ${side} push is a margin`);
    for (const skip of ['.paw-x', '.pac-drawerhost', '.pac-lb']) assert.ok(rule[1].includes(`:not(${skip})`), `${skip} is never pushed`);
  }
  const excl = /const PAC_DOCK_EXCL=([^;]+);/.exec(CHAT_SRC);
  assert.match(excl[1], /:not\(\.paw-x\)/, 'the drawer\'s left push never moves a panel window');
});
