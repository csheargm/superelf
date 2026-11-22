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
import { judge } from '../.github/ci-guard.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, '.github/ci-guard.mjs');
const WF = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const tap = (o) => Object.entries(o).map(([k, v]) => `# ${k} ${v}`).join('\n') + '\n';
const GOOD = { tests: 1790, pass: 1789, fail: 0, cancelled: 0, skipped: 1, todo: 0 };

const CEIL = 6;   // a per-OS MAX_SKIPPED

test('guard: a full, clean run passes', () => {
  const r = judge('ok 1 - x\n' + tap(GOOD), 1500, CEIL);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.summary.tests, 1790, 'CONTROL: it read the summary');
});

test('guard: fails a run with too few tests, no summary, a failure, or a bad floor', () => {
  assert.equal(judge(tap({ ...GOOD, tests: 12, pass: 12 }), 1500, CEIL).ok, false, 'a handful of tests is not a run');
  assert.equal(judge(tap({ ...GOOD, tests: 0, pass: 0 }), 1500, CEIL).ok, false, 'zero tests is not a run');
  assert.equal(judge('npm ERR! something\n', 1500, CEIL).ok, false, 'no summary is no evidence');
  assert.equal(judge('# pass 5\n# fail 0\n', 1500, CEIL).ok, false, 'a summary without a test count is no evidence either');
  assert.equal(judge(tap({ ...GOOD, fail: 1 }), 1500, CEIL).ok, false);
  assert.equal(judge(tap({ ...GOOD, cancelled: 2 }), 1500, CEIL).ok, false, 'a cancelled test (timeout) is not a pass');
  assert.equal(judge(tap(GOOD), NaN, CEIL).ok, false, 'an unset MIN_TESTS must not disable the floor');
  assert.equal(judge(tap(GOOD), 0, CEIL).ok, false);
});

test('guard: skips and todos are not passes (R14): the floor is on pass, and skips have a ceiling', () => {
  const massSkip = { tests: 1817, pass: 1000, fail: 0, cancelled: 0, skipped: 817, todo: 0 };
  assert.equal(judge(tap(massSkip), 1500, 1000).ok, false, 'most tests skipped: below the pass floor, whatever the ceiling');
  assert.equal(judge(tap({ ...massSkip, pass: 0, skipped: 0, todo: 1817 }), 1500, 5000).ok, false, 'all todo');
  assert.equal(judge(tap({ ...GOOD, tests: 1790 + 7, skipped: 8 }), 1500, CEIL).ok, false, 'over the per-OS ceiling, though pass is high');
  assert.equal(judge(tap({ ...GOOD, tests: 1790 + 6, skipped: 4, todo: 3 }), 1500, CEIL).ok, false, 'todo counts toward the ceiling');
  assert.equal(judge(tap({ ...GOOD, tests: 1790 + 5, skipped: 6 }), 1500, CEIL).ok, true, 'CONTROL: at the ceiling passes');
  assert.equal(judge(tap(GOOD), 1500, NaN).ok, false, 'an unset MAX_SKIPPED must not disable the ceiling');
  const noSkipLine = { ...GOOD };
  delete noSkipLine.skipped;
  assert.equal(judge(tap(noSkipLine), 1500, CEIL).ok, false, 'no "# skipped" line: the skips cannot be counted');
});

test('guard: the LAST summary wins, and Windows line endings parse', () => {
  const early = '# tests 99999\n';   // a test printing a summary-shaped line mid-run
  assert.equal(judge(early + tap({ ...GOOD, tests: 3, pass: 3 }), 1500, CEIL).ok, false);
  assert.equal(judge(tap(GOOD).replace(/\n/g, '\r\n'), 1500, CEIL).ok, true, 'CRLF from a Windows runner');
});

test('guard as a command: exit 1 below the floor, exit 0 above it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ci-guard-'));
  try {
    const f = path.join(dir, 'out.txt');
    const run = (min, max = '6') => spawnSync(process.execPath, [GUARD, f],
      { env: { ...process.env, MIN_TESTS: String(min), MAX_SKIPPED: max }, encoding: 'utf8' });
    fs.writeFileSync(f, tap(GOOD));
    const hi = run(1500), lo = run(5000);
    assert.equal(hi.status, 0, hi.stdout + hi.stderr);
    assert.match(hi.stdout, /^# tests 1790$/m, 'it prints the summary');
    assert.equal(lo.status, 1, 'CONTROL: the same file fails a higher floor');
    assert.equal(run(1500, '0').status, 1, 'CONTROL: the same file fails a lower ceiling');
    fs.writeFileSync(f, tap({ ...GOOD, pass: 1790, skipped: 0 }));
    assert.equal(run(1500, '0').status, 0, 'CONTROL: a run with no skips passes a ceiling of 0');
    assert.equal(run(1500, '').status, 1, 'but an empty MAX_SKIPPED is unset, not 0: it fails');
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
  for (const os of ['ubuntu-latest', 'windows-latest']) {
    assert.match(WF, new RegExp(`- os: ${os}\\n {12}max_skipped: \\d+$`, 'm'), `${os} on every trigger, with its own skip ceiling`);
  }
  assert.match(WF, /^ {6}MAX_SKIPPED: \$\{\{ matrix\.max_skipped \}\}$/m, 'the matrix ceiling reaches the guard');
  const mac = WF.slice(WF.indexOf('test-macos:'));
  assert.match(mac, /if: github\.event_name == 'workflow_dispatch'/, 'macOS runs only when started by hand');
  assert.match(mac, /^ {6}MAX_SKIPPED: \d+$/m, 'and has its own ceiling');
  assert.ok(!/upload-artifact/.test(WF), 'nothing is uploaded');
  assert.match(WF, /timeout-minutes: \d+/);
  assert.match(WF, /cancel-in-progress: true/);
});
