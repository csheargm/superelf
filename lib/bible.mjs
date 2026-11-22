import fs from 'node:fs';
import path from 'node:path';

// The Bible text comes from DISK: bible-data/<translation>/<BOOK>/<chapter>.json, the public-domain
// corpus scripturetolife (bible_app, scripts/fetch-bible-data.mjs) bundles — English: Berean
// Standard Bible (BSB), Chinese: 简体和合本 (CUV, Simplified). All 66 books, 1,189 chapters.
//
// WHY (owner, 2026-11-01: "it's lacking chinese version for some chapters"): the text used to be
// fetched per chapter from two sites (WEB from bolls.life, CUV from bible.fhl.net) and cached as
// fetched — so when the Chinese site failed, the chapter was cached WITHOUT its Chinese and stayed
// that way (6 of 44 cached chapters on the owner's node: Acts 1, Romans 4-7, 1 Corinthians 1).
// A corpus on disk cannot be half-missing, needs no network, and reads in under a millisecond.
// The 4 verses CUV does not carry (Deut 13:18, 1 Chr 22:19, Psa 116:19, John 7:53) keep zh ''.
export const BIBLE_DATA_DIR = 'bible-data';
export const TRANSLATIONS = { en: 'bsb', zh: 'cuv' };
// Book 1-66 → the three-letter ids the corpus is filed under (same order as the Chinese list below).
export const BOOK_IDS = [
  'GEN','EXO','LEV','NUM','DEU','JOS','JDG','RUT','1SA','2SA','1KI','2KI','1CH','2CH','EZR','NEH','EST','JOB','PSA','PRO',
  'ECC','SNG','ISA','JER','LAM','EZK','DAN','HOS','JOL','AMO','OBA','JON','MIC','NAM','HAB','ZEP','HAG','ZEC','MAL',
  'MAT','MRK','LUK','JHN','ACT','ROM','1CO','2CO','GAL','EPH','PHP','COL','1TH','2TH','1TI','2TI','TIT','PHM','HEB','JAS',
  '1PE','2PE','1JN','2JN','3JN','JUD','REV',
];
const MAX_CHAPTER = 150;
const SEARCH_LIMIT = 60;
const QUERY_MAX = 80;

const chapterFile = (dataDir, lang, b, c) => path.join(dataDir, TRANSLATIONS[lang], BOOK_IDS[b - 1], `${c}.json`);
const readVerses = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')).verses || []; } catch { return null; } };

// One chapter, both languages: {book, chapter, verses:[{n, en, zh}]}. Throws on a reference that
// is out of range or a chapter the corpus does not have — never answers with an empty chapter.
export function getChapter(dataDir, book, chapter) {
  const b = Number(book), c = Number(chapter);
  if (!(b >= 1 && b <= 66) || !(c >= 1 && c <= MAX_CHAPTER)) throw new Error('bad reference');
  const en = readVerses(chapterFile(dataDir, 'en', b, c));
  if (!en || !en.length) throw new Error(`no such chapter: ${BOOK_IDS[b - 1]} ${c}`);
  const zh = new Map((readVerses(chapterFile(dataDir, 'zh', b, c)) || []).map((v) => [v.verse, String(v.text || '').trim()]));
  return { book: b, chapter: c, verses: en.map((v) => ({ n: v.verse, en: String(v.text || '').trim(), zh: zh.get(v.verse) || '' })) };
}

// Full-text search over the corpus on disk: a Chinese query searches 和合本, any other the BSB.
// Case-insensitive substring, canonical order, the first SEARCH_LIMIT hits.
export function searchBible(dataDir, query) {
  const q = String(query || '').trim().slice(0, QUERY_MAX);
  if (q.length < 2) return [];
  const lang = /[一-鿿]/.test(q) ? 'zh' : 'en';
  const needle = q.toLowerCase();
  const out = [];
  for (let b = 1; b <= 66 && out.length < SEARCH_LIMIT; b++) {
    const dir = path.join(dataDir, TRANSLATIONS[lang], BOOK_IDS[b - 1]);
    let chapters; try { chapters = fs.readdirSync(dir).map((f) => Number(f.replace('.json', ''))).filter(Number.isFinite).sort((x, y) => x - y); } catch { continue; }
    for (const c of chapters) {
      for (const v of readVerses(path.join(dir, `${c}.json`)) || []) {
        const text = String(v.text || '').trim();
        if (text.toLowerCase().includes(needle)) { out.push({ book: b, chapter: c, verse: v.verse, text }); if (out.length >= SEARCH_LIMIT) break; }
      }
      if (out.length >= SEARCH_LIMIT) break;
    }
  }
  return out;
}
