// Note OCR queue（识别队列）— fills a record's `ink` and `photo` sources in the background, phase 2 of
// note search (docs/plans/note-search.md, ADR 0023). Work = every record whose `need.<source>`
// (content hash, lib/note-index.mjs) differs from its `done.<source>`; one worker per process, one
// page at a time, newest first, yielding between pages. Progress lives in the index file itself, so
// a restart simply carries on; a page that failed on its CONTENT keeps its error with the hash it
// failed at and is not retried until its content changes. A failure of the ENVIRONMENT (no toolchain,
// build failed, timeout, spawn error) is never written to a page: it ends the burst, is remembered
// per process (`ocrEnvState`, what the route reports as ocr:'failed' with the reason) and retried
// after OCR_ENV_RETRY_MS, so the pages stay pending and are transcribed once the node can (R13 round
// 1 #1/#14). Nothing here throws into the loop: every OCR call is an outcome (lib/note-ocr.mjs) and
// a loop error reaches `onError` (web.mjs audits it).
import fs from 'node:fs';
import path from 'node:path';
import { UPLOADS_DIR, noLinkOnTheWay } from './appdata.mjs';
import { loadIndex, saveIndex, reindexFile, readDataFile, DATA_OK, DATA_UNCHANGED, INDEX_FAILED } from './note-search.mjs';
import { findNotebooks, applyOcr, imagePaths, inkHash, photoHash, OCR_SOURCES, recKey } from './note-index.mjs';
import { ocrInk, ocrImage, ocrPossible, building, ensureBuilt, isEnvFailure, OCR_FAILED, OCR_UNAVAILABLE, OCR_ENV_RETRY_MS } from './note-ocr.mjs';

export { UPLOADS_DIR };
export const OCR_SAVE_DEBOUNCE_MS = 2000;           // the index is written at most this often mid-burst, and always at the end
export const OCR_MAX_IMAGES_PER_PAGE = 8;           // pictures of one page read per burst; the rest are noted as ocrSkipped (R13 round 1 #4)
export const NOTE_OCR_FAILED = 'note-ocr-failed';   // the ONE audit event name for a page OCR failure (web.mjs)
export const UPLOAD_PATH_REFUSED = 'upload_path_refused';
export const PAGE_GONE = 'page_gone';
export const OCR_STALE_INDEX = 'ocr_stale_index';   // the loop's backstop: a record no reindex of its file can satisfy (R13 round 1 #2)
export const OCR_MAX_PICKS_PER_BURST = 3;           // a record picked more often than this in one burst is marked stale, never spun on
// What the route reports as `ocr`: 'ready' | 'building' (compile in progress) | 'failed' (the
// environment failed lately; `reason` says how) | 'unavailable' (nothing to try on this node).
export const OCR_STATUS = Object.freeze({ ready: 'ready', building: 'building', failed: 'failed', unavailable: 'unavailable' });

// ── Environmental state, per process ── set when a burst meets an environmental failure, cleared by
// the next successful OCR. While it stands, no kick starts a worker until OCR_ENV_RETRY_MS passed.
let envState = null;   // {status, code, reason, at}
export const ocrEnvState = () => envState;
export const resetOcrEnvState = () => { envState = null; };   // for tests
export const ocrStatus = ({ cmd = '', platform } = {}) => (building() ? OCR_STATUS.building : envState ? envState.status : ocrPossible({ cmd, platform }) ? OCR_STATUS.ready : OCR_STATUS.unavailable);

// A source is owed when the page has it, it is not done at this hash, and it did not already fail
// at this hash (retried only once the content changes).
export const isOwed = (rec, s) => !!rec.need[s] && rec.done[s] !== rec.need[s] && !(rec.ocrError[s] && rec.ocrError[s].hash === rec.need[s]);
export const ocrWork = (index) => index.records.filter((r) => OCR_SOURCES.some((s) => isOwed(r, s))).sort((a, b) => b.updated - a.updated);
export const pendingCount = (index) => ocrWork(index).length;

// The absolute file of a page's picture, or null: the stored path must sit inside <ws>/uploads/ by
// its text (no `..`, no dot entry, no absolute path) AND on disk (no link on the way) — a notebook
// is app data, and a path in it could name anything.
export function uploadFile(ws, rel) {
  if (typeof rel !== 'string') return null;
  const segs = rel.split('/');
  if (segs.length < 2 || segs[0] !== UPLOADS_DIR || segs.some((s) => !s || s === '..' || s.startsWith('.') || s.includes('\\'))) return null;
  const f = path.join(ws, ...segs);
  return noLinkOnTheWay(ws, f) ? f : null;
}

const fail = (code, error) => ({ ok: false, code, error });

// The page a record describes, re-read from its notebook file through the SAME judged read as the
// indexer (link, size cap: R13 round 1 #16). `cache` holds one parsed file per path for the burst
// (stamp-checked: a save in between is seen), so a notebook of N ink pages is parsed once, not N
// times (R13 round 1 #3).
function pageOf(ws, slug, rec, cache) {
  const c = cache.get(rec.path);
  const r = readDataFile(ws, slug, rec.path, { stamp: c && c.stamp });
  let json;
  if (r.state === DATA_UNCHANGED) json = c.value;
  else if (r.state === DATA_OK) { json = r.value; cache.set(rec.path, { stamp: { mtimeMs: r.st.mtimeMs, size: r.st.size }, value: json }); }
  else { cache.delete(rec.path); return null; }
  const nb = findNotebooks(json).find((n) => n.scope === rec.scope);
  return nb ? nb.nb.pages[rec.page] || null : null;
}

// The page's pictures through Vision, text and labels concatenated, at most OCR_MAX_IMAGES_PER_PAGE
// of them (`skipped` counts the rest); the first refused path or failed run fails the source.
async function ocrPhotos(ws, page, ocr, opts) {
  const lines = [], text = [], labels = [];
  let ms = 0;
  const all = imagePaths(page), used = all.slice(0, OCR_MAX_IMAGES_PER_PAGE);
  for (const [img, rel] of used.entries()) {
    const f = uploadFile(ws, rel);
    if (!f) return fail(UPLOAD_PATH_REFUSED, `${rel}: not a file under ${UPLOADS_DIR}/`);
    const out = await ocr.ocrImage(f, opts);
    if (!out.ok) return out;
    lines.push(...out.lines.map((l) => ({ ...l, img })));   // img: the picture's index in this (sorted) order, so a hit can be drawn on it (phase 3)
    if (out.text) text.push(out.text); labels.push(...out.labels); ms += out.ms;
  }
  return { ok: true, lines, text: text.join('\n'), labels, ms, skipped: all.length - used.length };
}

// OCR what one record is owed: [{s, hash, out}] — only sources whose content on disk still hashes
// to what the index asked for (a page edited since is left to the reindex that follows).
async function ocrRecord(ws, slug, rec, ocr, opts, cache) {
  const page = pageOf(ws, slug, rec, cache);
  const results = [];
  for (const s of OCR_SOURCES) {
    if (!isOwed(rec, s)) continue;
    if (!page) { results.push({ s, hash: rec.need[s], out: fail(PAGE_GONE, `${rec.path} page ${rec.page}: not in the notebook any more`) }); continue; }
    const now = s === 'ink' ? inkHash(page) : photoHash(page);
    if (now !== rec.need[s]) continue;
    const out = s === 'ink' ? await ocr.ocrInk(page.strokes, opts) : await ocrPhotos(ws, page, ocr, opts);
    results.push({ s, hash: rec.need[s], out });
  }
  return results;
}

// Land results on whichever index copy is current: the save route may have rewritten the file in
// between, so a result is matched by page AND hash, and applied only if still owed.
function landResults(index, results) {
  const by = new Map(index.records.map((r) => [recKey(r), r]));
  for (const { key, s, hash, out } of results) {
    const rec = by.get(key);
    if (rec && rec.need[s] === hash && rec.done[s] !== hash) applyOcr(rec, s, hash, out);
  }
}

const yieldLoop = () => new Promise((r) => setImmediate(r));
const errorOf = (slug, rec, s, out) => Object.assign(new Error(`note ocr ${slug}/${rec.path} page ${rec.page} ${s}: ${out.error}`), { code: out.code || OCR_FAILED, detail: { app: slug, path: rec.path, scope: rec.scope, page: rec.page, source: s } });

// One burst for one app: until nothing is owed, or the environment fails. `unsaved` holds results
// not yet written; EVERY save re-loads the index from disk first and lands them on that copy,
// because the save hook (scheduleReindex) writes the same file between two pages and a copy loaded
// before an OCR run would clobber what it added (a page saved mid-burst vanished: route test).
async function runApp(ws, slug, { ocr, onError, cmd, saveDebounceMs, now }) {
  const unsaved = [], cache = new Map(), reindexed = new Set(), picks = new Map();
  let lastSave = now();
  const flush = (mutate = null) => { const fresh = loadIndex(ws, slug); if (mutate) mutate(fresh); landResults(fresh, unsaved); saveIndex(ws, slug, fresh); unsaved.length = 0; lastSave = now(); };
  // Re-read one record's file into `idx` now, ONCE per record and burst; rebuilt records get their own turns.
  const reindexNow = (idx, rec, key) => {
    reindexed.add(key); cache.delete(rec.path);
    for (const k of picks.keys()) if (k.startsWith(`${rec.path}\0`)) picks.delete(k);
    const r = reindexFile(ws, slug, rec.path, idx);
    if (!r.ok) onError(Object.assign(new Error(r.error), { code: INDEX_FAILED }));
  };
  for (;;) {
    if (!fs.existsSync(ws)) return;                          // tombstoned since: nothing to write to
    const index = loadIndex(ws, slug);
    landResults(index, unsaved);
    const [rec] = ocrWork(index);
    if (!rec) { if (unsaved.length) flush(); return; }
    const key = recKey(rec);
    // The backstop (memory rule "backstop first"): a record still owed after OCR_MAX_PICKS_PER_BURST
    // turns is one this burst cannot satisfy (its result never lands, or no reindex matches it) — marked
    // stale AT ITS HASH on this very copy, its file re-read once from disk (the honest recovery: the
    // records are rebuilt), and saved, so the loop ends instead of spinning until restart.
    const n = (picks.get(key) || 0) + 1; picks.set(key, n);
    if (n > OCR_MAX_PICKS_PER_BURST) {
      const out = fail(OCR_STALE_INDEX, `${rec.path} page ${rec.page}: still owed after ${OCR_MAX_PICKS_PER_BURST} turns of one burst`);
      for (const s of OCR_SOURCES) if (isOwed(rec, s)) { applyOcr(rec, s, rec.need[s], out); onError(errorOf(slug, rec, s, out)); }
      if (!reindexed.has(key)) reindexNow(index, rec, key);
      saveIndex(ws, slug, index); unsaved.length = 0; lastSave = now();
      await yieldLoop(); continue;
    }
    const results = await ocrRecord(ws, slug, rec, ocr, { cmd }, cache);
    let env = null;
    for (const r of results) {
      if (!r.out.ok && isEnvFailure(r.out.code)) { env = r; continue; }   // the node's failure, not the page's: never landed
      unsaved.push({ key, ...r });
      if (r.out.ok) envState = null;                                       // the environment works again
      else onError(errorOf(slug, rec, r.s, r.out));                        // once: the hash is remembered with the error
    }
    if (env) {
      envState = { status: env.out.code === OCR_UNAVAILABLE ? OCR_STATUS.unavailable : OCR_STATUS.failed, code: env.out.code, reason: String(env.out.error || env.out.code).slice(0, 200), at: now() };
      onError(errorOf(slug, rec, env.s, env.out));                         // once per burst; kicks are gated for OCR_ENV_RETRY_MS
      if (unsaved.length) flush();
      return;
    }
    // Nothing owed matched the disk: the file changed under the index. Re-read it now (the save
    // hook's debounce has not fired yet), ONCE per record and burst, so the loop moves on instead of
    // picking the same page again; a second miss is left to the pick cap above.
    if (!results.length && !reindexed.has(key)) flush((fresh) => reindexNow(fresh, rec, key));
    else if (results.length && now() - lastSave >= saveDebounceMs) flush();
    await yieldLoop();
  }
}

// ── The worker ── one chain per process (one page at a time across apps); per app a running flag
// and an `again` bit so a start during a burst queues one more pass. Returns whether a worker is
// running for the app afterwards (false = nothing to try here, or the environment failed lately).
const apps = new Map();
let chain = Promise.resolve();
export function startOcrWorker(ws, slug, { cmd = '', onError, ocr = { ocrInk, ocrImage }, saveDebounceMs = OCR_SAVE_DEBOUNCE_MS, now = Date.now, envRetryMs = OCR_ENV_RETRY_MS } = {}) {
  if (typeof onError !== 'function') throw new Error('startOcrWorker: onError is required (the server audits it)');
  // Possibility is the REAL tool's question (macOS, or a `cmd`). An injected `ocr` IS the stand-in:
  // it must run on any OS, or every queue test is macOS-only (CI on ubuntu/windows: "the worker
  // started: false"). The real tool additionally starts its compile now, so this very kick reports
  // 'building' (the promise is shared, runTool joins it) — never for an injected `ocr`.
  const realTool = ocr.ocrInk === ocrInk;
  if (realTool && !ocrPossible({ cmd })) return false;
  if (envState && now() - envState.at < envRetryMs) return false;
  if (!cmd && realTool) ensureBuilt({ now });
  const key = `${ws}\0${slug}`;
  const st = apps.get(key) || { running: false, again: false };
  apps.set(key, st);
  if (st.running) { st.again = true; return true; }
  st.running = true;
  chain = chain.then(async () => {
    do { st.again = false; await runApp(ws, slug, { ocr, onError, cmd, saveDebounceMs, now }); } while (st.again && !envState);
  }).catch((e) => onError(e)).finally(() => { st.running = false; });
  return true;
}
export const workerRunning = (ws, slug) => !!(apps.get(`${ws}\0${slug}`) || {}).running;
// For tests: the moment the chain is idle.
export const workerIdle = () => chain.then(() => undefined, () => undefined);

// What the search route adds to its reply, and the kick that backfills an old node on a search:
// {pending, ocr, reason?}. The worker starts only when there is work and something to try.
export function noteOcrState(ws, slug, index, { cmd = '', onError, now = Date.now, envRetryMs = OCR_ENV_RETRY_MS } = {}) {
  const pending = pendingCount(index);
  if (pending) startOcrWorker(ws, slug, { cmd, onError, now, envRetryMs });
  const ocr = ocrStatus({ cmd });
  return { pending, ocr, ...(envState && ocr === envState.status ? { reason: envState.reason } : {}) };
}
