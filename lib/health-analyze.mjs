// Deterministic-first health analysis (docs/design/ios-health-ingestion.md §3).
// Plain code computes trends / threshold flags / correlations / gap accounting
// over the DAILY ROLLUPS (never raw samples); ONE injected LLM pass then phrases
// suggestions from those computed aggregates only. R14 throughout: missing data
// is reported as missing, a failed run yields NO briefing, empty ≠ pass.
import { recentHealth } from './health.mjs';
import { DAY_MS, localDateStr } from './schedule.mjs';
import { loadReminders } from './reminders.mjs';
import { loadActions } from './autonomy.mjs';
import { adherenceReport, adherenceHorizonDays, WALK_REMINDER_TIME } from './adherence.mjs';
import { mealsBriefLines } from './meals-brief.mjs';

// Rolling analysis horizon: 30d windows + a prior-week margin, in DAILY rows.
// The weekly brief widens this to the oldest evaluated intervention's
// before-window (adherenceHorizonDays) — a fixed fetch orphaned older
// interventions into 'insufficient data forever' (R13 finding).
const ANALYSIS_DAYS = 60;

// Daily-rollup field per locked metric (rollupDay in lib/health.mjs writes these).
const FIELDS = { steps: 'steps', sleep: 'sleepMinutes', weight: 'weight' };
const LABELS = { steps: 'Steps 步数', sleep: 'Sleep 睡眠', weight: 'Weight 体重' };
const UNITS = { steps: 'steps/day', sleep: 'min/night', weight: 'kg' };
const GAP_TEXT = {
  steps: 'no steps data this week · 本周无步数数据',
  sleep: 'no sleep data this week · 本周无睡眠数据',
  weight: 'no weight data this week · 本周无体重数据',
};
const MIN_CORR_N = 10;          // design §3: correlations only with n ≥ 10 paired days
const rnd = (v, p = 1) => Math.round(v * 10 ** p) / 10 ** p;

// Zero-baseline marker — ONE string (R3): lib/adherence.mjs meanChange and
// trendLine below phrase the same fact ("percent change vs 0 is undefined,
// show the absolute rise") and must read identically in the briefing.
export const FROM_ZERO_TEXT = ' · from zero · 从0开始';

// Metrics that ACCUMULATE during the day. Their analysis windows end YESTERDAY:
// on any run during the day, today's step count is a partial day, and
// counting it as a full day dragged the 7d mean down into false threshold
// flags (R13 finding). Sleep buckets on the morning it ENDS (complete when
// analyzed) and weight is a point-in-time reading — both may include today.
const CUMULATIVE = new Set(['steps']);

// Exported for lib/adherence.mjs — ONE date helper and ONE stats impl (R3).
export function daysAgo(now, n) { const d = new Date(now); d.setDate(d.getDate() - n); return localDateStr(d); }

// The 7-day threshold window for one metric — cumulative metrics end
// YESTERDAY (see CUMULATIVE above).
function d7Window(byDate, name, now) {
  const off = CUMULATIVE.has(name) ? 1 : 0;
  return windowStats(byDate, FIELDS[name], daysAgo(now, 6 + off), daysAgo(now, off));
}

// Values of one metric across a [from..to] calendar window (dates inclusive).
// `expected` = days in the window, derived from the range itself (a caller-
// supplied literal could silently disagree with the dates).
export function windowStats(byDate, field, from, to) {
  const expected = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
  const vals = Object.keys(byDate).filter((d) => d >= from && d <= to).sort()
    .map((d) => byDate[d][field]).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const mean = vals.length ? rnd(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  const sorted = [...vals].sort((a, b) => a - b);
  const median = vals.length ? rnd(sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : null;
  return { mean, median, present: vals.length, expected, first: vals[0] ?? null, last: vals[vals.length - 1] ?? null };
}

function pearson(pairs) {
  const n = pairs.length;
  const mx = pairs.reduce((a, p) => a + p[0], 0) / n, my = pairs.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return (sxx && syy) ? rnd(sxy / Math.sqrt(sxx * syy), 2) : 0;
}

// Config-driven threshold flags — each carries the exact numbers that fired it.
// A metric with NO data cannot flag (that is a gap, not a breach — R14).
function computeFlags(m, thresholds) {
  const flags = []; const t = thresholds || {};
  if (m.steps.d7.present > 0 && t.steps_min_daily && m.steps.d7.mean < t.steps_min_daily)
    flags.push({ metric: 'steps', rule: 'steps_min_daily', threshold: t.steps_min_daily, value: m.steps.d7.mean,
      text: `steps 7d avg ${m.steps.d7.mean} < ${t.steps_min_daily} threshold · 步数7日均值低于阈值` });
  if (m.sleep.d7.present > 0 && t.sleep_min_minutes && m.sleep.d7.mean < t.sleep_min_minutes)
    flags.push({ metric: 'sleep', rule: 'sleep_min_minutes', threshold: t.sleep_min_minutes, value: m.sleep.d7.mean,
      text: `sleep 7d avg ${m.sleep.d7.mean} min < ${t.sleep_min_minutes} min threshold · 睡眠7日均值低于阈值` });
  const w = m.weight.d7;
  if (w.present >= 2 && t.weight_delta_kg_7d && Math.abs(w.last - w.first) > t.weight_delta_kg_7d)
    flags.push({ metric: 'weight', rule: 'weight_delta_kg_7d', threshold: t.weight_delta_kg_7d, value: rnd(w.last - w.first),
      text: `weight changed ${rnd(w.last - w.first)} kg in 7d (>${t.weight_delta_kg_7d} kg) · 体重7日变化超过阈值` });
  return flags;
}

// Pure + deterministic: rows = recentHealth() daily rollups (oldest→newest).
export function analyzeHealth(rows, { thresholds = {}, now = new Date() } = {}) {
  const byDate = {}; for (const r of rows || []) byDate[r.date] = r;
  const metrics = {};
  for (const [name, field] of Object.entries(FIELDS)) {
    const off = CUMULATIVE.has(name) ? 1 : 0;   // cumulative windows END YESTERDAY
    const d7 = d7Window(byDate, name, now);
    const prior7 = windowStats(byDate, field, daysAgo(now, 13 + off), daysAgo(now, 7 + off));
    const d30 = windowStats(byDate, field, daysAgo(now, 29 + off), daysAgo(now, off));
    // Percent change vs a ZERO baseline is undefined → deltaPct stays null,
    // but a zero mean with real coverage is DATA (R14): trendLine renders it
    // as the absolute change (0 → X), never as a missing prior week.
    const deltaPct = (d7.mean != null && prior7.mean) ? rnd(((d7.mean - prior7.mean) / prior7.mean) * 100) : null;
    metrics[name] = { d7, prior7, d30, deltaPct };
  }
  const gaps = Object.keys(FIELDS).filter((n) => metrics[n].d7.present === 0).map((n) => GAP_TEXT[n]);
  const flags = computeFlags(metrics, thresholds);
  // steps ↔ sleep, same-day pairs over the last 30 days; r only with n ≥ 10,
  // always with n. Ends yesterday — the pairs contain cumulative steps.
  const from = daysAgo(now, 30), to = daysAgo(now, 1);
  const pairs = Object.keys(byDate).filter((d) => d >= from && d <= to)
    .map((d) => [byDate[d].steps, byDate[d].sleepMinutes])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  const correlations = [pairs.length >= MIN_CORR_N
    ? { pair: 'steps~sleep', n: pairs.length, r: pearson(pairs), note: 'correlation, not causation · 相关非因果' }
    : { pair: 'steps~sleep', n: pairs.length, note: `insufficient paired days (n=${pairs.length} < ${MIN_CORR_N}) — not computed` }];
  const hasData = rows && rows.length > 0;
  return { generated: localDateStr(now), hasData, metrics, gaps, flags, correlations };
}

// ── LLM phrasing pass (aggregates ONLY ever leave this module) ────────────────
// SINGLE source of the suggestion prompt (R3). The model gets the computed
// aggregates JSON below — never raw samples, never per-day rows, no web search.
const SUGGEST_PROMPT =
  'You are phrasing a weekly family health digest. Below is a JSON of COMPUTED AGGREGATES ' +
  '(7/30-day trends, threshold flags, data gaps, correlations) from one person\'s own data. ' +
  'Write 3-5 short, actionable, first-principles diet / exercise / sleep suggestions as a ' +
  'markdown bullet list. Rules: each suggestion must cite a finding from the JSON; use ONLY ' +
  'numbers present in the JSON — never invent any; every bullet bilingual (English + 中文); ' +
  'treat a gap as "collect this data", not as good or bad news; correlations are correlations, ' +
  'never causation; this is lifestyle guidance, not medical advice 非医疗建议. Aggregates JSON:\n';

// Rebuilt EXPLICITLY field-by-field so nothing beyond aggregates can leak into
// the prompt even if analyzeHealth() grows richer output later.
export function buildSuggestionPrompt(analysis) {
  const slim = (w) => ({ mean: w.mean, median: w.median, daysPresent: w.present, daysExpected: w.expected });
  const aggregates = {
    metrics: Object.fromEntries(Object.keys(FIELDS).map((n) => [n, {
      unit: UNITS[n], last7d: slim(analysis.metrics[n].d7), prior7d: slim(analysis.metrics[n].prior7),
      last30d: slim(analysis.metrics[n].d30), deltaPctVsPrior7d: analysis.metrics[n].deltaPct }])),
    flags: analysis.flags.map((f) => f.text),
    gaps: analysis.gaps,
    correlations: analysis.correlations,
  };
  return SUGGEST_PROMPT + JSON.stringify(aggregates, null, 1);
}

// The delta clause of one trend line. Three honest cases (R14): a computable
// percent; a genuine ZERO baseline with coverage (absolute change, the
// lib/adherence.mjs meanChange precedent — never "no data"); no prior rows.
function deltaText(m) {
  if (m.deltaPct != null) return `${m.deltaPct > 0 ? '+' : ''}${m.deltaPct}% vs prior 7d`;
  if (m.prior7.mean === 0) return `prior 7d avg 0 → ${m.d7.mean}${FROM_ZERO_TEXT}`;
  return 'no prior week to compare · 无上周数据可比';
}

function trendLine(name, m) {
  const { d7, d30 } = m;
  if (d7.present === 0) return `- ${LABELS[name]}: ${GAP_TEXT[name]}`;
  const delta = deltaText(m);
  return `- ${LABELS[name]}: 7d avg ${d7.mean} ${UNITS[name]} (${d7.present}/${d7.expected} days), 30d avg ${d30.mean ?? '—'} (${d30.present}/${d30.expected} days), ${delta}`;
}

// The full weekly digest body (markdown). Deterministic sections + the LLM's
// suggestion bullets (already validated non-empty by the caller). `llmLabel`
// names the lane that phrased the suggestions — REQUIRED honesty when the lane
// is cloud-hosted (design: aggregates only ever leave the machine, and the
// briefing says which lane saw them).
export function renderBriefing(analysis, suggestions, llmLabel = '', adherenceLines = [], mealLines = []) {
  const parts = [`# 健康简报 · Weekly Health Brief`, `Week ending ${analysis.generated}`, '', '## Trends · 趋势'];
  for (const n of Object.keys(FIELDS)) parts.push(trendLine(n, analysis.metrics[n]));
  if (analysis.flags.length) { parts.push('', '## Flags · 阈值提醒'); for (const f of analysis.flags) parts.push(`- ${f.text}`); }
  // Adherence（跟进闭环, lib/adherence.mjs): deterministic follow-through
  // verdicts on past interventions — never phrased by the LLM (R14).
  if (adherenceLines.length) { parts.push('', '## Adherence · 跟进'); for (const l of adherenceLines) parts.push(l); }
  // Meals（拍照记录饮食, lib/meals.mjs): pure aggregation of the stored
  // meal-photo records — never phrased by the LLM (R14); empty → no section.
  if (mealLines.length) { parts.push('', '## Meals · 饮食'); for (const l of mealLines) parts.push(l); }
  const c = analysis.correlations[0];
  parts.push('', '## Correlations · 相关性',
    c.r !== undefined ? `- steps~sleep: r=${c.r} (n=${c.n} paired days) — ${c.note}` : `- steps~sleep: ${c.note}`);
  parts.push('', '## Suggestions · 建议', suggestions.trim(), '',
    '_Lifestyle guidance computed from your own aggregated data — not medical advice · 基于你本人汇总数据的生活方式建议，非医疗建议_');
  if (llmLabel) parts.push(`_analyzed via ${llmLabel} (aggregates only) · 仅聚合数据_`);
  return parts.join('\n');
}

// ── Proposed actions（提议行动）— the approval loop's first PRODUCER ──────────
// DETERMINISTIC code decides WHAT to propose from the computed flags/gaps (R14:
// never LLM-invented actions; every number in the `why` sentence comes from the
// analysis). Shape = lib/autonomy.mjs proposeAction fields — summary IS the
// why（原因）sentence; payload.flag is the dedupe key the denial cooldown
// (lib/actions.mjs deniedRecently) matches on, checked via deps.isSuppressed.
const MAX_PROPOSALS = 2;
export function healthProposals(analysis, { isSuppressed = () => false } = {}) {
  const out = [];
  const steps = analysis.flags.find((f) => f.rule === 'steps_min_daily');
  if (steps && !isSuppressed('steps_min_daily')) out.push({
    type: 'create-reminder',
    title: 'Daily walk reminder · 每日散步提醒',
    summary: `why: steps 7d avg ${steps.value} < ${steps.threshold} threshold — a daily ${WALK_REMINDER_TIME} walk nudge · 步数7日均值${steps.value}低于阈值${steps.threshold}，建议每日${WALK_REMINDER_TIME}散步提醒`,
    payload: { flag: 'steps_min_daily', text: 'Walk 20 minutes · 散步20分钟', time: WALK_REMINDER_TIME },
  });
  const sleep = analysis.metrics.sleep.d7;
  if (out.length < MAX_PROPOSALS && analysis.hasData && sleep.present === 0 && !isSuppressed('gap_sleep')) out.push({
    type: 'create-reminder',
    title: 'Sleep-data check reminder · 睡眠数据检查提醒',
    summary: `why: ${GAP_TEXT.sleep} (0/${sleep.expected} days) — a weekly Saturday 09:00 Shortcut check · 建议每周六09:00检查健康快捷指令`,
    payload: { flag: 'gap_sleep', text: 'Check the Health Shortcut sync · 检查健康快捷指令同步', time: '09:00', day: 6 },
  });
  return out.slice(0, MAX_PROPOSALS);
}

// Weekly job body. deps = { llm(prompt)→text, llmLabel, thresholds, now, manual,
// isSuppressed(flag) — denial-cooldown check for healthProposals }.
// R14 contract: empty store → null when scheduled (no briefing at all) but an
// explicit "no data yet" body when run manually; LLM failure or empty output →
// THROW (the job fails, no briefing is saved — never an empty "all good").
export async function healthBriefBody(user, deps = {}) {
  const now = deps.now || new Date();
  // Adherence stores load FIRST: the row fetch must reach back to the oldest
  // evaluated intervention's before-window, not a fixed horizon. A corrupt
  // reminders/actions store THROWS here → the job fails loudly (R5), never a
  // brief that silently omits follow-through.
  const reminders = loadReminders(user);
  const actionsHistory = loadActions(user);
  const rows = recentHealth(user,
    Math.max(ANALYSIS_DAYS, adherenceHorizonDays({ reminders, actionsHistory, now })));
  const analysis = analyzeHealth(rows, { thresholds: deps.thresholds, now });
  if (!analysis.hasData) {
    if (!deps.manual) return null;
    return { body: '# 健康简报 · Weekly Health Brief\n\nNo health data received yet — set up the iPhone Shortcut from your profile\'s Health setup. · 尚未收到任何健康数据 — 请在个人资料的“健康接入”中设置 iPhone 快捷指令。' };
  }
  if (typeof deps.llm !== 'function') throw new Error('health-brief: no LLM lane injected');
  // Adherence（跟进闭环）: deterministic verdicts on past interventions,
  // computed BEFORE the LLM pass — the model never sees them (R14).
  const suppressed = typeof deps.isSuppressed === 'function' ? deps.isSuppressed : () => false;
  const adherence = adherenceReport({ reminders, actionsHistory, rows, now, isSuppressed: suppressed });
  let suggestions;
  try { suggestions = await deps.llm(buildSuggestionPrompt(analysis)); }
  catch (e) { throw new Error(`health-brief: suggestion pass failed (${e && e.message || e}) — no briefing produced`); }
  if (!suggestions || !String(suggestions).trim()) throw new Error('health-brief: LLM returned empty suggestions — no briefing produced (empty ≠ pass)');
  // An ACTIVE intervention owns its flag: re-proposing create-reminder for a
  // reminder that already exists would only stack noise — the adherence
  // verdict speaks for that flag now (approve would dedupe, but the ask itself
  // is the cost — P2).
  const proposals = healthProposals(analysis, { isSuppressed: (f) => adherence.activeFlags.has(f) || suppressed(f) });
  // Meals（饮食小结）: deterministic lines from the stored meal-photo records
  // (lib/meals.mjs), computed like adherence BEFORE the render — never LLM.
  return { body: renderBriefing(analysis, String(suggestions), deps.llmLabel || '', adherence.lines, mealsBriefLines(user, { now })),
    actions: [...proposals, ...adherence.proposals] };
}
