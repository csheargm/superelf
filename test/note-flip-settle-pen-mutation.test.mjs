// MUTATION TESTS for the flip-settle fix (test/note-flip-settle-pen.test.mjs holds the repros and
// controls). Each layer and each guard is removed from the APP'S OWN SOURCE — the routing block,
// the flip code or the stylesheet — and the scenario that must go red is pinned here. `cut`
// refuses a piece the source no longer holds, so a renamed guard fails loudly instead of "passing"
// against unmutated code (R14). A layer that another layer backs up is proved the only way it can
// be: removed alone it SURVIVES the replay, and its own isolation scenario goes red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as F from './helpers-flip-settle.mjs';
import * as Sc from './helpers-flip-settle-scenarios.mjs';

const { cut, L, ONLY } = Sc;
const red = (fn, o) => assert.rejects(async () => fn(o), assert.AssertionError);
const both = (a, b) => (s) => b(a(s));
const G = {
  // layer 1 — the settle takeover
  settleCall: cut("if(settleFlipNow()) pdec('flip-settled-pen',e);"),
  settleInStage: cut('if(!stage.contains(e.target)) return;'),
  rerouteOffInkOnly: cut('if(turnAtNib&&!ownRoute(e.target)&&!txtEdit){', 'if(turnAtNib&&!txtEdit){'),
  rerouteNotText: cut('if(turnAtNib&&!ownRoute(e.target)&&!txtEdit){', 'if(turnAtNib&&!ownRoute(e.target)){'),
  rerouteInTurnOnly: cut('if(turnAtNib&&!ownRoute(e.target)&&!txtEdit){', 'if(!ownRoute(e.target)&&!txtEdit){'),
  settleOnce: cut('settleFn=null; clearTimeout(settleT);', 'clearTimeout(settleT);'),
  settleClearsTimer: cut('settleFn=null; clearTimeout(settleT);', 'settleFn=null;'),
  // layer 3 — the late start
  penOnly: cut("if(e.pointerType!=='pen'||!(e.buttons>0)||", 'if(!(e.buttons>0)||'),
  buttons: cut("if(e.pointerType!=='pen'||!(e.buttons>0)||", "if(e.pointerType!=='pen'||"),
  pressure: cut('||!(e.pressure>0)) return false;', ') return false;'),
  owner: cut('if(penId!==null||drawing||', 'if(drawing||'),
  live: cut('if(penId!==null||drawing||', 'if(penId!==null||'),
  text: cut('drawing||txtEdit||popsOpen()', 'drawing||popsOpen()'),
  popNow: cut('drawing||txtEdit||popsOpen()', 'drawing||txtEdit'),
  popAtDown: cut('ok:stage.contains(e.target)&&!popsOpen()}', 'ok:stage.contains(e.target)}'),
  inStageAtDown: cut('ok:stage.contains(e.target)&&!popsOpen()}', 'ok:!popsOpen()}'),
  endUp: cut("listenG(window,'pointerup',penContactEnds,{capture:true});"),
  endCancel: cut("listenG(window,'pointercancel',penContactEnds,{capture:true});"),
  contact: cut('if(penContact&&penContact.id===e.pointerId&&!penContact.ok) return false;'),
  afterFlipRefusal: (s) => cut('      if(lateStart(e)) return;')(s).replace("      if(flipping){ pdec('refused-flipping',e); return; }        // pen/mouse",
    "      if(lateStart(e)) return;\n      if(flipping){ pdec('refused-flipping',e); return; }        // pen/mouse"),
  onDownRefusal: cut("function onDown(e){\n      if(flipping){ pdec('refused-flipping',e); return; }", 'function onDown(e){'),
};

// ═══ the layers ══════════════════════════════════════════════════════════════════════════════
test('MUTATION layer 1 (settle takeover) removed — CAUGHT by the replay: the late start alone loses the pointerdown', async () => {
  await red(F.reproDeviceLog, { mutate: L.settle });
  F.reproLateOnly({ mutate: L.settle });                         // what is left still recovers the rest of the stroke
});
test('MUTATION layer 2 (overlay pointer-events:none) removed — SURVIVES the replay (layer 1 reroutes), CAUGHT by its own scenario', async () => {
  F.reproDeviceLog({ css: F.OVERLAY_CATCHES(F.STYLE) });          // SURVIVED: the takeover routes the overlay's down to onDown
  assert.equal(F.deviceReplay({ css: F.OVERLAY_CATCHES(F.STYLE) }).nibOn, 'overlay', 'CAUGHT: the overlay catches the nib again');
  assert.equal(F.overlayTakesInput(F.OVERLAY_CATCHES(F.STYLE)), true);
});
test('MUTATION layer 3 (late start) removed — SURVIVES the replay (layers 1+2), CAUGHT by its own scenarios', async () => {
  F.reproDeviceLog({ mutate: L.late });                           // SURVIVED: by design, layers 1+2 carry the device log
  await red(F.reproLateOnly, { ...ONLY.late, mutate: both(L.settle, L.late) });
  await red(Sc.lateEraser, { mutate: L.late });
  await red(Sc.lateHover, { mutate: L.late });                     // its control (a nib on the glass) goes red
});
test('MUTATION all three removed — the device log reproduces: CAUGHT', async () => {
  await red(F.reproDeviceLog, ONLY.none);
});

// ═══ layer 1 guards ══════════════════════════════════════════════════════════════════════════
test('MUTATION settleFlipNow not called — CAUGHT (replay and the settle-state scenarios)', async () => {
  await red(F.reproDeviceLog, { mutate: G.settleCall });
  await red((o) => Sc.settleSameState(true, o), { mutate: G.settleCall });
  await red(Sc.buttonFlipSettle, { mutate: G.settleCall });
});
test('MUTATION "only a nib in the writing area settles" removed — CAUGHT: a bar tap cuts the animation', async () => {
  await red(Sc.barTapKeepsSettle, { mutate: G.settleInStage });
});
test('MUTATION reroute not limited to off-ink targets — CAUGHT: a nib on the ink starts two strokes', async () => {
  await red(Sc.inkDownOneStroke, { mutate: G.rerouteOffInkOnly });
});
test('MUTATION reroute not limited to a nib that landed in a page-turn — CAUGHT: a pen in the margin draws', async () => {
  await red(Sc.marginPenNoTurn, { mutate: G.rerouteInTurnOnly });
});
test('MUTATION the page-turn snapshot (read on window before guard 1) removed — CAUGHT: replay and live drag lose the down', async () => {
  const m = cut("listenG(window,'pointerdown',e=>{ if(e.pointerType==='pen') turnAtNib=flipping; },{capture:true});");
  await red(F.reproDeviceLog, { mutate: m });
  await red(Sc.liveDragNibOffInk, { mutate: m });
});
test('MUTATION reroute in the T tool — CAUGHT: the T tool inks', async () => {
  await red(Sc.textToolOverlayNoInk, { mutate: G.rerouteNotText });
});
test('MUTATION settle not cleared after it runs — CAUGHT: a later nib "settles" a flip that is long over', async () => {
  await red((o) => Sc.settleSameState(false, o), { mutateFlip: G.settleOnce });
});
test('MUTATION timer not cleared — CAUGHT: the old timer ends the NEXT flip early', async () => {
  await red(Sc.buttonFlipAfterEarlySettle, { mutateFlip: G.settleClearsTimer });
});

// ═══ layer 3 guards ══════════════════════════════════════════════════════════════════════════
const caught = [
  ['pen only', 'penOnly', Sc.lateNotTouchOrMouse],
  ['buttons > 0', 'buttons', Sc.lateHover],
  ['pressure > 0', 'pressure', Sc.lateHover],
  ['no owner (penId)', 'owner', Sc.lateNotOverOwner],
  ['no live stroke (drawing)', 'live', Sc.lateNotOverOwner],
  ['not in the T tool', 'text', Sc.lateNotSelectOrText],
  ['no popover open now', 'popNow', Sc.lateNotWithPopover],
  ['no popover open at the down', 'popAtDown', Sc.lateNotWithPopover],
  ['the down landed in the writing area', 'inStageAtDown', Sc.lateNotFromBar],
  ['ended by pointerup', 'endUp', Sc.lateNotAfterLift],
  ['ended by pointercancel', 'endCancel', Sc.lateNotAfterLift],
  ['the contact check itself', 'contact', Sc.lateNotAfterLift],
];
for (const [what, key, scenario] of caught) {
  test(`MUTATION late start: "${what}" removed — CAUGHT`, async () => {
    scenario({});                                                 // green against the shipped source
    await red(scenario, { mutate: G[key] });
  });
}

// "Never during a flip" is held twice: onMove refuses before the late start is reached, and the
// start path it reuses (onDown) refuses on its own. Each alone holds; the pair removed goes red.
test('MUTATION late start during a flip — placement alone SURVIVES, onDown\'s refusal alone SURVIVES, both removed CAUGHT', async () => {
  Sc.lateNotDuringFlip({ mutate: G.afterFlipRefusal });            // SURVIVED: onDown refuses while flipping
  Sc.lateNotDuringFlip({ mutate: G.onDownRefusal });               // SURVIVED: onMove refuses first
  await red(Sc.lateNotDuringFlip, { mutate: both(G.afterFlipRefusal, G.onDownRefusal) });
});
