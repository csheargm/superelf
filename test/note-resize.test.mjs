// Pins the fix for the 2026-09-02 Pencil-offset scar: the canvas backing store is sized
// from the stage at setup, while pointAt reads the element's CURRENT rect, so ANY size
// change without a re-measure makes CSS stretch the canvas and ink drift right.
// aae66be (docked drawer narrows .pan-fs via left:var(--pac-dock)) created the trigger and
// fires no resize event; setupCanvases also early-returns while the pad is hidden, which is
// why only the Bible app (which hides/shows the pad) showed it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SRC = fs.readFileSync(new URL('../web/note-ui.inline.html', import.meta.url), 'utf8');
const code = SRC.replace(/<!--[\s\S]*?-->/g, '');   // strip comments: contracts must hold in CODE

test('the engine observes its own ELEMENT, not just window.resize', () => {
  assert.match(code, /new ResizeObserver\(/, 'no ResizeObserver: a drawer-dock resize fires no window event');
  assert.match(code, /roStage\.observe\(stage\)/, 'the observer must watch the stage the canvases are sized from');
  assert.match(code, /roStage&&roStage\.disconnect\(\)/, 'observer must be torn down in destroy');
});

test('a hidden pad re-measures on show (setupCanvases skips a hidden element)', () => {
  const show = code.match(/const show=\(\)=>\{[^}]*\}/);
  assert.ok(show, 'fullscreen show() not found');
  assert.match(show[0], /api\.resize\(\)/, 'show() must re-measure: a resize while hidden was dropped');
});

test('the early-return that drops a hidden resize still exists (the reason show() must re-measure)', () => {
  // Pinned as the INVARIANT: setupCanvases refuses to size anything from a zero-sized stage.
  // It used to read `if(W<=0||H<=0)` because W/H WERE the stage; the page is now a fixed Letter
  // surface, so the measurement it guards is the stage's own rect.
  assert.match(code, /if\(r\.width<=0\|\|r\.height<=0\) return;/,
    'guard changed — revisit whether show() still needs to re-measure');
});

test('resize path redraws, so a re-measure cannot blank the page', () => {
  const setup = code.slice(code.indexOf('function setupCanvases()'));
  const body = setup.slice(0, setup.indexOf('\n    }') + 6);
  assert.match(body, /redrawPage\(\)/, 'setupCanvases clears the backing store; it must redraw or content is lost');
});

// Pins the fix for the 2026-09-04 text-mode first-line scar: in fullscreen mode (Bible,
// Journal) the .pan-top bar covers the stage from top:0, but applyTextMetrics read only
// --pan-dockrow which is never set in fullscreen (only mount mode sets it). paddingTop was
// gap*0.4 ≈ 23px — first text line appeared behind the ~90px toolbar. Fix: read topBar.offsetHeight.
test('the page clears the top bar — now by moving the PAGE, not just the text', () => {
  // Pins the 2026-09-04 scar: the .pan-top bar covers the stage from y=0, and without clearance
  // the first text line rendered behind it. The clearance is still required and still reads the
  // same two sources; what changed is WHERE it is applied.
  //
  // It used to pad the TEXT LAYER, which offset the typed text while leaving the ink where it
  // was — two layers, two origins. Since the bar's height and the page's zoom both differ per
  // device, a note written on one iPad opened on another with its handwriting across its own
  // typed paragraph. The stage now holds it, so both layers move together.
  const fn = code.slice(code.indexOf('function barClearance()'));
  const body = fn.slice(0, fn.indexOf('\n    }') + 6);
  assert.match(body, /topBar\s*\?\s*topBar\.offsetHeight/,
    'fullscreen: must read topBar.offsetHeight so the page clears the pan-top bar');
  assert.match(body, /pan-dockrow/,
    'mount: must still fall back to --pan-dockrow for the floating-toolbar case');
  // Applied as the PAGE's own top, not as stage padding: an absolutely positioned child's
  // containing block is its ancestor's padding box, so padding-top moves it not at all
  // (measured). The whole page moves, both layers with it.
  assert.match(code, /el\.style\.top=t\+'px'/, 'and it is the PAGE that moves');
  // …and the text layer must not reintroduce an offset of its own.
  // Asserted on the ASSIGNMENTS, not on the text of the function: its comment explains where the
  // clearance went and naturally names barClearance, which a bare source match trips over.
  const tm = code.slice(code.indexOf('function applyTextMetrics()'));
  const pads = [...tm.slice(0, tm.indexOf('\n    }') + 6).matchAll(/textLayer\.style\.paddingTop=([^;]+);/g)];
  assert.equal(pads.length, 2, 'both template branches set it');
  for (const [, v] of pads) assert.doesNotMatch(v, /dockRow|barClearance|offsetHeight/,
    `the text layer carries no toolbar offset: ${v}`);
});

// The tempting WRONG fix for the same scar, and why it must not come back.
//
// A session hit the ink drift above and worked around it in the Bible app's CSS:
//   html.pac-docked > body > .pan-fs.pan-fs.on{left:0!important}
// — a doubled class written specifically to out-specify the drawer's dock push, pinning the
// pad full-width. It stopped the drift, because the pad's width then never changed. It also
// meant the docked drawer sat ON TOP of the page the user was trying to read, which is how it
// was eventually reported. The real cause is fixed at the source (the ResizeObserver pinned
// above re-measures on ANY width change), so the pad must narrow like every other surface.
test('no app pins .pan-fs full-width against the docked drawer', () => {
  const path = new URL('../workspace/apps/', import.meta.url);
  let apps = [];
  try { apps = fs.readdirSync(path); } catch { return; }   // fresh checkout: no live instances
  for (const a of apps) {
    let html;
    try { html = fs.readFileSync(new URL(`../workspace/apps/${a}/index.html`, import.meta.url), 'utf8'); }
    catch { continue; }                                     // not an app dir, or unreadable
    assert.equal(/\.pan-fs\.pan-fs/.test(html), false,
      `${a}: a doubled .pan-fs selector exists only to beat the dock push — the drawer then covers the page`);
    assert.equal(/pac-docked[^{]*\.pan-fs[^}]*left:\s*0\s*!important/.test(html), false,
      `${a}: the draw pad must narrow with the docked drawer, not sit under it`);
  }
});

// A page taller than the viewport must be reachable (item A).
// Ink is stored normalised by WIDTH — y_px = y_norm * W — so the same note is TALLER on a
// wider screen. The stage clipped that overflow and nothing scrolled, so a photo pasted on an
// iPad simply could not be seen on a laptop.
test('the page is sized to its content, and the stage can scroll to it', () => {
  assert.match(code, /\.pan-stage\{[^}]*overflow:auto/, 'the stage must scroll — both axes now that the page has a minimum width');
  assert.equal(/\.pan-stage\{[^}]*overflow:hidden/.test(code), false, 'and must not still clip');
  assert.match(code, /function pageExtent\(pg\)/, 'content extent is measured, not assumed');
  assert.match(code, /el\.style\.width=W\+'px'; el\.style\.height=H\+'px';/,
    'the page carries an explicit width and height, so the stage has something to scroll to');
});

test('REGRESSION: the hidden-pad guard runs BEFORE the page is sized', () => {
  // A closed pad measures 0x0. Sizing from that wrote height:48px — the tail padding alone —
  // over a real note, because the guard that used to catch it had moved below the sizing.
  const fn = code.slice(code.indexOf('function setupCanvases()'));
  const body = fn.slice(0, fn.indexOf('\n    }'));
  const guard = body.indexOf('if(r.width<=0||r.height<=0) return;');
  const sized = body.indexOf("el.style.height=H+'px'");
  assert.ok(guard > 0 && sized > 0, 'both must stay findable');
  assert.ok(guard < sized, 'a hidden pad must return before anything is written to the page');
});

// Item B: a readable page on a phone is a MINIMUM WIDTH, not a shrunken viewport.
// Text size follows the page (ruleGap = W/RULE_DIV, font = 0.6*gap), so a viewport-width page
// rendered ~11px text on an iPhone against ~22px on an iPad — the same note, unreadable on the
// smaller screen. The narrow screen now PANS across a readable column instead.
test('the page has a minimum readable width, and a finger can reach the rest', () => {
  assert.match(code, /const MIN_PAGE_W=\d+/, 'a minimum page width exists');
  // The page no longer TAKES the screen's width, so the floor moved from the width to the SCALE:
  // below it the page stops shrinking and the stage pans instead — which is what this test has
  // always been about (text size follows the page, so a shrunken page is unreadable text).
  // kFitOf (journal-iphone step 2): off a phone it IS this expression; a phone ink page fits the width.
  assert.match(code, /if\(!phoneOn\(\)\|\|!window\.PANotePhone\) return Math\.max\(MIN_PAGE_W\/PAGE_W, rw\/PAGE_W\);/,
    'the readable floor is applied to the fit scale');
  assert.match(code, /const kFit=kFitOf\(r\.width\)/, 'and the page scale is that fit');
  assert.match(code, /el\.style\.width=W\+'px'/, 'the page carries its width explicitly so the stage can scroll to it');
  assert.match(code, /\.pan-ink\.pan-canpan\{touch-action:pan-x pan-y\}/, 'a finger may pan when it is not drawing');
});

test('REGRESSION: panning never overrides the pen, and its re-check cannot spin', () => {
  // touch-action:pan on the ink would let a resting PALM scroll the page out from under the
  // nib, so it is gated on penNear() — the same predicate palm rejection uses.
  // (Computed into panOn first: the Pencil recorder logs that mirror as `cp`.)
  assert.match(code, /panOn=!fingerDraw *&& *!penNear\(\); *ink\.classList\.toggle\('pan-canpan', *panOn\)/,
    'gated on the finger not drawing AND no pen owning the surface');
  // The first version re-scheduled itself while penNear() was true. Under a frozen clock that
  // never terminates — it hung test/note-palm.test.mjs — and in the app it left a live timer
  // after every stroke. One delayed re-check, scheduled by the pen-lift handler.
  const fn = code.slice(code.indexOf('function syncPan()'));
  const body = fn.slice(0, fn.indexOf('\n'));
  assert.equal(/setTimeout/.test(body), false, 'syncPan must not schedule anything itself');
});
