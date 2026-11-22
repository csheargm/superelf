// GET /api/note-search over the REAL web.mjs (helpers-web harness, throwaway root) and the
// save-data hook that keeps the index warm. Synthetic notebooks only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, waitFor, PNG_B64 } from './helpers-web.mjs';
import { INDEX_DIR } from '../lib/note-search.mjs';
import { NOTE_OCR_FAILED, UPLOADS_DIR, uploadFile } from '../lib/note-ocr-queue.mjs';
import { nb, put as putIn } from './helpers-note.mjs';   // R3: the one notebook shape (R13 round 1 #11)

let port, root, web, WS;
const put = (rel, obj) => putIn(WS, rel.slice(0, rel.indexOf('/')), rel.slice(rel.indexOf('/') + 1), obj);
const auditLines = (re) => fs.readFileSync(path.join(root, 'audit.log'), 'utf8').split('\n').filter((l) => re.test(l));
const get = async (qs) => { const r = await api(port, `/api/note-search${qs}`); return { status: r.status, body: await r.json() }; };

before(async () => {
  port = await freePort(); root = mkWebRoot({ port }); WS = path.join(root, 'workspace');
  // On disk BEFORE the server ever sees a save: the "existing notes become searchable" guarantee.
  put('notes/entry-1.json', nb('<div>Met the landlord about the roof #ores</div>'));
  put('notes/journal.json', { v: 3, entries: [{ id: '1', title: 'x' }] });
  put('bible/notes/43-3.json', { draws: { v16: nb('<div>神爱世人 so loved</div>') } });
  put('notes/broken.json', '{"pages":[{"pageHtml":"<div>half');      // on disk too: must be audited, never 500 the search
  put('notes/entry-0.json', { v: 1, id: '0', text: '<div>Legacy <b>prayer</b> list #old</div>', draw: null });   // the pre-notebook journal shape
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); });

test('backfill: pre-existing notebooks answer on the first search, per app', async () => {
  const a = await get('?app=notes&q=landlord');
  assert.equal(a.status, 200);
  assert.equal(a.body.ok, true);
  assert.deepEqual(a.body.hits.map((h) => [h.path, h.scope, h.where]), [['entry-1.json', '', 'typed']]);
  assert.match(a.body.hits[0].snippet, /landlord/);
  const t = await get('?app=notes&q=%23ores');
  assert.deepEqual(t.body.hits.map((h) => h.where), ['tag']);
  const b = await get('?app=bible&q=' + encodeURIComponent('神爱'));
  assert.deepEqual(b.body.hits.map((h) => [h.path, h.scope]), [['notes/43-3.json', 'v16']]);
  assert.deepEqual((await get('?app=notes&q=' + encodeURIComponent('神爱'))).body.hits, [], 'apps do not see each other');
  assert.ok(fs.existsSync(path.join(WS, INDEX_DIR, 'notes.json')), 'the index sits at <ws>/search/, outside data/');
  assert.ok(!fs.existsSync(path.join(WS, 'data', 'notes', 'search')) && !fs.existsSync(path.join(WS, 'data', INDEX_DIR)), 'and nowhere under data/');
});

// R13 round 2 #6: the route's own audit of a notebook that will not parse, through the real server.
test('an unparsable notebook is audited ONCE through the route (path and reason), and the good hits still answer', async () => {
  const r = await get('?app=notes&q=landlord');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.hits.map((h) => h.path), ['entry-1.json'], 'the broken file costs nothing but its own records');
  await get('?app=notes&q=landlord');                                   // a second search: same stamp, nothing new to say
  const lines = auditLines(/note-index-failed/);
  assert.equal(lines.length, 1, `audited once across the searches so far, got:\n${lines.join('\n')}`);
  assert.match(lines[0], /"path":"data\/notes\/broken\.json"/, 'the route names the file under data/<app>/');
  assert.match(lines[0], /not valid JSON/, 'with lib\'s reason, not "undefined"');
});

// R13 round 2 #2: the legacy journal entry ({text, draw}) answers at scope '' with its text indexed.
test('a legacy journal entry is searchable by its text, at the root scope the journal row claims', async () => {
  const r = await get('?app=notes&q=prayer');
  assert.deepEqual(r.body.hits.map((h) => [h.path, h.scope, h.where]), [['entry-0.json', '', 'typed']]);
  assert.deepEqual((await get('?app=notes&q=%23old')).body.hits.map((h) => [h.path, h.scope, h.where]), [['entry-0.json', '', 'tag']]);
});

test('guards: a bad slug is refused with a code; an empty query is an empty answer, not a scan', async () => {
  for (const bad of ['?q=x', '?app=../notes&q=x', '?app=Notes&q=x', '?app=con&q=x']) {
    const r = await get(bad);
    assert.equal(r.status, 400, bad);
    assert.deepEqual(r.body, { ok: false, error: 'bad app', code: 'bad_app' });
  }
  assert.deepEqual((await get('?app=notes')).body, { ok: true, hits: [], truncated: false });
  assert.deepEqual((await get('?app=notes&q=%20%20')).body, { ok: true, hits: [], truncated: false });
  assert.deepEqual((await get('?app=nothing-here&q=x')).body, { ok: true, hits: [], truncated: false, terms: ['x'], pending: 0, ocr: 'ready' }, 'an app with no data folder yet has no hits, no error, nothing to transcribe');
});

test('a save through /api/save-data becomes searchable; a .bak never double-counts', async () => {
  const save = await api(port, '/api/save-data', { method: 'POST', body: JSON.stringify({ path: 'data/notes/entry-2.json', data: JSON.stringify(nb('<div>Prayer list 祷告 恩典 #灵修</div>')) }) });
  assert.equal(save.status, 200, await save.text());
  // The lazy scan sees the new file at once (the debounced hook only keeps the index warm).
  const r = await get('?app=notes&q=' + encodeURIComponent('恩典'));
  assert.deepEqual(r.body.hits.map((h) => h.path), ['entry-2.json']);
  // The hook itself: after the debounce the index already holds the file without another search.
  const save2 = await api(port, '/api/save-data', { method: 'POST', body: JSON.stringify({ path: 'data/notes/entry-3.json', data: JSON.stringify(nb('<div>hooked words</div>')) }) });
  assert.equal(save2.status, 200);
  await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(WS, INDEX_DIR, 'notes.json'), 'utf8')).files['entry-3.json']; } catch { return false; } }, 'the save hook to index entry-3', { timeoutMs: 6000 });
  // A rolling backup beside the file must not be indexed as a second copy.
  fs.copyFileSync(path.join(WS, 'data', 'notes', 'entry-2.json'), path.join(WS, 'data', 'notes', 'entry-2.json.bak'));
  const again = await get('?app=notes&q=' + encodeURIComponent('恩典'));
  assert.equal(again.body.hits.length, 1);
});

// ── Phase 2: the reply says what handwriting is still owed, and a search backfills it ──
// The harness server's `note_ocr_cmd` is the committed fake tool (helpers-web), so this is the real
// queue, the real execFile and the real index, with Vision stood in for.
// (The KICK by a search is pinned in test/note-search-route-kick.test.mjs on a server that saw no
// save: here the save hook's worker drains the whole app, so this suite cannot tell the two apart.)
test('a search reports pages awaiting OCR; once transcribed, handwriting and its #tags answer with where:ink', async () => {
  const r = await get('?app=notes&q=landlord');
  assert.equal(r.body.ocr, 'ready', 'the fake tool is an executable: status ready');
  assert.equal(typeof r.body.pending, 'number');
  // Every fixture page carries a stroke: the save hook's worker (and the first searches) drain them.
  // Drained = the index on disk owes nothing AND a save's 2 s hook can no longer add a page behind
  // our back (the saves above are older than that by the time three pages are transcribed).
  const indexNow = () => JSON.parse(fs.readFileSync(path.join(WS, INDEX_DIR, 'notes.json'), 'utf8'));
  await waitFor(async () => (await get('?app=notes&q=landlord')).body.pending === 0 && indexNow().records.filter((x) => x.need.ink && x.done.ink === x.need.ink).length >= 3, 'the notes backlog to drain', { timeoutMs: 15000 });
  const ink = await get('?app=notes&q=saturday');
  assert.ok(ink.body.hits.length >= 1, 'pass B\'s word is found');
  assert.ok(ink.body.hits.every((h) => h.where === 'ink'), `where:ink, got ${JSON.stringify(ink.body.hits.map((h) => h.where))}`);
  assert.match(ink.body.hits[0].snippet, /Saturday pollen moderate/);
  const tag = await get('?app=notes&q=' + encodeURIComponent('#墨水'));
  assert.ok(tag.body.hits.length >= 1 && tag.body.hits.every((h) => h.where === 'tag'), 'a handwritten tag is a tag hit');
  const typed = await get('?app=notes&q=landlord');
  assert.deepEqual(typed.body.hits.map((h) => h.where), ['typed'], 'a typed word still ranks as typed, and the typed snippet is kept');
  assert.match(typed.body.hits[0].snippet, /landlord/);
  const idx = indexNow();
  assert.ok(idx.records.filter((x) => x.src.ink).length >= 3, 'the OCR text is in the index file (progress survives a restart)');
  assert.deepEqual(auditLines(new RegExp(NOTE_OCR_FAILED)), [], 'no page failed');
});

test('a save with new strokes is transcribed by the hook without another search; a failing page is audited once with the event name', async () => {
  const strokes = [{ c: '#141414', w: 0.002, p: [[0.3, 0.3, 0.5]] }, { c: '#141414', w: 0.002, p: [[0.4, 0.3, 0.5]] }];
  const save = await api(port, '/api/save-data', { method: 'POST', body: JSON.stringify({ path: 'data/notes/entry-5.json', data: JSON.stringify({ ...nb(''), pages: [{ id: 'p', created: 1, updated: 2, strokes, pageHtml: '', images: [] }] }) }) });
  assert.equal(save.status, 200);
  await waitFor(() => { try { return (JSON.parse(fs.readFileSync(path.join(WS, INDEX_DIR, 'notes.json'), 'utf8')).records.find((x) => x.path === 'entry-5.json') || {}).src?.ink; } catch { return false; } }, 'the save hook to index and transcribe entry-5', { timeoutMs: 10000 });
  const r = await get('?app=notes&q=' + encodeURIComponent('moderate 2'));
  assert.deepEqual(r.body.hits.map((h) => [h.path, h.where]), [['entry-5.json', 'ink']], 'the fake names the stroke count: this page has 2');
  // A picture whose path is not under uploads/: refused with a code, audited ONCE, never retried at that content.
  const bad = { ...nb(''), pages: [{ id: 'p', created: 1, updated: 2, strokes: [], pageHtml: '', images: [{ path: '../secrets.jpg', x: 0, y: 0, w: 1, h: 1 }] }] };
  assert.equal((await api(port, '/api/save-data', { method: 'POST', body: JSON.stringify({ path: 'data/notes/entry-6.json', data: JSON.stringify(bad) }) })).status, 200);
  await waitFor(() => auditLines(new RegExp(NOTE_OCR_FAILED)).length >= 1, 'the refused picture to be audited', { timeoutMs: 10000 });
  await get('?app=notes&q=x'); await get('?app=notes&q=x');
  await new Promise((d) => setTimeout(d, 300));
  const lines = auditLines(new RegExp(NOTE_OCR_FAILED));
  assert.equal(lines.length, 1, `once, got:\n${lines.join('\n')}`);
  assert.match(lines[0], /"path":"entry-6\.json"/); assert.match(lines[0], /"code":"upload_path_refused"/); assert.match(lines[0], /"source":"photo"/);
  assert.equal((await get('?app=notes&q=x')).body.pending, 0, 'a failed page is not pending');
});

// R13 round 1 #9/#15: the writer (/api/upload) and the reader (the queue's uploadFile) share ONE
// directory constant — proven through the real route: a picture uploaded here is found and read.
test('a picture uploaded through /api/upload is read by the OCR queue from where the route put it', async () => {
  const up = await api(port, '/api/upload', { method: 'POST', body: JSON.stringify({ name: 'receipt.png', data: PNG_B64 }) });
  const body = await up.json();
  assert.equal(up.status, 200, JSON.stringify(body));
  const rel = body.path;
  assert.ok(rel.startsWith(`${UPLOADS_DIR}/`), `the route answers a path under the shared constant, got ${rel}`);
  assert.equal(uploadFile(WS, rel), path.join(WS, rel), 'and the queue\'s judge accepts that very path');
  assert.ok(fs.existsSync(path.join(WS, rel)));
  const photo = { ...nb(''), pages: [{ id: 'p', created: 1, updated: 2, strokes: [], pageHtml: '', images: [{ path: rel, x: 0, y: 0, w: 1, h: 1 }] }] };
  assert.equal((await api(port, '/api/save-data', { method: 'POST', body: JSON.stringify({ path: 'data/notes/entry-7.json', data: JSON.stringify(photo) }) })).status, 200);
  await waitFor(() => { try { return (JSON.parse(fs.readFileSync(path.join(WS, INDEX_DIR, 'notes.json'), 'utf8')).records.find((x) => x.path === 'entry-7.json') || {}).src?.photo; } catch { return false; } }, 'the uploaded picture to be transcribed', { timeoutMs: 10000 });
  const r = await get('?app=notes&q=receipt');
  assert.deepEqual(r.body.hits.map((h) => [h.path, h.where]), [['entry-7.json', 'photo']]);
});

test('the route is authenticated like every other /api route', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/note-search?app=notes&q=landlord`);
  assert.equal(r.status, 401);
});
