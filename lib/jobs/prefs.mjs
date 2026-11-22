// Per-user ON/OFF for BUILT-IN jobs · 内置任务的开关
//
// A built-in job is code (the JOBS literal in web.mjs), so it cannot be edited or deleted. It
// must still be possible to turn one OFF. Before this, a built-in briefing (then 每日一报,
// since removed) fired every morning with no supported way to stop it: the settings row shows an Edit button only for file jobs, and
// PATCH/DELETE answered 403 for a built-in, so "I don't want this briefing" was unsayable.
//
// The override lives in <workspace>/job-prefs.json, a sibling of job-runs.json — deliberately NOT
// inside the jobs/ directory, where every .json is scanned as a job file and this would be
// reported as an invalid one.
//
//   { "health-brief": { "enabled": false } }
//
// File jobs are absent from this file by design: they carry their own `enabled` field and are
// patched and deleted directly, so recording them here would be a second source of truth (R3).
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonFile } from '../webutil.mjs';

export const PREFS_FILENAME = 'job-prefs.json';
export const prefsFile = (userDir) => path.join(userDir, PREFS_FILENAME);
// Said on the row, so a job the user switched off never reads as a fault.
export const PAUSED_BY_USER = 'turned off here · 已关闭';
export const PREFS_UNREADABLE = 'settings unreadable · 无法读取任务开关';

// STRICT, exactly like readJobRuns: a missing file means "no overrides", but an unreadable or
// corrupt one THROWS. Treating damage as "{}" would silently resurrect a job the user had turned
// off and start mailing them again — the single outcome this file exists to prevent (R5).
export function readJobPrefs(userDir) {
  let txt;
  try { txt = fs.readFileSync(prefsFile(userDir), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
  const o = JSON.parse(txt);                     // corrupt JSON throws here — the caller audits
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('job-prefs.json is not an object');
  return o;
}

// Fresh read-merge-write, so two writes cannot lose each other. Turning a job back ON deletes the
// key rather than storing `true`: the built-in's own default is then what applies, and the file
// stays a list of deliberate exceptions instead of a copy of the defaults that can drift.
export function setJobEnabled(userDir, id, enabled) {
  const prefs = readJobPrefs(userDir);
  if (enabled) delete prefs[id];
  else prefs[id] = { ...(prefs[id] || {}), enabled: false };
  writeJsonFile(prefsFile(userDir), prefs);       // atomic (shared helper, R3)
  return prefs;
}

// The built-ins a person gets: an `ownerOnly` job (the node's, not a person's) only for the node
// owner (lib/owner.mjs nodeOwnerId). The objects are passed through, not copied, so a live getter
// such as model-check's schedule keeps reading config at every tick.
export const builtinsFor = (builtins, isNodeOwner) =>
  (isNodeOwner ? builtins : Object.fromEntries(Object.entries(builtins || {}).filter(([, j]) => !j.ownerOnly)));

// NEVER MUTATES its input. The JOBS literal is module-level and shared by every user in the
// household, so writing `enabled` onto it would turn one person's briefing off for everybody.
export function applyJobPrefs(builtins, prefs) {
  const out = {};
  for (const [name, j] of Object.entries(builtins || {})) {
    out[name] = (prefs && prefs[name] && prefs[name].enabled === false)
      ? { ...j, enabled: false, pausedReason: PAUSED_BY_USER }
      : j;
  }
  return out;
}

// What to show when the prefs file cannot be read. Holding every built-in OFF is the safe
// direction — running a briefing the user switched off is the failure that matters — and the
// reason travels with it so the row explains itself instead of showing a bare "paused".
export function heldOff(builtins, why) {
  const out = {};
  for (const [name, j] of Object.entries(builtins || {})) {
    out[name] = { ...j, enabled: false, pausedReason: `${PREFS_UNREADABLE} — ${why}` };
  }
  return out;
}
