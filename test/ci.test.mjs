// The CI workflow and its guard · 持续集成工作流与守卫
//
// The guard is what stops a run that tested nothing from going green (R14), so it is tested like
// code. The workflow's safety properties are pinned as text: its least-privilege token, its actions
// pinned to a commit (a tag can be moved under us), and macOS only by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judge, skipReasons, unexpectedSkips, forbidTags } from '../.github/ci-guard.mjs';
import { SKIP_TAGS, skipBecause, skipIf } from './helpers-skip.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, '.github/ci-guard.mjs');
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const tap = (o) => Object.entries(o).map(([k, v]) => `# ${k} ${v}`).join('\n') + '\n';
const GOOD = { tests: 4000, pass: 3998, fail: 0, cancelled: 0, skipped: 2, todo: 0 };
const SKIPS = 'ok 1 - opens the page # SKIP [no-browser] no Playwright: set PA_PLAYWRIGHT\n'
  + '    ok 2 - nested e2e \\# 3 # SKIP [no-browser] no Playwright\n';
const run = (skipLines, sum = GOOD, platform = 'linux', min = 3500) => judge('ok 9 - x\n' + skipLines + tap(sum), min, platform);

test('guard: a full run whose every skip is tagged and expected passes', () => {
  const r = run(SKIPS);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.summary.tests, 4000, 'CONTROL: it read the summary');
  assert.deepEqual(skipReasons(SKIPS), ['[no-browser] no Playwright: set PA_PLAYWRIGHT', '[no-browser] no Playwright'],
    'it reads reasons at any depth, past an escaped # in a name');
});

test('guard: fails a run with too few tests, no summary, a failure, a todo, or a bad floor', () => {
  assert.equal(run(SKIPS, { ...GOOD, tests: 14, pass: 12 }).ok, false, 'a handful of tests is not a run');
  assert.equal(judge('npm ERR! something\n', 3500).ok, false, 'no summary is no evidence');
  assert.equal(judge('# pass 5\n# fail 0\n', 3500).ok, false, 'a partial summary is no evidence either');
  assert.equal(run(SKIPS, { ...GOOD, fail: 1 }).ok, false);
  assert.equal(run(SKIPS, { ...GOOD, cancelled: 2 }).ok, false, 'a cancelled test (timeout) is not a pass');
  assert.equal(run(SKIPS, { ...GOOD, todo: 1 }).ok, false, 'a todo is not a pass');
  assert.equal(run(SKIPS, GOOD, 'linux', NaN).ok, false, 'an unset MIN_TESTS must not disable the floor');
  assert.equal(run(SKIPS, GOOD, 'linux', 0).ok, false);
});

test('guard: an untagged, unknown or unexpected skip fails; the same tag elsewhere passes', () => {
  const one = { ...GOOD, skipped: 1, pass: 3999 };
  assert.equal(run('ok 1 - a # SKIP\n', one).ok, false, 'no reason at all');
  assert.equal(run('ok 1 - a # SKIP needs bash\n', one).ok, false, 'a reason without a tag');
  assert.equal(run('ok 1 - a # SKIP [made-up] x\n', one).ok, false, 'a tag helpers-skip.mjs does not know');
  assert.equal(run('ok 1 - a # SKIP [no-git-history] x\n', one).ok, false, 'a tag CI must never hit');
  assert.equal(run('ok 1 - a # SKIP [posix-only] x\n', one, 'linux').ok, false, 'posix-only is unexpected on Linux');
  assert.equal(run('ok 1 - a # SKIP [posix-only] x\n', one, 'win32').ok, true, 'CONTROL: and expected on Windows');
  assert.match(run('ok 1 - a # SKIP needs bash\n', one).reason, /needs bash/, 'the failure names the reason');
  assert.deepEqual(unexpectedSkips(['[no-browser] x', 'x', '[no-gpg] y'], 'linux'), ['x', '[no-gpg] y']);
});

test('guard: skip lines must add up to the summary, so a missed line cannot hide a skip', () => {
  assert.equal(run(SKIPS, { ...GOOD, skipped: 3 }).ok, false, 'summary says 3, only 2 lines found');
  assert.equal(run('', GOOD).ok, false, 'skips with no skip lines at all');
  assert.equal(run('', { ...GOOD, skipped: 0, pass: 4000 }).ok, true, 'CONTROL: no skips, nothing to account for');
});

test('guard: the LAST summary wins, and Windows line endings parse', () => {
  assert.equal(judge('# tests 99999\n' + SKIPS + tap({ ...GOOD, tests: 5, pass: 3 }), 3500, 'linux').ok, false);
  assert.equal(judge((SKIPS + tap(GOOD)).replace(/\n/g, '\r\n'), 3500, 'linux').ok, true, 'CRLF from a Windows runner');
});

test('every skip tag is a known one, and skipBecause refuses an unknown tag', () => {
  assert.equal(skipBecause('no-browser', 'x'), '[no-browser] x');
  assert.equal(skipIf(false, 'no-browser', 'x'), false);
  assert.throws(() => skipBecause('nope', 'x'), /unknown skip tag/);
  for (const [tag, oses] of Object.entries(SKIP_TAGS)) {
    assert.match(tag, /^[a-z-]+$/);
    for (const o of oses) assert.ok(['linux', 'win32', 'darwin'].includes(o), `${tag}: ${o}`);
  }
});

// Known limits: a text scan, so it pins the shapes that once existed (bare platform booleans, a
// string literal handed to t.skip), not every way a test could skip. The runtime guard is the net.
test('no test skips without a tag: no bare { skip: <platform test> } and no t.skip("literal")', () => {
  const dir = path.join(ROOT, 'test');
  const hits = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.mjs') && n !== 'ci.test.mjs')) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      if (/skip:\s*(true\b|process\.platform|!\w+\s*&&)/.test(line) || /\bt\.skip\(\s*['"`]/.test(line)) hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], 'use skipIf / skipBecause from test/helpers-skip.mjs');
  assert.ok(/t\.skip\(\s*['"`]/.test("t.skip('x')") && /skip:\s*process\.platform/.test("{ skip: process.platform === 'win32' }"), 'CONTROL: the scan matches the old shapes');
});

test('guard as a command: exit 0 on a clean run, exit 1 on an untagged skip or a high floor', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ci-guard-'));
  try {
    const f = path.join(dir, 'out.txt');
    const cmd = (min) => spawnSync(process.execPath, [GUARD, f], { env: { ...process.env, MIN_TESTS: String(min) }, encoding: 'utf8' });
    fs.writeFileSync(f, SKIPS + tap(GOOD));
    const hi = cmd(3500);
    assert.equal(hi.status, 0, hi.stdout + hi.stderr);
    assert.match(hi.stdout, /^# tests 4000$/m, 'it prints the summary');
    assert.equal(cmd(5000).status, 1, 'CONTROL: the same file fails a higher floor');
    assert.equal(cmd('').status, 1, 'an empty MIN_TESTS is unset, not 0: it fails');
    fs.writeFileSync(f, 'ok 1 - a # SKIP\n' + SKIPS + tap({ ...GOOD, skipped: 3 }));
    const bad = cmd(3500);
    assert.equal(bad.status, 1, 'an untagged skip fails');
    assert.match(bad.stdout, /unexpected skips/);
    assert.equal(spawnSync(process.execPath, [GUARD, path.join(dir, 'missing.txt')]).status, 1, 'unreadable output fails');
  } finally { rmTemp(dir); }
});

test('workflow: least privilege, pinned actions, a floor, macOS only by hand', () => {
  assert.match(WF, /^permissions:\n {2}contents: read$/m, 'the token can read the repo and nothing else');
  const uses = [...WF.matchAll(/uses:\s*(\S+)(.*)$/gm)];
  assert.ok(uses.length >= 2, 'CONTROL: the workflow uses actions');
  for (const [, ref, rest] of uses) {
    assert.match(ref, /@[0-9a-f]{40}$/, `${ref} is pinned to a full commit SHA`);
    assert.match(rest, /# v\d/, `${ref} names its version in a comment`);
  }
  assert.match(WF, /^ {2}MIN_TESTS: \d{3,}$/m, 'a test-count floor is set');
  assert.match(WF, /ci-guard\.mjs/, 'and the guard runs');
  assert.match(WF, /^ {8}os: \[ubuntu-latest, windows-latest\]$/m, 'ubuntu and Windows on every trigger');
  assert.ok(!/MAX_SKIPPED|max_skipped/.test(WF), 'no hand-raised skip ceiling: the guard checks skip tags');
  const mac = WF.slice(WF.indexOf('test-macos:'));
  assert.match(mac, /if: github\.event_name == 'workflow_dispatch'/, 'macOS runs only when started by hand');
  assert.ok(!/upload-artifact/.test(WF), 'nothing is uploaded');
  assert.match(WF, /timeout-minutes: \d+/);
  assert.match(WF, /cancel-in-progress: true/);
});

test('CI_FORBID_SKIP: a browser job that skips for a missing browser goes red (R14)', () => {
  const out = 'ok 1 - a # SKIP [no-browser] none\nok 2 - b\n# tests 2\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n';
  assert.equal(judge(out, 1, 'linux').ok, true);
  const r = judge(out, 1, 'linux', forbidTags('no-browser'));
  assert.equal(r.ok, false); assert.match(r.reason, /unexpected skips/);
  assert.ok(Object.hasOwn(forbidTags(''), 'no-browser'));
});
