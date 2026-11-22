// The shared drawer's tag chips and strip (web/drawer-tags.inline.html, docs/plans/note-features.md B):
// PAChat is RUN (helpers-stationery loadChatUi) with the real component on its window, a fake
// PANoteText.fetch answering the index's tags, and a fake PANote.search receiving the tap. Rows join
// the reply by `doc` through the drawer's own sameDoc; a row without `doc` gets no chip; a page
// without the component draws exactly as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CHAT } from './helpers-app.mjs';
import { WHERE, tick, SETTLE_MS, ids, pickMore } from './helpers-drawer-search.mjs';
import { loadChatUi } from './helpers-stationery.mjs';

const TAGS_HTML = fs.readFileSync(path.join(ROOT, 'web', 'drawer-tags.inline.html'), 'utf8');
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
const rows = () => [
  { id: 'a', title: 'Roof', preview: 'typed', updated: 3, doc: { path: 'entry-1.json' } },
  { id: 'b', title: 'Bible', preview: 'verse', updated: 2, doc: { path: 'notes/43-3.json', scope: 'v16' } },
  { id: 'c', title: 'No doc', preview: '', updated: 1 },
];
// The index's answer: entry-1 has two pages (six distinct tags across them), the Bible file two notebooks.
// `typedTags` (lib/note-text.mjs) names the typed ones: `scrawl` is handwriting OCR on three pages — a row chip
// and searchable, never in the strip (note-features.md H).
const PAGES = [
  { path: 'entry-1.json', scope: '', page: 0, pending: false, tags: ['ores', '灵修', 'todo', 'scrawl'], typedTags: ['ores', '灵修'] },
  { path: 'entry-1.json', scope: '', page: 1, pending: false, tags: ['todo', 'roof', 'rent', 'scrawl'], typedTags: ['todo', 'roof', 'rent'] },
  { path: 'notes/43-3.json', scope: 'v16', page: 0, pending: false, tags: ['prayer'], typedTags: ['prayer'] },
  { path: 'notes/43-3.json', scope: 'general', page: 0, pending: false, tags: ['chapter'], typedTags: ['chapter'] },
  { path: 'entry-9.json', scope: '', page: 0, pending: false, tags: ['todo', 'rent', 'zz', 'yy', 'xx', 'ww', 'vv', 'scrawl'], typedTags: ['todo', 'rent', 'zz', 'yy', 'xx', 'ww', 'vv'] },
];
const chipsOf = (html) => [...html.matchAll(/class="pac-ltag" data-tag="([^"]+)"/g)].map((m) => m[1]);
const rowHtml = (html, id) => { const i = html.indexOf(`data-id="${id}"`); const j = html.indexOf('pac-lrow', i + 1); return j < 0 ? html.slice(i) : html.slice(i, j); };

// Stubbed timers for the long-press (never a real setTimeout in a fake-DOM test): the component's bare
// setTimeout/clearTimeout are these, injected as Function parameters.
function fakeTimers() { const q = [];
  return { q, setTimeout: (fn, ms) => { q.push({ fn, ms, id: q.length + 1, cleared: false }); return q.length; }, clearTimeout: (id) => { const t = q.find((x) => x.id === id); if (t) t.cleared = true; },
    fire: () => { for (const t of q.splice(0)) if (!t.cleared) t.fn(); } }; }

// One drawer with the component loaded on the page; `fetch` answers PANoteText.fetch (null = no component).
// `sent` records every broker request the drawer posts (the prefs writes go there as set-app-settings).
async function drawer({ fetch = async () => ({ ok: true, pages: PAGES }), component = true, items = rows } = {}) {
  const fetched = [], searched = [], sent = [], timers = fakeTimers(), winOn = {};
  // The shell answers every request (the prefs read with an empty object, a write with ok:true), on a microtask
  // like helpers-stationery's shell stub: a prefs write waits for the read and the prior write (chat-ui's one chain).
  const reply = (id, r) => { for (const fn of winOn.message || []) fn({ data: { pa: 'res', id, ...r } }); };
  const post = (m) => { sent.push(m); if (m.kind === 'app-settings') queueMicrotask(() => reply(m.id, { ok: true, prefs: {} })); if (m.kind === 'set-app-settings') queueMicrotask(() => reply(m.id, { ok: true })); };
  const win = { PANote: { SEARCH_TXT: WHERE, search: async (q) => { searched.push(q); return { ok: true, hits: [] }; } }, PANoteText: { fetch: async (o) => { fetched.push(o); return fetch(o); } },
    addEventListener: (t, fn) => (winOn[t] ||= []).push(fn) };
  if (component) {
    const src = TAGS_HTML.slice(TAGS_HTML.indexOf('>', TAGS_HTML.indexOf('<script id="pdt-script">')) + 1, TAGS_HTML.indexOf('</script>', TAGS_HTML.indexOf('<script id="pdt-script">')));
    // On the SAME window the drawer gets: the component reads window.PANoteText at call time.
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'setTimeout', 'clearTimeout', src)(win, { createElement: (t) => mkEl(t) }, timers.setTimeout, timers.clearTimeout);
  }
  const { PAChat } = loadChatUi({ win, parent: { postMessage: post } });
  const d = PAChat.listDrawer({ title: 'Notes', items: async () => items(), onOpen: () => {} });
  await d.refresh(); await tick(20);
  const el = (s) => d.el.querySelector(s);
  const strip = () => el('.pac-lsearch').children.find((k) => k.className === 'pac-ltags');
  const type = async (q) => { el('.pac-q').value = q; for (const fn of el('.pac-q').on.input || []) fn(); };
  const chipEv = (tag) => ({ target: { closest: (s) => (s === '.pac-ltag' ? { dataset: { tag } } : null) }, stopped: false, stopImmediatePropagation() { this.stopped = true; }, preventDefault() {} });
  const tap = (tag, where = el('.pac-lrows')) => { const ev = chipEv(tag);
    for (const fn of where.on.click || []) { if (ev.stopped) break; fn(ev); } return ev; };
  const press = (tag, ev = 'pointerdown') => { for (const fn of strip().on[ev] || []) fn(chipEv(tag)); };
  return { d, fetched, searched, sent, timers, strip, type, tap, press, rows: () => el('.pac-lrows').innerHTML, box: () => el('.pac-q').value, el };
}
function mkEl(tag) { const on = {}; return { tagName: String(tag).toUpperCase(), className: '', innerHTML: '', on, addEventListener: (t, fn) => (on[t] ||= []).push(fn) }; }

test('rows get up to 3 chips after the Note chip, "+n" beyond, joined by path and scope; a row without doc gets none', async () => {
  const D = await drawer();
  assert.deepEqual(D.fetched, [{ fields: ['tags'] }], 'one ask per refresh, tags only (no page text travels for a chip)');
  const a = rowHtml(D.rows(), 'a');
  assert.deepEqual(chipsOf(a), ['ores', '灵修', 'todo'], 'page order, deduped across the file\'s pages (todo once), cut at three');
  assert.match(a, /<span class="pac-lchip">\+3<\/span>/, 'scrawl, roof and rent fold into +3 (a handwritten tag stays on its row)');
  assert.ok(a.indexOf('pac-ltag') > a.indexOf('pac-lmeta'), 'in the meta line');
  const b = rowHtml(D.rows(), 'b');
  assert.deepEqual(chipsOf(b), ['prayer'], 'the Bible row claims ONLY its scope: the general notebook\'s tag is not its');
  assert.doesNotMatch(b, /\+\d/);
  assert.deepEqual(chipsOf(rowHtml(D.rows(), 'c')), [], 'no doc, no chips');
  assert.match(a, /<button type="button" class="pac-ltag" data-tag="ores">#ores<\/button>/, 'a chip shows the word with its #');
});

test('the strip under the empty box holds the top 8 tags by page count, and leaves while the box has text', async () => {
  const D = await drawer();
  const s = D.strip();
  assert.ok(s, 'the strip sits in the search block');
  assert.deepEqual(chipsOf(s.innerHTML), ['rent', 'todo', 'chapter', 'ores', 'prayer', 'roof', 'vv', 'ww'], 'TYPED counts: rent and todo (2 typed pages each; todo\'s ink page on entry-1 p0 does not count, so it no longer leads) first, then ties by name, eight in all — scrawl (ink on 3 pages) never');
  await D.type('roof');
  assert.equal(s.innerHTML, '', 'a query replaces the strip');
  await D.type('');
  assert.deepEqual(chipsOf(s.innerHTML).length, 8, 'cleared: the strip is back');
  // The × beside the box (owner, 2026-11-10): hidden while empty, shown with text, one tap clears and brings the strip back.
  const x = D.el('.pac-qx');
  assert.equal(x.hidden, true, 'no text, no ×');
  await D.type('#todo'); assert.equal(x.hidden, false);
  for (const fn of x.on.click || []) fn();
  assert.equal(D.box(), ''); assert.equal(x.hidden, true); assert.deepEqual(chipsOf(s.innerHTML).length, 8, 'the × clears the tag and the strip returns');
});

test('tapping a chip puts #word in the box and runs the existing search; the row under it does not open', async () => {
  const D = await drawer();
  const ev = D.tap('灵修');
  assert.equal(D.box(), '#灵修');
  assert.equal(ev.stopped, true, 'the chip listener stopped the row-click listener behind it');
  await tick(SETTLE_MS);
  assert.deepEqual(D.searched, ['#灵修'], 'PANote.search got the tag query through the drawer\'s own path (tag-only matching lives in the node)');
  assert.equal(D.strip().innerHTML, '', 'the box now has text: no strip');
  D.tap('rent', D.strip());
  assert.equal(D.box(), '#rent', 'a strip chip does the same');
  // The × must offer itself after a CHIP tap too, not only after typing (owner, 2026-11-10: "clear the tags").
  const x = D.el('.pac-qx');
  assert.equal(x.hidden, false, 'a chip tap shows the ×');
  for (const fn of x.on.click || []) fn();
  assert.equal(D.box(), '', 'the × clears the chip-set tag');
  assert.equal(x.hidden, true);
});

test('CONTROL: without the component the drawer draws as before; a failed or absent tags reply leaves the list standing with no chips', async () => {
  const P = await drawer({ component: false });
  assert.deepEqual(ids(P.rows()), ['a', 'b', 'c']);
  assert.doesNotMatch(P.rows(), /pac-ltag/);
  assert.equal(P.strip(), undefined, 'no strip element at all');
  assert.deepEqual(P.fetched, [], 'nothing asked');
  const noDoc = await drawer({ items: () => rows().map(({ doc, ...r }) => r) });
  assert.deepEqual(noDoc.fetched, [], 'a list whose rows carry no doc never asks the node (chat-only drawers)');
  const F = await drawer({ fetch: async () => ({ ok: false, error: 'Signed out', code: 'unauthorized' }) });
  assert.deepEqual(ids(F.rows()), ['a', 'b', 'c']); assert.doesNotMatch(F.rows(), /pac-ltag/); assert.equal(F.strip().innerHTML, '');
  const T = await drawer({ fetch: async () => { throw new Error('network'); } });
  assert.deepEqual(ids(T.rows()), ['a', 'b', 'c'], 'a throw is a failure too, never an unhandled rejection');
});

test('long-press on a strip chip hides the tag (prefs hiddenTags, no search); the ⋯ sheet offers Show hidden · 显示隐藏 only then, and restores; a released press hides nothing', async () => {
  const D = await drawer();
  const before = chipsOf(D.strip().innerHTML);
  assert.ok(before.includes('todo'));
  D.press('todo'); D.press('todo', 'pointerup');
  D.timers.fire();
  assert.deepEqual(chipsOf(D.strip().innerHTML), before, 'a press released before the hold is a tap, not a hide');
  assert.equal(D.timers.q.length, 0, 'and its timer was cleared');
  const labels0 = await pickMore(D.d, '');
  assert.ok(!labels0.some((l) => l.startsWith('Show hidden')), 'nothing hidden: no entry');
  D.press('todo'); D.timers.fire();   // held past LONG_PRESS_MS
  assert.deepEqual(chipsOf(D.strip().innerHTML), ['rent', 'chapter', 'ores', 'prayer', 'roof', 'vv', 'ww', 'xx'], 'todo left the strip; the next typed tag by name (xx) filled the eighth place');
  const ev = D.tap('todo', D.strip());
  assert.equal(ev.stopped, true); assert.equal(D.box(), '', 'the click that follows the release is swallowed: no #todo search');
  assert.deepEqual(D.searched, [], 'nothing was searched by the press');
  assert.match(rowHtml(D.rows(), 'a'), /data-tag="todo"/, 'a hidden tag stays on its row chips (and searchable)');
  await tick(5);   // the write leaves once the chain reaches it (after the prefs read's answer)
  const pref = D.sent.filter((m) => m.kind === 'set-app-settings').pop();
  assert.deepEqual(pref && pref.prefs, { hiddenTags: ['todo'] }, 'remembered in the app prefs through the drawer\'s prefs hook (set-app-settings carries the merged object)');
  const labels = await pickMore(D.d, 'Show hidden');
  assert.ok(labels.includes('Show hidden · 显示隐藏 (1)'), labels.join(' | '));
  assert.deepEqual(chipsOf(D.strip().innerHTML), before, 'shown again');
  assert.deepEqual(D.sent.filter((m) => m.kind === 'set-app-settings').pop().prefs, { hiddenTags: [] });
});

test('after a long-press hide the NEXT tap is not swallowed: a new press clears the held tag (a touch long-press may end with no click), and a row chip never consults it', async () => {
  const D = await drawer();
  D.press('todo'); D.timers.fire();   // hidden — and, as on a touch screen whose long-press ends in no click, nothing follows
  D.searched.length = 0;
  assert.equal(D.tap('todo').stopped, true); assert.equal(D.box(), '#todo', 'a ROW chip of the hidden tag searches at once');
  D.box.value = ''; D.el('.pac-q').value = '';
  await pickMore(D.d, 'Show hidden');
  D.press('todo'); D.press('todo', 'pointerup');   // a plain tap on the restored chip: press, release, click
  D.tap('todo', D.strip());
  assert.equal(D.box(), '#todo', 'the tap after the hide runs its search; it is not eaten by the stale hold');
  D.el('.pac-q').value = '';
  D.press('rent'); D.timers.fire();                // hide rent; the click that follows the release is the one swallowed
  D.tap('rent', D.strip()); assert.equal(D.box(), '', 'the release click after the hold is swallowed');
  D.tap('rent', D.strip()); assert.equal(D.box(), '#rent', 'only once: the next tap on the same tag goes through');
});

test('the component alone: a stored hiddenTags list applies from the first draw; a reply without typedTags (older node) lists its tags; a refused save keeps the session list', async () => {
  const src = TAGS_HTML.slice(TAGS_HTML.indexOf('>', TAGS_HTML.indexOf('<script id="pdt-script">')) + 1, TAGS_HTML.indexOf('</script>', TAGS_HTML.indexOf('<script id="pdt-script">')));
  const win = { PANoteText: { fetch: async () => ({ ok: true, pages: PAGES.map(({ typedTags, ...p }) => p) }) } };
  const timers = fakeTimers();
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'setTimeout', 'clearTimeout', src)(win, { createElement: mkEl }, timers.setTimeout, timers.clearTimeout);
  const search = mkEl('div'); search.querySelector = () => search; search.children = []; search.appendChild = (k) => { search.children.push(k); return k; };
  const host = mkEl('div'); host.querySelector = () => search;
  const writes = []; let stored = { hiddenTags: ['rent', 'zz'] };
  const T = win.PADrawerTags.attach({ host, rows: mkEl('div'), box: mkEl('input'), items: () => [], sameDoc: () => false, search: () => {}, redraw: () => {},
    prefs: { get: () => stored, set: async (p) => { writes.push(p); return { ok: false, error: 'read-only' }; } } });
  assert.deepEqual(T.hidden(), ['rent', 'zz'], 'read from the stored prefs');
  await T.refresh();
  const strip = search.children[0];
  assert.deepEqual(chipsOf(strip.innerHTML), ['scrawl', 'todo', 'chapter', 'ores', 'prayer', 'roof', 'vv', 'ww'], 'no typedTags in the reply: every tag counts (scrawl, 3 pages, leads); rent and zz stay hidden');
  const warned = []; const w = console.warn; console.warn = (...a) => warned.push(a);
  try { T.hide('todo'); await tick(5); } finally { console.warn = w; }
  assert.deepEqual(writes, [{ hiddenTags: ['rent', 'zz', 'todo'] }]);
  assert.deepEqual(T.hidden(), ['rent', 'zz', 'todo'], 'the refused save keeps this session\'s list (a strip preference is not reverted under the finger)');
  assert.equal(warned.length, 1, 'and says so once (R5)');
  assert.doesNotMatch(strip.innerHTML, /data-tag="todo"/);
});

test('pins: chat-ui carries the marker (the groups marker is appended after it), web.mjs inlines the component after chat-ui, the chip listener is registered before the row-click one', () => {
  assert.ok(CHAT.trimEnd().endsWith('<!--PA_DRAWER_TAGS_UI-->\n<!--PA_DRAWER_GROUPS_UI-->\n<!--PA_APP_PREFS_UI-->\n<!--PA_TIPS_UI-->'), 'the markers end chat-ui, so the components follow its script');
  const comps = WEB.slice(WEB.indexOf('const PA_COMPONENTS = ['), WEB.indexOf('];', WEB.indexOf('const PA_COMPONENTS = [')));
  assert.ok(comps.indexOf("file: 'drawer-tags.inline.html'") > comps.indexOf("file: 'chat-ui.inline.html'"), 'registered after chat-ui (the loop re-tests the inlined html)');
  assert.match(comps, /marker: '<!--PA_DRAWER_TAGS_UI-->', file: 'drawer-tags\.inline\.html'/);
  assert.ok(CHAT.indexOf('window.PADrawerTags.attach({host,rows,') < CHAT.indexOf("rows.addEventListener('click',e=>{"), 'attach (and its rows click listener) comes first');
  assert.match(CHAT, /\(tags\?tags\.chips\(it\):''\)/, 'the row html asks the component for its chips');
});
