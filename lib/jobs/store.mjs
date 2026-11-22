// Job store（任务存储）— jobs are DATA, one JSON file each, under the user's own workspace.
//
// The rule this exists for: creating or changing a job must never require a server restart.
// Nothing here imports web.mjs and nothing here runs a job — the store only reads, writes and
// VALIDATES. A runner is supplied separately (lib/jobs/run.mjs), so the store stays testable
// with no scheduler, no tools and no network.
//
// A malformed file is SKIPPED AND REPORTED, never fatal (R5): one bad row must not stop the
// tick for every other job the user has.
import fs from 'node:fs';
import path from 'node:path';
import { slugOk, writeFileAtomic } from '../webutil.mjs';
import { TIME_RE } from '../schedule.mjs';   // the ONE HH:MM shape (R3)

export const JOBS_DIRNAME = 'jobs';
export const DELIVER = ['own-message', 'feed-only'];
// LEGACY alias. 'fold-daily' (ride in the daily brief) was the default until the daily brief
// was removed (2026-10-11, docs/adr/0004). Job files on disk still say it, and they must keep
// working without anyone rewriting user data — so it is NORMALISED to 'own-message' here, when a
// job is read or validated, and nothing is written back. A file is only rewritten when its
// owner saves the job again (PATCH/POST), which then stores 'own-message'.
export const LEGACY_DELIVER = { 'fold-daily': 'own-message' };
export const PLAN_KINDS = ['tool'];          // more kinds arrive with the resolver
export const TITLE_MAX = 80;
export const PROMPT_MAX = 2000;
export const MAX_JOBS = 50;                  // a bound, not a product limit

export const jobsDir = (userDir) => path.join(userDir, JOBS_DIRNAME);
export const jobPath = (userDir, id) => path.join(jobsDir(userDir), `${id}.json`);

const bad = (m) => ({ ok: false, error: m });

// Returns {ok:true, job} or {ok:false, error} — never throws, never partially accepts.
// Every rejection names the field, because these files are hand-editable and a silent
// "job stopped running" is the worst outcome here.
// `lanes` and `tools` come from the CALLER: which models this install actually has, and the
// tool catalogue. The store stays the authority on SHAPE; what is valid here is not its
// business to know. Omit them and the model field is shape-checked but not cross-checked.
export function validateJob(raw, { id, lanes = null, tools = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('not a JSON object');
  const jid = String(raw.id || id || '');
  if (!slugOk(jid)) return bad(`id must be a slug (a-z 0-9 -), got ${JSON.stringify(jid)}`);
  if (id && raw.id && raw.id !== id) return bad(`id "${raw.id}" does not match its filename "${id}"`);

  const title = String(raw.title || '').trim();
  if (!title) return bad('title is required');
  if (title.length > TITLE_MAX) return bad(`title over ${TITLE_MAX} chars`);
  if (raw.prompt != null && typeof raw.prompt !== 'string') return bad('prompt must be a string');
  if (raw.prompt && raw.prompt.length > PROMPT_MAX) return bad(`prompt over ${PROMPT_MAX} chars`);

  const s = raw.schedule;
  if (!s || typeof s !== 'object') return bad('schedule is required, e.g. {"time":"06:30"}');
  if (!TIME_RE.test(String(s.time || ''))) return bad(`schedule.time must be HH:MM, got ${JSON.stringify(s.time)}`);
  if (s.day !== undefined && !(Number.isInteger(s.day) && s.day >= 0 && s.day <= 6)) {
    return bad('schedule.day must be 0-6 (0 = Sunday) or absent for daily');
  }

  const p = raw.plan;
  if (!p || typeof p !== 'object') return bad('plan is required, e.g. {"kind":"tool","tool":"pollen"}');
  if (!PLAN_KINDS.includes(p.kind)) return bad(`plan.kind must be one of ${PLAN_KINDS.join(', ')}, got ${JSON.stringify(p.kind)}`);
  if (p.kind === 'tool' && !slugOk(String(p.tool || ''))) return bad(`plan.tool must be a slug, got ${JSON.stringify(p.tool)}`);

  // Per-job model（每个任务可指定模型）. Optional: most tools are deterministic and use none.
  if (raw.model != null && raw.model !== '') {
    if (typeof raw.model !== 'string') return bad('model must be a model id, e.g. "claude"');
    if (lanes && !lanes.includes(raw.model)) return bad(`unknown model ${JSON.stringify(raw.model)} — have: ${lanes.join(', ')}`);
    // Refused rather than ignored: a model pinned on a tool that never calls one is a setting
    // that silently does nothing, which is the failure mode this engine guards hardest against.
    const man = tools && p.tool ? tools[p.tool] : null;
    if (man && man.usesModel === false) return bad(`${p.tool} does not use a model — pinning one would do nothing`);
  }
  if (p.args != null && (typeof p.args !== 'object' || Array.isArray(p.args))) return bad('plan.args must be an object');

  const given = raw.deliver === undefined ? 'own-message' : raw.deliver;
  const deliver = Object.prototype.hasOwnProperty.call(LEGACY_DELIVER, given) ? LEGACY_DELIVER[given] : given;
  if (!DELIVER.includes(deliver)) return bad(`deliver must be one of ${DELIVER.join(', ')}, got ${JSON.stringify(raw.deliver)}`);
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return bad('enabled must be true or false');
  if (raw.pausedReason != null && typeof raw.pausedReason !== 'string') return bad('pausedReason must be a string');

  return { ok: true, job: {
    id: jid, name: jid,                       // `name` is what the scheduler and job-runs.json key on
    title, prompt: raw.prompt || '',
    schedule: s.day === undefined ? { time: s.time } : { time: s.time, day: s.day },
    plan: { kind: p.kind, tool: p.tool, args: p.args || {} },
    // Empty = whatever lane the tool is configured to use. Pinned = THIS job always uses
    // that model, so changing a global default never silently changes what a job does.
    model: (raw.model && String(raw.model)) || '',
    deliver, enabled: raw.enabled !== false,
    pausedReason: raw.pausedReason || '',
    created: Number(raw.created) || 0, updated: Number(raw.updated) || 0,
    author: raw.author === 'chat' ? 'chat' : 'user',
    source: 'file',                            // distinguishes a data job from a built-in
  } };
}

// Reads every job file. NEVER throws for a bad file — bad ones come back in `bad[]` so the
// caller can surface them; the good ones still run.
export function loadJobs(userDir, { onBad } = {}) {
  const dir = jobsDir(userDir);
  const out = { jobs: {}, bad: [] };
  let names;
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); }
  catch (e) { return e.code === 'ENOENT' ? out : (out.bad.push({ id: null, error: `jobs/ unreadable: ${e.message}` }), out); }
  for (const f of names.slice(0, MAX_JOBS)) {
    const id = f.slice(0, -5);
    let v;
    try { v = validateJob(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), { id }); }
    catch (e) { v = bad(`unreadable: ${e.message}`); }
    if (v.ok) out.jobs[v.job.name] = v.job;
    else { out.bad.push({ id, error: v.error }); if (onBad) onBad(id, v.error); }
  }
  return out;
}

export function saveJob(userDir, raw) {
  const v = validateJob(raw);
  if (!v.ok) throw new Error(`invalid job: ${v.error}`);
  fs.mkdirSync(jobsDir(userDir), { recursive: true });
  const now = Date.now();
  const job = { ...v.job, created: v.job.created || now, updated: now };
  const { name, source, ...onDisk } = job;                       // derived fields are not stored
  const p = jobPath(userDir, job.id);
  writeFileAtomic(p, JSON.stringify(onDisk, null, 2));   // the ONE tmp+rename writer (R3): a crash never
                                                         // leaves half a job file, and no link is written through
  return job;
}

export function deleteJob(userDir, id) {
  if (!slugOk(String(id || ''))) throw new Error('invalid job id');
  try { fs.unlinkSync(jobPath(userDir, id)); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
