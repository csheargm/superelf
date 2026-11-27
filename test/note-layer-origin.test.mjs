// Ink and typed text share one page origin · 墨迹与文字必须同一原点
//
// SCAR. A note written on a 12.9" iPad opened on an 11" with its handwriting lying across its own
// typed paragraph. The fixed Letter page did not fix it and neither did pinning the text size,
// because neither was the cause.
//
// The cause: the text layer's padding-top carried the TOP BAR'S HEIGHT, so the first typed line
// would clear the bar that overlays the page. The ink carried no such offset. The two layers were
// therefore drawing against different origins, and the gap between them was:
//   · the bar's height, which differs per device (safe-area inset, font scale), and
//   · measured in SCREEN px while applied inside the page's own coordinate system, so it was
//     also multiplied by the page zoom — which differs per device again.
// Author on one device, open on another, and the text moves relative to the ink.
//
// Clearing the bar is the STAGE's job: it moves the whole page, both layers together. That is the
// only arrangement in which "where is the top of the page" has a single answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, stripComments } from './helpers-app.mjs';

const E = stripComments(ENGINE);

test('the text layer carries no toolbar offset', () => {
  const fn = /function applyTextMetrics\(\)\{[\s\S]*?\n    \}/.exec(E);
  assert.ok(fn, 'applyTextMetrics must be findable');
  assert.doesNotMatch(fn[0], /dockRow/, 'the bar height is not part of the text metrics any more');
  // Both branches: ruled pages still offset to the first rule, plain pages to nothing at all.
  assert.match(fn[0], /textLayer\.style\.paddingTop=Math\.round\(firstRuleY\(\)-gap\)\+baselineDrop/,
    'ruled: the offset is the rule geometry only');
  assert.match(fn[0], /textLayer\.style\.paddingTop=''/, 'plain: no offset at all');
});

test('one clearance moves the whole page, both layers with it', () => {
  assert.match(E, /for\(const el of \[pageInner,flip\]\) if\(el\) el\.style\.top=t\+'px';/,
    'applied to the page box that holds the ink canvas AND the text layer');
  const fn = /function barClearance\(\)\{[\s\S]*?\n    \}/.exec(E);
  assert.ok(fn, 'barClearance must be findable');
  assert.match(fn[0], /topBar \? topBar\.offsetHeight/, 'the bar in fullscreen');
  assert.match(fn[0], /--pan-dockrow/, 'the tool strip in mount mode');
});

test('the clearance is measured in the unzoomed frame it is applied in', () => {
  // The old offset mixed units: a screen-px measurement applied inside the page's zoomed
  // coordinate system, so it silently scaled with the zoom. The stage is not zoomed — only the
  // page inside it is — so a screen-px value is the correct unit there.
  // The invariant is WHERE it is applied, not the order of two statements — the first version of
  // this test asserted an arbitrary ordering and told nobody anything.
  // MEASURED: padding-top on the stage does NOT move the page. An absolutely positioned child's
  // containing block is its ancestor's PADDING BOX, so top:0 already sits at the padding edge.
  // A 60px stage padding left the page at 0; top:60px moved it to 60. The first attempt at this
  // fix used padding and was a no-op — the text stayed under the bar and the release looked like
  // it had done something.
  assert.match(E, /for\(const el of \[pageInner,flip\]\) if\(el\) el\.style\.top=t\+'px';/,
    "the clearance is the page's own top");
  assert.doesNotMatch(E, /stage\.style\.paddingTop/, 'and never stage padding, which does nothing here');
  const zoomed = /for\(const el of \[pageInner,flip\]\)\{[\s\S]*?\}/.exec(E)[0];
  // …and BECAUSE it is on the zoomed page, it is divided by k — an offset on a zoomed element is
  // scaled with it, measured at 60px landing on 48 at k=0.8, the same correction `left` needs.
  // (A phone reads toolsClearance(), which is barClearance() unless the bar is hidden: step 3 gives a hidden bar's room back.)
  assert.match(E, /const c=host\.classList\.contains\('pan-phone'\)\?toolsClearance\(\):barClearance\(\), k=pageK\(\)\|\|1, t=Math\.round\(c\/k\);/,
    'the clearance is read once and converted into the page\'s own units');
});

test('both layers still start at the same y inside the page', () => {
  // The invariant the whole fix exists for: the ink canvas and the text layer are siblings filling
  // the same page box, with no offset between them beyond the template's own geometry.
  assert.match(E, /<canvas class="pan-ink"><\/canvas><div class="pan-textlayer"><\/div>/,
    'siblings in the page, in that order');
  assert.match(E, /\.pan-textlayer\{position:absolute;inset:0/, 'the text layer fills the page box');
  assert.match(E, /\.pan-bg,\.pan-ink\{position:absolute;inset:0/, 'and so do the canvases');
});

test('the clearance is re-read whenever the bar can change height', () => {
  // SCAR. The bar is not a fixed height: entering the T tool DOCKS the formatting bar into it,
  // and the tool row docks there too, so it grows and shrinks while the note is open. Computed
  // once at resize, the first line of typed text ended up behind a bar that had got taller after
  // the page was laid out — reported as "text is covered by header".
  assert.match(E, /function applyTextMetrics\(\)\{\n      syncStageClear\(\);/,
    'every existing trigger recomputes it, since they all already call applyTextMetrics');
  // Docking reparents the bar, so its height is not final until the browser lays it out again.
  assert.match(E, /requestAnimationFrame\(\(\)=>\{ positionFmt\(\); syncStageClear\(\); \}\)/,
    'showing the formatting bar re-reads it on the NEXT frame');
  assert.match(E, /requestAnimationFrame\(syncStageClear\)/, 'and so does hiding it');
  // One definition: setupCanvases must not keep a second copy that can drift.
  assert.equal((E.match(/el\.style\.top=t\+'px'/g) || []).length, 1, 'exactly one writer');
  assert.match(E, /syncStageClear\(\);\s*\/\/ `top` depends on the k just set/,
    'and the layout pass calls it after setting the zoom it depends on');
});

test('the scroller is told its top is occupied, not just the page', () => {
  // Placing the page below the bar is only half the problem. The bar OVERLAYS the scroll port,
  // so every automatic scroll — the caret moving, focus, scrollIntoView — is free to park content
  // underneath it again. Measured: scrolling a line into view from below lands it at 0 (flush
  // under a 60px bar) without scroll-padding-top, and at 60 with it.
  //
  // NOT a phone fix, though a phone is where it was reported: with a small viewport and the
  // keyboard up the editor auto-scrolls on nearly every keystroke. The same thing happens on an
  // iPad, just rarely enough to look like nothing is wrong.
  assert.match(E, /if\(stage\) stage\.style\.scrollPaddingTop=c\+'px';/, 'declared on the scroll container');
  // From the SAME measurement that offsets the page — two sources would drift, and the symptom
  // of drift is exactly this bug in one direction or the other.
  const fn = /function syncStageClear\(\)\{[\s\S]*?\n    \}/.exec(E)[0];
  assert.match(fn, /const c=host\.classList\.contains\('pan-phone'\)\?toolsClearance\(\):barClearance\(\)/, 'one reading (iPad/desktop: the bar; a phone: the bar unless it is hidden)');
  assert.ok(fn.includes("el.style.top=t+'px'") && fn.includes('scrollPaddingTop=c'),
    'both the page offset and the scroll padding come from it');
  // In SCREEN px, unlike the page offset: the stage is not zoomed, the page is.
  assert.match(fn, /scrollPaddingTop=c\+'px'/, 'unscaled');
  assert.match(fn, /t=Math\.round\(c\/k\)/, 'while the page offset is divided by the zoom');
});

// ── Stacking: the ink paints above the typed text, and text mode still gets its taps ────
// SCAR (2026-09-30). A "Draw below text" toggle gave .pan-ink `z-index:2` so strokes would always
// show over typed text. .pan-textlayer is z-index:1, and in text mode it becomes INTERACTIVE
// (.pan-txted sets pointer-events:auto). Ink stacked above it therefore swallowed every tap:
// no caret, no selection, no typing. Typing is a major function of the pad, and it was broken by a
// cosmetic preference — reverted before it ever shipped.
//
// 2026-11-08 (ADR 0021): the owner asked for exactly that paint order — handwriting is an
// annotation, it must show over typed lines and pictures. "Ink paints above text" and "text
// receives taps" are the SAME axis for a stacked element, so the two are separated explicitly:
// the canvas is raised for good, and while the T tool is active (.pan-editing on the pad root)
// the canvas is pointer-events:none, so the taps fall through to the text layer beneath it.
// Both halves are pinned below; drop either and the scar is back.

// Read a rule's z-index straight out of the stylesheet. A plain scan, not a built regex: the
// selector contains a dot and a brace, and escaping it through a RegExp constructor is how the
// first version of this helper silently matched nothing.
const ruleBody = (sel) => {
  const at = ENGINE.indexOf('\n' + sel + '{');
  assert.ok(at > 0, `the stylesheet still declares ${sel}`);
  const open = ENGINE.indexOf('{', at);
  return ENGINE.slice(open + 1, ENGINE.indexOf('}', open));
};
const zOf = (sel) => {
  const z = /(?:^|;)\s*z-index\s*:\s*(-?\d+)/.exec(ruleBody(sel));
  return z ? Number(z[1]) : null;        // null = auto, i.e. does not take part in ordering
};

test('the ink canvas paints above the typed-text layer', () => {
  const ink = zOf('.pan-ink');
  const text = zOf('.pan-textlayer');
  assert.equal(typeof text, 'number', 'CONTROL: the text layer does declare a z-index, so this compares something');
  assert.equal(typeof ink, 'number', 'the canvas declares one too — auto would paint it in DOM order, under the text');
  assert.ok(ink > text, `.pan-ink (${ink}) must stack above .pan-textlayer (${text}): a stroke across a typed line shows`);
});

test('in text mode the raised canvas is transparent to taps — the scar\'s other half', () => {
  // The text layer is inert in the drawing tools and interactive in T mode; it is the interactive
  // state the stacking must not block. The canvas above it must step out of the hit order then.
  assert.match(ENGINE, /\.pan-textlayer\{[^}]*pointer-events:none/, 'inert by default, so pen/finger reach the canvas');
  assert.match(ENGINE, /\.pan-textlayer\.pan-txted\{[^}]*pointer-events:auto/, 'and interactive in text mode');
  assert.match(ruleBody('.pan-editing .pan-ink'), /pointer-events:none/,
    'while the T tool is active the canvas takes no pointer events, so the text layer beneath gets them');
  // .pan-editing is the class enterTextMode sets and exitTextMode clears, on the pad root (host),
  // the same hook the edge gutters use — not a second flag that could drift from the first.
  // Bounded at the next function head, so the class must be set INSIDE the function, not anywhere after it.
  const body = (name) => { const m = new RegExp('function ' + name + '\\(\\w*\\)\\{([\\s\\S]*?)\\n    function ').exec(ENGINE); assert.ok(m, name + ' must be findable'); return m[1]; };
  assert.match(body('enterTextMode'), /host\.classList\.add\('pan-editing'\)/, 'set on entering the T tool');
  assert.match(body('exitTextMode'), /host\.classList\.remove\('pan-editing'\)/, 'cleared on leaving it');
});
