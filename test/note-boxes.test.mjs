// lib/note-boxes.mjs + the phase 3 half of the matcher: a hit carries the page boxes of the OCR lines
// that hold the query, in page coordinates (x, y, w, h in page widths), and the query's terms.
// Synthetic records only (test/helpers-note.mjs rec).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { INK_MIN_H, INK_PAD, INK_MAX_H, BOXES_MAX, inkRatio, sortedImages, pageGeo, pageBox, dedupeBoxes } from '../lib/note-boxes.mjs';
import { imagePaths, buildFileRecords, applyOcr } from '../lib/note-index.mjs';
import { searchHits, boxesFor, lineMatches, parseQuery } from '../lib/note-match.mjs';
import { loadIndex, saveIndex, ensureIndexed, INDEX_VERSION, INDEX_VERSION_PREV } from '../lib/note-search.mjs';
import { TOOL_SRC } from '../lib/note-ocr.mjs';
import { rec, nb, put, mkws } from './helpers-note.mjs';

const near = (a, b, msg) => assert.deepEqual(a.map((n) => Math.round(n * 1000)), b.map((n) => Math.round(n * 1000)), msg);

test('the ink bitmap height mirrors the tool: the three constants are read from the Swift source, not restated', () => {
  const swift = fs.readFileSync(TOOL_SRC, 'utf8');
  const m = /H = max\(W \* ([\d.]+), min\(W \* maxY \+ W \* ([\d.]+), W \* MAX_PAGE_HEIGHT_RATIO\)\)/.exec(swift);
  const ratio = /MAX_PAGE_HEIGHT_RATIO = ([\d.]+)/.exec(swift);
  assert.ok(m && ratio, 'renderInk still sizes its bitmap with the formula this lib mirrors');
  assert.deepEqual([INK_MIN_H, INK_PAD, INK_MAX_H], [Number(m[1]), Number(m[2]), Number(ratio[1])]);
  const page = (ys) => ({ strokes: ys.map((y) => ({ p: [[0.1, y, 0.5]] })) });
  assert.equal(inkRatio(page([0.1])), INK_MIN_H, 'a short page is the minimum height');
  assert.equal(inkRatio(page([0.5, 1.2, 0.9])), 1.25, 'else the lowest stroke plus the pad');
  assert.equal(inkRatio(page([99])), INK_MAX_H, 'capped like the bitmap');
  assert.equal(inkRatio({ strokes: [{ p: [[0.1]] }, {}] }), INK_MIN_H, 'malformed points count as nothing');
});

test('pictures are placed in the ONE sorted order the queue reads them in', () => {
  const page = { images: [{ path: 'uploads/2_b.jpg', x: 0.5, y: 0.1, w: 0.4, h: 0.3 }, { path: 'uploads/1_a.jpg', x: 0, y: 1, w: 1, h: 0.5 }, { x: 0, y: 0, w: 1, h: 1 }] };
  assert.deepEqual(sortedImages(page).map((i) => i.path), ['uploads/1_a.jpg', 'uploads/2_b.jpg'], 'by path; a picture without a path is not one');
  assert.deepEqual(imagePaths(page), ['uploads/1_a.jpg', 'uploads/2_b.jpg'], 'imagePaths is the same order (R3)');
  assert.deepEqual(pageGeo(page), { ink: INK_MIN_H, imgs: [[0, 1, 1, 0.5], [0.5, 0.1, 0.4, 0.3]] });
});

test('pageBox: an ink box scales y and h by the bitmap ratio; a photo box sits inside its picture; the unplaceable is null', () => {
  const geo = { ink: 1.25, imgs: [[0.5, 0.1, 0.4, 0.3]] };
  near(pageBox({ box: [0.1, 0.2, 0.6, 0.08] }, 'ink', geo), [0.1, 0.25, 0.6, 0.1]);
  near(pageBox({ box: [0.25, 0.5, 0.5, 0.2], img: 0 }, 'photo', geo), [0.6, 0.25, 0.2, 0.06]);
  assert.equal(pageBox({ box: [0.25, 0.5, 0.5, 0.2] }, 'photo', geo), null, 'a photo line from before phase 3 names no picture');
  assert.equal(pageBox({ box: [0.25, 0.5, 0.5, 0.2], img: 3 }, 'photo', geo), null, 'a picture the page no longer has');
  assert.equal(pageBox({ box: [0.1, 0.2, 0.6, 0.08] }, 'ink', undefined), null, 'a record with no geometry yet');
  assert.equal(pageBox({ box: [0.1, 0.2, 0.6] }, 'ink', geo), null, 'a malformed box');
  assert.deepEqual(dedupeBoxes([[1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 5]]), [[1, 2, 3, 4], [1, 2, 3, 5]], 'the same line from both ink passes is one rectangle');
});

const inkLines = [{ t: 'Met the landlord', box: [0.1, 0.1, 0.6, 0.05], pass: 'zh' }, { t: 'Met the landlord', box: [0.1, 0.1, 0.6, 0.05], pass: 'en' }, { t: 'about the roof', box: [0.1, 0.2, 0.5, 0.05], pass: 'en' }, { t: '祷告 #灵修', box: [0.1, 0.3, 0.3, 0.05], pass: 'zh' }];
const photoLines = [{ t: 'Receipt total 12.50', box: [0.1, 0.1, 0.5, 0.1], img: 0 }, { t: 'landlord receipt', box: [0.1, 0.5, 0.5, 0.1] }];
const fixture = () => rec('a.json', '', 2, 5, 'typed words', { ink: 'Met the landlord\nabout the roof\n祷告 #灵修', photo: 'Receipt total 12.50\nlandlord receipt',
  boxes: { ink: inkLines, photo: photoLines }, geo: { ink: 2, imgs: [[0, 1, 1, 0.5]] } });

test('boxesFor: only the lines that hold a query token, through the same matcher as the record (prefix, one edit, bigrams, #tag)', () => {
  const r = fixture();
  const box = (q) => boxesFor(r, parseQuery(q));
  near(box('landlord')[0], [0.1, 0.2, 0.6, 0.1], 'ink y, h scaled by the ratio 2');
  assert.equal(box('landlord').length, 1, 'both passes said the same line: one rectangle; the photo line that says landlord has no picture index, so it is not guessed');
  near(box('receipt')[0], [0.1, 1.05, 0.5, 0.05], 'a photo line inside its picture at y=1, h=0.5');
  assert.deepEqual(box('roof').length, 1, 'prefix');
  assert.deepEqual(box('bandlord').length, 1, 'one edit');
  assert.deepEqual(box('祷告').length, 1, 'a Chinese bigram');
  assert.deepEqual(box('#灵修').length, 1, 'a tag token marks the line that carries the tag word');
  assert.deepEqual(box('zzz'), [], 'nothing');
  assert.deepEqual(boxesFor({ boxes: { ink: [], photo: [] } }, parseQuery('x')), [], 'a record from before phase 3 (no geo) yields no boxes, never throws');
  assert.ok(lineMatches(parseQuery('land')[0], 'the landlord') && !lineMatches(parseQuery('land')[0], 'the roof'));
  const many = rec('m.json', '', 0, 1, '', { ink: 'x', boxes: { ink: Array.from({ length: BOXES_MAX + 20 }, (_, i) => ({ t: 'roof', box: [0, i / 100, 0.1, 0.01] })) } });
  assert.equal(boxesFor(many, parseQuery('roof')).length, BOXES_MAX, 'capped');
});

test('searchHits carries boxes per returned hit and the query terms; a tag or typed hit on a page without OCR carries none', () => {
  const index = { v: INDEX_VERSION, files: {}, records: [fixture(), rec('b.json', '', 0, 9, 'the landlord typed')] };
  const r = searchHits(index, 'Landlord roof');
  assert.deepEqual(r.terms, ['landlord', 'roof'], 'lowercase tokens, as matched');
  assert.deepEqual(r.hits.map((h) => [h.path, h.page, h.boxes.length]), [['a.json', 2, 2]], 'AND: b.json has no roof; a.json carries one box per matched line');
  const t = searchHits(index, 'typed');
  assert.deepEqual(t.hits.map((h) => [h.path, h.boxes]), [['b.json', []], ['a.json', []]], 'typed words have no OCR box (the page marks them itself from `terms`)');
  assert.deepEqual(searchHits(index, '').terms, []);
});

test('an index of the previous version loads with its records kept and its file stamps made stale, so the scan re-reads once and keeps the OCR', () => {
  const ws = mkws('pa-boxes-');
  put(ws, 'notes', 'entry-1.json', nb('<div>hello</div>'));
  const fresh = ensureIndexed(ws, 'notes').index;
  const r0 = fresh.records[0];
  assert.deepEqual(r0.geo, { ink: INK_MIN_H, imgs: [] }, 'a new record carries its geometry');
  // What phase 2 left on disk: v3, geometry-less records, the ink already transcribed.
  const { geo, ...noGeo } = r0;
  const old = { v: INDEX_VERSION_PREV, files: fresh.files, records: [{ ...noGeo, src: { ...noGeo.src, ink: 'old ink' }, done: { ...noGeo.done, ink: noGeo.need.ink }, boxes: { ink: [{ t: 'old ink', box: [0, 0, 1, 0.1] }], photo: [] } }] };
  saveIndex(ws, 'notes', old);
  const loaded = loadIndex(ws, 'notes');
  assert.deepEqual([loaded.v, loaded.files, loaded.records.length], [INDEX_VERSION, { 'entry-1.json': { mtimeMs: -1, size: -1 } }, 1], 'upgraded in memory: stamps stale (never forgotten, so a deleted file is still dropped), records kept');
  const { index } = ensureIndexed(ws, 'notes');
  const r1 = index.records[0];
  assert.deepEqual([r1.src.ink, r1.done.ink === r1.need.ink, r1.boxes.ink.length, r1.geo], ['old ink', true, 1, { ink: INK_MIN_H, imgs: [] }], 'carried: the ink text, its hash and boxes; added: the geometry');
  assert.equal(JSON.parse(fs.readFileSync(path.join(ws, 'search', 'notes.json'), 'utf8')).v, INDEX_VERSION, 'and saved as the current version');
  assert.deepEqual(loadIndex(ws, 'x').records, [], 'CONTROL: nothing on disk is still empty');
  const broken = { ...old, records: [{ ...old.records[0], tags: 'nope' }] };
  saveIndex(ws, 'notes', broken);
  assert.deepEqual(loadIndex(ws, 'notes'), { v: INDEX_VERSION, files: {}, records: [] }, 'a malformed previous-version index is rebuilt from empty, as before');
});

test('applyOcr keeps the picture index of a photo line, and buildFileRecords places the page', () => {
  const page = { strokes: [{ p: [[0.1, 0.9, 0.5]] }], pageHtml: '', images: [{ path: 'uploads/1_a.jpg', x: 0.1, y: 0.2, w: 0.5, h: 0.4 }] };
  const [r] = buildFileRecords('p.json', { pages: [page] }, 1);
  assert.deepEqual(r.geo, { ink: 0.95, imgs: [[0.1, 0.2, 0.5, 0.4]] });
  applyOcr(r, 'photo', r.need.photo, { ok: true, text: 'Total', lines: [{ t: 'Total', c: 1, box: [0, 0, 1, 0.5], img: 0 }, { t: 'x', c: 1, box: [0, 0, 1, 1] }], labels: [] });
  assert.deepEqual(r.boxes.photo, [{ t: 'Total', box: [0, 0, 1, 0.5], img: 0 }, { t: 'x', box: [0, 0, 1, 1] }], 'img kept when the queue gave one, absent otherwise');
  near(boxesFor(r, parseQuery('total'))[0], [0.1, 0.2, 0.5, 0.2]);
});
