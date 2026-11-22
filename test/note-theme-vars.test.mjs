// Menus stay legible in dark mode · 深色模式下菜单必须可读
//
// SCAR. On iPad in dark mode the paragraph-style menu was black text on a black card — the rows
// were there, and unreadable. The cause was not a missing dark theme: it was a variable that does
// not exist. `var(--fg,#1a1a1a)` looks theme-aware and is not — the apps declare --text, --muted,
// --card, --line, --accent and --bg, and never --fg — so it had ALWAYS been the hardcoded
// near-black fallback. On light paper nobody could tell.
//
// The same two rules styled the image and photo menus, which had the defect all along and had
// simply never been opened in the dark.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, CHAT, APP_SRC, stripComments } from './helpers-app.mjs';

// Comments are stripped: the rules below warn about --fg BY NAME, and a source-text match would
// trip over the warning instead of the defect.
// stripComments handles JS comments; the pad's CSS lives inside JS STRINGS, so its /* … */
// blocks survive that — and one of them warns about --fg by name. Both are removed here, or the
// test trips over the warning instead of the defect.
const E = stripComments(ENGINE).replace(/\/\*[\s\S]*?\*\//g, '');
const APP = APP_SRC['notes (template)'];

test('the pad uses no colour variable the apps do not define', () => {
  // Every var(--x) the component reads must be declared by the page it is inlined into, or its
  // fallback is the only value it will ever have — a hardcoded colour wearing a theme's clothes.
  const declared = new Set([...APP.matchAll(/--([a-z-]+)\s*:/g)].map((m) => m[1]));
  for (const v of ['text', 'muted', 'card', 'line', 'accent', 'bg']) {
    assert.ok(declared.has(v), `the app declares --${v}`);
  }
  const used = new Set([...E.matchAll(/var\(--([a-z-]+)/g)].map((m) => m[1]));
  // Variables the PAD defines for itself are fine; these are the ones it inherits from the page.
  // Declared by the pad itself, or by a SIBLING component inlined into the same page — chat-ui
  // declares --pac-dock and the pad reads it, which is legitimate: they share one document.
  // The pad's OWN namespace. --pan-* variables are set from JS (host.style.setProperty), not in
  // a CSS declaration, so a rule-text scan does not see them and they are not orphans.
  const own = new Set([...E.matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1].slice(2)));
  const sibling = new Set([...stripComments(CHAT).matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1].slice(2)));
  const orphans = [...used].filter((v) =>
    !declared.has(v) && !own.has(v) && !sibling.has(v) && !v.startsWith('pan-'));
  assert.deepEqual(orphans, [], `these resolve to their hardcoded fallback, always: ${orphans.join(', ')}`);
});

test('--fg and --hover are gone, specifically', () => {
  // Named, because they are the two that were wrong and a regression would most likely
  // reintroduce exactly these spellings.
  assert.doesNotMatch(E, /var\(--fg[,)]/, '--fg is not a thing');
  assert.doesNotMatch(E, /var\(--hover[,)]/, 'nor is --hover');
});

test('menu rows take their colour from the theme', () => {
  for (const sel of ['.pan-photoopt', '.pan-styleopt']) {
    const i = E.indexOf(`\n${sel}{`);
    assert.ok(i >= 0, `${sel} must exist`);
    const rule = E.slice(i, E.indexOf('}', i) + 1);
    assert.match(rule, /color:var\(--text,/, `${sel} follows the theme's text colour`);
  }
});

test('the hover tint adapts to whatever ground it is on', () => {
  // A fixed rgba(0,0,0,.06) is invisible on a dark card. currentColor is the row's own text
  // colour, which is by definition legible against the ground it sits on.
  const hovers = [...E.matchAll(/:hover,[^{]*:active\{background:([^}]+)\}/g)].map((m) => m[1]);
  assert.ok(hovers.length >= 2, 'both menus have a hover');
  for (const h of hovers) assert.match(h, /color-mix\(in srgb,currentColor/, `adaptive, not fixed: ${h}`);
});
