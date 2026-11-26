// Automatic version bump · 自动升级版本 — lib/version-bump.mjs + tools/bump-version.mjs (docs/adr/0038).
// Scar: package.json said 5.0.0 for six weeks of merges because a bump was a human act.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { nextVersion, classifyBranch, planReleases, applyReleases, UPKEEP_ITEM } from '../lib/version-bump.mjs';
import { run } from '../tools/bump-version.mjs';
import { autoSince } from '../lib/version-auto.mjs';
import { needBash } from './helpers-platform.mjs';
import { ROOT } from './helpers-panote-routing.mjs';

test('bump rules: feat → minor, fix/other → patch, type! → major; internal-only branches are flagged', () => {
  assert.deepEqual(classifyBranch(['fix(x): a', 'feat(y): b']), { level: 'minor', internal: false });
  assert.deepEqual(classifyBranch(['fix(x): a', 'test: b']), { level: 'patch', internal: false });
  assert.deepEqual(classifyBranch(['feat(api)!: drop v1']), { level: 'major', internal: false });
  assert.deepEqual(classifyBranch(['ci: x', 'test(y): z']), { level: 'patch', internal: true });
  assert.equal(nextVersion('5.0.0', 'patch'), '5.0.1');
  assert.equal(nextVersion('5.0.3', 'minor'), '5.1.0');
  assert.equal(nextVersion('5.4.3', 'major'), '6.0.0');
  assert.equal(nextVersion('5.99.2', 'minor'), '6.0.0', 'minor cap at 99, as version.sh');
});

test('the minor cap agrees with the real version.sh --next (one rule, R3)', { skip: needBash }, () => {
  for (const [lvl, cur] of [['minor', '2.98.4'], ['minor', '2.99.0'], ['patch', '2.3.4'], ['major', '2.3.4']]) {
    const sh = execFileSync('bash', [path.join(ROOT, 'version.sh'), '--next', lvl, cur], { encoding: 'utf8' }).trim();
    assert.equal(nextVersion(cur, lvl), sh, `${lvl} from ${cur}`);
  }
});

const M = (sha, date, subject, branch) => ({ sha, date, subject, branch });
test('notes generation: one entry per day, strongest merge sets the bump, items are merge titles newest first', () => {
  const rel = planReleases('5.0.0', [
    M('a1', '2026-11-21', 'Merge: CI green (branch ci-x)', ['ci: y']),
    M('b1', '2026-11-22', 'Merge: tap fix', ['fix(t): z']),
    M('b2', '2026-11-22', 'Merge: demo waiting list · 候补名单', ['feat(demo): w', 'test: v']),
  ]);
  assert.deepEqual(rel, [
    { version: '5.0.1', entry: { date: '2026-11-21', features: [], fixes: [UPKEEP_ITEM], through: 'a1' } },
    { version: '5.1.0', entry: { date: '2026-11-22', features: ['demo waiting list · 候补名单'], fixes: ['tap fix'], through: 'b2' } },
  ]);
  const notes = applyReleases({ 'v5.0.0': { date: '2026-10-12', features: ['x'], fixes: [] } }, rel);
  assert.deepEqual(Object.keys(notes), ['v5.1.0', 'v5.0.1', 'v5.0.0'], 'newest first, curated history kept');
});

// A throwaway repo: base tag, two merges, the tool run twice.
function repo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bump-'));
  const g = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ version: '5.0.0' }));
  fs.writeFileSync(path.join(d, 'version-notes.json'), JSON.stringify({ 'v5.0.0': { date: '2026-10-12', features: ['old'], fixes: [] } }));
  g('add', '.'); g('commit', '-qm', 'base'); g('tag', 'v5.0.0');
  const merge = (br, msg, title) => { g('checkout', '-qb', br); fs.writeFileSync(path.join(d, br), br); g('add', '.'); g('commit', '-qm', msg); g('checkout', '-q', 'main'); g('merge', '-q', '--no-ff', br, '-m', title); };
  merge('b1', 'fix(x): one', 'Merge: first fix');
  merge('b2', 'feat(y): two', 'Merge: a feature');
  return { d, g, merge };
}

test('tool: --check refuses with the fix command, the bump writes both files, a second run changes nothing', () => {
  const { d, g, merge } = repo();
  try {
    const chk = run(d, ['--check']);
    assert.equal(chk.code, 1); assert.match(chk.out, /2 merge\(s\) since v5\.0\.0/); assert.match(chk.out, /node tools\/bump-version\.mjs/);
    assert.equal(run(d, []).out, 'v5.1.0');
    const notes = JSON.parse(fs.readFileSync(path.join(d, 'version-notes.json'), 'utf8'));
    assert.deepEqual(Object.keys(notes), ['v5.1.0', 'v5.0.0']);
    assert.deepEqual(notes['v5.1.0'].features, ['a feature']); assert.deepEqual(notes['v5.1.0'].fixes, ['first fix']);
    assert.match(notes['v5.1.0'].time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'the release time, UTC ISO (shown in the footer, lib/version-time.mjs)');
    const snap = () => fs.readFileSync(path.join(d, 'package.json'), 'utf8') + fs.readFileSync(path.join(d, 'version-notes.json'), 'utf8');
    g('commit', '-qam', 'release: v5.1.0');   // the ship flow's direct commit on main is not a merge
    const s1 = snap();
    assert.equal(run(d, []).out, 'v5.1.0 (nothing new)');
    assert.equal(snap(), s1, 'idempotent');
    assert.equal(run(d, ['--check']).code, 0);
    assert.equal(autoSince(d, 'h1').n, 0, 'the footer +N counts from the same release (R3)');
    merge('b3', 'fix(z): three', 'Merge: later fix');
    assert.equal(run(d, ['--check']).code, 1, 'a new merge is caught');
    assert.equal(autoSince(d, 'h2').n, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('git failure is loud, never "nothing new" (R14)', () => {
  const { d } = repo();
  try {
    assert.throws(() => run(d, ['--check'], (a) => { if (a[0] === 'log') throw new Error('boom'); return 'v5.0.0\n'; }), /cannot list merges/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// GPT review round 1 (2026-11-23): each case below once passed --check or mis-bumped.
test('a BREAKING CHANGE footer is major; a subject that only mentions it is not', () => {
  assert.equal(classifyBranch([{ subject: 'fix(x): a', body: 'why\n\nBREAKING CHANGE: drops v1\n' }]).level, 'major');
  assert.equal(classifyBranch(['fix: explain BREAKING CHANGE wording']).level, 'patch');
});

test('dates A, B, A keep `through` in first-parent order (never moves back)', () => {
  const rel = planReleases('5.0.0', [M('1', '2026-11-22', 'Merge: a', ['fix: a']), M('2', '2026-11-21', 'Merge: b', ['fix: b']), M('3', '2026-11-22', 'Merge: c', ['fix: c'])]);
  assert.deepEqual(rel.map((r) => r.entry.through), ['1', '2', '3']);
});

test('--check refuses: no release base, an uncommitted bump, a half-written bump', () => {
  const { d, g } = repo();
  try {
    assert.throws(() => run(d, ['--check'], (a) => (a[0] === 'for-each-ref' ? '' : '')), /no release base/);
    run(d, []);
    const unc = run(d, ['--check']);
    assert.equal(unc.code, 1); assert.match(unc.out, /uncommitted/);
    g('commit', '-qam', 'release');
    assert.equal(run(d, ['--check']).code, 0);
    const pf = path.join(d, 'package.json');
    fs.writeFileSync(pf, JSON.stringify({ version: '5.0.0' })); g('commit', '-qam', 'half');   // crash after notes
    const half = run(d, ['--check']);
    assert.equal(half.code, 1); assert.match(half.out, /!= newest release v5\.1\.0/);
    assert.equal(run(d, []).out, 'v5.1.0', 'a re-run finishes the bump, no double bump');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('pre-push hook runs --check for a push to remote main from another branch', { skip: needBash }, () => {
  const { d, g } = repo();
  try {
    fs.mkdirSync(path.join(d, 'tools'));
    for (const f of ['pre-push.sh', 'bump-version.mjs']) fs.copyFileSync(path.join(ROOT, 'tools', f), path.join(d, 'tools', f));
    fs.symlinkSync(path.join(ROOT, 'lib'), path.join(d, 'lib'));
    g('checkout', '-qb', 'other');
    const head = g('rev-parse', 'HEAD').trim();
    let err = '';
    try { execFileSync('sh', [path.join(d, 'tools/pre-push.sh'), 'origin'], { cwd: d, input: `refs/heads/other ${head} refs/heads/main ${'0'.repeat(40)}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { err = String(e.stderr); }
    assert.match(err, /not in the release notes/);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
