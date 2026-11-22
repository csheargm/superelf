// MUTATION TESTS for the Pencil routing guards (test/note-pencil-routing.test.mjs holds the repros
// and controls). Each guard is removed from the APP'S OWN SOURCE and the repro that must go red is
// pinned here. `cut` deletes an exact piece of the shipped source; runPad refuses a mutation that
// matched nothing, so a renamed guard fails here loudly instead of "passing" against unmutated
// code (R14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Sc from './helpers-pencil-scenarios.mjs';

const cut = (piece, by = '') => (src) => src.split(piece).join(by);
const red = (fn, mutate) => assert.throws(() => fn({ mutate }), assert.AssertionError);
const G = {
  ownerUp: "if(strokePtr===e.pointerId){ pdec('finger-end',e); inkEnd(); } else pdec('touch-not-owner',e);",
  ownerMove: 'if(drawing&&strokePtr===e.pointerId){',
  ownerStart: 'function inkStart(e){ strokePtr=e.pointerId; startStroke(e); }',
  scrollClear: "if(scrollTouch){ scrollTouch=null; pdec('scroll-dropped-pen'); }",
  scrollGuard: "if(penId!==null){ scrollTouch=null; pdec('scroll-refused-pen',e); return; }",
  docUp: "listenG(document,'pointerup',onPenGone,{capture:true});",
  docCancel: "listenG(document,'pointercancel',onPenGone,{capture:true});",
  lpcLogOnly: "ink.addEventListener('lostpointercapture',e=>{ if(e.pointerType==='pen'&&e.pointerId===penId) pdec('capture-lost-pen-down',e); });",
  notInk: 'else if(e.target===ink) return;',
  selectEnd: 'if(drawing&&strokePtr===e.pointerId) inkEnd();',
  hidePen: "if(penId!==null){ pdec('hidden-pen-released',e); penUpAt=Date.now(); penId=null; syncPan(); syncPanAfterGrace(); }",
  hideInk: 'if(drawing) inkEnd(); });',
  immediate: 'if(started) endFlipDrag(false,true);',
  settleTakeover: "host.addEventListener('pointerdown',e=>{ if(e.pointerType==='pen') penLandsInFlip(e); },{capture:true});",
};

test('MUTATION A owner check on a touch LIFT — removed, a palm lift ends the Pencil stroke again', () => {
  const m = cut(G.ownerUp, "{ pdec('finger-end',e); inkEnd(); }");
  for (const t of ['pointerup', 'pointercancel']) red((o) => Sc.reproPalmLift(t, o), m);
  red(Sc.reproPalmFirst, m);
  red(Sc.reproTwoPalms, m);
});
test('MUTATION A owner check on a touch MOVE — removed, palm drift is drawn into the Pencil stroke', () => {
  red(Sc.reproPalmDrift, cut(G.ownerMove, 'if(drawing){'));
});
test('MUTATION A ownership taken at stroke start — removed, a finger can no longer draw its own stroke', () => {
  // Without it NOBODY owns a stroke, so the touch checks fail CLOSED: the palm repros still pass
  // (SURVIVED there, as expected) and the damage shows on the finger's own stroke instead.
  const m = cut(G.ownerStart, 'function inkStart(e){ startStroke(e); }');
  Sc.reproPalmLift('pointerup', { mutate: m });
  red(Sc.controlFingerStroke, m);
});
test('MUTATION B the two scroll guards — each alone closes the leak; with BOTH removed the page scrolls under the pen', () => {
  // Redundant on purpose, like palm guards 1 and 2: penTookOver drops the scroll when the nib lands
  // and the scroll branch re-checks penId on every move. A redundant guard is proved the only way
  // it can be — the other removed, this one alone still holds — and the pair removed goes red.
  Sc.reproPalmScroll({ mutate: cut(G.scrollClear) });                                  // SURVIVES alone: the branch guard holds
  Sc.reproPalmScroll({ mutate: cut(G.scrollGuard) });                                  // SURVIVES alone: the penTookOver clear holds
  red(Sc.reproPalmScroll, (s) => cut(G.scrollGuard)(cut(G.scrollClear)(s)));           // CAUGHT together
});
test('MUTATION C document backstop — removed, a lift that lands off the ink leaves penId stuck', () => {
  const m = (s) => cut(G.docCancel)(cut(G.docUp)(s));
  red(Sc.reproLiftOnToolbar, m);
  red(Sc.reproLiftOutside, m);
});
test('MUTATION C lostpointercapture as an end signal — restored, with or without the old buttons guard, a capture loss mid-word stops the Pencil (the symptom)', () => {
  // The branch's first version ended the stroke on lostpointercapture unless e.buttons said the nib
  // was down. WebKit's lostpointercapture always carries buttons 0, so that guard never fired on
  // the iPad. Both shapes are restored here and both must go red against the WebKit-shaped event.
  const endIt = "ink.addEventListener('lostpointercapture',e=>{ if(e.pointerType==='pen'&&e.pointerId===penId){ pdec('pen-gone',e); onPenLift(e); onUp(e); } });";
  const guarded = "ink.addEventListener('lostpointercapture',e=>{ if(e.pointerType==='pen'&&e.pointerId===penId){ if(e.buttons) return; pdec('pen-gone',e); onPenLift(e); onUp(e); } });";
  red(Sc.controlCaptureLostInContact, cut(G.lpcLogOnly, endIt));
  red(Sc.controlCaptureLostInContact, cut(G.lpcLogOnly, guarded));
});
test('MUTATION C "ink handles its own lift" — removed, a normal lift is ended twice', () => {
  red(Sc.controlEndsOnce, cut(G.notInk));
});
test('MUTATION C a Select lift ends a stroke begun before the switch — removed, drawing stays true and hover inks', () => {
  red(Sc.reproSelectMidStroke, cut(G.selectEnd));
});
test('MUTATION C a hidden page releases the pen and keeps the stroke — each half removed goes red', () => {
  red(Sc.reproHiddenMidStroke, cut(G.hidePen));
  red(Sc.reproHiddenMidStroke, cut(G.hideInk, '});'));
});
test('MUTATION D the shipped immediate flip cancel (b174a71) — reverted, the settle takeover still covers it; both gone, the lockout returns', () => {
  // Redundant since the settle takeover (penLandsInFlip): an animated snap-back the nib caused is
  // settled at once by the same pointerdown. Proved like MUTATION B: each alone holds, the pair is red.
  const revert = cut(G.immediate, 'if(started) endFlipDrag(false);');
  Sc.reproRealFlipCancel({ mutate: revert });                                          // SURVIVES alone: the takeover settles it
  Sc.reproRealFlipCancel({ mutate: cut(G.settleTakeover) });                           // SURVIVES alone: the immediate path holds
  red(Sc.reproRealFlipCancel, (s) => cut(G.settleTakeover)(revert(s)));                // CAUGHT together
});
