// Bookmarks（书签, docs/plans/note-features.md D, H) in the shared drawer: PAChat is RUN (helpers-stationery
// loadChatUi) with the real tag-strip component (web/drawer-tags.inline.html) on its window. A row
// with `pin:true` shows ★ before its title (the filled --pac-star of web/drawer-groups.inline.html);
// the ⋯ sheet offers Bookmark/Unbookmark only on a row with an onPin and calls it with the right flag.
// The strip carries NO ★ chip any more (owner 2026-11-11: the Bookmarked · 收藏 group replaces it —
// test/drawer-groups.test.mjs drives the group). CONTROL rows (no onPin, nothing pinned) draw as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CHAT } from './helpers-app.mjs';
import { WHERE, tick, ids } from './helpers-drawer-search.mjs';
import { loadChatUi } from './helpers-stationery.mjs';

const TAGS_HTML = fs.readFileSync(path.join(ROOT, 'web', 'drawer-tags.inline.html'), 'utf8');
const rows = () => [
  { id: 'a', title: 'Roof', preview: 'typed', updated: 3, pin: true, doc: { path: 'entry-1.json' } },
  { id: 'b', title: 'Bible', preview: 'verse', updated: 2, doc: { path: 'notes/43-3.json', scope: 'v16' } },
  { id: 'c', title: 'Rent', preview: 'roof again', updated: 1, pin: true },
];
const mkWin = () => ({ PANote: { SEARCH_TXT: WHERE, search: async () => ({ ok: true, hits: [] }) } });
const rowHtml = (html, id) => { const i = html.indexOf(`data-id="${id}"`); const j = html.indexOf('pac-lrow', i + 1); return j < 0 ? html.slice(i) : html.slice(i, j); };

// One listDrawer with the component on the page. No PANoteText: the tag strip has nothing to ask.
async function drawer({ items = rows, onPin } = {}) {
  const win = mkWin();
  const src = TAGS_HTML.slice(TAGS_HTML.indexOf('>', TAGS_HTML.indexOf('<script id="pdt-script">')) + 1, TAGS_HTML.indexOf('</script>', TAGS_HTML.indexOf('<script id="pdt-script">')));
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(win, { createElement: (t) => mkEl(t) });
  const { PAChat } = loadChatUi({ win });
  const d = PAChat.listDrawer({ title: 'Notes', items: async () => items(), onOpen: () => {}, onPin });
  await d.refresh(); await tick(5);
  const el = (s) => d.el.querySelector(s);
  const strip = () => el('.pac-lsearch').children.find((k) => k.className === 'pac-ltags');
  return { d, strip, rows: () => el('.pac-lrows').innerHTML, el };
}
function mkEl(tag) { const on = {}; return { tagName: String(tag).toUpperCase(), className: '', innerHTML: '', on, children: [], appendChild(k) { this.children.push(k); return k; }, addEventListener: (t, fn) => (on[t] ||= []).push(fn) }; }

test('a pinned row shows ★ before its title; an unpinned one does not; the strip shows no ★ chip (the group is the one way)', async () => {
  const D = await drawer({ onPin: () => {} });
  assert.match(rowHtml(D.rows(), 'a'), /<div class="pac-lttl"><span class="pac-lstar" aria-label="已收藏 · Bookmarked">★<\/span> Roof<\/div>/);
  assert.doesNotMatch(rowHtml(D.rows(), 'b'), /pac-lstar/);
  assert.match(rowHtml(D.rows(), 'c'), /★<\/span> Rent/, 'a row without doc can be pinned too (the flag is the host\'s, not the index\'s)');
  assert.equal(D.strip().innerHTML, '', 'no tags asked, no chips — and no ★ chip while rows are pinned');
  assert.doesNotMatch(TAGS_HTML, /pac-lpin|data-pin|pinChip|keep\(/, 'the strip\'s ★ filter is gone from the component (R3: one bookmark view)');
  assert.doesNotMatch(CHAT, /tags\.keep\(/, 'and the drawer no longer asks the strip for a row filter');
});

test('listDrawer: the ⋯ on a row → the sheet → Bookmark calls the host\'s onPin(id, true); a row whose only action is onPin still gets its ⋯', async () => {
  const calls = [];
  const D = await drawer({ items: rows, onPin: async (id, f) => calls.push([id, f]) });
  assert.match(rowHtml(D.rows(), 'b'), /data-menu="b"/);
  const mb = { dataset: { menu: 'b' }, getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0 }) };
  // pacSheet places an anchored sheet by the browser's bare innerWidth/innerHeight globals.
  Object.assign(globalThis, { innerWidth: 390, innerHeight: 844 });
  try { for (const fn of D.el('.pac-lrows').on.click || []) fn({ target: { closest: (s) => (s === '[data-menu]' ? mb : null) }, stopPropagation() {} }); await tick(5); }
  finally { delete globalThis.innerWidth; delete globalThis.innerHeight; }
  const sheet = D.d.el.children.filter((k) => /^pac-modal/.test(k.className)).pop();
  assert.ok(sheet, 'the sheet opened in the drawer host');
  const btn = sheet.children[0].children.find((k) => k.textContent === '收藏 · Bookmark');
  assert.ok(btn, 'offered on an unpinned row with an onPin');
  sheet.remove = () => {};   // the harness element has no remove(); the sheet closes itself on a pick
  btn.onclick(); await tick(5);
  assert.deepEqual(calls, [['b', true]], 'the id-bound hook, with the flag the sheet promised');
});

// ── the ⋯ sheet, RUN (the same extraction test/note-chat-delete.test.mjs uses) ─────────────────
function menuModule() {
  const src = /async function rowMenu\(id,anchor\)\{[\s\S]*?\n    \}/.exec(CHAT);
  assert.ok(src, 'rowMenu must be extractable');
  return (item, choose) => {
    let offered = null;
    const it = Object.assign({ id: 'n1', title: 'Note' }, item);
    const api = new Function('itemOf', 'pacSheet', 'pacPrompt', 'pacConfirm', 'host', 'refresh', `${src[0]}\n      return rowMenu;`)(
      () => it, async (_h, labels) => { offered = labels.map((l) => l.label); return choose(offered); }, async () => null, async () => false, {}, async () => {});
    return api('n1').then(() => offered);
  };
}

test('the ⋯ sheet: Bookmark on an unpinned row calls onPin(true); Unbookmark on a pinned row calls onPin(false); after Rename, never destructive', async () => {
  const run = menuModule();
  const got = [];
  const offered = await run({ onRename: async () => {}, onDelete: async () => got.push('DELETED'), onPin: async (f) => got.push(f) }, (labels) => labels.indexOf('收藏 · Bookmark'));
  assert.deepEqual(offered, ['重命名 · Rename', '收藏 · Bookmark', '删除 · Delete']);
  assert.deepEqual(got, [true]);
  const again = await run({ pin: true, onPin: async (f) => got.push(f) }, (labels) => labels.indexOf('取消收藏 · Unbookmark'));
  assert.deepEqual(again, ['取消收藏 · Unbookmark'], 'the label reads the row\'s own flag');
  assert.deepEqual(got, [true, false]);
});

test('CONTROL: a row without onPin is offered no bookmark entry, and a list with nothing pinned shows no ★ and no ⋯ for a plain row', async () => {
  const run = menuModule();
  assert.deepEqual(await run({ onRename: async () => {}, onDelete: async () => {} }, () => -1), ['重命名 · Rename', '删除 · Delete']);
  assert.deepEqual(await run({ pin: true, onRename: async () => {} }, () => -1), ['重命名 · Rename'], 'pinned by data but no hook: the sheet cannot promise a toggle it has no way to make');
  const D = await drawer({ items: () => rows().map(({ pin, ...r }) => r) });
  assert.equal(D.strip().innerHTML, '');
  assert.doesNotMatch(D.rows(), /pac-lstar|data-menu/);
  assert.deepEqual(ids(D.rows()), ['a', 'b', 'c']);
});

test('pins: the chat-side list forwards pin and onPin from the host\'s augment row, as it does onRename', () => {
  assert.match(CHAT, /tab:'notes', doc:n\.doc, pin:!!n\.pin,\n\s+onOpen:n\.onClick, onRename:n\.onRename, onDelete:n\.onDelete, onDeleteAi:n\.onDeleteAi, onPin:n\.onPin \}\);/);
  assert.match(CHAT, /onPin:o\.onPin\?\(f\)=>o\.onPin\(it\.id,f\):undefined,/, 'listDrawer');
});

// Owner 2026-11-11: a summary saved before the human titles still reads "Summary · 总结 2026-W46" in the list.
test('a saved summary row with the raw W title shows its human title (display only); other rows are untouched (CONTROL)', async () => {
  const { loadTitle } = await import('./helpers-summary.mjs');
  const win = mkWin(); win.PA_SUMMARY_NOW = new Date(2026, 10, 11, 12, 0, 0).getTime(); loadTitle(win);
  const { PAChat } = loadChatUi({ win });
  const items = [{ id: 's', title: 'Summary · 总结 2026-W46', preview: 'p', updated: 2 }, { id: 'r', title: 'Roof', preview: 'q', updated: 1 }];
  const d = PAChat.listDrawer({ title: 'Notes', items: async () => items, onOpen: () => {} });
  await d.refresh(); await tick(5);
  const html = d.el.querySelector('.pac-lrows').innerHTML;
  assert.match(rowHtml(html, 's'), /<div class="pac-lttl">本周 · This week Nov 9–15, 2026<\/div>/);
  assert.match(rowHtml(html, 'r'), /<div class="pac-lttl">Roof<\/div>/);
  assert.equal(items[0].title, 'Summary · 总结 2026-W46', 'the stored title is not rewritten');
});
