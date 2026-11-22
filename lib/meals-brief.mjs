// Weekly Meals · 饮食 section（每周饮食小结, PLAN.md capability #3）— PURE
// aggregation of the stored meal records (lib/meals.mjs) into the 健康简报:
// deterministic lines, named thresholds, honest coverage, no LLM at brief
// time (R14). Split from lib/meals.mjs so both stay inside the R4 budget.
import { DAY_MS, localDateStr } from './schedule.mjs';
import { recentMeals, MEAL_FLAGS, MEALS_WINDOW_DAYS } from './meals.mjs';

// ── Named thresholds（命名阈值） ─────────────────────────────────────────────
export const MIN_PATTERN_PHOTOS = 2;    // pattern lines need ≥2 ANALYZED FOOD records — the denominators' own population, not raw photos
export const MIN_DINNERS = 2;           // the dinner-late average needs ≥2 dinners: an n=1 "average" is one meal, not a pattern
export const DINNER_LATE_MIN = 20 * 60; // dinner avg later than 20:00 → 晚餐偏晚
export const CARB_HEAVY_RATIO = 0.5;    // carb_heavy on more than half the food photos → 碳水偏多
export const VEG_LOW_RATIO = 0.5;       // vegetables on less than half → 蔬菜偏少
export const FRIED_RATIO = 1 / 3;       // fried on more than a third → 油炸偏多
const MAX_PATTERN_LINES = 2;            // with the coverage line: 3 lines max in the brief

// R3 drift guard: the aggregation keys must exist in lib/meals.mjs MEAL_FLAGS
// — a flag rename there fails HERE at module load, never silently at brief time.
const RULE_FLAGS = { carb: 'carb_heavy', veg: 'vegetables_present', sugar: 'sugary_drink', fried: 'fried' };
for (const f of Object.values(RULE_FLAGS)) {
  if (!MEAL_FLAGS.includes(f)) throw new Error(`meals-brief: rule flag ${f} missing from MEAL_FLAGS (R3 drift)`);
}

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const timeMins = (t) => { const m = /^(\d{2}):(\d{2})$/.exec(t || ''); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

// Read-back shape guard（读回校验）: month files live in the user workspace,
// where agent lanes and hand edits can also write. A record only counts as
// ANALYZED when its stored shape is intact — analyzed:true, boolean isFood,
// and (for food) every MEAL_FLAGS key a boolean. A malformed row counts in
// coverage as an unanalyzed photo, never in a pattern denominator (R14).
const validFlags = (o) => !!o && typeof o === 'object' && !Array.isArray(o) && MEAL_FLAGS.every((f) => typeof o[f] === 'boolean');
export const isAnalyzedMeal = (r) => r.analyzed === true && typeof r.isFood === 'boolean' && (!r.isFood || validFlags(r.flags));

// Deterministic pattern rules in priority order; every line cites its counts.
// `food` is guaranteed ≥ MIN_PATTERN_PHOTOS well-formed records by the caller.
function patternLines(food) {
  const out = [];
  const dts = food.filter((r) => r.slot === 'dinner').map((r) => timeMins(r.time)).filter((m) => m != null);
  if (dts.length >= MIN_DINNERS) {
    const avg = Math.round(dts.reduce((s, m) => s + m, 0) / dts.length);
    if (avg > DINNER_LATE_MIN) out.push(`- dinner avg ${hhmm(avg)} over ${dts.length} dinners, later than ${hhmm(DINNER_LATE_MIN)} · 晚餐偏晚 (平均${hhmm(avg)}，${dts.length}次晚餐)`);
  }
  const n = food.length;
  const cnt = (f) => food.filter((r) => r.flags[f]).length;
  const carb = cnt(RULE_FLAGS.carb); const veg = cnt(RULE_FLAGS.veg);
  const sugar = cnt(RULE_FLAGS.sugar); const fried = cnt(RULE_FLAGS.fried);
  if (carb / n > CARB_HEAVY_RATIO) out.push(`- carb-heavy ${carb}/${n} · 碳水偏多`);
  if (veg / n < VEG_LOW_RATIO) out.push(`- vegetables in ${veg}/${n} · 蔬菜偏少`);
  if (sugar > 0) out.push(`- sugary drinks ${sugar}/${n} · 含糖饮料${sugar}次`);
  if (fried / n > FRIED_RATIO) out.push(`- fried ${fried}/${n} · 油炸偏多`);
  return out;
}

// Calendar window（日历窗口）: the brief's week = MEALS_WINDOW_DAYS calendar
// days ending YESTERDAY — the same DAY convention analyzeHealth's daily rows
// use — so the photo count cannot drift against the rest of the brief and a
// meal is never counted by two consecutive weekly runs.
function windowDates(now) {
  const dates = new Set();
  for (let i = 1; i <= MEALS_WINDOW_DAYS; i++) dates.add(localDateStr(new Date(now.getTime() - i * DAY_MS)));
  return dates;
}

// Lines for the 健康简报 Meals · 饮食 section. Zero photos → [] (section
// omitted). Coverage is honest: analyzed:false AND malformed records count as
// photos, never as data; non-food photos count toward coverage but never
// toward pattern denominators. Patterns need ≥ MIN_PATTERN_PHOTOS analyzed
// FOOD records — the population the denominators are computed over — else the
// coverage line stands alone. Every count is computed here; the LLM never
// sees or phrases these lines (R14).
export function mealsBriefLines(user, { now = new Date() } = {}) {
  const dates = windowDates(now);
  const rows = recentMeals(user, MEALS_WINDOW_DAYS + 1, now).filter((r) => dates.has(r.date));
  if (!rows.length) return [];
  if (rows.length < MIN_PATTERN_PHOTOS) return [`- ${rows.length} photo this week — too few to see a pattern · 照片不足，暂无规律`];
  const analyzed = rows.filter(isAnalyzedMeal);
  const food = analyzed.filter((r) => r.isFood);
  const cover = analyzed.length === rows.length
    ? `- ${rows.length} photos this week · 本周${rows.length}张照片`
    : `- ${analyzed.length} of ${rows.length} photos analyzed this week · 本周${rows.length}张照片中已分析${analyzed.length}张`;
  if (food.length < MIN_PATTERN_PHOTOS) return [cover]; // too few analyzed food records — no invented trend (R14)
  return [cover, ...patternLines(food).slice(0, MAX_PATTERN_LINES)];
}
