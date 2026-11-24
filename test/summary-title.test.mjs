// web/summary-title.inline.html — PASummaryTitle: the period ids and the human titles of period summaries
// (docs/plans/note-features.md E; owner 2026-11-11: "W46 — not sure what it is"). The shipped script is RUN
// (helpers-summary loadTitle) with `now` pinned: every preset's title with its date range, a week spanning a
// month boundary and one spanning a year boundary, the this / last / plain words, the Selected span, and
// scopeOfLabel as the exact inverse — of every title and of the earlier "总结 · Summary <id>" label that
// existing notes and threads carry. Pins: the marker drawer-summary carries, the registration (last), the
// ONE scope prefix.
// R11 — searched: "Last week", "周 · Week", "月 · Month", "年 · Year", "isoWeek", "periodOf" — no earlier copies.
process.env.TZ = 'America/Los_Angeles';   // before any Date: the DST-week cases below need a zone that changes clocks
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTitle, loadRefs } from './helpers-summary.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime();   // Tue 2026-11-10 local: the week is Mon 11-09 .. Sun 11-15 (ISO 2026-W46)
const T = (now = NOW) => loadTitle({ PA_SUMMARY_NOW: now });

// Every title the presets can produce at NOW, and the id each stands for.
const CASES = [
  ['2026-W46', '本周 · This week Nov 9–15, 2026'],
  ['2026-W45', '上周 · Last week Nov 2–8, 2026'],
  ['2026-W49', '周 · Week Nov 30–Dec 6, 2026'],                 // spans a month boundary
  ['2026-W53', '周 · Week Dec 28, 2026–Jan 3, 2027'],           // spans a year boundary (2026 has 53 ISO weeks)
  ['2027-W01', '周 · Week Jan 4–10, 2027'],
  ['2026-W01', '周 · Week Dec 29, 2025–Jan 4, 2026'],
  ['2026-11', '本月 · This month Nov 2026'],
  ['2026-10', '上月 · Last month Oct 2026'],
  ['2026-03', '月 · Month Mar 2026'],
  ['2026', '今年 · This year 2026'],
  ['2025', '去年 · Last year 2025'],
  ['2024', '年 · Year 2024'],
  ['2026-03-03..2026-10-15', '已选 · Selected Mar 3–Oct 15, 2026'],
  ['2026-03-03..2026-03-09', '已选 · Selected Mar 3–9, 2026'],
  ['2025-12-30..2026-01-02', '已选 · Selected Dec 30, 2025–Jan 2, 2026'],
  ['2026-03-03', '已选 · Selected Mar 3, 2026'],
  ['selected', '已选 · Selected'],
];

test('titleOf: every preset reads as its human date range with the period word relative to now; the ISO id is never shown', () => {
  const S = T();
  for (const [id, title] of CASES) assert.equal(S.titleOf(id), title, id);
  assert.doesNotMatch(CASES.map(([, t]) => t).join('\n'), /W\d\d/, 'no week number anywhere');
  assert.equal(S.titleOf('nonsense'), '已选 · Selected', 'an id that is no period falls back to the bare word (never a throw)');
  assert.equal(S.titleOf(undefined), '已选 · Selected');
});

test('scopeOfLabel is the exact inverse of titleOf for every case, accepts the earlier label, and refuses any other label', () => {
  const S = T();
  for (const [id, title] of CASES) assert.equal(S.scopeOfLabel(title), id === 'selected' ? 'summary:selected' : 'summary:' + id, title);
  assert.equal(S.scopeOfLabel('Summary · 总结 2026-10'), 'summary:2026-10', 'a note or thread titled before 2026-11-11 still maps to its period');
  assert.equal(S.scopeOfLabel('Summary · 总结 2026-W46'), 'summary:2026-W46');
  for (const bad of ['Journal 手写', 'John 3:16', '本周 · This week', '本周 · This week Nov 31–33, 2026', '月 · Month Foo 2026', '今年 26 · This year', '已选 · Selected Feb 30, 2026', '', null, undefined, 42])
    assert.equal(S.scopeOfLabel(bad), null, String(bad));
});

test('the words move with now: the same id is "This week" today and "Last week" a week later, then plain', () => {
  assert.equal(T(NOW + 7 * 86400000).titleOf('2026-W46'), '上周 · Last week Nov 9–15, 2026');
  assert.equal(T(NOW + 14 * 86400000).titleOf('2026-W46'), '周 · Week Nov 9–15, 2026');
  assert.equal(T(new Date(2026, 11, 5).getTime()).titleOf('2026-11'), '上月 · Last month Nov 2026');
  assert.equal(T(new Date(2027, 0, 5).getTime()).titleOf('2026'), '去年 · Last year 2026');
  assert.equal(T(NOW + 7 * 86400000).scopeOfLabel('本周 · This week Nov 9–15, 2026'), 'summary:2026-W46', 'a label written last week still names its week');
});

test('periodOf: the presets\' windows from now, and the week id they name', () => {
  const S = T();
  const w = S.periodOf('week', NOW);
  assert.equal(w.id, '2026-W46'); assert.equal(new Date(w.from).getDate(), 9); assert.equal(w.to - w.from, 7 * 86400000);
  assert.equal(S.periodOf('month', NOW).id, '2026-11'); assert.equal(S.periodOf('lastMonth', NOW).id, '2026-10');
  assert.equal(S.periodOf('year', NOW).id, '2026'); assert.equal(S.periodOf('lastYear', NOW).id, '2025');
  assert.equal(S.periodOf('selected', NOW), null);
  assert.equal(S.isoWeek(new Date(2026, 11, 31).getTime()), '2026-W53'); assert.equal(S.isoWeek(new Date(2027, 0, 1).getTime()), '2026-W53');
  assert.equal(S.now(), NOW, 'pinned'); assert.ok(loadTitle({}).now() > NOW, 'unpinned: the clock');
});

test('periodOf(week) survives a DST change: Sunday 23:30 local is inside This week in both the spring and the autumn change weeks (local-midnight arithmetic, not from+7×24 h)', () => {
  const S = T();
  for (const [y, m, d] of [[2026, 2, 8], [2026, 10, 1]]) {   // Sun 2026-03-08 (clocks forward) and Sun 2026-11-01 (clocks back), America/Los_Angeles
    const sunday = new Date(y, m, d, 23, 30).getTime(), w = S.periodOf('week', sunday), monday = new Date(y, m, d - 6);
    assert.equal(w.from, monday.getTime(), 'from = Monday 00:00 local');
    assert.equal(w.to, new Date(y, m, d + 1).getTime(), 'to = next Monday 00:00 local');
    assert.ok(sunday >= w.from && sunday < w.to, `Sunday 23:30 is inside the week of ${y}-${m + 1}-${d}`);
    assert.notEqual(w.to - w.from, 7 * 86400000, 'CONTROL: this week is not 7×24 h in this zone, so the old arithmetic would have missed or overrun');
    assert.equal(S.isoWeek(sunday), S.isoWeek(w.from), 'one id for the whole week');
  }
});

test('pins: ONE scope prefix (drawer-summary\'s equals this one), the marker above drawer-summary\'s script, registered LAST, and the drawer-summary API delegates', () => {
  const win = { PA_SUMMARY_NOW: NOW }; loadRefs(win);
  const SUM = read('web/drawer-summary.inline.html'), WEB = read('web.mjs');
  const i = SUM.indexOf('<script id="pds-script">');
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', SUM.slice(SUM.indexOf('>', i) + 1, SUM.indexOf('</script>', i)))(win, { createElement: () => ({}) });
  assert.equal(win.PADrawerSummary.SCOPE, win.PASummaryTitle.SCOPE);
  assert.equal(win.PADrawerSummary.titleOf('2026-W46'), '本周 · This week Nov 9–15, 2026');
  assert.equal(win.PADrawerSummary.scopeOfLabel('本周 · This week Nov 9–15, 2026'), 'summary:2026-W46');
  assert.equal(win.PADrawerSummary.periodOfScope('summary:2026-11'), '2026-11'); assert.equal(win.PADrawerSummary.isScope('note:1'), false);
  assert.equal(win.PADrawerSummary.periodOf('month', NOW).id, '2026-11');
  assert.ok(SUM.indexOf('<!--PA_SUMMARY_TITLE_UI-->') > SUM.indexOf('<!--PA_SUMMARY_REFS_UI-->') && SUM.indexOf('<!--PA_SUMMARY_TITLE_UI-->') < i, 'the marker sits before drawer-summary\'s script');
  const comps = WEB.slice(WEB.indexOf('const PA_COMPONENTS = ['), WEB.indexOf('];', WEB.indexOf('const PA_COMPONENTS = [')));
  assert.match(comps, /\{ marker: '<!--PA_SUMMARY_TITLE_UI-->', file: 'summary-title\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_DRAWER_GROUPS_UI-->', file: 'drawer-groups\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_SUMMARY_IMAGES_UI-->', file: 'summary-images\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_SUMMARY_FOLLOWUP_UI-->', file: 'summary-followup\.inline\.html' \},\n  \/\/[^\n]*\n  \/\/[^\n]*\n  \{ marker: '<!--PA_INK_ANCHOR_UI-->', file: 'ink-anchor\.inline\.html' \},\n  \/\/[^\n]*\n  \/\/[^\n]*\n  \{ marker: '<!--PA_INK_PEN_UI-->', file: 'ink-pen\.inline\.html' \},\n  \/\/[^\n]*\n  \/\/[^\n]*\n  \{ marker: '<!--PA_APP_PREFS_UI-->', file: 'app-prefs\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_SETTINGS_ROWS-->', file: 'settings-rows\.inline\.html' \},\n(?:  \/\/[^\n]*\n)+  \{ marker: '<!--PA_TIPS_UI-->', file: 'tips\.inline\.html' \},\n(?:  \/\/[^\n]*\n)*  \{ marker: '<!--PA_PANE_CHROME_UI-->', file: 'pane-chrome\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_APP_BAR_UI-->', file: 'app-bar\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '\/\* PA_BAR_HANDLE_CSS \*\/', file: 'bar-handle\.css' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_READING_HISTORY_UI-->', file: 'reading-history\.inline\.html' \},\n  \/\/[^\n]*\n  \/\/[^\n]*\n  \{ marker: '<!--PA_INK_FRAME_UI-->', file: 'ink-frame\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: PA_SNAP_MARKER, file: 'snap\.inline\.html' \},\n$/, 'registered after the refs component, before the three that came later (the append-only rule)');
  assert.doesNotMatch(SUM, /noteTitle|'Summary · 总结 \{p\}'/, 'drawer-summary writes no title of its own');
});

test('displayTitle: a saved summary label (the raw "Summary · 总结 2026-W46" or a current title) shows as titleOf today; any other label is itself', () => {
  const S = T();
  assert.equal(S.displayTitle('Summary · 总结 2026-W46'), '本周 · This week Nov 9–15, 2026');
  assert.equal(S.displayTitle('Summary · 总结 2026-10'), '上月 · Last month Oct 2026');
  assert.equal(S.displayTitle('本周 · This week Nov 9–15, 2026'), '本周 · This week Nov 9–15, 2026');
  assert.equal(S.displayTitle('Roof'), 'Roof'); assert.equal(S.displayTitle(''), '');
});

test('a label stored before the 中文-first sweep ("This week · 本周 …") still maps to its period and shows as today\'s title', () => {
  const S = T();
  assert.equal(S.scopeOfLabel('This week · 本周 Nov 9–15, 2026'), 'summary:2026-W46', 'the English-first week label');
  assert.equal(S.scopeOfLabel('Last month · 上月 Oct 2026 · 11/12 14:52'), 'summary:2026-10', 'a legacy run title keeps its period');
  assert.equal(S.displayTitle('This week · 本周 Nov 9–15, 2026'), '本周 · This week Nov 9–15, 2026', 'shown in today\'s 中文-first words');
});
