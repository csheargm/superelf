// Most-recently-opened app ordering for the My Apps shelf.
//
// The shelf reuses ME.appOrder — the SAME server-side array the ▲/▼ menu writes — rather
// than adding a second ordering system (R3). Opening one of your own apps moves its slug to
// the head; the family shelf is excluded because appOrder describes own apps only.
//
// mruOrder and sortBySavedOrder are pure and are executed here for real (no DOM); the
// wiring that cannot be run headless (openApp's guard, the redundant-PUT skip) is asserted
// against the committed source, the same way test/actions-ui.test.mjs does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8'); // throws if moved — never pass vacuously (R14)

function extractFn(src, name, deps = {}) {
  const m = src.match(new RegExp(`(async )?function ${name}\\([^)]*\\)\\{[\\s\\S]*?\\n\\}`));
  assert.ok(m, `${name} must stay a named top-level function — the harness runs it without a DOM`);
  const keys = Object.keys(deps);
  return new Function(...keys, `${m[0]}; return ${name};`)(...keys.map((k) => deps[k]));
}

const SHELL = readShell(ROOT);
const mruOrder = extractFn(SHELL, 'mruOrder');
const sortFor = (order) => extractFn(SHELL, 'sortBySavedOrder', { savedAppOrder: () => order });
const APPS = ['bible', 'journal', 'longevity', 'diabetes'].map((n) => ({ name: n }));

test('mruOrder puts the opened app first', () => {
  assert.deepEqual(mruOrder('diabetes', ['bible', 'journal', 'longevity', 'diabetes']),
    ['diabetes', 'bible', 'journal', 'longevity']);
});

test('mruOrder keeps the other apps in their existing relative order', () => {
  assert.deepEqual(mruOrder('longevity', ['bible', 'journal', 'longevity', 'diabetes']),
    ['longevity', 'bible', 'journal', 'diabetes']);
});

test('mruOrder never duplicates a slug, however many times it is opened', () => {
  let o = ['bible', 'journal'];
  for (let i = 0; i < 5; i++) o = mruOrder('journal', o);
  assert.deepEqual(o, ['journal', 'bible']);
  assert.equal(new Set(o).size, o.length);
});

test('mruOrder handles a first-ever open (no saved order yet)', () => {
  assert.deepEqual(mruOrder('bible', undefined), ['bible']);
  assert.deepEqual(mruOrder('bible', []), ['bible']);
  assert.deepEqual(mruOrder('bible', null), ['bible']);
});

test('an app absent from the saved order is still promoted to the top', () => {
  // A newly created app has no entry in appOrder; opening it must still float it up.
  assert.deepEqual(mruOrder('timer', ['bible', 'journal']), ['timer', 'bible', 'journal']);
});

// ---- the actual user flow: open an app, then look at the shelf (R6) ----

test('USER FLOW: opening Diabetes renders it at the top of My Apps', () => {
  const after = mruOrder('diabetes', []);           // shelf had no saved order (the screenshot's state)
  const rendered = sortFor(after)(APPS).map((a) => a.name);
  assert.equal(rendered[0], 'diabetes');
  assert.deepEqual(rendered, ['diabetes', 'bible', 'journal', 'longevity']);
});

test('USER FLOW: the three most recent apps end up on top, newest first', () => {
  let order = [];
  for (const opened of ['longevity', 'bible', 'diabetes']) order = mruOrder(opened, order);
  const rendered = sortFor(order)(APPS).map((a) => a.name);
  assert.deepEqual(rendered.slice(0, 3), ['diabetes', 'bible', 'longevity']);
  assert.equal(rendered[3], 'journal', 'the never-opened app falls to the bottom');
});

test('USER FLOW: a deleted app lingering in appOrder does not displace a real one', () => {
  const rendered = sortFor(['ghost-app', 'diabetes'])(APPS).map((a) => a.name);
  assert.equal(rendered[0], 'diabetes');
});

// ---- wiring that cannot run headless ----

test('openApp promotes only your OWN apps, never a family-shelf app', () => {
  assert.match(SHELL, /function openApp\(uid,slug,title\)\{ if\(uid===UID\) promoteApp\(slug\);/,
    'openApp must guard promotion on uid===UID — appOrder describes own apps only');
});

test('promoteApp skips the PUT when the app is already on top', () => {
  const src = SHELL.match(/function promoteApp\([\s\S]*?\n\}/)[0];
  assert.match(src, /if\(cur\[0\]===name\) return;/, 'reopening the top app must not re-render or re-PUT');
  assert.match(src, /saveAppOrder\(names\)/, 'the new order must persist server-side, not just locally');
  assert.match(src, /ME\.appOrder=names/, 'local state must update optimistically, like moveApp');
  assert.match(src, /loadApps\(\)/, 'the shelf must re-render so Home is sorted when the app closes');
});

test('MRU reuses the ▲/▼ ordering, it does not introduce a second one (R3)', () => {
  assert.equal((SHELL.match(/appOrder:/g) || []).length, 1, 'exactly one place writes appOrder to the profile');
  assert.ok(!/localStorage\.[gs]etItem\(['"][^'"]*(?:mru|recent)/i.test(SHELL),
    'recency must live in the profile so it follows the account across devices, not in localStorage');
});
