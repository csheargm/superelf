// The model review's email · 模型评测邮件 (docs/adr/0020)
//
// The HTML part of the review's briefing email: the same view as the briefing text
// (lib/model-review-report.mjs reviewView), drawn as bars a phone can read at a glance — quality per
// group on an honest 0-5 scale that starts at 0, and seconds to the first word, shorter is better.
// Gmail-safe on purpose: tables and inline styles only. No <style> block, SVG, image, script, link
// or external URL, so nothing is blocked, fetched or stripped. Every dynamic string is escaped here.
import { reviewView, tableCells, f1, ROLE_TAG, pickedTag, HEADING, SCORES_TITLE, UNDO_HOW } from './model-review-report.mjs';

export const QUALITY_MAX = 5;
export const COLORS = { lane: '#2563eb', bar: '#1e3a8a', new: '#f59e0b', picked: '#16a34a', out: '#9ca3af', agent: '#7c3aed',
  track: '#e9edf3', ink: '#111827', muted: '#6b7280', rule: '#e5e7eb', panel: '#f3f6fb' };
const ACCENT = { none: COLORS.picked, applied: COLORS.lane, report: COLORS.muted, changed: COLORS.new, refused: COLORS.new };
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif";
const TABLE = 'role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"';
const WRAP = 'word-break:break-word;overflow-wrap:anywhere';   // a long model name wraps instead of widening a phone screen

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x, max) => Math.max(0, Math.min(100, Math.round((x / max) * 100)));

// One bar: a coloured cell `value/max` wide and the grey rest. No value draws the track alone.
export function barCells(value, max, color) {
  const w = Number.isFinite(value) && max > 0 ? pct(value, max) : 0;
  const cell = (width, bg) => `<td width="${width}%" height="14" bgcolor="${bg}" `
    + `style="width:${width}%;height:14px;background-color:${bg};font-size:1px;line-height:1px">&nbsp;</td>`;
  return `<table ${TABLE}><tr>${w > 0 ? cell(w, color) : ''}${w < 100 ? cell(100 - w, COLORS.track) : ''}</tr></table>`;
}

const heading = (text) => `<div style="font-size:15px;font-weight:bold;color:${COLORS.ink};margin:22px 0 2px">${esc(text)}</div>`;
const note = (text) => `<div style="font-size:12px;color:${COLORS.muted};margin:0 0 6px">${esc(text)}</div>`;
const list = (items) => (items.length ? `<ul style="margin:4px 0 0 18px;padding:0">${items
  .map((s) => `<li style="margin:3px 0;font-size:13px;color:${COLORS.ink}">${esc(s)}</li>`).join('')}</ul>` : '');

// rows: [{ name, sub, role, value }]; axis: [left, middle, right] labels under the bars. Each row
// names its role in words under the model ("in use · 在用"), so the colour is never the only cue.
function chart(rows, max, axis, fmt) {
  const tr = rows.map((x) => `<tr><td width="38%" style="padding:4px 8px 4px 0;vertical-align:middle;font-size:13px;color:${COLORS.ink};${WRAP}">`
    + `${esc(x.name)}<br><span style="font-size:11px;color:${COLORS.muted}">${esc([x.sub, x.tag].filter(Boolean).join(' · '))}</span></td>`
    + `<td width="50%" style="padding:4px 0;vertical-align:middle">${barCells(x.value, max, COLORS[x.role])}</td>`
    + `<td width="12%" align="right" style="padding:4px 0 4px 8px;vertical-align:middle;font-size:13px;font-weight:bold;`
    + `color:${COLORS.ink};white-space:nowrap">${esc(fmt(x.value))}</td></tr>`).join('');
  const tick = (t, align) => `<td align="${align}" style="font-size:11px;color:${COLORS.muted}">${esc(t)}</td>`;
  const ticks = `<tr><td></td><td style="padding-top:2px"><table ${TABLE}><tr>${tick(axis[0], 'left')}${tick(axis[1], 'center')}`
    + `${tick(axis[2], 'right')}</tr></table></td><td></td></tr>`;
  return `<table ${TABLE}>${tr}${ticks}</table>`;
}

const byValue = (dir) => (a, b) => (a.value === null) - (b.value === null) || dir * ((a.value ?? 0) - (b.value ?? 0));
// A row as a chart draws it: its value, its tag in words, and its colour. A newcomer picked for the
// OTHER group is drawn as a plain newcomer here (amber), its tag saying where it went.
const charted = (x, value, group) => ({ ...x, value, tag: x.role === 'picked' ? pickedTag(x.pickedFor) : ROLE_TAG[x.role],
  role: x.role === 'picked' && group && x.pickedFor !== group ? 'new' : x.role });

function groupChart(v, g) {
  const rows = g.rows.map((x) => charted(x, x.st.quality[g.group], g.group)).sort(byValue(-1));
  const who = g.bar && (g.bar.lane.label || g.bar.lane.id), plus = `+${f1(v.margin)}`;
  const gone = g.bar && rows.some((x) => x.model === g.bar.lane.model && x.role === 'out');   // its bar is grey now, not dark
  // 'add' beats the weakest lane of the group; 'replace' beats the weakest lane a review MAY remove
  // (barFor in model-review-pick.mjs skips lanes other settings use), which can be the group's best.
  const which = g.bar && g.bar.kind === 'add' ? `your weakest ${g.group} model`
    : `the weakest ${g.group} model a review may replace (a model another setting uses is never replaced)`;
  const whichZh = g.bar && g.bar.kind === 'add' ? '' : `，可更换的 ${g.group} 模型中最弱的`;
  const why = g.blocked ? `This group cannot change: ${g.blocked}`
    : `${g.bar.kind === 'add' ? 'This group has room: a new model joins' : 'A new model gets in only'} by beating ${who} `
      + `(${gone ? 'replaced' : 'dark bar'}), ${which}, by ${plus} overall (quality minus a small speed penalty) · `
      + `新模型需综合超过 ${who}（${gone ? '已换下' : '深色条'}${whichZh}）${plus} 分才能入选`;
  return heading(`${g.group} tasks (${g.tests}) · ${g.group === 'Fast' ? '快速任务' : '深度任务'} — quality 0-5, higher is better · 质量越高越好`)
    + note(why) + chart(rows, QUALITY_MAX, ['0', '2.5', '5'], f1);
}

function speedChart(v) {
  const rows = v.rows.map((x) => charted(x, x.st.firstAll, null)).sort(byValue(1));
  const max = Math.max(1, Math.ceil(Math.max(0, ...rows.map((x) => x.value ?? 0))));
  return heading('Speed · 速度 — seconds to the first word, shorter is better · 首字秒数，越短越好')
    + note('Median over the text tasks each model passed · 每个模型通过的文字题的中位数')
    + chart(rows, max, ['0 s', `${f1(max / 2)} s`, `${max} s`], (x) => (x === null ? '-' : `${f1(x)} s`));
}

// The compact table under the charts; a header's 中文 goes on its own line so seven columns fit a phone.
function numbers(v) {
  const [head, ...body] = tableCells(v);
  const cell = (c, i, th) => `<${th ? 'th' : 'td'} align="${i ? 'center' : 'left'}" style="padding:4px 3px;font-size:12px;${i ? '' : `${WRAP};`}`
    + `border-bottom:1px solid ${COLORS.rule};color:${th ? COLORS.muted : COLORS.ink};font-weight:${th ? 'normal' : (i ? 'bold' : 'normal')}">`
    + `${th ? String(c).split(' · ').map(esc).join('<br>') : esc(c)}</${th ? 'th' : 'td'}>`;
  return heading('All numbers · 全部数据') + note(SCORES_TITLE)
    + `<table ${TABLE}><tr>${head.map((c, i) => cell(c, i, true)).join('')}</tr>`
    + body.map((row) => `<tr>${row.map((c, i) => cell(c, i, false)).join('')}</tr>`).join('') + '</table>'
    + (v.agentNote ? note(v.agentNote) : '');
}

function verdictBox(v) {
  return `<table ${TABLE}><tr><td style="background-color:${COLORS.panel};border-left:4px solid ${ACCENT[v.outcome] || COLORS.muted};padding:14px 16px">`
    + `<div style="font-size:18px;font-weight:bold;line-height:1.35;color:${COLORS.ink}">${esc(v.verdict)}</div>`
    + `<div style="font-size:13px;color:${COLORS.muted};margin-top:6px">${esc(v.context)}</div></td></tr></table>`;
}

function footer(v) {
  const undo = v.undo ? `<div style="margin-top:8px;font-weight:bold;color:${COLORS.ink}">${esc(UNDO_HOW)}</div>` : '';
  return `<div style="margin-top:26px;padding-top:12px;border-top:1px solid ${COLORS.rule};font-size:12px;color:${COLORS.muted};line-height:1.5">`
    + `${esc(v.testLine)}<br>${esc(v.costLine)}${undo}</div>`;
}

const section = (title, items) => (items.length ? heading(title.replace(/:$/, '')) + list(items) : '');

// The whole email body, one self-contained HTML document.
export function reviewHtml(r) {
  const v = reviewView(r);
  const body = verdictBox(v) + section(v.changesTitle, v.changes) + section(HEADING.challengers, v.challengers)
    + v.groups.map((g) => groupChart(v, g)).join('') + speedChart(v)
    + section(HEADING.others, v.others) + section(HEADING.blocked, v.blocked)
    + numbers(v) + section(v.chooserTitle, v.chooser) + (v.declined ? note(v.declined) : '') + footer(v);
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>'
    + '<body style="margin:0;padding:0;background-color:#ffffff">'
    + `<table ${TABLE}><tr><td align="center" style="padding:16px 12px">`
    + `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;font-family:${FONT};color:${COLORS.ink}">`
    + `<tr><td align="left">${body}</td></tr></table></td></tr></table></body></html>`;
}
