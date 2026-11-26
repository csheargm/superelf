// 夜间代码审查 · Nightly review (docs/adr/0046): every night, GPT (the Codex CLI, read-only sandbox) reviews
// each configured repo's new commits; a second pass (Claude, read-only file tools) confirms or rejects each
// finding; one morning briefing (emailed by the normal briefing path, lib/notify.mjs) says what was found.
//   range    last reviewed commit..branch tip (state.json); the first run: the last window_h hours
//   skip     no new commits: the project is one line, and with nothing else to say no briefing at all
//   failure  codex error, timeout, empty or unparsable reply, the deadline: "REVIEW FAILED", the range is
//            NOT marked reviewed (tried again next night), never reported as "no findings" (R14)
//   fix      a repo with fix:"selfpub" (superelf) hands its confirmed findings to the core lane
//            (lib/selfpub, ADR 0044) as ONE change; nothing is published until the owner taps Publish
// Every repo is a read-only clone: no token, push URL unreachable, and the tree is checked clean after Codex.
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonFile } from '../atomicwrite.mjs';
import { localDateStr } from '../schedule.mjs';
import { nightlySetting, slugOf } from './config.mjs';
import { syncRepo, pickRange, diffChunks, commitLines } from './repo.mjs';
import { reviewPrompt, verifyPrompt, parseFindings, parseVerdict, fixRequest, plainPrompt, parsePlain } from './prompt.mjs';
import { renderEmail } from './digest.mjs';
import { git } from '../selfpub/checkout.mjs';

export const STATE_FILE = 'state.json';
const MIN = 60000;
const LEFT_MIN_MS = MIN;   // less than this left before the deadline: stop, the run is failed (backstop)

export function readState(dir) {
  try { const s = JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')); return { repos: (s && s.repos) || {} }; }
  catch (e) { if (e.code === 'ENOENT') return { repos: {} }; throw new Error(`nightly review: ${STATE_FILE} unreadable: ${e.message}`); }
}
function writeState(dir, s) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); writeJsonFile(path.join(dir, STATE_FILE), s); }

function timeLeft(deadline, now) {
  const left = deadline - now();
  if (left < LEFT_MIN_MS) throw new Error('the run deadline was reached before every part was reviewed');
  return left;
}

// Codex over each diff chunk; any failed or unparsable reply fails the project.
async function findAll(ctx, range, chunks) {
  const { r, d, s, dir, deadline } = ctx;
  const found = [];
  for (let i = 0; i < chunks.length; i++) {
    const timeoutMs = Math.min(s.call_min * MIN, timeLeft(deadline, d.now));
    const res = await d.codex({ cmd: s.codex_cmd, cwd: dir, timeoutMs,
      prompt: reviewPrompt({ repo: r.name, range: `${range.base.slice(0, 7)}..${range.tip.slice(0, 7)}`, commits: range.commits.length, chunk: chunks[i], part: i + 1, parts: chunks.length }) });
    if (!res || !res.ok) throw new Error(`codex: ${String((res && res.text) || 'no result').slice(0, 300)}`);
    if (res.code !== undefined && (res.code !== 0 || res.signal)) throw new Error(`codex exited ${res.signal || res.code} (part ${i + 1}); its reply is not trusted`);
    try { found.push(...parseFindings(res.text)); } catch (e) { throw new Error(`codex reply unusable (part ${i + 1}): ${e.message}`); }
    if (git(dir, ['status', '--porcelain']).trim()) throw new Error('the review changed files in the read-only clone; its findings are not trusted');
  }
  return found;
}

async function verifyAll(ctx, findings) {
  const { d, s, dir, deadline } = ctx;
  const out = { confirmed: [], rejected: [], unverified: [] };
  for (const [i, f] of findings.entries()) {
    if (i >= s.max_verify) { out.unverified.push({ ...f, reason: `not verified: over max_verify (${s.max_verify})` }); continue; }
    const res = await d.verify({ cwd: dir, prompt: verifyPrompt(f), timeoutMs: Math.min(s.call_min * MIN, timeLeft(deadline, d.now)) });
    const v = res && res.ok ? parseVerdict(res.text) : { verdict: 'unverified', reason: `verifier failed: ${String((res && res.text) || '').slice(0, 200)}` };
    out[v.verdict].push({ ...f, reason: v.reason });
  }
  return out;
}

async function startFix(ctx, confirmed) {
  const { r, d, date } = ctx;
  if (r.fix !== 'selfpub' || !confirmed.length) return {};
  if (!d.startFix) return { fix: 'not started: no core lane on this node', fixState: 'not-started' };
  try {
    const f = await d.startFix({ request: fixRequest(confirmed, date), title: `夜间审查修复 ${date} · Nightly review fixes` });
    return { fix: f.text, fixId: f.id || null, fixState: f.state || null, fixTitle: f.title || null };
  } catch (e) { return { fix: `not started: ${String((e && e.message) || e).slice(0, 200)}`, fixState: 'not-started' }; }
}

// One repo → its project record. A throw anywhere (fetch, codex, deadline) is caught by the caller.
async function reviewRepo(ctx) {
  const { r, d, s, st } = ctx;
  const dir = ctx.dir = path.join(s.dir, 'repos', slugOf(r.name));
  timeLeft(ctx.deadline, d.now);
  const tip = syncRepo({ dir, url: r.url, branch: r.branch });
  const range = pickRange(dir, { tip, lastSha: st.lastSha || st.retryBase, now: d.now(), windowMs: s.window_h * 3600000 });
  const base = ctx.known = { name: r.name, base: range.base, tip, commits: range.commits, note: range.note };   // a later failure still names its range
  if (!range.commits.length) return { ...base, status: 'skipped' };
  const chunks = diffChunks(dir, { base: range.base, tip, capBytes: s.chunk_kb * 1024 });
  const cut = chunks.flatMap((c) => c.cut);
  if (!chunks.length) base.note = [base.note, 'the commits change nothing overall (they cancel out); nothing to review'].filter(Boolean).join('; ');
  const findings = await findAll(ctx, range, chunks);
  const v = await verifyAll(ctx, findings);
  if (d.now() > ctx.deadline) throw new Error('the run deadline passed during the verify pass');   // a queued verify may start late
  return { ...base, status: 'reviewed', cut, log: commitLines(dir, range.commits), ...v, ...(await startFix(ctx, v.confirmed)) };
}

// The fix started on an earlier night: its state now, said once more until it is final.
function previousFix(d, st) {
  if (!st.fixId || !d.fixStatus) return { text: null, final: false };
  try { return d.fixStatus(st.fixId); } catch (e) { return { text: `status unreadable: ${String(e.message || e).slice(0, 120)}`, final: false }; }
}

export async function runNightlyReview(d, { manual = false } = {}) {
  const s = nightlySetting(d.cfg, d.env);
  if (!s.enabled) return manual ? { body: 'Nightly review is off (nightly_review.enabled) · 夜间代码审查未开启' } : null;
  if (!s.repos.length) return manual ? { body: 'Nightly review has no repos (nightly_review.repos) · 未配置要审查的仓库' } : null;
  const date = localDateStr(new Date(d.now()));
  const deadline = d.now() + s.deadline_min * MIN;
  const state = readState(s.dir);
  const projects = [];
  for (const r of s.repos) {
    const st = state.repos[r.name] || {};
    const prev = previousFix(d, st);
    const ctx = { r, d, s, st, date, deadline };
    let p;
    try { p = await reviewRepo(ctx); }
    catch (e) { p = { name: r.name, base: st.lastSha || '', tip: '', commits: [], ...ctx.known, status: 'failed', why: String((e && e.message) || e).slice(0, 400) }; }
    p.prevFix = prev.text; p.prevFixWaiting = !!prev.waiting; p.prevFixLive = !!prev.live;
    projects.push(p);
    if (p.status === 'failed') {
      d.audit && d.audit('nightly-review-failed', { repo: r.name, error: p.why });
      // A failed FIRST range is remembered, so the window cannot age it out before it is reviewed.
      if (!st.lastSha && ctx.known && ctx.known.base) { state.repos[r.name] = { ...st, retryBase: ctx.known.base }; writeState(s.dir, state); }
      continue;
    }
    const fixId = p.fixId || (prev.final ? null : st.fixId || null);   // a fix not started never drops the one still open
    state.repos[r.name] = { lastSha: p.tip, reviewedAt: d.now(), ...(fixId ? { fixId } : {}) };
    writeState(s.dir, state);   // after each success: a later repo's failure never loses this one's progress
  }
  const news = projects.some((p) => p.status !== 'skipped' || p.prevFix);
  if (!news && !manual) return null;
  // Every project failed: the briefing still goes out (it says why), and the run reads as failed in the Jobs view.
  const failed = projects.length > 0 && projects.every((p) => p.status === 'failed');
  const plain = await plainWords(d, s, projects, deadline);
  return { ...renderEmail(projects, { date, plain, baseUrl: d.cfg.public_base_url || '' }), ...(failed ? { failed: true } : {}) };
}

// One plain-words pass over every confirmed finding (the verify path: read-only Claude). Any failure is
// carried as { error } and the email falls back to the technical text, so no finding is ever dropped.
async function plainWords(d, s, projects, deadline) {
  const all = projects.filter((p) => p.status === 'reviewed').flatMap((p) => p.confirmed);
  if (!all.length) return null;
  try {
    const res = await d.verify({ cwd: s.dir, prompt: plainPrompt(all), timeoutMs: Math.min(s.call_min * MIN, timeLeft(deadline, d.now)) });
    if (!res || !res.ok) throw new Error(String((res && res.text) || 'no reply').slice(0, 200));
    return { items: parsePlain(res.text, all.length) };
  } catch (e) { return { error: String((e && e.message) || e).slice(0, 200) }; }
}

// One run at a time per node: a Run now during the night's run is refused, a scheduled one yields.
let running = false;
export function nightlyReviewJobs(deps) {
  const { cfg, env = process.env } = deps;
  return {
    'nightly-review': {
      name: 'nightly-review', title: '夜间代码审查 · Nightly review', type: 'digest', ownerOnly: true,
      get schedule() { try { const s = nightlySetting(cfg, env); return s.enabled ? { time: s.time } : null; } catch { return null; /* bad settings: Run now reports the error */ } },
      run: async (user, opts = {}) => {
        if (running) { if (opts.manual) throw new Error('a nightly review is already running · 夜间审查正在进行'); return null; }
        running = true;
        try { return await runNightlyReview({ now: Date.now, ...deps, env }, { manual: !!opts.manual }); }
        finally { running = false; }
      },
    },
  };
}
