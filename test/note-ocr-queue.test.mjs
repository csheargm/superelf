// lib/note-ocr-queue.mjs — the background OCR worker over a REAL throwaway workspace and index (harness
// fidelity), with the OCR itself injected: a recording fake `ocr` for ordering/persistence, the
// committed fake tool (`cmd`) for the whole path. Synthetic notebooks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ensureIndexed, loadIndex, reindexFile, saveIndex, search, searchHits, scheduleReindex } from '../lib/note-search.mjs';
import { startOcrWorker, workerIdle, workerRunning, ocrWork, pendingCount, isOwed, uploadFile, ocrStatus, noteOcrState, ocrEnvState, resetOcrEnvState, OCR_STATUS, OCR_MAX_IMAGES_PER_PAGE, OCR_MAX_PICKS_PER_BURST, OCR_STALE_INDEX, UPLOAD_PATH_REFUSED, PAGE_GONE } from '../lib/note-ocr-queue.mjs';
import { inkHash, photoHash, applyOcr, findNotebooks, recKey } from '../lib/note-index.mjs';
import { OCR_FAILED, OCR_BUILD_FAILED, OCR_TIMEOUT } from '../lib/note-ocr.mjs';
import { FAKE_OCR_CMD } from './helpers-web.mjs';
import { stroke, mkws, put, paths, rec } from './helpers-note.mjs';

const ink = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ ...stroke, p: [[0.1 + i * 0.01, 0.2, 0.5]], ...extra }));
const page = (o) => ({ id: 'p', created: 1, updated: 2, strokes: [], pageHtml: '', images: [], ...o });
const nbOf = (pages, updated) => ({ v: 2, id: 'n', created: 1, updated, template: 'blank', bgColor: '#fff', pages });
const errors = () => { const seen = []; return { seen, onError: (e) => seen.push(e) }; };
// A recording OCR: ink text names the stroke count (as a word, so no two results are one edit apart
// — the matcher's fuzziness is not under test here), so a page is tellable by its result.
const WORD = ['zero', 'one', 'two', 'three', 'four', 'five'];
function fakeOcr() {
  const calls = [];
  return { calls, ocr: {
    ocrInk: async (strokes) => { calls.push(['ink', strokes.length]); const t = `${WORD[strokes.length]}strokes #penned`; return { ok: true, lines: [{ t, c: 0.5, box: [0, 0, 1, 1], pass: 'zh' }], text: t, ms: 1 }; },
    ocrImage: async (f) => { calls.push(['image', path.basename(f)]); return { ok: true, lines: [{ t: 'receipt total', c: 0.9, box: [0, 0, 1, 1] }], text: 'receipt total', labels: ['document'], ms: 1 }; },
  } };
}
const run = async (ws, slug, opts) => { assert.equal(startOcrWorker(ws, slug, opts), true, 'the worker started'); await workerIdle(); };

test('work = pages whose need differs from done, newest first; the results land in the index on disk and make ink/photo searchable', async () => {
  const ws = mkws('pa-ocr-q-');
  put(ws, 'notes', 'old.json', nbOf([page({ strokes: ink(2) })], 100));
  put(ws, 'notes', 'new.json', nbOf([page({ strokes: ink(3), pageHtml: '<div>typed words</div>' }), page({ strokes: ink(4) })], 300));
  put(ws, 'notes', 'mid.json', nbOf([page({ images: [{ path: 'uploads/1_r.jpg', x: 0, y: 0, w: 1, h: 1 }] })], 200));
  fs.mkdirSync(path.join(ws, 'uploads')); fs.writeFileSync(path.join(ws, 'uploads', '1_r.jpg'), 'jpg');
  put(ws, 'notes', 'typed-only.json', nbOf([page({ pageHtml: '<div>no ink here</div>' })], 400));
  const { index } = ensureIndexed(ws, 'notes');
  assert.deepEqual(ocrWork(index).map((r) => [r.path, r.page]), [['new.json', 0], ['new.json', 1], ['mid.json', 0], ['old.json', 0]], 'newest notebook first; the typed-only page owes nothing');
  assert.equal(pendingCount(index), 4);
  const { calls, ocr } = fakeOcr(); const E = errors();
  await run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0 });
  assert.deepEqual(calls, [['ink', 3], ['ink', 4], ['image', '1_r.jpg'], ['ink', 2]], 'one page at a time, in that order');
  assert.deepEqual(E.seen, []);
  const after = loadIndex(ws, 'notes');
  assert.equal(pendingCount(after), 0, 'nothing owed: progress is in the index file');
  const r = after.records.find((x) => x.path === 'new.json' && x.page === 1);
  assert.equal(r.src.ink, 'fourstrokes #penned'); assert.equal(r.done.ink, r.need.ink); assert.deepEqual(r.tags, ['penned'], 'a handwritten #tag is a tag');
  assert.deepEqual(r.boxes.ink, [{ t: 'fourstrokes #penned', box: [0, 0, 1, 1], pass: 'zh' }], 'boxes kept for phase 3');
  const m = after.records.find((x) => x.path === 'mid.json');
  assert.equal(m.src.photo, 'receipt total'); assert.deepEqual(m.labels, ['document']); assert.equal(m.boxes.photo[0].img, 0, 'the line names its picture (phase 3)');
  assert.deepEqual(paths(search(after, 'fourstrokes')), ['new.json'], 'handwriting is searchable');
  assert.deepEqual(searchHits(after, 'receipt').hits.map((h) => [h.path, h.where, h.snippet]), [['mid.json', 'photo', 'receipt total document']], 'photo text, with its snippet (text, then the labels)');
  assert.deepEqual(searchHits(after, 'document').hits.map((h) => h.where), ['photo'], 'a label is a searchable word');
  assert.deepEqual(searchHits(after, '#penned').hits.map((h) => h.where), ['tag', 'tag'], 'and the ink tag is a tag hit (both ink notebooks carry it)');
  assert.deepEqual(searchHits(after, 'typed').hits.map((h) => h.where), ['typed']);
  assert.equal(workerRunning(ws, 'notes'), false);
});

test('a typed edit does not re-OCR unchanged ink (carried by hash); changed strokes are owed again; erased ink is forgotten', async () => {
  const ws = mkws('pa-ocr-q-');
  const f = put(ws, 'notes', 'e.json', nbOf([page({ strokes: ink(2), pageHtml: '<div>v1</div>' })], 100));
  ensureIndexed(ws, 'notes');
  const { calls, ocr } = fakeOcr(); const E = errors();
  await run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0 });
  assert.deepEqual(calls, [['ink', 2]]);
  fs.writeFileSync(f, JSON.stringify(nbOf([page({ strokes: ink(2), pageHtml: '<div>v2 typed</div>' })], 101)));
  const idx = loadIndex(ws, 'notes'); reindexFile(ws, 'notes', 'e.json', idx); saveIndex(ws, 'notes', idx);
  assert.equal(idx.records[0].src.ink, 'twostrokes #penned', 'the OCR text survived the reindex');
  assert.equal(pendingCount(idx), 0, 'nothing owed: same strokes, same hash');
  assert.deepEqual(paths(search(idx, 'v2')), ['e.json']);
  fs.writeFileSync(f, JSON.stringify(nbOf([page({ strokes: ink(5), pageHtml: '<div>v2 typed</div>' })], 102)));
  const idx2 = ensureIndexed(ws, 'notes').index;
  assert.equal(pendingCount(idx2), 1, 'new strokes: owed again'); assert.equal(idx2.records[0].src.ink, '', 'and the stale text is gone, not searched');
  await run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0 });
  assert.deepEqual(calls, [['ink', 2], ['ink', 5]]);
  fs.writeFileSync(f, JSON.stringify(nbOf([page({ strokes: [], pageHtml: '<div>v2 typed</div>' })], 103)));
  const idx3 = ensureIndexed(ws, 'notes').index;
  assert.deepEqual([idx3.records[0].need.ink, idx3.records[0].src.ink, pendingCount(idx3)], [null, '', 0], 'erased ink: no hash, no text, nothing owed');
  assert.deepEqual(E.seen, []);
});

test('a page that failed on its CONTENT is reported ONCE with a code, remembered with its hash, and not retried until the content changes', async () => {
  const ws = mkws('pa-ocr-q-');
  const f = put(ws, 'notes', 'bad.json', nbOf([page({ strokes: ink(2) })], 100));
  put(ws, 'notes', 'good.json', nbOf([page({ strokes: ink(3) })], 50));
  ensureIndexed(ws, 'notes');
  let fails = 0;
  const ocr = { ocrInk: async (s) => (s.length === 2 ? (fails++, { ok: false, code: OCR_FAILED, error: 'panote-ocr ink: vision: no text region' }) : { ok: true, lines: [], text: 'fine', ms: 1 }), ocrImage: async () => ({ ok: true, lines: [], text: '', labels: [], ms: 0 }) };
  const E = errors();
  await run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0 });
  assert.equal(fails, 1);
  assert.equal(E.seen.length, 1, 'audited once');
  assert.equal(E.seen[0].code, OCR_FAILED); assert.match(E.seen[0].message, /bad\.json page 0 ink: panote-ocr ink: vision/);
  assert.deepEqual(E.seen[0].detail, { app: 'notes', path: 'bad.json', scope: '', page: 0, source: 'ink' });
  const idx = loadIndex(ws, 'notes');
  const bad = idx.records.find((r) => r.path === 'bad.json');
  assert.deepEqual(bad.ocrError.ink, { hash: bad.need.ink, error: 'panote-ocr ink: vision: no text region', code: OCR_FAILED });
  assert.equal(isOwed(bad, 'ink'), false, 'not owed while the content is what failed');
  assert.equal(pendingCount(idx), 0, 'a failed page is not "pending": it will not be transcribed');
  assert.equal(idx.records.find((r) => r.path === 'good.json').src.ink, 'fine', 'the burst went on past the failure');
  await run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0 });
  assert.equal(fails, 1, 'a second burst does not retry it');
  fs.writeFileSync(f, JSON.stringify(nbOf([page({ strokes: ink(2, { w: 0.01 }) })], 101)));
  const again = ensureIndexed(ws, 'notes').index;
  assert.equal(isOwed(again.records.find((r) => r.path === 'bad.json'), 'ink'), true, 'changed strokes: tried again');
  assert.deepEqual(again.records.find((r) => r.path === 'bad.json').ocrError, {}, 'the old error does not travel with new content');
});

test('pictures are read from <ws>/uploads only: a path outside, a dotted one, or a link is refused with a code', async () => {
  const ws = mkws('pa-ocr-q-');
  fs.mkdirSync(path.join(ws, 'uploads')); fs.writeFileSync(path.join(ws, 'uploads', '1_ok.jpg'), 'x');
  fs.symlinkSync(path.join(ws, 'uploads', '1_ok.jpg'), path.join(ws, 'uploads', '2_link.jpg'));
  assert.equal(uploadFile(ws, 'uploads/1_ok.jpg'), path.join(ws, 'uploads', '1_ok.jpg'));
  for (const bad of ['uploads/../data/x.json', 'data/notes/e.json', '/etc/passwd', 'uploads/.hidden', 'uploads/', 'uploads', 'uploads/a\\b', 'uploads/2_link.jpg', 7, null]) assert.equal(uploadFile(ws, bad), null, String(bad));
  put(ws, 'notes', 'p.json', nbOf([page({ images: [{ path: '../../etc/hosts', x: 0, y: 0, w: 1, h: 1 }] }), page({ images: [{ path: 'uploads/1_ok.jpg', x: 0, y: 0, w: 1, h: 1 }, { path: 'uploads/2_link.jpg', x: 0, y: 0, w: 1, h: 1 }] })], 100));
  ensureIndexed(ws, 'notes');
  const { calls, ocr } = fakeOcr(); const E = errors();
  await run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0 });
  assert.deepEqual(E.seen.map((e) => [e.code, e.detail.page]), [[UPLOAD_PATH_REFUSED, 0], [UPLOAD_PATH_REFUSED, 1]], 'both pages refused: page 1 because its second picture is a link');
  assert.deepEqual(calls, [['image', '1_ok.jpg']], 'the good picture was read before the link stopped the page; nothing outside uploads was opened');
  assert.equal(pendingCount(loadIndex(ws, 'notes')), 0);
});

test('unavailable OCR: the worker does nothing and says so; `noteOcrState` reports pending and status and kicks the worker only when it can', async () => {
  const ws = mkws('pa-ocr-q-');
  put(ws, 'notes', 'e.json', nbOf([page({ strokes: ink(2) })], 100));
  const { index } = ensureIndexed(ws, 'notes');
  const E = errors();
  assert.equal(startOcrWorker(ws, 'notes', { cmd: '/no/such/tool', onError: E.onError }), false);
  assert.equal(ocrStatus({ cmd: '/no/such/tool' }), OCR_STATUS.unavailable);
  assert.deepEqual(noteOcrState(ws, 'notes', index, { cmd: '/no/such/tool', onError: E.onError }), { pending: 1, ocr: OCR_STATUS.unavailable });
  assert.equal(workerRunning(ws, 'notes'), false);
  assert.throws(() => startOcrWorker(ws, 'notes', { cmd: FAKE_OCR_CMD }), /onError is required/);
  // The whole path through the committed fake tool (execFile): status ready, worker kicked, union indexed.
  assert.deepEqual(noteOcrState(ws, 'notes', index, { cmd: FAKE_OCR_CMD, onError: E.onError }), { pending: 1, ocr: OCR_STATUS.ready });
  await workerIdle();
  const after = loadIndex(ws, 'notes');
  assert.equal(after.records[0].src.ink, '手写笔记 #墨水 2\nSatuday pollen\nSaturday pollen moderate 2', 'both passes, union');
  assert.deepEqual(after.records[0].boxes.ink.map((b) => b.pass), ['zh', 'zh', 'en']);
  assert.deepEqual(searchHits(after, 'saturday').hits.map((h) => [h.where, h.snippet]), [['ink', '手写笔记 #墨水 2 Satuday pollen Saturday pollen moderate 2']], 'pass B\'s correct word is found; the snippet is one line');
  assert.deepEqual(searchHits(after, '#墨水').hits.map((h) => h.where), ['tag'], 'a handwritten Chinese tag');
  assert.deepEqual(E.seen, []);
  assert.deepEqual(noteOcrState(ws, 'notes', after, { cmd: FAKE_OCR_CMD, onError: E.onError }), { pending: 0, ocr: OCR_STATUS.ready }, 'nothing left: no kick');
});

test('a start during a burst queues one more pass; the save hook\'s `after` starts the worker; a page gone mid-burst is recorded, not looped on', async () => {
  const ws = mkws('pa-ocr-q-');
  const f = put(ws, 'notes', 'a.json', nbOf([page({ strokes: ink(2) })], 100));
  ensureIndexed(ws, 'notes');
  let release; const gate = new Promise((r) => { release = r; });
  const calls = [];
  const ocr = { ocrInk: async (s) => { calls.push(s.length); await gate; return { ok: true, lines: [], text: `ink${s.length}`, ms: 1 }; }, ocrImage: async () => ({ ok: true, lines: [], text: '', labels: [], ms: 0 }) };
  const E = errors();
  assert.equal(startOcrWorker(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0 }), true);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(workerRunning(ws, 'notes'), true);
  // While page a is in Vision, a save adds b.json and the hook's `after` kicks the worker again.
  put(ws, 'notes', 'b.json', nbOf([page({ strokes: ink(3) })], 200));
  assert.equal(scheduleReindex(ws, 'data/notes/b.json', { delayMs: 1, onError: E.onError, after: (slug) => startOcrWorker(ws, slug, { ocr, onError: E.onError, saveDebounceMs: 0 }) }), true);
  await new Promise((r) => setTimeout(r, 30));
  release(); await workerIdle();
  assert.deepEqual(calls, [2, 3], 'the page saved during the burst was transcribed by the queued pass, not left for the next search');
  const idx = loadIndex(ws, 'notes');
  assert.deepEqual(idx.records.map((r) => [r.path, r.src.ink]), [['a.json', 'ink2'], ['b.json', 'ink3']]);
  // The record's page disappears from the notebook before its turn: recorded as page_gone, once.
  fs.writeFileSync(f, JSON.stringify(nbOf([page({ strokes: ink(4) })], 300)));
  const owed = ensureIndexed(ws, 'notes').index;
  assert.equal(pendingCount(owed), 1);
  fs.writeFileSync(f, JSON.stringify({ v: 3, entries: [] }));   // not a notebook any more; the index still says a page is owed
  await run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0 });
  assert.deepEqual(calls, [2, 3], 'nothing ran for the vanished page');
  assert.deepEqual(E.seen.map((e) => e.code), [PAGE_GONE]);
  assert.equal(pendingCount(loadIndex(ws, 'notes')), 0);
});

test('applyOcr/isOwed: hashes change only with the strokes or the picture list, not with position or typed text', () => {
  const a = page({ strokes: ink(2), images: [{ path: 'uploads/1.jpg', x: 0, y: 0, w: 1, h: 1 }, { path: 'uploads/2.jpg', x: 0, y: 0, w: 1, h: 1 }] });
  const moved = { ...a, pageHtml: '<div>typed</div>', images: [{ path: 'uploads/2.jpg', x: 0.5, y: 0.5, w: 1, h: 1 }, { path: 'uploads/1.jpg', x: 0.9, y: 0, w: 2, h: 2 }] };
  assert.equal(inkHash(a), inkHash(moved)); assert.equal(photoHash(a), photoHash(moved), 'order and placement do not matter');
  assert.notEqual(inkHash(a), inkHash({ strokes: ink(3) })); assert.notEqual(photoHash(a), photoHash({ images: [{ path: 'uploads/1.jpg' }] }));
  assert.equal(inkHash({ strokes: [] }), null); assert.equal(photoHash({ images: [{ x: 1 }] }), null, 'a picture without a path is not one');
  const r = rec('a.json', '', 0, 1, 'typed', { need: { ink: 'h1' } });
  assert.equal(isOwed(r, 'ink'), true); assert.equal(isOwed(r, 'photo'), false);
  applyOcr(r, 'ink', 'h1', { ok: true, text: 'hand #写经', lines: [{ t: 'hand #写经', c: 0.4, box: [0, 0, 1, 1], pass: 'en' }] });
  assert.deepEqual([r.done.ink, r.src.ink, r.tags, isOwed(r, 'ink')], ['h1', 'hand #写经', ['写经'], false]);
  assert.deepEqual(r.idx.ink.runs, ['hand', '写经'], 'idx recomputed for the source');
  r.need.ink = 'h2';
  assert.equal(isOwed(r, 'ink'), true, 'new content, owed again');
});

// R13 round 1 #1/#14: an ENVIRONMENTAL failure (build failed, timeout, spawn error, unavailable) is the
// node's, not the page's. It ends the burst, lands on NO record (the pages stay owed, so `pending` is
// honest), is remembered per process as ocr:'failed' with the reason, gates further kicks for
// OCR_ENV_RETRY_MS, and a later successful kick resumes the pending pages.
test('an environmental failure ends the burst, poisons no page, is reported as ocr:failed with its reason, and the pages resume on a later kick', async () => {
  resetOcrEnvState();
  const ws = mkws('pa-ocr-q-');
  put(ws, 'notes', 'a.json', nbOf([page({ strokes: ink(2) })], 200));
  put(ws, 'notes', 'b.json', nbOf([page({ strokes: ink(3) })], 100));
  put(ws, 'notes', 'typed.json', nbOf([page({ pageHtml: '<div>typed</div>' })], 300));
  const { index } = ensureIndexed(ws, 'notes');
  assert.equal(pendingCount(index), 2);
  let env = { ok: false, code: OCR_BUILD_FAILED, error: 'swiftc: error: unable to find utility "swiftc", not a developer tool or in PATH' };
  const calls = [];
  const ocr = { ocrInk: async (s) => { calls.push(s.length); return env || { ok: true, lines: [], text: `ink${s.length}`, ms: 1 }; }, ocrImage: async () => ({ ok: true, lines: [], text: '', labels: [], ms: 0 }) };
  const E = errors();
  let t = 5_000_000; const now = () => t;
  assert.equal(ocrStatus({ cmd: FAKE_OCR_CMD }), OCR_STATUS.ready, 'before: nothing known against the node');
  const owedBefore = () => loadIndex(ws, 'notes').records.filter((r) => r.need.ink).map((r) => [r.path, r.done.ink, r.ocrError, isOwed(r, 'ink')]);
  assert.deepEqual(owedBefore().map((x) => x[3]), [true, true]);
  await run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0, now });
  assert.deepEqual(calls, [2], 'the burst ENDED at the first environmental failure: page b was not even tried');
  assert.deepEqual(owedBefore(), [['a.json', null, {}, true], ['b.json', null, {}, true]], 'STATE: no done hash, no ocrError, both pages still owed');
  assert.equal(pendingCount(loadIndex(ws, 'notes')), 2, 'pending stays honest');
  assert.equal(E.seen.length, 1, 'audited once per burst'); assert.equal(E.seen[0].code, OCR_BUILD_FAILED);
  assert.deepEqual(ocrEnvState() && [ocrEnvState().status, ocrEnvState().code, ocrEnvState().reason], [OCR_STATUS.failed, OCR_BUILD_FAILED, env.error]);
  assert.equal(ocrStatus({ cmd: FAKE_OCR_CMD }), OCR_STATUS.failed, 'the route reports failed, not ready');
  assert.deepEqual(noteOcrState(ws, 'notes', loadIndex(ws, 'notes'), { cmd: FAKE_OCR_CMD, onError: E.onError, now }), { pending: 2, ocr: OCR_STATUS.failed, reason: env.error }, 'with the reason');
  assert.equal(workerRunning(ws, 'notes'), false, 'and that call did NOT kick: the window has not passed');
  assert.equal(startOcrWorker(ws, 'notes', { ocr, onError: E.onError, now }), false);
  // The environment is repaired (e.g. CLT installed); after the window a kick runs and resumes BOTH pages.
  env = null; t += 10 * 60 * 1000;
  await run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0, now });
  assert.deepEqual(calls, [2, 2, 3], 'the pages left pending were transcribed, newest first');
  assert.equal(pendingCount(loadIndex(ws, 'notes')), 0);
  assert.equal(ocrEnvState(), null, 'a success clears the state'); assert.equal(ocrStatus({ cmd: FAKE_OCR_CMD }), OCR_STATUS.ready);
  assert.equal(E.seen.length, 1, 'nothing new audited');
  // A timeout mid-burst is environmental too: the page is NOT remembered as failed.
  put(ws, 'notes', 'c.json', nbOf([page({ strokes: ink(4) })], 400));
  ensureIndexed(ws, 'notes');
  env = { ok: false, code: OCR_TIMEOUT, error: 'panote-ocr ink: no answer within 30000 ms' };
  await run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0, now, envRetryMs: 0 });
  const c = loadIndex(ws, 'notes').records.find((r) => r.path === 'c.json');
  assert.deepEqual([c.done.ink, c.ocrError, isOwed(c, 'ink'), ocrEnvState().code], [null, {}, true, OCR_TIMEOUT]);
  resetOcrEnvState();
});

test('applyOcr refuses an environmental outcome: the record is untouched and still owed (CONTROL: a content failure lands)', () => {
  const r = rec('a.json', '', 0, 1, 'typed', { need: { ink: 'h1' } });
  for (const code of [OCR_BUILD_FAILED, OCR_TIMEOUT, 'ocr_unavailable', 'ocr_spawn_failed']) {
    applyOcr(r, 'ink', 'h1', { ok: false, code, error: 'env' });
    assert.deepEqual([r.done.ink, r.ocrError, isOwed(r, 'ink')], [null, {}, true], code);
  }
  applyOcr(r, 'ink', 'h1', { ok: false, code: OCR_FAILED, error: 'content' });
  assert.deepEqual([r.done.ink, r.ocrError.ink.code, isOwed(r, 'ink')], ['h1', OCR_FAILED, false]);
});

// R13 round 1 #2: a file that repeats a notebook key at two depths. findNotebooks keeps ONE notebook per
// scope (first wins), so pageOf and buildFileRecords agree and the worker ends; before, the second
// record's need never matched the first notebook's page and the loop re-parsed and rewrote forever.
test('two notebooks under the same key: one record per scope (first wins), and the worker terminates', async () => {
  const nbA = nbOf([page({ strokes: ink(2) })], 100), nbB = nbOf([page({ strokes: ink(3) })], 100);
  const found = findNotebooks({ draws: { v1: nbA }, backup: { v1: nbB } });
  assert.deepEqual(found.map((n) => [n.scope, n.nb.pages[0].strokes.length]), [['v1', 2]], 'the first notebook under the key, the second is not a record');
  const ws = mkws('pa-ocr-q-');
  put(ws, 'notes', 'e.json', { draws: { v1: nbA }, backup: { v1: nbB } });
  const { index } = ensureIndexed(ws, 'notes');
  assert.deepEqual([...new Set(index.records.map(recKey))].length, index.records.length, 'record keys are unique');
  assert.equal(pendingCount(index), 1);
  const { calls, ocr } = fakeOcr(); const E = errors();
  const done = run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0 });
  const bound = new Promise((_, reject) => setTimeout(() => reject(new Error('the worker did not terminate in 3 s')), 3000).unref());
  await Promise.race([done, bound]);
  assert.deepEqual(calls, [['ink', 2]], 'one OCR run, then nothing owed');
  assert.deepEqual(E.seen, []);
  assert.equal(pendingCount(loadIndex(ws, 'notes')), 0);
});

// The loop's backstop, on an index the de-dup cannot reach: two records under ONE key (an index written
// by other code; forged here), the first matching the page on disk. Its result can never land (the key
// map addresses the second), so without the cap the worker re-ran Vision on every tick until restart
// (R13 round 1 #2, verified by mutation: with findNotebooks' de-dup removed the two-notebook fixture
// ends through this cap in ~40 ms). With it: the stale record is marked at its hash, the file is
// reindexed once, the rebuilt record is transcribed, and the burst ends.
test('backstop: a record still owed after OCR_MAX_PICKS_PER_BURST turns is marked ocr_stale_index and the burst ends', async () => {
  const ws = mkws('pa-ocr-q-');
  put(ws, 'notes', 'e.json', nbOf([page({ strokes: ink(2) })], 100));
  const { index } = ensureIndexed(ws, 'notes');
  const [real] = index.records;
  index.records.push({ ...structuredClone(real), need: { ink: 'deadbeefdeadbeef', photo: null } });   // same key, a need no file holds
  saveIndex(ws, 'notes', index);
  assert.equal(pendingCount(loadIndex(ws, 'notes')), 2, 'the forged index loads (shape-valid) with two records under one key');
  const { calls, ocr } = fakeOcr(); const E = errors();
  const bound = new Promise((_, reject) => setTimeout(() => reject(new Error('the worker did not terminate in 3 s')), 3000).unref());
  await Promise.race([run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0 }), bound]);
  assert.ok(calls.length <= OCR_MAX_PICKS_PER_BURST + 1, `OCR ran at most the cap plus the rebuilt record's turn, got ${calls.length}`);
  assert.ok(E.seen.some((e) => e.code === OCR_STALE_INDEX), 'the spin was reported with its code');
  const after = loadIndex(ws, 'notes');
  assert.deepEqual(after.records.map((r) => [r.src.ink, r.ocrError, isOwed(r, 'ink')]), [['twostrokes #penned', {}, false]], 'the reindex rebuilt the one real record and it was transcribed');
  assert.equal(pendingCount(after), 0);
});

// R13 round 1 #3: one parse of a notebook file per burst, however many ink pages it has (the index is
// re-read per page: it is the progress record and the save hook writes it between pages).
test('a notebook of N ink pages is parsed once per burst, not once per page', async () => {
  const ws = mkws('pa-ocr-q-');
  const f = put(ws, 'notes', 'big.json', nbOf([page({ strokes: ink(1) }), page({ strokes: ink(2) }), page({ strokes: ink(3) })], 100));
  ensureIndexed(ws, 'notes');
  const { calls, ocr } = fakeOcr(); const E = errors();
  const real = fs.readFileSync; let reads = 0;
  fs.readFileSync = function (p, ...a) { if (p === f) reads++; return real.call(this, p, ...a); };
  try { await run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0 }); } finally { fs.readFileSync = real; }
  assert.equal(calls.length, 3, 'three pages transcribed');
  assert.equal(reads, 1, `the notebook file was parsed once for the burst, got ${reads}`);
  // A save in between IS seen: the stamp moves, the cached copy is dropped.
  fs.writeFileSync(f, JSON.stringify(nbOf([page({ strokes: ink(4) })], 101)));
  ensureIndexed(ws, 'notes');
  await run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0 });
  assert.deepEqual(calls.at(-1), ['ink', 4]);
  assert.deepEqual(E.seen, []);
});

// R13 round 1 #4: at most OCR_MAX_IMAGES_PER_PAGE pictures of one page per burst; the rest are counted
// on the record (ocrSkipped), carried across a typed edit like the result itself.
test('pictures per page are capped: the rest are skipped and noted as ocrSkipped on the record', async () => {
  const ws = mkws('pa-ocr-q-');
  fs.mkdirSync(path.join(ws, 'uploads'));
  const imgs = (n) => Array.from({ length: n }, (_, i) => { fs.writeFileSync(path.join(ws, 'uploads', `${i}_p.jpg`), 'x'); return { path: `uploads/${i}_p.jpg`, x: 0, y: 0, w: 1, h: 1 }; });
  const f = put(ws, 'notes', 'many.json', nbOf([page({ images: imgs(OCR_MAX_IMAGES_PER_PAGE + 2) }), page({ images: imgs(2) })], 100));
  ensureIndexed(ws, 'notes');
  const { calls, ocr } = fakeOcr(); const E = errors();
  await run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0 });
  assert.equal(calls.filter((c) => c[0] === 'image').length, OCR_MAX_IMAGES_PER_PAGE + 2, `${OCR_MAX_IMAGES_PER_PAGE} for the crowded page, 2 for the other`);
  const idx = loadIndex(ws, 'notes');
  assert.deepEqual(idx.records.map((r) => [r.page, r.ocrSkipped]), [[0, { photo: 2 }], [1, undefined]], 'the gap is on the record; a page within the cap carries no ocrSkipped');
  assert.equal(pendingCount(idx), 0, 'done at this hash: not retried until the pictures change');
  assert.deepEqual(E.seen, []);
  fs.writeFileSync(f, JSON.stringify(nbOf([page({ images: imgs(OCR_MAX_IMAGES_PER_PAGE + 2), pageHtml: '<div>typed</div>' }), page({ images: imgs(2) })], 101)));
  const again = ensureIndexed(ws, 'notes').index;
  assert.deepEqual([again.records[0].ocrSkipped, again.records[0].src.photo.length > 0, pendingCount(again)], [{ photo: 2 }, true, 0], 'carried with the result');
});

// R13 round 1 #16: the worker's re-read of a notebook is judged like the indexer's: a file swapped for a
// link after indexing is not followed (page_gone), even though the link's target holds the very strokes.
test('a notebook replaced by a link after indexing is refused by the worker, not read through the link', async () => {
  const ws = mkws('pa-ocr-q-');
  const f = put(ws, 'notes', 'e.json', nbOf([page({ strokes: ink(2) })], 100));
  const elsewhere = path.join(mkws('pa-ocr-q-target-'), 'target.json'); fs.copyFileSync(f, elsewhere);
  ensureIndexed(ws, 'notes');
  fs.unlinkSync(f); fs.symlinkSync(elsewhere, f);
  const { calls, ocr } = fakeOcr(); const E = errors();
  await run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0 });
  assert.deepEqual(calls, [], 'nothing was read through the link (the target\'s strokes hash to what is owed, so a follow would have run)');
  assert.deepEqual(E.seen.map((e) => e.code), [PAGE_GONE]);
  assert.equal(pendingCount(loadIndex(ws, 'notes')), 0);
});

// CI (ubuntu, windows): every test above failed with "the worker started: false" — the kick asked
// ocrPossible() about the REAL tool although the OCR was injected. The platform stands in through
// the env hook lib/note-ocr.mjs reads at use time, so this pins the Linux path on a Mac.
// TODO(R4 seam): this file is over budget; split the worker-lifecycle tests (start/again/env) from the indexing ones.
test('an injected `ocr` runs on a Linux node (no Vision, no cmd); the real tool is still refused there', async () => {
  resetOcrEnvState();
  const ws = mkws('pa-ocr-q-');
  put(ws, 'notes', 'a.json', nbOf([page({ strokes: ink(2) })], 100));
  ensureIndexed(ws, 'notes');
  const { calls, ocr } = fakeOcr(); const E = errors();
  process.env.NOTE_OCR_PLATFORM = 'linux';
  try {
    assert.equal(startOcrWorker(ws, 'notes', { onError: E.onError }), false, 'CONTROL: the real tool is refused off macOS');
    await run(ws, 'notes', { ocr, onError: E.onError, saveDebounceMs: 0 });
  } finally { delete process.env.NOTE_OCR_PLATFORM; }
  assert.deepEqual(calls, [['ink', 2]]);
  assert.equal(loadIndex(ws, 'notes').records[0].src.ink, 'twostrokes #penned');
  assert.deepEqual(E.seen, []);
});
