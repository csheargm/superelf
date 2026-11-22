// Scores and the update rule · 评分与更换规则 (docs/adr/0017)
//
// Pure functions over the run's results: no I/O, so every rule is pinned by a unit test.
//   quality   mean score per group (Fast, Deep, Vision) over that group's tests; a failed answer
//             counts 0 (R14), so a model that fails half the tests cannot average well.
//   first     median seconds to first text over the group's passing answers.
//   rank      quality - weight x first. Fast weighs speed ten times more than Deep does.
// A newcomer replaces the weakest REMOVABLE lane of a group only when its rank beats that lane's
// by `margin` and it is at most `max_slowdown` times slower to first text, with no failed Fast or
// Deep answer. A group below GROUP_KEEP lanes takes the newcomer as an addition on the same terms.
// A model sits in one group; each group changes at most once; Claude, Codex and every non-Ollama
// lane are never touched; an id another key references is never removed.
import { slugOk } from './webutil.mjs';
import { cloudModel } from './model-health.mjs';

export const GROUP_KEEP = 3;                       // lanes each of Fast and Deep keeps
export const ROUND2_NEWCOMERS = 6;                 // newcomers that reach the full test set
export const SPEED_WEIGHT = { Fast: 0.3, Deep: 0.03 };   // rank points per second to first text
export const CHANGED_GROUPS = ['Fast', 'Deep'];

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// { model: { quality: {Fast, Deep, Vision}, first: {…}, firstAll, fails, failNotes, tested } }
// fails counts Fast and Deep only: Vision is reported, never a reason to drop a text lane.
export function summarize({ models, tests, results, scores }) {
  const out = {};
  const textTests = new Set(tests.filter((t) => t.group !== 'Vision').map((t) => t.id));
  for (const model of models) {
    const mine = results.filter((r) => r.model === model);
    const st = { quality: {}, first: {}, fails: 0, failNotes: [], tested: mine.length };
    for (const g of ['Fast', 'Deep', 'Vision']) {
      const ts = tests.filter((t) => t.group === g);
      const rs = ts.map((t) => mine.find((r) => r.test === t.id)).filter(Boolean);
      st.quality[g] = rs.length ? mean(rs.map((r) => (r.fail ? 0 : ((scores[r.test] || {})[model] ?? 0)))) : null;
      st.first[g] = median(rs.filter((r) => !r.fail && r.firstTextMs !== null).map((r) => r.firstTextMs / 1000));
      if (g !== 'Vision') for (const r of rs.filter((x) => x.fail)) { st.fails += 1; st.failNotes.push(`${r.test}: ${r.fail}`); }
    }
    st.firstAll = median(mine.filter((r) => !r.fail && r.firstTextMs !== null && textTests.has(r.test)).map((r) => r.firstTextMs / 1000));
    out[model] = st;
  }
  return out;
}

export function rank(st, group) {
  if (!st || st.quality[group] === null || st.first[group] === null) return -Infinity;
  return st.quality[group] - SPEED_WEIGHT[group] * st.first[group];
}

// Round 1 → round 2: newcomers with every quick answer passing, fastest first, at most `limit`.
// Returns { picked: [names], dropped: { name: { kind, why } } }; kind is 'untested', 'failed' or
// 'slower', so the report can group them ("9 were slower in the quick round").
export function pickRound2({ newcomers, results, limit = ROUND2_NEWCOMERS }) {
  const ok = [], dropped = {};
  for (const n of newcomers) {
    const rs = results.filter((r) => r.model === n.model);
    const failed = rs.find((r) => r.fail);
    if (!rs.length) dropped[n.name] = { kind: 'untested', why: 'not tested (call budget) · 未测试（调用上限）' };
    else if (failed) dropped[n.name] = { kind: 'failed', why: `${failed.test}: ${failed.fail}` };
    else ok.push({ n, first: median(rs.map((r) => r.firstTextMs / 1000)) });
  }
  ok.sort((a, b) => a.first - b.first);
  ok.slice(limit).forEach((x) => { dropped[x.n.name] = { kind: 'slower', why: `slower than the ${limit} picked · 第一轮较慢` }; });
  return { picked: ok.slice(0, limit).map((x) => x.n), dropped };
}

// Ids no review may remove: what other config keys resolve to (a DERIVED default counts — health_llm
// unset means the first Ollama lane, and removing it would silently move the health brief), the
// default lane (the list's first entry), and every model a job file pins.
export function referencedIds(cfg, lanes, pinned = []) {
  const ids = [cfg.health_llm, cfg.research && cfg.research.llm, ...(cfg.assess_models || []),
    cfg.vision_default, cfg.one_shot_model, lanes[0] && lanes[0].id, ...pinned];
  return new Set(ids.filter((x) => typeof x === 'string' && x));
}

// The lane a newcomer must beat in a group, or why the group cannot change.
function barFor(group, lanes, stats, refs) {
  const members = lanes.filter((l) => l.provider === 'ollama' && l.group === group);
  if (!members.length) return { why: `no ${group} lane · 无 ${group} 模型` };
  const byRank = (a, b) => rank(stats[a.model], group) - rank(stats[b.model], group);
  if (members.length < GROUP_KEEP) return { kind: 'add', lane: [...members].sort(byRank)[0] };
  const removable = members.filter((l) => !refs.has(l.id));
  if (!removable.length) return { why: `every ${group} lane is used by another setting · 均被其他配置引用` };
  return { kind: 'replace', lane: removable.sort(byRank)[0] };
}

// How a newcomer does against a group's bar: { adv, ok, code, why, group, kind, bar }. code says
// why it is not ok — 'fail' (a failed answer), 'margin' (not clearly better), 'slow' — so the
// report can say it in plain words; `why` is the same reason as one line.
function versus(n, st, bar, group, settings, stats) {
  const bst = stats[bar.lane.model];
  const adv = rank(st, group) - rank(bst, group);
  const slow = bst && bst.first[group] !== null && st.first[group] !== null && st.first[group] > bst.first[group] * settings.max_slowdown;
  const at = { adv, group, kind: bar.kind, bar: bar.lane };
  if (st.fails) return { ...at, ok: false, code: 'fail', why: `round 2: ${st.failNotes[0]}` };
  if (!(adv >= settings.margin)) return { ...at, ok: false, code: 'margin', why: `${group}: not clearly better than ${bar.lane.label || bar.lane.id} (${fmt(adv)} < ${settings.margin}) · 优势不足` };
  if (slow) return { ...at, ok: false, code: 'slow', why: `${group}: ${fmt(st.first[group])} s to first text vs ${fmt(bst.first[group])} s · 太慢` };
  return { ...at, ok: true, code: null };
}
const noteOf = (t) => ({ code: t.code, why: t.why, model: t.n.model, group: t.group, kind: t.kind, bar: t.bar, adv: t.adv });
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');

// New lane: a fresh id from the catalog name (lowercase slug, unique), the name as its label.
export function newLane(name, group, taken) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'model';
  const root = slugOk(slug) ? slug : `m-${slug}`.slice(0, 36);   // a reserved device name (con, nul…) is not an id
  let id = root;
  for (let i = 2; taken.has(id); i += 1) id = `${root}-${i}`;
  taken.add(id);
  return { id, label: String(name), group, provider: 'ollama', model: cloudModel(name) };
}

// Each group takes one qualifying newcomer or none, and no newcomer joins two groups. Every such
// assignment is tried — two groups and at most ROUND2_NEWCOMERS newcomers is at most 49 — and the
// one with the most changes, then the biggest total lead, wins. A model that leads both groups
// takes the one that leaves the other to a second newcomer, rather than blocking it.
function bestAssignment(wins) {
  let best = { picks: [], count: 0, lead: -Infinity };
  const walk = (gi, picks, used) => {
    if (gi === CHANGED_GROUPS.length) {
      const lead = picks.reduce((a, w) => a + w.adv, 0);
      if (picks.length > best.count || (picks.length === best.count && lead > best.lead)) best = { picks: [...picks], count: picks.length, lead };
      return;
    }
    walk(gi + 1, picks, used);
    for (const w of wins.filter((x) => x.g === CHANGED_GROUPS[gi] && !used.has(x.n.name))) {
      used.add(w.n.name); picks.push(w);
      walk(gi + 1, picks, used);
      picks.pop(); used.delete(w.n.name);
    }
  };
  walk(0, [], new Set());
  return best.picks;
}

// { changes: [{ group, kind, out, bar, in, adv }], notes: { name: { code, why, group?, kind?, bar?, adv? } },
//   blocked: { group: reason }, bars: { group: { kind, lane } } } — `bars` is the lane each group's
// newcomers had to beat; a note's code is versus()'s, or 'lost', 'blocked', 'absent'.
export function decideChanges({ lanes, stats, newcomers, refs, settings }) {
  const bars = {}, blocked = {}, notes = {}, wins = [];
  for (const g of CHANGED_GROUPS) { const b = barFor(g, lanes, stats, refs); if (b.why) blocked[g] = b.why; else bars[g] = b; }
  for (const n of newcomers) {
    const st = stats[n.model];
    if (!st) { notes[n.name] = { code: 'absent', why: 'not in round 2 · 未进入第二轮' }; continue; }
    const tries = Object.entries(bars).map(([g, bar]) => ({ n, g, ...versus(n, st, bar, g, settings, stats) }));
    wins.push(...tries.filter((t) => t.ok));
    if (!tries.some((t) => t.ok)) notes[n.name] = tries.length ? noteOf(tries.sort((a, b) => b.adv - a.adv)[0]) : { code: 'blocked', why: 'no group can change · 无可更换的组' };
  }
  const picks = bestAssignment(wins);
  const placed = new Set(picks.map((w) => w.n.name));
  for (const w of wins) if (!placed.has(w.n.name)) notes[w.n.name] = { ...noteOf(w), code: 'lost', why: `${w.g}: another newcomer ranked higher · 另一新模型更优` };
  const taken = new Set(lanes.map((l) => l.id));
  const changes = picks.map(({ n, g, adv }) => ({ group: g, kind: bars[g].kind,
    out: bars[g].kind === 'replace' ? bars[g].lane : null, bar: bars[g].lane, in: newLane(n.name, g, taken), adv }));
  return { changes, notes, blocked, bars };
}

// The new list: a replacement takes the old lane's place (order, and so the default, kept); an
// addition goes after the last lane of its group.
export function applyChanges(lanes, changes) {
  const next = [...lanes];
  for (const c of changes) {
    if (c.kind === 'replace') { next[next.findIndex((l) => l.id === c.out.id)] = c.in; continue; }
    let at = -1;
    next.forEach((l, i) => { if (l.provider === 'ollama' && l.group === c.group) at = i; });
    next.splice(at + 1, 0, c.in);
  }
  return next;
}
