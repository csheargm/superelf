// 夜间代码审查的设置 · Nightly review settings (docs/adr/0046). Read at EVERY use (no restart):
// config.json `nightly_review` wins; when it is absent, the SUPERELF_NIGHTLY_REVIEW env var (JSON, set by a
// private node's compose file) is the fallback; with neither, the job is off. Invalid settings throw, and
// the job's run reports that (never a silent default).
import path from 'node:path';
import { TIME_RE } from '../schedule.mjs';

export const ENV_KEY = 'SUPERELF_NIGHTLY_REVIEW';
export const DEFAULT_DIR = '/data/nightly-review';
export const DEFAULTS = Object.freeze({
  enabled: false, time: '02:30', dir: DEFAULT_DIR, codex_cmd: 'codex',
  deadline_min: 60,        // the whole run: one backstop (fail closed)
  call_min: 20,            // one Codex or verify call
  chunk_kb: 150,           // one Codex call reviews at most this much diff
  max_verify: 20,          // findings verified per project; the rest are listed as unverified
  window_h: 24,            // the first run (no last-reviewed commit) reviews this many hours back
});
export const FIX_MODES = ['selfpub', 'none'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;

const bad = (m) => { throw new Error(`nightly_review: ${m}`); };
// https for real repos; an absolute local path only for a throwaway test remote. Never ext::, ssh, file:: tricks.
export const urlOk = (u) => typeof u === 'string' && !u.includes('..') && !u.startsWith('-') && !u.includes('::')
  && (/^https:\/\/[A-Za-z0-9.-]+\/[\w./-]+$/.test(u) || (path.isAbsolute(u) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)));

function repoOf(r, i) {
  if (!r || typeof r !== 'object') bad(`repos[${i}]: not an object`);
  if (!NAME_RE.test(String(r.name || ''))) bad(`repos[${i}].name: letters, digits, space . _ - (max 40)`);
  if (!urlOk(r.url)) bad(`repos[${i}].url: an https URL`);
  const branch = r.branch === undefined ? 'main' : r.branch;
  if (!BRANCH_RE.test(String(branch)) || String(branch).includes('..')) bad(`repos[${i}].branch: not a branch name`);
  const fix = r.fix === undefined ? 'none' : r.fix;
  if (!FIX_MODES.includes(fix)) bad(`repos[${i}].fix: one of ${FIX_MODES.join(', ')}`);
  return { name: r.name, url: r.url, branch, fix };
}

function rawSetting(cfg, env) {
  if (cfg && cfg.nightly_review !== undefined) return cfg.nightly_review;
  const s = env && env[ENV_KEY];
  if (!s) return null;
  try { return JSON.parse(s); } catch (e) { return bad(`${ENV_KEY} is not JSON: ${e.message}`); }
}

const posNum = (v, k) => (Number.isFinite(v) && v > 0 ? v : bad(`${k}: a positive number`));

export function nightlySetting(cfg, env = process.env) {
  const raw = rawSetting(cfg, env);
  if (raw === null) return { ...DEFAULTS, repos: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) bad('not an object');
  const s = { ...DEFAULTS, repos: [], ...raw };
  if (typeof s.enabled !== 'boolean') bad('enabled: true or false');
  if (typeof s.time !== 'string' || !TIME_RE.test(s.time)) bad(`time: not HH:MM: ${JSON.stringify(s.time)}`);
  if (typeof s.dir !== 'string' || !path.isAbsolute(s.dir)) bad('dir: an absolute path');
  if (typeof s.codex_cmd !== 'string' || !s.codex_cmd) bad('codex_cmd: a command');
  for (const k of ['deadline_min', 'call_min', 'chunk_kb', 'max_verify', 'window_h']) posNum(s[k], k);
  if (!Array.isArray(s.repos)) bad('repos: a list');
  const repos = s.repos.map(repoOf);
  if (new Set(repos.map((r) => r.name)).size !== repos.length) bad('repos: two repos share a name');
  return { ...s, repos };
}

// The folder a repo's read-only clone lives in, under the job's dir: from its name, never its URL.
export const slugOf = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
