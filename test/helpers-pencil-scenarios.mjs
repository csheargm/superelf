// PANote Pencil reliability — the scenarios, as functions of the harness options, so the SAME
// sequence runs as a repro/control (test/note-pencil-routing.test.mjs) and under each mutation
// (test/note-pencil-routing-mutation.test.mjs). Ported from independent verifiers' failing repros
// (claims A–D). Each one asserts the CORRECT behaviour; `o` is passed through to runPad, which is
// how a mutation reaches the shipped source.
import assert from 'node:assert/strict';
import { runPad } from './helpers-panote-routing.mjs';

export const PEN = { id: 2, pt: 'pen' };
const PALM = { id: 3, pt: 'touch', w: 45, h: 45 };
const PALM2 = { id: 4, pt: 'touch', w: 45, h: 45, primary: false };
const penMoves = (pad, from, to, y = 200) => { for (let x = from; x <= to; x += 10) { pad.move(pad.ink, { ...PEN, x, y }); pad.at(8); } };
export const inkBy = (pad, id, since = 0) => pad.calls.extendBy.slice(since).filter((x) => x === id).length;

// ═══ A. fingerDraw ON: a palm must never end, extend or replace the PENCIL's stroke ═══════════

// Pen writing, palm lands, palm LIFTS mid-stroke, pen keeps writing (15 moves after the lift).
export function palmLiftsMidStroke(pad, endType = 'pointerup') {
  pad.down(pad.ink, { ...PEN, x: 100, y: 200 });
  penMoves(pad, 110, 200);
  pad.down(pad.ink, { ...PALM, x: 500, y: 700 });
  penMoves(pad, 210, 250);
  pad.fire(pad.ink, endType, { ...PALM, x: 500, y: 700 });
  const mark = pad.calls.extendBy.length;
  penMoves(pad, 260, 400);
  const drawingAfter = pad.S.drawing;
  pad.up(pad.ink, { ...PEN, x: 400, y: 200 });
  return { mark, drawingAfter, palmPts: inkBy(pad, PALM.id) };
}
export const reproPalmLift = (endType, o = {}) => {
  const pad = runPad({ fingerDraw: true, ...o });
  const r = palmLiftsMidStroke(pad, endType);
  assert.equal(r.drawingAfter, true, 'the Pencil stroke is still live after the palm lifted');
  assert.equal(inkBy(pad, PEN.id, r.mark), 15, 'all 15 pen moves after the palm lift are ink');
  assert.equal(pad.calls.committed, 1, 'and the pen lift commits it as ONE stroke');
};
export const reproPalmDrift = (o = {}) => {
  const pad = runPad({ fingerDraw: true, ...o });
  pad.down(pad.ink, { ...PEN, x: 100, y: 200 });
  penMoves(pad, 110, 150);
  pad.down(pad.ink, { ...PALM, x: 500, y: 700 });
  pad.move(pad.ink, { ...PALM, x: 505, y: 703 });
  pad.move(pad.ink, { ...PALM, x: 510, y: 706 });
  penMoves(pad, 160, 200);
  pad.up(pad.ink, { ...PEN, x: 200, y: 200 });
  pad.up(pad.ink, { ...PALM, x: 510, y: 706 });
  assert.equal(inkBy(pad, PALM.id), 0, 'no palm point became part of the Pencil stroke (a stray line to the palm)');
  assert.equal(pad.calls.committed, 1);
};
export const reproPalmFirst = (o = {}) => {
  const pad = runPad({ fingerDraw: true, ...o });
  pad.down(pad.ink, { ...PALM, x: 500, y: 700 });          // indistinguishable from a finger stroke at this instant
  pad.down(pad.ink, { ...PEN, x: 100, y: 200 });           // the nib takes the stroke over
  penMoves(pad, 110, 200);
  pad.up(pad.ink, { ...PALM, x: 500, y: 700 });
  const mark = pad.calls.extendBy.length;
  penMoves(pad, 210, 300);
  pad.up(pad.ink, { ...PEN, x: 300, y: 200 });
  assert.equal(inkBy(pad, PEN.id, mark), 10, 'every pen move after the palm lift is ink');
};
export const reproTwoPalms = (o = {}) => {
  const pad = runPad({ fingerDraw: true, ...o });
  pad.down(pad.ink, { ...PEN, x: 100, y: 200 });
  pad.down(pad.ink, { ...PALM, x: 500, y: 700 });
  pad.down(pad.ink, { ...PALM2, x: 560, y: 720 });
  pad.up(pad.ink, { ...PALM2, x: 560, y: 720 });
  pad.up(pad.ink, { ...PALM, x: 500, y: 700 });
  const mark = pad.calls.extendBy.length;
  penMoves(pad, 110, 200);
  assert.equal(inkBy(pad, PEN.id, mark), 10);
};
export const controlFingerStroke = (o = {}) => {
  const pad = runPad({ fingerDraw: true, ...o });
  pad.down(pad.ink, { id: 9, pt: 'touch', x: 100, y: 300 });
  for (const x of [120, 140, 160]) pad.move(pad.ink, { id: 9, pt: 'touch', x, y: 300 });
  assert.equal(inkBy(pad, 9), 3, 'the finger stroke extends');
  pad.up(pad.ink, { id: 9, pt: 'touch', x: 160, y: 300 });
  assert.equal(pad.S.drawing, false, 'the finger that owns the stroke ends it');
  assert.equal(pad.calls.committed, 1);
};

// ═══ B. a palm SCROLL that began before the nib must stop when the nib lands ═════════════════

function palmScrollThenPen(pad) {
  pad.S.stage.scrollTop = 200;
  pad.down(pad.ink, { id: 11, pt: 'touch', x: 560, y: 700, w: 90, h: 110 });
  pad.at(40); pad.move(pad.ink, { id: 11, pt: 'touch', x: 562, y: 676, w: 90, h: 110 });   // 24px vertical → scroll
  pad.at(16); pad.move(pad.ink, { id: 11, pt: 'touch', x: 563, y: 670, w: 90, h: 110 });
  const beforePen = pad.S.stage.scrollTop;
  pad.at(60);
  pad.down(pad.ink, { ...PEN, x: 300, y: 400 });
  for (let i = 1; i <= 5; i++) {                                        // write while the palm drifts 8px/frame
    pad.at(16);
    pad.move(pad.ink, { ...PEN, x: 300 + 10 * i, y: 400 });
    pad.move(pad.ink, { id: 11, pt: 'touch', x: 563, y: 670 - 8 * i, w: 90, h: 110 });
  }
  const afterPen = pad.S.stage.scrollTop;
  pad.up(pad.ink, { ...PEN, x: 350, y: 400 });
  pad.up(pad.ink, { id: 11, pt: 'touch', x: 563, y: 630 });
  return { beforePen, afterPen };
}
export const reproPalmScroll = (o = {}) => {
  const pad = runPad(o);
  const r = palmScrollThenPen(pad);
  assert.ok(r.beforePen > 200, `precondition: the palm drag really became a scroll (scrollTop ${r.beforePen})`);
  assert.equal(r.afterPen, r.beforePen, `scrollTop moved ${r.beforePen} → ${r.afterPen} with the pen down`);
  assert.equal(pad.calls.committed, 1, 'and the Pencil stroke is untouched');
};

// ═══ C. a pen contact that ended where ink could not see it must not leave state stuck ════════

export const fingerScroll = (pad, id = 50) => {
  pad.down(pad.ink, { id, pt: 'touch', x: 300, y: 600 });
  for (const y of [560, 500, 430, 360]) pad.move(pad.ink, { id, pt: 'touch', x: 300, y });
  pad.up(pad.ink, { id, pt: 'touch', x: 300, y: 360 });
};
const assertReleased = (pad, what) => {
  assert.equal(pad.S.penId, null, `${what}: penId must be cleared once the pen is gone, got ${pad.S.penId}`);
  assert.equal(pad.S.drawing, false, `${what}: drawing must be false`);
  assert.equal(pad.calls.committed, 1, `${what}: the stroke the user drew is committed (saved), not ghosted`);
  pad.at(5000);
  fingerScroll(pad);
  assert.ok(pad.S.stage.scrollTop > 0, `${what}: a finger scroll 5 s later works, got scrollTop=${pad.S.stage.scrollTop}`);
  assert.ok(pad.ink.classList.contains('pan-canpan'), `${what}: native panning is re-enabled once the pen is gone`);
  pad.down(pad.ink, { id: 7, pt: 'pen', x: 100, y: 100 });
  pad.up(pad.ink, { id: 7, pt: 'pen', x: 100, y: 100 });
  assert.equal(pad.calls.lostStrokes, 0, `${what}: no stroke was overwritten by the next one`);
};
const penStroke = (pad) => {
  pad.down(pad.ink, { ...PEN, x: 300, y: 300 });
  for (const x of [320, 340, 360]) pad.move(pad.ink, { ...PEN, x, y: 300 });
};
export const reproLiftOnToolbar = (o = {}) => {
  const pad = runPad(o);
  penStroke(pad);
  pad.fire(pad.ink, 'lostpointercapture', PEN);                                       // lost while the nib is still down
  pad.up(pad.toolbar, { ...PEN, x: 360, y: 980 });
  assertReleased(pad, 'capture lost, lift on toolbar');
};
export const reproLiftOutside = (o = {}) => {
  const pad = runPad(o);
  pad.ink.setPointerCapture = () => { throw new Error('InvalidStateError'); };
  penStroke(pad);
  pad.up(pad.doc, { ...PEN, x: 360, y: 1200 });                                       // hit-tested outside the host
  assertReleased(pad, 'no capture, lift outside the pad');
};
// Capture lost while the nib is STILL ON the glass, as WebKit delivers it: the event carries
// buttons 0, x/y 0, pressure 0 (the harness builds every lostpointercapture that way), so nothing
// on it can say the nib is down. Ending the stroke here is the owner's symptom: the Pencil stops
// inking mid-word ("no-stroke") until it is lifted and re-gripped.
export const controlCaptureLostInContact = (o = {}) => {
  const pad = runPad(o);
  pad.down(pad.ink, { ...PEN, x: 300, y: 300 });
  for (const x of [320, 340]) pad.move(pad.ink, { ...PEN, x, y: 300 });
  const lpc = pad.fire(pad.ink, 'lostpointercapture', PEN);
  assert.deepEqual([lpc.buttons, lpc.clientX, lpc.clientY, lpc.pressure], [0, 0, 0, 0], 'precondition: WebKit-shaped');
  const mark = pad.calls.extendBy.length;
  for (const x of [360, 380, 400, 420]) pad.move(pad.ink, { ...PEN, x, y: 300 });
  assert.equal(inkBy(pad, PEN.id, mark), 4, 'all 4 pen moves after the capture loss are still ink');
  pad.up(pad.ink, { ...PEN, x: 420, y: 300 });
  assert.equal(pad.calls.committed, 1, 'and the lift commits it as ONE stroke');
  assert.equal(pad.S.penId, null);
};
export const controlEndsOnce = (o = {}) => {
  for (const tool of ['pen', 'select']) {
    const pad = runPad({ tool, ...o });
    let selUps = 0; pad.S.selUp = () => { selUps++; };
    pad.down(pad.ink, { ...PEN, x: 100, y: 100 });
    pad.move(pad.ink, { ...PEN, x: 140, y: 160 });
    pad.up(pad.ink, { ...PEN, x: 140, y: 160 });
    pad.fire(pad.ink, 'lostpointercapture', PEN);
    assert.equal(pad.S.penId, null, tool);
    if (tool === 'pen') { assert.equal(pad.calls.committed, 1); assert.equal(pad.calls.endStroke, 1, 'onUp ran once, not again from a backstop'); }
    else assert.equal(selUps, 1, 'select: selUp ran once');
  }
};
export const reproSelectMidStroke = (o = {}) => {
  const pad = runPad(o);
  pad.down(pad.ink, { ...PEN, x: 300, y: 300 });
  pad.move(pad.ink, { ...PEN, x: 330, y: 300 });
  pad.S.tool = 'select';                                                  // a finger tapped Select in the toolbar
  pad.up(pad.ink, { ...PEN, x: 330, y: 300 });
  assert.equal(pad.S.drawing, false, 'drawing ends with the lift');
  assert.equal(pad.calls.committed, 1, 'and what was drawn is kept');
  pad.S.tool = 'pen';
  const mark = pad.calls.extendBy.length;
  for (const x of [400, 450, 500]) pad.move(pad.ink, { id: 7, pt: 'pen', x, y: 500, buttons: 0, pressure: 0 });   // HOVER
  assert.equal(pad.calls.extendBy.length - mark, 0, 'a hovering Pencil extends nothing');
};
export const reproHiddenMidStroke = (o = {}) => {
  const pad = runPad(o);
  penStroke(pad);
  pad.visibility('hidden');
  pad.visibility('visible');
  assertReleased(pad, 'hidden mid-stroke');
};

// ═══ D. the shipped palm-flip lockout fix, through the REAL endFlipDrag ══════════════════════

export function palmThenNib(pad) {
  pad.down(pad.ink, { id: 1, pt: 'touch', x: 620, y: 700, w: 44, h: 44 });
  pad.at(60); pad.move(pad.ink, { id: 1, pt: 'touch', x: 590, y: 702 });
  pad.at(60); pad.move(pad.ink, { id: 1, pt: 'touch', x: 560, y: 703 });
  const flipStarted = pad.S.flipping === true && pad.S.cur === 2;
  pad.at(20);
  const before = pad.calls.startStroke;
  pad.down(pad.ink, { ...PEN, x: 300, y: 300 });
  const r = { flipStarted, inkedOnSameDown: pad.calls.startStroke === before + 1, flippingAfterNib: pad.S.flipping, curAfterNib: pad.S.cur };
  pad.at(10); pad.move(pad.ink, { ...PEN, x: 310, y: 305 });            // inside the old 320 ms window
  pad.at(500); pad.move(pad.ink, { ...PEN, x: 330, y: 320 });           // after it
  return { ...r, strokePage: pad.S.strokePage, extend: inkBy(pad, PEN.id), finalCur: pad.S.cur };
}
export const reproRealFlipCancel = (o = {}) => {
  const r = palmThenNib(runPad({ noFlip: false, realFlip: true, ...o }));
  assert.equal(r.flipStarted, true, 'precondition: the palm really started a flip');
  assert.equal(r.inkedOnSameDown, true, 'the nib inks on the SAME pointerdown');
  assert.equal(r.flippingAfterNib, false);
  assert.equal(r.curAfterNib, 1);
  assert.equal(r.strokePage, 1, 'on the page it was actually on');
  assert.equal(r.extend, 2);
  assert.equal(r.finalCur, 1);
};
