// Model review settings and state · 模型评测的配置与状态 (docs/adr/0017)
//
// ONE config key, `model_review`, an object whose defaults live here and nowhere else (R3).
// lib/config.mjs validateConfig calls modelReviewSetting, so a bad value refuses to load and the
// running node keeps its last good config (docs/adr/0011); the job reads cfg.model_review at use.
//
// model-review.json (node root, beside model-health.json, gitignored runtime state):
//   { reviewedAt: <ms> | 0, catalogSeen: [catalog names at the last review],
//     undo: { at, hadKey, previous: [lanes] | null, applied: [lanes], added: [model strings] } | null,
//     declined: [model strings an Undo took back — never proposed again] }
// No file = this node has never been reviewed, so the next review only reports.
import fs from 'node:fs';
import { TIME_RE } from './schedule.mjs';   // the ONE HH:MM shape (R3)
import { writeJsonFile } from './atomicwrite.mjs';

export const MODEL_REVIEW_FILENAME = 'model-review.json';

export const MODEL_REVIEW_DEFAULTS = Object.freeze({
  time: '03:00',                       // daily HH:MM the job looks whether a review is due
  every_days: 7,                       // a review is due this many days after the last one
  tests: 'model-review/tests.json',    // the test data file, relative to the node root
  concurrency: 3,                      // Ollama calls at once
  call_timeout_s: 120,                 // per Ollama call; no answer by then is a failure
  max_calls: 200,                      // Ollama calls per review, both rounds together
  margin: 0.5,                         // how much higher (score points) a newcomer must rank
  max_slowdown: 1.5,                   // a newcomer may be at most this many times slower to first text
  agent_lanes: true,                   // also measure the Claude and Codex lanes on the text tests (never swapped)
});

// [min, max] for each number; integers where a fraction means nothing.
const RANGES = {
  every_days: [1, 365, true], concurrency: [1, 16, true], call_timeout_s: [5, 1800, true],
  max_calls: [1, 5000, true], margin: [0, 5, false], max_slowdown: [1, 100, false],
};

const bad = (msg) => { throw new Error(`model_review: ${msg}`); };

function checkNumber(key, v) {
  const [min, max, int] = RANGES[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
    bad(`${key} must be ${int ? 'a whole number' : 'a number'} from ${min} to ${max}, got ${JSON.stringify(v)}`);
  }
}

// The validated settings: defaults overlaid with config.json's `model_review`. Throws on an
// unknown sub-key (a typo would otherwise be a setting that silently does nothing) or a bad value.
export function modelReviewSetting(cfg) {
  const given = cfg.model_review;
  if (given !== undefined && (given === null || typeof given !== 'object' || Array.isArray(given))) bad('must be an object');
  for (const k of Object.keys(given || {})) {
    if (!(k in MODEL_REVIEW_DEFAULTS)) bad(`unknown key "${k}" (known: ${Object.keys(MODEL_REVIEW_DEFAULTS).join(', ')})`);
  }
  const s = { ...MODEL_REVIEW_DEFAULTS, ...(given || {}) };
  if (typeof s.time !== 'string' || !TIME_RE.test(s.time)) bad(`time: not HH:MM: ${JSON.stringify(s.time)}`);
  if (typeof s.tests !== 'string' || !s.tests.trim()) bad('tests must be a file path');
  for (const k of Object.keys(RANGES)) checkNumber(k, s[k]);
  if (typeof s.agent_lanes !== 'boolean') bad(`agent_lanes must be true or false, got ${JSON.stringify(s.agent_lanes)}`);
  return s;
}

export const emptyReviewState = () => ({ reviewedAt: 0, catalogSeen: [], undo: null, declined: [] });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);

// STRICT like readModelHealth: missing = never reviewed; damaged = THROWS, and the caller decides
// (the review rebuilds it and only reports; Undo refuses).
export function readReviewState(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return { ...emptyReviewState(), exists: false }; throw e; }
  const o = JSON.parse(txt);
  if (!isObj(o)) throw new Error(`${MODEL_REVIEW_FILENAME} is not an object`);
  const u = isObj(o.undo) && Array.isArray(o.undo.applied) ? o.undo : null;
  return { reviewedAt: Number(o.reviewedAt) || 0, catalogSeen: strings(o.catalogSeen), undo: u,
    declined: strings(o.declined), exists: true };
}

export function writeReviewState(file, state) {
  const out = { ...state };
  delete out.exists;   // it describes the read, it is not state
  writeJsonFile(file, out);
}
