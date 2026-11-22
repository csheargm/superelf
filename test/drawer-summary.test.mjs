// Ask AI period summaries（按时期总结, docs/plans/note-features.md E, option 1): PAChat is RUN
// (helpers-stationery loadChatUi) with the real component (web/drawer-summary.inline.html) on its
// window, a fake PANoteText.fetch answering the index's page text, a fake PAChat.complete for the
// month maps and fake host hooks (run / monthSummary / saveNote). The multi-select bar's Summarize
// button opens the sheet; presets pick rows by date; the confirm line counts pages and characters
// from the reply; Send runs exactly ONE rail turn with the grouped text under the constant prompt;
// a year is built from month summaries; the cap is said; the turn's own answer is saved as a note by itself
// (fresh + pending) with the first line, the human title and the scope (every run is its own note, titled with its run time); a tap re-saves that note by its id.
// CONTROL: cancel sends nothing; a note-text failure is said and sends nothing; a replayed or follow-up answer
// is not auto-saved.
// TODO(R4 seam): over 300 lines — split the Save-as-note / auto-save tests (and the sources test) from the sheet tests, with their shared drawer() fixture in a helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CHAT, APP_SRC } from './helpers-app.mjs';
import { WHERE, tick, pickMore } from './helpers-drawer-search.mjs';
import { loadChatUi } from './helpers-stationery.mjs';
import { loadRefs } from './helpers-summary.mjs';

const SUM_HTML = fs.readFileSync(path.join(ROOT, 'web', 'drawer-summary.inline.html'), 'utf8');
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime();   // Tue 2026-11-10 local: the week is Mon 11-09 .. Sun 11-15
const at = (y, m, d) => new Date(y, m - 1, d, 9, 0, 0).getTime();
const rows = () => [
  { id: 'a', title: 'Roof', created: at(2026, 11, 9), updated: at(2026, 11, 9), doc: { path: 'entry-a.json' } },
  { id: 'b', title: 'Rent', created: at(2026, 11, 2), updated: at(2026, 11, 3), doc: { path: 'entry-b.json' } },
  { id: 'c', title: 'October', created: at(2026, 10, 15), doc: { path: 'entry-c.json' } },
  { id: 'd', title: 'March', created: at(2026, 3, 3), doc: { path: 'entry-d.json' } },
  { id: 'e', title: 'Old', created: at(2025, 6, 1), doc: { path: 'entry-e.json' } },
  { id: 'f', title: 'A chat', created: at(2026, 11, 9) },
  { id: 's', title: 'Summary · 总结 2026-10', created: at(2026, 10, 31), doc: { path: 'entry-s.json' } },   // a saved month summary note (no pages in PAGES: it sends nothing itself)
];
const PAGES = [
  { path: 'entry-a.json', scope: '', page: 1, src: { typed: '', ink: 'call #landlord', photo: '' }, important: ['call #landlord'] },   // highlighted on page 1 (note-features.md F)
  { path: 'entry-a.json', scope: '', page: 0, src: { typed: 'Rain on the roof', ink: 'fix gutter', photo: 'SLIDE TEXT' }, important: [] },
  { path: 'entry-b.json', scope: '', page: 0, src: { typed: 'Rent paid', ink: '', photo: '' } },
  { path: 'entry-c.json', scope: '', page: 0, src: { typed: 'October thoughts', ink: '', photo: '' } },
  { path: 'entry-d.json', scope: '', page: 0, src: { typed: 'March notes', ink: '', photo: '' } },
  { path: 'entry-e.json', scope: '', page: 0, src: { typed: 'Last year', ink: '', photo: '' } },
];
function mkEl(tag) { const on = {}, kids = []; return { tagName: String(tag).toUpperCase(), className: '', innerHTML: '', textContent: '', disabled: false, checked: false, on, children: kids,
  appendChild(k) { kids.push(k); return k; }, addEventListener: (t, fn) => (on[t] ||= []).push(fn), setAttribute(k, v) { this['@' + k] = v; }, remove() { this.removed = true; } }; }

// One listDrawer with the component on the page, in multi-select with `picked` ticked; `fetch` answers PANoteText.fetch.
async function drawer({ fetch = async () => ({ ok: true, pages: PAGES }), hooks = {}, items = rows, picked = [], complete } = {}) {
  const calls = { fetched: [], run: [], month: [], saved: [], completed: [] };
  const H = { run: async (t) => { calls.run.push(t); return true; }, monthSummary: async (p, title) => { calls.month.push([p, title]); return null; },
    saveNote: async (o) => { calls.saved.push(o); return { ok: true }; }, onLink() {}, ...hooks };   // onLink: links are written only once a host passed it
  const win = { PA_SUMMARY_NOW: NOW, PANote: { SEARCH_TXT: WHERE, search: async () => ({ ok: true, hits: [] }), mdToHtml: (t) => '<p>' + t + '</p>' },
    PANoteText: { fetch: async (o) => { calls.fetched.push(o); return fetch(o); } } };
  const { PAChat, window } = loadChatUi({ win });
  loadRefs(window, { createElement: mkEl });   // as the page has it: PASummaryRefs is defined before drawer-summary's script runs
  // On the SAME window chat-ui got (the component reads window.PAChat and window.PANoteText at call time).
  const src = SUM_HTML.slice(SUM_HTML.indexOf('>', SUM_HTML.indexOf('<script id="pds-script">')) + 1, SUM_HTML.indexOf('</script>', SUM_HTML.indexOf('<script id="pds-script">')));
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(window, { createElement: mkEl });
  let api = null; const real = window.PADrawerSummary.attach; window.PADrawerSummary.attach = (c) => (api = real(c));
  PAChat.lane = () => ({ id: 'claude', label: 'Claude' });
  PAChat.complete = async (m, o) => { calls.completed.push([m, o]); return complete ? complete(m, o) : { ok: true, text: 'SUM ' + m.length }; };
  const d = PAChat.listDrawer({ title: 'Notes', items: async () => items(), onOpen: () => {}, onDelete: async () => {}, summary: ('none' in hooks) ? null : H });
  await d.refresh(); await tick(5);
  const el = (s) => d.el.querySelector(s);
  // Tick rows the way the drawer does: Select · 多选 in the header's ⋯ sheet, then the row-click listener per id.
  if (picked.length) { await pickMore(d, 'Select'); await d.refresh();
    for (const id of picked) for (const fn of el('.pac-lrows').on.click || []) fn({ target: { closest: (s) => (s === '.pac-lrow' ? { dataset: { id }, classList: { add() {}, remove() {} } } : null) } }); }
  return { d, calls, api: () => api, bar: () => el('.pac-lbulk'), win: window, line: () => api.state() && api.el.children[0].children.find((k) => k.className === 'pds-line').textContent, send: () => api.el.children[0].children.find((k) => k.className === 'pds-btns').children[1] };
}
const { SUMMARY_PROMPT, YEAR_NOTE } = (() => { const w = {}; loadRefs(w, { createElement: mkEl }); const i = SUM_HTML.indexOf('<script id="pds-script">'); const src = SUM_HTML.slice(SUM_HTML.indexOf('>', i) + 1, SUM_HTML.indexOf('</script>', i)); new Function('window', 'document', src)(w, { createElement: mkEl }); return w.PADrawerSummary; })();

test('the multi-select bar gets ONE Summarize button beside Delete, only when the host passes hooks (CONTROL: none without)', async () => {
  const D = await drawer();
  const btns = D.bar().children.map((k) => [k.className, k.textContent]);
  assert.deepEqual(btns, [['pac-lbulksum', 'Summarize · 总结']], 'appended to the bulk bar; the Cancel/Delete buttons are in its innerHTML');
  const N = await drawer({ hooks: { none: true } });
  assert.deepEqual(N.bar().children, [], 'no hooks, no button');
  assert.equal(N.api(), null);
});

test('presets pick rows by their created date, the Selected preset by the ticks; the confirm line counts pages and characters from the note-text reply and names the lane', async () => {
  const D = await drawer({ picked: ['c', 'd'] });
  await D.api().open();
  assert.equal(D.api().state().key, 'selected', 'opens on Selected when rows are ticked');
  assert.deepEqual(D.api().state().rows.map((r) => r.id), ['d', 'c'], 'the ticked rows, oldest first');
  assert.equal(D.api().state().id, '2026-03-03..2026-10-15', 'a Selected period is named by its date span');
  assert.deepEqual(D.calls.fetched.at(-1), { paths: ['entry-d.json', 'entry-c.json'], fields: ['src', 'important'] }, 'one ask, src + the important lines, for exactly those files');
  for (const [key, ids, id] of [['week', ['a'], '2026-W46'], ['month', ['b', 'a'], '2026-11'], ['lastMonth', ['c', 's'], '2026-10'], ['year', ['d', 'c', 's', 'b', 'a'], '2026'], ['lastYear', ['e'], '2025']]) {
    await D.api().choose(key);
    assert.deepEqual(D.api().state().rows.map((r) => r.id), ids, key); assert.equal(D.api().state().id, id, key + ' period id');
  }
  await D.api().choose('month');
  assert.equal(D.line(), 'Send 3 pages · 51 characters to Claude · 发送 3 页 · 51 字到 Claude (off this Mac · 离开本机)', 'typed + ink of a\'s two pages and b\'s one; photo text left out');
  assert.equal(D.send().disabled, false);
  await D.api().togglePhoto(true);
  assert.equal(D.line(), 'Send 3 pages · 62 characters to Claude · 发送 3 页 · 62 字到 Claude (off this Mac · 离开本机)', 'the tick adds the photo text; no second ask');
  assert.equal(D.calls.fetched.length, 7, 'one ask per preset choice (six choices + the open), none for the tick');
});

test('Send runs exactly ONE rail turn under summary:<period> with the constant prompt and the pages grouped by day; the sheet closes and select mode ends', async () => {
  const D = await drawer();
  await D.api().open(); await D.api().choose('month');
  assert.equal(await D.api().send(), true);
  assert.equal(D.calls.run.length, 1); assert.deepEqual(D.calls.completed, [], 'a month is one turn: no map step');
  const t = D.calls.run[0];
  assert.equal(t.scope, 'summary:2026-11'); assert.equal(t.label, 'This month · 本月 Nov 2026', 'the label is the human title (PASummaryTitle), never the id');
  assert.equal(t.message, SUMMARY_PROMPT + '\n\n## 2026-11-02\n\n### [1] Rent\nRent paid\n\n## 2026-11-09\n\n### [2] Roof\nImportant · 重点:\n- call #landlord\nRain on the roof\nfix gutter\ncall #landlord', 'days in order, notes numbered, a note\'s important lines in a block before its pages (page order)');
  assert.deepEqual(D.win.PASummaryRefs.refsOf('summary:2026-11'), [{ n: 1, id: 'b', page: 0, title: 'Rent', day: '2026-11-02' }, { n: 2, id: 'a', page: 1, title: 'Roof', day: '2026-11-09' }], 'the refs the turn left: [2] → note a, its first page with an important line, its day (the link text)');
  assert.match(SUMMARY_PROMPT, /Important · 重点 .*like \[2\]\. · .*如 \[2\]。$/, 'the prompt asks for weight on the marked points and a source number after each, in both languages');
  assert.equal(D.api().state(), null, 'closed');
  assert.equal(D.d.el.querySelector('.pac-list').classList.contains('pac-multi'), false, 'select mode ended');
});

test('a year is built from months: a saved month summary is reused (asked by period AND its note title), the others are mapped through PAChat.complete in order, then the year turn runs in the rail; the line says the turns', async () => {
  const D = await drawer({ hooks: { monthSummary: async (p, title) => { D.calls.month.push([p, title]); return p === '2026-10' ? 'October summary text' : null; } } });
  await D.api().open(); await D.api().choose('year');
  assert.deepEqual(D.calls.month, [['2026-03', 'Month · 月 Mar 2026'], ['2026-10', 'Last month · 上月 Oct 2026'], ['2026-11', 'This month · 本月 Nov 2026']]);
  assert.equal(D.line(), 'Send 4 pages · 82 characters to Claude · 发送 4 页 · 82 字到 Claude (off this Mac · 离开本机) · 3 turns · 3 轮', 'March (11 characters, 1 page) + November (51, 3 pages) are sent; October\'s 20 saved characters ride instead of its page');
  assert.equal(await D.api().send(), true);
  assert.deepEqual(D.calls.completed.map(([m, o]) => [m.slice(SUMMARY_PROMPT.length + 2, SUMMARY_PROMPT.length + 15), o.label]), [['## 2026-03-03', 'Month · 月 Mar 2026'], ['## 2026-11-02', 'This month · 本月 Nov 2026']], 'two maps, chronological, each labelled');
  assert.equal(D.calls.run.length, 1);
  const t = D.calls.run[0]; assert.equal(t.scope, 'summary:2026');
  assert.ok(t.message.startsWith(SUMMARY_PROMPT + '\n' + YEAR_NOTE + '\n\n## 2026-03\n\n### [1] 2026-03\nSUM '), 'the year turn carries the month texts under numbered month headings');
  assert.match(t.message, /## 2026-10\n\n### \[2\] 2026-10\nOctober summary text\n\n## 2026-11\n\n### \[3\] 2026-11\nSUM /, 'the saved summary\'s text, not its pages');
  assert.deepEqual(D.win.PASummaryRefs.refsOf('summary:2026'), [{ n: 2, id: 's', page: 0, title: '2026-10', day: '2026-10' }], 'a year links [n] to the SAVED month note (the row titled Summary · 总结 2026-10 — the earlier title, still recognised); mapped months have no note and no link');
  const L = await drawer({ hooks: { monthSummary: async (p) => (p === '2026-10' ? 'Kept [3] and [1] inside' : null) } });
  await L.api().open(); await L.api().choose('year'); await L.api().send();
  assert.match(L.calls.run[0].message, /### \[2\] 2026-10\nKept and inside\n/, 'a saved month\'s own [n] are dropped: they number that month\'s notes, not the year\'s');
});

test('a single turn is capped at TURN_MAX_CHARS and the trim is said on the line and in the message', async () => {
  const big = 'x'.repeat(90000);
  const D = await drawer({ fetch: async () => ({ ok: true, pages: PAGES.concat([{ path: 'entry-g.json', scope: '', page: 0, src: { typed: big, ink: '', photo: '' } }]) }),
    items: () => rows().concat([{ id: 'g', title: 'Long', created: at(2026, 10, 20), doc: { path: 'entry-g.json' } }]) });
  await D.api().open(); await D.api().choose('lastMonth');
  assert.match(D.line(), / · trimmed · 已截断$/);
  await D.api().send();
  const m = D.calls.run[0].message;
  assert.ok(m.endsWith('[Trimmed to 80000 characters · 已截断至 80000 字]'));
  assert.ok(m.length < SUMMARY_PROMPT.length + 80000 + 60, 'the body is cut at the cap');
});

test('CONTROL: cancel sends nothing; a failed or absent note-text reply is said and Send stays off; a failed month map stops before the rail; a busy rail is said', async () => {
  const D = await drawer(); await D.api().open(); D.api().cancel();
  assert.deepEqual(D.calls.run, []); assert.deepEqual(D.calls.completed, []); assert.equal(D.api().state(), null);
  assert.equal(await D.api().send(), false, 'nothing to send after cancel');
  const F = await drawer({ fetch: async () => ({ ok: false, error: 'Signed out' }) }); await F.api().open();
  assert.equal(F.line(), 'Could not read the notes · 无法读取笔记 — Signed out'); assert.equal(F.send().disabled, true);
  assert.equal(await F.api().send(), false); assert.deepEqual(F.calls.run, []);
  const T = await drawer({ fetch: async () => { throw new Error('network'); } }); await T.api().open();
  assert.match(T.line(), /^Could not read the notes · 无法读取笔记 — network/, 'a throw is a failure too');
  const E = await drawer({ items: () => [] }); await E.api().open();
  assert.equal(E.line(), 'No notes in this period · 此时期没有笔记'); assert.deepEqual(E.calls.fetched, [], 'no rows, no ask');
  const M = await drawer({ complete: async () => ({ ok: false, error: 'lane down' }) }); await M.api().open(); await M.api().choose('year');
  assert.equal(await M.api().send(), false);
  assert.equal(M.calls.completed.length, 1, 'stopped at the first failed month'); assert.deepEqual(M.calls.run, [], 'the rail never ran');
  assert.equal(M.line(), 'Month summary failed · 月总结失败 2026-03 — lane down'); assert.equal(M.send().disabled, false, 'retry possible');
  const B = await drawer({ hooks: { run: async () => false } }); await B.api().open(); await B.api().choose('month');
  assert.equal(await B.api().send(), false); assert.equal(B.line(), 'Still answering · 正在回答中');
});

test('Save as note: only under an answer in a summary scope with a saveNote hook; the host gets the human title, the first line + mdToHtml(answer), the period, the scope and the thread; a refusal is said on the button', async () => {
  const D = await drawer();
  const S = D.win.PADrawerSummary;
  const bar = mkEl('div');
  assert.equal(S.decorate(bar, 'x', { key: 'note:1', convo: () => 'c1', hooks: { saveNote: async () => ({ ok: true }) } }), null, 'a note thread gets no button');
  assert.equal(S.decorate(bar, 'x', { key: 'summary:2026-11', convo: () => 'c1', hooks: null }), null, 'no hook, no button');
  const b = S.decorate(bar, '# Nov\n- rent', { key: 'summary:2026-11', convo: () => 'c1', hooks: { saveNote: async (o) => { D.calls.saved.push(o); return { ok: true }; } } });
  assert.equal(b.textContent, 'Save as note · 存为笔记'); assert.deepEqual(bar.children, [b]);
  await b.onclick();
  assert.deepEqual(D.calls.saved, [{ title: 'This month · 本月 Nov 2026 · 11/10 12:00', html: '<div>AI summary · AI 总结 — This month · 本月 Nov 2026 #summary #ai</div><p># Nov\n- rent</p>', period: '2026-11', scope: 'summary:2026-11', convoId: 'c1' }]);
  assert.equal(b.textContent, 'Saved · 已存'); assert.equal(b.disabled, true);
  // With the turn's refs remembered, the saved html carries the [n] as note links (the sanitizer keeps the scheme).
  D.win.PASummaryRefs.remember('summary:2026-11', [{ n: 2, id: 'a', page: 1, title: 'Roof', day: '2026-11-09' }]);
  const b2 = S.decorate(mkEl('div'), 'Fix the gutter [2] and pay [9]', { key: 'summary:2026-11', convo: () => 'c1', hooks: { saveNote: async (o) => { D.calls.saved.push(o); return { ok: true }; } } });
  await b2.onclick();
  assert.equal(D.calls.saved[1].html, '<div>AI summary · AI 总结 — This month · 本月 Nov 2026 #summary #ai</div><p>Fix the gutter <a href="?note=a&amp;page=1">[2] Roof · 2026-11-09</a> and pay [9]</p>', '[2] is linked to note a page 1 and says which note; [9] names no note and stays text');
  const r = S.decorate(mkEl('div'), 'x', { key: 'summary:2026', convo: () => null, hooks: { saveNote: async () => ({ ok: false, error: 'disk full' }) } });
  await r.onclick();
  assert.equal(r.textContent, 'Not saved · 未保存 — disk full'); assert.equal(r.disabled, false, 'a retry stays possible');
});

test('refs belong to the turn actually SENT: a plan that is re-planned or cancelled remembers nothing, and a bubble painted from the first turn keeps its links through a later plan (enhance and Save as note alike)', async () => {
  const D = await drawer(); const S = D.win.PASummaryRefs;
  await D.api().open(); await D.api().choose('month');
  assert.equal(S.refsOf('summary:2026-11'), null, 'planned, not sent: nothing remembered yet');
  assert.equal(await D.api().send(), true);
  const A = [{ n: 1, id: 'b', page: 0, title: 'Rent', day: '2026-11-02' }, { n: 2, id: 'a', page: 1, title: 'Roof', day: '2026-11-09' }];
  assert.deepEqual(S.refsOf('summary:2026-11'), A, 'the sent turn\'s refs');
  const bubble = { innerHTML: '<p>Call [2]</p>' };
  assert.equal(S.enhance(bubble, 'summary:2026-11'), true); assert.equal(bubble.innerHTML, '<p>Call <a href="?note=a&amp;page=1">[2] Roof · 2026-11-09</a></p>');
  // A second plan on other rows, never sent: the first turn's refs stand, the new scope has none.
  await D.api().open(); await D.api().choose('lastMonth'); assert.deepEqual(D.api().state().plan.turns[0].refs.map((r) => r.id), ['c'], 'the plan carries its refs');
  D.api().cancel();
  assert.equal(S.refsOf('summary:2026-10'), null, 'cancelled: nothing remembered'); assert.deepEqual(S.refsOf('summary:2026-11'), A);
  // A later turn in the SAME scope (a follow-up summary of another selection) cannot relink the older bubble or its Save as note.
  S.remember('summary:2026-11', [{ n: 2, id: 'zz', page: 0, title: 'Other' }]);
  assert.equal(S.enhance(bubble, 'summary:2026-11'), false); assert.doesNotMatch(bubble.innerHTML, /zz/);
  const b = D.win.PADrawerSummary.decorate(mkEl('div'), 'Call [2]', { el: bubble, key: 'summary:2026-11', convo: () => 'c1', hooks: { saveNote: async (o) => { D.calls.saved.push(o); return { ok: true }; } } });
  await b.onclick();
  assert.equal(D.calls.saved.at(-1).html, '<div>AI summary · AI 总结 — This month · 本月 Nov 2026 #summary #ai</div><p>Call <a href="?note=a&amp;page=1">[2] Roof · 2026-11-09</a></p>', 'the saved note links with the bubble\'s own refs, not the scope\'s newer ones');
});

test('AUTO-SAVE: the answer of the turn the sheet sent is saved by itself when it has streamed (fresh), once; a re-run of the period saves a NEW note (no id), a tap re-saves its own note by id; a replayed thread or a follow-up is saved only by the tap', async () => {
  const D = await drawer(); const S = D.win.PADrawerSummary, Rf = D.win.PASummaryRefs;
  const H = { saveNote: async (o) => { D.calls.saved.push(o); return { ok: true, id: 'n-' + D.calls.saved.length }; } };
  // Before any turn was sent: a fresh-looking answer under the scope is NOT a summary turn's (nothing pending).
  const b0 = S.decorate(mkEl('div'), 'early', { el: {}, key: 'summary:2026-11', convo: () => 'c1', hooks: H, fresh: true });   // no prompt: an absent prompt must never match an absent entry
  assert.equal(b0.pending, undefined); assert.deepEqual(D.calls.saved, [], 'CONTROL: nothing pending, nothing saved');
  await D.api().open(); await D.api().choose('month'); assert.equal(await D.api().send(), true);
  // The rail streamed the answer and chat-ui decorated the bubble from its send path (fresh).
  const bubble = { innerHTML: '<p>Call [2]</p>' }; Rf.enhance(bubble, 'summary:2026-11');
  const sent = () => D.calls.run[D.calls.run.length - 1].message;   // the prompt chat-ui's send path hands decorate (addActions `prompt`)
  const b1 = S.decorate(mkEl('div'), 'Call [2]', { el: bubble, key: 'summary:2026-11', convo: () => 'c1', hooks: H, fresh: true, prompt: sent() });
  assert.ok(b1.pending, 'saving at once'); assert.equal(await b1.pending, true);
  assert.equal(D.calls.saved.length, 1);
  assert.deepEqual(D.calls.saved[0], { title: 'This month · 本月 Nov 2026 · 11/10 12:00', html: '<div>AI summary · AI 总结 — This month · 本月 Nov 2026 #summary #ai</div><p>Call <a href="?note=a&amp;page=1">[2] Roof · 2026-11-09</a></p>', period: '2026-11', scope: 'summary:2026-11', convoId: 'c1' }, 'the same entry a tap would save, links included');
  assert.equal(b1.textContent, 'Saved · 已存'); assert.equal(b1.disabled, true);
  assert.equal(Rf.backTarget(), null); Rf.open('?note=a&page=1'); assert.equal(Rf.backTarget(), 'n-1', 'the saved note is where the back pill returns (noteSaved)');
  // A follow-up answer in the same thread (fresh, but the pending save was consumed): the tap only.
  const b2 = S.decorate(mkEl('div'), 'More', { el: {}, key: 'summary:2026-11', convo: () => 'c1', hooks: H, fresh: true });
  assert.equal(b2.pending, undefined); assert.equal(D.calls.saved.length, 1, 'a follow-up is not a summary');
  await b2.onclick(); assert.equal(D.calls.saved.length, 2, 'the tap saves it as its own note');
  // A replayed thread (openConvo: no fresh flag) after a new send: still only the tap.
  await D.api().open(); await D.api().choose('month'); await D.api().send();
  const b3 = S.decorate(mkEl('div'), 'Old', { el: {}, key: 'summary:2026-11', convo: () => 'c1', hooks: H });
  assert.equal(b3.pending, undefined); assert.equal(D.calls.saved.length, 2, 'a replay never saves by itself');
  const b4 = S.decorate(mkEl('div'), 'New', { el: {}, key: 'summary:2026-11', convo: () => 'c1', hooks: H, fresh: true, prompt: sent() });
  assert.equal(await b4.pending, true); assert.equal(D.calls.saved.length, 3, 'the re-run\'s own answer is saved');
  assert.equal(D.calls.saved[2].scope, 'summary:2026-11'); assert.equal(D.calls.saved[2].id, undefined, 'a re-run is a NEW note: no id, the host keeps the earlier run (owner 2026-11-12)');
  assert.equal(D.calls.saved[1].id, undefined, 'the tapped answer\'s first save is its own new note');
});

test('AUTO-SAVE failure is said on the button, the answer stays, a retry is possible; a refused turn leaves nothing pending (CONTROL)', async () => {
  const D = await drawer(); const S = D.win.PADrawerSummary;
  let fail = true; const H = { saveNote: async (o) => { D.calls.saved.push(o); return fail ? { ok: false, error: 'disk full' } : { ok: true, id: 'n1' }; } };
  await D.api().open(); await D.api().choose('month'); await D.api().send();
  const b = S.decorate(mkEl('div'), 'Answer', { el: {}, key: 'summary:2026-11', convo: () => 'c1', hooks: H, fresh: true, prompt: D.calls.run[0].message });
  assert.equal(await b.pending, false);
  assert.equal(b.textContent, 'Not saved · 未保存 — disk full'); assert.equal(b.disabled, false, 'the button stays live for a retry');
  fail = false; await b.onclick(); assert.equal(b.textContent, 'Saved · 已存'); assert.equal(D.calls.saved.length, 2);
  await b.onclick(); assert.equal(D.calls.saved[2].id, 'n1', 'a re-tap updates the note its first good save answered, never a third note'); assert.equal(D.calls.saved[1].id, undefined, 'a failed save minted no id');
  const T = await drawer({ hooks: { saveNote: H.saveNote, run: async () => { throw new Error('boom'); } } });
  await T.api().open(); await T.api().choose('month'); assert.equal(await T.api().send(), false);
  const tb = T.win.PADrawerSummary.decorate(mkEl('div'), 'x', { el: {}, key: 'summary:2026-11', convo: () => null, hooks: H, fresh: true });
  assert.equal(tb.pending, undefined, 'a turn the rail refused or that threw is not pending');
  const B = await drawer({ hooks: { run: async () => false } }); await B.api().open(); await B.api().choose('month'); await B.api().send();
  assert.equal(B.win.PADrawerSummary.decorate(mkEl('div'), 'x', { el: {}, key: 'summary:2026-11', convo: () => null, hooks: H, fresh: true }).pending, undefined);
});

test('AUTO-SAVE is bound to the turn sent: a sheet turn that ended without an answer (no decorate) leaves the user\'s next follow-up unsaved; the sheet turn\'s own answer saves (CONTROL)', async () => {
  const D = await drawer(); const S = D.win.PADrawerSummary;
  const H = { saveNote: async (o) => { D.calls.saved.push(o); return { ok: true, id: 'n1' }; } };
  // The rail accepted the turn (run → true) but it failed without text, or the user switched threads: chat-ui never decorated an answer.
  await D.api().open(); await D.api().choose('month'); assert.equal(await D.api().send(), true);
  const sent = D.calls.run[0].message;
  // The user's next question in the same scope, answered fresh from the send path with ITS prompt: not the summary.
  const b = S.decorate(mkEl('div'), 'Yes, Tuesday works', { el: {}, key: 'summary:2026-11', convo: () => 'c1', hooks: H, fresh: true, prompt: 'When is rent due?' });
  assert.equal(b.pending, undefined); assert.deepEqual(D.calls.saved, [], 'a follow-up answer is never saved as the period\'s note');
  const b2 = S.decorate(mkEl('div'), 'Later', { el: {}, key: 'summary:2026-11', convo: () => 'c1', hooks: H, fresh: true });
  assert.equal(b2.pending, undefined); assert.equal(D.calls.saved.length, 0, 'nor one decorated without a prompt');
  // CONTROL: the sheet turn's own answer (the same prompt, fresh) still saves by itself, once.
  const c = S.decorate(mkEl('div'), 'The month', { el: {}, key: 'summary:2026-11', convo: () => 'c1', hooks: H, fresh: true, prompt: sent });
  assert.equal(await c.pending, true); assert.equal(D.calls.saved.length, 1); assert.equal(D.calls.saved[0].scope, 'summary:2026-11');
  const c2 = S.decorate(mkEl('div'), 'Again', { el: {}, key: 'summary:2026-11', convo: () => 'c1', hooks: H, fresh: true, prompt: sent });
  assert.equal(c2.pending, undefined); assert.equal(D.calls.saved.length, 1, 'consumed: a re-ask (↺) of the same prompt is saved only by the tap');
});

test('a saved summary note is NOT a source of a new summary — by the host flag, its title (new or raw W form), its first line (new or raw period) or #summary; an ordinary note keeps its brackets (CONTROL)', async () => {
  const extra = [
    { path: 'entry-s.json', scope: '', page: 0, src: { typed: 'AI summary · AI 总结 — 2026-10 #summary #ai\nRoof fixed [1] and rent [12]', ink: '', photo: '' } },
    { path: 'entry-c.json', scope: '', page: 1, src: { typed: 'see [3] later', ink: '', photo: '' } },
    { path: 'entry-h.json', scope: '', page: 0, src: { typed: 'AI summary · AI 总结 — 2026-10-01..2026-10-07 #summary #ai\nWeek [2] done', ink: '', photo: '' } },
    { path: 'entry-n.json', scope: '', page: 0, src: { typed: 'AI summary · AI 总结 — Last month · 上月 Oct 2026 #summary #ai\nNew form', ink: '', photo: '' } },
    { path: 'entry-f.json', scope: '', page: 0, src: { typed: 'Flagged by the host', ink: '', photo: '' } },
    { path: 'entry-t.json', scope: '', page: 0, src: { typed: 'Edited first line\nstill tagged #summary here', ink: '', photo: '' } },
    { path: 'entry-u.json', scope: '', page: 0, src: { typed: 'Weekly recap #summary\nTagged on line one', ink: '', photo: '' } },
  ];
  const more = [{ id: 'h', title: 'My own title', created: at(2026, 10, 8), doc: { path: 'entry-h.json' } }, { id: 'n', title: 'Renamed', created: at(2026, 10, 9), doc: { path: 'entry-n.json' } },
    { id: 'f', title: 'Plain', created: at(2026, 10, 10), summary: true, doc: { path: 'entry-f.json' } }, { id: 't', title: 'Plain too', created: at(2026, 10, 11), doc: { path: 'entry-t.json' } },
    { id: 'u', title: 'Recap', created: at(2026, 10, 12), doc: { path: 'entry-u.json' } }];
  const D = await drawer({ fetch: async () => ({ ok: true, pages: PAGES.concat(extra) }), items: () => rows().concat(more) });
  await D.api().open(); await D.api().choose('lastMonth'); await D.api().send();
  const m = D.calls.run[0].message;
  assert.match(m, /### \[\d\] October\nOctober thoughts\nsee \[3\] later$/, 'the ordinary note is a source, its brackets its own text');
  assert.match(m, /### \[\d\] Plain too\nEdited first line\nstill tagged #summary here\n/, 'the body-mention note is its own numbered source');
  assert.ok(m.includes('still tagged #summary here'), 'a note that only MENTIONS #summary in its body is the owner\'s own note: a source (review 2026-11-11)');
  for (const w of ['AI summary', 'Roof fixed', 'Week', 'New form', 'Flagged', 'Tagged on line one']) assert.ok(!m.includes(w), 'no summary note enters the turn: ' + w);
  const S = D.win.PADrawerSummary;
  assert.ok(S.FIRST_LINE_RE.test('AI summary · AI 总结 — This week · 本周 Nov 9–15, 2026 #summary #ai') && S.FIRST_LINE_RE.test('AI summary · AI 总结 — 2026-W46 #summary #ai'), 'both first-line forms are read');
  assert.equal(S.isSummaryNote({ title: 'Summary · 总结 2026-W46' }, 'x'), true, 'the raw old title'); assert.equal(S.isSummaryNote({ title: 'Roof' }, 'Roof'), false, 'CONTROL');
  assert.equal(D.api().state(), null);
});

test('pins: chat-ui carries the marker (before the tags marker), web.mjs inlines the component after drawer-tags, the drawer attaches it to the bulk bar, the actions bar decorates AI answers, PAChat.lane reads the chooser; both hosts carry identical hooks', () => {
  assert.ok(CHAT.indexOf('<!--PA_DRAWER_SUMMARY_UI-->') > CHAT.lastIndexOf('</script>'), 'after chat-ui\'s script');
  assert.ok(CHAT.indexOf('<!--PA_DRAWER_SUMMARY_UI-->') < CHAT.indexOf('<!--PA_DRAWER_TAGS_UI-->'));
  const comps = WEB.slice(WEB.indexOf('const PA_COMPONENTS = ['), WEB.indexOf('];', WEB.indexOf('const PA_COMPONENTS = [')));
  assert.ok(comps.indexOf("file: 'drawer-summary.inline.html'") > comps.indexOf("file: 'drawer-tags.inline.html'"), 'registered after drawer-tags');
  assert.match(comps, /marker: '<!--PA_DRAWER_SUMMARY_UI-->', file: 'drawer-summary\.inline\.html'/);
  assert.match(CHAT, /if\(window\.PADrawerSummary\) window\.PADrawerSummary\.attach\(\{host,bar:bulkBar,head:q\('\.pac-dhead'\),picked:\(\)=>\[\.\.\._picked\]\.map\(itemOf\),items:\(\)=>_items,done:\(\)=>setMulti\(false\),hooks:c\.summary\|\|null\}\);/, 'the bulk bar AND the header slot (owner 2026-11-11)');
  assert.match(CHAT, /if\(window\.PADrawerSummary\) window\.PADrawerSummary\.decorate\(bar,rawText,\{el:bubble,key:scopeKey===undefined\?key:scopeKey,convo:\(c=>\(\)=>c\)\(curConvo\),hooks:opts\.summary\|\|null,fresh:scopeKey!==undefined,prompt\}\);/, 'the AI actions bar, with the bubble, its own scope key, conversation, fresh = the send path and the prompt (test/drawer-summary-review.test.mjs runs it)');
  assert.match(CHAT, /addActions\(thinking,'ai',final, q, k\);/, 'send() passes its scope key'); assert.match(CHAT, /addActions\(ae,'ai',mm\.text, lastUser\);/, 'openConvo\'s replay passes none');
  assert.match(CHAT, /lane:\(\)=>\{ const cur=PAC_MODELS\.find\(x=>x\.id===PAC_CURMODEL\)\|\|PAC_MODELS\[0\];/, 'the lane the next turn uses');
  assert.match(CHAT, /activeId:\(\)=>_sel, summary:opts\.summary,/, 'Chat\'s own drawer gets the host hooks');
  assert.match(CHAT, /onRefresh:o\.onRefresh, summary:o\.summary,/, 'and so does listDrawer');
  for (const [a, b, name] of [['notes (template)', 'notes (live)', 'SUMMARY_HOOKS'], ['bible (template)', 'bible (live)', 'BIBLE_SUMMARY']]) {
    const block = (s) => s.slice(s.indexOf('const ' + name + '={'), s.indexOf('\n};', s.indexOf('const ' + name + '={')) + 3);
    assert.ok(block(APP_SRC[a]).length > 100, name + ' in ' + a); assert.equal(block(APP_SRC[a]), block(APP_SRC[b]), name + ' identical in both copies');
    assert.match(APP_SRC[a], new RegExp('summary:' + name + ','), 'passed to the drawer / chat');
  }
  assert.match(APP_SRC['notes (live)'], /getLabel:\(k\)=>\{ if\(window\.PADrawerSummary&&PADrawerSummary\.isScope\(k\)\) return PADrawerSummary\.titleOf/, 'a summary thread is labelled by its period');
  for (const app of ['notes (live)', 'notes (template)']) { assert.doesNotMatch(APP_SRC[app], /summaryEntry\(period\)/, app + ': no upsert by period'); assert.match(APP_SRC[app], /if\(runId!=null\)\{ const old=entryById\(String\(runId\)\); return old\?updateSummaryNote\(old,\{title,html,convoId,quiet\}\):\{ok:false,gone:true\}; \}/, app + ': saveNote upserts by period, quiet carried (test/summary-followup-client.test.mjs pins the quiet path)'); assert.match(APP_SRC[app], /if\(period\) e\.summary=period;/, app + ': the entry carries its period'); }
  for (const app of ['bible (live)', 'bible (template)']) { assert.doesNotMatch(APP_SRC[app], /\.summary===period/, app + ': no upsert by period'); assert.match(APP_SRC[app], /if\(old&&!ANN\.draws\[old\]\) return \{ok:false,gone:true\};/, app + ': by the run\'s id'); }
  assert.match(APP_SRC['bible (live)'], /async function openNewDrawNote\(key\)\{/, 'the Bible opens a note the hook already wrote');
  assert.match(APP_SRC['bible (live)'], /const freeKey=key\|\|'free-'\+Date\.now\(\);/);
});
