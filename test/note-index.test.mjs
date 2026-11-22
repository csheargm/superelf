// lib/note-index.mjs — what a notebook file contributes to search (phase 1: typed text + #tags).
//
// Fixtures are SYNTHETIC notebooks in the live shape (pages with strokes / pageHtml / images); no
// owner data. The detector must be generic: the journal keeps a notebook at the file root, the Bible
// keeps one per verse scope under `draws`, and a third PANote host must need no new code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNotebook, findNotebooks, legacyNotebook, htmlToText, tagsOf, indexNotebook, buildFileRecords, indexText, MAX_WALK_DEPTH, inkHash } from '../lib/note-index.mjs';
import { pageGeo } from '../lib/note-boxes.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const stroke = { c: '#141414', w: 0.002, p: [[0.1, 0.2, 0.5], [0.11, 0.21, 0.5]] };
const page = (html, extra = {}) => ({ id: 'p1', created: 1, updated: 2, strokes: [stroke], pageHtml: html, images: [], ...extra });
const notebook = (html, extra = {}) => ({ v: 2, id: 'nb', created: 1, updated: 1700000000000, template: 'blank', bgColor: '#fff', pages: [page(html)], ...extra });

test('a notebook is recognised by its shape: a non-empty pages array of page objects', () => {
  assert.ok(isNotebook(notebook('<div>hi</div>')));
  assert.ok(isNotebook({ pages: [{ strokes: [] }] }), 'ink-only page');
  assert.ok(isNotebook({ pages: [{ images: [{ path: 'x.jpg', x: 0, y: 0, w: 1, h: 1 }] }] }), 'photo-only page');
  assert.ok(isNotebook({ pages: [{ texts: [] }] }), 'legacy text boxes');
  assert.ok(!isNotebook({ pages: [] }), 'empty pages is not a notebook');
  assert.ok(!isNotebook({ pages: [1, 2] }), 'pages of non-objects is not one');
  assert.ok(!isNotebook({ pages: [{ title: 'chapter 1' }] }), 'an unrelated "pages" list (no page members) is not one');
  assert.ok(!isNotebook({ entries: [{ id: 1 }] }), 'the journal index is not one');
  assert.ok(!isNotebook(null) && !isNotebook([{ pages: [] }]));
});

test('findNotebooks: root (journal), nested draws (Bible), none (plain json)', () => {
  const root = findNotebooks(notebook('<div>a</div>'));
  assert.deepEqual(root.map((n) => n.scope), [''], 'a root notebook has the empty scope');
  const bible = { notes: { v1: 'plain text' }, titles: { 'free-1788000000000': 'Mine' },
    draws: { v1: notebook('<div>verse one</div>'), 'v25.26': notebook('<div>two verses</div>'), 'free-1788000000000': notebook('<div>free</div>') } };
  assert.deepEqual(findNotebooks(bible).map((n) => n.scope).sort(), ['free-1788000000000', 'v1', 'v25.26'], 'the scope is the draws key');
  assert.deepEqual(findNotebooks({ entries: [{ id: 'e1', title: 'x' }], v: 3 }), [], 'a non-notebook file yields nothing');
  assert.deepEqual(findNotebooks('string'), []);
});

test('the walk is bounded and does not descend into a notebook', () => {
  let deep = notebook('<div>deep</div>');
  for (let i = 0; i < MAX_WALK_DEPTH; i += 1) deep = { k: deep };            // MAX_WALK_DEPTH wrappers → at depth MAX
  assert.equal(findNotebooks(deep).length, 1, 'reachable at the maximum depth');
  assert.equal(findNotebooks({ k: deep }).length, 0, 'one deeper is not looked at');
  const nested = notebook('<div>outer</div>', { pages: [page('<div>outer</div>', { inner: notebook('<div>inner</div>') })] });
  assert.equal(findNotebooks(nested).length, 1, 'a notebook inside a page is not a second notebook');
});

test('htmlToText: block tags end lines, markup is dropped, entities decoded', () => {
  assert.equal(htmlToText('<div>Line one</div><div>Line&nbsp;two &amp; more</div><p>x &lt;y&gt;</p>'), '\nLine one\n\nLine two & more\n\nx <y>\n');
  assert.equal(htmlToText('<b>bold</b> <span style="color:red">red</span><br>next'), 'bold red\nnext');
  assert.equal(htmlToText(''), '');
  assert.equal(htmlToText(undefined), '');
});

test('web.mjs firstLineTitle uses THIS helper rather than a second copy of the rule (R3)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  assert.match(src, /import \{ htmlToText \} from '\.\/lib\/note-index\.mjs'/);
  assert.match(src, /const fromHtml = htmlToText\(html\)/);
  assert.equal((src.match(/replace\(\/<\\\/\?\(\?:br\|div\|p\|li\|h\[1-6\]\)/g) || []).length, 0, 'the block-tag regex lives in the lib only');
});

test('tags: any #word, any script, lowercased, without the #, once each', () => {
  assert.deepEqual(tagsOf('Met the #Landlord about #ORES; #landlord again. 今天 #灵修 #祷告 #ores2 #a_b'), ['landlord', 'ores', '灵修', '祷告', 'ores2', 'a_b']);
  assert.deepEqual(tagsOf('a # b #'), [], 'a bare # is not a tag');
  assert.deepEqual(tagsOf('color #fff;'), ['fff'], 'the regex does not know CSS — stated, not hidden');
  // OCR noise seen live (2026-11-10): a stroke read as `#` + digits, and one-letter tags. Not tags.
  assert.deepEqual(tagsOf('Bitt #sportet #s #e33723616 #1 #2026 #q3 #week42 #灵修 #_x'), ['sportet', 'q3', 'week42', '灵修'], 'a tag starts with a letter, has 2+ chars and at most 2 digits');
});

test('indexNotebook: one entry per page, typed text flattened, tags from it', () => {
  const nb = notebook('<div>Prayer list</div><div>祷告 恩典 #灵修</div>', { pages: [page('<div>Prayer list</div><div>祷告 恩典 #灵修</div>'), page(''), page('<div>#ores meeting</div>')] });
  const idx = indexNotebook(nb);
  assert.deepEqual(idx, [
    { page: 0, text: { typed: 'Prayer list 祷告 恩典 #灵修' }, tags: ['灵修'] },
    { page: 1, text: { typed: '' }, tags: [] },
    { page: 2, text: { typed: '#ores meeting' }, tags: ['ores'] }]);
});

test('buildFileRecords: the search record shape, keyed by source for phase 2', () => {
  const nb = notebook('<div>hello</div>', { pages: [page('<div>hello #tag</div>'), page('')] });
  const recs = buildFileRecords('entry-9.json', nb, 1234);
  const empty = { ink: { runs: [], bi: [] }, photo: { runs: [], bi: [] } };
  // Both pages carry the fixture stroke, so page 1 (no words) is a record too: its ink is owed.
  assert.deepEqual(recs, [
    { path: 'entry-9.json', scope: '', page: 0, updated: 1700000000000, src: { typed: 'hello #tag', ink: '', photo: '' }, tags: ['tag'], labels: [], boxes: { ink: [], photo: [] }, geo: pageGeo(page('')), need: { ink: inkHash(page('')), photo: null }, done: { ink: null, photo: null }, ocrError: {}, idx: { typed: { runs: ['hello', 'tag'], bi: [] }, ...empty }, emph: { hl: [], circ: [] }, imp: { ink: [], typed: [] } },
    { path: 'entry-9.json', scope: '', page: 1, updated: 1700000000000, src: { typed: '', ink: '', photo: '' }, tags: [], labels: [], boxes: { ink: [], photo: [] }, geo: pageGeo(page('')), need: { ink: inkHash(page('')), photo: null }, done: { ink: null, photo: null }, ocrError: {}, idx: { typed: { runs: [], bi: [] }, ...empty }, emph: { hl: [], circ: [] }, imp: { ink: [], typed: [] } }],
    'updated is the notebook\'s own; the runs are precomputed per source; ink/photo wait for the queue; emph/imp (v6) empty on a plain page');
  const bible = { draws: { v3: { pages: [{ strokes: [], pageHtml: '<div>grace 恩典</div>', updated: 55 }] } } };
  assert.deepEqual(buildFileRecords('notes/43-3.json', bible, 999).map((r) => [r.scope, r.updated, r.src.typed, r.idx.typed, r.need]), [['v3', 55, 'grace 恩典', { runs: ['grace', '恩典'], bi: ['恩典', '恩', '典'] }, { ink: null, photo: null }]],
    'no notebook stamp → the page\'s; the file\'s mtime is the last resort; no ink, no picture: nothing owed');
  assert.equal(buildFileRecords('x.json', { draws: { v1: { pages: [{ strokes: [stroke] }] } } }, 7).length, 1, 'an ink-only page IS a record now (phase 2): its text arrives from the queue');
  assert.equal(buildFileRecords('x.json', { pages: [{ images: [{ path: 'uploads/1_a.jpg', x: 0, y: 0, w: 1, h: 1 }] }] }, 7)[0].need.photo.length, 16, 'a photo-only page too');
  assert.equal(buildFileRecords('x.json', { pages: [{ strokes: [], pageHtml: '', images: [] }] }, 7).length, 0, 'a blank page contributes nothing');
  assert.equal(buildFileRecords('x.json', { pages: [{ pageHtml: '<div>late</div>' }] }, 7)[0].updated, 7, 'mtime fallback');
});

// R13 round 2 #2: the pre-notebook journal entry. Mirrors workspace/apps/notes/index.html migrateEntry.
test('LEGACY journal entry {draw, text}: the root\'s notebook (scope \'\'), with `text` searchable', () => {
  const legacy = { v: 1, id: 'e7', created: 1, updated: 1700000000000, text: '<div>Met the <b>landlord</b> #roof</div>', draw: notebook('<div>typed on the pad</div>') };
  const recs = buildFileRecords('entry-7.json', legacy, 5);
  assert.deepEqual(recs.map((r) => [r.scope, r.page, r.src.typed, r.tags]), [['', 0, 'typed on the pad Met the landlord #roof', ['roof']]],
    'scope is \'\' (not \'draw\'), and the legacy text follows page 0\'s typed text exactly as migrateEntry appends it');
  assert.deepEqual(buildFileRecords('entry-8.json', { v: 1, id: 'e8', text: '<p>text only</p>', draw: null }, 5).map((r) => [r.scope, r.src.typed]), [['', 'text only']], 'draw:null → one blank page carrying the text');
  assert.deepEqual(buildFileRecords('entry-9.json', { v: 1, id: 'e9', text: '', draw: notebook('<div>ink and words</div>') }, 5).map((r) => [r.scope, r.src.typed]), [['', 'ink and words']], 'no text: the draw notebook as the root\'s');
  assert.deepEqual(buildFileRecords('entry-a.json', { v: 1, id: 'ea', text: '', draw: null }, 5), [], 'an empty legacy entry contributes nothing');
  assert.equal(legacyNotebook(notebook('<div>new shape</div>')), null, 'CONTROL: a notebook is not legacy');
  assert.equal(legacyNotebook({ entries: [], v: 3 }), null, 'CONTROL: the journal index is not legacy');
  assert.equal(legacyNotebook({ draws: { v1: notebook('<div>x</div>') } }), null, 'CONTROL: a Bible chapter is not legacy');
  assert.equal(findNotebooks(legacy).length, 1, 'the walk does not ALSO claim `draw` at scope \'draw\'');
  assert.equal(legacy.draw.pages[0].pageHtml, '<div>typed on the pad</div>', 'the parsed file is not mutated');
});

test('indexText is exactly what a record carries, derived from its typed text alone', () => {
  for (const typed of ['Met the landlord about the roof. Grace abounds.', '今天读经 祷告 恩典满满 #灵修', 'ORES会议 today', '']) {
    const [rec] = buildFileRecords('p.json', { pages: [{ pageHtml: `<div>${typed || '#t'}</div>` }] }, 1);
    assert.deepEqual(rec.idx.typed, indexText(rec.src.typed), typed);
  }
  assert.deepEqual(indexText('祷告 祷告'), { runs: ['祷告', '祷告'], bi: ['祷告', '祷', '告'] }, 'bigrams once each');
});

// R13 round 3 #1: a page still in the pre-pageHtml `texts[]` shape on disk (PANote rewrites it only on
// its next save) is read the way textsToPageHtml reads it, or its words would be unsearchable.
test('legacy texts[] pages are indexed top-to-bottom by y, exactly as PANote migrates them', () => {
  const page = { strokes: [], texts: [{ y: 0.5, text: 'second #late' }, { y: 0.1, html: '<b>first</b> line' }, { y: 0.3 }] };
  const recs = buildFileRecords('t.json', { pages: [page] }, 1);
  assert.deepEqual(recs.map((r) => [r.src.typed, r.tags]), [['first line second #late', ['late']]], 'html boxes and text-only boxes, sorted by y, the empty one skipped');
  assert.deepEqual(buildFileRecords('u.json', { pages: [{ pageHtml: '<div>new</div>', texts: [{ y: 0, text: 'old' }] }] }, 1)[0].src.typed, 'new', 'CONTROL: pageHtml wins when present, as in pageTextHtml');
});
