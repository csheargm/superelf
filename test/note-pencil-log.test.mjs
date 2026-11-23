// The on-device Pencil recorder（笔迹记录）— web/pencil-log.inline.html, wired into PANote by the
// PA_PENCIL_LOG glue in web/note-ui.inline.html and into the Journal by its saveLog hook.
//
// It exists to collect EVIDENCE for the open "Pencil stops until re-grip" symptom, so the tests
// pin the four things that make that evidence trustworthy and safe to collect:
//   1. bounded — a ring, never a growing array;
//   2. inert — logging never prevents or stops an event, so it cannot change what it records;
//   3. complete — every routing branch reports its decision through ONE call (pdec, R3);
//   4. private — no text, no note ids, and no handwriting: inking moves are exported without x/y
//      (a field whitelist and a scrub, not a hope).
// Plus the path out: the menu entry → the host's saveLog hook → the app's own data namespace.
// Everything runs the SHIPPED recorder, glue and routing through test/helpers-panote-routing.mjs.
// TODO(R4): over the 300-line budget. Split seam: the reading-guide and save-path sections (from
// "the reading guide matches") move to their own file; they share only runPad and the constants.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ENGINE, RECORDER, C, routingSource, recorderSource, runPad, dispatch, swipe } from './helpers-panote-routing.mjs';
import { runApp, startHarness, until } from './helpers-app.mjs';

const num = (name) => { const m = RECORDER.match(new RegExp(`\\b${name}=(\\d+)`)); assert.ok(m, `the recorder declares ${name}`); return Number(m[1]); };
const MAX = num('MAX'), WINDOW_MS = num('WINDOW_MS'), KEY_MAX = num('KEY_MAX');
const KEYS = Object.keys(new Function(`${RECORDER.match(/const KEYS=\{[\s\S]*?\};/)[0]}\nreturn KEYS;`)());   // eslint-disable-line no-new-func
const RECORDER_OFF = (s) => s.replace('window.PAPencilLog?window.PAPencilLog.attach(', 'false?window.PAPencilLog.attach(');
const PEN = { id: 2, pt: 'pen' };
const click = (el) => dispatch(el, { type: 'click', preventDefault() {}, stopPropagation() {} });
const settle = () => new Promise((r) => setImmediate(r));

// ═══ 1. bounded ═════════════════════════════════════════════════════════════════════════════
const ringCheck = (o = {}) => {
  const pad = runPad(o);
  for (let i = 0; i < MAX + 500; i++) { pad.move(pad.toolbar, { id: 9, pt: 'touch', x: i, y: 10 }); if (i % 100 === 0) pad.at(1); }
  const log = pad.pencilLog(), ev = log.events.slice(log.thinned);
  assert.equal(ev.length, MAX, 'full detail: the last MAX entries');
  assert.equal(ev[0].x, 500, 'the first 500 fell off the front');
  assert.equal(ev[MAX - 1].x, MAX + 499, 'the newest is last');
  assert.deepEqual(log.events.slice(0, log.thinned).map((e) => e.x), [0], 'of the dropped run, the key ring kept only its start');
  for (let i = 1; i < log.events.length; i++) assert.ok(log.events[i].t >= log.events[i - 1].t, 'oldest first');
};
test('the ring holds at most MAX entries — the oldest are dropped, order is kept', () => ringCheck());

// ~10-25 s of writing fills MAX (a Pencil delivers ~120 contact moves/s on a ProMotion iPad, palms
// add their own) — so the moment the Pencil stopped must outlive the re-grip and the writing after it.
const PEN3 = { id: 3, pt: 'pen' };
function writeFor(pad, ms, pen = PEN3) {
  for (let t = 0, x = 0; t < ms; t += 8, x++) {
    if (x % 120 === 0) { if (x) pad.up(pad.ink, { ...pen, x, y: 10 }); pad.down(pad.ink, { ...pen, x, y: 10 }); }
    pad.move(pad.ink, { ...pen, x, y: 10 }); pad.at(8);
  }
}
test('REPRO: the onset survives 30 s of writing after it — the key ring keeps downs, ups, cancels and decision changes', () => {
  const pad = runPad();
  pad.down(pad.ink, { ...PEN, x: 100, y: 100 }); pad.move(pad.ink, { ...PEN, x: 110, y: 100 });
  pad.cancel(pad.ink, { ...PEN, x: 110, y: 100 });                          // the onset
  pad.move(pad.ink, { ...PEN, x: 120, y: 100 });                           // the pen still down, inking nothing
  pad.at(500);
  writeFor(pad, 30_000);                                                    // re-grip, keep writing
  const log = pad.pencilLog();
  const onset = log.events.find((e) => e.type === 'pointercancel' && e.id === PEN.id);
  assert.ok(onset, 'the pen pointercancel is still in the export');
  assert.equal(onset.d, 'end');
  assert.ok(log.events.some((e) => e.type === 'pointermove' && e.id === PEN.id && e.d === 'no-stroke'), 'and the first move after it');
  assert.ok(log.thinned > 0 && log.thinned <= KEY_MAX, `a thinned head (${log.thinned}) ahead of the full ring`);
  assert.equal(log.events.length - log.thinned, MAX);
  const headExtends = log.events.slice(0, log.thinned).filter((e) => e.d === 'extend').length;
  assert.ok(headExtends <= 40, `the head is thinned — one extend per stroke, not a copy of the writing (${headExtends})`);
  for (let i = 1; i < log.events.length; i++) assert.ok(log.events[i].t >= log.events[i - 1].t, 'one timeline, oldest first');
  assert.equal(new Set(log.events).size, log.events.length, 'no entry exported twice');
});
// The key ring's MEMORY bound cannot be seen from the export (log() reads only its last KEY_MAX),
// so it is pinned on the source: every write into either ring goes through its modulo.
const ringWritesBounded = (src) => {
  const writes = src.match(/\b(ring|kring)\[[^\]]*\]=/g) || [];
  assert.equal(writes.length, 2, `one write per ring: ${writes.join(' ')}`);
  for (const w of writes) assert.match(w, w.startsWith('kring') ? /%KEY_MAX\]=$/ : /%MAX\]=$/, w);
};
test('bounded: the export never exceeds MAX + KEY_MAX, and both rings are written only modulo their size', () => {
  const pad = runPad();
  for (let i = 0; i < KEY_MAX + 500; i++) pad.down(pad.toolbar, { id: 9, pt: 'touch', x: i, y: 1 });   // key entries
  for (let i = 0; i < MAX + 10; i++) pad.move(pad.toolbar, { id: 9, pt: 'touch', x: i, y: 1 });       // one run: flushes the full ring
  const log = pad.pencilLog();
  assert.equal(log.thinned, KEY_MAX, 'the key ring is full and every entry of it is older than the full ring');
  assert.equal(log.events.length, MAX + KEY_MAX);
  ringWritesBounded(recorderSource());
  assert.throws(() => ringWritesBounded(recorderSource().replace('kring[kn++%KEY_MAX]=o', 'kring[kn++]=o')), assert.AssertionError);
});

test('the export keeps only the last WINDOW_MS, whatever the ring still holds', () => {
  const pad = runPad();
  for (let i = 0; i < 10; i++) pad.move(pad.toolbar, { id: 9, pt: 'touch', x: i, y: 10 });
  pad.at(WINDOW_MS + 1000);
  for (let i = 0; i < 5; i++) pad.move(pad.toolbar, { id: 9, pt: 'touch', x: 100 + i, y: 10 });
  assert.deepEqual(pad.pencilLog().events.map((e) => e.x), [100, 101, 102, 103, 104]);
});

test('a hovering Pencil is thinned; contact moves are not', () => {
  const pad = runPad();
  for (let i = 0; i < 50; i++) { pad.move(pad.ink, { ...PEN, x: i, y: 10, buttons: 0, pressure: 0 }); pad.at(10); }   // 500 ms of hover
  const hover = pad.pencilLog().events.filter((e) => e.type === 'pointermove').length;
  assert.ok(hover >= 4 && hover <= 6, `about one hover move per 100 ms, got ${hover}`);
  const touch = runPad();
  for (let i = 0; i < 50; i++) { touch.move(touch.toolbar, { id: 9, pt: 'touch', x: i, y: 10 }); touch.at(10); }
  assert.equal(touch.pencilLog().events.length, 50, 'every touch move is kept');
});

// ═══ 2. inert ═══════════════════════════════════════════════════════════════════════════════
test('every listener is capture-phase and passive, on window, host and stage', () => {
  const pad = runPad();
  for (const node of [pad.win, pad.host, pad.S.stage]) {
    const mine = node._listeners('pointerdown').filter((l) => l.opt && l.opt.passive);
    assert.equal(mine.length, 1, `${node._name}: one passive recorder listener`);
    assert.equal(mine[0].opt.capture, true, `${node._name}: capture phase`);
  }
});

test('logging never calls preventDefault or stopPropagation (events outside the routing)', () => {
  const pad = runPad();
  const evs = [];
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'gotpointercapture', 'lostpointercapture']) evs.push(pad.fire(pad.toolbar, type, { id: 9, pt: 'touch', x: 1, y: 1 }));
  for (const type of ['touchstart', 'touchend', 'touchcancel']) evs.push(pad.touch(pad.toolbar, type, { touches: [{ id: 1, x: 1, y: 1 }], changed: [{ id: 1, x: 1, y: 1 }] }));
  for (const e of evs) { assert.equal(e.defaultPrevented, false, e.type); assert.equal(e._stopCalls, 0, e.type); }
  assert.equal(pad.pencilLog().events.length, evs.length, 'and every one of them WAS recorded (not vacuous)');
});

// One realistic session through the ink surface: palm, pen, scroll, capture loss, hide.
function session(pad) {
  const out = [];
  const rec = (e) => out.push([e.type, e.defaultPrevented, e._stopCalls ?? 0]);
  rec(pad.down(pad.ink, { id: 5, pt: 'touch', x: 300, y: 600 }));
  for (const y of [560, 500, 430]) rec(pad.move(pad.ink, { id: 5, pt: 'touch', x: 300, y }));
  rec(pad.down(pad.ink, { ...PEN, x: 100, y: 100 }));
  rec(pad.touch(pad.ink, 'touchstart', { touches: [{ id: 1, x: 100, y: 100, tt: 'stylus' }], changed: [{ id: 1, x: 100, y: 100, tt: 'stylus' }] }));
  for (const x of [120, 140]) rec(pad.move(pad.ink, { ...PEN, x, y: 100 }));
  rec(pad.up(pad.ink, { id: 5, pt: 'touch', x: 300, y: 430 }));
  rec(pad.fire(pad.ink, 'lostpointercapture', PEN));
  rec(pad.up(pad.toolbar, { ...PEN, x: 140, y: 100 }));
  pad.visibility('hidden'); pad.visibility('visible');
  return { out, state: [pad.S.penId, pad.S.drawing, pad.S.stage.scrollTop, pad.calls.committed, pad.calls.extendStroke] };
}
test('CONTROL: the same session with the recorder ON and OFF — identical defaultPrevented, propagation and outcome', () => {
  const on = runPad(), off = runPad({ mutateLog: RECORDER_OFF });
  const a = session(on), b = session(off);
  assert.deepEqual(a.out, b.out);
  assert.deepEqual(a.state, b.state);
  assert.ok(on.pencilLog().events.length >= a.out.length, 'the ON run really recorded the session');
  assert.throws(() => off.pencilLog(), 'the OFF run really had no recorder');
});

test('MUTATION inert / bounded: a recorder that prevents, stops, or grows without bound is caught', () => {
  // A PASSIVE listener's preventDefault is ignored (the harness models that), so the harmful recorder prevents AND is not passive.
  const prevents = (s) => s.replace('if(e===last) return;', 'if(e.preventDefault) e.preventDefault(); if(e===last) return;')
    .replace('const OPT={capture:true,passive:true};', 'const OPT={capture:true,passive:false};');
  const stops = (s) => s.replace('if(e===last) return;', 'if(e.stopPropagation) e.stopPropagation(); if(e===last) return;');
  for (const m of [prevents, stops]) {
    const pad = runPad({ mutateRecorder: m });
    const e = pad.move(pad.toolbar, { id: 9, pt: 'touch', x: 1, y: 1 });
    assert.ok(e.defaultPrevented || e._stopCalls > 0, 'the check above would see it');
  }
  assert.throws(() => ringCheck({ mutateRecorder: (s) => s.replace('ring[n++%MAX]=o', 'ring[n++]=o') }), assert.AssertionError);
});

// ═══ 3. complete — one decision per routing branch ═══════════════════════════════════════════
test('a routing decision is recorded for each branch an event can take', () => {
  const seen = new Set();
  const take = (pad) => { for (const e of pad.pencilLog().events) if (e.d) for (const d of e.d.split('>')) seen.add(d); };
  let p = runPad();                                              // pen stroke, hover, palm near the pen, backstop, hide
  p.down(p.ink, { ...PEN, x: 1, y: 1 }); p.move(p.ink, { ...PEN, x: 5, y: 5 }); p.down(p.ink, { id: 3, pt: 'touch', x: 500, y: 700 });
  p.up(p.ink, { ...PEN, x: 5, y: 5 }); p.at(200); p.move(p.ink, { ...PEN, x: 9, y: 9, buttons: 0 });
  p.down(p.ink, { ...PEN, x: 1, y: 1 }); p.up(p.toolbar, { ...PEN, x: 1, y: 1 });
  p.down(p.ink, { ...PEN, x: 1, y: 1 }); p.fire(p.ink, 'lostpointercapture', PEN); p.visibility('hidden'); take(p);
  p = runPad(); p.at(5000);                                      // finger scroll, then a palm scroll the nib interrupts
  p.down(p.ink, { id: 5, pt: 'touch', x: 300, y: 600 }); for (const y of [590, 560, 500]) p.move(p.ink, { id: 5, pt: 'touch', x: 300, y });
  p.down(p.ink, { ...PEN, x: 1, y: 1 }); take(p);
  p = runPad({ noFlip: false });                                 // a flip, a pen landing mid-flip, a pen inside the settle
  p.down(p.ink, { id: 1, pt: 'touch', x: 620, y: 700 }); for (const x of [590, 520]) p.move(p.ink, { id: 1, pt: 'touch', x, y: 700 });
  p.down(p.ink, { ...PEN, x: 1, y: 1 }); p.up(p.ink, { ...PEN, x: 1, y: 1 }); p.at(1000);
  p.down(p.ink, { id: 6, pt: 'touch', x: 600, y: 400 }); for (const x of [500, 300, 150]) p.move(p.ink, { id: 6, pt: 'touch', x, y: 400 });
  p.up(p.ink, { id: 6, pt: 'touch', x: 150, y: 400 }); p.down(p.ink, { id: 8, pt: 'mouse', x: 1, y: 1 });   // a mouse is refused inside the settle,
  p.down(p.ink, { ...PEN, x: 1, y: 1 }); take(p);                                                              // a nib settles it at once
  p = runPad({ noFlip: false, realFlip: true }); swipe(p, p.ink); p.down(p.flip, { ...PEN, x: 1, y: 1 }); take(p);   // a nib the overlay caught
  p = runPad(); p.move(p.ink, { ...PEN, x: 1, y: 1 }); take(p);                                                // a nib on the glass whose down was lost
  p = runPad({ fingerDraw: true });                              // finger drawing and a non-owner touch
  p.down(p.ink, { id: 9, pt: 'touch', x: 1, y: 1 }); p.move(p.ink, { id: 9, pt: 'touch', x: 9, y: 9 }); p.move(p.ink, { id: 8, pt: 'touch', x: 9, y: 9 });
  p.up(p.ink, { id: 9, pt: 'touch', x: 9, y: 9 }); take(p);
  p = runPad({ tool: 'select' }); p.down(p.ink, { ...PEN, x: 1, y: 1 }); p.up(p.ink, { ...PEN, x: 1, y: 1 }); take(p);
  for (const d of ['draw', 'extend', 'end', 'no-stroke', 'palm-pen-near', 'pen-gone', 'hidden-pen-released', 'gesture-armed',
    'to-scroll', 'scroll', 'scroll-dropped-pen', 'flip-begin', 'flip-dropped-pen', 'refused-flipping', 'finger-draw',
    'finger-extend', 'touch-not-owner', 'finger-end', 'select', 'select-up', 'capture-lost-pen-down',
    'flip-settled-pen', 'pen-off-ink', 'late-start']) assert.ok(seen.has(d), `decision "${d}" recorded (saw ${[...seen].join(',')})`);
});

test('R3: the routing reports ONLY through pdec — it never touches the recorder directly', () => {
  const r = routingSource();
  assert.ok((r.match(/pdec\(/g) || []).length >= 25, 'the routing is instrumented');
  assert.ok(!/PAPencilLog|plog\.|\.log\(\)/.test(r), 'and holds no second logging path');
  assert.equal((ENGINE.match(/PAPencilLog\.attach\(/g) || []).length, 1, 'one attach, in the glue');
});

// ═══ 4. private ═════════════════════════════════════════════════════════════════════════════
const SECRET = 'SECRET-journal-words 秘密日记';
function privatePad(mutateRecorder) {
  const pad = runPad({ mutateRecorder });
  pad.textLayer.textContent = SECRET; pad.textLayer.innerHTML = `<p>${SECRET}</p>`;
  pad.S.NB.pages.forEach((pg) => { pg.id = `note-${SECRET}`; pg.title = SECRET; });
  pad.down(pad.textLayer, { id: 9, pt: 'touch', x: 10, y: 10 });
  pad.touch(pad.textLayer, 'touchstart', { touches: [{ id: 1, x: 10, y: 10 }], changed: [{ id: 1, x: 10, y: 10, rx: 30, ry: 40, f: 0.5 }] });
  pad.down(pad.ink, { ...PEN, x: 100, y: 100 }); pad.move(pad.ink, { ...PEN, x: 120, y: 100 }); pad.up(pad.ink, { ...PEN, x: 120, y: 100 });
  pad.scroll(40);
  return pad.pencilLog();
}
test('the exported JSON carries no text content, ids or titles — and no field the KEYS legend does not document', () => {
  const log = privatePad();
  const json = JSON.stringify(log);
  assert.ok(!json.includes('SECRET') && !json.includes('秘密'), 'no text from the text layer, the note id or its title');
  assert.deepEqual(Object.keys(log).sort(), ['at', 'build', 'dpr', 'events', 'focus', 'keys', 'kind', 'thinned', 'touchPoints', 'ua', 'v']);
  assert.ok(log.events.length >= 6, 'and the session WAS recorded');
  for (const e of log.events) for (const k of Object.keys(e)) assert.ok(KEYS.includes(k), `undocumented field "${k}"`);
  const ch = log.events.find((e) => e.ch).ch[0];
  assert.deepEqual(Object.keys(ch).sort(), ['f', 'id', 'rx', 'ry', 'tt', 'x', 'y']);
  assert.deepEqual([ch.rx, ch.ry, ch.f], [30, 40, 0.5], 'contact geometry IS recorded — it is the evidence a palm leaves');
});
test('MUTATION privacy: a recorder that copies the target text is caught by both checks', () => {
  const leak = (s) => s.replace("const o={type:e.type,tg:target(e.target)};", "const o={type:e.type,tg:target(e.target),txt:e.target&&e.target.textContent};");
  assert.throws(() => { const j = JSON.stringify(privatePad(leak)); assert.ok(!j.includes('SECRET')); });
  assert.throws(() => { for (const e of privatePad(leak).events) for (const k of Object.keys(e)) assert.ok(KEYS.includes(k)); });
});

// The handwriting itself: every inking move's x/y would redraw the last seconds of the journal.
const inking = (e) => e.type === 'pointermove' && e.b && (e.pt !== 'touch' || /finger-extend/.test(e.d || ''));
function strokesLog(fingerDraw, mutateRecorder) {
  const pad = runPad({ fingerDraw, mutateRecorder });
  const who = fingerDraw ? { id: 9, pt: 'touch' } : PEN;
  pad.down(pad.ink, { ...who, x: 100, y: 100 });
  for (let i = 1; i <= 20; i++) pad.move(pad.ink, { ...who, x: 100 + 7 * i, y: 100 + ((i * 13) % 40) });
  pad.up(pad.ink, { ...who, x: 240, y: 120 });
  pad.down(pad.ink, { id: 5, pt: 'touch', x: 600, y: 800, w: 45, h: 45 });  // a palm (fingerDraw OFF: not ink)
  pad.move(pad.ink, { id: 5, pt: 'touch', x: 604, y: 803, w: 45, h: 45 });
  return pad.pencilLog();
}
test('REPRO privacy: the export cannot redraw handwriting — inking moves carry no x/y; contacts keep their ends', () => {
  for (const fingerDraw of [false, true]) {
    const log = strokesLog(fingerDraw);
    const ink = log.events.filter(inking);
    assert.ok(ink.length >= 20, `fingerDraw ${fingerDraw}: the stroke's moves were recorded (${ink.length})`);
    for (const e of ink) assert.ok(!('x' in e) && !('y' in e), `fingerDraw ${fingerDraw}: an inking move kept x/y ${JSON.stringify(e)}`);
    const ends = log.events.filter((e) => e.type === 'pointerdown' || e.type === 'pointerup');
    assert.ok(ends.every((e) => typeof e.x === 'number'), 'downs and ups keep the point where a contact began and ended');
    if (!fingerDraw) assert.ok(log.events.some((e) => e.type === 'pointermove' && e.pt === 'touch' && e.x === 604), 'a palm move keeps its position (evidence, not ink)');
  }
});
test('MUTATION privacy: an export that keeps inking positions is caught', () => {
  const keep = (s) => s.replace('function scrub(o){', 'function scrub(o){ return o;');
  assert.ok(strokesLog(false, keep).events.filter(inking).some((e) => 'x' in e));
});

// ═══ the native-gesture state the leading hypothesis turns on ═══════════════════════════════
test('REPRO: each entry carries cp — whether the ink surface had native panning (touch-action pan) armed', () => {
  const pad = runPad();                                                       // finger drawing OFF (shipped)
  const palm = (id) => pad.touch(pad.ink, 'touchstart', { touches: [{ id, x: 500, y: 700 }], changed: [{ id, x: 500, y: 700, rx: 40, ry: 40 }] });
  pad.down(pad.ink, { ...PEN, x: 1, y: 1 }); pad.up(pad.ink, { ...PEN, x: 1, y: 1 });
  palm(1);                                                                    // inside the pen grace: panning off
  pad.at(C.PEN_GRACE_MS + 100);
  palm(2);                                                                    // a pause between words: panning ON
  assert.equal(pad.ink.classList.contains('pan-canpan'), true, 'precondition: the routing armed native panning');
  const ts = pad.pencilLog().events.filter((e) => e.type === 'touchstart');
  assert.deepEqual(ts.map((e) => e.cp), [0, 1]);
  // The pen landing after that pause: the entry says what the class says. (Observed, not changed
  // here: the routing does NOT disarm panning on a pen DOWN — penTookOver runs before penId is set
  // — so the class stays on through that stroke until the lift. Exactly what cp makes visible.)
  pad.down(pad.ink, { ...PEN, x: 1, y: 1 });
  assert.equal(pad.pencilLog().events.at(-1).cp, pad.ink.classList.contains('pan-canpan') ? 1 : 0, 'cp is the class, as the pen lands');
  pad.up(pad.ink, { ...PEN, x: 1, y: 1 });
  palm(3);
  assert.equal(pad.ink.classList.contains('pan-canpan'), false, 'precondition: the lift disarmed it');
  assert.equal(pad.pencilLog().events.at(-1).cp, 0, 'and cp follows it');
});
test('REPRO: page pan/zoom, window scroll, selection and focus changes are recorded — kind and state, never text', () => {
  const pad = runPad();
  const plain = (type) => ({ type, preventDefault() {}, stopPropagation() {} });
  const vv = pad.win.visualViewport;
  vv.scale = 1.5; vv.offsetTop = 120; dispatch(vv, plain('resize'));
  pad.win.scrollY = 64; dispatch(pad.doc, plain('scroll'));
  pad.win.getSelection = () => ({ isCollapsed: false, toString: () => SECRET });
  dispatch(pad.doc, plain('selectionchange'));
  pad.textLayer.textContent = SECRET;
  dispatch(pad.textLayer, plain('focusin'));
  const ev = pad.pencilLog().events;
  const by = (t) => ev.filter((e) => e.type === t);
  assert.deepEqual(by('resize').map((e) => [e.tg, e.vz, e.vy]), [['vv', 1.5, 120]]);
  assert.deepEqual(by('scroll').map((e) => [e.tg, e.wy]), [['doc', 64]]);
  assert.deepEqual(by('selectionchange').map((e) => e.sl), [0], 'a non-collapsed selection');
  assert.deepEqual(by('focusin').map((e) => e.tg), ['txt']);
  assert.ok(!JSON.stringify(ev).includes('SECRET'));
  for (const e of ev) for (const k of Object.keys(e)) assert.ok(KEYS.includes(k), `undocumented field "${k}"`);
  pad.scroll(40);
  assert.deepEqual(pad.pencilLog().events.filter((e) => e.type === 'scroll').map((e) => [e.tg, e.st, e.wy]), [['doc', undefined, 64], ['stage', 40, undefined]],
    'a stage scroll is logged once, as the stage');
});

// ═══ the reading guide matches what the recorder writes ══════════════════════════════════════
// docs/plans/panote-palm-flip-pen-lockout.md told the reader to look for tg values the recorder
// never writes (`pan-ink`) and a decision WebKit can never produce. Every tg:"…" and d:"…" it names
// must be one the shipped code can emit.
test('the log-reading guide names only tg values target() can produce and d values the routing emits', () => {
  const guide = fs.readFileSync(path.join(ROOT, 'docs/plans/panote-palm-flip-pen-lockout.md'), 'utf8');
  const section = guide.slice(guide.indexOf('### How to collect'));
  const named = (k) => [...section.matchAll(new RegExp(`\\b${k}:"([^"]+)"`, 'g'))].map((m) => m[1]);
  const tgs = named('tg'), ds = named('d');
  assert.ok(tgs.includes('ink') && ds.includes('no-stroke'), `the guide names targets and decisions (${tgs} / ${ds})`);
  const fixed = [...recorderSource().match(/function target\(t\)\{[\s\S]*?\n {4}\}/)[0].matchAll(/return '(\w+)'/g)].map((m) => m[1]);
  // target() logs the FIRST class only, so the toolbar (class="pan-bar pan-tools") is tg:"pan-bar", never "pan-tools".
  const classes = new Set([...ENGINE.matchAll(/class="([^"]+)"/g)].map((m) => m[1].split(/\s+/)[0]));
  for (const tg of ['ink', 'stage', 'txt']) assert.ok(!classes.has(tg) || fixed.includes(tg));
  assert.ok(!tgs.includes('pan-ink'), 'the ink canvas is logged as tg:"ink", never by its class');
  const emitted = new Set([...routingSource().matchAll(/pdec\('([\w-]+)'/g)].map((m) => m[1]));
  // Plus the recorder's OWN entries: tg:"shell" and d:"win-<blur|focus>" / d:"shell-<a type the shell relays>".
  const rec = recorderSource();
  const winTys = rec.match(/for\(const ty of \[([^\]]*)\]\) listen\(window,ty,e=>\{ if\(e\.target===window\) mark\(e,'win-'\+ty\)/)[1];
  const shellTys = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8').match(/const SHELL_EVENTS=\[([^\]]*)\];/)[1];
  for (const [pre, list] of [['win-', winTys], ['shell-', shellTys]]) for (const m of list.matchAll(/'(\w+)'/g)) emitted.add(pre + m[1]);
  const ownTg = rec.includes("tg:'shell'") ? ['shell'] : [];
  for (const tg of tgs) assert.ok(fixed.includes(tg) || classes.has(tg) || ownTg.includes(tg), `tg:"${tg}" — target() returns ${fixed.join('/')}, a FIRST class name, or the recorder's own tg:"shell"`);
  for (const d of ds) assert.ok(emitted.has(d), `d:"${d}" is a decision the routing or the recorder emits`);
});

// ═══ the path out: menu entry → saveLog → the app's own data namespace ═══════════════════════
const PATH_SHAPE = /^debug\/pencil-log-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.json$/;
test('"Send Pencil log" calls the host hook with debug/pencil-log-<ISO>.json and the JSON, then confirms', async () => {
  const pad = runPad({ saveLog: async () => ({ ok: true }) });
  pad.down(pad.ink, { ...PEN, x: 1, y: 1 }); pad.up(pad.ink, { ...PEN, x: 1, y: 1 });
  click(pad.sendLogBtn); await settle();
  assert.equal(pad.calls.saveLog.length, 1);
  const { path: p, text } = pad.calls.saveLog[0];
  assert.match(p, PATH_SHAPE);
  const log = JSON.parse(text);
  assert.equal(log.kind, 'pa-pencil-log'); assert.equal(log.build, 'unstamped', 'the harness is not served by web.mjs');
  assert.ok(log.events.length >= 2);
  assert.equal(pad.calls.closePops, 1, 'the popover closes');
  assert.ok(pad.calls.flash[0].includes(p), `the confirmation names the file: ${pad.calls.flash[0]}`);
});
test('a refused or throwing save is SAID, never swallowed (R5)', async () => {
  const no = runPad({ saveLog: async () => ({ ok: false, error: 'disk full' }) });
  click(no.sendLogBtn); await settle();
  assert.match(no.calls.flash[0], /NOT saved.*disk full/);
  const boom = runPad({ saveLog: async () => { throw new Error('broker gone'); } });
  click(boom.sendLogBtn); await settle();
  assert.match(boom.calls.flash[0], /NOT saved.*broker gone/);
});
test('the entry exists only when the host wired saveLog — and sits in the ink popover, not the toolbar', () => {
  const pad = runPad();
  assert.equal(pad.sendLogBtn._listeners('click').length, 0, 'no hook, no entry wired');
  const markup = ENGINE.match(/\(opts\.saveLog\?'<button type="button" class="pan-photoopt pan-sendlog">[^\n]*发送笔迹日志 · Send Pencil log/);
  assert.ok(markup, 'the button is rendered only behind opts.saveLog');
  const pop = ENGINE.indexOf("'<div class=\"pan-pop pan-inkpop\">'"), end = ENGINE.indexOf("'<div class=\"pan-pop pan-paperpop\">'");
  assert.ok(markup.index > pop && markup.index < end, 'inside the ink popover');
});
// Both PANote hosts in the owner's workspace: the Journal and the Bible app. shared-apps/notes is a
// PROMOTED snapshot with a byte manifest (test/line-endings.test.mjs) — it picks this up at the
// owner's next promote, not by hand-editing.
for (const app of ['notes', 'bible']) {
  test(`the owner's ${app} app wires saveLog through its checked DATA.write`, () => {
    assert.match(fs.readFileSync(path.join(ROOT, `workspace/apps/${app}/index.html`), 'utf8'), /\n {2}saveLog:\(path,text\)=>DATA\.write\(path,text\),\n/);
  });
}
test('END TO END: the Journal hook writes the log into data/notes/debug/ through the real broker and writer', async () => {
  const h = await startHarness('notes');
  try {
    const app = runApp('notes (live)', h.relay, ['S'], { clampTimers: true });
    await until(() => app.captured.pads.length > 0, 'the journal mounts its pad');
    const opts = app.captured.pads[0].opts;
    const rel = 'debug/pencil-log-2026-10-11T08-00-00-000Z.json';
    assert.match(rel, PATH_SHAPE);
    const r = await opts.saveLog(rel, JSON.stringify({ kind: 'pa-pencil-log', v: 1, events: [{ t: 1, type: 'pointerdown' }] }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(JSON.parse(fs.readFileSync(h.file(rel), 'utf8')).kind, 'pa-pencil-log', 'the file is on disk in the app namespace');
    app.stopPads();
  } finally { await h.stop(); }
});

test('END TO END: the Bible app hook writes the log into data/bible/debug/ through the real broker and writer', async () => {
  const h = await startHarness('bible');
  try {
    const A = runApp('bible (live)', h.relay, ['NOTE_OPTS'], { clampTimers: true });
    const rel = 'debug/pencil-log-2026-10-11T08-00-00-000Z.json';
    assert.equal(typeof A.NOTE_OPTS.saveLog, 'function', 'the Bible app hands PANote a saveLog hook');
    const r = await A.NOTE_OPTS.saveLog(rel, JSON.stringify({ kind: 'pa-pencil-log', v: 2, events: [] }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(JSON.parse(fs.readFileSync(h.file(rel), 'utf8')).kind, 'pa-pencil-log', 'the file is on disk in the bible namespace');
  } finally { await h.stop(); }
});

// ═══ cost ═══════════════════════════════════════════════════════════════════════════════════
test('per-event cost is negligible, and the per-event path does no JSON, DOM queries or layout reads', () => {
  // record() and everything it calls per event: fill() and settle().
  const src = recorderSource(), perEvent = ['function record(e){', 'function fill(o,e){', 'function settle(o){'];
  const body = perEvent.map((head) => { const i = src.indexOf(head); assert.ok(i > 0, head); return src.slice(i, src.indexOf('\n    function ', i + 1)); }).join('\n');
  assert.ok(body.includes('ring[n++%MAX]=o') && body.includes('o.vz=') && body.includes('kring['), 'the scan covers all three bodies');
  for (const bad of ['JSON', 'querySelector', 'getBoundingClientRect', 'getComputedStyle', 'offsetWidth', 'offsetHeight', 'textContent', 'innerHTML'])
    assert.ok(!body.includes(bad), `record() must not use ${bad}`);
  // Timed on the recorder's OWN listener, evaluated with plain bindings (no harness Proxy scope,
  // which costs more than the recorder itself) and a plain snap, the way a browser resolves them.
  // The window listener records; host and stage see the same event object and return at once.
  const node = () => ({ addEventListener() {} });
  const win = { devicePixelRatio: 2 }, doc = node(), ink = node(), stage = node(), state = { tool: 'pen', penId: 2, drawing: true };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'performance', 'navigator', recorderSource())(win, doc, performance, { userAgent: 'x' });
  let rec = null;
  win.PAPencilLog.attach({ host: node(), stage, ink, textLayer: node(),
    listen: (t, type, fn) => { if (type === 'pointermove') rec = fn; },
    snap: (o) => { o.tool = state.tool; o.pen = state.penId; o.dr = state.drawing; o.fl = false; o.sc = null; o.fd = false; o.nf = true; } });
  const N = 200_000, evs = [];
  for (let i = 0; i < 1000; i++) evs.push({ type: 'pointermove', pointerId: 2, pointerType: 'pen', isPrimary: true, buttons: 1, pressure: 0.4, width: 1, height: 1, clientX: i, clientY: i, target: ink });
  const run = (fn) => { const t = process.hrtime.bigint(); for (let i = 0; i < N; i++) { const e = evs[i % 1000]; fn(e); fn(e); fn(e); evs[i % 1000] = { ...e }; } return Number(process.hrtime.bigint() - t) / N; };
  const noop = () => {};
  run(rec); run(noop);                                           // warm both
  const per = Math.max(0, run(rec) - run(noop));
  console.log(`[pencil-log] recorder overhead ≈ ${per.toFixed(0)} ns per pen move (3 listener calls, 1 entry)`);
  assert.ok(per < 2_000, `under 2 µs per event even on a loaded CI box, measured ${per.toFixed(0)} ns`);
});
