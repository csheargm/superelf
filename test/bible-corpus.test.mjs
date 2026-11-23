// The Bible text is a corpus ON DISK (bible-data/, BSB + 简体和合本), not two web fetches cached as
// they came (which left chapters without Chinese — owner, 2026-11-01). This pins: every chapter
// of every book is there in BOTH languages, getChapter pairs them verse by verse, the only verses
// without Chinese are the four CUV does not carry, and search reads the same files.
// R11 — searched: "bible-data", "getChapter(", "searchBible(" — one reader, one caller each.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { getChapter, searchBible, BIBLE_DATA_DIR, BOOK_IDS, TRANSLATIONS } from '../lib/bible.mjs';

const DATA = path.join(ROOT, BIBLE_DATA_DIR);
const CUV_LACKS = new Set(['DEU 13:18', '1CH 22:19', 'PSA 116:19', 'JHN 7:53']);

test('66 books, 1,189 chapters, in BOTH translations, and every verse pairs — the corpus is whole', () => {
  assert.equal(BOOK_IDS.length, 66);
  let chapters = 0, verses = 0; const noZh = [];
  for (let b = 1; b <= 66; b++) {
    const dir = path.join(DATA, TRANSLATIONS.en, BOOK_IDS[b - 1]);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    assert.ok(files.length > 0, `${BOOK_IDS[b - 1]} has chapters`);
    for (const f of files) {
      const c = Number(f.replace('.json', ''));
      const ch = getChapter(DATA, b, c); chapters++;
      assert.ok(ch.verses.length > 0, `${BOOK_IDS[b - 1]} ${c} has verses`);
      for (const v of ch.verses) { verses++; assert.ok(v.en, `${BOOK_IDS[b - 1]} ${c}:${v.n} English`); if (!v.zh) noZh.push(`${BOOK_IDS[b - 1]} ${c}:${v.n}`); }
    }
  }
  assert.equal(chapters, 1189);
  assert.ok(verses > 31000, `${verses} verses`);
  assert.deepEqual(new Set(noZh), CUV_LACKS, `only the verses CUV does not carry lack Chinese: ${noZh.join(', ')}`);
});

test('the chapters that used to be cached without Chinese now have it (Acts 1, Romans 4-7, 1 Cor 1)', () => {
  for (const [b, c] of [[44, 1], [45, 4], [45, 5], [45, 6], [45, 7], [46, 1]]) {
    const ch = getChapter(DATA, b, c);
    assert.ok(ch.verses.every((v) => v.zh), `${BOOK_IDS[b - 1]} ${c}: every verse has Chinese`);
  }
  const j = getChapter(DATA, 43, 3);
  assert.match(j.verses[15].en, /^For God so loved the world/, 'John 3:16 BSB');
  assert.match(j.verses[15].zh, /^神爱世人/, 'John 3:16 和合本');
});

test('a bad or missing reference throws — never an empty chapter', () => {
  assert.throws(() => getChapter(DATA, 0, 1), /bad reference/);
  assert.throws(() => getChapter(DATA, 67, 1), /bad reference/);
  assert.throws(() => getChapter(DATA, 43, 22), /no such chapter: JHN 22/);
  assert.throws(() => getChapter(DATA, 43, 151), /bad reference/);
});

// F2-10 (overnight 2026-11-22): book=1.5 passed the range check and leaked Node's internal
// 'The "path" argument must be of type string'; book=1e1 was read as 10. Whole numbers only.
test('a reference that is not a plain whole number is a bad reference, not an internal error', () => {
  for (const [b, c] of [['1.5', 1], ['1e1', 1], [43, '3.5'], [' 43', 3], ['0x2B', 3], [43, '']]) {
    assert.throws(() => getChapter(DATA, b, c), /^Error: bad reference$/, `book=${b} chapter=${c}`);
  }
  assert.equal(getChapter(DATA, '43', '3').book, 43, 'a digit string still works (query params are strings)');
});

test('search: an English query reads the BSB, a Chinese one 和合本; capped; short queries empty', () => {
  const en = searchBible(DATA, 'so loved the world');
  assert.ok(en.hits.some((r) => r.book === 43 && r.chapter === 3 && r.verse === 16), 'John 3:16 found in English');
  assert.equal(en.more, false, 'every hit is listed');
  const zh = searchBible(DATA, '神爱世人');
  assert.ok(zh.hits.some((r) => r.book === 43 && r.chapter === 3 && r.verse === 16), 'John 3:16 found in Chinese');
  // F2-01: a cap that says nothing reads as "these are all the verses" ("love" stopped at 1 Samuel).
  const the = searchBible(DATA, 'the');
  assert.equal(the.hits.length, 60, 'capped at 60');
  assert.equal(the.more, true, 'the cap is said, so the reader knows to narrow the search');
  assert.deepEqual(searchBible(DATA, 'a'), { hits: [], more: false });
  assert.deepEqual(searchBible(DATA, ''), { hits: [], more: false });
});
