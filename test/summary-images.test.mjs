// web/summary-images.inline.html — PASummaryImages: the pages a period summary sends as pictures (ADR 0027,
// docs/plans/note-features.md I). The shipped script is RUN (helpers-summary loadImages): the pick (important
// ink only, newest row first, the cap), the lane preference (the first served claude, then codex, else the
// current lane; vision from /api/models), the confirm-line words; then the real drawer-summary over the real
// chat-ui (the drawer-summary harness) — the line says the images and the lane, Send renders them through the
// broker kind and hands `images` + `model` + the trust-the-image sentence to the host's run, a lane without
// vision sends text only and says so, a render failure stops the send and is said. Pins: the attachment wiring
// in chat-ui (send(text,{attachments,model}) reaches the posted `chat` request), PAChat.lanes, the hosts' run
// hooks (live = template), the cap equal to the lib's, /api/models publishing provider + vision.
// R11 — searched: "PASummaryImages", "page images", "SUMMARY_LANE_PREF", "attachments:images", "YEAR_KEYS" — no duplicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { WHERE, tick } from './helpers-drawer-search.mjs';
import { loadChatUi } from './helpers-stationery.mjs';
import { loadRefs, loadImages, loadFollowup } from './helpers-summary.mjs';
import { PAGE_IMAGES_MAX } from '../lib/note-page-image.mjs';

const SUM_HTML = fs.readFileSync(path.join(ROOT, 'web', 'drawer-summary.inline.html'), 'utf8');
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
const CHAT_SRC = fs.readFileSync(path.join(ROOT, 'web', 'chat-ui.inline.html'), 'utf8');
const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime();
const at = (y, m, d) => new Date(y, m - 1, d, 9, 0, 0).getTime();
const LANES = [{ id: 'deepseek', label: 'DeepSeek', group: 'Fast', provider: 'ollama', vision: false }, { id: 'glmflash', label: 'GLM Flash', group: 'Fast', provider: 'ollama', vision: true },
  { id: 'gpt', label: 'GPT (Codex)', group: 'Agent', provider: 'codex', vision: true }, { id: 'claude', label: 'Claude', group: 'Agent', provider: 'claude', vision: true }];
const rows = () => [
  { id: 'a', title: 'Roof', created: at(2026, 11, 9), doc: { path: 'entry-a.json' } },
  { id: 'b', title: 'Rent', created: at(2026, 11, 2), doc: { path: 'entry-b.json' } },
  { id: 'f', title: 'A chat', created: at(2026, 11, 9) },
];
const PAGES = [
  { path: 'entry-a.json', scope: '', page: 1, src: { typed: '', ink: 'call #landlord', photo: '' }, important: ['call #landlord'], inkImportant: true },
  { path: 'entry-a.json', scope: '', page: 0, src: { typed: 'Rain on the roof', ink: 'fix gutter', photo: '' }, important: [], inkImportant: false },
  { path: 'entry-b.json', scope: '', page: 0, src: { typed: 'Rent paid', ink: 'FDE', photo: '' }, important: ['FDE'], inkImportant: true },
  { path: 'entry-x.json', scope: '', page: 0, src: { typed: 'not in the rows', ink: 'x', photo: '' }, important: ['x'], inkImportant: true },
];
function mkEl(tag) { const on = {}, kids = []; return { tagName: String(tag).toUpperCase(), className: '', innerHTML: '', textContent: '', disabled: false, checked: false, on, children: kids,
  appendChild(k) { kids.push(k); return k; }, addEventListener: (t, fn) => (on[t] ||= []).push(fn), setAttribute(k, v) { this['@' + k] = v; }, remove() { this.removed = true; } }; }

test('pick: important ink only, among the rows\' files, newest row first then page order, capped at PAGE_IMAGES_MAX (= the lib\'s); plan words the line', () => {
  const win = { PAChat: { lanes: () => LANES, lane: () => ({ id: 'deepseek', label: 'DeepSeek' }) } };
  const I = loadImages(win);
  assert.equal(I.PAGE_IMAGES_MAX, PAGE_IMAGES_MAX, 'the client copy equals lib/note-page-image.mjs (R3 across the sandbox boundary)');
  assert.deepEqual(I.pick(PAGES, rows()), { pages: [{ path: 'entry-a.json', scope: '', page: 1, ts: at(2026, 11, 9) }, { path: 'entry-b.json', scope: '', page: 0, ts: at(2026, 11, 2) }], total: 2 }, 'a\'s page 0 has no marked ink; entry-x is not a row');
  const many = Array.from({ length: 9 }, (_, i) => ({ path: 'entry-a.json', scope: '', page: 8 - i, inkImportant: true }));
  const p = I.pick(many, rows()); assert.equal(p.pages.length, PAGE_IMAGES_MAX); assert.equal(p.total, 9); assert.deepEqual(p.pages.map((x) => x.page), [0, 1, 2, 3, 4, 5], 'page order inside a row');
  assert.deepEqual(I.plan({ pages: PAGES, rows: rows() }).line, ' · 2 页图片 · 2 page images');
  assert.deepEqual(I.plan({ pages: many, rows: rows() }).line, ' · 6 页图片 · 6 page images (最多 6 · max 6)', 'the cap is said when it bit');
  assert.deepEqual(I.plan({ pages: [], rows: rows() }), { pages: [], total: 0, lane: { id: 'claude', label: 'Claude', vision: true }, line: '' }, 'nothing to picture: nothing said');
  assert.deepEqual(I.pick(null, null), { pages: [], total: 0 });
  assert.deepEqual(I.YEAR_KEYS, ['year', 'lastYear']);
  for (const key of I.YEAR_KEYS) assert.deepEqual(I.plan({ pages: many, rows: rows(), key }), { pages: [], total: 0, lane: { id: 'claude', label: 'Claude', vision: true }, line: '' }, key + ': a whole-year scope sends no page images (the payload is bounded)');
  assert.equal(I.plan({ pages: many, rows: rows(), key: 'lastMonth' }).pages.length, PAGE_IMAGES_MAX, 'a month scope still does');
});

test('lane: the first served preferred provider (claude before codex, whatever the list order); else the current lane, which may lack vision → text only, said', () => {
  const cur = { id: 'deepseek', label: 'DeepSeek' };
  const mk = (lanes, lane = cur) => loadImages({ PAChat: { lanes: () => lanes, lane: () => lane } });
  assert.deepEqual(mk(LANES).lane(), { id: 'claude', label: 'Claude', vision: true });
  assert.deepEqual(mk(LANES.filter((l) => l.id !== 'claude')).lane(), { id: 'gpt', label: 'GPT (Codex)', vision: true }, 'Claude not served: Codex');
  assert.deepEqual(mk(LANES.slice(0, 2)).lane(), { id: 'deepseek', label: 'DeepSeek', vision: false }, 'no agent lane: the current one, no vision');
  assert.deepEqual(mk(LANES.slice(0, 2), { id: 'glmflash', label: 'GLM Flash' }).lane(), { id: 'glmflash', label: 'GLM Flash', vision: true }, 'the vision default is an Ollama lane that sees');
  assert.equal(mk([], null).lane(), null, 'no lanes at all');
  const I = mk(LANES.slice(0, 1));
  assert.deepEqual(I.plan({ pages: PAGES, rows: rows() }), { pages: [], total: 2, lane: { id: 'deepseek', label: 'DeepSeek', vision: false }, line: ' · DeepSeek 无法看图 · DeepSeek cannot see images — 仅发送文字 · text only' }, 'no pages are fetched for a lane that cannot see them');
  assert.deepEqual(I.SUMMARY_LANE_PREF, ['claude', 'codex']);
  assert.match(I.PROMPT, /trust the image\. · .*以图片为准。$/);
});

test('fetch: one broker ask per page, the file names as the rail\'s attachments; the first failure fails the whole set (R5); no broker is said', async () => {
  const asks = [];
  const win = { PAStore: { ask: async (m) => { asks.push(m); return m.page === 9 ? { ok: false, code: 'no_ink', error: 'no ink on this page' } : { ok: true, path: `uploads/pages/notes_abc_p${m.page}.png`, bytes: 10 }; } } };
  const I = loadImages(win);
  assert.deepEqual(await I.fetch([{ path: 'entry-a.json', scope: '', page: 1 }, { path: 'n.json', scope: 'v16', page: 0 }]), { ok: true, images: [{ name: 'notes_abc_p1.png', path: 'uploads/pages/notes_abc_p1.png' }, { name: 'notes_abc_p0.png', path: 'uploads/pages/notes_abc_p0.png' }] });
  assert.deepEqual(asks, [{ kind: 'note-page-image', path: 'entry-a.json', scope: '', page: 1 }, { kind: 'note-page-image', path: 'n.json', scope: 'v16', page: 0 }]);
  const f = await I.fetch([{ path: 'a', page: 0 }, { path: 'a', page: 9 }, { path: 'a', page: 2 }]);
  assert.equal(f.ok, false); assert.equal(f.error, 'no ink on this page'); assert.equal(asks.length, 4, 'stopped at the failure');
  assert.deepEqual(await loadImages({}).fetch([{ path: 'a', page: 0 }]), { ok: false, images: [], error: '无通道 · no broker' });
  assert.deepEqual(await I.fetch([]), { ok: true, images: [] });
});

// ── drawer-summary over the real chat-ui, with the images and follow-up parts on the window (the page's order) ──
async function drawer({ lanes = LANES, ask = async (m) => ({ ok: true, path: `uploads/pages/notes_h_p${m.page}.png` }), run = async () => true, posted = [] } = {}) {
  const calls = { run: [], asks: [] }; const listeners = [];
  const win = { PA_SUMMARY_NOW: NOW, PANote: { SEARCH_TXT: WHERE, search: async () => ({ ok: true, hits: [] }), mdToHtml: (t) => '<p>' + t + '</p>' },
    PANoteText: { fetch: async () => ({ ok: true, pages: PAGES }) }, PAStore: { ask: async (m) => { calls.asks.push(m); return ask(m); } },
    addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); } };
  const { PAChat, window, body } = loadChatUi({ win, parent: { postMessage: (m) => posted.push(m) } });
  for (const fn of listeners) fn({ data: { pa: 'prefs', models: lanes } });   // the shell's prefs: the served lanes with their vision flag
  loadRefs(window, { createElement: mkEl }); loadImages(window); loadFollowup(window, { createElement: mkEl });
  const src = SUM_HTML.slice(SUM_HTML.indexOf('>', SUM_HTML.indexOf('<script id="pds-script">')) + 1, SUM_HTML.indexOf('</script>', SUM_HTML.indexOf('<script id="pds-script">')));
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(window, { createElement: mkEl });
  let api = null; const real = window.PADrawerSummary.attach; window.PADrawerSummary.attach = (c) => (api = real(c));
  const d = PAChat.listDrawer({ title: 'Notes', items: async () => rows(), onOpen: () => {}, onDelete: async () => {}, summary: { run: async (t) => { calls.run.push(t); return run(t); }, saveNote: async () => ({ ok: true }), onLink() {} } });
  await d.refresh(); await tick(5);
  return { PAChat, window, body, calls, reply: (m) => { for (const fn of listeners) fn({ data: m }); }, api: () => api, line: () => api.el.children[0].children.find((k) => k.className === 'pds-line').textContent };
}

test('the sheet: the line names the preferred agent lane and the page images; Send renders them through `note-page-image`, adds the trust-the-image sentence to the prompt and hands images + model to the host\'s run', async () => {
  const D = await drawer();
  await D.api().open(); await D.api().choose('month');
  assert.equal(D.line(), '发送 3 页 · 55 字到 Claude · Send 3 pages · 55 characters to Claude (离开本机 · off this Mac) · 2 页图片 · 2 page images', 'Claude, though the chooser\'s current lane is the first in the list (DeepSeek)');
  assert.equal(D.PAChat.lane().id, 'deepseek', 'the chooser itself is untouched');
  assert.equal(await D.api().send(), true);
  assert.deepEqual(D.calls.asks, [{ kind: 'note-page-image', path: 'entry-a.json', scope: '', page: 1 }, { kind: 'note-page-image', path: 'entry-b.json', scope: '', page: 0 }], 'newest row first');
  const t = D.calls.run[0];
  assert.equal(t.model, 'claude'); assert.equal(t.scope, 'summary:2026-11');
  assert.deepEqual(t.images, [{ name: 'notes_h_p1.png', path: 'uploads/pages/notes_h_p1.png' }, { name: 'notes_h_p0.png', path: 'uploads/pages/notes_h_p0.png' }]);
  assert.equal(t.message.startsWith(D.window.PADrawerSummary.SUMMARY_PROMPT + ' ' + D.window.PASummaryImages.PROMPT + '\n\n## 2026-11-02'), true, 'the sentence joins the prompt, before the notes');
  assert.match(D.window.PADrawerSummary.SUMMARY_PROMPT, /under the heading "待办 · Open to-dos"/, 'the prompt names the to-do heading the node extracts (ADR 0027)');
});

test('CONTROL: a lane without vision → text only, said on the line, no render asked, no images, no model override; a render failure stops the send and is said', async () => {
  const D = await drawer({ lanes: LANES.slice(0, 1) });
  await D.api().open(); await D.api().choose('month');
  assert.equal(D.line(), '发送 3 页 · 55 字到 DeepSeek · Send 3 pages · 55 characters to DeepSeek (离开本机 · off this Mac) · DeepSeek 无法看图 · DeepSeek cannot see images — 仅发送文字 · text only');
  assert.equal(await D.api().send(), true);
  assert.deepEqual(D.calls.asks, []); assert.deepEqual(D.calls.run[0].images, []); assert.equal(D.calls.run[0].model, 'deepseek', 'the current lane, named');
  assert.equal(D.calls.run[0].message.includes('trust the image'), false);
  const F = await drawer({ ask: async () => ({ ok: false, code: 'render_failed', error: 'EACCES' }) });
  await F.api().open(); await F.api().choose('month');
  assert.equal(await F.api().send(), false);
  assert.equal(F.line(), '页图片失败 · Page images failed — EACCES'); assert.deepEqual(F.calls.run, [], 'nothing sent without its pictures (R5)');
  assert.equal(F.api().state().busy, false, 'a retry stays possible');
});

test('chat-ui wiring: send(text,{attachments,model}) posts the host\'s files and lane on the `chat` request, keeps the composer\'s chips; PAChat.lanes carries provider + vision', async () => {
  const posted = [];
  const { PAChat, body, reply } = await drawer({ posted });
  assert.deepEqual(PAChat.lanes().map((l) => [l.id, l.provider, l.vision]), LANES.map((l) => [l.id, l.provider, l.vision]));
  const chat = PAChat.mount(body, {});   // a second surface on the same page (the harness mounted one at load)
  chat.attach({ name: 'mine.jpg', path: 'uploads/1_mine.jpg' });   // a chip the user picked
  const p = chat.send('summarise', { attachments: [{ name: 'notes_h_p1.png', path: 'uploads/pages/notes_h_p1.png' }], model: 'claude' });
  await tick(2);
  const req = posted.find((m) => m && m.kind === 'chat');
  assert.ok(req, 'a chat request was posted');
  assert.deepEqual(req.attachments, [{ name: 'notes_h_p1.png', path: 'uploads/pages/notes_h_p1.png' }], 'the host\'s files, not the composer\'s chip');
  assert.equal(req.model, 'claude', 'the per-turn lane, not the chooser\'s');
  assert.match(req.message, /^summarise\n\n\[Attached file: notes_h_p1\.png — saved to workspace\/uploads\/pages\/notes_h_p1\.png\. Use the Read tool to view it\.\]$/, 'named for the agent lane as any attachment is');
  reply({ pa: 'res', id: req.id, done: true, ok: true, text: 'ok' });   // the shell's answer: the turn ends and its elapsed-time timer stops
  assert.equal(await p, true);
  assert.match(CHAT_SRC, /const reqChat=\(message,convoId,onEvent,attachments,label,system,assess,oneShot,onId,model\)=>/, 'reqChat\'s tenth parameter');
  assert.match(CHAT_SRC, /model:model\|\|PAC_CURMODEL\|\|undefined/, 'falls back to the chooser');
});

test('pins: the hosts\' run hooks hand images + model to send (live = template), the markers sit before drawer-summary\'s script, /api/models publishes provider + vision, note-text carries inkImportant', () => {
  const notes = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const NOTES_RUN = "run:async({scope,message,images,model})=>{ if(!await openAsk(scope)) return false; const r=await railChat.send(message,{attachments:images||[],model}); syncDrawer(); return r; },";
  for (const f of ['workspace/apps/notes/index.html', 'workspace.example/apps/notes/index.html']) assert.ok(notes(f).includes(NOTES_RUN), f);
  const BIBLE_RUN = "if(!splitOn()){ if(await aiChat.open(scope)===false) return false; return aiChat.send(message,{attachments:images||[],model}); }\n    rail.open(); rail.expand('chat'); if(await railChat.open(scope)===false) return false; return railChat.send(message,{attachments:images||[],model}); },";
  for (const f of ['workspace/apps/bible/index.html', 'workspace.example/apps/bible/index.html']) assert.ok(notes(f).includes(BIBLE_RUN), f);
  assert.ok(SUM_HTML.includes("I().plan({pages:st.pages,rows:st.rows,key:st.key})"), 'the sheet hands its preset key to the plan: year / lastYear get no images');
  assert.ok(SUM_HTML.includes("for(const k of ['selected','week','month','lastMonth','year','lastYear'])"), 'the keys PASummaryImages.YEAR_KEYS names are the sheet\'s');
  const i = SUM_HTML.indexOf('<script id="pds-script">');
  for (const m of ['<!--PA_SUMMARY_IMAGES_UI-->', '<!--PA_SUMMARY_FOLLOWUP_UI-->']) assert.ok(SUM_HTML.indexOf(m) > SUM_HTML.indexOf('<!--PA_SUMMARY_TITLE_UI-->') && SUM_HTML.indexOf(m) < i, m + ' sits after the title marker, before the script');
  assert.match(WEB, /vision: m\.provider === 'claude' \|\| m\.provider === 'codex' \|\| m\.id === cfg\.vision_default/, '/api/models: the agent lanes read files; an Ollama lane only as the vision default');
  assert.match(WEB, /provider: m\.provider \|\| ''/);
  assert.match(notes('lib/note-text.mjs'), /out\.inkImportant = \(rec\.imp && Array\.isArray\(rec\.imp\.ink\) \? rec\.imp\.ink : \[\]\)\.length > 0/);
});
