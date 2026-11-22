// Automatic versioning · 自动版本 — lib/version-auto.mjs (docs/adr/0026). The sheet said
// "v5.0.0 · current" for a month of merges because nobody tags on every merge; now the version
// names itself 'v<pkg>+<N>' from the git history, and the shell footer shows the SAME N.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mergeItem, uncachedAutoSince, autoSince, autoEntry, autoKey, AUTO_MARK } from '../lib/version-auto.mjs';
import { ROOT } from './helpers-panote-routing.mjs';

const TAG = 'v5.0.0';
const LOG = '2026-11-10\tMerge: important notes — 重点 linked in AI summaries (branch note-important, one review round)\n'
  + '2026-11-09\tMerge: Claude sign-in resilience (branch claude-auth-resilience)\n'
  + '2026-11-08\tMerge: pin the × after a chip tap\n';
// An argv fake, same shape as the real exec (never a command string — see vernotes.test.mjs).
const fakeExec = ({ tag = TAG, log = LOG } = {}) => {
  const fn = (args) => {
    assert.ok(Array.isArray(args) && !args.includes('git'), 'argv array, git is the program');
    fn.calls.push(args.join(' '));
    if (args[0] === 'for-each-ref') { assert.ok(args.includes('--count=1'), 'only the newest tag is asked for'); return tag ? `${tag}\n` : ''; }
    if (args[0] === 'log') { assert.ok(args.includes('--merges') && args.includes('--first-parent') && args.includes(`${tag}..HEAD`), 'merges to main since the newest tag'); return log; }
    throw new Error(`unexpected git ${args[0]}`);
  };
  fn.calls = [];
  return fn;
};

test('mergeItem strips the "Merge: " head and the "(branch …)" tail, keeps bilingual text as written', () => {
  assert.equal(mergeItem('Merge: important notes — 重点 linked (branch note-important, one review round)'), 'important notes — 重点 linked');
  assert.equal(mergeItem('Merge: pin the × after a chip tap (branch search-clear-tags)'), 'pin the × after a chip tap');
  assert.equal(mergeItem('Merge: plain'), 'plain');
  assert.equal(mergeItem('feat(x): not a merge'), 'feat(x): not a merge');
});

test('fixture log → entry shape: N = merges since the tag, dated from the newest, items newest first', () => {
  const since = uncachedAutoSince('/r', fakeExec());
  assert.deepEqual(since, { tag: TAG, n: 3, date: '2026-11-10',
    items: ['important notes — 重点 linked in AI summaries', 'Claude sign-in resilience', 'pin the × after a chip tap'] });
  const e = autoEntry('5.0.0', since);
  assert.equal(e.key, 'v5.0.0+3');
  assert.equal(autoKey('5.0.0', 3), e.key);
  assert.deepEqual(e.entry, { date: '2026-11-10', features: since.items, fixes: [], auto: AUTO_MARK });
  assert.equal(AUTO_MARK, 'auto · 自动', 'the badge the sheet shows beside "current · 当前"');
});

test('N = 0, no tag, or no git → no auto entry (never a "+0", never a throw)', () => {
  assert.equal(autoEntry('5.0.0', uncachedAutoSince('/r', fakeExec({ log: '' }))), null, 'nothing merged since the tag');
  assert.equal(autoEntry('5.0.0', uncachedAutoSince('/r', fakeExec({ tag: '' }))), null, 'a repo with no tag has nothing to count from');
  assert.equal(autoEntry('5.0.0', uncachedAutoSince('/r', () => { throw new Error('no git'); })), null, 'no git: the curated notes alone');
});

test('autoSince caches by HEAD and tag: the same HEAD never runs the log twice, a new merge (new HEAD) recounts without a restart', () => {
  const exec = fakeExec();
  const a = autoSince('/cache-root', 'head-1', exec);
  autoSince('/cache-root', 'head-1', exec);
  assert.deepEqual(exec.calls.filter((c) => c.startsWith('log ')).length, 1, 'one log for a HEAD, then the cache answers');
  assert.equal(exec.calls.filter((c) => c.startsWith('for-each-ref')).length, 2, 'the cheap tag lookup runs per call (it is the key)');
  assert.equal(a.n, 3);
  const exec2 = fakeExec({ log: LOG + '2026-11-11\tMerge: a fourth (branch x)\n' });
  const b = autoSince('/cache-root', 'head-2', exec2);
  assert.equal(b.n, 4, 'the key moved with HEAD, so the new merge is counted');
  assert.equal(exec2.calls.length, 2);
});

test('a new tag on the same HEAD moves the key: N drops to 0 without a restart', () => {
  const exec = fakeExec();
  assert.equal(autoSince('/tag-root', 'head-9', exec).n, 3);
  const tagged = fakeExec({ tag: 'v5.1.0', log: '' });
  const after = autoSince('/tag-root', 'head-9', tagged);
  assert.equal(after.tag, 'v5.1.0');
  assert.equal(after.n, 0, 'the tag now sits on HEAD: nothing is "since"');
  assert.equal(tagged.calls.filter((c) => c.startsWith('log ')).length, 1, 'a miss, so the log ran for the new key');
});

test('on this repo: N counts exactly the first-parent merges since the newest tag (same number as git says)', () => {
  const since = uncachedAutoSince(ROOT);
  if (!since.tag) return;   // a tarball checkout has no tags: nothing to compare against; the shape tests above still ran
  const n = execFileSync('git', ['rev-list', '--merges', '--first-parent', '--count', `${since.tag}..HEAD`], { cwd: ROOT, encoding: 'utf8' }).trim();
  assert.equal(String(since.n), n);
  assert.ok(since.items.every((s) => !/^Merge:/.test(s) && !/\(branch /.test(s)), 'every item is a reader-facing title');
});
