// Screenshot freshness for both chat cameras (web/snap.inline.html PA_SHOT_FRESH block), and the PASnap fix for
// pages whose HTML comments hold "--" (fatal in the XML the picture is drawn from: Sunday Study, Bible).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const panel = fs.readFileSync(new URL('../web/snap.inline.html', import.meta.url), 'utf8');   // PAShotFresh lives with PASnap: both composers share it
const block = /\/\* ══ PA_SHOT_FRESH_BEGIN[\s\S]*?\*\/([\s\S]*?)\/\* ══ PA_SHOT_FRESH_END/.exec(panel)[1];
const ctx = {}; vm.runInNewContext(block + ';this.F=PAShotFresh;', ctx);
const F = ctx.F;
const s = (path, gen, mine = true) => ({ path, gen, mine });

test('a shot of ours from before the last reload is stale; the user\'s own photo never is', () => {
  assert.deepEqual([...F.stale([s('a', 0), s('b', 1), s('p', 0, false)], 1)], ['a']);
  assert.deepEqual([...F.stale([s('a', 2)], 2)], [], 'nothing changed: nothing retaken');
});
test('a new camera shot drops the stale ones, then the oldest of ours beyond 3', () => {
  assert.deepEqual([...F.makeRoom([s('a', 0), s('b', 1)], 1)], ['a']);
  assert.deepEqual([...F.makeRoom([s('a', 1), s('b', 1), s('c', 1)], 1)], ['a'], 'the 4th makes room by dropping the oldest');
  assert.deepEqual([...F.makeRoom([s('a', 1), s('p', 1, false)], 1)], [], 'room left: nothing dropped');
  assert.equal(F.MAX, 3);
});
test('the thumbnail label is the local time it was taken', () => {
  assert.equal(F.label(new Date(2026, 10, 24, 9, 5, 7).getTime()), '09:05:07');
});
test('PASnap drops HTML comments before it serializes the page as XML', () => {
  const snap = fs.readFileSync(new URL('../web/snap.inline.html', import.meta.url), 'utf8');
  assert.match(snap, /function stripComments\(root\)/);
  assert.ok(snap.indexOf('stripComments(clone)') > snap.indexOf("clone.querySelectorAll('script,iframe,noscript')"), 'stripped from the clone, before serializing');
});
