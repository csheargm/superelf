// Note search（笔记搜索）— the per-app index store, scan and save hook behind GET /api/note-search
// (docs/plans/note-search.md, ADR 0023). Records: lib/note-index.mjs; matcher: lib/note-match.mjs;
// handwriting/photo OCR that fills records in later: lib/note-ocr-queue.mjs.
//
// The index is DERIVED and regenerable: it lives at <workspace>/search/<slug>.json, OUTSIDE data/,
// so the app broker's auto-namespaced data channel cannot read or overwrite it, and a lost or
// corrupt index is simply rebuilt from the notebooks. Existing notes need no migration: the first
// search lazily scans data/<slug>/**/*.json and indexes whatever is already on disk.
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './atomicwrite.mjs';
import { slugOk } from './webutil.mjs';
import { readJsonState, FILE_OK, FILE_ABSENT } from './readjson.mjs';
import { APP_DATA_DIR, APP_DATA_MAX_BYTES, noLinkOnTheWay } from './appdata.mjs';
import { buildFileRecords, carryOcr, OCR_SOURCES, SOURCES } from './note-index.mjs';
import { searchHits, DEFAULT_LIMIT } from './note-match.mjs';
// The matcher and its tunables live in lib/note-match.mjs; re-exported so the route and the tests
// keep ONE import for note search.
export { QUERY_MAX_CHARS, DEFAULT_LIMIT, SNIPPET_CHARS, FUZZY_MIN_CHARS, SCORE, withinOneEdit, parseQuery, snippetFor, searchHits, search } from './note-match.mjs';

export const INDEX_DIR = 'search';                 // <ws>/search/<slug>.json — never under data/
export const INDEX_VERSION = 6;                    // 6: emph + imp per record (emphasis); 5: tag rule (looksLikeTag); 4: geo per record (phase 3 boxes); 3: ink/photo sources, OCR hashes, idx per source; 2: idx:{runs,bi}
export const INDEX_VERSION_PREV = 5;               // loads, then every file is re-read ONCE with its OCR carried (see loadIndex)
export const REINDEX_DEBOUNCE_MS = 2000;           // a 700 ms autosave must not reindex per keystroke
// A data file over the save-side cap is never parsed (it could not have been saved through the
// route; parsing it would stall the event loop): skipped and reported once, like a broken file.
export const INDEX_FILE_MAX_BYTES = APP_DATA_MAX_BYTES;
export const NOTE_INDEX_FAILED = 'note-index-failed';   // the ONE audit event name for an index failure (web.mjs, both sites)
export const INDEX_PATH_REFUSED = 'index_path_refused'; // e.code when <ws>/search is reached through a link
export const DATA_PATH_REFUSED = 'data_path_refused';   // e.code when data/ or data/<slug> IS a link (never scanned)
export const INDEX_FAILED = 'index_failed';             // e.code when a file would not (re)index (the queue and the save hook, web.mjs)

export const indexFile = (ws, slug) => path.join(ws, INDEX_DIR, `${slug}.json`);
const emptyIndex = () => ({ v: INDEX_VERSION, files: {}, records: [] });
const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
const isStr = (v) => typeof v === 'string';
const strs = (a) => Array.isArray(a) && a.every(isStr);
// Every member search() touches is typed here: a record that loads but throws mid-search would
// otherwise poison the index for good, since nothing dirty means nothing rewritten (R13 round 2 #1).
const hashOk = (h) => h === null || isStr(h);
const idxOk = (i) => isObj(i) && strs(i.runs) && strs(i.bi);
const srcOk = (s) => isObj(s) && SOURCES.every((k) => isStr(s[k]));
const geoOk = (g) => isObj(g) && typeof g.ink === 'number' && Array.isArray(g.imgs);
// emph / imp (v6) are optional like geo (v4): a v5 record has neither until its file is re-read.
const emphOk = (e) => e === undefined || (isObj(e) && Array.isArray(e.hl) && Array.isArray(e.circ));
const impOk = (i) => i === undefined || (isObj(i) && Array.isArray(i.ink) && i.ink.every((n) => typeof n === 'number') && strs(i.typed));
const recordOk = (r, v = INDEX_VERSION) => isObj(r) && isStr(r.path) && (r.geo === undefined || geoOk(r.geo)) && emphOk(r.emph) && impOk(r.imp) && isStr(r.scope) && typeof r.page === 'number'
  && typeof r.updated === 'number' && strs(r.tags) && strs(r.labels) && srcOk(r.src) && isObj(r.ocrError)
  && isObj(r.need) && isObj(r.done) && isObj(r.boxes) && OCR_SOURCES.every((k) => hashOk(r.need[k]) && hashOk(r.done[k]) && Array.isArray(r.boxes[k]))
  && isObj(r.idx) && SOURCES.every((k) => idxOk(r.idx[k]));
const indexOk = (v, ver = INDEX_VERSION) => isObj(v) && v.v === ver && isObj(v.files) && Array.isArray(v.records) && v.records.every((r) => recordOk(r, ver));

// The index path is judged like every other workspace write target (lib/appdata.mjs appDataFile):
// a link at <ws>/search would carry the plain text of every page wherever it points, so a link on
// the way refuses BOTH the write and the read, with a code the route audits (R5).
function judgedIndexFile(ws, slug) {
  const f = indexFile(ws, slug);
  if (noLinkOnTheWay(ws, f)) return f;
  const e = new Error(`note index ${slug}: ${INDEX_DIR}/ is reached through a link, refused`);
  e.code = INDEX_PATH_REFUSED;
  throw e;
}

const staleStamps = (files) => Object.fromEntries(Object.keys(files).map((k) => [k, { mtimeMs: -1, size: -1 }]));

export function loadIndex(ws, slug) {
  const r = readJsonState(judgedIndexFile(ws, slug));
  // A missing, unreadable, older-version or malformed index is rebuilt from the notebooks: it is
  // derived data with nothing to lose, so starting empty IS the recovery (R5: the comment is the
  // reason). Malformed means ANY record off-shape — a partial keep would leave `files` claiming a
  // file is indexed while its records are gone, so the whole index starts over instead.
  if (r.state === FILE_OK && indexOk(r.value)) return r.value;
  // The previous version differs only by per-record derived members (v4: geometry; v6: emphasis):
  // its records are kept so the next scan re-reads every file ONCE and carryOcr keeps the ink and
  // photo text already recognised — a rebuild from empty would transcribe every page again.
  // The file list is kept with every stamp made stale (not forgotten): a forgotten list would let
  // a record of a deleted file survive, and a single-file save in between (autosave, OCR flush)
  // would write an index whose other records still lack geo / emph — so those are optional in recordOk and
  // the stale stamps make the next scan re-read, or drop, every file (R13 p3 #1).
  if (r.state === FILE_OK && indexOk(r.value, INDEX_VERSION_PREV)) return { ...r.value, v: INDEX_VERSION, files: staleStamps(r.value.files) };
  return emptyIndex();
}

// Never creates the workspace root: a workspace that is gone was tombstoned (renamed) by the delete
// route, and provisioning reuses any directory that exists, so recreating it would resurrect the
// account's folder. mkdir is one level, <ws>/search, and only when <ws> is there.
export function saveIndex(ws, slug, index) {
  const f = judgedIndexFile(ws, slug);
  try { fs.mkdirSync(path.dirname(f)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  writeFileAtomic(f, JSON.stringify(index));
}
// Start over: the index is derived, so an index that loaded but will not search is thrown away and
// the next scan rebuilds it from the notebooks (ADR 0023: rebuilt, not repaired).
export const resetIndex = (ws, slug) => saveIndex(ws, slug, emptyIndex());

// The data root is judged like the index path: data/ or data/<slug> that IS a link would scan (and
// copy into this workspace's index) whatever it points at — another member's journal. Refused with
// a code the route audits; a link ENTRY below the root is skipped and reported once (reindexFile).
function judgedDataRoot(ws, slug) {
  const root = path.join(ws, APP_DATA_DIR, slug);
  if (noLinkOnTheWay(ws, root)) return root;
  const e = new Error(`note index ${slug}: ${APP_DATA_DIR}/${slug} is reached through a link, refused`);
  e.code = DATA_PATH_REFUSED;
  throw e;
}

// Every candidate file under data/<slug>/, app-relative with '/' separators: *.json only, never a
// .bak (a previous generation would double every hit) and never a dot entry. A symlink entry (file
// or directory) is listed but never followed: reindexFile refuses it with a remembered error.
export function listDataFiles(ws, slug) {
  const root = judgedDataRoot(ws, slug);
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { if (e.code === 'ENOENT') return; throw e; }   // no data folder yet: nothing to index
    for (const d of entries) {
      if (d.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isSymbolicLink()) out.push(r);                      // judged, not walked (Dirent never follows)
      else if (d.isDirectory()) walk(path.join(dir, d.name), r);
      else if (d.isFile() && d.name.endsWith('.json')) out.push(r);
    }
  };
  walk(root, '');
  return out;
}

// Drop a file's records, returning them: a reindex hands them to carryOcr so a typed edit keeps the
// ink and photo text the queue already recognised (same page, same content hash).
const dropFile = (index, relPath) => { const prev = index.records.filter((r) => r.path === relPath); index.records = index.records.filter((r) => r.path !== relPath); delete index.files[relPath]; return prev; };

// Re-read one file into the index. A file that is gone drops out; one that will not parse (or is
// over `maxBytes`) drops out and is REPORTED ({ok:false,error}) rather than kept stale — the caller
// audits it. The failure is REMEMBERED with the file's stamp (files[rel].error), so an unchanged
// broken file is skipped by the next scan instead of re-parsed, re-reported and the index rewritten
// on every keystroke; it is retried once its mtime or size moves.
// The ONE judged read of a data file (R3): the indexer and the OCR queue's page re-read go through
// it, so a file swapped for a link or grown past the cap after indexing is refused in both places
// (R13 round 1 #16). {state:'absent'} | {state:'refused', st, error} | {state:'ok', st, value}, or
// {state:'unchanged', st} when the caller's `stamp` ({mtimeMs,size}) still matches: nothing parsed.
export const DATA_ABSENT = 'absent', DATA_REFUSED = 'refused', DATA_OK = 'ok', DATA_UNCHANGED = 'unchanged';
export function readDataFile(ws, slug, relPath, { maxBytes = INDEX_FILE_MAX_BYTES, stamp = null } = {}) {
  const f = path.join(judgedDataRoot(ws, slug), relPath);
  let st;
  try { st = fs.lstatSync(f); } catch (e) { if (e.code === 'ENOENT') return { state: DATA_ABSENT }; throw e; }
  if (stamp && stamp.mtimeMs === st.mtimeMs && stamp.size === st.size && !st.isSymbolicLink()) return { state: DATA_UNCHANGED, st };
  if (st.isSymbolicLink()) return { state: DATA_REFUSED, st, error: `${relPath} is a link: not indexed` };
  if (st.size > maxBytes) return { state: DATA_REFUSED, st, error: `${path.basename(f)} is ${st.size} bytes, over the ${maxBytes}-byte cap: not indexed` };
  const r = readJsonState(f);
  if (r.state === FILE_ABSENT) return { state: DATA_ABSENT };
  if (r.state !== FILE_OK) return { state: DATA_REFUSED, st, error: r.error };
  return { state: DATA_OK, st, value: r.value };
}

export function reindexFile(ws, slug, relPath, index, { maxBytes = INDEX_FILE_MAX_BYTES } = {}) {
  const prev = dropFile(index, relPath);
  const r = readDataFile(ws, slug, relPath, { maxBytes });
  if (r.state === DATA_ABSENT) return { ok: true, records: 0 };
  // A refused file keeps its own stamp: remembered, reported once, retried when the stamp moves.
  if (r.state === DATA_REFUSED) { index.files[relPath] = { mtimeMs: r.st.mtimeMs, size: r.st.size, error: r.error }; return { ok: false, error: r.error, records: 0 }; }
  const recs = carryOcr(prev, buildFileRecords(relPath, r.value, r.st.mtimeMs));
  index.records.push(...recs);
  index.files[relPath] = { mtimeMs: r.st.mtimeMs, size: r.st.size };
  return { ok: true, records: recs.length };
}

// The lazy scan: index what is new or changed (mtime or size differs), drop what was deleted,
// save only when something moved. Returns {index, errors:[{path,error}]} — a file that failed to
// parse is named ONCE (the first scan that meets it at that stamp), never silently skipped.
export function ensureIndexed(ws, slug, { maxBytes = INDEX_FILE_MAX_BYTES } = {}) {
  const index = loadIndex(ws, slug);
  const errors = [];
  let dirty = false;
  const onDisk = new Set(listDataFiles(ws, slug));
  for (const rel of Object.keys(index.files)) if (!onDisk.has(rel)) { dropFile(index, rel); dirty = true; }
  for (const rel of onDisk) {
    const known = index.files[rel];
    let st;
    try { st = fs.lstatSync(path.join(ws, APP_DATA_DIR, slug, rel)); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (known && known.mtimeMs === st.mtimeMs && known.size === st.size) continue;
    const r = reindexFile(ws, slug, rel, index, { maxBytes });
    if (!r.ok) errors.push({ path: rel, error: r.error });
    dirty = true;
  }
  if (dirty) saveIndex(ws, slug, index);
  return { index, errors };
}

// What the route does: scan, then match. A match that THROWS means the index loaded (indexOk) but
// still will not search — derived data, so it is reset and rebuilt ONCE before the error is let
// through; `reset` tells the caller to audit it. `matcher` is injectable for the test only.
export function searchIndexed(ws, slug, q, { limit = DEFAULT_LIMIT, matcher = searchHits } = {}) {
  const first = ensureIndexed(ws, slug);
  try { return { ...matcher(first.index, q, { limit }), errors: first.errors, reset: null, index: first.index }; }
  catch (e) {
    resetIndex(ws, slug);
    const second = ensureIndexed(ws, slug);
    return { ...matcher(second.index, q, { limit }), errors: first.errors.concat(second.errors), reset: String(e.message || e), index: second.index };
  }
}

// ── The save hook ── `rel` is the save-data path (data/<slug>/<file>). Debounced per file so an
// autosave burst costs one reindex; a failure reaches onError (the route audits it), never a
// swallowed timer. Timers are unref'd so a process can exit with one pending.
const pending = new Map();
export function splitDataRel(rel) {
  const m = new RegExp(`^${APP_DATA_DIR}/([^/]+)/(.+\\.json)$`).exec(String(rel || ''));
  return m && slugOk(m[1]) ? { slug: m[1], relPath: m[2] } : null;
}
// Without an onError the failure is rethrown with the file named: loud in a test, and a server
// MUST pass one (web.mjs audits it), because a throw inside a timer would take the process down.
const rethrow = (rel) => (e) => { throw new Error(`note index ${rel}: ${e.message || e}`); };
// `after(slug)` runs once the file is in the index (the OCR queue starts there, web.mjs).
export function scheduleReindex(ws, rel, { onError = rethrow(rel), delayMs = REINDEX_DEBOUNCE_MS, after = null } = {}) {
  const at = splitDataRel(rel);
  if (!at) return false;
  const key = `${ws}\0${rel}`;
  if (pending.has(key)) clearTimeout(pending.get(key));
  const t = setTimeout(() => {
    pending.delete(key);
    // The workspace is gone: the delete route tombstoned (renamed) it since the save. Nothing is
    // left to index, and a write now would resurrect the folder provisioning gates on — so skip.
    if (!fs.existsSync(ws)) return;
    try {
      const index = loadIndex(ws, at.slug);
      const r = reindexFile(ws, at.slug, at.relPath, index);
      saveIndex(ws, at.slug, index);
      if (!r.ok) onError(new Error(r.error));
      if (after) after(at.slug);
    } catch (e) { onError(e); }
  }, delayMs);
  if (t.unref) t.unref();
  pending.set(key, t);
  return true;
}
