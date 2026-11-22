// The version rule, pinned against the REAL version.sh — not a re-implementation of its
// arithmetic, which would be free to agree with a copy of the bug (R3/R14). version.sh grew a
// `--next` mode for exactly this: it prints the version it WOULD produce and exits, touching no
// file, making no commit, creating no tag.
//
// The rule: MINOR IS CAPPED AT 99. A minor bump from x.99.z is the next MAJOR, not x.100.0. It
// arrived after the minor reached 110 unnoticed, so the cap also has to pull an already
// out-of-range version back into line rather than leave it stranded.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { needBash } from './helpers-platform.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO, 'version.sh');
// Invoked as `bash version.sh`, not as ./version.sh: executing it directly relies on the shebang
// and the exec bit, and Windows honours neither (git checks out mode 100755 as a plain file).
const next = (bump, current) =>
  execFileSync('bash', [SCRIPT, '--next', bump, ...(current ? [current] : [])], { encoding: 'utf8' }).trim();

test('a minor below the cap still just increments — the cap must not fire early', { skip: needBash }, () => {
  // The control for every rollover assertion below: if the cap fired on every minor bump these
  // would read 3.0.0 too, and the rollover tests would pass while the rule was wrong.
  assert.equal(next('minor', '2.0.0'), '2.1.0');
  assert.equal(next('minor', '2.97.3'), '2.98.0');
  assert.equal(next('minor', '2.98.4'), '2.99.0', '99 is reachable — the cap is a ceiling, not a limit of 98');
});

test('a minor AT the cap becomes the next major', { skip: needBash }, () => {
  assert.equal(next('minor', '2.99.0'), '3.0.0');
  assert.equal(next('minor', '2.99.7'), '3.0.0', 'the patch number does not change the rollover');
  assert.equal(next('minor', '9.99.0'), '10.0.0', 'the major itself is not capped');
});

test('a minor that is ALREADY past the cap is pulled back into line', { skip: needBash }, () => {
  // How the rule arrived: the minor had reached 110. The next minor release must be 3.0.0, not
  // 2.111.0 — otherwise the version stays illegal for ever and the cap only applies to versions
  // that never needed it.
  assert.equal(next('minor', '2.110.1'), '3.0.0');
  assert.equal(next('minor', '2.100.0'), '3.0.0');
});

test('major and patch bumps are untouched by the cap', { skip: needBash }, () => {
  assert.equal(next('major', '2.99.0'), '3.0.0');
  assert.equal(next('major', '2.4.9'), '3.0.0');
  assert.equal(next('patch', '2.99.5'), '2.99.6');
  assert.equal(next('patch', '2.110.1'), '2.110.2', 'a patch is never silently promoted to a release it is not');
  assert.equal(next('minor', '3.0.0'), '3.1.0', 'and counting resumes normally after a rollover');
});

test('--next changes nothing: no version written, no commit, no tag', { skip: needBash }, () => {
  // R14: a dry-run that quietly bumped would make every assertion above a side effect, and the
  // suite would rewrite the project's version 20 times a run.
  const before = fs.readFileSync(path.join(REPO, 'package.json'), 'utf8');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
  const tags = execFileSync('git', ['tag'], { cwd: REPO, encoding: 'utf8' });
  next('minor', '2.99.0'); next('major'); next('patch');
  assert.equal(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'), before, 'package.json untouched');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim(), head, 'no commit');
  assert.equal(execFileSync('git', ['tag'], { cwd: REPO, encoding: 'utf8' }), tags, 'no tag');
});

test('with no version given it reads the real package.json — the shipped path, same rule', { skip: needBash }, () => {
  // The form the release actually uses. Pinned to agree with the explicit form so the two cannot
  // drift into different arithmetic.
  const cur = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  for (const bump of ['major', 'minor', 'patch']) assert.equal(next(bump), next(bump, cur), bump);
});
