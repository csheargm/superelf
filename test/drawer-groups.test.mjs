// The drawer's header, groups and jump strip（标题栏 · 分组 · 按月回溯, docs/plans/note-features.md H, owner
// 2026-11-11): PAChat is RUN (helpers-stationery loadChatUi) with the real components on its window —
// drawer-tags, summary-title (the one clock), drawer-groups — and a fake PANoteText answering the index's
// tags. Header: ＋, Summarize · 总结 (when the host passes summary hooks) and ONE ⋯ sheet with Sort / Select /
// Refresh. List: ★ Bookmarked, Summaries · 总结, then one sticky collapsible group per month (current month
// open, older closed, a tap remembered in the app prefs), the day headers kept inside; a jump strip of the
// years and months under the box; a search stays flat. CONTROL: no component → the day list as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CHAT } from './helpers-app.mjs';
import { WHERE, tick, ids, pickMore } from './helpers-drawer-search.mjs';
import { loadChatUi } from './helpers-stationery.mjs';
import { loadRefs } from './helpers-summary.mjs';

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const GROUPS_HTML = read('web/drawer-groups.inline.html'), TAGS_HTML = read('web/drawer-tags.inline.html'), TITLE_HTML = read('web/summary-title.inline.html'), SUM_HTML = read('web/drawer-summary.inline.html'), WEB = read('web.mjs');
const script = (html, id) => { const i = html.indexOf('<script id="' + id + '">'); return html.slice(html.indexOf('>', i) + 1, html.indexOf('</script>', i)); };
const NOW = new Date(2026, 0, 10, 12, 0, 0).getTime();   // Sat 2026-01-10 local: the current month is 2026-01, across the year boundary
const at = (y, m, d, h = 9) => new Date(y, m - 1, d, h, 0, 0).getTime();
const rows = () => [
  { id: 'a', title: 'Roof', created: at(2026, 1, 9), updated: at(2026, 1, 9), doc: { path: 'entry-a.json' } },
  { id: 'b', title: 'Rent', created: at(2026, 1, 2), updated: at(2026, 1, 3), pin: true, doc: { path: 'entry-b.json' } },
  { id: 'c', title: 'Advent', created: at(2025, 12, 15), doc: { path: 'entry-c.json' } },
  { id: 'd', title: 'Advent two', created: at(2025, 12, 15, 18), doc: { path: 'entry-d.json' } },
  { id: 'e', title: 'Thanks', created: at(2025, 11, 27), doc: { path: 'entry-e.json' } },
  { id: 'f', title: 'A chat', created: at(2025, 12, 1) },
  { id: 's', title: 'This month · 本月 Jan 2026', created: at(2026, 1, 8), doc: { path: 'entry-s.json' } },   // a saved summary, by its title (PASummaryTitle)
  { id: 't', title: 'Tagged', created: at(2025, 12, 20), doc: { path: 'entry-t.json' } },                    // a #summary page (the index's tag)
  { id: 'u', title: 'Flagged', created: at(2025, 11, 1), summary: true, doc: { path: 'entry-u.json' } },     // the host's own flag
  { id: 'n', title: 'No time', doc: { path: 'entry-n.json' } },
];
const PAGES = [{ path: 'entry-t.json', scope: '', page: 0, tags: ['summary', 'ai'], typedTags: ['summary', 'ai'] }, { path: 'entry-a.json', scope: '', page: 0, tags: ['roof'], typedTags: ['roof'] }];
function mkEl(tag) { const on = {}, kids = []; return { tagName: String(tag).toUpperCase(), className: '', innerHTML: '', textContent: '', disabled: false, on, children: kids,
  appendChild(k) { kids.push(k); return k; }, addEventListener: (t, fn) => (on[t] ||= []).push(fn), setAttribute(k, v) { this['@' + k] = v; }, remove() { this.removed = true; }, querySelector: () => null }; }

// One listDrawer with the components on the page. `stored` = the app prefs the shell answers; `sent` = every
// broker request the drawer posts; `summary` = host hooks (the header's Summarize appears only with them).
async function drawer({ items = rows, stored = {}, component = true, summary = null, ack = true } = {}) {
  const sent = [], winOn = {};
  // The shell answers every write (ok:true, on a microtask, like helpers-stationery's shell stub); `ack:false`
  // leaves the writes for the test to answer with reply(id, r), the way the serialisation test needs.
  // The store behaves as the shell's does: app-settings answers what is stored, an accepted write replaces it whole.
  let state = JSON.parse(JSON.stringify(stored));
  const reply = (id, r) => { const w = sent.find((m) => m.id === id && m.kind === 'set-app-settings'); if (w && r.ok) state = JSON.parse(JSON.stringify(w.prefs));
    for (const fn of winOn.message || []) fn({ data: { pa: 'res', id, ...r } }); };
  const post = (m) => { sent.push(m);
    if (m.kind === 'app-settings') queueMicrotask(() => reply(m.id, { ok: true, prefs: JSON.parse(JSON.stringify(state)), systemPrompt: { override: '' } }));
    if (ack && m.kind === 'set-app-settings') queueMicrotask(() => reply(m.id, { ok: true })); };
  const win = { PA_SUMMARY_NOW: NOW, PANote: { SEARCH_TXT: WHERE, search: async () => ({ ok: true, hits: [] }) }, PANoteText: { fetch: async () => ({ ok: true, pages: PAGES }) },
    addEventListener: (t, fn) => (winOn[t] ||= []).push(fn) };   // the broker's replies come back through window 'message'
  const doc = { createElement: mkEl };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', script(TITLE_HTML, 'pst-script'))(win, doc);
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'setTimeout', 'clearTimeout', script(TAGS_HTML, 'pdt-script'))(win, doc, () => 0, () => {});
  // eslint-disable-next-line no-new-func
  if (component) new Function('window', 'document', script(GROUPS_HTML, 'pdg-script'))(win, doc);
  const { PAChat, window } = loadChatUi({ win, parent: { postMessage: post } });
  if (summary) { loadRefs(window, doc); new Function('window', 'document', script(SUM_HTML, 'pds-script'))(window, doc); }   // eslint-disable-line no-new-func
  const d = PAChat.listDrawer({ title: 'Notes', items: async () => items(), onOpen: () => {}, onDelete: async () => {}, onPin: async () => {}, summary });
  // The shell's app-settings answer: the drawer asked on build; answer it the way the shell does (a 'res' message on the window).
  await d.refresh(); await tick(20);
  assert.ok(sent.some((m) => m.kind === 'app-settings'), 'the drawer asks the shell for this app\'s prefs on build');
  const el = (s) => d.el.querySelector(s);
  const type = async (q) => { el('.pac-q').value = q; for (const fn of el('.pac-q').on.input || []) fn(); await tick(5); };
  const tapGroup = (g) => { for (const fn of el('.pac-lrows').on.click || []) fn({ target: { closest: (s) => (s === '.pac-lgroup' ? { dataset: { g } } : null) }, stopImmediatePropagation() {} }); };
  const jump = () => el('.pac-lsearch').children.find((k) => k.className === 'pac-ljump');
  const tapJump = (g) => { for (const fn of jump().on.click || []) fn({ target: { closest: (s) => (s === '.pac-ljm' ? { dataset: { g } } : null) } }); };
  const tapRow = (id, shiftKey = false) => { for (const fn of el('.pac-lrows').on.click || []) fn({ shiftKey, target: { closest: (s) => (s === '.pac-lrow' ? { dataset: { id }, classList: { add() {}, remove() {} } } : null) }, stopImmediatePropagation() {} }); };
  return { d, sent, el, type, tapGroup, tapRow, jump, tapJump, reply, rows: () => el('.pac-lrows').innerHTML, win: window };
}
// The group headers in order, with their open state, and the row ids each open one holds.
const groupsOf = (html) => [...html.matchAll(/<div class="pac-lgroup" data-g="([^"]+)" role="button" tabindex="0" aria-expanded="(true|false)">/g)].map((m) => [m[1], m[2] === 'true']);
const rowsUnder = (html, key) => { const i = html.indexOf('data-g="' + key + '"'); const j = html.indexOf('class="pac-lgroup"', i + 1); return ids(j < 0 ? html.slice(i) : html.slice(i, j)); };
const G = (() => { const w = {}; new Function('window', 'document', script(GROUPS_HTML, 'pdg-script'))(w, { createElement: mkEl }); return w.PADrawerGroups; })();   // eslint-disable-line no-new-func

test('header: ＋, the Summarize slot and ONE ⋯ (no Sort / Select / Refresh buttons); the sheet offers Sort, Select, Refresh; Select enters multi-select, Sort flips the order and writes noteSort', async () => {
  const top = /'<div class="pac-top">[\s\S]*?'<\/div>'\+\n/.exec(CHAT)[0];
  assert.match(top, /pac-dnew/); assert.match(top, /<span class="pac-dhead"><\/span>/); assert.match(top, /class="pac-new pac-dmore" title="More · 更多"/);
  assert.doesNotMatch(top, /pac-dsort|pac-dsel|pac-drefresh/);
  const D = await drawer();
  const labels = await pickMore(D.d, '');
  assert.deepEqual(labels, ['Sort by last edited · 按修改时间排序', 'Select · 多选', 'Refresh · 刷新'], 'the default order is by creation, so the entry offers the other one; no hidden tags, no Show hidden');
  await pickMore(D.d, 'Select');
  assert.ok(D.el('.pac-list').classList.contains('pac-multi'), 'multi-select entered from the sheet');
  assert.deepEqual(await pickMore(D.d, 'Done'), ['Sort by last edited · 按修改时间排序', 'Done · 完成', 'Refresh · 刷新'], 'in the mode the entry reads Done');
  assert.equal(D.el('.pac-list').classList.contains('pac-multi'), false);
  await pickMore(D.d, 'Sort');
  assert.deepEqual(D.sent.filter((m) => m.kind === 'set-app-settings').map((m) => m.prefs), [{ noteSort: 'updated' }], 'the order goes to the app prefs, merged into the object the shell answered');
  assert.deepEqual((await pickMore(D.d, '')).slice(0, 1), ['Sort by date created · 按创建时间排序'], 'and the entry now offers the way back');
});

test('groups: ★ Bookmarked, Summaries, then the months newest first; the current month open, older months closed; the day headers inside an open month; rows without a time last', async () => {
  const D = await drawer();
  const html = D.rows();
  assert.deepEqual(groupsOf(html), [['pins', true], ['sums', true], ['2026-01', true], ['2025-12', false], ['2025-11', false], ['none', false]]);
  assert.deepEqual(rowsUnder(html, 'pins'), ['b'], 'a pinned row sits in the Bookmarked group and nowhere else');
  assert.deepEqual(rowsUnder(html, 'sums'), ['s', 't', 'u'], 'by title (PASummaryTitle), by the #summary tag (the index), by the host flag — newest first');
  assert.deepEqual(rowsUnder(html, '2026-01'), ['a'], 'the current month: open (b and s went to their own groups)');
  assert.deepEqual(rowsUnder(html, '2025-12'), [], 'an older month: closed by default');
  assert.deepEqual(rowsUnder(html, 'none'), [], 'no date: closed by default');
  assert.match(html, /data-g="pins"[^>]*>(?:<span class="pac-lgcaret">▾<\/span>)★ Bookmarked · 收藏<span class="pac-lgn">1<\/span>/);
  assert.match(html, /▾<\/span>Summaries · 总结<span class="pac-lgn">3<\/span>/);
  assert.match(html, /▾<\/span>2026 · Jan 一月<span class="pac-lgn">1<\/span>/, 'the month header: year · English 中文');
  assert.match(html, /▸<\/span>2025 · Dec 十二月<span class="pac-lgn">3<\/span>/, 'a closed month still counts its rows (c, d and the chat f; t is a summary)');
  assert.match(html, /▸<\/span>No date · 无日期<span class="pac-lgn">1<\/span>/);
  assert.ok(html.indexOf('class="pac-lday"') > html.indexOf('data-g="2026-01"') && html.indexOf('class="pac-lday"') < html.indexOf('data-id="a"'), 'the day header sits under the month header, above its row');
  assert.doesNotMatch(html.slice(0, html.indexOf('data-g="2026-01"')), /pac-lday/, 'the fixed groups list their rows plainly');
  assert.equal(G.MONTHS_EN.join(), D.win.PASummaryTitle.MONTHS.join(), 'one month-name list with the summaries');
  assert.equal(D.win.PADrawerSummary, undefined); assert.match(SUM_HTML, new RegExp(' #' + G.SUMMARY_TAG + ' #ai'), 'the tag is the one the saved summary\'s first line carries');
});

test('collapse: a tap on a month header toggles it, is written to the app prefs (noteGroups) and read back on the next build; the stored state wins over the default', async () => {
  const D = await drawer();
  D.tapGroup('2025-12'); await tick(5);
  assert.deepEqual(groupsOf(D.rows()).find((g) => g[0] === '2025-12'), ['2025-12', true]);
  assert.deepEqual(rowsUnder(D.rows(), '2025-12'), ['d', 'c', 'f'], 'opened: its rows, newest first (t is in Summaries)');
  assert.match(D.rows().slice(D.rows().indexOf('data-g="2025-12"')), /pac-lday/, 'with their day headers');
  D.tapGroup('2026-01'); await tick(5);
  assert.deepEqual(rowsUnder(D.rows(), '2026-01'), [], 'the current month closes too');
  const writes = D.sent.filter((m) => m.kind === 'set-app-settings').map((m) => m.prefs);
  assert.deepEqual(writes, [{ noteGroups: { '2025-12': 1 } }, { noteGroups: { '2025-12': 1, '2026-01': 0 } }], 'only the groups tapped are stored (1 open, 0 closed)');
  const E = await drawer({ stored: { noteSort: 'created', noteGroups: { '2025-11': 1, pins: 0 } } });
  assert.deepEqual(groupsOf(E.rows()), [['pins', false], ['sums', true], ['2026-01', true], ['2025-12', false], ['2025-11', true], ['none', false]], 'the stored state applies from the first draw');
  assert.deepEqual(rowsUnder(E.rows(), 'pins'), []);
  assert.deepEqual(E.sent.filter((m) => m.kind === 'set-app-settings').map((m) => m.prefs), [], 'nothing written by reading');
  E.tapGroup('pins'); await tick(5);
  assert.deepEqual(E.sent.filter((m) => m.kind === 'set-app-settings').map((m) => m.prefs), [{ noteSort: 'created', noteGroups: { '2025-11': 1, pins: 1 } }], 'a write carries the other prefs along (the shell replaces the whole object)');
});

test('jump strip: the years and months that have notes, newest first, under the box; a tap opens that month; the strip leaves while the box has text, and a search stays flat', async () => {
  const D = await drawer();
  assert.equal(D.jump().innerHTML, '<span class="pac-ljy">2026</span><button type="button" class="pac-ljm" data-g="2026-01">Jan</button><span class="pac-ljy">2025</span><button type="button" class="pac-ljm" data-g="2025-12">Dec</button><button type="button" class="pac-ljm" data-g="2025-11">Nov</button>');
  D.tapJump('2025-11'); await tick(5);
  assert.deepEqual(groupsOf(D.rows()).find((g) => g[0] === '2025-11'), ['2025-11', true]);
  assert.deepEqual(rowsUnder(D.rows(), '2025-11'), ['e'], 'opened by the jump (u is a summary)');
  await D.type('advent');
  assert.equal(D.jump().innerHTML, '', 'no strip while searching');
  assert.deepEqual(groupsOf(D.rows()), [], 'a search result is the flat day list');
  assert.deepEqual(ids(D.rows()), ['d', 'c']);
  assert.match(D.rows(), /^<div class="pac-lday">/, 'with the day header first');
  await D.type('');
  assert.deepEqual(groupsOf(D.rows()).map((g) => g[0]), ['pins', 'sums', '2026-01', '2025-12', '2025-11', 'none'], 'cleared: the groups again');
});

test('the star: ONE token --pac-star, a filled amber with at least 3:1 contrast on the light and the dark row background; drawer-tags colours no star', () => {
  const tok = /:root\{--pac-star:(#[0-9a-f]{6})\}/.exec(GROUPS_HTML);
  assert.ok(tok, 'the token is declared once, on :root');
  assert.match(GROUPS_HTML, /\.pac-lstar\{color:var\(--pac-star\);font-size:17px/, 'the star reads the token and is larger than the title text');
  assert.doesNotMatch(TAGS_HTML + CHAT, /pac-lstar\{/, 'no second rule colours it');
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [h, l] = [lum(a), lum(b)].sort((x, y) => y - x); return (h + 0.05) / (l + 0.05); };
  assert.ok(ratio(tok[1], '#ffffff') >= 3, 'light card: ' + ratio(tok[1], '#ffffff').toFixed(2));
  assert.ok(ratio(tok[1], '#1c1c1e') >= 3, 'dark card: ' + ratio(tok[1], '#1c1c1e').toFixed(2));
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(tok[1].slice(i, i + 2), 16));
  assert.ok(r > g && g > b * 2, 'amber: red over green over blue');
});

test('Summarize · 总结 in the header opens the same sheet as the bar\'s, with Selected greyed until rows are ticked; absent without host hooks', async () => {
  const H = { run: async () => true, saveNote: async () => ({ ok: true }), onLink() {} };
  const D = await drawer({ summary: H });
  const head = D.el('.pac-dhead');
  assert.deepEqual(head.children.map((k) => [k.className, k.textContent]), [['pac-lbulksum pac-dsum', 'Summarize · 总结']]);
  head.children[0].onclick(); await tick(20);
  const sheet = D.d.el.children.filter((k) => /^pac-modal pac-msheet/.test(k.className)).pop();
  assert.ok(sheet, 'the summary sheet opened in the drawer host');
  const sel = sheet.children[0].children.find((k) => k.className === 'pds-p');
  assert.equal(sel.textContent, 'Selected · 已选 (0)'); assert.equal(sel.disabled, true, 'greyed: nothing ticked');
  assert.equal(sheet.children[0].children.filter((k) => k.className === 'pds-p').some((k) => k['@aria-pressed'] === 'true' && k.textContent.startsWith('This month')), true, 'the month preset is the one chosen instead');
  const N = await drawer();
  assert.deepEqual(N.el('.pac-dhead').children, [], 'no hooks, no header button');
});

test('CONTROL: without the component the drawer draws the day list as before, the jump strip does not exist, and the ⋯ sheet still works; the hooks and the registration are pinned', async () => {
  const D = await drawer({ component: false });
  assert.deepEqual(groupsOf(D.rows()), []);
  assert.deepEqual(ids(D.rows()), ['a', 's', 'b', 't', 'd', 'c', 'f', 'e', 'u', 'n'], 'every row, newest first, no groups');
  assert.match(D.rows(), /^<div class="pac-lday">/);
  assert.equal(D.jump(), undefined);
  assert.deepEqual(await pickMore(D.d, ''), ['Sort by last edited · 按修改时间排序', 'Select · 多选', 'Refresh · 刷新']);
  assert.match(CHAT, /const groups=window\.PADrawerGroups\?window\.PADrawerGroups\.attach\(\{host,rows,box:qi,items:\(\)=>_items,prefs,redraw:\(\)=>draw\(\),esc,days:dayHtml,ts:sortTs,tags:it=>tags\?tags\.tagsOf\(it\):\[\]\}\):null;/, 'the one-line hook');
  assert.match(CHAT, /rows\.innerHTML=groups\?groups\.html\(shown,rowHtml,!!f\):dayHtml\(shown,rowHtml\);/, 'the list html asks the component, flat on a search');
  assert.ok(CHAT.indexOf('window.PADrawerGroups.attach({host,rows,') < CHAT.indexOf("rows.addEventListener('click',e=>{"), 'its header-tap listener comes before the row-click one');
  const comps = WEB.slice(WEB.indexOf('const PA_COMPONENTS = ['), WEB.indexOf('];', WEB.indexOf('const PA_COMPONENTS = [')));
  assert.match(comps, /\{ marker: '<!--PA_DRAWER_GROUPS_UI-->', file: 'drawer-groups\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_SUMMARY_IMAGES_UI-->', file: 'summary-images\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_SUMMARY_FOLLOWUP_UI-->', file: 'summary-followup\.inline\.html' \},\n  \/\/[^\n]*\n  \/\/[^\n]*\n  \{ marker: '<!--PA_INK_ANCHOR_UI-->', file: 'ink-anchor\.inline\.html' \},\n  \/\/[^\n]*\n  \/\/[^\n]*\n  \{ marker: '<!--PA_INK_PEN_UI-->', file: 'ink-pen\.inline\.html' \},\n  \/\/[^\n]*\n  \/\/[^\n]*\n  \{ marker: '<!--PA_APP_PREFS_UI-->', file: 'app-prefs\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_SETTINGS_ROWS-->', file: 'settings-rows\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_TIPS_UI-->', file: 'tips\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_PANE_CHROME_UI-->', file: 'pane-chrome\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_APP_BAR_UI-->', file: 'app-bar\.inline\.html' \},\n  \/\/[^\n]*\n  \{ marker: '\/\* PA_BAR_HANDLE_CSS \*\/', file: 'bar-handle\.css' \},\n  \/\/[^\n]*\n  \{ marker: '<!--PA_READING_HISTORY_UI-->', file: 'reading-history\.inline\.html' \},\n$/, 'registered after the title component; only the images, follow-up, ink-anchor, ink-pen, app-prefs, settings-rows, tips and pane-chrome components (appended later) follow (the append-only rule)');
  assert.ok(CHAT.trimEnd().endsWith('<!--PA_DRAWER_GROUPS_UI-->\n<!--PA_APP_PREFS_UI-->\n<!--PA_TIPS_UI-->'), 'chat-ui carries the marker after the tags marker, before the app-prefs one');
});

test('shift-range in select mode is measured in the DRAWN order — group by group, a closed group left out — not the pre-group sort', async () => {
  const D = await drawer();
  await pickMore(D.d, 'Select');
  // Drawn: pins [b], sums [s, t, u], 2026-01 [a]; Dec/Nov/none closed. The pre-group sort is a, s, b, t, d, c, f, e, u, n.
  D.tapRow('b'); D.tapRow('a', true); await tick(5);
  assert.match(D.el('.pac-lbulkn').textContent, /^5 selected/, 'b → a sweeps the three summaries between them in the drawn order');
  // Open December and sweep from a down into it: the sort order would reach d, c, f only after t; the drawn order has them under a.
  await pickMore(D.d, 'Done'); D.tapGroup('2025-12'); await tick(5); await pickMore(D.d, 'Select');
  D.tapRow('a'); D.tapRow('f', true); await tick(5);
  assert.match(D.el('.pac-lbulkn').textContent, /^4 selected/, 'a, d, c, f — nothing from the closed months and nothing from the groups above a');
  D.tapRow('e', true); await tick(5);
  assert.match(D.el('.pac-lbulkn').textContent, /^4 selected/, 'a row in a CLOSED group is not drawn, so a range to it selects nothing more');
  assert.match(CHAT, /_shown=groups\?groups\.drawn\(\):shown;/, 'the drawer records the component\'s drawn order');
});

test('prefs writes are ONE chain: a second write waits for the first answer and carries its value; the first read is waited for too', async () => {
  const D = await drawer({ ack: false });
  await pickMore(D.d, 'Sort');            // writes noteSort — unanswered
  D.tapGroup('2025-12'); await tick(5);   // writes noteGroups while the first is in flight
  const writes = () => D.sent.filter((m) => m.kind === 'set-app-settings');
  assert.equal(writes().length, 1, 'the second write is not sent before the first is answered');
  assert.deepEqual(writes()[0].prefs, { noteSort: 'updated' });
  D.reply(writes()[0].id, { ok: true }); await tick(5);
  assert.equal(writes().length, 2);
  assert.deepEqual(writes()[1].prefs, { noteSort: 'updated', noteGroups: { '2025-12': 1 } }, 'the second carries the first\'s value (the shell replaces the whole object)');
  // A refused first write leaves the object alone, and the next write still goes out, over the unchanged object.
  D.tapGroup('2025-11'); await tick(5);
  assert.equal(writes().length, 2, 'queued behind the unanswered second');
  D.reply(writes()[1].id, { ok: false, error: 'read-only' }); await tick(5);
  assert.deepEqual(writes()[2].prefs, { noteSort: 'updated', noteGroups: { '2025-12': 1, '2025-11': 1 } }, 'the groups keep their optimistic state; the merged base is the last ACCEPTED object');
  D.reply(writes()[2].id, { ok: true });
  // The read: a write made before the shell answered app-settings waits for it and merges into what it answered.
  const sent = [], winOn = {};
  const win = { PA_SUMMARY_NOW: NOW, PANote: { SEARCH_TXT: WHERE, search: async () => ({ ok: true, hits: [] }) }, PANoteText: { fetch: async () => ({ ok: true, pages: PAGES }) }, addEventListener: (t, fn) => (winOn[t] ||= []).push(fn) };
  new Function('window', 'document', script(GROUPS_HTML, 'pdg-script'))(win, { createElement: mkEl });   // eslint-disable-line no-new-func
  const { PAChat } = loadChatUi({ win, parent: { postMessage: (m) => sent.push(m) } });
  const d = PAChat.listDrawer({ title: 'Notes', items: async () => rows(), onOpen: () => {}, onDelete: async () => {} });
  await d.refresh(); await tick(20);
  for (const fn of d.el.querySelector('.pac-lrows').on.click || []) fn({ target: { closest: (s) => (s === '.pac-lgroup' ? { dataset: { g: '2025-12' } } : null) }, stopImmediatePropagation() {} });
  await tick(5);
  assert.equal(sent.filter((m) => m.kind === 'set-app-settings').length, 0, 'no write before the read is answered');
  // The page's ONE chain (PAAppPrefs): the build reads, then the write re-reads; answer each ask as the shell would.
  for (let i = 0; i < 5 && !sent.some((m) => m.kind === 'set-app-settings'); i++) {
    for (const ask of sent.filter((m) => m.kind === 'app-settings' && !m.answered)) { ask.answered = true;
      for (const fn of winOn.message || []) fn({ data: { pa: 'res', id: ask.id, ok: true, prefs: { hiddenTags: ['x'], noteSort: 'created' }, systemPrompt: { override: '' } } }); }
    await tick(5);
  }
  assert.deepEqual(sent.filter((m) => m.kind === 'set-app-settings').map((m) => m.prefs), [{ hiddenTags: ['x'], noteSort: 'created', noteGroups: { '2025-12': 1 } }], 'merged into the object the read brought');
});
