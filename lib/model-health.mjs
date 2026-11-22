// Model health（模型可用性）— is every configured Ollama lane still served?
//
// SCAR (2026-10-12): two default lanes, deepseek-v4-flash:0731 (the Fast default most apps open
// on) and qwen3.5:397b, were retired by Ollama on 2026-09-25. For two weeks every turn on them
// answered "Ollama HTTP 410" and nothing on the node knew. Measured on Ollama 0.34.3: `/api/show`
// still answers 200 for a retired model and `/api/tags` lists only locally pulled ones, so the
// only reliable signal is a real `/api/chat` call. This module is that call, run by the scheduled
// `model-check` job (web.mjs JOBS), plus the record every Ollama caller writes when it meets a
// gone answer itself (isGoneAnswer), so a retirement is caught on the first failed turn, not the next run.
//
// model-health.json (node root, gitignored runtime state):
//   { checked: <ms>, gone: { "<model string>": { status, error, since, reported } },
//     catalog: [names] | null, unknown: [model strings], catalogError: string | null }
// Keyed by the MODEL STRING, not the lane id: pointing a lane at a new model clears it at once.
// `reported` is false while only a chat turn has seen the model gone: the job's next run still
// briefs it, or the turn that found it first would have silenced the owner's report. `unknown` and
// `catalogError` remember what could not be checked, so a lasting outage is briefed once, not daily.
// A model marked gone stays hidden until a run sees it answer — up to a day, or until Run now.
// Briefing is at most once: `reported` is written before the job engine stores the briefing, so a
// disk failure in between loses that one briefing (the lane stays hidden, and Run now lists it
// under "Still gone"). The other order would brief every retirement again after any crash.
// The chooser list and the lane fallback read `gone` (web.mjs PA_CHAT_LANE); nothing here edits
// config.json. `catalog` is what the weekly model review (lib/model-review.mjs, docs/adr/0017) reads
// to find new models: this job records arrivals and no longer briefs them; the review tests them.
import fs from 'node:fs';
import { writeJsonFile } from './atomicwrite.mjs';

export const MODEL_HEALTH_FILENAME = 'model-health.json';
// The only answers that mean "this model is not served here": 410, or a 404 whose body is Ollama's
// own "model '<name>' not found" (measured, local and cloud). A bare 404 — a wrong ollama_url
// answering "404 page not found" to every path — would otherwise hide every lane at once. A 5xx,
// a 401, a timeout or Ollama being down says nothing about the model either.
const MODEL_NOT_FOUND = /model ['"]?[^'"\s]+['"]? not found/i;
export const isGoneAnswer = (status, why) => status === 410 || (status === 404 && MODEL_NOT_FOUND.test(why || ''));
const PROBE_TIMEOUT_MS = 30000;
const ERROR_TEXT_MAX = 300;
const ZH_BY_STATUS = { 404: 'Ollama 上找不到该模型', 410: '该模型已被 Ollama 停用' };

// The server's own sentence: {"error":"…"} when it sent JSON, else the raw text, capped.
export function serverError(bodyText) {
  const raw = String(bodyText || '').trim();
  let msg = raw;
  try { const j = JSON.parse(raw); if (j && typeof j.error === 'string') msg = j.error; }
  catch { /* not JSON: the raw body IS the server's words */ }
  return msg.slice(0, ERROR_TEXT_MAX);
}

// The ONE error every Ollama caller throws for a non-2xx answer: the status, the server's reason
// and a Chinese line. `.gone` tells the caller to record it. It was `Ollama HTTP 410` alone, which
// left the user unable to tell a retired model from an outage.
export function ollamaHttpError(status, bodyText) {
  const why = serverError(bodyText);
  const gone = isGoneAnswer(status, why);
  const e = new Error(`Ollama HTTP ${status}${why ? ` — ${why}` : ''} · ${(gone && ZH_BY_STATUS[status]) || `Ollama 出错（${status}）`}`);
  e.status = status;
  e.gone = gone;
  e.serverError = why;
  return e;
}

const emptyHealth = () => ({ checked: 0, gone: {}, catalog: null, unknown: [], catalogError: null });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

// STRICT, like readJobRuns: missing = nothing known yet, damaged = THROWS. Each caller decides what
// damage means for it (chat: nothing known; the job: rebuild and say so).
export function readModelHealth(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return emptyHealth(); throw e; }
  const o = JSON.parse(txt);
  if (!isObj(o)) throw new Error(`${MODEL_HEALTH_FILENAME} is not an object`);
  return { checked: Number(o.checked) || 0, gone: isObj(o.gone) ? o.gone : {},
    catalog: Array.isArray(o.catalog) ? strings(o.catalog) : null, unknown: strings(o.unknown),
    catalogError: typeof o.catalogError === 'string' ? o.catalogError : null };
}

// A short reason for a status line: "retired 2026-09-25", "not found", or the status.
export function goneReason(rec) {
  const m = /retired at (\d{4}-\d{2}-\d{2})/.exec((rec && rec.error) || '');
  if (m) return `retired ${m[1]}`;
  return rec && rec.status === 404 ? 'not found' : `HTTP ${rec && rec.status}`;
}

// { "<model string>": "<reason>" } — the plain map web.mjs's lane decision takes.
export const goneModels = (health) =>
  Object.fromEntries(Object.entries((health && health.gone) || {}).map(([m, rec]) => [m, goneReason(rec)]));

// Record a gone answer a caller met. Fresh read-merge-write; a damaged file is rebuilt rather than
// blocking the record. Returns true when the model was not already known to be gone. A job run in
// progress re-reads before it writes (runModelCheck), so this record survives it.
export function recordGone(file, model, err, now = Date.now()) {
  let h;
  try { h = readModelHealth(file); }
  catch { h = emptyHealth(); }   // damaged: rebuilt by this write — the record is what matters now
  const was = h.gone[model];
  h.gone[model] = { status: err.status, error: err.serverError || '', since: was ? was.since : now, reported: !!(was && was.reported) };
  writeJsonFile(file, h);
  return !was;
}

// The two things web.mjs needs per request, bound to the node's file and audit log (R4: the
// wiring lives here, not in web.mjs). A damaged file must not take chat down: gone() degrades to
// "nothing known", which is how the node behaved before the check existed, and the next run
// rebuilds the file. Both failures are audited, never silent (R5). gone() runs on every chat turn
// and every /api/models, so its audit goes through `auditRepeating` — web.mjs passes its throttled
// auditSize — or a damaged file would write one entry per request for up to a day.
export function modelHealthFor(file, audit, auditRepeating = audit) {
  return {
    file,
    gone() {
      try { return goneModels(readModelHealth(file)); }
      catch (e) { auditRepeating('model-health-error', { error: String((e && e.message) || e) }); return {}; }
    },
    // A failed record never masks the caller's own error, which it is about to throw.
    noteGone(model, err) {
      try { if (recordGone(file, model, err)) audit('model-gone', { model, status: err.status, error: err.serverError }); }
      catch (e) { audit('model-health-error', { error: String((e && e.message) || e) }); }
    },
  };
}

// One probe with the app's own request shape (web.mjs streamOllama: {model, messages, stream}).
// num_predict:1 and an abort once the status is in keep it to a single token.
export async function probeLane({ url, model, fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS }) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetchImpl(url + '/api/chat', { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], stream: true, options: { num_predict: 1 } }) });
    if (r.ok) return { state: 'ok' };
    const e = ollamaHttpError(r.status, await r.text().catch(() => ''));   // no body: a 410 is still gone; a 404 without Ollama's sentence is not
    return e.gone ? { state: 'gone', status: r.status, error: e.serverError } : { state: 'unknown', error: e.message };
  } catch (e) {
    return { state: 'unknown', error: ac.signal.aborted ? `no answer within ${timeoutMs / 1000}s` : String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
    ac.abort();   // a status is all a probe needs — stop the stream
  }
}

// 'glm-5.3-flash:cloud' → 'glm-5.3-flash', 'deepseek-v4-pro:0813-cloud' → 'deepseek-v4-pro:0813'.
// null for a local model, which the cloud catalog cannot speak for.
export const catalogName = (model) => (/[:-]cloud$/.test(model || '') ? model.replace(/[:-]cloud$/, '') : null);
// The inverse, for a catalog name no lane uses yet: 'beam' → 'beam:cloud', 'clef:27b' → 'clef:27b-cloud'.
// MEASURED 2026-10-17 on Ollama 0.34.3: both reach the model with no pull; for a tagged name
// '<tag>-cloud' and '<tag>:cloud' both answer (mistral-large-3:675b), and '-cloud' is Ollama's own form.
export const cloudModel = (name) => (String(name).includes(':') ? `${name}-cloud` : `${name}:cloud`);

async function fetchCatalog(catalogUrl, fetchImpl) {
  const r = await fetchImpl(catalogUrl, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (!j || !Array.isArray(j.models)) throw new Error('no "models" list');
  return j.models.map((m) => m && m.name).filter((n) => typeof n === 'string').sort();
}

// The catalog as read now. A failed read keeps the last good list. Arrivals are not briefed here
// any more (docs/adr/0017): the weekly model review compares this list with the one it last saw.
async function readCatalog({ prev, catalogUrl, fetchImpl }) {
  if (!catalogUrl) return { catalog: prev.catalog, catalogError: null };
  try { return { catalog: await fetchCatalog(catalogUrl, fetchImpl), catalogError: null }; }
  catch (e) { return { catalog: prev.catalog, catalogError: String((e && e.message) || e) }; }
}

// Probe every Ollama lane, diff against the last record. Throws when NO lane could be checked:
// Ollama being down is a failed run (retried, audited), never a quiet "all fine" (R14).
export async function checkModels({ chatModels, url, catalogUrl, prev: given, now = Date.now(), fetchImpl = fetch }) {
  const prev = { ...emptyHealth(), ...(given || {}) };   // a record of an older shape lacks the newer fields
  const lanes = (chatModels || []).filter((m) => m && m.provider === 'ollama' && m.model);
  const results = await Promise.all(lanes.map(async (lane) => ({ lane, ...(await probeLane({ url, model: lane.model, fetchImpl })) })));
  if (results.length && results.every((r) => r.state === 'unknown')) {
    throw new Error(`model check: no Ollama lane could be checked at ${url} — ${results[0].error}`);
  }
  const gone = {};
  const changes = { retired: [], back: [], unknown: [], unknownFresh: [] };
  for (const r of results) {
    const was = prev.gone[r.lane.model];
    if (r.state === 'gone') {
      gone[r.lane.model] = { status: r.status, error: r.error, since: was ? was.since : now, reported: true };
      if (!was || !was.reported) changes.retired.push(r);
    } else if (r.state === 'unknown') {
      if (was) gone[r.lane.model] = was;   // no evidence either way: keep what was known
      changes.unknown.push(r);
      if (!prev.unknown.includes(r.lane.model)) changes.unknownFresh.push(r);
    } else if (was) changes.back.push(r);
  }
  const cat = await readCatalog({ prev, catalogUrl, fetchImpl });
  Object.assign(changes, { catalogError: cat.catalogError, catalogErrorFresh: !!cat.catalogError && !prev.catalogError });
  const summary = { lanes: lanes.length, served: results.filter((r) => r.state === 'ok').length,
    gone: results.filter((r) => gone[r.lane.model]).map((r) => r.lane.label || r.lane.id) };
  const probed = Object.fromEntries(results.map((r) => [r.lane.model, r.state]));
  const next = { checked: now, gone, catalog: cat.catalog, unknown: changes.unknown.map((r) => r.lane.model), catalogError: cat.catalogError };
  return { next, changes, summary, probed };
}

const laneLine = (r, tail) => `- ${r.lane.label || r.lane.id} (${r.lane.model})${tail ? ` — ${tail}` : ''}`;

// null = nothing changed (a quiet day: no briefing). A scheduled run reports what could not be
// checked only when it starts failing; a manual run always answers, and its "no change" line
// counts what answered — a lane still gone must not read as "all fine". New catalog models are
// never a line here: the weekly model review reports them with their scores (docs/adr/0017).
export function modelCheckBrief(changes, { summary = { lanes: 0, served: 0, gone: [] }, manual = false, rebuilt = null } = {}) {
  const parts = [];
  if (rebuilt) parts.push(`${MODEL_HEALTH_FILENAME} was unreadable and has been rebuilt · 状态文件已重建 (${rebuilt})`);
  if (changes.retired.length) {
    parts.push(['Gone from Ollama · 已停用 — hidden from the chooser; chats on it use the first lane still served:',
      ...changes.retired.map((r) => laneLine(r, `HTTP ${r.status}: ${r.error}`)),
      'Replace it in config.json chat_models · 请在 config.json 的 chat_models 中替换'].join('\n'));
  }
  if (changes.back.length) parts.push(['Answering again · 已恢复:', ...changes.back.map((r) => laneLine(r))].join('\n'));
  const unknown = manual ? changes.unknown : changes.unknownFresh;
  if (unknown.length) parts.push(['Could not check · 无法检查:', ...unknown.map((r) => laneLine(r, r.error))].join('\n'));
  if (changes.catalogError && (manual || changes.catalogErrorFresh)) parts.push(`Could not read the Ollama catalog · 无法读取模型目录: ${changes.catalogError}`);
  if (!parts.length) {
    if (!manual) return null;
    const { lanes, served, gone } = summary;
    return { body: `No change · 无变化 — ${served} of ${lanes} Ollama lanes answer · ${lanes} 个模型中 ${served} 个可用`
      + (gone.length ? `\nStill gone · 仍不可用: ${gone.join(', ')}` : '') };
  }
  return { body: parts.join('\n\n') };
}

// The job's run(): read → check → re-read → write → brief. A damaged record is rebuilt and said.
// The re-read keeps a gone answer a chat turn recorded while the probes ran, unless this run saw that
// model answer — the job's first read is older than that record.
export async function runModelCheck({ file, chatModels, url, catalogUrl, manual = false, now = Date.now(), fetchImpl = fetch }) {
  let prev, rebuilt = null;
  try { prev = readModelHealth(file); }
  catch (e) { prev = emptyHealth(); rebuilt = String((e && e.message) || e); }
  const { next, changes, summary, probed } = await checkModels({ chatModels, url, catalogUrl, prev, now, fetchImpl });
  let cur = null;
  try { cur = readModelHealth(file); }
  catch { /* damaged since the first read: this write rebuilds it, and nothing in it can be trusted */ }
  for (const [m, rec] of Object.entries((cur && cur.gone) || {})) {
    if (!next.gone[m] && !prev.gone[m] && probed[m] !== 'ok') next.gone[m] = rec;
  }
  writeJsonFile(file, next);
  return modelCheckBrief(changes, { summary, manual, rebuilt });
}
