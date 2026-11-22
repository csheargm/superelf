// The broker kinds list in superelf.md must name every kind the shell implements.
//
// SCAR: the list was maintained by hand and had drifted by SEVEN kinds — bible, bible-search,
// meal-photo, meals, print, set-model and websearch all shipped without ever being written down.
// superelf.md has a single commit (2026-09-11) and websearch landed six days later, so the
// document was stale by construction. That list is also what the server now feeds the agent as
// the app contract, so a kind missing from it is a capability no generated app will ever use.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MD = fs.readFileSync(path.join(ROOT, 'superelf.md'), 'utf8');
const SHELL = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const shellKinds = () => [...new Set([...SHELL.matchAll(/m\.kind==='([a-z-]+)'/g)].map((m) => m[1]))].sort();
// The KINDS LIST itself, not the whole document. Checking the whole file passes when a kind is
// merely mentioned in the prose underneath — which is exactly how the first version of this test
// failed to notice websearch being deleted from the list.
const kindsList = () => {
  const m = /^Kinds: [\s\S]*?`\.$/m.exec(MD);
  assert.ok(m, 'the "Kinds:" list must be findable in superelf.md');
  return m[0];
};

test('CONTROL: the shell really does implement a broad set of kinds', () => {
  // If this ever collapsed to a handful, the assertion below would pass by having nothing to check.
  const kinds = shellKinds();
  assert.ok(kinds.length >= 30, `only found ${kinds.length} kinds — the extraction is probably broken`);
  assert.ok(kinds.includes('websearch') && kinds.includes('render-md'), 'and the expected ones are among them');
});

test('superelf.md names every kind the shell implements', () => {
  const list = kindsList();
  const missing = shellKinds().filter((k) => !list.includes('`' + k + '`'));
  assert.deepEqual(missing, [],
    `superelf.md is missing ${missing.length} broker kind(s). It is the app contract AND what the agent is told — a kind absent from it is a capability no generated app will use.`);
});

test('the list says it is not hand-maintained, and names this test', () => {
  // So the next person to add a kind is told where the check lives instead of discovering it red.
  assert.match(MD, /test\/broker-kinds\.test\.mjs/, 'superelf.md points at its own enforcement');
});
