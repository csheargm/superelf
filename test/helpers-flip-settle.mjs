// PANote — a Pencil nib that lands while a page-turn SETTLES. The scenarios, as functions of the
// harness options, so the SAME sequence runs as a repro/control (test/note-flip-settle-pen.test.mjs)
// and under each mutation (test/note-flip-settle-pen-mutation.test.mjs).
//
// The device sequence (owner's iPad, swipe-to-flip ON, finger drawing OFF, pen tool) is rebuilt
// here SYNTHETICALLY: the same event types, order, timing, targets and contact radii as the log,
// with invented coordinates — no data from the log itself (the owner's rule: no personal logs in
// the repo). Its summary is in docs/plans/panote-palm-flip-pen-lockout.md.
//
// HIT-TESTING, the one part of it this fix depends on (R14 — stated, not hidden): the harness
// dispatches to whatever element a test names, so which element a nib LANDS on is decided by
// pageHit() below from two facts the shipped code owns — the overlay (.pan-flip, inset:0,
// z-index 2) is displayed (the real snapshotOutgoing / settle code set its display), and the
// SHIPPED stylesheet's .pan-flip rules do or do not say pointer-events:none — plus one measured
// fact: while a snap-back settles, the page box is slid aside, so what lies under the overlay is
// BARE STAGE. Measured in Chromium (CDP touch + pen, 820x1180, the real PANote): elementFromPoint
// = .pan-flip before this fix, .pan-stage after; the base build then logged the nib's down on
// pan-flip and every later move "no-stroke", as the iPad did. A touch pointer is implicitly
// captured by the element it went down on (WebKit and Chromium), so finger events keep their target.
import assert from 'node:assert/strict';
import { C, ENGINE, runPad, routingSource } from './helpers-panote-routing.mjs';
import { between, scopeProxy } from './helpers-app.mjs';

export const STYLE = between(ENGINE, '<style id="pan-style">', '</style>');
const flipRules = (css) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => m[1].split(',').some((sel) => sel.trim() === '.pan-flip')).map((m) => m[2]);
export const overlayTakesInput = (css = STYLE) => {
  assert.ok(flipRules(css).length >= 2, 'the stylesheet still carries the .pan-flip rules');
  return !flipRules(css).some((body) => /(^|;)\s*pointer-events\s*:\s*none\b/.test(body));
};
// LAYER 2 removed: the overlay's pointer-events:none taken out of the shipped stylesheet.
export const OVERLAY_CATCHES = (css) => {
  const out = css.replace(/(\.pan-flip\{[^}]*?)pointer-events:none;/, '$1');
  assert.notEqual(out, css, 'the CSS mutation matched nothing — it would prove nothing');
  return out;
};
export const pageHit = (pad, css = STYLE) => (pad.flip.style.display !== 'block' ? pad.ink : overlayTakesInput(css) ? pad.flip : pad.stage);

// The engine's own onPopOutside (it swallows a tap outside an open popover), installed the way the
// engine installs it, so "a nib that closed a popover" is the real swallow and not a restatement.
// `mutate` rewrites the extracted handler first (mutation testing); it must match.
export function installPopOutside(pad, mutate) {
  let src = between(ENGINE, 'const onPopOutside=(e)=>{', "document.addEventListener('pointerdown',onPopOutside,true);");
  if (mutate) { const before = src; src = mutate(src); assert.notEqual(src, before, 'the mutation matched nothing — it would prove nothing'); }
  const pops = routingSource().match(/const POPS_OPEN='[^']*';/);
  // eslint-disable-next-line no-new-func
  const fn = new Function('__scope', `with(__scope){${pops ? pops[0] : ''}\n${src.replace(/document\.addEventListener[^\n]*$/, '')}\nreturn onPopOutside;}`)(
    scopeProxy({ host: pad.host, syncPopBtns() {} }));
  pad.doc.addEventListener('pointerdown', fn, true);
}

export const NIB = { id: 43, pt: 'pen' };
const HAND_A = { id: 41, pt: 'touch', w: 84, h: 84 };    // touch radius 42 (WebKit: width = 2·radius)
const HAND_B = { id: 42, pt: 'touch', w: 104, h: 104 };  // radius 52
export const NIB_AFTER_CANCEL = 286;                     // the nib landed 286 ms after iPadOS cancelled the hand
const MOVE_MS = 4.2;                                     // ~104 moves in ~440 ms
export const inkBy = (pad, id) => pad.calls.extendBy.filter((x) => x === id).length;
export const decisions = (pad, type, pt) => pad.pencilLog().events.filter((e) => e.type === type && e.pt === pt).map((e) => `${e.tg}:${e.d || ''}`);

const handTouch = (pad, type, list, at) => pad.touch(at, type, {
  touches: type === 'touchstart' ? list.map((h, i) => ({ id: h.id, x: 520 + 80 * i, y: 760, rx: h.w / 2, ry: h.h / 2 })) : [],
  changed: list.map((h, i) => ({ id: h.id, x: 520 + 80 * i, y: 760, rx: h.w / 2, ry: h.h / 2 })) });

// A resting hand starts a finger flip, iPadOS cancels it, and the nib lands inside the settle.
export function deviceReplay(o = {}) {
  const { css = STYLE, ...opts } = o;
  const pad = runPad({ noFlip: false, realFlip: true, cur: 1, ...opts });
  pad.at(5000);                                                        // no pen near: the hand's flip can arm
  pad.down(pad.ink, { ...HAND_A, x: 520, y: 760 });                    // d:gesture-armed (both)
  pad.down(pad.ink, { ...HAND_B, x: 600, y: 800 });
  handTouch(pad, 'touchstart', [HAND_A, HAND_B], pad.ink);
  const xs = [596, 590, 574, 552, 531, 507, 486];                      // B drifts left: arming, arming, flip-begin, …
  const steps = [34, 9, 10, 25, 20, 18, 22];
  xs.forEach((x, i) => {
    pad.at(steps[i]);
    pad.move(pad.ink, { ...HAND_A, x: 520 - i, y: 760 + i });         // d:touch-unarmed
    pad.move(pad.ink, { ...HAND_B, x, y: 800 + i });
  });
  const flipBegan = pad.S.flipping === true && pad.S.cur === 2;
  pad.at(8);
  pad.cancel(pad.ink, { ...HAND_A, x: 514, y: 766 });                 // pointercancel + lostpointercapture, both
  pad.fire(pad.ink, 'lostpointercapture', HAND_A);
  pad.cancel(pad.ink, { ...HAND_B, x: 486, y: 806 });
  pad.fire(pad.ink, 'lostpointercapture', HAND_B);
  handTouch(pad, 'touchcancel', [HAND_A, HAND_B], pad.ink);
  pad.at(NIB_AFTER_CANCEL);
  const settling = pad.S.flipping === true;
  const nibAt = pageHit(pad, css);
  const before = pad.calls.startStroke;
  pad.down(nibAt, { ...NIB, x: 300, y: 420, pressure: 0.08, buttons: 1 });
  pad.touch(nibAt, 'touchstart', { touches: [{ id: 99, x: 300, y: 420, tt: 'stylus' }], changed: [{ id: 99, x: 300, y: 420, tt: 'stylus' }] });
  const r = { flipBegan, settling, nibOn: nibAt === pad.flip ? 'overlay' : nibAt === pad.stage ? 'stage' : 'ink', drewOnDown: pad.calls.startStroke === before + 1,
    flippingAfterDown: pad.S.flipping, curAfterDown: pad.S.cur };
  let moves = 0;
  for (let i = 0; i < 112; i++) {                                      // ~9 inside the old window, then 104 more
    pad.at(MOVE_MS);
    pad.move(pageHit(pad, css), { ...NIB, x: 300 + i, y: 420 + (i % 7), pressure: 0.08 + (0.42 * i) / 112, buttons: 1 });
    moves++;
  }
  pad.up(pad.ink, { ...NIB, x: 412, y: 420 });
  return { pad, ...r, moves, ink: inkBy(pad, NIB.id), started: pad.calls.startStroke - before, strokePage: pad.S.strokePage,
    committed: pad.calls.committed, finalCur: pad.S.cur, settledNatural: C.FLIP_MS + 40 };
}

export const assertPreconditions = (r) => {
  assert.equal(r.flipBegan, true, 'precondition: the resting hand really started a flip');
  assert.ok(NIB_AFTER_CANCEL < r.settledNatural, 'precondition: the nib lands INSIDE the settle window');
  assert.equal(r.settling, true, 'precondition: the flip was still settling when the nib landed');
};
// The whole symptom, fixed: the nib inks from its own pointerdown, on the page the flip settled on.
export const reproDeviceLog = (o = {}) => {
  const r = deviceReplay(o);
  assertPreconditions(r);
  assert.equal(r.ink, r.moves, `every one of the ${r.moves} pen moves is ink (got ${r.ink})`);
  assert.equal(r.drewOnDown, true, 'the stroke starts on the SAME pointerdown');
  assert.equal(r.started, 1, 'one stroke, not one per move');
  assert.equal(r.strokePage, 1, 'on the page the cancelled flip snapped back to');
  assert.equal(r.committed, 1, 'and the lift commits it');
  assert.equal(r.finalCur, 1);
  return r;
};
// Recovery by the LATE START alone: the down is lost, the first move after the settle starts it.
export const reproLateOnly = (o = {}) => {
  const r = deviceReplay(o);
  assertPreconditions(r);
  assert.equal(r.drewOnDown, false, 'precondition of this layer: the pointerdown itself was lost');
  assert.equal(r.started, 1, 'one late stroke');
  assert.ok(r.ink >= r.moves - 12, `the writing after the settle is ink (${r.ink} of ${r.moves})`);
  assert.equal(r.strokePage, 1, 'on the page the flip settled on');
  assert.ok(decisions(r.pad, 'pointermove', 'pen').some((d) => d.endsWith(':late-start>draw')), 'logged as d:"late-start>draw"');
  assert.equal(r.committed, 1);
  return r;
};
