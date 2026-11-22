// Two controls in the shell say "Home" and neither went home: the drawer's was a plain <b> with
// no handler at all, and the app bar's "← Home" closed the app and opened the DRAWER. Reported as
// "click home to display home screen".
//
// The rule this file enforces is the one that keeps it fixed: there is ONE definition of the home
// destination, and every control labelled Home is wired to it — rather than each growing its own
// idea of where Home is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHELL } from './helpers-app.mjs';

const JS = SHELL.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('there is exactly one definition of Home, and it clears everything', () => {
  assert.equal((JS.match(/function goHome\(\)/g) || []).length, 1, 'goHome must be defined once');
  const body = JS.slice(JS.indexOf('function goHome()'), JS.indexOf('\n}', JS.indexOf('function goHome()')));
  for (const [what, re] of [
    ['close any open app', /#frame'\)\.style\.display='none'/],
    // Leaving holds the app's page while it saves, then removes it (web/app-frame.js, ADR 0018;
    // run by test/app-leave.test.mjs). Blanking the frame here is what lost the last save.
    ['leave the app', /appFrameLeave\(\)/],
    ['drop the open conversation', /setConvo\(null\)/],
    ['clear the transcript', /#log'\)\.innerHTML=''/],
    ['close the drawer', /closeDrawer\(\)/],
    ['show the app shelf', /showEmptyState\(\)/],
  ]) assert.match(body, re, `Home must ${what}`);
});

test('every control that says Home is wired to it', () => {
  // Enumerate rather than trusting a list: find each element whose label is Home, then prove
  // its handler is goHome. A third Home button added later fails here until it is wired.
  const labelled = [...SHELL.matchAll(/id="([a-zA-Z]+)"[^>]*>(?:←\s*)?Home</g)].map((m) => m[1]);
  const byTitle = [...SHELL.matchAll(/id="([a-zA-Z]+)"[^>]*title="Home[^"]*"/g)].map((m) => m[1]);
  const homes = [...new Set([...labelled, ...byTitle])];
  assert.ok(homes.includes('goHome'), 'the drawer header must carry a Home control');
  assert.ok(homes.includes('back'), 'the app bar must carry a Home control');
  for (const id of homes) {
    assert.match(JS, new RegExp(`\\$\\('#${id}'\\)\\.onclick\\s*=\\s*goHome\\b`),
      `#${id} says Home but is not wired to goHome`);
  }
});

test('the drawer Home is a real control, not a label', () => {
  assert.match(SHELL, /<button[^>]*id="goHome"/, 'Home must be a button — a <b> cannot be clicked');
  assert.doesNotMatch(SHELL, /<div class="dhead"><b>Home<\/b>/, 'the dead <b> label is back');
});

test('nobody re-implements the destination', () => {
  // ← Home used to close the app and open the drawer instead of going home.
  assert.doesNotMatch(JS, /\$\('#back'\)\.onclick=\(\)=>\{[^}]*openDrawer\(\)/, '← Home must not open the drawer');
  // + New lands at the same place; it must alias goHome, not copy the sequence.
  assert.match(JS, /const newConvo\s*=\s*goHome/, 'newConvo must be the same destination, not a second copy');
  assert.equal((JS.match(/showEmptyState\(\);\s*\}/g) || []).length, 1, 'only goHome ends by showing the shelf');
});
