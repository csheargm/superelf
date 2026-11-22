// The PANote pointer-routing harness, shared by test/note-palm.test.mjs, test/note-pencil-routing.test.mjs,
// test/note-pencil-log.test.mjs, test/note-stage-guard.test.mjs and test/note-bar-guard.test.mjs (R3 — it used to live inside note-palm.test.mjs; a second copy
// for the new files would have been the duplication R3 forbids).
//
// WHY THE HARNESS LOOKS LIKE THIS (test-harness fidelity is a standing rule here): the routing
// under test is NOT re-implemented. The whole pointer-routing block is EXTRACTED verbatim from
// web/note-ui.inline.html between its PA_POINTER_ROUTING markers and executed — together with the
// recorder glue (PA_PENCIL_LOG markers) that precedes it and the Pencil recorder component itself
// (web/pencil-log.inline.html), because the routing calls pdec()/listenG() and that is what ships. Listeners are registered through a DOM stub
// that performs real capture → target → bubble dispatch from WINDOW → DOCUMENT → host → surface,
// and the tests drive PointerEvent-shaped events through addEventListener exactly as Safari would.
// The engine's own PEN_GRACE_MS / FLIP_THRESH / FLICK_MS / FLIP_MS are extracted too, never
// restated (R3). Timers run on the same fake clock as Date.now() and performance.now().
//
// WHAT IS STUBBED, STATED PLAINLY (R14 — the fidelity boundary is not hidden):
//   · the stroke pipeline (startStroke / extendStroke / endStroke) — canvas work. The stubs keep
//     its STATE effects: startStroke sets `drawing` and REPLACES the live points (so a stroke
//     started while one is live is counted as lost), endStroke commits only while drawing.
//   · the flip ANIMATION, by default. Pass { realFlip: true } to run the engine's own
//     beginFlipDrag / updateFlipDrag / endFlipDrag (extracted verbatim) on the fake clock instead;
//     the default stub reproduces their state effects, deferring the snap-back by FLIP_MS + 40
//     exactly as the real one does unless `immediate` is passed (or settleFlipNow() pre-empts it).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scopeProxy, ENG_INK } from './helpers-app.mjs';
import { closest, matches } from './helpers-dom-match.mjs';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ENGINE = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');
export const RECORDER = fs.readFileSync(path.join(ROOT, 'web', 'pencil-log.inline.html'), 'utf8');

const between = (src, a, b) => {
  const from = src.indexOf(a), to = src.indexOf(b, from);
  assert.ok(from > 0 && to > from, `the engine still carries one contiguous block ${a.slice(0, 40)}…`);
  return src.slice(from, to);
};
// ── The shipped blocks, extracted ────────────────────────────────────────────────────────────
export const routingSource = () => between(ENGINE, '/* ══ PA_POINTER_ROUTING_BEGIN', '/* ══ PA_POINTER_ROUTING_END ══ */');
export const logSource = () => between(ENGINE, '/* ══ PA_PENCIL_LOG_BEGIN', '/* ══ PA_PENCIL_LOG_END ══ */');
export const flipSource = () => between(ENGINE, '// ── THE SETTLE（翻页收尾）', 'async function addPage(){');   // the button flip, the finger flip and their settle
export const recorderSource = () => between(RECORDER, '<script id="ppl-script">', '</script>').slice('<script id="ppl-script">'.length);

// The engine's OWN constants — extracted, never restated, so a retune of PEN_GRACE_MS retunes
// the tests with it instead of leaving them asserting a number the app no longer uses.
function constants() {
  const line = (name) => {
    const m = ENGINE.match(new RegExp(`^\\s*const ${name}=[^\\n]*$`, 'm'));
    assert.ok(m, `the engine still declares ${name}`);
    return m[0];
  };
  // FLIP_MS is declared mid-line (`const SCHEMA=2, MAX_UNDO=60, FLIP_MS=280, TAU=...`), so the
  // whole-line matcher above cannot see it. noFlip is declared OUTSIDE the routing block, so the
  // scope must be seeded with the engine's own default or a behavioural test would exercise a
  // value the test chose rather than the one that ships.
  const noFlip = ENGINE.match(/\blet noFlip\s*=\s*(true|false)\s*;/);
  assert.ok(noFlip, 'the engine still declares a noFlip default');
  const flipMs = ENGINE.match(/\bFLIP_MS\s*=\s*(\d+)/);
  assert.ok(flipMs, 'the engine still declares FLIP_MS');
  // eslint-disable-next-line no-new-func
  const c = new Function(`${line('FLIP_THRESH')}\n${line('PEN_GRACE_MS')}\nreturn {FLIP_THRESH,FLICK_MS,PEN_GRACE_MS};`)();
  return { ...c, FLIP_MS: Number(flipMs[1]), NO_FLIP_DEFAULT: noFlip[1] === 'true' };
}
export const C = constants();

// ── A DOM stub with REAL event propagation ───────────────────────────────────────────────────
// Capture (root→target) then target then bubble (target→root), listeners in registration order,
// `currentTarget` set per node, stopPropagation honoured — because the palm fix depends on a
// capture-phase listener on the pad running BEFORE the per-surface handler, and the pen backstop
// on a capture-phase listener on the DOCUMENT. A stub that ignored phases would hide both.
export function makeNode(name, parent, extra = {}) {
  const caps = [], bubs = [], classes = new Set(String(extra.className || '').split(/\s+/).filter(Boolean));
  const el = {
    _name: name, parent: parent || null, children: [], nodeName: name.toUpperCase(),
    className: extra.className || '', style: {}, childNodes: [], innerHTML: '', textContent: '',
    captured: [], _classes: classes, attrs: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, f) => { const on = f === undefined ? !classes.has(c) : !!f; if (on) classes.add(c); else classes.delete(c); return on; } },
    addEventListener(type, fn, opt) { (opt && (opt === true || opt.capture) ? caps : bubs).push({ type, fn, opt }); },
    removeEventListener(type, fn, opt) {
      const list = opt && (opt === true || opt.capture) ? caps : bubs;
      const i = list.findIndex((l) => l.type === type && l.fn === fn); if (i >= 0) list.splice(i, 1);
    },
    _listeners: (type) => [...caps, ...bubs].filter((l) => !type || l.type === type),
    _fire(phase, ev) {
      for (const l of [...(phase === 'capture' ? caps : bubs)]) {
        if (l.type !== ev.type || ev._stopped) continue;
        ev.currentTarget = el; ev._passive = !!(l.opt && l.opt.passive);   // a passive listener's preventDefault is ignored, as in a browser
        l.fn(ev);
      }
    },
    setPointerCapture(id) { el.captured.push(id); },
    releasePointerCapture(id) { el.captured = el.captured.filter((x) => x !== id); },
    hasPointerCapture: (id) => el.captured.includes(id),
    contains(n) { for (let x = n; x; x = x.parent) if (x === el) return true; return false; },
    // closest()/matches() are REAL (test/helpers-dom-match.mjs): the stage guard's exemption is decided by one.
    closest: (sel) => closest(el, sel), matches: (sel) => matches(el, sel), querySelectorAll: (sel) => el.children.flatMap((c) => [...(matches(c, sel) ? [c] : []), ...c.querySelectorAll(sel)]),
    querySelector: (sel) => el.querySelectorAll(sel)[0] || null,   // real descendant walk: "is a popover open" is decided by one
    getAttribute: (n) => (n in el.attrs ? String(el.attrs[n]) : null), setAttribute: (n, v) => { el.attrs[n] = String(v); },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 1000 }),
    appendChild() {}, remove() { el.removed = true; },
    ...extra,
  };
  if (parent) parent.children.push(el);
  return el;
}
export function dispatch(target, ev) {
  const chain = [];
  for (let n = target; n; n = n.parent) chain.push(n);
  ev.target = target;
  for (let i = chain.length - 1; i >= 1; i--) chain[i]._fire('capture', ev);   // root → parent of target
  target._fire('capture', ev); target._fire('bubble', ev);                      // at target: both lists
  for (let i = 1; i < chain.length; i++) chain[i]._fire('bubble', ev);          // parent of target → root
  return ev;
}

// ── One pad, running the real routing ────────────────────────────────────────────────────────
// `mutate` / `mutateLog` (mutation testing only) rewrite the app's OWN routing / recorder source to
// re-introduce the defect a guard removes, and must actually match something — a mutation that
// changed nothing would "prove" a guard is load-bearing while testing the unmutated code.
// noFlip defaults to the SHIPPED value (C.NO_FLIP_DEFAULT), so a test that says nothing exercises
// the posture a real user has. Tests ABOUT the flip machinery opt in with { noFlip: false }.
export function runPad({ mutate = null, mutateLog = null, mutateRecorder = null, tool = 'pen', fingerDraw = false, txtEdit = null, cur = 1,
  noFlip = C.NO_FLIP_DEFAULT, realFlip = false, saveLog = null, hasFocus = null, mutateFlip = (s) => s } = {}) {
  let src = routingSource();
  assert.ok(/function fingerFlipStart\(e,dir\)\{/.test(src), 'the extraction found the real fingerFlipStart');
  assert.ok(/function onDown\(e\)\{/.test(src), 'the extraction found the real pointer handlers');
  if (mutate) { const before = src; src = mutate(src); assert.notEqual(src, before, 'the mutation matched nothing — it would prove nothing'); }
  let log = logSource();
  assert.ok(/window\.PAPencilLog\.attach\(/.test(log), 'the extraction found the real recorder glue');
  if (mutateLog) { const before = log; log = mutateLog(log); assert.notEqual(log, before, 'the glue mutation matched nothing'); }
  let rec = recorderSource();
  assert.ok(/function record\(e\)\{/.test(rec), 'the extraction found the real recorder');
  if (mutateRecorder) { const before = rec; rec = mutateRecorder(rec); assert.notEqual(rec, before, 'the recorder mutation matched nothing'); }

  const win = makeNode('window', null, { _notElement: true });
  const doc = makeNode('document', win, { visibilityState: 'visible', createElement: (t) => makeNode(t, null), _notElement: true });
  // The pad's real nesting (web/note-ui.inline.html's markup): the ink, the text layer and the
  // gutters live INSIDE the scrolling stage, the bars and popovers are the stage's SIBLINGS.
  const host = makeNode('host', doc, { className: 'pan-host' });
  const stage = makeNode('stage', host, { className: 'pan-stage', scrollTop: 0, scrollLeft: 0 });
  const pageInner = makeNode('pageInner', stage, { className: 'pan-pageInner' });   // the page box
  const ink = makeNode('canvas', pageInner, { className: 'pan-ink' });
  const textLayer = makeNode('textLayer', pageInner, { className: 'pan-textlayer' });
  const flipCanvas = makeNode('canvas', stage, { className: 'pan-flip' });
  const gutterL = makeNode('gutterL', stage, { className: 'pan-gutter pan-gutterL' });
  const gutterR = makeNode('gutterR', stage, { className: 'pan-gutter pan-gutterR' });
  const toolbar = makeNode('toolbar', host, { className: 'pan-bar pan-tools' });   // inside the pad, NOT a routing surface
  const toolBtn = makeNode('button', toolbar, { className: 'pan-tbtn pan-tool' });
  const pop = makeNode('div', host, { className: 'pan-pop pan-inkpop' });
  const popInput = makeNode('input', pop, { className: 'pan-sizerange' });
  const sendLogBtn = makeNode('button', pop, { className: 'pan-photoopt pan-sendlog' });
  win.getSelection = () => null; win.devicePixelRatio = 2; win.scrollY = 0;
  if (hasFocus) doc.hasFocus = hasFocus;                  // before attach: the recorder reads it at mount
  // The pinch-zoom / keyboard viewport the recorder watches (scale and offset are read on its events).
  win.visualViewport = makeNode('visualViewport', null, { scale: 1, offsetTop: 0 });

  let clock = 1_000_000; let timers = []; let tid = 0;
  const calls = { begin: [], update: [], end: [], startStroke: 0, extendStroke: 0, endStroke: 0, committed: 0, lostStrokes: 0,
    extendBy: [], erase: 0, setTool: [], flash: [], saveLog: [], closePops: 0 };

  const S = {
    PAGES: true, flipping: false, penId: null, cur, W: 800,
    NB: { pages: [{ id: 'p0' }, { id: 'p1' }, { id: 'p2' }] },
    tool, fingerDraw, txtEdit, drawing: false, sel: [],
    host, ink, gutterL, gutterR, textLayer,
    FLIP_THRESH: C.FLIP_THRESH, FLICK_MS: C.FLICK_MS, PEN_GRACE_MS: C.PEN_GRACE_MS, FLIP_MS: C.FLIP_MS,
    noFlip,
    // Constructible (the glue stamps the log file name with `new Date()`), on the same fake clock.
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [clock])); } static now() { return clock; } },
    performance: { now: () => clock },
    navigator: { userAgent: 'harness', maxTouchPoints: 5 },
    setTimeout: (fn, ms) => { timers.push({ id: ++tid, at: clock + (ms || 0), fn }); return tid; },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
    getSelection: () => null,
    window: win, document: doc,
    q: (sel) => (sel === '.pan-sendlog' && saveLog ? sendLogBtn : null),
    opts: saveLog ? { saveLog: (p, text) => { calls.saveLog.push({ path: p, text }); return saveLog(p, text); } } : {},
    flash: (m) => { calls.flash.push(m); },
    closePops: () => { calls.closePops++; },
  };
  // The flip animation. Default: its STATE EFFECTS, reproduced exactly. web/note-ui.inline.html's
  // endFlipDrag clears `flipping` and restores `cur` inside setTimeout(FLIP_MS + 40) — not
  // synchronously — and for that whole window onDown's `if(flipping) return;` drops the Pencil's
  // pointerdown. `immediate` restores the state NOW; the stub must do the same or the harness
  // cannot tell the two paths apart.
  const settle = () => {
    if (!S._settle || clock < S._settle.at) return;
    const { commit } = S._settle; S._settle = null;
    if (!commit) S.cur = S._from;
    S.flipping = false;
  };
  if (!realFlip) {
    S.beginFlipDrag = (dir) => { calls.begin.push({ dir, at: calls.end.length }); S.flipping = true; S._from = S.cur; S.cur += dir; };
    S.updateFlipDrag = (p) => { calls.update.push(p); };
    S.endFlipDrag = (commit, immediate) => {
      calls.end.push(!!commit);
      S._settle = { at: immediate ? clock : clock + C.FLIP_MS + 40, commit };
      settle();
    };
    S.settleFlipNow = () => { if (!S._settle) return false; S._settle.at = clock; settle(); return true; };   // the engine's pre-emptable settle
  } else {
    // The REAL flip functions run; only their DOM/canvas side effects are inert.
    Object.assign(S, {
      pageInner, flip: flipCanvas,
      commitPageHtml() {}, flushSave() {}, clearSelection() {}, pruneOtherPageHistory() {}, rebuildCommitted() {}, setupCanvases() {},
      snapshotOutgoing: () => { flipCanvas.style.display = 'block'; return null; },   // the overlay goes up; every settle path takes it down
    });
  }
  S.startStroke = (e) => { calls.startStroke++; if (S.drawing && S._pts > 0) calls.lostStrokes++; S.drawing = true; S._pts = 1; S.strokePage = S.cur; S._by = e && e.pointerId; };
  S.extendStroke = (e) => { calls.extendStroke++; calls.extendBy.push(e && e.pointerId); S._pts++; };
  S.endStroke = () => { calls.endStroke++; if (!S.drawing) return; S.drawing = false; if (S._pts) calls.committed++; S._pts = 0; };
  S.eraseAt = () => { calls.erase++; };
  S.selDown = () => {}; S.selMove = () => {}; S.selUp = () => {};
  // Page coordinates, normalised by WIDTH exactly as the engine does (nX/nY live above the block).
  S.nX = (e) => e.clientX / S.W; S.nY = (e) => e.clientY / S.W;
  // The screen↔page ratio the engine measures from the element: the harness page is unscaled.
  S.pageK = () => 1;
  S.lastTap = { t: 0, x: 0, y: 0 };
  // The scroll container the page pans in — real enough to be read and written, because the
  // routing decides a vertical drag is a SCROLL rather than a flip by moving it.
  S.stage = stage;
  S.singleImage = () => null; S.page = () => S.NB.pages[S.cur];
  S.clearSelection = S.clearSelection || (() => {}); S.deleteSel = () => {};
  S.setTool = (t) => { calls.setTool.push(t); S.tool = t; };
  S.commitPageHtml = S.commitPageHtml || (() => {});
  S.redrawPage = () => {}; S.renderTextLayer = () => {}; S.updateUndo = () => {};
  S.exitTextMode = () => {}; S.toolBtns = []; S.guardInk = ENG_INK.guardInk;   // the engine's own hoisted guard the block calls (never a retype)

  // The recorder component runs first, exactly as the page does: it defines window.PAPencilLog.
  // eslint-disable-next-line no-new-func
  new Function('__scope', `with(__scope){${rec}\n}`)(scopeProxy({ window: win, document: doc, performance: S.performance, navigator: S.navigator }));
  const code = `${log}\n${src}\n${realFlip ? mutateFlip(flipSource()) : ''}\nreturn { plog, globalsOff, syncGuard, flipTo };`;
  // eslint-disable-next-line no-new-func
  const inner = new Function('__scope', `with(__scope){${code}\n}`)(scopeProxy(S));

  let seq = 0;
  // got/lostpointercapture are built the way WEBKIT builds them, whatever the caller passes:
  // PointerEvent::createForPointerCapture (Source/WebCore/dom/PointerEvent.h) sets only pointerId,
  // isPrimary and pointerType, so buttons, pressure and clientX/Y are always 0 (width/height keep
  // the Init default 1). Chrome fills buttons in; a test that relied on that would be green here
  // and meaningless on the iPad (the test-harness-fidelity rule).
  const ev = (type, o) => {
    const up = type === 'pointerup' || type === 'pointercancel';
    if (type === 'gotpointercapture' || type === 'lostpointercapture') o = { id: o.id, pt: o.pt, primary: o.primary, x: 0, y: 0, buttons: 0, pressure: 0, w: 1, h: 1 };
    const e = {
      type, pointerId: o.id, pointerType: o.pt, clientX: o.x, clientY: o.y, isPrimary: o.primary ?? true,
      pressure: o.pressure ?? (up ? 0 : (o.pt === 'pen' ? 0.4 : 0.5)),
      width: o.w ?? (o.pt === 'touch' ? 20 : 1), height: o.h ?? (o.pt === 'touch' ? 20 : 1),
      buttons: o.buttons ?? (up ? 0 : 1),
      defaultPrevented: false, currentTarget: null, target: null, _n: ++seq, _stopped: false, _stopCalls: 0,
      preventDefault() { if (!e._passive) e.defaultPrevented = true; },
      stopPropagation() { e._stopCalls++; e._stopped = true; },
      stopImmediatePropagation() { e._stopCalls++; e._stopped = true; },
    };
    return e;
  };
  // A TouchEvent as iPad Safari builds it: `touches` = every contact still down, `changedTouches`
  // = the ones this event is about. touchType is 'stylus' for the Pencil, 'direct' for a finger.
  const touchEv = (type, { touches = [], changed = [] }) => {
    const mk = (t) => ({ identifier: t.id, radiusX: t.rx ?? 10, radiusY: t.ry ?? 10, force: t.f ?? 0, touchType: t.tt ?? 'direct', clientX: t.x, clientY: t.y });
    const e = { type, touches: touches.map(mk), changedTouches: changed.map(mk), defaultPrevented: false, _stopped: false, _stopCalls: 0,
      preventDefault() { if (!e._passive) e.defaultPrevented = true; }, stopPropagation() { e._stopCalls++; e._stopped = true; } };
    return e;
  };
  const advance = (ms) => {   // fire timers in order, exactly like the event loop under a fake clock
    const end = clock + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0]; if (!t || t.at > end) break;
      timers.shift(); clock = t.at; t.fn(); settle();
    }
    clock = end; settle();
  };
  return {
    S, calls, win, doc, host, stage, pageInner, ink, flip: flipCanvas, gutterL, gutterR, textLayer, toolbar, toolBtn, pop, popInput, sendLogBtn,
    // A tool change as the app makes it: enterTextMode/exitTextMode set txtEdit, then call the
    // routing's own syncGuard (pinned against the source by test/note-stage-guard.test.mjs).
    useTool: (t) => { S.tool = t; S.txtEdit = t === 'text' ? { el: textLayer } : null; inner.syncGuard(); },
    pencilLog: () => inner.plog.log(), globalsOff: inner.globalsOff, flipTo: inner.flipTo,   // flipTo: realFlip only
    now: () => clock,
    at: advance,
    down: (el, o) => dispatch(el, ev('pointerdown', o)),
    move: (el, o) => dispatch(el, ev('pointermove', o)),
    up: (el, o) => dispatch(el, ev('pointerup', o)),
    cancel: (el, o) => dispatch(el, ev('pointercancel', o)),
    fire: (el, type, o) => dispatch(el, ev(type, o)),
    touch: (el, type, t) => dispatch(el, touchEv(type, t)),
    scroll: (top) => { S.stage.scrollTop = top; return dispatch(S.stage, { type: 'scroll', preventDefault() {}, stopPropagation() {} }); },
    visibility: (state) => { doc.visibilityState = state; return dispatch(doc, { type: 'visibilitychange', preventDefault() {}, stopPropagation() {} }); },
  };
}

// A deliberate finger swipe: down, then moves well past the arm threshold, then release.
export function swipe(pad, el, { id = 7, from = 600, to = 200, steps = 4 } = {}) {
  pad.down(el, { id, pt: 'touch', x: from, y: 400 });
  for (let i = 1; i <= steps; i++) pad.move(el, { id, pt: 'touch', x: from + ((to - from) * i) / steps, y: 400 });
  pad.up(el, { id, pt: 'touch', x: to, y: 400 });
}
