// lib/note-text.mjs — what GET /api/note-text answers from an index: one record per page, the
// fields asked for and no more, pending/error per page, the paths/scope filters, and the backstop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noteTextRecords, parseFields, importantLines, NOTE_TEXT_FIELDS, DEFAULT_FIELDS, PATHS_MAX, PAGES_MAX } from '../lib/note-text.mjs';
import { finishRecord } from '../lib/note-index.mjs';
import { INK_MIN_H } from '../lib/note-boxes.mjs';
import { rec } from './helpers-note.mjs';   // R3: the one record factory

const H = 'abc';
const index = () => ({ v: 4, files: {}, records: [
  rec('entry-2.json', '', 1, 5, 'second page #todo'),
  rec('entry-2.json', '', 0, 5, 'typed #灵修 words', { ink: 'handwritten #ores line', photo: 'slide text', labels: ['Document', 'Text'], need: { ink: H, photo: H }, done: { ink: H, photo: H }, boxes: { ink: [{ t: 'handwritten', box: [0, 0, 1, 0.1] }] } }),
  rec('entry-1.json', '', 0, 9, 'owed page', { need: { ink: H } }),                                       // ink owed, not done: pending
  rec('notes/43-3.json', 'v16', 0, 3, 'bible #prayer', { need: { photo: H }, done: { photo: null } }),
] });
const failed = () => { const r = rec('entry-3.json', '', 0, 1, 'bad', { need: { ink: H } }); r.ocrError.ink = { hash: H, error: 'panote-ocr ink: tool died', code: 'ocr_failed' }; return r; };

test('parseFields: a comma list, unknown names dropped, empty → tags only', () => {
  assert.deepEqual(parseFields('src,labels'), ['src', 'labels']);
  assert.deepEqual(parseFields(' tags , junk ,src,src'), ['tags', 'src'], 'trimmed, deduped, unknown dropped');
  assert.deepEqual(parseFields(''), [...DEFAULT_FIELDS]);
  assert.deepEqual(parseFields(null), ['tags']);
  assert.deepEqual(parseFields('junk'), ['tags'], 'only unknown names → the default');
  assert.deepEqual([...NOTE_TEXT_FIELDS], ['tags', 'src', 'labels', 'boxes', 'important']);
});

test('default: every page of every file, tags only, in file/scope/page order, pending per page', () => {
  const { pages, truncated } = noteTextRecords(index());
  assert.equal(truncated, false);
  assert.deepEqual(pages, [
    { path: 'entry-1.json', scope: '', page: 0, pending: true, tags: [], typedTags: [] },
    { path: 'entry-2.json', scope: '', page: 0, pending: false, tags: ['灵修', 'ores'], typedTags: ['灵修'] },
    { path: 'entry-2.json', scope: '', page: 1, pending: false, tags: ['todo'], typedTags: ['todo'] },
    { path: 'notes/43-3.json', scope: 'v16', page: 0, pending: true, tags: ['prayer'], typedTags: ['prayer'] },
  ], 'a handwritten tag counts (finishRecord derives tags from every source) and typedTags names the typed ones alone (the strip, note-features.md H); no src/labels/boxes ride uninvited');
});

test('one document with the transcript fields: src, labels, boxes; a page failure names its reason', () => {
  const idx = index(); idx.records.push(failed());
  const { pages } = noteTextRecords(idx, { paths: ['entry-2.json'], scope: '', fields: ['src', 'labels', 'boxes'] });
  assert.deepEqual(pages.map((p) => p.page), [0, 1]);
  assert.deepEqual(pages[0].src, { typed: 'typed #灵修 words', ink: 'handwritten #ores line', photo: 'slide text' });
  assert.deepEqual(pages[0].labels, ['Document', 'Text']);
  assert.deepEqual(pages[0].boxes, { ink: [{ t: 'handwritten', box: [0, 0, 1, 0.1] }], photo: [] });
  assert.equal('tags' in pages[0], false, 'tags not asked for');
  assert.deepEqual(pages[1].src, { typed: 'second page #todo', ink: '', photo: '' });
  const f = noteTextRecords(idx, { paths: ['entry-3.json'], fields: ['src'] }).pages;
  assert.deepEqual(f.map((p) => [p.pending, p.error]), [[false, 'panote-ocr ink: tool died']], 'a content failure is not pending, and says why');
});

test('filters: paths select files; scope null = any, a string ("" included) = exact; the paths cap is a backstop, not a throw', () => {
  const idx = index();
  assert.deepEqual(noteTextRecords(idx, { paths: ['notes/43-3.json', 'entry-1.json'] }).pages.map((p) => p.path), ['entry-1.json', 'notes/43-3.json']);
  assert.deepEqual(noteTextRecords(idx, { paths: ['notes/43-3.json'], scope: '' }).pages, [], 'the Bible page sits under v16, not the root');
  assert.deepEqual(noteTextRecords(idx, { paths: ['notes/43-3.json'], scope: 'v16' }).pages.map((p) => p.tags), [['prayer']]);
  assert.deepEqual(noteTextRecords(idx, { paths: ['nothing.json'] }).pages, []);
  const many = Array.from({ length: PATHS_MAX + 1 }, (_, i) => `x-${i}.json`);
  many[PATHS_MAX] = 'entry-1.json';                                   // the one real file sits past the cap
  const r = noteTextRecords(idx, { paths: many });
  assert.equal(r.truncated, true); assert.deepEqual(r.pages, [], 'past the cap is dropped and SAID, never scanned');
  const big = { records: Array.from({ length: PAGES_MAX + 5 }, (_, i) => ({ ...index().records[0], path: `e-${i}.json` })) };
  const b = noteTextRecords(big, { fields: ['src'] });
  assert.equal(b.pages.length, PAGES_MAX); assert.equal(b.truncated, true, 'no path + src: the reply is capped and says so, never the whole app');
});

test('CONTROL: the reply never carries the index\'s own members (idx, need, done, ocrError, geo)', () => {
  const { pages } = noteTextRecords(index(), { fields: [...NOTE_TEXT_FIELDS] });
  for (const p of pages) assert.deepEqual(Object.keys(p).sort(), ['boxes', 'important', 'inkImportant', 'labels', 'page', 'path', 'pending', 'scope', 'src', 'tags', 'typedTags']);   // inkImportant rides with important (note-features.md I)
});

test('important: the marked lines in reading order — typed highlights first, then highlighted/circled handwriting top to bottom; v5 records have none', () => {
  // Three OCR lines; the record's regions make lines 2 and 0 important (indexes land in OCR order, the field sorts by page y).
  const lines = [{ t: 'top line', box: [0.1, 0.1, 0.6, 0.1] }, { t: 'middle', box: [0.1, 0.3, 0.6, 0.1] }, { t: '  bottom line ', box: [0.1, 0.6, 0.6, 0.1] }];
  const r = rec('entry-9.json', '', 0, 1, 'typed', { ink: 'top line\nmiddle\nbottom line', need: { ink: H }, done: { ink: H }, boxes: { ink: lines } });
  r.emph = { hl: [[0.05, 0.17, 0.7, 0.05]], circ: [[0, 0, 0.8, 0.07]] };   // page y: line 2 at 0.18..0.21 under the highlighter; line 0 at 0.03..0.06 centred in the circle
  r.imp = { ink: [], typed: ['keep this'] }; finishRecord(r);
  assert.deepEqual(r.imp, { ink: [0, 2], typed: ['keep this'] });
  assert.deepEqual(importantLines(r), ['keep this', 'top line', 'bottom line'], 'typed first, then ink by y, trimmed');
  const idx = { records: [r] };
  assert.deepEqual(noteTextRecords(idx, { paths: ['entry-9.json'], fields: ['important'] }).pages[0].important, ['keep this', 'top line', 'bottom line']);
  assert.equal('important' in noteTextRecords(idx, { paths: ['entry-9.json'], fields: ['src'] }).pages[0], false, 'not asked for, not carried');
  const old = rec('entry-5.json', '', 0, 1, 'from v5'); delete old.imp; delete old.emph;
  assert.deepEqual(noteTextRecords({ records: [old] }, { fields: ['important'] }).pages[0].important, [], 'a record from before v6 has nothing marked');
  assert.equal(INK_MIN_H, 0.3, 'the geometry the y order above assumes');
});
