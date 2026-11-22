// Note index（笔记索引）— what a notebook file contributes to search (docs/plans/note-search.md, ADR 0023).
//
// Pure: JSON in, records out; no filesystem (that is lib/note-search.mjs). A record's `src` is keyed
// by source: `typed` is known at index time; `ink` (handwriting OCR) and `photo` (OCR + labels of the
// page's pictures) are filled in later by the background queue (lib/note-ocr-queue.mjs) and carried
// across reindexes by content hash. Nothing here knows an app's name: a notebook is recognised by
// its SHAPE wherever it sits in the file (the journal keeps one at the root, the Bible keeps one per
// verse scope under `draws`), so a third app that hosts PANote is searchable with no new code.

import { createHash } from 'node:crypto';
import { OCR_FAILED, isEnvFailure } from './note-ocr.mjs';
import { pageGeo, sortedImages } from './note-boxes.mjs';
// Emphasis（重点）: regions are stored with the record (`emph`), the important lines derived from them
// (`imp`, finishRecord). note-emphasis imports htmlToText from here: a function-level cycle, nothing
// of either module is read at load time.
import { emphasisRegions, importantInkLines, typedHighlights } from './note-emphasis.mjs';

// A PANote page: an object with any of the page members. `texts` is the legacy text-box shape.
const PAGE_MEMBERS = ['strokes', 'pageHtml', 'images', 'texts'];
export const isPage = (p) => !!p && typeof p === 'object' && !Array.isArray(p) && PAGE_MEMBERS.some((k) => k in p);
// A notebook: an object whose `pages` is a non-empty array of pages. Empty `pages` is not one — it
// would contribute nothing, and an unrelated `{pages:[]}` must not be claimed.
export const isNotebook = (o) => !!o && typeof o === 'object' && !Array.isArray(o)
  && Array.isArray(o.pages) && o.pages.length > 0 && o.pages.every(isPage);

// How deep the walk looks: the root (0), its members (1), their members (2) and one more (3). The
// journal is depth 0 and the Bible `draws[scope]` depth 2; the extra level is headroom, not a hunt.
export const MAX_WALK_DEPTH = 3;

// Every notebook in a parsed file: [{scope, nb}]. `scope` is the key the notebook sits under ('' at
// the root) — the Bible's draws key (`v1`, `v25.26`, `free-<epoch>`) is exactly that, so the app
// names a row's notebook by what it already knows. A notebook's own members are not walked. ONE
// notebook per scope, the first found: a record is keyed (path, scope, page), so a second notebook
// under the same key at another depth would be a record the queue can never satisfy (R13 round 1 #2).
export function findNotebooks(json) {
  const legacy = legacyNotebook(json);
  if (legacy) return [{ scope: '', nb: legacy }];
  const out = [];
  const seen = new Set();
  const walk = (o, key, depth) => {
    if (!o || typeof o !== 'object') return;
    if (isNotebook(o)) { if (!seen.has(key)) { seen.add(key); out.push({ scope: key, nb: o }); } return; }
    if (depth >= MAX_WALK_DEPTH || Array.isArray(o)) return;
    for (const [k, v] of Object.entries(o)) walk(v, k, depth + 1);
  };
  walk(json, '', 0);
  return out;
}

// LEGACY journal entry — the pre-notebook shape {v, id, text:<html>, draw:<notebook|null>} that
// workspace/apps/notes/index.html migrateEntry still accepts and only rewrites on the next save
// (37 of 77 live entries were still this shape on 2026-11-09). Mirrors migrateEntry exactly: the
// notebook is `draw` when it is one, else one blank page; `text` is appended to page 0's pageHtml.
// It is the root's notebook, so its records carry scope '' (the drawer row names no scope) — a
// walk would otherwise claim `draw` at scope 'draw' and never index `text` at all (R13 round 2 #2).
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
export function legacyNotebook(o) {
  if (!isObj(o) || isNotebook(o)) return null;
  const text = typeof o.text === 'string' ? o.text.trim() : '';
  const drawShaped = o.draw === null || (isObj(o.draw) && Array.isArray(o.draw.pages));
  if (!drawShaped && !text) return null;
  const base = isNotebook(o.draw) ? o.draw : { pages: [{ strokes: [], pageHtml: '', images: [] }] };
  if (!text) return base;
  const [p0, ...rest] = base.pages;
  return { ...base, pages: [{ ...p0, pageHtml: (p0.pageHtml || '') + text }, ...rest] };
}

// pageHtml → plain text, one line per block. The ONE HTML→text rule (R3): web.mjs firstLineTitle
// titles a Bible note by the first line of exactly this output.
export function htmlToText(html) {
  return String(html || '')
    // [^<>]*, not [^>]*: on text with many '<' and no '>' the latter rescans to the end from every
    // '<' (quadratic — a public demo's 16 MB save stalled the event loop, GPT review 2026-11-21).
    .replace(/<\/?(?:br|div|p|li|h[1-6])\b[^<>]*>/gi, '\n')   // block tags end a line
    .replace(/<[^<>]*>/g, '')                                   // drop the rest of the markup
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

// ── The ONE tokenizer (R3) ── what counts as a word character decides both what a `#tag` is at
// index time and how text and queries are cut into runs at match time; lib/note-search.mjs imports
// these rather than spelling its own. A run is a Han run OR a run of other word characters: Han is
// in \p{L}, so without the exclusion `ORES会议` would be ONE run and `会议` unsearchable (R13, 2026-11-09).
export const WORD_CHAR = '[\\p{L}\\p{N}_]';
export const RUN_RE = new RegExp(`\\p{Script=Han}+|(?:(?!\\p{Script=Han})${WORD_CHAR})+`, 'gu');
export const runsOf = (text) => [...String(text || '').toLowerCase().matchAll(RUN_RE)].map((m) => m[0]);

// Han helpers shared with the matcher: a Han run is matched by character bigrams (one character
// matches itself), so a record carries those bigrams precomputed (indexText) — search() never
// re-tokenizes a page per keystroke (R13 round 2 #9).
export const isHan = (s) => /^\p{Script=Han}+$/u.test(s);
export const bigrams = (run) => (run.length < 2 ? [run] : Array.from({ length: run.length - 1 }, (_, i) => run.slice(i, i + 2)));
// What the matcher needs of a page's typed text: its runs and the Han bigram set, as plain arrays.
export const indexText = (typed) => {
  const runs = runsOf(typed);
  return { runs, bi: [...new Set(runs.filter(isHan).flatMap((r) => [...bigrams(r), ...r]))] };
};

// A tag is a `#word` in the text, typed or (phase 2) recognised: letters, digits, underscore, in
// any script, so `#灵修`, `#ores` and `#ores会议` each count (a tag is NOT cut at a script change).
// Lowercased, without the `#`, each once. A word is a tag only when it LOOKS like one: it starts
// with a letter, is TAG_MIN_CHARS or longer and carries at most TAG_MAX_DIGITS digits — the owner's
// live list showed `#1`, `#s` and `#e33723616`, a stroke the OCR read as a hash plus digits (2026-11-10).
// So `#2026` is not a tag (say so in the plan), `#q3`, `#week42` and `#fff` are.
export const TAG_RE = new RegExp(`#(${WORD_CHAR}+)`, 'gu');
export const TAG_MIN_CHARS = 2;
export const TAG_MAX_DIGITS = 2;
const looksLikeTag = (w) => w.length >= TAG_MIN_CHARS && /^\p{L}/u.test(w) && (w.match(/\p{N}/gu) || []).length <= TAG_MAX_DIGITS;
export const tagsOf = (text) => [...new Set([...String(text || '').matchAll(TAG_RE)].map((m) => m[1].toLowerCase()).filter(looksLikeTag))];

// Per page: {page, text:{typed}, tags}. `page` is the position in `pages` (the stable handle the pad
// opens by); `text` is keyed by source for phase 2.
// A pre-pageHtml page keeps its words in positioned text boxes `texts[]`; PANote migrates them into
// pageHtml only on load (web/note-ui.inline.html textsToPageHtml: boxes top-to-bottom by y), so a
// page still in that shape on disk is read the same way here, or its words would be unsearchable.
export const legacyTextsHtml = (texts) => (Array.isArray(texts) ? texts : []).filter((t) => t && typeof t === 'object')
  .map((t) => ({ y: +t.y || 0, html: typeof t.html === 'string' ? t.html : String(t.text || '') }))
  .sort((a, b) => a.y - b.y).map((t) => `<div>${t.html}</div>`).join('');
export const pageHtmlOf = (p) => (typeof p.pageHtml === 'string' ? p.pageHtml : legacyTextsHtml(p.texts));
export function indexNotebook(nb) {
  return nb.pages.map((p, i) => {
    const typed = htmlToText(pageHtmlOf(p)).replace(/\s+/g, ' ').trim();
    return { page: i, text: { typed }, tags: tagsOf(typed) };
  });
}

// ── OCR seams（识别） ── what a page's ink and pictures are NOW, as cheap content hashes, so the
// queue re-reads a page only when THAT source changed: a typed-text edit must never re-OCR
// unchanged ink. `null` = the page has none of that source.
export const OCR_SOURCES = Object.freeze(['ink', 'photo']);
// Every source a record carries, in rank order (the matcher tries them in this order): the ONE list
// (R3) the validator, the matcher and finishRecord derive from.
export const SOURCES = Object.freeze(['typed', ...OCR_SOURCES]);
// The ONE record key (R3): the queue matches an OCR result to its record by it, carryOcr a new
// record to its predecessor. A change to one side alone would silently drop every result.
export const recKey = (r) => `${r.path}\0${r.scope}\0${r.page}`;
export const contentHash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
export const inkHash = (p) => (Array.isArray(p.strokes) && p.strokes.length ? contentHash(JSON.stringify(p.strokes)) : null);
// A page's pictures by their stored paths (`images[].path`, 'uploads/<ts>_<name>'), sorted (the ONE
// order, lib/note-boxes.mjs): moving a picture on the page is not a new picture.
export const imagePaths = (p) => sortedImages(p).map((i) => i.path);
export const photoHash = (p) => { const paths = imagePaths(p); return paths.length ? contentHash(paths.join('\n')) : null; };

// The searchable words of a record, per source: `photo` is the picture's text plus its labels (a
// label is a searchable word, never a tag — docs/plans/note-search.md).
export const sourceText = (rec, s) => (s === 'photo' ? [rec.src.photo || '', ...(rec.labels || [])].join(' ') : (rec.src[s] || ''));
// Tags and idx are DERIVED from src + labels, in ONE place (R3): called when a record is built and
// again whenever an OCR result lands on it.
// `imp.ink` is derived too: the OCR line indexes under a highlight or inside a circle, from the
// record's own `emph` regions and geometry — so it is right after an OCR result lands as much as at
// build time. `imp.typed` was read from the page's HTML when the record was built and is kept.
export function finishRecord(rec) {
  rec.tags = tagsOf(SOURCES.map((s) => rec.src[s]).join('\n'));
  rec.idx = Object.fromEntries(SOURCES.map((s) => [s, indexText(sourceText(rec, s))]));
  rec.imp = { ink: importantInkLines(rec.boxes && rec.boxes.ink, rec.geo, rec.emph), typed: (rec.imp && Array.isArray(rec.imp.typed)) ? rec.imp.typed : [] };
  return rec;
}
// An OCR outcome for one source lands on the record with the hash it was computed for; the queue
// compares need vs done to know what is still owed. A CONTENT failure is remembered the same way
// (ocrError) so the page is not retried until its content changes. An ENVIRONMENTAL failure
// (lib/note-ocr.mjs OCR_ENV_CODES) is about the node, not the page: it never lands — the record stays
// owed and the queue retries it later (R13 round 1 #1/#14). `out.skipped` pictures beyond the
// per-page cap are noted as ocrSkipped so the gap is visible in the index (R13 round 1 #4).
export function applyOcr(rec, s, hash, out) {
  if (!out.ok && isEnvFailure(out.code)) return rec;
  if (out.ok) {
    rec.src[s] = out.text || '';
    rec.boxes[s] = (out.lines || []).map((l) => ({ t: l.t, box: l.box, ...(l.pass ? { pass: l.pass } : {}), ...(Number.isInteger(l.img) ? { img: l.img } : {}) }));   // img: which picture (phase 3 highlight)
    if (s === 'photo') rec.labels = Array.isArray(out.labels) ? [...new Set(out.labels)] : [];
    delete rec.ocrError[s];
  } else rec.ocrError[s] = { hash, error: String(out.error || 'failed').slice(0, 200), code: out.code || OCR_FAILED };
  if (out.skipped > 0) rec.ocrSkipped = { ...(rec.ocrSkipped || {}), [s]: out.skipped };
  else if (rec.ocrSkipped) { delete rec.ocrSkipped[s]; if (!Object.keys(rec.ocrSkipped).length) delete rec.ocrSkipped; }
  rec.done[s] = hash;
  return finishRecord(rec);
}
// A reindexed file keeps what the queue already recognised: every new record takes the ink/photo
// result of its predecessor (same path/scope/page) whose hash still matches, else starts over.
export function carryOcr(prev, recs) {
  const by = new Map(prev.map((r) => [recKey(r), r]));
  for (const r of recs) {
    const o = by.get(recKey(r));
    if (!o) continue;
    for (const s of OCR_SOURCES) {
      if (!r.need[s] || o.done[s] !== r.need[s]) continue;
      r.done[s] = o.done[s]; r.src[s] = o.src[s] || ''; r.boxes[s] = o.boxes[s] || [];
      if (s === 'photo') r.labels = o.labels || [];
      if (o.ocrError && o.ocrError[s]) r.ocrError[s] = o.ocrError[s];
      if (o.ocrSkipped && o.ocrSkipped[s]) r.ocrSkipped = { ...(r.ocrSkipped || {}), [s]: o.ocrSkipped[s] };
    }
    finishRecord(r);
  }
  return recs;
}

// One file's search records: {path, scope, page, updated, src:{typed,ink,photo}, tags, labels,
// boxes:{ink,photo}, geo:{ink,imgs} (lib/note-boxes.mjs: puts a box back on the page), need:{ink,photo},
// done:{ink,photo}, ocrError:{}, idx:{typed,ink,photo}, emph:{hl,circ} (lib/note-emphasis.mjs: the
// page's highlighter boxes and circles), imp:{ink:[line indexes], typed:[runs]} (what is marked important)}. `path`
// is the file's app-relative name (what the app itself saves under); `updated` is the notebook's own
// stamp, else the page's, else the file's mtime — the tie-breaker newer-first ranks by. A page with
// nothing on it (no words, no ink, no picture) yields no record.
export function buildFileRecords(relPath, json, mtimeMs) {
  const out = [];
  for (const { scope, nb } of findNotebooks(json)) {
    for (const page of indexNotebook(nb)) {
      const p = nb.pages[page.page] || {};
      const need = { ink: inkHash(p), photo: photoHash(p) };
      if (!page.text.typed && !page.tags.length && !need.ink && !need.photo) continue;
      const own = Number(nb.updated) || Number(p.updated) || 0;
      out.push(finishRecord({ path: relPath, scope, page: page.page, updated: own || Number(mtimeMs) || 0,
        src: { typed: page.text.typed, ink: '', photo: '' }, tags: [], labels: [], boxes: { ink: [], photo: [] }, geo: pageGeo(p),
        need, done: { ink: null, photo: null }, ocrError: {}, idx: null, emph: emphasisRegions(p.strokes), imp: { ink: [], typed: typedHighlights(pageHtmlOf(p)) } }));
    }
  }
  return out;
}
