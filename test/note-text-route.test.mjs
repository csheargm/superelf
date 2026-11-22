// GET /api/note-text over the REAL web.mjs (helpers-web harness, throwaway root): the transcript
// and tags of synthetic notebooks, per page, through the same lazy index as the search; the OCR
// kick; the guards; the auth. Mirrors test/note-search-route.test.mjs (R3: same fixtures).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, waitFor } from './helpers-web.mjs';
import { nb, put as putIn } from './helpers-note.mjs';

let port, root, web, WS;
const put = (rel, obj) => putIn(WS, rel.slice(0, rel.indexOf('/')), rel.slice(rel.indexOf('/') + 1), obj);
const get = async (qs) => { const r = await api(port, `/api/note-text${qs}`); return { status: r.status, body: await r.json() }; };
const notes = (p) => `?app=notes&path=${encodeURIComponent(p)}&fields=src,labels`;

before(async () => {
  port = await freePort(); root = mkWebRoot({ port }); WS = path.join(root, 'workspace');
  put('notes/entry-1.json', nb('<div>Met the landlord about the roof #ores</div>'));
  const two = nb('<div>Page one #灵修</div>'); two.pages.push({ id: 'p2', created: 1, updated: 2, strokes: [], pageHtml: '<div>typed only #todo</div>', images: [] });
  put('notes/entry-2.json', two);
  put('bible/notes/43-3.json', { draws: { v16: nb('<div>神爱世人 #prayer</div>'), general: nb('<div>chapter note</div>') } });
  // Emphasis (note-features.md F): a highlighter stroke across the top of the page, over where the fake
  // tool's first OCR line lands (bitmap y 0.1..0.2 of a 0.3-high bitmap = page y 0.03..0.06), plus a typed highlight.
  const hi = nb('<div>Keep <span style="background-color: rgba(250, 204, 21, 0.4);">the roof quote</span> and the rest</div>');
  hi.pages[0].strokes.push({ c: '#facc15', w: 0.02, t: 'highlighter', p: [[0.05, 0.02, 0.5], [0.75, 0.02, 0.5], [0.05, 0.07, 0.5], [0.75, 0.07, 0.5]] });
  put('notes/entry-hi.json', hi);
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); });

test('one document: a record per page with the typed text, pending while its ink is owed; the fake tool then fills the transcript in', async () => {
  const first = await get(notes('entry-2.json'));
  assert.equal(first.status, 200);
  assert.equal(first.body.ok, true);
  assert.deepEqual(first.body.pages.map((p) => [p.page, p.src.typed]), [[0, 'Page one #灵修'], [1, 'typed only #todo']]);
  assert.equal(first.body.pages[0].pending, true, 'page 0 carries a stroke the fake tool has not read yet');
  assert.equal(first.body.pages[1].pending, false, 'a typed-only page owes nothing');
  assert.equal(first.body.ocr, 'ready', 'the fake tool is an executable');
  assert.equal(typeof first.body.pending, 'number', 'the app-level count rides along, as on a search');
  // The read KICKED the queue: no search, no save, and the transcript still arrives.
  await waitFor(async () => (await get(notes('entry-2.json'))).body.pages[0].pending === false, 'the ink of entry-2 page 0 to be transcribed', { timeoutMs: 15000 });
  const done = await get(notes('entry-2.json'));
  assert.match(done.body.pages[0].src.ink, /Saturday pollen moderate/, 'the fake\'s handwriting is in the transcript');
  assert.deepEqual(done.body.pages[0].labels, [], 'no picture: no labels');
  assert.equal('tags' in done.body.pages[0], false, 'tags were not asked for');
});

test('tags for every document in one call (the drawer\'s chips), joined by path + scope; handwritten tags included once transcribed', async () => {
  await waitFor(async () => (await get('?app=notes')).body.pages.every((p) => !p.pending), 'the notes backlog to drain', { timeoutMs: 15000 });
  const r = await get('?app=notes');
  assert.deepEqual(r.body.pages.map((p) => [p.path, p.scope, p.page, p.tags]), [
    ['entry-1.json', '', 0, ['ores', '墨水']], ['entry-2.json', '', 0, ['灵修', '墨水']], ['entry-2.json', '', 1, ['todo']], ['entry-hi.json', '', 0, ['墨水']],
  ], 'the fake tool writes #墨水 into every transcribed page; typed tags stay first');
  for (const p of r.body.pages) assert.equal('src' in p, false, 'tags only: no page text travels for a chip');
  const b = await get('?app=bible&path=' + encodeURIComponent('notes/43-3.json') + '&scope=v16');
  assert.deepEqual(b.body.pages.map((p) => [p.scope, p.tags.includes('prayer')]), [['v16', true]], 'a scope selects one notebook of the chapter file');
  const any = await get('?app=bible&path=' + encodeURIComponent('notes/43-3.json'));
  assert.deepEqual(any.body.pages.map((p) => p.scope).sort(), ['general', 'v16'], 'no scope: every notebook of the file');
  assert.deepEqual((await get('?app=notes&path=' + encodeURIComponent('notes/43-3.json'))).body.pages, [], 'apps do not see each other');
});

test('important (note-features.md F): the typed highlight at once; the handwriting line under the highlighter once the fake tool has read the page, the line below it not', async () => {
  const q = `?app=notes&path=${encodeURIComponent('entry-hi.json')}&fields=important,boxes`;
  const first = await get(q);
  assert.equal(first.status, 200);
  assert.equal(first.body.pages[0].important[0], 'the roof quote', 'the typed highlight comes first, known with or without OCR (the earlier test may have drained the queue)');
  await waitFor(async () => (await get(q)).body.pages[0].pending === false, 'the ink of entry-hi to be transcribed', { timeoutMs: 15000 });
  const done = await get(q);
  // The fake reads 2 strokes (the fixture's and the highlighter's); both passes' FIRST line sits under the stroke, the zh pass's second ('Satuday pollen', page y 0.09..0.12) does not.
  assert.deepEqual(done.body.pages[0].important, ['the roof quote', '手写笔记 #墨水 2', 'Saturday pollen moderate 2'], 'typed first, then the two highlighted OCR lines in page order');
  assert.equal(done.body.pages[0].boxes.ink.length, 3, 'the page has three OCR lines; one is not important');
  const plain = await get(`?app=notes&path=${encodeURIComponent('entry-1.json')}&fields=important`);
  assert.deepEqual(plain.body.pages[0].important, [], 'CONTROL: a page with no mark has nothing important');
});

test('guards: a bad slug is refused with a code; an unknown app or file is an empty answer; the route is authenticated', async () => {
  for (const bad of ['?path=x', '?app=../notes', '?app=Notes', '?app=con']) {
    const r = await get(bad);
    assert.equal(r.status, 400, bad);
    assert.deepEqual(r.body, { ok: false, error: 'bad app', code: 'bad_app' });
  }
  const none = await get('?app=nothing-here');
  assert.equal(none.status, 200); assert.deepEqual(none.body.pages, []); assert.equal(none.body.ok, true);
  assert.deepEqual((await get('?app=notes&path=missing.json&fields=src')).body.pages, []);
  const r = await fetch(`http://127.0.0.1:${port}/api/note-text?app=notes`);
  assert.equal(r.status, 401);
});
