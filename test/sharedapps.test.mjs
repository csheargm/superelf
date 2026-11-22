import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileManifest, promote, rollback, unshare, listShared, versionsOf, fork } from '../lib/sharedapps.mjs';
import { rmTemp } from './helpers-tmp.mjs';

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sh-'));
  const shared = path.join(root, 'shared');
  const mia = path.join(root, 'mia', 'vocab');
  fs.mkdirSync(mia, { recursive: true });
  fs.writeFileSync(path.join(mia, 'index.html'), '<h1>v1</h1>');
  fs.writeFileSync(path.join(mia, 'meta.json'), '{"title":"Vocab"}');
  return { root, shared, mia };
}

test('promote publishes with sharedBy, visible to all', () => {
  const { shared, mia } = setup();
  promote(shared, 'vocab', mia, 'mia');
  const l = listShared(shared);
  assert.equal(l[0].title, 'Vocab');
  assert.equal(l[0].sharedBy, 'mia');
  assert.equal(l[0].versions, 0);
});

test('re-promote archives old; rollback restores and is reversible', () => {
  const { shared, mia } = setup();
  promote(shared, 'vocab', mia, 'mia');
  fs.writeFileSync(path.join(mia, 'index.html'), '<h1>v2</h1>');
  promote(shared, 'vocab', mia, 'mia');
  assert.equal(versionsOf(shared, 'vocab').length, 1);
  assert.match(fs.readFileSync(path.join(shared, 'vocab', 'index.html'), 'utf8'), /v2/);
  rollback(shared, 'vocab');
  assert.match(fs.readFileSync(path.join(shared, 'vocab', 'index.html'), 'utf8'), /v1/);
  rollback(shared, 'vocab'); // reversible
  assert.match(fs.readFileSync(path.join(shared, 'vocab', 'index.html'), 'utf8'), /v2/);
});

test('unshare archives, does not destroy', () => {
  const { shared, mia } = setup();
  promote(shared, 'vocab', mia, 'mia');
  unshare(shared, 'vocab');
  assert.equal(listShared(shared).length, 0);
  assert.equal(versionsOf(shared, 'vocab').length, 1);
});

test('promote strips symlinks', () => {
  const { root, shared, mia } = setup();
  fs.writeFileSync(path.join(root, 'secret'), 'x');
  fs.symlinkSync(path.join(root, 'secret'), path.join(mia, 'leak'));
  promote(shared, 'vocab', mia, 'mia');
  assert.ok(!fs.existsSync(path.join(shared, 'vocab', 'leak')));
});

test('fork copies for private edit, records forkedFrom, second gets -mine', () => {
  const { root, shared, mia } = setup();
  promote(shared, 'vocab', mia, 'mia');
  const dad = path.join(root, 'dad');
  assert.equal(fork(shared, 'vocab', dad), 'vocab');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dad, 'vocab', 'meta.json'), 'utf8')).forkedFrom, 'vocab');
  assert.equal(fork(shared, 'vocab', dad), 'vocab-mine');
});

test('bad slugs rejected', () => {
  const { shared } = setup();
  assert.throws(() => promote(shared, '../x', '/tmp', 'a'), /bad slug/);
  assert.throws(() => fork(shared, '..', '/tmp'), /bad slug/);
});

// Guard: conversation deletion must be recoverable (tombstone), not destructive.
// (Mirrors the web.mjs DELETE handler behavior so a regression is caught.)
test('convo delete tombstones into .trash instead of obliterating', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-cv-'));
  const convos = path.join(root, 'conversations');
  fs.mkdirSync(convos, { recursive: true });
  const f = path.join(convos, 'abc123.json');
  fs.writeFileSync(f, '{"id":"abc123","messages":[{"role":"me","text":"keep me"}]}');
  // simulate the handler
  const trash = path.join(convos, '.trash');
  fs.mkdirSync(trash, { recursive: true });
  fs.renameSync(f, path.join(trash, `1-${path.basename(f)}`));
  assert.ok(!fs.existsSync(f), 'live file moved');
  const recovered = fs.readdirSync(trash)[0];
  assert.match(fs.readFileSync(path.join(trash, recovered), 'utf8'), /keep me/, 'recoverable from trash');
  // listing (json-in-root only) must ignore .trash
  assert.equal(fs.readdirSync(convos).filter((n) => n.endsWith('.json')).length, 0);
});

test('a promote stamps a RELEASE, not just an author', () => {
  // It used to write only `sharedBy`. That left the shelf copy carrying whatever `shared` flag the
  // source happened to have — bible's said FALSE, and listShared forced it true at read time,
  // hiding the fault — with no version and no gitRef, so /changelog had nothing to diff and the
  // update check had nothing to compare against.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sh-'));
  try {
    const src = path.join(d, 'src'); fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'index.html'), '<h1>v1</h1>');
    fs.writeFileSync(path.join(src, 'meta.json'), JSON.stringify({ title: 'Bible', shared: false }));
    const shared = path.join(d, 'shared');
    const m = promote(shared, 'bible', src, 'owner', { gitRef: 'abc123' });
    assert.equal(m.shared, true, 'a shelf copy IS shared — the source flag must not survive');
    assert.equal(m.sharedBy, 'owner');
    assert.equal(m.version, '1.0.0', 'an unversioned source gets a first version');
    assert.equal(m.gitRef, 'abc123', 'passed in, not shelled out for');
    assert.ok(m.promotedAt && m.promotedFrom && m.promotedFrom.slug === 'bible');
    // On disk too, not just in the return value.
    const onDisk = JSON.parse(fs.readFileSync(path.join(shared, 'bible', 'meta.json'), 'utf8'));
    assert.equal(onDisk.shared, true);
    assert.deepEqual(Object.keys(onDisk.files), ['index.html'], 'and a per-file fingerprint');
  } finally { rmTemp(d); }
});

test('the manifest sees EVERY file, not just index.html', () => {
  // The old fingerprint was sha1(index.html) alone, so a multi-file app could not be told apart
  // from its own fork, and an upstream change to a sibling file was invisible.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sh-'));
  try {
    fs.mkdirSync(path.join(d, 'a', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(d, 'a', 'index.html'), 'x');
    fs.writeFileSync(path.join(d, 'a', 'app.css'), 'y');
    fs.writeFileSync(path.join(d, 'a', 'sub', 'data.js'), 'z');
    fs.writeFileSync(path.join(d, 'a', 'meta.json'), '{}');
    const man = fileManifest(path.join(d, 'a'));
    // 'sub/data.js' on EVERY OS: a manifest key is not a filesystem path (lib/sharedapps.mjs).
    assert.deepEqual(Object.keys(man).sort(), ['app.css', 'index.html', 'sub/data.js'].sort());
    assert.ok(!('meta.json' in man), 'meta.json carries the manifest, so it cannot be in it');
    // A CONTROL: change one sibling file and the manifest must move.
    const before = man['app.css'];
    fs.writeFileSync(path.join(d, 'a', 'app.css'), 'changed');
    assert.notEqual(fileManifest(path.join(d, 'a'))['app.css'], before);
  } finally { rmTemp(d); }
});

test('two archives in the same millisecond do not collide', () => {
  // archive() renames the live dir into .versions/<slug>/<stamp>-<why>. With millisecond-only
  // stamps, promote-then-rollback (or two rollbacks) landed on the same name and the rename failed
  // with ENOTEMPTY, aborting half-done. Measured before the fix: 3 failures in 6 runs of this file.
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-sh-'));
  try {
    const src = path.join(d, 'src'); fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'index.html'), '<h1>a</h1>');
    const shared = path.join(d, 'shared');
    // Three promotes back to back — as fast as the machine allows, which is the failing case.
    promote(shared, 'app', src, 'owner');
    fs.writeFileSync(path.join(src, 'index.html'), '<h1>b</h1>'); promote(shared, 'app', src, 'owner');
    fs.writeFileSync(path.join(src, 'index.html'), '<h1>c</h1>'); promote(shared, 'app', src, 'owner');
    assert.equal(versionsOf(shared, 'app').length, 2, 'both superseded versions were kept, neither overwrote the other');
    // And rollback still works twice running, which is the other collision path.
    rollback(shared, 'app');
    rollback(shared, 'app');
    assert.ok(fs.existsSync(path.join(shared, 'app', 'index.html')), 'the app survived both rollbacks');
  } finally { rmTemp(d); }
});
