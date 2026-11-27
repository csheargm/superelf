// The drawer-search fixture, shared by test/drawer-search.test.mjs and test/drawer-search-open.test.mjs
// (R3: one fake PANote, one row set, one way to type and click). PAChat is RUN (helpers-stationery
// loadChatUi) with a fake PANote; the drawer's own code decides.
import { loadChatUi } from './helpers-stationery.mjs';

export const WHERE = { tag: '标签 · Tag', typed: '文本 · Text', ink: '手写 · Ink', photo: '图片 · Photo', failed: '搜索不可用 · Search unavailable', searching: '搜索中… · Searching…', more: '仅显示最相关的笔记 · Only the best matches are shown',
  pending: '正在识别 {n} 页 · Transcribing {n} pages', noOcr: '手写搜索需要 Mac 节点 · Handwriting search needs the Mac node', ocrFailed: '本机手写识别失败 · Handwriting transcription failed on this node' };
export const rows = () => [
  { id: 'a', title: 'Roof', preview: 'typed about the roof', updated: 3, doc: { path: 'entry-1.json' } },
  { id: 'b', title: 'Tuesday', preview: 'Handwritten note 手写笔记', updated: 2, doc: { path: 'entry-2.json' } },
  { id: 'c', title: 'Tuesday two', preview: 'no doc on this row', updated: 1 },
];
export const hit = (path, where = 'tag', snippet = '…met the #landlord about…', scope = '') => ({ path, scope, page: 0, score: 10, where, snippet });
export const tick = (ms) => new Promise((r) => setTimeout(r, ms));
export const SETTLE_MS = 400;   // > the drawer's 250 ms debounce
export const ids = (html) => [...html.matchAll(/data-id="([^"]+)"/g)].map((m) => m[1]);

// One list drawer over the rows (+ extraRows), its node search answered by `search` (null = no
// PANote on the page). `opened` records every onOpen(id, at); `click(id)` taps a row.
export async function drawer(search, extraRows, win = {}) {
  const calls = [], opened = [];
  const PANote = search ? { SEARCH_TXT: WHERE, search: async (q) => { calls.push(q); return search(q); } } : undefined;
  const { PAChat } = loadChatUi({ win: { ...(PANote ? { PANote } : {}), ...win } });
  const d = PAChat.listDrawer({ title: 'Notes', items: async () => rows().concat(extraRows || []), onOpen: (id, at) => opened.push([id, at]) });
  await d.refresh();
  const el = (s) => d.el.querySelector(s);
  const type = async (q) => { el('.pac-q').value = q; for (const fn of el('.pac-q').on.input || []) fn(); };
  const click = (id) => { for (const fn of el('.pac-lrows').on.click || []) fn({ target: { closest: (s) => (s === '.pac-lrow' ? { dataset: { id } } : null) } }); };
  return { calls, opened, type, click, rows: () => el('.pac-lrows').innerHTML, msg: () => el('.pac-lsmsg').textContent, el };
}

// The header's ONE ⋯ sheet (owner 2026-11-11: Sort, Select, Refresh, the components' entries): open it on
// drawer `d` (a listDrawer) and pick the entry whose label starts with `label` ('' = pick nothing, just
// read the labels). Returns every label the sheet offered. pacSheet places an anchored sheet by the
// browser's bare innerWidth/innerHeight globals, so they are set for the call and removed after.
export async function pickMore(d, label) {
  Object.assign(globalThis, { innerWidth: 390, innerHeight: 844 });
  try {
    d.el.querySelector('.pac-dmore').onclick(); await tick(5);
    const sheet = d.el.children.filter((k) => /^pac-modal/.test(k.className)).pop();
    const labels = sheet ? sheet.children[0].children.map((k) => k.textContent) : [];
    if (label === '') return labels;
    const btn = sheet && sheet.children[0].children.find((k) => String(k.textContent).includes(label));
    if (!btn) throw new Error('no ⋯ entry "' + label + '" among: ' + labels.join(' | '));
    btn.onclick(); await tick(5);
    return labels;
  } finally { delete globalThis.innerWidth; delete globalThis.innerHeight; }
}
