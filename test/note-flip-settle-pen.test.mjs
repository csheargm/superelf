// PANote — a nib that lands while a page-turn SETTLES must ink, from its own pointerdown.
//
// The owner's iPad (swipe-to-flip ON): a resting hand started a finger flip, iPadOS cancelled the
// hand, the flip went on settling for FLIP_MS+40 ms with no finger left, and the nib that landed
// inside that window hit the page-turn overlay — then ~440 ms of writing were "no-stroke" until the
// Pencil was re-gripped. Three layers close it (web/note-ui.inline.html, routing block + flip code):
//   1. the settle takeover — the nib ends the settle at once and the same pointerdown draws;
//   2. the overlay (.pan-flip) is pointer-events:none — it never catches a contact;
//   3. the late start — a pen on the glass with no stroke starts one where it is.
// Every scenario runs the SHIPPED routing and flip code (realFlip) through the shared harness.
// Mutations, one per layer and per guard: test/note-flip-settle-pen-mutation.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPad, swipe } from './helpers-panote-routing.mjs';
import * as F from './helpers-flip-settle.mjs';
import * as Sc from './helpers-flip-settle-scenarios.mjs';

const { NIB } = F;

// ═══ (a) the device sequence, replayed ═══════════════════════════════════════════════════════
test('(a) REPRO the device log: a nib landing 286 ms into a cancelled flip\'s settle inks every move', () => {
  const r = F.reproDeviceLog();
  assert.equal(r.nibOn, 'stage', 'the nib passes through the overlay — to bare stage, the page box being slid aside');
  assert.equal(r.flippingAfterDown, false, 'the settle ended the instant the nib landed');
  assert.equal(r.curAfterDown, 1, 'on the page the snap-back would have left');
  assert.deepEqual(F.decisions(r.pad, 'pointerdown', 'pen'), ['stage:flip-settled-pen>pen-off-ink>draw']);
});

// ═══ (b) each layer on its own ═══════════════════════════════════════════════════════════════
test('(b) the SETTLE TAKEOVER alone (overlay catching the nib, no late start) recovers the whole stroke', () => {
  const r = F.reproDeviceLog(Sc.ONLY.settle);
  assert.equal(r.nibOn, 'overlay', 'precondition: the overlay caught the nib, as on the device');
  assert.ok(F.decisions(r.pad, 'pointerdown', 'pen')[0].includes('flip-settled-pen>pen-off-ink>draw'));
});
test('(b) the LATE START alone (overlay catching the nib, no takeover) recovers the stroke from the settle on', () => {
  const r = F.reproLateOnly(Sc.ONLY.late);
  assert.equal(r.nibOn, 'overlay');
});
test('(b) the OVERLAY alone stops swallowing the nib — but cannot ink while the flip settles (stated, not hidden)', () => {
  // The overlay layer only changes WHERE the pointerdown goes: mid-turn that is bare stage, which
  // routes no pen, and onDown would refuse it anyway while `flipping`. Paired with the late start
  // it recovers; on its own the stroke is lost. It is the layer that makes the other two robust.
  const r = F.deviceReplay(Sc.ONLY.overlay);
  F.assertPreconditions(r);
  assert.equal(r.nibOn, 'stage');
  assert.equal(r.ink, 0, 'alone it recovers nothing');
  F.reproLateOnly(Sc.ONLY.overlayLate);
});
test('(b) BASE: with all three layers off the device log reproduces exactly — no ink at all', () => {
  const r = F.deviceReplay(Sc.ONLY.none);
  F.assertPreconditions(r);
  assert.equal(r.nibOn, 'overlay');
  assert.equal(r.ink, 0);
  assert.equal(r.started, 0);
  assert.ok(F.decisions(r.pad, 'pointermove', 'pen').filter((d) => d === 'ink:no-stroke').length >= 100, 'd:"no-stroke" for the rest of the contact');
});

// ═══ the settle takeover: same end state, and only where a nib writes ════════════════════════
for (const commit of [true, false]) {
  test(`settle takeover: a nib landing in a ${commit ? 'committing' : 'snapping-back'} settle leaves exactly the state the timer would`, () => Sc.settleSameState(commit));
}
test('settle takeover: a button flip (flipTo) settling under a nib ends at once, on the new page', () => Sc.buttonFlipSettle());
test('settle takeover: a button flip right after a nib cut a settle short keeps its own full animation', () => Sc.buttonFlipAfterEarlySettle());
test('settle takeover: a pen tap on a BAR during a settle leaves the animation alone', () => Sc.barTapKeepsSettle());
test('settle takeover: a nib on the ink starts exactly ONE stroke (the reroute is for the overlay only)', () => Sc.inkDownOneStroke());
test('settle takeover: a nib off the ink during a LIVE palm drag inks on that same down, on the right page', () => Sc.liveDragNibOffInk());
test('settle takeover: outside a page-turn a pen on bare stage still draws nothing', () => Sc.marginPenNoTurn());
test('settle takeover: in the T tool an overlay-caught nib never inks', () => Sc.textToolOverlayNoInk());
test('overlay: the finger that drives a flip is captured BEFORE the overlay appears, so it never needed the overlay', () => Sc.fingerCapturedFirst());

// ═══ (c) the late start never invents ink ═══════════════════════════════════════════════════
test('(c) hover never inks: buttons 0, pressure 0 — and each field alone', () => Sc.lateHover());
test('(c) touch and mouse never late-start', () => Sc.lateNotTouchOrMouse());
test('(c) select and text tools never late-start', () => Sc.lateNotSelectOrText());
test('(c) a pen move after THAT pen lifted or was cancelled never inks', () => Sc.lateNotAfterLift());
test('(c) during a live flip and during its settle the late start never fires', () => Sc.lateNotDuringFlip());
test('(c) a popover: open → no late start; a nib that closed one (swallowed down) never inks', () => Sc.lateNotWithPopover());
test('(c) a nib that went down on a bar and slid onto the page never inks', () => Sc.lateNotFromBar());
test('(c) a contact that owns the surface or a live stroke is never restarted', () => Sc.lateNotOverOwner());
test('(c) a palm already scrolling stops when a late nib starts (the existing scroll guard)', () => Sc.latePalmScrollStops());
test('(c) the eraser: a contact whose down was lost starts erasing and owns the surface', () => Sc.lateEraser());

// ═══ (d) everyday writing unchanged ══════════════════════════════════════════════════════════
test('(d) plain strokes and fast taps: one stroke each, no late start, nothing lost', () => Sc.everydayStrokesAndTaps());
for (const fingerDraw of [false, true]) {
  test(`(d) a palm resting while writing (fingerDraw ${fingerDraw ? 'ON' : 'OFF'}): unchanged, no late start`, () => Sc.everydayPalm(fingerDraw));
}
test('(d) a finger scroll still scrolls', () => {
  const pad = runPad();
  Sc.fingerScroll(pad);
  assert.ok(pad.S.stage.scrollTop > 0);
});
test('(d) a finger flip with swipe-to-flip ON and no pen completes normally', () => {
  const pad = runPad({ noFlip: false, realFlip: true, cur: 1 });
  pad.at(5000);
  swipe(pad, pad.ink, { id: 7, from: 600, to: 200 });
  assert.equal(pad.S.flipping, true, 'the settle animates');
  assert.equal(pad.flip.style.display, 'block');
  pad.at(400);
  assert.deepEqual([pad.S.flipping, pad.S.cur, pad.flip.style.display], [false, 2, 'none'], 'and lands on the next page');
  pad.down(pad.ink, { ...NIB, x: 100, y: 100 }); pad.up(pad.ink, { ...NIB, x: 100, y: 100 });
  assert.equal(pad.S.strokePage, 2);
});
