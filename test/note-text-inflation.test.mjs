// iOS must not resize the typed text · 禁止 iOS 自动放大文字
//
// SCAR. A note written on a 12.9" iPad opened on an 11" with its handwriting sitting on top of
// its own last typed line. The fixed Letter page was supposed to have made that impossible: both
// devices lay the text out at 816px, so it must wrap identically.
//
// It is not a layout-width problem. iOS Safari INFLATES text on its own — "text autosizing" — by
// a factor derived from the text block's width against the viewport's. Those viewports differ, so
// the factor differs, so the same paragraph renders at a different SIZE, wraps into a different
// number of lines, and grows downwards into space the handwriting already occupies. Handwriting
// is a canvas and is never inflated, which is exactly why only one of the two layers moved.
//
// The lesson worth keeping: making the page the same size everywhere is not sufficient for
// identical layout. The text must also be rendered at the size it was asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, stripComments } from './helpers-app.mjs';

const E = stripComments(ENGINE);
const rule = (sel) => {
  const i = E.indexOf(`\n${sel}{`);
  assert.ok(i >= 0, `${sel} is gone`);
  return E.slice(i, E.indexOf('}', i) + 1);
};

test('the text layer pins its own rendered size', () => {
  const r = rule('.pan-textlayer');
  assert.match(r, /-webkit-text-size-adjust:100%/, 'the prefixed property is what iOS actually reads');
  assert.match(r, /[^-]text-size-adjust:100%/, 'and the standard one for everything else');
});

test('100%, not none', () => {
  // `none` disables autosizing too, but it also disables the user's own Dynamic Type / zoom
  // preference in some engines. 100% says "render at the size I asked for", which is the
  // narrower statement and the one that is actually meant.
  const r = rule('.pan-textlayer');
  assert.doesNotMatch(r, /text-size-adjust:none/, 'never none');
});

test('the print measuring copy inherits it', () => {
  // Print transcribes the browser's layout from an offscreen copy. If that copy were inflated and
  // the live layer were not — or the reverse — the printout would not match the screen.
  const fn = /function textMeasureEl\(\)\{[\s\S]*?return measureEl;\n    \}/.exec(E);
  assert.ok(fn, 'the measuring element must be findable');
  assert.match(fn[0], /measureEl\.className='pan-textlayer'/,
    'it carries the same class, so it gets the same rule');
  // …and the inline cssText it sets must not reintroduce a size adjustment of its own.
  assert.doesNotMatch(fn[0], /text-size-adjust/, 'no second opinion in the inline styles');
});

test('the font size the rule pins is the one the layer declares', () => {
  // A pinned adjustment is only meaningful if the declared size is stable too. 18px/1.6 is the
  // word-processor default; ruled templates override it from the rule gap, which is derived from
  // the PAGE width and therefore identical across devices.
  const r = rule('.pan-textlayer');
  assert.match(r, /font-size:18px/, 'a declared size');
  assert.match(r, /line-height:1\.6/, 'and a declared leading');
  assert.match(E, /textLayer\.style\.fontSize=Math\.max\(12,Math\.round\(gap\*0\.6\)\)/,
    'the ruled override is derived from the rule gap');
  assert.match(E, /const gap=ruleGap\(\)/, 'which comes from the page width, not the screen');
});
