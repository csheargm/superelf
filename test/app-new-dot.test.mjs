// A newly created app must appear at the TOP of My Apps with a blue dot.
//
// SCAR: it appeared at the BOTTOM. sortBySavedOrder ranked anything missing from appOrder at
// Infinity, and appOrder is fully populated the moment a ▲/▼ reorder writes the whole list —
// so every app created afterwards sorted last, at the end of a long shelf on a phone.
//
// The fix must NOT be "absent from appOrder = new". appOrder is the most-recently-opened
// list, so an old app you simply never opened is absent too; floating those would push the
// app you just used below apps you have never touched. "New" is tracked per device against a
// baseline of app names this device has already listed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8'); // throws if moved (R14)
const SHELL = readShell(ROOT);

function extractFn(src, name, deps = {}) {
  const m = src.match(new RegExp(`(async )?function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} must stay a named top-level function`);
  const keys = Object.keys(deps);
  return new Function(...keys, `${m[0]}; return ${name};`)(...keys.map((k) => deps[k]));
}
const sortFor = (order) => extractFn(SHELL, 'sortBySavedOrder', { savedAppOrder: () => order });

// A fresh device: real Sets, a stubbed _SEEN, and a no-op persist.
function mkNoteNewApps({ known = [], fresh = [], seen = [] } = {}) {
  const K = new Set(known), N = new Set(fresh), S = new Set(seen);
  const fn = extractFn(SHELL, 'noteNewApps',
    { _KNOWN_APPS: K, _NEW_APPS: N, _SEEN: S, _saveAppSets: () => {} });
  return { fn, K, N };
}

test('first run seeds silently — nothing is called new without a baseline', () => {
  const { fn, K } = mkNoteNewApps();
  assert.deepEqual([...fn(['bible', 'notes', 'tasks'])], [], 'dotting every app would claim what we do not know');
  assert.deepEqual([...K].sort(), ['bible', 'notes', 'tasks'], 'but the baseline is now recorded');
});

test('an app that appears after the baseline is new', () => {
  const { fn } = mkNoteNewApps({ known: ['bible', 'notes'] });
  assert.deepEqual([...fn(['bible', 'notes', 'research'])], ['research']);
});

test('it stays new across reloads until it is opened', () => {
  const { fn } = mkNoteNewApps({ known: ['bible'], fresh: ['research'] });
  assert.deepEqual([...fn(['bible', 'research'])], ['research'], 'a reload must not clear the dot');
});

test('opening it clears new — the dot does not nag forever', () => {
  const { fn } = mkNoteNewApps({ known: ['bible', 'research'], fresh: ['research'], seen: ['app:research'] });
  assert.deepEqual([...fn(['bible', 'research'])], []);
});

test('a deleted app stops being new instead of lingering in storage', () => {
  const { fn, N } = mkNoteNewApps({ known: ['bible', 'gone'], fresh: ['gone'] });
  assert.deepEqual([...fn(['bible'])], []);
  assert.equal(N.has('gone'), false, 'and is dropped from the stored set');
});

test('USER FLOW: a new app renders FIRST, above the most-recently-opened one', () => {
  // appOrder is the MRU list; 'research' was created after it was written.
  const order = ['diabetes', 'bible', 'notes'];
  const apps = ['bible', 'diabetes', 'notes', 'research'].map((n) => ({ name: n }));
  const out = sortFor(order)(apps, new Set(['research'])).map((a) => a.name);
  assert.equal(out[0], 'research', 'the new app belongs where the user will see it');
  assert.deepEqual(out, ['research', 'diabetes', 'bible', 'notes'], 'and MRU order is untouched below it');
});

test('REGRESSION: an old app you never opened must NOT float to the top', () => {
  // The tempting shortcut — "absent from appOrder means new" — breaks exactly here: it would
  // push 'melody' above the app the user just opened.
  const order = ['diabetes', 'bible'];
  const apps = ['bible', 'diabetes', 'melody'].map((n) => ({ name: n }));
  const out = sortFor(order)(apps, new Set()).map((a) => a.name);
  assert.equal(out[0], 'diabetes', 'the most recently opened app stays on top');
  assert.deepEqual(out, ['diabetes', 'bible', 'melody']);
});

test('with no saved order at all, the server order is preserved exactly as before', () => {
  const apps = ['bible', 'notes', 'tasks'].map((n) => ({ name: n }));
  assert.deepEqual(sortFor([])(apps, new Set()).map((a) => a.name), ['bible', 'notes', 'tasks']);
});

test('the shelf rows and the ☰ that hides them are both dotted', () => {
  // The shelf is off-screen when an app is created, so without the ☰ dot there is no cue.
  const src = SHELL.slice(SHELL.indexOf('async function loadApps()'));
  assert.match(src, /markNew\(el,'app:'\+el\.dataset\.n\)/, 'drawer rows carry the dot');
  assert.match(src, /markNew\(el,'app:'\+el\.dataset\.es\)/, 'empty-state cards too');
  assert.match(src, /markNewSel\('#menu'/, 'and the ☰ button');
});
