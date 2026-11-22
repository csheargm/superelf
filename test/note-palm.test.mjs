// PANote palm rejection（掌拒）— the finger page-flip vs. a hand resting on the page.
//
// THE BUG THIS FILE EXISTS FOR (reported from a real iPad): resting the pinky/palm on the page
// in order to start writing turned the page. `fingerFlipStart` rejected a palm only via
// `penId!==null`, and that is the one instant the test cannot work — the palm lands BEFORE the
// nib, so penId was still null and the gesture armed; nothing re-checked it afterwards, so the
// nib arriving did not cancel it; and after the nib lifted penId returned to null while the palm
// was still resting, so its next slide armed another one.
//
// THE HARNESS (extraction of the shipped routing, real capture → target → bubble dispatch, what
// is stubbed and why) lives in test/helpers-panote-routing.mjs, shared with the Pencil routing and
// Pencil recorder tests (R3).
//
// R14: nothing here may pass vacuously. "the harness can see a flip" and "the extraction found
// the real guards" run first, and every guard is mutation-tested — removed from the app's own
// source, with the assertion that must go red pinned in the same test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, C, routingSource, runPad, swipe } from './helpers-panote-routing.mjs';

// TODO(R4): this file is over the 300-line budget. Split seam: everything from
// "MUTATION TESTS" down (the guard mutations, the default-posture and the scrolling regressions)
// moves to test/note-palm-mutation.test.mjs; sections 0 and (a)–(e) stay here. New pointer-routing
// tests go to test/note-pencil-routing.test.mjs, not here.

// ═══ 0. THE HARNESS MUST BE ABLE TO FAIL (R14) ═══════════════════════════════════════════════

test('the harness can see a flip at all — a plain finger swipe with no pen turns the page', () => {
  const pad = runPad({ noFlip: false });
  const before = pad.S.cur;
  swipe(pad, pad.ink);
  assert.equal(pad.calls.begin.length, 1, 'the swipe started a flip drag');
  assert.deepEqual(pad.calls.end, [true], 'and it settled onto the next page');
  assert.equal(pad.S.cur, before + 1);
});

test('the extraction really carries the three palm guards (not a stale copy)', () => {
  const src = routingSource();
  assert.match(src, /function penTookOver\(\)\{/, 'guard 1: a pen pointerdown cancels an armed flip');
  assert.match(src, /host\.addEventListener\('pointerdown',e=>\{ if\(e\.pointerType==='pen'\) penTookOver\(\); \},\{capture:true\}\)/, 'guard 1 is installed in the capture phase on the pad');
  assert.equal((src.match(/if\(penId!==null\)\{ penTookOver\(\); return; \}/g) || []).length, 2, 'guard 2 re-checks penId in BOTH fingerFlipMove and fingerFlipEnd');
  assert.match(src, /const penNear=\(\)=>penId!==null\|\|\(penUpAt>0&&Date\.now\(\)-penUpAt<PEN_GRACE_MS\)/, 'guard 3: the pen-recency window');
  assert.ok(C.PEN_GRACE_MS > 0 && C.PEN_GRACE_MS <= 2000, `PEN_GRACE_MS is a defensible window, got ${C.PEN_GRACE_MS}`);
});

// ═══ (a) PALM DOWN → PEN DOWN → PALM SLIDES ══════════════════════════════════════════════════

test('(a) palm lands first, then the pen, then the palm slides — no flip, no drag', () => {
  const pad = runPad({ noFlip: false });
  const before = pad.S.cur;
  pad.down(pad.ink, { id: 1, pt: 'touch', x: 620, y: 700 });      // the pinky settles on the page
  pad.at(60);
  pad.down(pad.ink, { id: 2, pt: 'pen', x: 300, y: 300 });         // the nib arrives
  pad.at(40);
  for (const x of [600, 560, 500, 420]) pad.move(pad.ink, { id: 1, pt: 'touch', x, y: 700 });
  pad.up(pad.ink, { id: 1, pt: 'touch', x: 420, y: 700 });
  assert.deepEqual(pad.calls.begin, [], 'the palm never started a flip drag');
  assert.deepEqual(pad.calls.end, [], 'and nothing had to be snapped back');
  assert.equal(pad.S.cur, before, 'the page did not turn');
  assert.equal(pad.S.penId, 2, 'the Pencil still owns the surface — drawing is untouched');
});

test('(a) the palm sliding does not draw either — the finger is not a pen', () => {
  const pad = runPad({ noFlip: false });
  pad.down(pad.ink, { id: 1, pt: 'touch', x: 620, y: 700 });
  pad.down(pad.ink, { id: 2, pt: 'pen', x: 300, y: 300 });
  assert.equal(pad.calls.startStroke, 1, 'exactly one stroke started, by the pen');
  for (const x of [600, 500, 420]) pad.move(pad.ink, { id: 1, pt: 'touch', x, y: 700 });
  assert.equal(pad.calls.extendStroke, 0, 'the palm contributed no points to it');
});

// ═══ (b) PEN LIFTS, PALM STILL RESTING ═══════════════════════════════════════════════════════

test('(b) a touch gesture starting inside PEN_GRACE_MS of the pen lifting never arms a flip', () => {
  const pad = runPad({ noFlip: false });
  const before = pad.S.cur;
  pad.down(pad.ink, { id: 2, pt: 'pen', x: 300, y: 300 });
  pad.at(300);
  pad.up(pad.ink, { id: 2, pt: 'pen', x: 340, y: 300 });            // nib lifts to reposition
  assert.equal(pad.S.penId, null, 'penId is back to null — this is exactly the window that was open');
  pad.at(Math.floor(C.PEN_GRACE_MS / 2));
  swipe(pad, pad.ink, { id: 9 });                                   // the heel of the hand shifts
  assert.deepEqual(pad.calls.begin, [], 'no flip drag inside the grace window');
  assert.equal(pad.S.cur, before, 'the page did not turn');
});

test('(b) a pointercancel on the pen starts the same grace window — the contact ended either way', () => {
  const pad = runPad({ noFlip: false });
  const before = pad.S.cur;
  pad.down(pad.ink, { id: 2, pt: 'pen', x: 300, y: 300 });
  pad.cancel(pad.ink, { id: 2, pt: 'pen', x: 300, y: 300 });
  pad.at(Math.floor(C.PEN_GRACE_MS / 2));
  swipe(pad, pad.ink, { id: 9 });
  assert.deepEqual(pad.calls.begin, []);
  assert.equal(pad.S.cur, before);
});

test('(b) the grace window EXPIRES — a swipe after it still flips (the guard is not a mute button)', () => {
  const pad = runPad({ noFlip: false });
  const before = pad.S.cur;
  pad.down(pad.ink, { id: 2, pt: 'pen', x: 300, y: 300 });
  pad.up(pad.ink, { id: 2, pt: 'pen', x: 340, y: 300 });
  pad.at(C.PEN_GRACE_MS + 50);
  swipe(pad, pad.ink, { id: 9 });
  assert.equal(pad.calls.begin.length, 1, 'past the window a real swipe flips again');
  assert.equal(pad.S.cur, before + 1);
});

// ═══ (c) THE FEATURE MUST SURVIVE — A GENUINE FINGER SWIPE, BOTH MODES ═══════════════════════

test('(c) draw mode: a finger swipe anywhere on the page flips it, forwards and back', () => {
  const pad = runPad({ noFlip: false, cur: 1 });
  swipe(pad, pad.ink, { id: 3, from: 600, to: 150 });                // swipe left → next
  assert.equal(pad.S.cur, 2);
  assert.deepEqual(pad.calls.end, [true]);
  const back = runPad({ noFlip: false, cur: 1 });
  swipe(back, back.ink, { id: 4, from: 150, to: 600 });               // swipe right → prev
  assert.equal(back.S.cur, 0);
  assert.deepEqual(back.calls.end, [true]);
});

test('(c) text mode: the same swipe on the editable page layer flips it', () => {
  const pad = runPad({ noFlip: false, tool: 'text', txtEdit: { el: 1 }, cur: 1 });
  swipe(pad, pad.textLayer, { id: 5, from: 600, to: 150 });
  assert.equal(pad.calls.begin.length, 1, 'the text layer still reaches the one flip implementation');
  assert.equal(pad.S.cur, 2);
});

test('(c) text mode: the edge gutter swipe (T tool) still flips, and is palm-guarded too', () => {
  const ok = runPad({ noFlip: false, tool: 'text', txtEdit: { el: 1 }, cur: 1 });
  ok.down(ok.gutterR, { id: 6, pt: 'touch', x: 780, y: 400 });
  for (const x of [740, 660, 500]) ok.move(ok.gutterR, { id: 6, pt: 'touch', x, y: 400 });
  ok.up(ok.gutterR, { id: 6, pt: 'touch', x: 500, y: 400 });
  assert.equal(ok.S.cur, 2, 'the gutter swipe turned the page');

  const palm = runPad({ tool: 'text', txtEdit: { el: 1 }, cur: 1 });
  palm.down(palm.ink, { id: 2, pt: 'pen', x: 300, y: 300 });
  palm.up(palm.ink, { id: 2, pt: 'pen', x: 300, y: 300 });
  palm.at(100);
  palm.down(palm.gutterR, { id: 6, pt: 'touch', x: 780, y: 400 });
  for (const x of [740, 660, 500]) palm.move(palm.gutterR, { id: 6, pt: 'touch', x, y: 400 });
  palm.up(palm.gutterR, { id: 6, pt: 'touch', x: 500, y: 400 });
  assert.equal(palm.S.cur, 1, 'the gutter refuses the same slide inside the grace window');
});

test('(c) a vertical drag and a tap are still not flips (unchanged behaviour)', () => {
  const v = runPad({ noFlip: false });
  v.down(v.ink, { id: 3, pt: 'touch', x: 400, y: 200 });
  for (const y of [280, 400, 600]) v.move(v.ink, { id: 3, pt: 'touch', x: 404, y });
  v.up(v.ink, { id: 3, pt: 'touch', x: 404, y: 600 });
  assert.deepEqual(v.calls.begin, [], 'vertical → not a flip');
  const t = runPad();
  t.down(t.ink, { id: 3, pt: 'touch', x: 400, y: 200 });
  t.up(t.ink, { id: 3, pt: 'touch', x: 401, y: 201 });
  assert.deepEqual(t.calls.begin, [], 'a tap → not a flip');
});

// ═══ (d) THE PEN ARRIVES MID-DRAG ════════════════════════════════════════════════════════════

test('(d2) THE REPORTED SYMPTOM: the nib that cancels a palm-flip draws on that same touch', () => {
  // "the apple pencil periodically unable to draw, I have to lift my finger and touch the pencil
  // again and that seems to reset it."
  //
  // The palm arms and starts a flip, which sets `flipping`. The nib lands: penTookOver cancels the
  // drag — but the ANIMATED path clears `flipping` in a setTimeout FLIP_MS+40 (320ms) later, and
  // onDown opens with `if(flipping) return;`. So the nib's pointerdown was dropped. The nib is
  // already down, so no second pointerdown ever comes and the Pencil stays dead until the user
  // lifts and touches again — which is exactly the "reset" they discovered.
  //
  // penTookOver runs in the CAPTURE phase on the pad, before onDown runs on the ink surface, so a
  // synchronous cancel means the very same event can go on to draw.
  const pad = runPad({ noFlip: false, cur: 1 });
  pad.down(pad.ink, { id: 1, pt: 'touch', x: 620, y: 700 });
  for (const x of [590, 520]) pad.move(pad.ink, { id: 1, pt: 'touch', x, y: 700 });
  assert.equal(pad.calls.begin.length, 1, 'the palm really did start a flip');
  assert.equal(pad.S.flipping, true, 'and the surface is claimed — this is the window that broke it');

  const before = pad.calls.startStroke;
  pad.down(pad.ink, { id: 2, pt: 'pen', x: 300, y: 300 });
  assert.equal(pad.calls.startStroke, before + 1, 'the nib draws on the SAME pointerdown, not after a re-touch');
  assert.equal(pad.S.flipping, false, 'because the surface was released synchronously');
  assert.equal(pad.S.cur, 1, 'and on the page it was actually on, not the one the palm was dragging in');

  // It keeps drawing: the stroke is not cancelled a moment later when the transition finishes.
  pad.at(500);
  pad.move(pad.ink, { id: 2, pt: 'pen', x: 320, y: 320 });
  assert.ok(pad.calls.extendStroke > 0, 'and the stroke continues past the animation window');
  assert.equal(pad.S.cur, 1, 'with the page still unchanged');
});

test('(d) a pen landing mid-drag snaps the page back immediately — before any further finger event', () => {
  const pad = runPad({ noFlip: false, cur: 1 });
  pad.down(pad.ink, { id: 1, pt: 'touch', x: 620, y: 700 });
  for (const x of [590, 520]) pad.move(pad.ink, { id: 1, pt: 'touch', x, y: 700 });
  assert.equal(pad.calls.begin.length, 1, 'the palm slide had already begun dragging');
  assert.equal(pad.S.cur, 2, 'and the incoming page was already showing');

  pad.down(pad.ink, { id: 2, pt: 'pen', x: 300, y: 300 });           // the nib lands
  assert.deepEqual(pad.calls.end, [false], 'the drag was snapped back on the pen-down itself');
  assert.equal(pad.S.cur, 1, 'the original page is back');

  for (const x of [400, 300]) pad.move(pad.ink, { id: 1, pt: 'touch', x, y: 700 });
  pad.up(pad.ink, { id: 1, pt: 'touch', x: 300, y: 700 });
  assert.deepEqual(pad.calls.end, [false], 'and the palm cannot restart or re-settle it');
  assert.equal(pad.S.cur, 1, 'the page never changed');
});

// ═══ (e) FINGER-DRAW MODE IS UNTOUCHED ═══════════════════════════════════════════════════════

test('(e) finger-draw mode: a finger draws and never flips, with or without a recent pen', () => {
  const pad = runPad({ fingerDraw: true, cur: 1 });
  swipe(pad, pad.ink, { id: 3, from: 600, to: 150 });
  assert.equal(pad.calls.startStroke, 1, 'the finger started a stroke');
  assert.ok(pad.calls.extendStroke >= 3, 'and every move extended it');
  assert.equal(pad.calls.endStroke, 1, 'and the lift ended it');
  assert.deepEqual(pad.calls.begin, [], 'finger-draw mode never flips');
  assert.equal(pad.S.cur, 1);

  const after = runPad({ fingerDraw: true, cur: 1 });
  after.down(after.ink, { id: 2, pt: 'pen', x: 300, y: 300 });
  after.up(after.ink, { id: 2, pt: 'pen', x: 300, y: 300 });
  after.at(50);                                                       // inside the grace window
  swipe(after, after.ink, { id: 3, from: 600, to: 150 });
  assert.equal(after.calls.startStroke, 2, 'the grace window does not block finger DRAWING');
  assert.equal(after.S.cur, 1);
});

test('(e) the Pencil draw path is unchanged — down/move/up still stroke normally', () => {
  const pad = runPad();
  pad.down(pad.ink, { id: 2, pt: 'pen', x: 100, y: 100 });
  assert.equal(pad.calls.startStroke, 1);
  assert.deepEqual(pad.ink.captured, [2], 'the pen still takes pointer capture');
  pad.move(pad.ink, { id: 2, pt: 'pen', x: 140, y: 160 });
  pad.move(pad.ink, { id: 2, pt: 'pen', x: 180, y: 220 });
  assert.equal(pad.calls.extendStroke, 2);
  pad.up(pad.ink, { id: 2, pt: 'pen', x: 180, y: 220 });
  assert.equal(pad.calls.endStroke, 1);
  assert.equal(pad.S.penId, null);
  assert.deepEqual(pad.ink.captured, [], 'and still releases it');
});

// ═══ MUTATION TESTS — every guard removed must turn a named assertion red ════════════════════
// Each case re-introduces the defect in the APP'S OWN SOURCE and asserts the exact observation
// that goes wrong. A guard with no mutation here would be a guard nothing proves is load-bearing.

const GUARD1 = "host.addEventListener('pointerdown',e=>{ if(e.pointerType==='pen') penTookOver(); },{capture:true});";
const GUARD2 = 'if(penId!==null){ penTookOver(); return; }';
// Anchored to the guard's own line: `penNear()` also appears in the comment above it, and a
// mutation that only edited prose would leave the code untouched while still "matching".
const GUARD3 = '||penNear()) return false;';

test('MUTATION guard 1 — without the pen-down hook, the pen no longer snaps the drag back on arrival', () => {
  const pad = runPad({ noFlip: false, cur: 1, mutate: (s) => s.replace(GUARD1, '') });
  pad.down(pad.ink, { id: 1, pt: 'touch', x: 620, y: 700 });
  for (const x of [590, 520]) pad.move(pad.ink, { id: 1, pt: 'touch', x, y: 700 });
  assert.equal(pad.calls.begin.length, 1);
  pad.down(pad.ink, { id: 2, pt: 'pen', x: 300, y: 300 });
  // The (d) assertion, inverted: the page is left mid-flip under the nib until some later finger
  // event happens to arrive — which is the visible defect the hook removes.
  assert.deepEqual(pad.calls.end, [], 'DEFECT: the drag survived the pen landing');
  assert.equal(pad.S.cur, 2, 'DEFECT: the page had already turned under the Pencil');
});

test('MUTATION guard 2 — with guard 1 also gone, the palm slide flips: the re-check is what catches it', () => {
  // Guard 2 is redundant with guard 1 in the ordinary order of events, so it is proved the only
  // way a redundant guard can be: disable guard 1 and show guard 2 alone closes case (a).
  const both = runPad({ noFlip: false, cur: 1, mutate: (s) => s.replace(GUARD1, '').split(GUARD2).join('') });
  both.down(both.ink, { id: 1, pt: 'touch', x: 620, y: 700 });
  both.down(both.ink, { id: 2, pt: 'pen', x: 300, y: 300 });
  for (const x of [600, 560, 500, 420]) both.move(both.ink, { id: 1, pt: 'touch', x, y: 700 });
  assert.equal(both.calls.begin.length, 1, 'DEFECT: with neither guard the palm turns the page under the pen');
  assert.equal(both.S.cur, 2);

  const only1Gone = runPad({ cur: 1, mutate: (s) => s.replace(GUARD1, '') });
  only1Gone.down(only1Gone.ink, { id: 1, pt: 'touch', x: 620, y: 700 });
  only1Gone.down(only1Gone.ink, { id: 2, pt: 'pen', x: 300, y: 300 });
  for (const x of [600, 560, 500, 420]) only1Gone.move(only1Gone.ink, { id: 1, pt: 'touch', x, y: 700 });
  assert.deepEqual(only1Gone.calls.begin, [], 'guard 2 alone still refuses the palm');
  assert.equal(only1Gone.S.cur, 1);
});

test('MUTATION guard 3 — reverted to the bare penId check, the resting palm flips after the nib lifts', () => {
  // Exercised through the TEXT-MODE EDGE GUTTER, which is the path this guard exists for.
  //
  // It used to swipe the ink surface and asserted a defect that could not appear there: onDown
  // rejects a touch outright while penNear() holds, so the flip guard is never reached by that
  // route and weakening it changes nothing. The ink path is double-guarded; the gutter path is
  // not — its handlers call the flip logic directly — so this is the one place the guard is
  // load-bearing, and the only place its removal is observable.
  const pad = runPad({ noFlip: false, tool: 'text', txtEdit: { el: 1 }, cur: 1,
    mutate: (s) => s.replace(GUARD3, '||penId!==null) return false;') });
  pad.down(pad.ink, { id: 2, pt: 'pen', x: 300, y: 300 });
  pad.up(pad.ink, { id: 2, pt: 'pen', x: 340, y: 300 });
  pad.at(Math.floor(C.PEN_GRACE_MS / 2));
  pad.down(pad.gutterR, { id: 9, pt: 'touch', x: 780, y: 400 });
  for (const x of [740, 660, 500]) pad.move(pad.gutterR, { id: 9, pt: 'touch', x, y: 400 });
  pad.up(pad.gutterR, { id: 9, pt: 'touch', x: 500, y: 400 });
  assert.equal(pad.S.cur, 2, 'DEFECT: the page turned with the pen milliseconds away');
});

test('guard 3 is what stops it — the same gutter swipe is refused unmutated', () => {
  // The control. Without it the mutation test above proves only that a swipe can turn a page.
  const pad = runPad({ noFlip: false, tool: 'text', txtEdit: { el: 1 }, cur: 1 });
  pad.down(pad.ink, { id: 2, pt: 'pen', x: 300, y: 300 });
  pad.up(pad.ink, { id: 2, pt: 'pen', x: 340, y: 300 });
  pad.at(Math.floor(C.PEN_GRACE_MS / 2));
  pad.down(pad.gutterR, { id: 9, pt: 'touch', x: 780, y: 400 });
  for (const x of [740, 660, 500]) pad.move(pad.gutterR, { id: 9, pt: 'touch', x, y: 400 });
  pad.up(pad.gutterR, { id: 9, pt: 'touch', x: 500, y: 400 });
  assert.equal(pad.S.cur, 1, 'the palm did not turn the page while the pen was still near');
});

test('MUTATION the capture phase is load-bearing — a bubble-phase hook is too late for the same-tick case', () => {
  // The nib and a palm can land on the SAME element; a bubbling hook runs after that element's
  // own pointerdown handlers, so it is only the capture phase that guarantees the cancel wins.
  const src = routingSource();
  assert.ok(src.includes('{capture:true});'), 'the hook is registered with capture:true');
});

// ── The default posture ───────────────────────────────────────────────────────

test('swipe-to-flip is OFF by default, and a stored preference still wins both ways', () => {
  // A hand resting on the page to write is the normal posture. A palm that slips past the guards
  // costs a turned page — and, until penTookOver was made synchronous, a Pencil that stopped
  // drawing. Finger page-turns are a convenience; not losing your place mid-sentence is not.
  const src = ENGINE;
  assert.match(src, /let noFlip=true;/, 'the flag starts disabled');
  assert.match(src, /class="pan-noflipcb" checked/, 'and the checkbox agrees, or the UI lies about the state');
  // The preference round-trip must still override in BOTH directions, or turning it back on
  // would not stick.
  assert.match(src, /typeof m\.noFlip==='boolean'\){ noFlip=m\.noFlip;/, 'a stored pref wins');
  // The flag gates FLIPPING, not the gesture. It used to be `if(noFlip) return false;` at the top
  // of fingerFlipStart, which also disarmed vertical scrolling — scrollTouch is only created once
  // the gesture is armed. It is now carried as `canFlip` and refused in the horizontal branch.
  assert.match(src, /const canFlip=!noFlip&&PAGES;/, 'noFlip decides whether a flip is possible');
  assert.match(src, /if\(!flipTouch\.canFlip\)\{ flipTouch=null; return; \}/, 'and refuses only the horizontal branch');
  assert.ok(!/if\(noFlip\) return false;/.test(src), 'never by bailing before the gesture arms — that took scrolling with it');
});

test('with the default in force, a finger swipe does NOT turn the page', () => {
  // NO override: runPad seeds noFlip from the engine's own declaration, so this exercises the
  // posture that actually ships. (A bulk edit briefly gave this one `noFlip: false`, which made it
  // assert the opposite of its name and still pass — worth naming, since that is how a test ends
  // up guarding nothing.)
  const pad = runPad();
  const before = pad.S.cur;
  swipe(pad, pad.ink);
  assert.equal(pad.calls.begin.length, 0, 'no flip was armed');
  assert.equal(pad.S.cur, before, 'and the page did not move');
});

// ── Scrolling must not be parasitic on flipping ───────────────────────────────

test('REGRESSION: a vertical finger drag scrolls the page with the SHIPPED default', () => {
  // Reported from an iPhone in landscape: in drawing mode the page will not scroll to the bottom,
  // while text mode scrolls fine (the text layer scrolls natively). No override here — this runs
  // with noFlip at its shipped value, which is the whole point.
  const pad = runPad();
  pad.S.stage.scrollTop = 0;
  pad.down(pad.ink, { id: 5, pt: 'touch', x: 300, y: 600 });
  for (const y of [560, 500, 430, 360]) pad.move(pad.ink, { id: 5, pt: 'touch', x: 300, y });
  pad.up(pad.ink, { id: 5, pt: 'touch', x: 300, y: 360 });
  assert.ok(pad.S.stage.scrollTop > 0,
    `a vertical finger drag must scroll the page, got scrollTop=${pad.S.stage.scrollTop}`);
});
