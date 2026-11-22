// Rule A（冲突规则 A）, web/offline-merge.js via lib/offline-merge.mjs (the same file the shell
// inlines), docs/plans/offline-first.md §4/§7: one-side page, both-side page (the loser as a copy
// page with the right heading), same page same bytes (no copy), a page changed on one side
// only against the base (no copy), a deletion honoured against the base, tombstone vs edit, the
// index per entry id, and mergeOffline's "the node did not move" short-cut.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeNotebook, mergeIndex, mergeOffline, mergeTitle, OFF_CONFLICT_TITLE, OFF_FROM_LOCAL, OFF_FROM_REMOTE } from '../lib/offline-merge.mjs';

const page = (id, updated, html = '') => ({ id, created: 1, updated, strokes: [], pageHtml: html, images: [] });
const nb = (updated, pages, extra = {}) => ({ v: 3, id: 'n1', created: 1, updated, template: 'plain', pages, ...extra });
const ids = (r) => r.nb.pages.map((p) => p.id);
let n = 0; const newId = () => `c${++n}`;

test('a page on one side only is kept on either side; the newer notebook keeps its order', () => {
  const base = nb(10, [page('a', 10)]);
  const local = nb(30, [page('a', 10), page('l', 30)]);
  const remote = nb(20, [page('r', 20), page('a', 10)]);
  const r = mergeNotebook(local, remote, base, { newId });
  assert.deepEqual(ids(r), ['a', 'l', 'r'], 'local is newer: its order first, then the remote-only page');
  assert.equal(r.copies, 0);
  assert.equal(r.nb.updated, 30);
  assert.equal(r.nb.template, 'plain');
});

test('both sides changed the same page: the later updated wins, the loser is appended as a conflict copy with the heading', () => {
  const base = nb(10, [page('a', 10, '<p>base</p>')]);
  const local = nb(40, [page('a', 40, '<p>mine</p>')]);
  const remote = nb(35, [page('a', 35, '<p>theirs <b>&</b></p>')]);
  const r = mergeNotebook(local, remote, base, { newId });
  assert.deepEqual(ids(r), ['a', 'c1']);
  assert.equal(r.copies, 1);
  assert.equal(r.nb.pages[0].pageHtml, '<p>mine</p>', 'the winner is the local page');
  const copy = r.nb.pages[1];
  assert.equal(copy.updated, 35, 'the copy keeps the loser\'s stamp');
  const title = mergeTitle(OFF_FROM_REMOTE, 35);
  assert.equal(copy.pageHtml, `<p><b>${title}</b></p><p>theirs <b>&</b></p>`, 'headed, then the loser\'s own text untouched');
  assert.match(title, /^Conflict copy · 冲突副本 \(home node · 家中节点, \d\d-\d\d \d\d:\d\d\)$/);
  assert.equal(OFF_CONFLICT_TITLE, 'Conflict copy · 冲突副本');
  // The other way round: the node's page is newer, the iPad's edit becomes the copy.
  const r2 = mergeNotebook(nb(40, [page('a', 36)]), nb(50, [page('a', 50)]), base, { newId });
  assert.equal(r2.nb.pages[0].updated, 50);
  assert.match(r2.nb.pages[1].pageHtml, new RegExp(`^<p><b>Conflict copy · 冲突副本 \\(${OFF_FROM_LOCAL}, `));
});

test('same page, same bytes: one page, no copy; changed on one side only (the other equals the base byte for byte): that side, no copy', () => {
  const base = nb(10, [page('a', 10, 'old'), page('b', 10, 'old')]);
  const same = mergeNotebook(nb(30, [page('a', 10, 'old'), page('b', 10, 'old')]), nb(20, [page('a', 10, 'old'), page('b', 10, 'old')]), base, { newId });
  assert.deepEqual(ids(same), ['a', 'b']); assert.equal(same.copies, 0);
  // Page a changed on the node only (local still the base's bytes); page b changed here only.
  const r = mergeNotebook(nb(30, [page('a', 10, 'old'), page('b', 30, 'mine')]), nb(50, [page('a', 50, 'theirs'), page('b', 10, 'old')]), base, { newId });
  assert.equal(r.copies, 0, 'no copy: each page changed on one side only');
  assert.deepEqual(r.nb.pages.map((p) => [p.id, p.pageHtml]), [['a', 'theirs'], ['b', 'mine']]);
});

test('without a base every same-id difference is a both-side change: a copy rather than a silent loss', () => {
  const r = mergeNotebook(nb(30, [page('a', 30)]), nb(50, [page('a', 50)]), null, { newId });
  assert.equal(r.copies, 1);
  assert.deepEqual(ids(r).length, 2);
});

test('deletion against the base: a page gone on one side and untouched on the other since the base goes; an edited one stays', () => {
  const base = nb(10, [page('a', 10), page('b', 10), page('c', 10)]);
  // The iPad deleted a and edited b; the node deleted c and left a and b alone.
  const local = nb(30, [page('b', 30)]);
  const remote = nb(20, [page('a', 10), page('b', 10)]);
  const r = mergeNotebook(local, remote, base, { newId });
  assert.deepEqual(ids(r), ['b'], 'a: deleted here, untouched there → gone; c: deleted there, untouched here → gone; b: edited here → kept');
  assert.equal(r.nb.pages[0].updated, 30);
  // An edit beats a deletion: the node edited a after this device deleted it.
  const r2 = mergeNotebook(nb(30, [page('b', 30)]), nb(40, [page('a', 40), page('b', 10)]), base, { newId });
  assert.deepEqual(ids(r2), ['a', 'b']);
});

test('tombstone vs edit: the edit wins both ways; two tombstones stay a tombstone', () => {
  const base = nb(10, [page('a', 10)]);
  const tomb = { v: 1, deleted: true };
  const edited = nb(40, [page('a', 40)]);
  assert.deepEqual(mergeNotebook(tomb, edited, base, { newId }).nb, edited, 'deleted here, edited on the node: the note comes back');
  assert.deepEqual(mergeNotebook(edited, tomb, base, { newId }).nb, edited, 'edited here, deleted on the node: the edit stands');
  assert.deepEqual(mergeNotebook(tomb, { v: 1, deleted: true, updated: 5 }, base, { newId }).nb, tomb);
});

test('the index merges per entry id: union, the later updated per row, deletions honoured, no copies', () => {
  const e = (id, updated, title) => ({ id, updated, title });
  const base = { v: 1, entries: [e('x', 10, 'x0'), e('y', 10, 'y0'), e('z', 10, 'z0')] };
  const local = { v: 1, entries: [e('n', 40, 'new here'), e('x', 30, 'x here'), e('y', 10, 'y0')] };   // z deleted here
  const remote = { v: 1, entries: [e('m', 25, 'new there'), e('x', 20, 'x there'), e('y', 10, 'y0'), e('z', 10, 'z0')] };
  const r = mergeIndex(local, remote, base);
  assert.deepEqual(r.entries.map((x) => [x.id, x.title]), [['n', 'new here'], ['x', 'x here'], ['y', 'y0'], ['m', 'new there']]);
  assert.equal(r.v, 1);
});

test('mergeOffline: the node unchanged since the base → the local text as it is; moved → merged; neither shape → local (LWW by file); unreadable → throws with context', () => {
  const base = JSON.stringify(nb(10, [page('a', 10)]));
  const local = JSON.stringify(nb(30, [page('a', 30)]));
  assert.deepEqual(mergeOffline(local, base, base), { text: local, merged: false }, 'same bytes');
  const sameStamp = JSON.stringify({ ...nb(10, [page('a', 10)]), extra: 1 });
  assert.equal(mergeOffline(local, sameStamp, base, { newId }).merged, true, 'the same updated stamp with other bytes is a move: merged (review finding 3)');
  const moved = JSON.stringify(nb(50, [page('a', 50)]));
  const m = mergeOffline(local, moved, base, { newId });
  assert.equal(m.merged, true); assert.equal(m.kind, 'notebook'); assert.equal(m.copies, 1);
  assert.equal(JSON.parse(m.text).pages.length, 2);
  const noBase = mergeOffline(local, moved, null, { newId });
  assert.equal(noBase.merged, true, 'no base: always merged');
  const idx = mergeOffline('{"v":1,"entries":[{"id":"a","updated":2}]}', '{"v":1,"entries":[{"id":"b","updated":3}]}', null);
  assert.equal(idx.kind, 'index'); assert.equal(JSON.parse(idx.text).entries.length, 2);
  const file = mergeOffline('{"list":[1]}', '{"list":[2]}', null);
  assert.deepEqual(file, { text: '{"list":[1]}', merged: true, copies: 0, kind: 'file' });
  assert.throws(() => mergeOffline(local, 'not json', null), /cannot read the node file · 无法读取node文件/);
  assert.throws(() => mergeOffline('nope', moved, null), /cannot read the local file/);
});

// ── Review finding 3: an equal `updated` is only a fast path when the bytes are equal too.
test('regression: same stamp, different bytes → changed on both sides: the loser is a conflict copy, nothing is dropped', () => {
  const base = nb(10, [page('a', 10, 'base')]);
  // Both sides wrote page a without bumping its stamp (a stamp is a hint, the bytes are the truth).
  const r = mergeNotebook(nb(30, [page('a', 10, 'mine')]), nb(20, [page('a', 10, 'theirs')]), base, { newId });
  assert.equal(r.copies, 1, 'before the fix: one page, "theirs" silently gone');
  assert.deepEqual(r.nb.pages.map((p) => p.pageHtml.replace(/<p><b>[^<]*<\/b><\/p>/, 'COPY:')), ['mine', 'COPY:theirs'], 'the newer notebook\'s side wins the tie');
  // A page present on one side only, at the base\'s stamp but with other bytes, was edited: it stays.
  const kept = mergeNotebook(nb(30, [page('a', 10, 'edited, not stamped')]), nb(20, []), base, { newId });
  assert.deepEqual(ids(kept), ['a']);
  // CONTROL: equal bytes at an equal stamp are one page, no copy; a one-side page equal to the base goes.
  const same = mergeNotebook(nb(30, [page('a', 10, 'base')]), nb(20, [page('a', 10, 'base')]), base, { newId });
  assert.equal(same.copies, 0); assert.deepEqual(ids(same), ['a']);
  assert.deepEqual(ids(mergeNotebook(nb(30, [page('a', 10, 'base')]), nb(20, []), base, { newId })), []);
  // The file-level short-cut: equal bytes → not merged; the same stamp with other bytes → merged.
  const baseText = JSON.stringify(base), local = JSON.stringify(nb(30, [page('a', 30, 'mine')]));
  assert.equal(mergeOffline(local, baseText, baseText).merged, false);
  const m = mergeOffline(local, JSON.stringify(nb(10, [page('a', 10, 'theirs, not stamped')])), baseText, { newId });
  assert.equal(m.merged, true); assert.equal(m.copies, 1);
});

// ── Review finding 2: a tombstone loses only to a side that actually moved since the base.
test('regression: deleted here, the node unchanged since the base → the tombstone wins; moved → the edit wins; the same rule for a node tombstone', () => {
  const base = nb(10, [page('a', 10, 'base')]);
  const tomb = { v: 1, deleted: true };
  assert.deepEqual(mergeNotebook(tomb, base, base, { newId }).nb, tomb, 'before the fix the unchanged node file came back from the dead');
  assert.deepEqual(mergeNotebook(tomb, nb(10, [page('a', 10, 'edited, not stamped')]), base, { newId }).nb.pages.length, 1, 'other bytes at the base\'s stamp: the node moved, the note stays');
  assert.deepEqual(mergeNotebook(tomb, nb(40, [page('a', 40)]), base, { newId }).nb, nb(40, [page('a', 40)]), 'edited on the node: the note stays');
  assert.deepEqual(mergeNotebook(base, tomb, base, { newId }).nb, tomb, 'deleted on the node, untouched here: the tombstone wins');
  assert.deepEqual(mergeNotebook(nb(40, [page('a', 40)]), tomb, base, { newId }).nb, nb(40, [page('a', 40)]), 'edited here: the edit wins');
  assert.deepEqual(mergeNotebook(tomb, base, null, { newId }).nb, base, 'no base: unknown whether the node moved, so the note stays (a copy over a loss)');
  // Through mergeOffline with the texts the sync hands over.
  const t = JSON.stringify(tomb), b = JSON.stringify(base);
  assert.deepEqual(mergeOffline(t, b, b), { text: t, merged: false }, 'the same bytes: the short-cut posts the tombstone');
  assert.equal(JSON.parse(mergeOffline(t, JSON.stringify({ ...base, pages: base.pages }), b).text).deleted, true, 'rebuilt base bytes (key order kept): still the tombstone');
});
