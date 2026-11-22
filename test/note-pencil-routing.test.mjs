// PANote Pencil reliability — who OWNS the stroke, and how a lost pen contact is let go.
//
// Ported from independent verifiers' failing repros (claims A–D), run against the SHIPPED routing
// through the shared harness (test/helpers-panote-routing.mjs — extraction + real dispatch). Each
// defect has a REPRO (asserts the correct behaviour; every one was red before the fix) and a
// CONTROL (a sequence that must behave the same before and after, so a fix cannot pass by muting
// the input). The scenarios live in test/helpers-pencil-scenarios.mjs so the same sequences run
// under each mutation in test/note-pencil-routing-mutation.test.mjs (R14).
//
// The owner's OPEN symptom (Pencil stops until re-grip, finger drawing OFF) is NOT claimed fixed
// by anything here. These are the defects a test could prove; the Pencil recorder
// (test/note-pencil-log.test.mjs) exists to collect evidence for the rest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C, runPad } from './helpers-panote-routing.mjs';
import * as Sc from './helpers-pencil-scenarios.mjs';

const { PEN, inkBy } = Sc;

// ═══ A. fingerDraw ON: stroke ownership ══════════════════════════════════════════════════════
for (const endType of ['pointerup', 'pointercancel']) {
  test(`A REPRO fingerDraw ON: a palm ${endType} while the Pencil writes does not end the Pencil's stroke`, () => Sc.reproPalmLift(endType));
}
test('A REPRO fingerDraw ON: palm drift while the Pencil writes adds no points to the Pencil stroke', () => Sc.reproPalmDrift());
test('A REPRO fingerDraw ON: palm lands BEFORE the nib, then lifts — the Pencil keeps inking', () => Sc.reproPalmFirst());
test('A REPRO fingerDraw ON: two palm contacts — neither lift ends the Pencil stroke', () => Sc.reproTwoPalms());
test('A CONTROL fingerDraw ON: a finger stroke on its own still draws, extends and ends on its own lift', () => Sc.controlFingerStroke());
test('A CONTROL fingerDraw OFF (shipped default): palm lift / cancel / drift never touch the Pencil (unchanged)', () => {
  for (const endType of ['pointerup', 'pointercancel']) {
    const pad = runPad();
    assert.equal(pad.S.fingerDraw, false);
    const r = Sc.palmLiftsMidStroke(pad, endType);
    assert.equal(inkBy(pad, PEN.id, r.mark), 15, endType);
    assert.equal(r.palmPts, 0);
    assert.equal(pad.calls.committed, 1);
  }
});
test('A CONTROL fingerDraw OFF: a plain Pencil stroke is unchanged — capture, ink, lift, release', () => {
  const pad = runPad();
  pad.down(pad.ink, { ...PEN, x: 100, y: 100 });
  assert.deepEqual(pad.ink.captured, [2]);
  pad.move(pad.ink, { ...PEN, x: 140, y: 160 });
  pad.move(pad.ink, { ...PEN, x: 180, y: 220 });
  pad.up(pad.ink, { ...PEN, x: 180, y: 220 });
  assert.equal(inkBy(pad, PEN.id), 2);
  assert.equal(pad.calls.endStroke, 1);
  assert.equal(pad.calls.committed, 1);
  assert.equal(pad.S.penId, null);
  assert.deepEqual(pad.ink.captured, []);
});

// ═══ B. a palm scroll begun before the nib ═══════════════════════════════════════════════════
for (const noFlip of [C.NO_FLIP_DEFAULT, false]) {
  test(`B REPRO (noFlip=${noFlip}): a palm scroll started before the nib does not scroll the page under the Pencil`, () => Sc.reproPalmScroll({ noFlip }));
}
test('B CONTROL: a palm that lands AFTER the nib cannot start a scroll; a plain finger scroll still scrolls', () => {
  const late = runPad();
  late.S.stage.scrollTop = 200;
  late.down(late.ink, { ...PEN, x: 300, y: 400 });
  late.at(30);
  late.down(late.ink, { id: 11, pt: 'touch', x: 560, y: 700 });
  for (const y of [676, 650, 620, 590]) { late.at(16); late.move(late.ink, { id: 11, pt: 'touch', x: 562, y }); }
  assert.equal(late.S.stage.scrollTop, 200);

  const plain = runPad();
  plain.S.stage.scrollTop = 200;
  plain.down(plain.ink, { id: 5, pt: 'touch', x: 300, y: 600 });
  for (const y of [560, 500, 430]) { plain.at(16); plain.move(plain.ink, { id: 5, pt: 'touch', x: 300, y }); }
  assert.ok(plain.S.stage.scrollTop > 200, 'a finger scroll with no pen anywhere still scrolls (unchanged)');
});

// ═══ C. a pen contact that ended where ink could not see it ══════════════════════════════════
test('C REPRO: capture lost mid-stroke and the lift lands on the toolbar — nothing stays stuck', () => Sc.reproLiftOnToolbar());
test('C REPRO: capture never taken (setPointerCapture is best-effort) and the lift lands outside the pad', () => Sc.reproLiftOutside());
test('C REPRO: capture lost while the nib is STILL ON the glass (WebKit-shaped: buttons 0) — the Pencil keeps inking', () => Sc.controlCaptureLostInContact());
test('C CONTROL: a normal stroke (lift on ink, then the trailing lostpointercapture) ends exactly once', () => Sc.controlEndsOnce());
test('C REPRO: switching to Select mid-stroke — the lift commits the stroke and a hovering Pencil adds no ink', () => Sc.reproSelectMidStroke());
test('C REPRO: the page is hidden mid-stroke (no lift ever delivered) — on return nothing is stuck', () => Sc.reproHiddenMidStroke());
test('C CONTROL (already true before the fix): hidden mid palm-flip, the Pencil still draws on its own page on return', () => {
  // The nib's own pointerdown cancels the stale flip through penTookOver → endFlipDrag(false,true),
  // so the hide handler deliberately does NOT touch flip state.
  const pad = runPad({ noFlip: false, cur: 1 });
  pad.down(pad.ink, { id: 1, pt: 'touch', x: 620, y: 700 });
  for (const x of [590, 520]) pad.move(pad.ink, { id: 1, pt: 'touch', x, y: 700 });
  assert.equal(pad.S.flipping, true, 'precondition: the palm started a flip drag');
  pad.visibility('hidden');
  pad.visibility('visible');
  pad.at(50);
  const before = pad.calls.startStroke;
  pad.down(pad.ink, { ...PEN, x: 300, y: 300 });
  assert.equal(pad.calls.startStroke, before + 1, 'the nib draws');
  assert.equal(pad.S.strokePage, 1, 'on the page it was actually on');
});
test('C CONTROL: hide/show with nothing in flight changes nothing; a pen stroke after it is normal', () => {
  const pad = runPad();
  pad.visibility('hidden'); pad.visibility('visible');
  assert.equal(pad.calls.endStroke, 0, 'no stroke to end, none ended');
  pad.down(pad.ink, { ...PEN, x: 100, y: 100 });
  pad.move(pad.ink, { ...PEN, x: 120, y: 100 });
  pad.up(pad.ink, { ...PEN, x: 120, y: 100 });
  assert.equal(pad.calls.committed, 1);
});
test('C: the document-level listeners are torn down with the pad (destroy runs globalsOff)', () => {
  const pad = runPad();
  const live = () => pad.doc._listeners().length + pad.win._listeners().length;
  assert.ok(live() > 0, 'precondition: the recorder and the pen backstop listen on window/document');
  pad.globalsOff.forEach((off) => off());
  assert.equal(live(), 0, 'nothing is left listening once the pad is gone');
});

// ═══ D. the shipped palm-flip lockout fix, through the REAL endFlipDrag ══════════════════════
// note-palm's stub models endFlipDrag; this runs the engine's own (realFlip) on the fake clock,
// so its `immediate` branch — the actual fix from b174a71 — is what is under test.
test('D: through the REAL endFlipDrag, the nib that cancels a palm-flip inks on the SAME pointerdown, right page', () => Sc.reproRealFlipCancel());
test('D: with the shipped default (swipe-to-flip off) the palm slide cannot start a flip at all', () => {
  const r = Sc.palmThenNib(runPad({ realFlip: true }));
  assert.equal(r.flipStarted, false);
  assert.equal(r.inkedOnSameDown, true);
  assert.equal(r.finalCur, 1);
});
