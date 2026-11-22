// Model review · 模型评测 (docs/adr/0017) — the weekly job that tests Ollama cloud models on OUR
// uses, keeps the best in the chat chooser, and reports what it found and why, with the scores.
//
//   due      the scheduler asks daily at model_review.time; a review runs when every_days have
//            passed since the last one, or the daily model check (lib/model-health.mjs) recorded a
//            catalog name the last review did not see. Not due: no briefing. Run now always reviews.
//   round 1  every current Ollama lane and every unconfigured catalog model answers the quick tests
//            (time to first text, errors, the format our apps parse).
//   round 2  the current lanes plus the ROUND2_NEWCOMERS fastest clean newcomers answer the rest.
//   agents   with model_review.agent_lanes, the Claude and Codex lanes answer the text tests too,
//            compared only, never swapped (lib/model-review-agent.mjs).
//   grade    Claude, blind, one call per test (lib/model-review-grade.mjs). A grading failure fails
//            the run: nothing is written.
//   decide   lib/model-review-pick.mjs; write   lib/model-review-apply.mjs; report   -report.mjs (the
//            briefing text) and -email.mjs (the email's HTML part, with the charts).
// The FIRST review on a node only reports. The tests are data (model_review.tests). The undo job
// beside it restores the list from before the last change.
import path from 'node:path';
import { readModelHealth, catalogName, laneModel } from './model-health.mjs';
import { DAY_MS, localDateStr } from './schedule.mjs';
import { loadJobs } from './jobs/store.mjs';
import { modelReviewSetting, readReviewState, emptyReviewState, writeReviewState, MODEL_REVIEW_FILENAME } from './model-review-config.mjs';
import { loadReviewTests } from './model-review-tests.mjs';
import { runCalls } from './model-review-call.mjs';
import { isAgentLane, agentKey, runAgentCalls } from './model-review-agent.mjs';
import { gradeAll } from './model-review-grade.mjs';
import { summarize, pickRound2, referencedIds, decideChanges, applyChanges, ROUND2_NEWCOMERS } from './model-review-pick.mjs';
import { readRawConfig, baseLanes, applyReview, undoReview } from './model-review-apply.mjs';
import { reviewBrief, undoBrief, NOTHING_TO_UNDO, NO_CATALOG } from './model-review-report.mjs';
import { reviewHtml } from './model-review-email.mjs';

const unique = (xs) => [...new Set(xs)];
const pairsOf = (models, tests) => models.flatMap((model) => tests.map((test) => ({ model, test })));

// Whole local days, so a review at 03:05 is due again at 03:00 seven days on, not a day later.
export function reviewDue({ state, catalog, settings, now }) {
  if (!state.reviewedAt) return true;
  const days = Math.round((new Date(localDateStr(new Date(now))) - new Date(localDateStr(new Date(state.reviewedAt)))) / DAY_MS);
  return days >= settings.every_days || catalog.some((n) => !state.catalogSeen.includes(n));
}

// A damaged record is rebuilt, and the review then only reports, saying why (R5).
function loadState(file) {
  try { return { state: readReviewState(file), rebuilt: null }; }
  catch (e) { return { state: { ...emptyReviewState(), exists: false }, rebuilt: String((e && e.message) || e) }; }
}

// How many newcomers round 1 can test within max_calls, keeping room for round 2. Throws when even
// the current lanes do not fit: a review that silently tested less would not be a review (R14).
export function planRounds({ laneCount, newcomerCount, quick, rest, maxCalls }) {
  const need = (c) => (laneCount + c) * quick + (laneCount + Math.min(ROUND2_NEWCOMERS, c)) * rest;
  if (need(0) > maxCalls) throw new Error(`model review: max_calls ${maxCalls} cannot test the ${laneCount} current lanes (${need(0)} calls)`);
  let c = newcomerCount;
  while (c > 0 && need(c) > maxCalls) c -= 1;
  return c;
}

function prepare({ d, settings, base, health, state }) {
  const url = d.cfg.ollama_url;   // ONE endpoint for the whole run: names, calls and the apply check
  const lanes = base.filter((l) => l.provider === 'ollama' && l.model);
  if (!lanes.length) throw new Error('model review: no Ollama lane in chat_models to review');
  const configured = new Set(lanes.map((l) => catalogName(l.model, url)).filter(Boolean));
  const seen = new Set(state.catalogSeen);
  const ordered = [...health.catalog.filter((n) => !seen.has(n)), ...health.catalog.filter((n) => seen.has(n))];   // arrivals first
  const all = ordered.filter((n) => !configured.has(n)).map((name) => ({ name, model: laneModel(name, url) }));
  const newcomers = all.filter((n) => !state.declined.includes(n.model));
  const tests = loadReviewTests(path.resolve(d.root, settings.tests), { appPrompts: (d.cfg.system_prompts || {}).apps });
  const laneModels = unique(lanes.map((l) => l.model));
  const quick = tests.tests.filter((t) => t.quick), rest = tests.tests.filter((t) => !t.quick);
  const n = planRounds({ laneCount: laneModels.length, newcomerCount: newcomers.length, quick: quick.length, rest: rest.length, maxCalls: settings.max_calls });
  const untested = Object.fromEntries(newcomers.slice(n).map((x) => [x.name, { kind: 'untested', why: 'not tested: max_calls · 超出调用上限，未测试' }]));
  const agentLanes = settings.agent_lanes ? base.filter(isAgentLane) : [];
  return { d, settings, url, base, lanes, laneModels, health, state, ...tests, quick, rest, newcomers: newcomers.slice(0, n), untested, agentLanes,
    declined: all.filter((x) => state.declined.includes(x.model)).map((x) => x.name) };
}

async function testAndGrade(ctx) {
  const { d, settings } = ctx;
  const budget = { used: 0, max: settings.max_calls };
  const call = (pairs) => runCalls({ pairs, url: ctx.url, auth: d.auth(), settings, budget, fetchImpl: d.fetchImpl });
  const r1 = await call(pairsOf([...ctx.laneModels, ...ctx.newcomers.map((x) => x.model)], ctx.quick));
  if (r1.every((r) => r.error)) throw new Error(`model review: no model answered at ${ctx.url} — ${r1[0].error}`);
  const { picked, dropped } = pickRound2({ newcomers: ctx.newcomers, results: r1 });
  const models = [...ctx.laneModels, ...picked.map((x) => x.model)];
  const r2 = await call(pairsOf(models, ctx.rest));
  const ra = await runAgentCalls({ lanes: ctx.agentLanes, tests: ctx.tests.filter((t) => t.group !== 'Vision'),
    timeoutMs: settings.call_timeout_s * 1000, run: d.runLane });
  const results = [...r1.filter((r) => models.includes(r.model)), ...r2, ...ra];
  const graded = await gradeAll({ tests: ctx.tests, results, rubric: ctx.rubric, ask: d.ask, cfg: d.cfg, rng: d.rng });
  return { results, models, picked, dropped, graded, calls: budget.used, agentCalls: ra.length };
}

// Decide, write (unless this is the node's first review), report.
function conclude(ctx) {
  const { d, settings } = ctx;
  const agents = ctx.agentLanes.map((lane) => ({ key: agentKey(lane), lane }));
  const stats = summarize({ models: [...ctx.models, ...agents.map((a) => a.key)], tests: ctx.tests, results: ctx.results, scores: ctx.graded.scores });
  const refs = referencedIds(d.cfg, ctx.base, d.pinnedModels());
  const decision = decideChanges({ lanes: ctx.base, stats, newcomers: ctx.picked, refs, settings });
  const now = d.now();
  const nextState = { ...ctx.state, reviewedAt: now, catalogSeen: ctx.health.catalog };
  let outcome = 'none', why = null, lanesAfter = ctx.base;
  if (!ctx.state.exists) { outcome = 'report'; writeReviewState(d.stateFile, nextState); }
  else if (decision.changes.length) {
    const next = applyChanges(ctx.base, decision.changes);
    const a = applyReview({ root: d.root, stateFile: d.stateFile, state: ctx.state, nextState, base: ctx.base, next,
      added: decision.changes.map((c) => c.in.model), now, url: ctx.url });
    ({ outcome, why } = a);
    if (outcome === 'applied') lanesAfter = next; else writeReviewState(d.stateFile, a.state);
  } else writeReviewState(d.stateFile, nextState);
  const report = { outcome, why, rebuilt: ctx.rebuilt, changes: decision.changes, lanesBefore: ctx.base, lanesAfter, stats,
    models: ctx.models, agents, tests: ctx.tests, round1: { ...ctx.dropped, ...ctx.untested }, notes: decision.notes, bars: decision.bars,
    blocked: decision.blocked, declined: ctx.declined, settings,
    cost: { ollama: ctx.calls, agent: ctx.agentCalls, claude: ctx.graded.calls, minutes: (Date.now() - ctx.t0) / 60000 } };
  return { body: reviewBrief(report), html: reviewHtml(report) };   // html: the email's chart part (lib/notify.mjs)
}

// The job's run(). null = not due (no briefing). Throws on a failed run, having written nothing.
export async function runModelReview(d, { manual = false } = {}) {
  const t0 = Date.now();
  const settings = modelReviewSetting(d.cfg);
  const health = readModelHealth(d.healthFile);   // damaged: the run fails; the daily check rebuilds it
  const { state, rebuilt } = loadState(d.stateFile);
  if (!health.catalog) return manual ? { body: NO_CATALOG } : null;
  if (!manual && !reviewDue({ state, catalog: health.catalog, settings, now: d.now() })) return null;
  const base = baseLanes(readRawConfig(d.root), d.root);
  const ctx = prepare({ d, settings, base, health, state });
  return conclude({ ...ctx, ...(await testAndGrade(ctx)), t0, rebuilt });
}

export function runModelUndo(d) {
  const r = undoReview({ root: d.root, stateFile: d.stateFile });
  return { body: r ? undoBrief(r) : NOTHING_TO_UNDO };
}

// Every lane id a job file pins (lib/jobs/store.mjs `model`): removing one would break that job.
const pinnedModels = (dirs) => dirs.flatMap((dir) => Object.values(loadJobs(dir).jobs).map((j) => j.model).filter(Boolean));

// One review or Undo at a time per node (keyed by its state file; the node is one process). Each
// reads model-review.json when it starts and writes it when it ends, so an overlap (Run now again
// while a long review runs, or Undo during one) wrote back a stale record and lost the other's
// undo or declined list. A manual run that finds one going is refused, changing nothing; a
// scheduled one returns null (no briefing), since the run in progress reports.
const running = new Map();
const REVIEW = { en: 'a model review', zh: '模型评测' }, UNDO = { en: 'an Undo', zh: '撤销' };
async function oneAtATime(stateFile, what, manual, fn) {
  const cur = running.get(stateFile);
  if (cur && !manual) return null;
  if (cur) throw new Error(`${cur.en} is already running; nothing done, try again when it finishes · ${cur.zh}正在进行，未作任何更改，请待其结束后再试`);
  running.set(stateFile, what);
  try { return await fn(); } finally { running.delete(stateFile); }
}

// The two built-ins web.mjs JOBS spreads in. `cfg` is the LIVE config object (reloaded in place,
// docs/adr/0011), so the time and every setting are read at use. healthFile() names model-health.json
// (a function: web.mjs builds JOBS before its modelHealth). ask({ args, prompt, user, timeoutMs }) →
// { ok, text } runs the claude CLI (web.mjs: runAgent in the agent queue). runLane({ lane, systemPrompt,
// prompt, timeoutMs, onDelta, user }) runs an agent lane (lib/model-review-agent.mjs laneRunner).
// auth() → the Ollama headers (web.mjs ollamaAuth): ollama.com answers 401 without the key.
// ownerOnly: the models are the node's (docs/adr/0007). The undo job has no schedule: it runs only
// from Run now, and the Jobs view lists it as "on demand" (lib/jobstatus.mjs).
export function modelReviewJobs({ cfg, root, healthFile, ask, runLane, auth = () => ({}), userDirs = () => [], fetchImpl = fetch, now = Date.now, rng = Math.random }) {
  const stateFile = path.join(root, MODEL_REVIEW_FILENAME);
  const deps = (user) => ({ cfg, root, healthFile: healthFile(), stateFile, fetchImpl, now, rng, auth,
    ask: (a) => ask({ ...a, user }), pinnedModels: () => pinnedModels(userDirs()),
    runLane: (a) => (runLane ? runLane({ ...a, user }) : Promise.reject(new Error('no runLane wired for the agent lanes'))) });
  return {
    'model-review': {
      name: 'model-review', title: '模型评测 · Model review', type: 'digest', ownerOnly: true,
      get schedule() { return { time: modelReviewSetting(cfg).time }; },   // validated at load, read at every tick
      run: (user, opts = {}) => oneAtATime(stateFile, REVIEW, !!opts.manual, () => runModelReview(deps(user), { manual: !!opts.manual })),
    },
    'model-review-undo': {
      name: 'model-review-undo', title: '撤销模型评测 · Undo model review', type: 'digest', ownerOnly: true, onDemand: true,
      run: (user) => oneAtATime(stateFile, UNDO, true, async () => runModelUndo(deps(user))),
    },
  };
}
