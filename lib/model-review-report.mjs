// The model review's report · 模型评测报告 (docs/adr/0017, docs/adr/0020)
//
// ONE view of a review (reviewView) feeds two renderings: the briefing text here, which the app
// shows as markdown and the email carries as its plain-text part, and the email's HTML part with the
// charts (lib/model-review-email.mjs). Both lead with the answer in one line, then what changed or
// came closest and why, then the numbers, then the test and its cost.
// 中文 and English, no emojis (lib/notify.mjs strips them anyway; none are written). Every string
// that came from a model or a server passes through sanitizeLine and is capped: a report is not a
// channel for remote text.
import { sanitizeLine } from './webutil.mjs';
import { CHANGED_GROUPS, ROUND2_NEWCOMERS } from './model-review-pick.mjs';
import { catalogName } from './model-health.mjs';
import { localDateStr } from './schedule.mjs';
import { NO_STREAM_NOTE, AGENT_TABLE_NOTE, AGENT_VISION_NOTE, AGENT_USE, streamsText } from './model-review-agent.mjs';

const NOTE_MAX = 140, WHY_MAX = 80, NAMES_MAX = 12;
export const CHALLENGERS = 3;          // "closest challengers" lines at most
export const NO_VISION = '—';          // Vision: the model could not see the test picture (it scored 0), never "0.0"
export const UNDO_HOW = 'Undo · 撤销: Your profile > Jobs · 任务 > "撤销模型评测 · Undo model review" > Run now · 立即运行 '
  + '— puts back the list from before this change · 恢复更改前的列表.';

export const f1 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? '-' : (Math.round(x * 10) / 10).toFixed(1));
const signed = (x) => (Number.isFinite(x) && x >= 0 ? '+' : '') + f1(x);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const laneName = (l) => `${l.label || l.id} (${l.model})`;
const labelOf = (l) => l.label || l.id;
export const visionText = (q) => (q === null || q === undefined || q === 0 ? NO_VISION : f1(q));

export const VERDICT = {
  none: 'No change: your current models are still the best fit · 无变化：当前模型仍是最佳',
  report: 'First review: report only, nothing changed; later reviews apply what they find · 首次评测：只报告，不作更改；以后的评测会自动更换',
  rebuilt: 'Report only, nothing changed: model-review.json was unreadable and has been rebuilt · 只报告，未作更改：状态文件无法读取，已重建',
  changed: 'Not applied: chat_models was edited while the review ran; the next review looks again · 未应用：评测期间 chat_models 被修改，下次评测再看',
  refused: 'Not applied: the config loader refused the new list · 未应用：新列表未通过配置校验',
  applied: (n) => `Changed: ${plural(n, 'new model')} in your chooser · 已更换：选择器换入 ${n} 个新模型`,
};
// What each row is to the chooser, in words under the model in the HTML charts; a picked newcomer
// says for which group (pickedTag).
export const ROLE_TAG = { lane: 'in use · 在用', bar: 'in use, the one to beat · 在用，需超过它', new: 'new · 新', out: 'replaced · 换下',
  agent: 'agent, compared only · 代理，仅作对比' };
export const pickedTag = (group) => `new, picked for ${group} · 新，入选 ${group}`;
export const SCORES_TITLE = 'Scores · 评分 — quality 0-5, higher is better (Claude, blind; a failed answer is 0); first word in '
  + `seconds, shorter is better; Vision ${NO_VISION} = could not see the picture · 质量 0-5 越高越好（Claude 盲评，失败记 0）；`
  + `首字秒数越短越好；看图 ${NO_VISION} = 看不到图片`;
export const TABLE_HEAD = ['Model · 模型', 'Use · 用途', 'Fast', 'Deep', 'Vision · 看图', '1st word s · 首字秒', 'Failed · 失败'];
// Section headings both renderings use (the text adds a colon).
export const HEADING = { challengers: 'Closest challengers · 最接近的挑战者', others: 'Other new models · 其他新模型',
  blocked: 'Groups that cannot change · 不能更换的组' };

function verdictOf(r) {
  if (r.outcome === 'applied') return VERDICT.applied(r.changes.length);
  if (r.rebuilt && r.outcome === 'report') return `${VERDICT.rebuilt} (${sanitizeLine(r.rebuilt, NOTE_MAX)})`;
  if (r.outcome === 'refused') return `${VERDICT.refused}: ${sanitizeLine(r.why, NOTE_MAX * 2)}`;
  return VERDICT[r.outcome];
}

function contextOf(tried, full, changed) {
  if (!tried) return 'No new model to try; your current models were scored again · 没有新模型可试，只重新评了当前模型';
  const none = changed ? '' : ', none clearly better than yours';
  return `${plural(tried, 'new model')} tried, ${full} reached the full test${none} · 试了 ${tried} 个新模型，${full} 个进入完整测试${changed ? '' : '，没有明显更好的'}`;
}

function changeLines(r) {
  return r.changes.map((c) => {
    const a = r.stats[c.in.model], b = r.stats[c.bar.model], g = c.group;
    const head = c.kind === 'replace' ? `${g}: ${laneName(c.out)} -> ${laneName(c.in)}` : `${g}: + ${laneName(c.in)}`;
    return `${head} — overall ${signed(c.adv)} vs ${labelOf(c.bar)}: quality ${f1(a.quality[g])} vs ${f1(b.quality[g])}, `
      + `first word ${f1(a.first[g])} s vs ${f1(b.first[g])} s, no failed answer · 综合领先 ${f1(c.adv)}`;
  });
}

// Why a round-2 newcomer stayed out, in plain words (lib/model-review-pick.mjs versus codes).
const TAIL = {
  margin: (n, s) => `overall ${signed(n.adv)}, needs +${f1(s.margin)} to ${n.kind === 'add' ? 'join' : 'replace it'} · 综合 ${signed(n.adv)}，需 +${f1(s.margin)}`,
  slow: (n, s) => `overall ${signed(n.adv)}, but more than ${s.max_slowdown}x slower to the first word · 综合 ${signed(n.adv)}，但首字太慢`,
  fail: (n) => `a failed answer rules it out (${sanitizeLine(n.why.replace(/^round 2: /, ''), WHY_MAX)}) · 有失败回答`,
  lost: () => 'good enough, but another new model ranked higher · 合格，但另一新模型更优',
};

function challengerLines(r, near) {
  return near.map(([name, n]) => {
    const a = r.stats[n.model], b = r.stats[n.bar.model], g = n.group;
    return `${name} vs ${labelOf(n.bar)} on ${g}: quality ${f1(a.quality[g])} vs ${f1(b.quality[g])}, `
      + `first word ${f1(a.first[g])} s vs ${f1(b.first[g])} s — ${TAIL[n.code](n, r.settings)}`;
  });
}

const OTHER = {
  margin: (k) => `${k} further behind · ${k} 个差距更大`,
  slow: (k) => `${k} too slow to the first word · ${k} 个首字太慢`,
  fail: (k) => `${k} with a failed answer · ${k} 个有失败回答`,
  lost: (k) => `${k} good enough, but other new models ranked higher · ${k} 个合格，但其他新模型更优`,
  slower: (k) => `${k} slower in the quick round (the ${ROUND2_NEWCOMERS} fastest went on) · ${k} 个在快速轮中较慢（最快的 ${ROUND2_NEWCOMERS} 个进入完整测试）`,
  failed: (k) => `${k} failed the quick round · ${k} 个在快速轮中失败`,
  untested: (k) => `${k} not tested (call limit) · ${k} 个未测试（调用上限）`,
};
const WITH_WHY = new Set(['fail', 'failed']);

// One line per reason: "9 slower in the quick round: a, b, …" — never a line per model.
function groupedLines(entries, codeOf) {
  const by = new Map();
  for (const [name, n] of entries) { const c = codeOf(n); if (!by.has(c)) by.set(c, []); by.get(c).push([name, n]); }
  const order = (c) => { const i = Object.keys(OTHER).indexOf(c); return i < 0 ? Infinity : i; };
  return [...by].sort((a, b) => order(a[0]) - order(b[0])).map(([code, list]) => {
    const names = list.slice(0, NAMES_MAX).map(([name, n]) => (WITH_WHY.has(code) || !OTHER[code]
      ? `${name} (${sanitizeLine(n.why, WHY_MAX)})` : name));
    const more = list.length > NAMES_MAX ? ` and ${list.length - NAMES_MAX} more · 等` : '';
    return `${(OTHER[code] || ((k) => `${k} not placed · ${k} 个未安排`))(list.length)}: ${names.join(', ')}${more}`;
  });
}

function chooserLines(lanes) {
  const groups = [...new Set(lanes.map((l) => l.group || '-'))];
  return groups.map((g) => `${g}: ${lanes.filter((l) => (l.group || '-') === g).map(labelOf).join(', ')}`);
}

// Each round-2 model as the charts and the table show it: its name, what it is to the chooser, its stats.
function modelRows(r) {
  const ins = new Set(r.changes.map((c) => c.in.model)), outs = new Set(r.changes.filter((c) => c.out).map((c) => c.out.model));
  const bars = new Set(Object.values(r.bars || {}).map((b) => b.lane.model));
  const lanes = r.lanesBefore.filter((l) => l.provider === 'ollama' && l.model);
  return r.models.map((m) => {
    const mine = lanes.filter((l) => l.model === m), short = catalogName(m) || m;
    const name = mine.length ? labelOf(mine[0]) : short;
    const groups = [...new Set(mine.map((l) => l.group || '-'))];
    const role = !mine.length ? (ins.has(m) ? 'picked' : 'new') : outs.has(m) ? 'out' : bars.has(m) ? 'bar' : 'lane';
    const pickedFor = (r.changes.find((c) => c.in.model === m) || {}).group;
    const use = role === 'picked' ? `new · 新 -> ${pickedFor}` : role === 'new' ? 'new · 新' : groups.join(', ') + (role === 'out' ? ' -> out · 换下' : '');
    return { model: m, name, sub: short === name ? '' : short, role, groups, use, pickedFor, st: r.stats[m] };
  });
}

// The agent lanes (lib/model-review-agent.mjs), after the Ollama rows: compared, never swapped.
// firstNote: the caveat beside a lane's first-word number when it measures the whole answer.
function agentRows(r) {
  return (r.agents || []).map(({ key, lane }) => ({ model: key, name: labelOf(lane), sub: '', role: 'agent', groups: [lane.group || AGENT_USE],
    use: AGENT_USE, pickedFor: undefined, st: r.stats[key], firstNote: streamsText(lane) ? '' : NO_STREAM_NOTE }));
}
// The line under the table, when agents were measured; names the lanes whose number is the whole answer.
function agentNote(rows) {
  const agents = rows.filter((x) => x.role === 'agent');
  if (!agents.length) return '';
  const whole = agents.filter((x) => x.firstNote).map((x) => `${x.name}: first word = ${x.firstNote}`);
  return [AGENT_TABLE_NOTE, ...whole, AGENT_VISION_NOTE].join('; ') + '.';
}

function testLine(tests) {
  const n = tests.length, pics = tests.filter((t) => t.group === 'Vision').length;
  return `The test · 测试: ${n} made-up tasks (${n - pics} text, ${pics} picture), graded blind by Claude 0-5; a failed answer scores 0 · `
    + `${n} 道虚构题（${n - pics} 道文字、${pics} 道看图），Claude 盲评 0-5，失败记 0。`;
}

const costLine = (c) => `Cost · 成本: ${c.ollama} Ollama calls, ${c.agent || 0} agent calls, ${c.claude} Claude grading calls, ${f1(c.minutes)} minutes · `
  + `${c.ollama} 次 Ollama 调用，${c.agent || 0} 次代理调用，${c.claude} 次 Claude 评分，${f1(c.minutes)} 分钟`;

// r: { outcome, why, rebuilt, changes, lanesBefore, lanesAfter, stats, models, tests, round1, notes, bars,
//      blocked, declined, settings: { margin, max_slowdown }, cost: { ollama, claude, minutes } }
export function reviewView(r) {
  const rows = [...modelRows(r), ...agentRows(r)];
  const full = rows.filter((x) => x.role === 'new' || x.role === 'picked').length;
  const r1 = Object.entries(r.round1 || {});
  const tried = full + r1.filter(([, d]) => d.kind !== 'untested').length;
  const near = Object.entries(r.notes || {}).filter(([, n]) => TAIL[n.code] && Number.isFinite(n.adv) && r.stats[n.model])
    .sort((a, b) => b[1].adv - a[1].adv).slice(0, CHALLENGERS);
  const nearNames = new Set(near.map(([name]) => name));
  const rest = Object.entries(r.notes || {}).filter(([name]) => !nearNames.has(name));
  return {
    outcome: r.outcome, verdict: verdictOf(r), context: contextOf(tried, full, r.changes.length > 0),
    changesTitle: r.outcome === 'applied' ? 'What changed · 更换 (the chooser follows within seconds, no restart · 选择器数秒内更新，无需重启):' : 'Would change · 将更换:',
    changes: changeLines(r), challengers: challengerLines(r, near),
    others: [...groupedLines(rest, (n) => n.code), ...groupedLines(r1, (d) => d.kind)],
    blocked: Object.entries(r.blocked || {}).map(([g, why]) => `${g}: ${sanitizeLine(why, NOTE_MAX)}`),
    groups: CHANGED_GROUPS.map((g) => ({ group: g, tests: r.tests.filter((t) => t.group === g).length, bar: (r.bars || {})[g] || null,
      blocked: (r.blocked || {})[g] || null, rows: rows.filter((x) => x.groups.includes(g) || x.role === 'new' || x.role === 'picked') })),
    rows, textTests: r.tests.filter((t) => t.group !== 'Vision').length, hasVision: r.tests.some((t) => t.group === 'Vision'),
    agentNote: agentNote(rows),
    chooserTitle: r.outcome === 'applied' ? 'Chooser now · 现在的选择器:' : 'Chooser (unchanged) · 选择器（未变）:',
    chooser: chooserLines(r.lanesAfter),
    declined: r.declined.length ? `Not tried again (taken back by Undo) · 已撤销，不再推荐: ${r.declined.join(', ')}` : '',
    testLine: testLine(r.tests), costLine: costLine(r.cost), undo: r.outcome === 'applied', margin: r.settings.margin,
  };
}

// The compact table, as markdown (the app draws it as a table; the email's text part keeps the pipes).
export function tableCells(v) {
  const cols = v.hasVision ? [0, 1, 2, 3, 4, 5, 6] : [0, 1, 2, 3, 5, 6];
  const body = v.rows.map((x) => [x.sub ? `${x.name} (${x.sub})` : x.name, x.use, f1(x.st.quality.Fast), f1(x.st.quality.Deep),
    visionText(x.st.quality.Vision), x.firstNote ? `${f1(x.st.firstAll)} (${x.firstNote})` : f1(x.st.firstAll), `${x.st.fails}/${v.textTests}`]);
  return [TABLE_HEAD, ...body].map((row) => cols.map((i) => row[i]));
}
const mdRow = (cells) => `| ${cells.map((c) => String(c).replace(/\|/g, '/')).join(' | ')} |`;

export function reviewBrief(r) {
  const v = reviewView(r);
  const dash = (s) => `- ${s}`;
  const [head, ...body] = tableCells(v);
  const out = [`**${v.verdict}**`, v.context];
  if (v.changes.length) out.push('', v.changesTitle, ...v.changes.map(dash));
  if (v.challengers.length) out.push('', `${HEADING.challengers}:`, ...v.challengers.map(dash));
  out.push('', SCORES_TITLE, '', mdRow(head), mdRow(head.map(() => '---')), ...body.map(mdRow));
  if (v.agentNote) out.push('', v.agentNote);
  if (v.others.length) out.push('', `${HEADING.others}:`, ...v.others.map(dash));
  if (v.blocked.length) out.push('', `${HEADING.blocked}:`, ...v.blocked.map(dash));
  out.push('', v.chooserTitle, ...v.chooser.map(dash));
  if (v.declined) out.push('', v.declined);
  out.push('', v.testLine, v.costLine);
  if (v.undo) out.push('', UNDO_HOW);
  return out.join('\n');
}

export function undoBrief({ at, restored }) {
  return ['Undone · 已撤销 — chat_models is back to the list from before the model review of '
    + `${localDateStr(new Date(at))}; the models it added are not proposed again · 已恢复评测前的列表，撤下的模型不再推荐。`,
  '', 'Chooser now · 现在的选择器:', ...chooserLines(restored).map((s) => `- ${s}`)].join('\n');
}

export const NOTHING_TO_UNDO = 'Nothing to undo · 没有可撤销的更改 — no model review has changed chat_models since the last Undo.';
export const NO_CATALOG = 'No Ollama catalog recorded yet, so there is nothing to compare · 尚无模型目录，无法评测 — '
  + 'the daily model check reads it (ollama_catalog_url; "" turns it off).';
