// lib/note-search.mjs — the MATCHER: tokenizing, matching, ranking, snippets, the per-notebook cap.
// Split from test/note-search.test.mjs (R4): that file keeps the index store, the scan and the hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { indexFile, ensureIndexed, search, searchHits, parseQuery, withinOneEdit, INDEX_VERSION, QUERY_MAX_CHARS, DEFAULT_LIMIT } from '../lib/note-search.mjs';
import { indexText, buildFileRecords, runsOf, tagsOf } from '../lib/note-index.mjs';
import { nb, put, paths, rec } from './helpers-note.mjs';

const mkws = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-note-match-'));

const fixture = () => ({ v: INDEX_VERSION, files: {}, records: [
  rec('a.json', '', 0, 100, 'Met the landlord about the roof. Grace abounds.'),
  rec('b.json', '', 0, 200, 'Sermon notes #grace and peace'),
  rec('c.json', 'v3', 1, 300, '今天读经 祷告 恩典满满 #灵修'),
  rec('d.json', '', 0, 400, 'grace notes, older style'),
] });

// R13 round 2 #9: the matcher reads the precomputed idx, never re-tokenizing src.typed. Results on
// the fixture are pinned by the matching tests above; this pins WHICH text they come from.
test('search matches on rec.idx (precomputed at index time), and the version bump rebuilds an idx-less index', () => {
  const tampered = fixture();
  tampered.records[0].idx.typed = indexText('nothing here');          // typed still says landlord
  assert.deepEqual(search(tampered, 'landlord'), [], 'typed text alone no longer matches: idx is what is searched');
  assert.deepEqual(paths(search(tampered, 'nothing')), ['a.json'], 'and idx alone does');
  assert.equal(INDEX_VERSION, 6, 'bumped (2: idx; 3: per-source idx + OCR hashes; 4: geo; 5: tag rule; 6: emph + imp) so an older index is rebuilt — the previous version with its OCR carried (test/note-search.test.mjs), not searched');
  const ws = mkws();
  put(ws, 'notes', 'entry-1.json', nb('<div>hello</div>'));
  const v1 = { v: 1, files: {}, records: [{ path: 'entry-1.json', scope: '', page: 0, updated: 1, src: { typed: 'hello' }, tags: [] }] };
  fs.mkdirSync(path.dirname(indexFile(ws, 'notes'))); fs.writeFileSync(indexFile(ws, 'notes'), JSON.stringify(v1));
  const { index } = ensureIndexed(ws, 'notes');
  assert.equal(index.v, INDEX_VERSION);
  assert.deepEqual(index.records[0].idx.typed, indexText('hello'));
  assert.deepEqual(paths(search(index, 'hello')), ['entry-1.json']);
});

test('matching: prefix, one-edit fuzzy on 4+ chars, Chinese bigrams, #tag only matches tags, AND across tokens', () => {
  const idx = fixture();
  assert.deepEqual(paths(search(idx, 'landl')), ['a.json'], 'prefix');
  assert.deepEqual(paths(search(idx, 'bandlord')), ['a.json'], 'one substitution (the OCR scar from the plan)');
  assert.deepEqual(paths(search(idx, 'landlrd')), ['a.json'], 'one deletion');
  assert.deepEqual(search(idx, 'roo f'), [], 'AND: a token that matches nothing fails the whole query');
  assert.deepEqual(search(idx, 'rof'), [], 'no fuzziness under 4 chars (rof is not a prefix of roof)');
  assert.deepEqual(paths(search(idx, '恩典')), ['c.json#v3'], 'a Chinese bigram');
  assert.deepEqual(paths(search(idx, '祷')), ['c.json#v3'], 'a one-character query matches the character');
  assert.deepEqual(paths(search(idx, '读经 恩典')), ['c.json#v3'], 'two Chinese tokens, both present');
  assert.deepEqual(search(idx, '恩爱'), [], 'a bigram the text does not have');
  assert.deepEqual(paths(search(idx, '#grace')), ['b.json'], '#word matches tags only — a.json and d.json say grace in text but are not tagged');
  assert.deepEqual(paths(search(idx, '#灵修')), ['c.json#v3'], 'a Chinese tag');
  assert.deepEqual(paths(search(idx, '#灵')), ['c.json#v3'], 'tag prefix');
  assert.deepEqual(paths(search(idx, 'landlord grace')), ['a.json'], 'AND within one record');
  assert.deepEqual(paths(search(idx, 'GRACE Roof')), ['a.json'], 'case-insensitive');
  assert.deepEqual(search(idx, ''), [], 'an empty query is no hits, not every record');
  assert.deepEqual(search(idx, '#'), [], 'and so is a bare #');
});

test('Chinese glued to Latin or digits is searchable; a mixed-script tag is ONE tag and its own query finds it', () => {
  const one = (html, q) => search({ v: INDEX_VERSION, files: {}, records: buildFileRecords('p.json', nb(html), 1) }, q).length;
  assert.equal(one('<div>ORES会议 today</div>', '会议'), 1, 'Han after Latin');
  assert.equal(one('<div>读了第3章</div>', '章'), 1, 'Han after a digit');
  assert.equal(one('<div>用Claude写代码</div>', '写代码'), 1, 'Han after a word');
  assert.equal(one('<div>ORES 会议 today</div>', '会议'), 1, 'CONTROL: spaced text was always found');
  assert.equal(one('<div>ORES会议 today</div>', 'ores'), 1, 'and the Latin side still matches on its own');
  assert.deepEqual(runsOf('ORES会议 today'), ['ores', '会议', 'today'], 'the one tokenizer cuts at the script change');
  assert.deepEqual(parseQuery('#ores会议 ORES会议'), [{ text: 'ores会议', tagOnly: true, han: false }, { text: 'ores', tagOnly: false, han: false }, { text: '会议', tagOnly: false, han: true }], 'a #piece is ONE tag token, a plain piece is cut');
  // Invariant across TAG_RE and the query parser: every tag tagsOf() yields is found by `#` + that tag.
  const text = 'x #ores会议 #读经24 #灵修ores #Grace_1 #ресурс #日本語テスト #祷告 y';
  const tags = tagsOf(text);
  assert.equal(tags.length, 7);
  const idx = { v: INDEX_VERSION, files: {}, records: buildFileRecords('t.json', nb(`<div>${text}</div>`), 1) };
  for (const tag of tags) assert.equal(search(idx, `#${tag}`).length, 1, `#${tag} finds its own tag`);
  assert.equal(search(idx, '#会议').length, 0, 'CONTROL: a tag is not cut — its second script is not a tag of its own');
});

test('ranking: a tag hit outranks a typed hit; newer updated breaks ties; limit applies', () => {
  const idx = fixture();
  const hits = search(idx, 'grace');
  assert.deepEqual(paths(hits), ['b.json', 'd.json', 'a.json'], 'tag first, then typed newest first');
  assert.deepEqual(hits.map((h) => h.where), ['tag', 'typed', 'typed']);
  assert.ok(hits[0].score > hits[1].score);
  assert.equal(search(idx, 'grace', { limit: 2 }).length, 2);
  for (const h of hits) assert.deepEqual(Object.keys(h).sort(), ['boxes', 'page', 'path', 'scope', 'score', 'snippet', 'where'], 'the hit shape');
});

test('snippet: ~80 chars around the first match, marked where cut', () => {
  const long = 'x'.repeat(100) + ' the needle sits here ' + 'y'.repeat(100);
  const idx = { v: INDEX_VERSION, files: {}, records: [rec('l.json', '', 0, 1, long)] };
  const [h] = search(idx, 'needle');
  assert.ok(h.snippet.includes('needle'), 'contains the hit');
  assert.ok(h.snippet.startsWith('…') && h.snippet.endsWith('…'), 'cut on both sides');
  assert.ok(h.snippet.length <= 82, `about 80 chars, got ${h.snippet.length}`);
  const [s] = search(fixture(), 'sermon');
  assert.equal(s.snippet, 'Sermon notes #grace and peace', 'short text is given whole, no marks');
});

test('query parsing is bounded and a tag token is marked', () => {
  assert.deepEqual(parseQuery('#Grace 恩典 roof'), [{ text: 'grace', tagOnly: true, han: false }, { text: '恩典', tagOnly: false, han: true }, { text: 'roof', tagOnly: false, han: false }]);
  const toks = parseQuery('a'.repeat(QUERY_MAX_CHARS * 3));
  assert.equal(toks.length, 1, 'the cut query still yields its token (R14: no vacuous .every on [])');
  assert.equal(toks[0].text.length, QUERY_MAX_CHARS, 'the one cost backstop: a query is cut, never refused into a crash');
  assert.ok(withinOneEdit('abc', 'abcd') && withinOneEdit('xbcd', 'abcd') && !withinOneEdit('abcd', 'abdc') && !withinOneEdit('ab', 'abcd'));
});


// R13 round 3 #2: the drawer lists NOTEBOOKS; a cap counted in pages hid whole notes behind the extra
// pages of another. One hit per (path,scope), its best page, and the cut is reported.
test('hits are one per notebook (best page first) and the cap reports what it cut', () => {
  const recs = [];
  for (let p = 0; p < 4; p++) recs.push(rec('multi.json', '', p, 500 - p, `grace on page ${p}` + (p === 2 ? ' #grace' : ''), p === 2 ? ['grace'] : []));
  recs.push(rec('other.json', 'v3', 0, 10, 'grace once'));
  const idx = { v: INDEX_VERSION, files: {}, records: recs };
  const r = searchHits(idx, 'grace', { limit: 2 });
  assert.deepEqual(r.hits.map((h) => [h.path, h.page, h.where]), [['multi.json', 2, 'tag'], ['other.json', 0, 'typed']], 'one row per notebook, the tag page chosen for multi');
  assert.equal(r.truncated, false, 'two notebooks fit a cap of two: nothing was cut');
  const cut = searchHits(idx, 'grace', { limit: 1 });
  assert.deepEqual([cut.hits.length, cut.truncated], [1, true], 'a notebook past the cap is reported as cut');
  assert.deepEqual(search(idx, 'grace', { limit: 1 }).length, 1, 'search() is the hits alone');
  assert.deepEqual(searchHits(idx, '', { limit: 1 }), { hits: [], truncated: false, terms: [] });
  assert.ok(DEFAULT_LIMIT >= 50);
});
