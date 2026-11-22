// Note text（笔记文本）— what GET /api/note-text answers from the search index (lib/note-search.mjs;
// docs/plans/note-features.md A and B): one record per PAGE of the asked documents, read-only, no
// model, no file write. The transcript (ink and photo text, picture labels) and the `#tags` are
// DERIVED data that live only in the index (ADR 0023: the indexer never writes a note), so this is
// the one place an app reads them — the Transcript panel (A), the drawer's tag chips (B) and, later,
// the period summaries (E) all ask here.
import { OCR_SOURCES, tagsOf } from './note-index.mjs';
import { isOwed } from './note-ocr-queue.mjs';
import { pageBox } from './note-boxes.mjs';

// The fields a caller may ask for, by name: the default is the cheapest (tags), so a many-docs call
// for chips never carries page text. `pending`, `error`, `path`, `scope` and `page` always ride.
// `tags` answers with `typedTags` beside it: the tags of the TYPED text alone (docs/plans/note-features.md H —
// the drawer's strip shows those; the row chips and the search keep every source). Derived here from
// `src.typed` by the index's one tag rule (tagsOf), so no index version or record field is owed.
export const NOTE_TEXT_FIELDS = Object.freeze(['tags', 'src', 'labels', 'boxes', 'important']);
export const DEFAULT_FIELDS = Object.freeze(['tags']);
export const PATHS_MAX = 500;                       // the one cost backstop on an untrusted paths list
export const PAGES_MAX = 2000;                      // fail-closed reply cap: no path + fields=src must not ship the whole app

// `fields` as the route receives it: a comma list, unknown names dropped, empty → the default.
export function parseFields(s) {
  const asked = String(s || '').split(',').map((f) => f.trim()).filter((f) => NOTE_TEXT_FIELDS.includes(f));
  return asked.length ? [...new Set(asked)] : [...DEFAULT_FIELDS];
}

// A page is pending while any of its ink/photo is still owed to the OCR queue; `error` is the first
// content failure the queue remembered for it (an environmental failure never lands on a record).
const pageError = (rec) => { for (const s of OCR_SOURCES) if (rec.ocrError && rec.ocrError[s]) return rec.ocrError[s].error || 'failed'; return ''; };
const pagePending = (rec) => OCR_SOURCES.some((s) => isOwed(rec, s));

// What the owner marked important on the page (lib/note-emphasis.mjs; docs/plans/note-features.md F),
// as text lines in reading order: the typed highlights first (document order), then the highlighted
// or circled handwriting lines top to bottom (by the line's page box, else index order). A record
// from before v6 (no `imp`) has none.
const lineY = (rec, i) => { const b = pageBox((rec.boxes.ink || [])[i], 'ink', rec.geo); return b ? b[1] : Number.MAX_SAFE_INTEGER; };
export function importantLines(rec) {
  const imp = rec.imp || { ink: [], typed: [] };
  const ink = [...imp.ink].sort((a, b) => lineY(rec, a) - lineY(rec, b) || a - b)
    .map((i) => (rec.boxes.ink || [])[i]).filter((l) => l && typeof l.t === 'string' && l.t.trim()).map((l) => l.t.trim());
  return [...imp.typed, ...ink];
}

function recordOut(rec, fields) {
  const out = { path: rec.path, scope: rec.scope, page: rec.page, pending: pagePending(rec) };
  const err = pageError(rec);
  if (err) out.error = err;
  if (fields.includes('tags')) { out.tags = [...rec.tags]; out.typedTags = tagsOf((rec.src && rec.src.typed) || ''); }
  if (fields.includes('src')) out.src = { ...rec.src };
  if (fields.includes('labels')) out.labels = [...(rec.labels || [])];
  if (fields.includes('boxes')) out.boxes = { ink: rec.boxes.ink || [], photo: rec.boxes.photo || [] };
  if (fields.includes('important')) { out.important = importantLines(rec); out.inkImportant = (rec.imp && Array.isArray(rec.imp.ink) ? rec.imp.ink : []).length > 0; }   // the pages a summary sends as images (note-features.md I)
  return out;
}

// The records the caller asked for. `paths` empty = every document of the app (the drawer's chips
// ask this way, with tags only). `scope` null = any scope; a string ('' included) matches exactly —
// the same rule the drawer's sameDoc applies to a row (web/chat-ui.inline.html).
// Returns {pages, truncated}: pages in file, scope, page order, as the index holds them.
export function noteTextRecords(index, { paths = [], scope = null, fields = DEFAULT_FIELDS } = {}) {
  const want = paths.length ? new Set(paths.slice(0, PATHS_MAX)) : null;
  let truncated = paths.length > PATHS_MAX;
  const pages = [];
  for (const rec of index.records) {
    if (want && !want.has(rec.path)) continue;
    if (scope !== null && (rec.scope || '') !== scope) continue;
    if (pages.length >= PAGES_MAX) { truncated = true; break; }
    pages.push(recordOut(rec, fields));
  }
  pages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : a.page - b.page));
  return { pages, truncated };
}
