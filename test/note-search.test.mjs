// lib/note-search.mjs — the per-app index store, the scan and the save hook (the matcher's tests
// are test/note-search-match.test.mjs, split for R4). Real files in a throwaway
// workspace (harness fidelity: no Map stands in for the disk), synthetic notebooks only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexFile, loadIndex, saveIndex, listDataFiles, reindexFile, ensureIndexed, search, searchHits, searchIndexed,
  scheduleReindex, splitDataRel, INDEX_DIR, INDEX_VERSION, INDEX_FILE_MAX_BYTES, INDEX_PATH_REFUSED, DATA_PATH_REFUSED, NOTE_INDEX_FAILED } from '../lib/note-search.mjs';
import { buildFileRecords, finishRecord } from '../lib/note-index.mjs';
import { APP_DATA_MAX_BYTES } from '../lib/appdata.mjs';
import { stroke, nb, put, paths, rec } from './helpers-note.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mkws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-note-search-'));

test('the index lives OUTSIDE data/ and round-trips atomically', () => {
  const ws = mkws();
  assert.equal(indexFile(ws, 'notes'), path.join(ws, INDEX_DIR, 'notes.json'));
  assert.ok(!indexFile(ws, 'notes').includes(`${path.sep}data${path.sep}`), 'the broker namespace cannot reach it');
  assert.deepEqual(loadIndex(ws, 'notes'), { v: INDEX_VERSION, files: {}, records: [] }, 'absent → empty');
  const idx = { v: INDEX_VERSION, files: { 'a.json': { mtimeMs: 1, size: 2 } }, records: [rec('a.json', '', 0, 1, 'x')] };
  saveIndex(ws, 'notes', idx);
  assert.deepEqual(loadIndex(ws, 'notes'), idx);
  assert.equal(fs.readdirSync(path.join(ws, INDEX_DIR)).filter((f) => f.includes('tmp')).length, 0, 'no tmp file left behind');
  fs.writeFileSync(indexFile(ws, 'notes'), '{not json');
  assert.deepEqual(loadIndex(ws, 'notes'), { v: INDEX_VERSION, files: {}, records: [] }, 'a corrupt index is derived data: rebuilt, not fatal');
  fs.writeFileSync(indexFile(ws, 'notes'), JSON.stringify({ v: INDEX_VERSION + 1, files: {}, records: [] }));
  assert.deepEqual(loadIndex(ws, 'notes').records, [], 'an unknown version starts over');
  // Valid JSON of the wrong shape is rebuilt too — not handed back to throw on every search.
  put(ws, 'notes', 'entry-1.json', nb('<div>hello</div>'));
  for (const bad of [{ v: INDEX_VERSION, files: null, records: [] }, { v: INDEX_VERSION, files: {}, records: [null] },
    { v: INDEX_VERSION, files: [], records: [] }, { v: INDEX_VERSION, files: {}, records: [{ ...rec('a.json', '', 0, 1, 'x'), path: 1 }] },
    // R13 round 2 #1: members search() touches, off-type inside a shape the old check accepted — each
    // once made EVERY later search throw, with nothing dirty to trigger a rewrite.
    { v: INDEX_VERSION, files: { 'entry-1.json': { mtimeMs: 1, size: 2 } }, records: [{ ...rec('entry-1.json', '', 0, 1, 'x'), tags: [1] }] },
    { v: INDEX_VERSION, files: { 'entry-1.json': { mtimeMs: 1, size: 2 } }, records: [{ ...rec('entry-1.json', '', 0, 1, 'x'), src: { typed: 5, ink: '', photo: '' } }] },
    { v: INDEX_VERSION, files: { 'entry-1.json': { mtimeMs: 1, size: 2 } }, records: [{ ...rec('entry-1.json', '', 0, 1, 'x'), updated: '1' }] },
    { v: INDEX_VERSION, files: { 'entry-1.json': { mtimeMs: 1, size: 2 } }, records: [{ ...rec('entry-1.json', '', 0, 1, 'x'), idx: { ...rec('x', '', 0, 1, 'x').idx, typed: { runs: [1], bi: [] } } }] },
    // Phase 2 members, each off-type once: an OCR result that cannot land must not poison the index.
    { v: INDEX_VERSION, files: { 'entry-1.json': { mtimeMs: 1, size: 2 } }, records: [{ ...rec('entry-1.json', '', 0, 1, 'x'), need: { ink: 5, photo: null } }] },
    { v: INDEX_VERSION, files: { 'entry-1.json': { mtimeMs: 1, size: 2 } }, records: [{ ...rec('entry-1.json', '', 0, 1, 'x'), labels: 'doc' }] },
    { v: INDEX_VERSION, files: { 'entry-1.json': { mtimeMs: 1, size: 2 } }, records: [{ ...rec('entry-1.json', '', 0, 1, 'x'), boxes: { ink: [] } }] },
    { v: INDEX_VERSION, files: { 'entry-1.json': { mtimeMs: 1, size: 2 } }, records: [{ ...rec('entry-1.json', '', 0, 1, 'x'), ocrError: null }] },
    { v: INDEX_VERSION, files: { 'entry-1.json': { mtimeMs: 1, size: 2 } }, records: [{ ...rec('entry-1.json', '', 0, 1, 'x'), idx: undefined }] }]) {
    fs.writeFileSync(indexFile(ws, 'notes'), JSON.stringify(bad));
    assert.deepEqual(loadIndex(ws, 'notes'), { v: INDEX_VERSION, files: {}, records: [] }, `malformed → empty: ${JSON.stringify(bad)}`);
    assert.deepEqual(paths(search(ensureIndexed(ws, 'notes').index, 'hello')), ['entry-1.json'], 'and the next scan rebuilds it');
  }
  // The stamp of the off-type index MATCHES the data file (nothing dirty): without the typed check
  // loadIndex hands it back, ensureIndexed rewrites nothing and search throws forever.
  const st = fs.statSync(path.join(ws, 'data', 'notes', 'entry-1.json'));
  fs.writeFileSync(indexFile(ws, 'notes'), JSON.stringify({ v: INDEX_VERSION, files: { 'entry-1.json': { mtimeMs: st.mtimeMs, size: st.size } }, records: [{ ...rec('entry-1.json', '', 0, 1, 'hello'), tags: [1] }] }));
  assert.deepEqual(paths(search(ensureIndexed(ws, 'notes').index, 'hello')), ['entry-1.json'], 'an off-type record under a current stamp is still rebuilt, not searched');
});

// R13 round 2 #1, the second wall: an index that loads but will not search is reset and rebuilt
// ONCE on the request path, never left to answer 500 until someone deletes the file by hand.
test('searchIndexed resets and rebuilds the index once when the matcher throws; a second throw is let through', () => {
  const ws = mkws();
  put(ws, 'notes', 'entry-1.json', nb('<div>hello there</div>'));
  const plain = searchIndexed(ws, 'notes', 'hello');
  assert.deepEqual([paths(plain.hits), plain.errors, plain.reset], [['entry-1.json'], [], null], 'CONTROL: no throw, no reset');
// TODO(R4 seam): this file is over budget; split the searchIndexed reset/rebuild tests from the plain search() ones.
  // A marker on the file as it stands: a rebuild writes the index afresh (no trailing newline), so
  // the marker gone proves the file was replaced. (Not the inode: ext4 reuses a freed inode number,
  // and the rebuilt index has the same bytes as the first, so size cannot tell either — CI ubuntu.)
  const MARK = '\n';
  fs.appendFileSync(indexFile(ws, 'notes'), MARK);
  searchIndexed(ws, 'notes', 'hello');
  assert.ok(fs.readFileSync(indexFile(ws, 'notes'), 'utf8').endsWith(MARK), 'CONTROL: a search that needs no reset leaves the marked file alone');
  let calls = 0;
  const once = (index, q, o) => { if (++calls === 1) throw new TypeError('t.startsWith is not a function'); return searchHits(index, q, o); };
  const healed = searchIndexed(ws, 'notes', 'hello', { matcher: once });
  assert.equal(calls, 2, 'matched again after the reset');
  assert.deepEqual(paths(healed.hits), ['entry-1.json'], 'the rebuilt index answers');
  assert.match(healed.reset, /startsWith/, 'the reset is reported for the audit');
  assert.ok(!fs.readFileSync(indexFile(ws, 'notes'), 'utf8').endsWith(MARK), 'the index file on disk was replaced (reset, then rebuilt)');
  assert.deepEqual(paths(search(loadIndex(ws, 'notes'), 'hello')), ['entry-1.json'], 'and what is on disk is the rebuilt index, not the empty one');
  assert.throws(() => searchIndexed(ws, 'notes', 'hello', { matcher: () => { throw new Error('still broken'); } }), /still broken/, 'one reset, then the error reaches the route');
});

test('the index is never written or read through a link at <ws>/search (the workspace write rule)', async () => {
  const ws = mkws(); const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-victim-'));
  put(ws, 'notes', 'entry-1.json', nb('<div>secret journal text #tag</div>'));
  fs.symlinkSync(victim, path.join(ws, INDEX_DIR), 'junction');
  assert.throws(() => ensureIndexed(ws, 'notes'), { code: INDEX_PATH_REFUSED }, 'the scan refuses with a code');
  assert.throws(() => loadIndex(ws, 'notes'), { code: INDEX_PATH_REFUSED });
  assert.throws(() => saveIndex(ws, 'notes', { v: INDEX_VERSION, files: {}, records: [] }), { code: INDEX_PATH_REFUSED });
  const errors = [];
  scheduleReindex(ws, 'data/notes/entry-1.json', { delayMs: 5, onError: (e) => errors.push(e) });
  await sleep(60);
  assert.equal(errors.length, 1, 'the save hook reports it to its owner');
  assert.equal(errors[0].code, INDEX_PATH_REFUSED);
  assert.deepEqual(fs.readdirSync(victim), [], 'nothing landed where the link points');
});

test('the save hook never recreates a workspace tombstoned while its timer ran; saveIndex never builds the root', async () => {
  const ws = mkws();
  put(ws, 'notes', 'entry-1.json', nb('<div>soon gone</div>'));
  const errors = [];
  scheduleReindex(ws, 'data/notes/entry-1.json', { delayMs: 20, onError: (e) => errors.push(e) });
  fs.renameSync(ws, `${ws}.deleted-1`);          // what the delete route does
  await sleep(80);
  assert.ok(!fs.existsSync(ws), 'the retired folder stays retired');
  assert.deepEqual(errors, [], 'and nothing is reported: there was nothing to index');
  assert.throws(() => saveIndex(ws, 'notes', { v: INDEX_VERSION, files: {}, records: [] }), { code: 'ENOENT' });
  assert.ok(!fs.existsSync(ws), 'a direct save on a missing workspace creates nothing');
});

test('listDataFiles: *.json under data/<slug>/, recursive, never .bak or dot entries', () => {
  const ws = mkws();
  put(ws, 'bible', 'notes/1-1.json', {}); put(ws, 'bible', 'notes/1-1.json.bak', {}); put(ws, 'bible', 'settings.json', {});
  put(ws, 'bible', '.hidden.json', {}); put(ws, 'bible', 'notes/readme.md', 'x');
  assert.deepEqual(listDataFiles(ws, 'bible').sort(), ['notes/1-1.json', 'settings.json']);
  assert.deepEqual(listDataFiles(ws, 'nothing'), [], 'no data folder yet: nothing, no throw');
});

// R13 round 2 #8: the scan must not read through a link. A link ENTRY under data/<slug> is listed,
// refused and remembered like an unparsable file; data/<slug> or data/ that IS a link is refused
// with a code (the member-plants-a-link-to-the-owner's-journal case).
test('a symlinked directory under data/<slug> is never walked: no records from it, one error, reported once', () => {
  const ws = mkws(); const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-victim-'));
  fs.writeFileSync(path.join(victim, 'owner.json'), JSON.stringify(nb('<div>secret owner text</div>')));
  put(ws, 'notes', 'mine.json', nb('<div>my own words</div>'));
  fs.symlinkSync(victim, path.join(ws, 'data', 'notes', 'linked'), 'junction');
  fs.symlinkSync(path.join(victim, 'owner.json'), path.join(ws, 'data', 'notes', 'alias.json'));
  assert.deepEqual(listDataFiles(ws, 'notes').sort(), ['alias.json', 'linked', 'mine.json'], 'links are listed to be judged, never descended');
  const a = ensureIndexed(ws, 'notes');
  assert.deepEqual(a.errors.map((e) => e.path).sort(), ['alias.json', 'linked']);
  assert.match(a.errors[0].error, /is a link: not indexed/);
  assert.deepEqual(search(a.index, 'secret'), [], 'nothing behind a link is indexed');
  assert.deepEqual(paths(search(a.index, 'words')), ['mine.json'], 'CONTROL: the real file answers');
  assert.ok(!fs.readFileSync(indexFile(ws, 'notes'), 'utf8').includes('secret'), 'and the victim\'s text is nowhere in this workspace');
  assert.deepEqual(ensureIndexed(ws, 'notes').errors, [], 'reported once: remembered under the link\'s own stamp');
});

test('data/<slug> or data/ that IS a link is refused with a code before anything is read', () => {
  const victim = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-victim-'));
  fs.writeFileSync(path.join(victim, 'owner.json'), JSON.stringify(nb('<div>secret owner text</div>')));
  const slugLink = mkws(); fs.mkdirSync(path.join(slugLink, 'data')); fs.symlinkSync(victim, path.join(slugLink, 'data', 'notes'), 'junction');
  assert.throws(() => listDataFiles(slugLink, 'notes'), { code: DATA_PATH_REFUSED });
  assert.throws(() => ensureIndexed(slugLink, 'notes'), { code: DATA_PATH_REFUSED });
  assert.throws(() => reindexFile(slugLink, 'notes', 'owner.json', { v: INDEX_VERSION, files: {}, records: [] }), { code: DATA_PATH_REFUSED }, 'the save hook\'s path is judged too');
  assert.ok(!fs.existsSync(indexFile(slugLink, 'notes')), 'no index was written');
  const dataLink = mkws(); fs.mkdirSync(path.join(victim, 'notes')); fs.symlinkSync(victim, path.join(dataLink, 'data'), 'junction');
  assert.throws(() => ensureIndexed(dataLink, 'notes'), { code: DATA_PATH_REFUSED });
});

test('BACKFILL: files already on disk (never saved through any route) are indexed on the first search', () => {
  const ws = mkws();
  put(ws, 'notes', 'entry-1.json', nb('<div>Met the landlord about the roof</div>'));
  put(ws, 'notes', 'journal.json', { v: 3, entries: [{ id: '1', title: 'x' }] });        // the journal index: not a notebook
  put(ws, 'bible', 'notes/43-3.json', { draws: { v16: nb('<div>God so loved 神爱世人</div>'), 'free-1788000000000': nb('<div>#祷告 for the kids</div>') }, notes: { v1: 'plain' } });
  const a = ensureIndexed(ws, 'notes');
  assert.deepEqual(a.errors, []);
  assert.deepEqual(paths(search(a.index, 'landlord')), ['entry-1.json']);
  assert.equal(a.index.records.length, 1, 'journal.json contributes no record');
  assert.ok(fs.existsSync(indexFile(ws, 'notes')), 'and the index was written');
  const b = ensureIndexed(ws, 'bible');
  assert.deepEqual(paths(search(b.index, '神爱')), ['notes/43-3.json#v16']);
  assert.deepEqual(paths(search(b.index, '#祷告')), ['notes/43-3.json#free-1788000000000']);
  assert.deepEqual(search(a.index, '神爱'), [], 'one app\'s index never answers for another');
});

test('new, changed and deleted files are tracked by mtime + size; unchanged ones are not re-read', () => {
  const ws = mkws();
  const f = put(ws, 'notes', 'entry-1.json', nb('<div>first words</div>'));
  put(ws, 'notes', 'entry-2.json', nb('<div>second</div>'));
  const first = ensureIndexed(ws, 'notes').index;
  assert.equal(first.records.length, 2);
  // Changed: same size would hide an edit, so the mtime moves too (the real save rewrites the file).
  fs.writeFileSync(f, JSON.stringify(nb('<div>other words</div>')));
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  put(ws, 'notes', 'entry-3.json', nb('<div>third</div>'));
  fs.unlinkSync(path.join(ws, 'data', 'notes', 'entry-2.json'));
  const second = ensureIndexed(ws, 'notes').index;
  assert.deepEqual(paths(search(second, 'other')), ['entry-1.json'], 'the edit is seen');
  assert.deepEqual(search(second, 'first'), [], 'and the old words are gone');
  assert.deepEqual(search(second, 'second'), [], 'a deleted file\'s records are dropped');
  assert.deepEqual(paths(search(second, 'third')), ['entry-3.json'], 'a new file is picked up');
  assert.deepEqual(Object.keys(second.files).sort(), ['entry-1.json', 'entry-3.json']);
  // Unchanged: a third pass rewrites nothing.
  const stamp = fs.statSync(indexFile(ws, 'notes')).mtimeMs;
  ensureIndexed(ws, 'notes');
  assert.equal(fs.statSync(indexFile(ws, 'notes')).mtimeMs, stamp, 'nothing moved, nothing written');
});

test('a file that will not parse is REPORTED and dropped, never kept stale or skipped quietly', () => {
  const ws = mkws();
  put(ws, 'notes', 'entry-1.json', nb('<div>fine</div>'));
  const f = put(ws, 'notes', 'entry-2.json', nb('<div>soon broken</div>'));
  const ok = ensureIndexed(ws, 'notes');
  assert.equal(ok.index.records.length, 2);
  fs.writeFileSync(f, '{"pages":[{"pageHtml":"<div>half');
  fs.utimesSync(f, new Date(), new Date(Date.now() + 5000));
  const bad = ensureIndexed(ws, 'notes');
  assert.equal(bad.errors.length, 1);
  assert.equal(bad.errors[0].path, 'entry-2.json');
  assert.match(bad.errors[0].error, /not valid JSON/);
  assert.deepEqual(search(bad.index, 'soon'), [], 'its stale records are gone');
  assert.deepEqual(paths(search(bad.index, 'fine')), ['entry-1.json'], 'CONTROL: the good file still answers');
  assert.equal(reindexFile(ws, 'notes', 'gone.json', bad.index).ok, true, 'a missing file is simply absent');
  // Reported ONCE: an unchanged broken file is remembered with its stamp, not re-parsed, re-reported
  // and the index rewritten on every keystroke.
  const stamp = fs.statSync(indexFile(ws, 'notes'));
  const again = ensureIndexed(ws, 'notes');
  assert.deepEqual(again.errors, [], 'the second scan says nothing new');
  assert.deepEqual([fs.statSync(indexFile(ws, 'notes')).mtimeMs, fs.statSync(indexFile(ws, 'notes')).ino], [stamp.mtimeMs, stamp.ino], 'and the index is not rewritten');
  assert.equal(again.index.files['entry-2.json'].error, bad.errors[0].error, 'the failure is kept with the stamp');
  fs.writeFileSync(f, JSON.stringify(nb('<div>mended</div>')));
  fs.utimesSync(f, new Date(), new Date(Date.now() + 10000));
  const fixed = ensureIndexed(ws, 'notes');
  assert.deepEqual(fixed.errors, []);
  assert.deepEqual(paths(search(fixed.index, 'mended')), ['entry-2.json'], 'a repaired file is retried once its stamp moves');
});

test('a data file over the byte cap is skipped and reported once, never parsed', () => {
  assert.equal(INDEX_FILE_MAX_BYTES, APP_DATA_MAX_BYTES, 'the cap is the save-side cap (R3)');
  const ws = mkws();
  put(ws, 'notes', 'small.json', nb('<div>small words</div>'));
  const big = put(ws, 'notes', 'big.json', nb(`<div>big words ${'x'.repeat(2000)}</div>`));
  const control = ensureIndexed(ws, 'notes');
  assert.deepEqual(paths(search(control.index, 'words')).sort(), ['big.json', 'small.json'], 'CONTROL: under the real cap both are indexed');
  const ws2 = mkws();
  put(ws2, 'notes', 'small.json', nb('<div>small words</div>'));
  put(ws2, 'notes', 'big.json', nb(`<div>big words ${'x'.repeat(2000)}</div>`));
  const cap = fs.statSync(big).size - 1;
  const a = ensureIndexed(ws2, 'notes', { maxBytes: cap });
  assert.deepEqual(a.errors.map((e) => e.path), ['big.json']);
  assert.match(a.errors[0].error, /over the \d+-byte cap/);
  assert.deepEqual(paths(search(a.index, 'words')), ['small.json'], 'the big file is skipped, the small one answers');
  assert.deepEqual(ensureIndexed(ws2, 'notes', { maxBytes: cap }).errors, [], 'reported once');
});

test('the save hook: debounced per file, reindexes once, failures reach onError', async () => {
  const ws = mkws();
  put(ws, 'notes', 'entry-1.json', nb('<div>typed fast</div>'));
  assert.deepEqual(splitDataRel('data/notes/entry-1.json'), { slug: 'notes', relPath: 'entry-1.json' });
  assert.deepEqual(splitDataRel('data/bible/notes/1-3.json'), { slug: 'bible', relPath: 'notes/1-3.json' });
  assert.equal(splitDataRel('profile.json'), null, 'not app data: nothing to do');
  assert.equal(splitDataRel('data/Bad Slug/x.json'), null);
  assert.equal(scheduleReindex(ws, 'data/notes/x.md', { delayMs: 1 }), false, 'markdown is not a notebook');
  const errors = [];
  // Counted, not inferred: every index write ends in ONE rename onto the index path (writeFileAtomic), so
  // the renames onto it across a burst are the reindex count. Five identical reindexes would leave the
  // same index, which is why "it is indexed afterwards" alone could not see a lost debounce (R14).
  const f = indexFile(ws, 'notes'), realRename = fs.renameSync;
  let writes = 0;
  fs.renameSync = (from, to) => { if (to === f) writes += 1; return realRename(from, to); };
  try {
    for (let i = 0; i < 5; i += 1) { scheduleReindex(ws, 'data/notes/entry-1.json', { delayMs: 30, onError: (e) => errors.push(e) }); await sleep(5); }
    await sleep(120);
  } finally { fs.renameSync = realRename; }
  assert.deepEqual(errors, []);
  assert.equal(writes, 1, 'a burst of saves is ONE reindex');
  assert.deepEqual(paths(search(loadIndex(ws, 'notes'), 'typed')), ['entry-1.json'], 'indexed after the burst settled');
  fs.writeFileSync(path.join(ws, 'data', 'notes', 'entry-1.json'), '{broken');
  scheduleReindex(ws, 'data/notes/entry-1.json', { delayMs: 10, onError: (e) => errors.push(e) });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(errors.length, 1, 'a file that will not parse is reported to the hook\'s owner');
  assert.match(errors[0].message, /not valid JSON/);
});

test('the audit event name for an index failure is ONE exported constant used at both web.mjs sites (R3)', () => {
  assert.equal(NOTE_INDEX_FAILED, 'note-index-failed');
  const src = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  assert.ok(!src.includes("'note-index-failed'"), 'web.mjs spells the literal nowhere');
  assert.equal((src.match(/audit\(NOTE_INDEX_FAILED,/g) || []).length, 4, 'the search route (a broken file, an index reset), the note-text route (a broken file) and the save hook all use it');
});

test('a v3 index loads at v4 with its OCR kept: a single-file save in between never wipes it, and a deleted file\'s records are dropped', () => {
  const ws = mkws();
  put(ws, 'notes', 'entry-1.json', nb('<div>kept words</div>'));
  put(ws, 'notes', 'entry-2.json', nb('<div>also kept</div>'));
  const v4 = ensureIndexed(ws, 'notes').index;
  const r2 = v4.records.find((r) => r.path === 'entry-2.json');
  const inkRec = finishRecord({ ...r2, src: { ...r2.src, ink: 'handwritten line' }, done: { ...r2.done, ink: r2.need.ink } });   // as the queue would leave it
  const v3 = { ...v4, v: INDEX_VERSION - 1, files: { ...v4.files, 'entry-gone.json': { mtimeMs: 1, size: 2 } },
    records: [...v4.records.filter((r) => r.path !== 'entry-2.json'), inkRec, rec('entry-gone.json', '', 0, 1, 'vanished')].map(({ geo, ...r }) => r) };
  fs.writeFileSync(indexFile(ws, 'notes'), JSON.stringify(v3));
  // The first touch after deploy is an AUTOSAVE of one file, not a full scan (R13 p3 #1).
  const loaded = loadIndex(ws, 'notes');
  assert.equal(loaded.v, INDEX_VERSION);
  reindexFile(ws, 'notes', 'entry-1.json', loaded);
  saveIndex(ws, 'notes', loaded);
  const again = loadIndex(ws, 'notes');
  assert.equal(again.records.length, 3, 'nothing was thrown away by the single-file save');
  const scanned = ensureIndexed(ws, 'notes').index;
  assert.deepEqual(paths(search(scanned, 'vanished')), [], 'a file deleted while on v3 is dropped by the first scan');
  assert.deepEqual(paths(search(scanned, 'handwritten')), ['entry-2.json'], 'OCR text survives the re-read (carryOcr)');
  assert.ok(scanned.records.every((r) => r.geo), 'every surviving record was re-read and has geometry');
});

test('a v5 index loads at v6 with its OCR kept: a single-file autosave before the full scan never wipes it; the scan fills emph/imp without re-transcribing', () => {
  const ws = mkws();
  put(ws, 'notes', 'entry-1.json', nb('<div>kept words</div>'));
  const two = nb('<div>Keep <span style="background-color: rgba(250, 204, 21, 0.4);">this</span></div>');
  two.pages[0].strokes.push({ c: '#facc15', w: 0.02, t: 'highlighter', p: [[0.05, 0.02, 0.5], [0.75, 0.02, 0.5], [0.05, 0.07, 0.5], [0.75, 0.07, 0.5]] });
  put(ws, 'notes', 'entry-2.json', two);
  const v6 = ensureIndexed(ws, 'notes').index;
  const r2 = v6.records.find((r) => r.path === 'entry-2.json');
  // As the queue would leave it on v5: the OCR line lands, then every v6-only member is stripped.
  const inkRec = finishRecord({ ...r2, src: { ...r2.src, ink: 'handwritten line' }, done: { ...r2.done, ink: r2.need.ink }, boxes: { ink: [{ t: 'handwritten line', box: [0.1, 0.1, 0.6, 0.1] }], photo: [] } });
  const v5 = { ...v6, v: INDEX_VERSION - 1, files: { ...v6.files, 'entry-gone.json': { mtimeMs: 1, size: 2 } },
    records: [...v6.records.filter((r) => r.path !== 'entry-2.json'), inkRec, rec('entry-gone.json', '', 0, 1, 'vanished')].map(({ emph, imp, ...r }) => r) };
  assert.ok(v5.records.every((r) => !('emph' in r) && !('imp' in r)), 'the fixture is a v5 index');
  fs.writeFileSync(indexFile(ws, 'notes'), JSON.stringify(v5));
  const loaded = loadIndex(ws, 'notes');
  assert.equal(loaded.v, INDEX_VERSION, 'loads, not rebuilt from empty');
  reindexFile(ws, 'notes', 'entry-1.json', loaded);   // the first touch after deploy: ONE file's autosave
  saveIndex(ws, 'notes', loaded);
  const again = loadIndex(ws, 'notes');
  assert.equal(again.records.length, 3, 'nothing was thrown away by the single-file save (imp/emph optional in recordOk)');
  const scanned = ensureIndexed(ws, 'notes').index;
  assert.deepEqual(paths(search(scanned, 'vanished')), [], 'a file deleted while on v5 is dropped by the first scan');
  assert.deepEqual(paths(search(scanned, 'handwritten')), ['entry-2.json'], 'OCR text survives the re-read (carryOcr): no page is transcribed again');
  const s2 = scanned.records.find((r) => r.path === 'entry-2.json');
  assert.equal(s2.emph.hl.length, 1, 'the re-read found the highlighter stroke');
  assert.deepEqual(s2.imp, { ink: [0], typed: ['this'] }, 'and the carried OCR line under it is important, with the typed highlight');
  assert.ok(scanned.records.every((r) => r.emph && r.imp), 'every surviving record was re-read and has emphasis members');
});
