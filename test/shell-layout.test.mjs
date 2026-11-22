// Two layout rules in the shell that are invisible in source review and only show on a device.
//
// 1. The app shelf sits as a SIBLING of #log inside main{overflow:hidden}. A shelf taller than the
//    viewport was therefore clipped with nothing to scroll — with 16 apps the last ones could not
//    be reached at all. Measured on the real page: the element grew to 1292px inside an 812px
//    viewport and scrollTop stayed 0.
// 2. The sign-in / first-run dialogs are the FIRST thing a phone sees. `*{margin:0}` cancels the
//    margin:auto that centres a modal <dialog>, so they sat in the top-left corner and hung off
//    the edge; their inputs inherited no font, so they rendered at the UA default (~13px); and
//    with no max-height a taller dialog (create-account + token field) overflowed a landscape
//    phone with no way to scroll — measured at 446px tall in a 375px viewport, scrollTop 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHELL } from './helpers-app.mjs';

// Comments are stripped FIRST: the dialog rule's own comment mentions `margin:auto` and contains a
// literal `}`, so a naive slice both ended early and then matched the prose it was explaining — a
// test that passed while the declaration was deleted (R14).
const CSS = SHELL.replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (sel) => {
  const i = CSS.indexOf(`\n${sel}{`);
  assert.ok(i >= 0, `the ${sel} rule is gone`);
  return CSS.slice(i, CSS.indexOf('}', i) + 1);
};

test('the app shelf can scroll — it is clipped by main{overflow:hidden} otherwise', () => {
  const main = rule('main');
  assert.match(main, /overflow:hidden/, 'main still clips its children, so the shelf must scroll itself');
  const shelf = rule('#emptyState');
  assert.match(shelf, /overflow-y:auto/, 'the shelf must scroll');
  assert.match(shelf, /min-height:0/, 'a flex child needs min-height:0 or it refuses to shrink');
  assert.doesNotMatch(shelf, /flex-shrink:0|flex:0 0/, 'a non-shrinking shelf overflows the viewport and is clipped');
  assert.match(shelf, /padding:[^;]*--pill-clear/, 'the last row must clear the composer, like #log does');
});

test('a modal dialog is centred, fits a phone, and can scroll', () => {
  const d = rule('dialog');
  // margin:auto is what centres a modal <dialog>; the global reset cancels it.
  assert.match(CSS, /\*\{ box-sizing:border-box; margin:0; \}/, 'the global reset still zeroes margins');
  assert.match(d, /margin:auto/, 'without margin:auto the dialog pins to the top-left corner');
  assert.match(d, /width:min\(/, 'a fixed width does not fit both a phone and a desktop');
  assert.match(d, /100vw - \d+px/, 'the width must leave a gutter on a narrow phone');
  assert.match(d, /max-height:/, 'an uncapped dialog overflows a landscape phone');
  assert.match(d, /overflow-y:auto/, 'and once capped it must scroll, or its button is unreachable');
});

test('dialog form controls carry a font — they inherit none by default', () => {
  const i = CSS.indexOf('dialog input, dialog textarea, dialog select, dialog button{');
  assert.ok(i >= 0, 'the dialog control font rule is gone — inputs fall back to ~13px');
  const r = CSS.slice(i, CSS.indexOf('}', i) + 1);
  assert.match(r, /font:inherit/, 'controls must take the shell font');
  assert.match(r, /max\(16px/, '16px is the floor below which iOS zooms the page on focus');
  assert.match(r, /--fs/, 'and it must still answer to A-/A+');
});

test('the primary action is a real touch target', () => {
  const r = rule('dialog .primary');
  assert.match(r, /min-height:44px/, '44px is the minimum comfortable touch target');
});
