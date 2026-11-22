// Settings reads as a page, not a pop-up · 设置是一页，不是弹窗
//
// Reported with a screenshot: the profile form squeezed into a narrow column — "so much content
// in a narrow pop up window". The cause is one SHARED rule, `dialog{ width:min(360px,…) }`, which
// serves #login, #setup and #cfg alike. 360px is right for a four-field login and wrong for a
// form carrying the profile, the family list, the shelf, node settings and the audit log.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = readShell(ROOT);

test('settings fills the viewport', () => {
  const rule = /#cfg\{[\s\S]*?\}/.exec(SHELL);
  assert.ok(rule, 'the #cfg box rule must be findable');
  assert.match(rule[0], /width:100vw/, 'full width');
  assert.match(rule[0], /height:100dvh/, 'full height — dvh, so an iOS toolbar cannot clip it');
  assert.match(rule[0], /max-width:100vw/, 'and the shared 360px cap is overridden, not merely widened');
});

test('CONTROL: login and setup are NOT widened', () => {
  // The whole point is that one dialog needed a different box, not that pop-ups are bad. If the
  // shared rule itself had been changed, a four-field login would now span a 27-inch monitor —
  // and this test would pass while making the product worse.
  assert.match(SHELL, /dialog\{[\s\S]*?width:min\(360px, calc\(100vw - 32px\)\)/,
    'the shared dialog rule still caps at 360px');
  const cfg = /#cfg\{[\s\S]*?\}/.exec(SHELL)[0];
  assert.ok(!/#login|#setup/.test(cfg), 'the override names only #cfg');
});

test('the content column stays readable on a wide screen', () => {
  // Full-width without a column cap means form rows stretched across the whole monitor, which is
  // a different unreadable. Padding centres the column without touching the markup.
  const rule = /#cfg\{[\s\S]*?\}/.exec(SHELL)[0];
  assert.match(rule, /calc\(\(100vw - 760px\) \/ 2\)/, 'a centred column, not an edge-to-edge form');
  assert.match(rule, /max\(16px, calc\(\(100vw - 760px\) \/ 2\)\)/,
    'and max() keeps a phone edge-to-edge once the viewport is narrower than the column');
});

test('it is still a <dialog>, so Escape and focus containment are not re-implemented', () => {
  // Converting to a routed view would mean re-building Escape-to-close, focus trapping and an
  // inert background — a lot of new surface to get wrong for a layout complaint.
  assert.match(SHELL, /<dialog id="cfg">|<dialog id=cfg>/, 'still a dialog element');
  assert.match(/#cfg\{[\s\S]*?\}/.exec(SHELL)[0], /border:0; border-radius:0/, 'but it no longer looks like a card');
});
