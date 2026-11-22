import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripPrefix, classifySubjects, buildNotes, appNotesJson, embedInTemplateLiteral } from '../lib/vernotes.mjs';
import { rmTemp } from './helpers-tmp.mjs';

// Throwaway roots only (never the live repo/workspace)
const mkroot = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vernotes-'));
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
};

const TAGS = "v2.1.0\t2026-08-31\trelease: v2.1.0 — polish\nv2.0.0\t2026-08-30\trelease: v2.0.0 - milestone\n";
// The real exec takes an ARGV ARRAY, never a command string — POSIX single quotes are not
// quoting to cmd.exe, so lib/vernotes.mjs stopped building shell strings. The fake must take the
// same shape or it would keep passing against an interface that no longer exists
// (test-harness fidelity: a mock that is laxer than the real thing hides the break).
const fakeExec = (logByRange) => {
  const calls = [];
  const fn = (args) => {
    assert.ok(Array.isArray(args), 'exec must be called with an argv array, not a command string');
    assert.ok(!args.includes('git'), 'git is the program, not an argument');
    const cmd = args.join(' ');
    calls.push(cmd);
    if (cmd.includes('for-each-ref')) return TAGS;
    for (const [range, out] of Object.entries(logByRange)) if (cmd.includes(range)) return out;
    return '';
  };
  fn.calls = calls;
  return fn;
};

test('stripPrefix drops conventional type, keeps scope', () => {
  assert.equal(stripPrefix('feat(journal): photo insertion parity'), 'journal: photo insertion parity');
  assert.equal(stripPrefix('fix: race guard'), 'race guard');
  assert.equal(stripPrefix('docs(plan): add lane'), 'plan: add lane');
  assert.equal(stripPrefix('Merge branch main'), 'Merge branch main'); // no prefix → untouched
});

test('classifySubjects: fix→fixes, feat→features, release AND internal types dropped', () => {
  // CHANGED 2026-09-11. This sheet is read by a family member asking "what's new", not by a
  // developer reading a changelog. refactor/chore/docs/test/style/ci/build change nothing a
  // person can SEE — and `refactor` is defined by the house rules as having NO behaviour change,
  // so by its own definition it has nothing to show. They stay in git, where they belong.
  const { features, fixes } = classifySubjects([
    'release: v2.1.0 — polish',
    'feat(a): one',
    'fix(b): two',
    'refactor(c): three',
    'fix: four',
    'chore: five',
    'docs(plan): six',
    'test(x): seven',
  ]);
  assert.deepEqual(features, ['a: one'], 'only real features reach the sheet');
  assert.deepEqual(fixes, ['b: two', 'four'], 'fixes are unchanged, order kept');
});

test('a release with nothing user-visible says nothing — unless its note says otherwise', () => {
  // The two halves of the same rule. An internal-only release contributes no bullets; but if the
  // author wrote a release note on the tag, THAT is curation and still shows (see buildNotes).
  const internalOnly = classifySubjects(['docs: plan', 'test: coverage', 'refactor(x): tidy']);
  assert.deepEqual(internalOnly.features, []);
  assert.deepEqual(internalOnly.fixes, []);
});

test('buildNotes: curated content wins; empty seeded entry filled from git, date kept', () => {
  const root = mkroot({
    'package.json': '{"version":"2.1.0"}\n',
    'version-notes.json': JSON.stringify({
      'v2.1.0': { date: '2026-09-15', features: [], fixes: [] }, // seeded, empty → derive
      'v2.0.0': { date: '2026-08-30', features: ['curated feature'], fixes: [] }, // curated → wins
    }),
  });
  const exec = fakeExec({ 'v2.0.0..v2.1.0': 'release: v2.1.0 — polish\nfeat(x): thing\nfix(y): oops\n' });
  const notes = buildNotes(root, exec);
  assert.deepEqual(notes['v2.1.0'], { date: '2026-09-15', features: ['x: thing'], fixes: ['y: oops'] });
  assert.deepEqual(notes['v2.0.0'].features, ['curated feature']);
  rmTemp(root);
});

test('buildNotes: empty derived range falls back to tag note; git failure → curated only', () => {
  const root = mkroot({
    'package.json': '{"version":"2.1.0"}\n',
    'version-notes.json': JSON.stringify({ 'v0.9.0': { date: '2026-08-01', features: ['pre-tag note'], fixes: [] } }),
  });
  // Only the release commit in range → dropped → falls back to the tag subject's note part
  const notes = buildNotes(root, fakeExec({ 'v2.0.0..v2.1.0': 'release: v2.1.0 — polish\n' }));
  assert.deepEqual(notes['v2.1.0'].features, ['polish']);
  assert.ok(notes['v0.9.0']); // curated version without a tag still shows
  const broken = () => { throw new Error('no git'); };
  assert.deepEqual(Object.keys(buildNotes(root, broken)), ['v0.9.0']);
  rmTemp(root);
});

test('appNotesJson caches until version-notes.json or package version changes', () => {
  const root = mkroot({
    'package.json': '{"version":"2.1.0"}\n',
    'version-notes.json': '{}',
  });
  const exec = fakeExec({ 'v2.0.0..v2.1.0': 'feat(x): thing\n' });
  const first = appNotesJson(root, exec);
  assert.ok(JSON.parse(first)['v2.1.0']);
  const callsAfterFirst = exec.calls.length;
  appNotesJson(root, exec);
  assert.equal(exec.calls.length, callsAfterFirst, 'second request must hit the cache');
  // Curated edit → cache miss → rebuild picks up the new content, no restart needed
  fs.writeFileSync(path.join(root, 'version-notes.json'), JSON.stringify({ 'v2.1.0': { date: 'x', features: ['edited'], fixes: [] } }));
  assert.deepEqual(JSON.parse(appNotesJson(root, exec))['v2.1.0'].features, ['edited']);
  assert.ok(exec.calls.length > callsAfterFirst, 'notes edit must invalidate the cache');
  // Version bump (new tag flow) → cache miss again
  const callsAfterEdit = exec.calls.length;
  fs.writeFileSync(path.join(root, 'package.json'), '{"version":"2.2.0"}\n');
  appNotesJson(root, exec);
  assert.ok(exec.calls.length > callsAfterEdit, 'version bump must invalidate the cache');
  rmTemp(root);
});

test('embedInTemplateLiteral survives backticks, ${, backslash and </script>', () => {
  const nasty = { 'v1.0.0': { date: 'd', features: ['a `tick`', 'costs ${5}', 'path C:\\x', '</script><b>'], fixes: [] } };
  const embedded = embedInTemplateLiteral(JSON.stringify(nasty));
  assert.ok(!embedded.includes('</script'), 'must not be able to close the script tag');
  // Evaluate exactly as the browser does: JSON inside a back-tick literal
  const roundTrip = new Function('return JSON.parse(`' + embedded + '`);')();
  assert.deepEqual(roundTrip, nasty);
});

// ── Automatic entry (lib/version-auto.mjs, docs/adr/0026) ──────────────────────────────────────
// A fake that also answers the auto queries: the newest tag and the merges since it.
const fakeExecAuto = (logByRange, merges) => {
  const inner = fakeExec(logByRange);
  const fn = (args) => {
    if (args[0] === 'for-each-ref' && args.includes('--count=1')) { inner.calls.push(args.join(' ')); return 'v2.1.0\n'; }
    if (args[0] === 'log' && args.includes('--merges')) { inner.calls.push(args.join(' ')); return merges; }
    return inner(args);
  };
  fn.calls = inner.calls;
  return fn;
};

test('buildNotes: merges since the newest tag add "v<pkg>+<N>" FIRST, flagged auto, the tag entries unchanged after it', () => {
  const root = mkroot({ 'package.json': '{"version":"2.1.0"}\n', 'version-notes.json': '{}' });
  const exec = fakeExecAuto({ 'v2.0.0..v2.1.0': 'feat(x): thing\n' },
    '2026-11-10\tMerge: newer thing (branch b, one review round)\n2026-11-09\tMerge: older thing (branch a)\n');
  const notes = buildNotes(root, exec, 'head-a');
  assert.deepEqual(Object.keys(notes), ['v2.1.0+2', 'v2.1.0', 'v2.0.0']);
  assert.deepEqual(notes['v2.1.0+2'], { date: '2026-11-10', features: ['newer thing', 'older thing'], fixes: [], auto: 'auto · 自动' });
  assert.deepEqual(notes['v2.1.0'].features, ['x: thing'], 'the tag entry is as before');
  assert.deepEqual(Object.keys(buildNotes(root, fakeExecAuto({ 'v2.0.0..v2.1.0': 'feat(x): thing\n' }, ''), 'head-b')), ['v2.1.0', 'v2.0.0'], 'N = 0 → no auto entry');
  rmTemp(root);
});

test('appNotesJson: the cache key moves with HEAD, so a new merge shows without a restart', () => {
  const root = mkroot({ 'package.json': '{"version":"2.1.0"}\n', 'version-notes.json': '{}' });
  const exec = fakeExecAuto({ 'v2.0.0..v2.1.0': 'feat(x): thing\n' }, '2026-11-10\tMerge: one (branch a)\n');
  assert.ok(JSON.parse(appNotesJson(root, exec, 'head-1'))['v2.1.0+1']);
  const calls = exec.calls.length;
  appNotesJson(root, exec, 'head-1');
  assert.equal(exec.calls.length, calls, 'same HEAD: the cache answers');
  const exec2 = fakeExecAuto({ 'v2.0.0..v2.1.0': 'feat(x): thing\n' }, '2026-11-11\tMerge: two (branch b)\n2026-11-10\tMerge: one (branch a)\n');
  const after = JSON.parse(appNotesJson(root, exec2, 'head-2'));
  assert.ok(after['v2.1.0+2'] && !after['v2.1.0+1'], 'a new HEAD rebuilds: +2 replaces +1');
  rmTemp(root);
});
