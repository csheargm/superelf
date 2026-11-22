// No one's identity lives in this repository · 身份信息不进仓库
//
// The repo is private today. The rule is written for the day it is not, and for the fact that a
// pushed history cannot be un-pushed. What counts as identity is NOT written in this file: a
// detector that carries the names it hunts for is itself the leak, and that mistake was made once,
// in the app-only check this file replaces. The list is DERIVED from the machine running the test,
// plus an optional local file that git ignores by construction:
//
//   workspace/identity-denylist.txt   one string per line; '#' comments; blank lines ignored
//
// Derived: the OS login, and the owner's username and display name from config.json. Member names
// are deliberately NOT derived — a name that is also an ordinary word would fail every Bible app on it
// alone — so they go in the file, where the owner sees a false positive the moment it happens.
//
// Scope is every tracked text file, not app code alone. The miss that forced the widening: a
// server-side prompt in tools/ carried the owner's full name while the app-only check stayed green.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IN_CI } from './helpers-platform.mjs';   // CI means exactly CI=true (one definition, R3)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DENYLIST_REL = 'workspace/identity-denylist.txt';
// A derived login shorter than this ('root', 'user') would match prose everywhere. File entries
// are explicit choices and are honoured at any length.
const MIN_DERIVED_LEN = 5;

function readText(p) {
  let s;
  try { s = fs.readFileSync(p, 'utf8'); } catch { return null; }   // indexed but deleted: nothing to scan
  return /\0/.test(s.slice(0, 512)) ? null : s;                       // binary: not prose
}

// bible-data/ is public-domain Scripture (BSB, 和合本): a name there belongs to its text, not to
// whoever runs this (Luke 2:36 names a prophetess; a first name on the denylist tripped on it, 2026-11-02).
const SCRIPTURE_DIR = 'bible-data/';
const trackedTextFiles = () => execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => !f.startsWith(SCRIPTURE_DIR))
  .map((f) => [f, readText(path.join(ROOT, f))])
  .filter(([, s]) => s !== null);

// In CI the OS login is NOT an identity. GitHub's runners log in as generic accounts ("runner" on
// Linux and macOS, "runneradmin" on Windows), and "runner" is an ordinary word in this code
// (lib/runner.mjs), so deriving it failed every CI run on a name that belongs to nobody. With no
// config.json and no denylist file there, the list is then empty and the tripwire below SKIPS,
// counted as a skip: it is a local pre-push check, and the place it runs for real is the owner's
// machine, where the login IS a person.
export function derivedIdentity({ ci = IN_CI } = {}) {
  const out = [];
  if (!ci) {
    try { out.push(os.userInfo().username); } catch { /* no passwd entry: nothing to derive from */ }
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    for (const u of cfg.users || []) if (u.role === 'owner') out.push(u.username, u.name);
  } catch { /* fresh clone with no owner yet: the OS login alone still applies */ }
  return out.map((s) => String(s || '').trim()).filter((s) => s.length >= MIN_DERIVED_LEN);
}

function fileIdentity() {
  let text;
  try { text = fs.readFileSync(path.join(ROOT, DENYLIST_REL), 'utf8'); } catch { return []; }
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

export const identityList = () => [...new Set([...derivedIdentity(), ...fileIdentity()])];

// An ASCII entry matches as a whole word, so a first name never fires on a longer word that
// happens to start with it. \b is ASCII-only in JS, so a Chinese entry — which has no word
// boundary to find — matches as a plain substring.
export function matcherFor(entry) {
  const esc = entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return /^[\w-]+$/.test(entry) ? new RegExp(`\\b${esc}\\b`, 'i') : new RegExp(esc, 'i');
}

// file:line plus the entry's INDEX, never the entry: test output gets pasted into issues.
function offenders(files, entries) {
  const out = [];
  const res = entries.map(matcherFor);
  for (const [f, s] of files) {
    s.split('\n').forEach((line, i) => {
      res.forEach((re, k) => { if (re.test(line)) out.push(`${f}:${i + 1} (entry #${k + 1})`); });
    });
  }
  return out;
}

test('no tracked file carries the identity of whoever runs this', (t) => {
  const entries = identityList();
  if (!entries.length) {
    return t.skip(IN_CI ? 'CI: the OS login is a generic runner account; no config.json, no denylist file'
      : 'nothing to check: no OS login, no owner in config.json, no denylist file');
  }
  // R14 controls: a green result must mean absence, not a matcher that never fires.
  assert.ok(matcherFor(entries[0]).test(`x ${entries[0]} y`), 'CONTROL: the matcher must match its own entry');
  assert.ok(matcherFor('mark').test('Mark 1:1') && !matcherFor('mark').test('marker'),
    'CONTROL: an ASCII entry is a whole word, case-insensitive');
  assert.ok(matcherFor('中文').test('是中文测试'), 'CONTROL: a non-ASCII entry matches as a substring');
  assert.deepEqual(offenders(trackedTextFiles(), entries), [],
    'these tracked lines carry a person. Names belong in runtime data (profile.json), never in code');
});

test('in CI the OS login is not derived; outside CI it is', () => {
  let login = '';
  try { login = os.userInfo().username; } catch { /* no passwd entry */ }
  // Measured against a login that is long enough to count, so neither branch can pass by length.
  const counts = login.trim().length >= MIN_DERIVED_LEN;
  if (counts) assert.ok(derivedIdentity({ ci: false }).includes(login), 'CONTROL: outside CI the login is derived');
  assert.ok(!derivedIdentity({ ci: true }).includes(login) || !login, 'in CI the login (e.g. "runner") is never an entry');
  assert.equal(IN_CI, process.env.CI === 'true', 'CI means exactly CI=true, the variable GitHub Actions sets');
});

test('no tracked file carries data shaped like a person', () => {
  // Shape, not name, so no list is needed. Email is scoped to app code: tests and the settings
  // dialog legitimately carry example addresses, and an exemption list wide enough to pass them
  // would prove nothing.
  const inApps = (f) => f.startsWith('workspace/apps/');
  const SHAPES = [
    [/\b\d{3}-\d{2}-\d{4}\b/, 'a government id', () => true],
    [/\b(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/, 'a phone number', () => true],
    [/\bA1C\s*[:=]\s*\d/i, 'a recorded health value', () => true],
    [/\b\d{1,5}\s+[A-Z][a-z]+\s+(Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln)\b/, 'a street address', () => true],
    [/[\w.+-]+@[\w-]+\.[a-z]{2,}/i, 'an email address', inApps],
  ];
  const found = [];
  for (const [f, s] of trackedTextFiles()) {
    for (const [re, what, applies] of SHAPES) if (applies(f) && re.test(s)) found.push(`${f}: ${what}`);
  }
  assert.deepEqual(found, [], 'tracked files must carry no personal data — put it in runtime data instead');
  // The control is assembled at runtime: written out, this file would be its own first offender.
  assert.ok(SHAPES[0][0].test(['123', '45', '6789'].join('-')) && SHAPES[4][0].test('a@b.example'), 'CONTROL: the shapes match their own kind');
});

test('the denylist file itself can never be committed', () => {
  // The one file that DOES name people. Ask git, not the .gitignore text.
  let ignored = true;
  try { execFileSync('git', ['check-ignore', '-q', '--no-index', DENYLIST_REL], { cwd: ROOT }); }
  catch { ignored = false; }
  assert.ok(ignored, `${DENYLIST_REL} must be ignored by construction, or the detector becomes the leak`);
});
