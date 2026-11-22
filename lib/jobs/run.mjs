// Job runner（任务执行）— turns a validated job record into the `run(user, job)` that
// lib/autonomy.mjs runJob expects.
//
// Contract inherited from runJob, and the whole reason a threshold job works at all:
//   null   = intentional silence — nothing stored, nothing sent
//   {body} = a briefing
//   throw  = failure — retried, and visible in the audit log
//
// An UNKNOWN tool throws. It must never resolve to silence: a job quietly doing nothing
// forever is indistinguishable from a quiet day, which is the failure mode this engine has
// to guard hardest against.
import { TOOLS } from './tools.mjs';

// `ctx` carries what a tool cannot get by itself — the lanes web.mjs owns, the user, config.
// A job's own `model` is layered on top, so a pinned lane wins over the global default for
// this job only. That is the point of pinning: changing the default must never silently
// change what an existing job does.
export function makeRunner(tools = TOOLS, baseCtx = {}) {
  return async function runPlanned(user, job) {
    const plan = job && job.plan;
    if (!plan || plan.kind !== 'tool') throw new Error(`job ${job && job.name}: unsupported plan kind ${JSON.stringify(plan && plan.kind)}`);
    const tool = tools[plan.tool];
    if (!tool) throw new Error(`job ${job.name}: unknown tool "${plan.tool}" (have: ${Object.keys(tools).sort().join(', ') || 'none'})`);
    const args = plan.args || {};
    const ctx = { ...baseCtx, user, job, model: (job && job.model) || null };
    const reading = await tool.run(args, ctx);
    const out = tool.brief(reading, args);
    if (out == null) return null;                       // quiet day
    if (!out.body || !String(out.body).trim()) {
      // R14: an empty briefing must never be stored — that is how "all good" spam is born,
      // and how a broken tool passes for a working one.
      throw new Error(`job ${job.name}: tool "${plan.tool}" produced an empty briefing`);
    }
    return out;
  };
}

// Built-ins own their own run(); data jobs get theirs from the runner. Both end up as the
// same shape, so the scheduler and the Jobs view never need to know which is which.
export const attachRunner = (job, runner) => (job.run ? job : { ...job, run: (user, opts) => runner(user, job, opts) });
