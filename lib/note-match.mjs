// Note search matcher（匹配）— how a query meets the index records (lib/note-index.mjs). Split out of
// lib/note-search.mjs in phase 2 (that file keeps the store, the scan and the save hook; both stayed
// under the R4 budget only this way). Pure: an index and a query in, hits out.
//
// Lowercase; runs come from the ONE tokenizer (lib/note-index.mjs runsOf): a Latin/digit run is a
// token, a Han run is matched by character bigrams (one character matches itself); prefix match;
// one edit (insert/delete/substitute) on tokens of FUZZY_MIN_CHARS or more; `#word` matches tags
// only; every query token must match (AND). A record's runs and bigrams were computed at index time
// (rec.idx, per source), never per keystroke.
import { runsOf, isHan, bigrams, indexText, sourceText, SOURCES, OCR_SOURCES } from './note-index.mjs';
import { pageBox, dedupeBoxes, BOXES_MAX } from './note-boxes.mjs';

export const QUERY_MAX_CHARS = 200;                // the one cost backstop on an untrusted query
export const DEFAULT_LIMIT = 50;
export const SNIPPET_CHARS = 80;
export const FUZZY_MIN_CHARS = 4;                  // one-edit fuzziness only on tokens this long
// Rank: tag > typed > ink > photo (SOURCES order, lib/note-index.mjs); a fuzzy match on any source
// scores below an exact photo match.
export const SCORE = Object.freeze({ tag: 10, typed: 5, ink: 4, photo: 3, fuzzy: 2 });
const RANK = Object.freeze({ tag: 0, typed: 1, ink: 2, photo: 3 });

export function withinOneEdit(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

export function parseQuery(q) {
  const out = [];
  for (const piece of String(q || '').slice(0, QUERY_MAX_CHARS).toLowerCase().split(/\s+/)) {
    if (!piece) continue;
    // A `#piece` is ONE tag token, the piece's word characters joined and never cut into runs: a tag
    // is `#` + word characters whatever the script (TAG_RE), so `#ores会议` must look for `ores会议`.
    if (piece.startsWith('#')) { const text = runsOf(piece.slice(1)).join(''); if (text) out.push({ text, tagOnly: true, han: isHan(text) }); continue; }
    for (const run of runsOf(piece)) out.push({ text: run, tagOnly: false, han: isHan(run) });
  }
  return out;
}

// One token against one source's precomputed idx: 'exact' | 'fuzzy' | null.
function matchSource(tok, idx, bi) {
  if (tok.han) return bigrams(tok.text).every((b) => bi.has(b)) ? 'exact' : null;
  if (idx.runs.some((r) => r.startsWith(tok.text))) return 'exact';
  if (tok.text.length >= FUZZY_MIN_CHARS && idx.runs.some((r) => withinOneEdit(r, tok.text))) return 'fuzzy';
  return null;
}

// Does ONE OCR line hold a query token — the same rule as a source, on the line's own text, so the
// boxes drawn on the page are exactly the lines that made the record match (phase 3). A `#tag`
// token matches the line that carries the tag word (runsOf drops the `#`).
export const lineMatches = (tok, text) => { const idx = indexText(text); return !!matchSource(tok, idx, new Set(idx.bi)); };
// The page boxes ([x,y,w,h] in page widths, lib/note-boxes.mjs) of a record's ink and photo lines
// that hold any query token; lines the record cannot place (no geometry yet, a photo line without
// its picture) are left out, never guessed. At most BOXES_MAX.
export function boxesFor(rec, tokens) {
  const out = [];
  for (const s of OCR_SOURCES) for (const l of (rec.boxes && rec.boxes[s]) || []) {
    if (!tokens.some((t) => lineMatches(t, l.t))) continue;
    const b = pageBox(l, s, rec.geo);
    if (b) out.push(b);
  }
  return dedupeBoxes(out).slice(0, BOXES_MAX);
}

// How one query token matches one record: {where:'tag'|<source>, score} or null. Sources are tried
// in rank order, so the best source wins for the token.
function matchToken(tok, rec, bis) {
  if (rec.tags.some((t) => t === tok.text || t.startsWith(tok.text) || (tok.text.length >= FUZZY_MIN_CHARS && withinOneEdit(t, tok.text)))) return { where: 'tag', score: SCORE.tag };
  if (tok.tagOnly) return null;
  for (const s of SOURCES) {
    const how = matchSource(tok, rec.idx[s], bis[s]);
    if (how) return { where: s, score: how === 'fuzzy' ? SCORE.fuzzy : SCORE[s] };
  }
  return null;
}

// ~SNIPPET_CHARS of text around the first query token found in it; the start of the text when the
// match was a tag (or fuzzy) that the text does not literally contain.
export function snippetFor(text, tokens) {
  const low = text.toLowerCase();
  let at = -1;
  for (const t of tokens) { const i = low.indexOf(t.text); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const start = Math.max(0, (at < 0 ? 0 : at) - Math.floor(SNIPPET_CHARS * 0.4));
  const end = Math.min(text.length, start + SNIPPET_CHARS);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

// The snippet comes from the source that matched best: a tag hit shows the first source that has
// words (typed, else ink, else photo); the snippet text is ONE line (OCR lines are joined by \n).
function snippetSource(rec, where) {
  const s = where === 'tag' ? SOURCES.find((x) => sourceText(rec, x)) || 'typed' : where;
  return sourceText(rec, s).replace(/\s+/g, ' ').trim();
}

// hits: [{path, scope, page, score, where, snippet, boxes}], best first (tag over typed over ink over photo,
// then newer `updated`), ONE per notebook (its best page — the drawer lists notebooks, not pages,
// so a cap counted in pages silently hid whole notes behind extra pages of another), at most
// `limit`; `truncated` says the cap cut real matches, so the drawer can say so (R5); `terms` are the
// query tokens as matched (lowercase), for the page to mark typed text with; `boxes` only for the
// hits returned (lib/note-boxes.mjs), never for every record.
export function searchHits(index, q, { limit = DEFAULT_LIMIT } = {}) {
  const tokens = parseQuery(q);
  if (!tokens.length) return { hits: [], truncated: false, terms: [] };
  const hits = [];
  for (const rec of index.records) {
    const bis = Object.fromEntries(SOURCES.map((s) => [s, new Set(rec.idx[s].bi)]));
    let score = 0, where = null, all = true;
    for (const tok of tokens) {
      const m = matchToken(tok, rec, bis);
      if (!m) { all = false; break; }
      score += m.score;
      if (where === null || RANK[m.where] < RANK[where]) where = m.where;
    }
    if (all) hits.push({ path: rec.path, scope: rec.scope, page: rec.page, updated: rec.updated, score, where, snippet: snippetFor(snippetSource(rec, where), tokens), rec });
  }
  hits.sort((a, b) => b.score - a.score || b.updated - a.updated);
  const seen = new Set(), docs = [];
  for (const h of hits) { const k = `${h.path}\0${h.scope}`; if (!seen.has(k)) { seen.add(k); docs.push(h); } }
  return { hits: docs.slice(0, limit).map(({ updated, rec, ...h }) => ({ ...h, boxes: boxesFor(rec, tokens) })), truncated: docs.length > limit, terms: tokens.map((t) => t.text) };
}
export const search = (index, q, opts) => searchHits(index, q, opts).hits;
