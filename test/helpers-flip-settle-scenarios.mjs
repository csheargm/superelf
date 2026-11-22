// PANote flip-settle fix — the scenarios beyond the device replay (that one is in
// test/helpers-flip-settle.mjs). Each asserts the CORRECT behaviour and takes the harness options,
// so test/note-flip-settle-pen-mutation.test.mjs can run the same sequence against a mutated source.
import assert from 'node:assert/strict';
import { runPad, swipe } from './helpers-panote-routing.mjs';
import { STYLE, OVERLAY_CATCHES, NIB, inkBy, decisions, installPopOutside } from './helpers-flip-settle.mjs';
import { palmLiftsMidStroke } from './helpers-pencil-scenarios.mjs';

export { fingerScroll } from './helpers-pencil-scenarios.mjs';

// ── The three layers, as exact pieces of the shipped source (a renamed piece fails loudly) ──
export const cut = (piece, by = '') => (src) => { assert.ok(src.includes(piece), `the source still holds: ${piece}`); return src.split(piece).join(by); };
export const L = {
  settle: cut("host.addEventListener('pointerdown',e=>{ if(e.pointerType==='pen') penLandsInFlip(e); },{capture:true});"),
  late: cut('if(lateStart(e)) return;'),
};
const both = (s) => L.late(L.settle(s));
// Each layer ON with the others OFF (getters: the CSS mutation must run against the shipped sheet).
export const ONLY = {
  get settle() { return { css: OVERLAY_CATCHES(STYLE), mutate: L.late }; },
  get late() { return { css: OVERLAY_CATCHES(STYLE), mutate: L.settle }; },
  get overlay() { return { mutate: both }; },
  get overlayLate() { return { mutate: L.settle }; },
  get none() { return { css: OVERLAY_CATCHES(STYLE), mutate: both }; },
};

const pen = (o) => ({ ...NIB, x: 300, y: 400, ...o });
const lateStarts = (pad) => decisions(pad, 'pointermove', 'pen').filter((d) => d.includes('late-start')).length;
const flipPad = (o = {}) => { const pad = runPad({ noFlip: false, realFlip: true, cur: 1, ...o }); pad.at(5000); return pad; };
const commitSwipe = (pad) => swipe(pad, pad.ink, { id: 7, from: 600, to: 200 });   // prog 0.5 → commits
const snapSwipe = (pad) => swipe(pad, pad.ink, { id: 7, from: 600, to: 570 });     // prog 0.04 → snaps back
const flipState = (pad) => ({ cur: pad.S.cur, flipping: pad.S.flipping, overlay: pad.flip.style.display,
  transform: pad.pageInner.style.transform, transition: pad.pageInner.style.transition });

// ═══ the settle takeover ═════════════════════════════════════════════════════════════════════
export function settleSameState(commit, o = {}) {
  const natural = flipPad(o), early = flipPad(o);
  for (const p of [natural, early]) { (commit ? commitSwipe : snapSwipe)(p); assert.equal(p.S.flipping, true, 'precondition: settling'); }
  natural.at(400);
  early.at(100);
  early.down(early.ink, pen());
  assert.deepEqual(flipState(early), flipState(natural), 'the nib ends the settle in exactly the state the timer leaves');
  assert.equal(early.S.strokePage, commit ? 2 : 1, 'and inks on that page, from the same pointerdown');
  early.at(1000);
  assert.deepEqual(flipState(early), flipState(natural), 'the cancelled timer never runs the end a second time');
  early.up(early.ink, pen());
  assert.equal(early.calls.committed, 1);
  early.down(early.ink, pen({ id: 44 })); early.up(early.ink, pen({ id: 44 }));
  assert.equal(decisions(early, 'pointerdown', 'pen').at(-1), 'ink:draw', 'a later nib finds no settle left to run');
}
// A button flip started right after a nib cut a swipe's settle short gets its OWN full animation:
// the swipe's timer was cleared, it does not end the new flip early.
export async function buttonFlipAfterEarlySettle(o = {}) {
  const pad = flipPad(o);
  commitSwipe(pad);                                                    // the swipe's timer: now + FLIP_MS + 40
  pad.at(100); pad.down(pad.ink, pen()); pad.up(pad.ink, pen());
  pad.at(100);
  assert.equal(await pad.flipTo(1), true, 'precondition: a button flip back');
  pad.at(150);                                                         // past the swipe's old deadline, inside the new one
  assert.equal(pad.S.flipping, true, 'the new flip is still animating');
  pad.at(400);
  assert.deepEqual([pad.S.flipping, pad.S.cur], [false, 1]);
}
// A palm already scrolling when a late nib starts is stopped by the existing scroll guard.
export function latePalmScrollStops(o = {}) {
  const pad = runPad(o);
  pad.S.stage.scrollTop = 200;
  pad.down(pad.ink, { id: 11, pt: 'touch', x: 560, y: 700 });
  for (const y of [676, 650]) { pad.at(16); pad.move(pad.ink, { id: 11, pt: 'touch', x: 560, y }); }
  const before = pad.S.stage.scrollTop;
  assert.ok(before > 200, 'precondition: the palm is scrolling');
  movesOn(pad, pad.ink, {}, 2);
  assert.equal(lateStarts(pad), 1, 'precondition: the nib late-started');
  for (const y of [620, 590]) { pad.at(16); pad.move(pad.ink, { id: 11, pt: 'touch', x: 560, y }); }
  assert.equal(pad.S.stage.scrollTop, before, 'the page does not scroll under the nib');
}
export async function buttonFlipSettle(o = {}) {
  const natural = flipPad(o), early = flipPad(o);
  for (const p of [natural, early]) { assert.equal(await p.flipTo(2), true); assert.equal(p.S.flipping, true, 'precondition: animating'); }
  natural.at(400);
  early.at(100);
  early.down(early.ink, pen());
  assert.deepEqual(flipState(early), flipState(natural));
  assert.equal(early.S.strokePage, 2);
}
export function barTapKeepsSettle(o = {}) {
  const pad = flipPad(o);
  commitSwipe(pad);
  pad.at(100);
  pad.down(pad.toolBtn, pen());
  pad.up(pad.toolBtn, pen());
  assert.equal(pad.S.flipping, true, 'a pen tap on a bar does not cut the animation short');
  pad.at(400);
  assert.equal(pad.S.flipping, false);
}
export function inkDownOneStroke(o = {}) {
  const pad = flipPad(o);
  commitSwipe(pad);
  pad.at(100);
  pad.down(pad.ink, pen());
  assert.equal(pad.calls.startStroke, 1, 'one stroke');
  assert.equal(pad.calls.lostStrokes, 0, 'not a second one replacing the first');
  assert.deepEqual(decisions(pad, 'pointerdown', 'pen'), ['ink:flip-settled-pen>draw']);
}
// A nib that lands off the ink during a LIVE palm drag (guard 1 cancels it) draws on that down too —
// on the overlay (layer 2 off) or on bare stage — on the page the palm had not really turned.
export function liveDragNibOffInk(o = {}) {
  for (const where of ['stage', 'flip']) {
    const pad = flipPad(o);
    pad.down(pad.ink, { id: 7, pt: 'touch', x: 600, y: 400, w: 90, h: 90 });
    for (const x of [590, 575, 540]) pad.move(pad.ink, { id: 7, pt: 'touch', x, y: 400, w: 90, h: 90 });
    assert.equal(pad.S.flipping, true, 'precondition: a palm is dragging the page');
    pad.down(pad[where], pen());
    assert.deepEqual([pad.calls.startStroke, pad.S.strokePage, pad.S.cur], [1, 1, 1], `${where}: inks on the same down, on the page it was on`);
  }
}
// Outside a page-turn, bare stage is a margin: a pen there draws nothing (as before).
export function marginPenNoTurn(o = {}) {
  const pad = runPad(o);
  pad.down(pad.stage, pen({ x: 10 }));
  pad.up(pad.stage, pen({ x: 10 }));
  assert.equal(pad.calls.startStroke, 0);
}
export function textToolOverlayNoInk(o = {}) {
  const pad = flipPad(o);
  pad.useTool('text');
  swipe(pad, pad.textLayer, { id: 7, from: 600, to: 200 });
  assert.equal(pad.S.flipping, true, 'precondition: a T-tool flip is settling');
  pad.at(100);
  pad.down(pad.flip, pen());                                           // the overlay caught it (layer 2 off)
  assert.equal(pad.S.flipping, false, 'the nib still ends the settle');
  assert.equal(pad.calls.startStroke, 0, 'but the T tool never inks');
}
export function fingerCapturedFirst(o = {}) {
  for (const [surface, tool] of [['ink', 'pen'], ['gutterR', 'text']]) {
    const pad = flipPad(o);
    pad.useTool(tool);
    const el = pad[surface], seen = [];
    const real = el.setPointerCapture; el.setPointerCapture = (id) => { seen.push(pad.flip.style.display || 'none'); real(id); };
    pad.down(el, { id: 7, pt: 'touch', x: 600, y: 400 });
    for (const x of [590, 575, 540, 480]) pad.move(el, { id: 7, pt: 'touch', x, y: 400 });
    assert.equal(pad.flip.style.display, 'block', `${surface}: precondition: the flip runs and its overlay is up`);
    assert.ok(seen.length >= 1 && seen.every((d) => d === 'none'), `${surface}: the finger was captured BEFORE the overlay appeared (${seen})`);
    pad.up(el, { id: 7, pt: 'touch', x: 300, y: 400 });
    pad.at(400);
    assert.equal(pad.S.cur, 2, `${surface}: the captured finger finished its flip`);
  }
}

// ═══ (c) the late start never invents ink ═══════════════════════════════════════════════════
const movesOn = (pad, el, o, n = 6) => { for (let i = 0; i < n; i++) { pad.at(8); pad.move(el, pen({ x: 300 + 5 * i, ...o })); } };
export function lateHover(o = {}) {
  for (const f of [{ buttons: 0, pressure: 0 }, { buttons: 0, pressure: 0.3 }, { buttons: 1, pressure: 0 }]) {
    const pad = runPad(o);
    movesOn(pad, pad.ink, f);
    assert.equal(pad.calls.startStroke, 0, `no ink from ${JSON.stringify(f)}`);
  }
  const control = runPad(o);
  movesOn(control, control.ink, { buttons: 1, pressure: 0.3 });
  assert.equal(lateStarts(control), 1, 'control: a nib ON the glass does late-start');
}
export function lateNotTouchOrMouse(o = {}) {
  for (const fingerDraw of [false, true]) {
    const pad = runPad({ fingerDraw, ...o });
    for (let i = 0; i < 6; i++) pad.move(pad.ink, { id: 9, pt: 'touch', x: 300 + 5 * i, y: 400, buttons: 1 });
    assert.equal(pad.calls.startStroke, 0, `touch (fingerDraw ${fingerDraw})`);
  }
  const pad = runPad(o);
  pad.down(pad.toolBtn, { id: 1, pt: 'mouse', x: 10, y: 10 });
  for (let i = 0; i < 6; i++) pad.move(pad.ink, { id: 1, pt: 'mouse', x: 300 + 5 * i, y: 400, buttons: 1, pressure: 0.5 });
  assert.equal(pad.calls.startStroke, 0, 'a mouse pressed on a bar and dragged onto the page');
}
export function lateNotSelectOrText(o = {}) {
  for (const tool of ['select', 'text']) {
    const pad = runPad(o);
    pad.useTool(tool);
    movesOn(pad, pad.ink, {});
    assert.equal(pad.calls.startStroke, 0, tool);
  }
}
export function lateNotAfterLift(o = {}) {
  for (const end of ['up', 'cancel']) {
    const pad = runPad(o);
    pad.down(pad.ink, pen());
    movesOn(pad, pad.ink, {}, 3);
    pad[end](pad.ink, pen());
    movesOn(pad, pad.ink, {});
    assert.equal(pad.calls.startStroke, 1, `after a pointer${end}, that pen's moves never start a stroke`);
  }
}
export function lateNotDuringFlip(o = {}) {
  const pad = flipPad(o);
  pad.down(pad.ink, { id: 7, pt: 'touch', x: 600, y: 400 });
  for (const x of [590, 575, 540]) pad.move(pad.ink, { id: 7, pt: 'touch', x, y: 400 });
  assert.equal(pad.S.flipping, true, 'precondition: a live flip');
  movesOn(pad, pad.ink, {}, 3);
  pad.up(pad.ink, { id: 7, pt: 'touch', x: 200, y: 400 });
  movesOn(pad, pad.ink, {}, 3);
  assert.equal(pad.S.flipping, true, 'precondition: still settling');
  assert.equal(pad.calls.startStroke, 0, 'no late start while a page turns or settles');
  pad.at(400);
  movesOn(pad, pad.ink, {}, 1);
  assert.equal(pad.calls.startStroke, 1, 'control: once it has settled, it does');
}
export function lateNotWithPopover(o = {}) {
  const open = runPad(o);
  open.pop.classList.add('on');
  movesOn(open, open.ink, {});
  assert.equal(open.calls.startStroke, 0, 'a popover is open: no late start');
  const swallowed = runPad(o);
  installPopOutside(swallowed);
  swallowed.pop.classList.add('on');
  swallowed.down(swallowed.ink, pen());
  assert.equal(swallowed.pop.classList.contains('on'), false, 'precondition: the nib closed the popover');
  assert.equal(swallowed.calls.startStroke, 0, 'precondition: and its down was swallowed');
  movesOn(swallowed, swallowed.ink, {});
  assert.equal(swallowed.calls.startStroke, 0, 'the rest of that contact never inks');
}
export function lateNotFromBar(o = {}) {
  const pad = runPad(o);
  pad.down(pad.toolBtn, pen());
  movesOn(pad, pad.ink, {});
  assert.equal(pad.calls.startStroke, 0);
}
export function lateNotOverOwner(o = {}) {
  const er = runPad({ tool: 'erase', ...o });
  er.down(er.ink, pen());
  er.S.tool = 'pen';                                                   // a finger picked the pen mid-contact
  movesOn(er, er.ink, {});
  assert.equal(er.calls.startStroke, 0, 'the eraser contact owns the surface: not restarted as ink');
  const fd = runPad({ fingerDraw: true, ...o });
  fd.down(fd.ink, { id: 9, pt: 'touch', x: 100, y: 100 });
  movesOn(fd, fd.ink, {});
  assert.equal(fd.calls.lostStrokes, 0, 'a live finger stroke is never replaced');
  assert.equal(lateStarts(fd), 0);
}
export function lateEraser(o = {}) {
  const pad = runPad({ tool: 'erase', ...o });
  movesOn(pad, pad.ink, {});
  assert.equal(lateStarts(pad), 1);
  assert.equal(pad.S.penId, NIB.id, 'the late contact owns the surface');
  assert.ok(pad.calls.erase >= 6, 'and erases along its path');
  pad.down(pad.ink, { id: 3, pt: 'touch', x: 500, y: 700 });
  assert.ok(decisions(pad, 'pointerdown', 'touch').includes('ink:palm-pen-near'), 'a palm is rejected under it');
  pad.up(pad.ink, pen());
  assert.equal(pad.S.penId, null);
}

// ═══ (d) everyday writing unchanged ══════════════════════════════════════════════════════════
export function everydayStrokesAndTaps(o = {}) {
  for (const noFlip of [true, false]) {
    const pad = runPad({ noFlip, ...o });
    for (let s = 0; s < 5; s++) {
      pad.at(200); pad.down(pad.ink, pen({ x: 100 }));
      movesOn(pad, pad.ink, { y: 100 + 20 * s }, 10);
      pad.up(pad.ink, pen());
      pad.at(60); pad.down(pad.ink, pen({ x: 50 })); pad.up(pad.ink, pen({ x: 50 }));
    }
    assert.deepEqual([pad.calls.startStroke, pad.calls.committed, pad.calls.lostStrokes, inkBy(pad, NIB.id)], [10, 10, 0, 50], `noFlip ${noFlip}`);
    assert.equal(lateStarts(pad), 0, 'no late start in ordinary writing');
  }
}
export function everydayPalm(fingerDraw, o = {}) {
  const pad = runPad({ fingerDraw, ...o });
  const r = palmLiftsMidStroke(pad, 'pointerup');
  assert.equal(r.palmPts, 0);
  assert.equal(pad.calls.committed, 1);
  assert.equal(lateStarts(pad), 0);
}
