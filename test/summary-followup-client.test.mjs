// web/summary-followup.inline.html — PASummaryFollowup: the automatic research after a saved summary, on the
// client (ADR 0027, docs/plans/note-features.md I). The shipped script is RUN (helpers-summary loadFollowup) in
// the fake DOM: run() puts ONE status line in the answer's action bar, asks the broker kind `summary-followup`
// once with the answer text, appends the node's block under its heading to the saved html through the host's
// saveNote (by the id of ITS run's note, never a new one) and says added / partial / none / failed / not saved — never silent (R5). Then
// the real drawer-summary over the real chat-ui: the turn's own auto-save triggers exactly one follow-up, a
// replayed answer none; a later re-save keeps the block. The to-do heading is pinned equal to the lib's.
// R11 — searched: "PASummaryFollowup", "跟进 · Follow-up", "pds-fu", "Researching", "quiet:true" — no duplicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { WHERE, tick } from './helpers-drawer-search.mjs';
import { loadChatUi } from './helpers-stationery.mjs';
import { loadRefs, loadImages, loadFollowup } from './helpers-summary.mjs';
import { TODO_HEADING, FOLLOWUP_HEADING } from '../lib/summary-followup.mjs';

const SUM_HTML = fs.readFileSync(path.join(ROOT, 'web', 'drawer-summary.inline.html'), 'utf8');
const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime();
const at = (y, m, d) => new Date(y, m - 1, d, 9, 0, 0).getTime();
function mkEl(tag) { const on = {}, kids = []; return { tagName: String(tag).toUpperCase(), className: '', innerHTML: '', textContent: '', disabled: false, checked: false, on, children: kids,
  appendChild(k) { kids.push(k); return k; }, addEventListener: (t, fn) => (on[t] ||= []).push(fn), setAttribute(k, v) { this['@' + k] = v; }, remove() { this.removed = true; } }; }
const BLOCK = { ok: true, heading: FOLLOWUP_HEADING, text: '### Find out X\n- An answer\n- 来源 · Sources: a.com', items: [{ item: 'Find out X', kind: 'research', ok: true }], partial: false };
const status = (bar) => bar.children.find((k) => k.className === 'pds-fu');

function unit({ ask = async () => BLOCK, save = async () => ({ ok: true, id: 'n1' }) } = {}) {
  const calls = { asks: [], saved: [] };
  const win = { PAStore: { ask: async (m) => { calls.asks.push(m); return ask(m); } }, PANote: { mdToHtml: (t) => '<p>' + t.replace(/\n/g, '|') + '</p>' } };
  const F = loadFollowup(win, { createElement: mkEl }); const bar = mkEl('div');
  const hooks = { saveNote: async (o) => { calls.saved.push(o); return save(o); } };
  return { F, bar, calls, run: (o) => F.run({ answer: 'SUMMARY TEXT', html: '<div>first</div><p>body</p>', period: '2026-11', scope: 'summary:2026-11', title: 'This month', id: 'n7', convoId: 'c1', hooks, bar, ...o }) };
}

test('run: ONE status line (researching → added), one broker ask with the answer text, the block appended under the node\'s heading through saveNote (the id of its run\'s note)', async () => {
  const U = unit();
  const p = U.run();
  assert.equal(status(U.bar).textContent, '正在研究待办 · Researching to-dos'); assert.equal(status(U.bar)['@role'], 'status');
  const r = await p;
  assert.deepEqual(U.calls.asks, [{ kind: 'summary-followup', text: 'SUMMARY TEXT' }]);
  assert.equal(U.calls.saved.length, 1);
  assert.deepEqual(U.calls.saved[0], { id: 'n7', title: 'This month', html: '<div>first</div><p>body</p><h3>跟进 · Follow-up</h3><p>### Find out X|- An answer|- 来源 · Sources: a.com</p>', period: '2026-11', scope: 'summary:2026-11', convoId: 'c1', quiet: true }, 'quiet: the host writes, never opens');
  assert.equal(r.ok, true); assert.equal(r.status, '已添加跟进 · Follow-up added — 1 项待办 · 1 to-do'); assert.equal(status(U.bar).textContent, r.status);
  assert.equal(U.bar.children.filter((k) => k.className === 'pds-fu').length, 1);
});

test('said, never silent: partial, no to-dos (nothing saved), the node failing, a thrown ask, saveNote refusing, no broker', async () => {
  const P = unit({ ask: async () => ({ ...BLOCK, partial: true, items: [{ item: 'a', kind: 'research', ok: false }, { item: 'b', kind: 'personal', ok: true }] }) });
  assert.equal((await P.run()).status, '已添加跟进（部分失败） · Follow-up added (partial) — 2 项待办 · 2 to-dos'); assert.equal(P.calls.saved.length, 1, 'a partial block is saved as partial');
  const N = unit({ ask: async () => ({ ok: true, heading: FOLLOWUP_HEADING, text: '', items: [], partial: false }) });
  const n = await N.run(); assert.equal(n.ok, true); assert.equal(n.status, '没有待办 · No open to-dos'); assert.deepEqual(N.calls.saved, [], 'nothing to append: the note is left as saved');
  const E = unit({ ask: async () => ({ ok: false, code: 'server-error', error: 'research lane down' }) });
  assert.equal((await E.run()).status, '跟进失败 · Follow-up failed — research lane down');
  const T = unit({ ask: async () => { throw new Error('relay closed'); } });
  assert.equal((await T.run()).status, '跟进失败 · Follow-up failed — relay closed');
  const S = unit({ save: async () => ({ ok: false, error: 'disk full' }) });
  const s = await S.run(); assert.equal(s.ok, false); assert.equal(s.status, '跟进未保存 · Follow-up not saved — disk full');
  const G = unit({ save: async () => ({ ok: false, gone: true }) });
  const g = await G.run(); assert.equal(g.ok, false); assert.equal(g.status, '跟进未保存 · Follow-up not saved — 该总结笔记已删除 · its summary note was deleted', 'its note deleted meanwhile: said on the bar');
  const I = unit(); const i = await I.run({ id: undefined }); assert.equal(i.ok, false); assert.deepEqual(I.calls.saved, [], 'no id: nothing saved, never a new note');
  const B = loadFollowup({}, { createElement: mkEl }); const bar = mkEl('div');
  const b = await B.run({ answer: 'x', html: '', hooks: { saveNote: async () => ({ ok: true }) }, bar });
  assert.equal(b.status, '跟进失败 · Follow-up failed — 无通道 · no broker');
  assert.deepEqual(await B.run({ answer: 'x' }), { ok: false, status: '' }, 'no bar or host: nothing to say it on');
});

// ── drawer-summary over the real chat-ui: the auto-save after the turn's own answer triggers the follow-up once ──
async function drawer({ ask = async () => BLOCK } = {}) {
  const calls = { asks: [], saved: [], run: [] };
  const win = { PA_SUMMARY_NOW: NOW, PANote: { SEARCH_TXT: WHERE, search: async () => ({ ok: true, hits: [] }), mdToHtml: (t) => '<p>' + t + '</p>' },
    PANoteText: { fetch: async () => ({ ok: true, pages: [{ path: 'entry-a.json', scope: '', page: 0, src: { typed: 'Rain', ink: '', photo: '' }, important: [], inkImportant: false }] }) },
    PAStore: { ask: async (m) => { calls.asks.push(m); return ask(m); } } };
  const { PAChat, window } = loadChatUi({ win });
  loadRefs(window, { createElement: mkEl }); loadImages(window); loadFollowup(window, { createElement: mkEl });
  const src = SUM_HTML.slice(SUM_HTML.indexOf('>', SUM_HTML.indexOf('<script id="pds-script">')) + 1, SUM_HTML.indexOf('</script>', SUM_HTML.indexOf('<script id="pds-script">')));
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(window, { createElement: mkEl });
  let api = null; const real = window.PADrawerSummary.attach; window.PADrawerSummary.attach = (c) => (api = real(c));
  const hooks = { run: async (t) => { calls.run.push(t); return true; }, saveNote: async (o) => { calls.saved.push(o); return { ok: true, id: 'n1' }; }, onLink() {} };
  const d = PAChat.listDrawer({ title: 'Notes', items: async () => [{ id: 'a', title: 'Roof', created: at(2026, 11, 9), doc: { path: 'entry-a.json' } }], onOpen: () => {}, onDelete: async () => {}, summary: hooks });
  await d.refresh(); await tick(5); await api.open(); await api.choose('month'); assert.equal(await api.send(), true, 'the sheet turn ran');
  const prompt = calls.run[0].message;
  const decorate = (fresh, p = prompt) => { const bar = mkEl('div'); const b = window.PADrawerSummary.decorate(bar, `## ${TODO_HEADING}\n- Find out X`, { el: mkEl('div'), key: 'summary:2026-11', convo: () => 'c1', hooks, fresh, prompt: p }); return { bar, b }; };
  return { window, calls, decorate };
}

test('the turn\'s own auto-save runs the follow-up ONCE: second saveNote carries the block under the heading; the status sits in the bar; a tap re-save keeps the block; a replayed answer asks nothing', async () => {
  const D = await drawer();
  const { bar, b } = D.decorate(true);
  await b.pending; const f = await b.followup;
  assert.equal(f.ok, true);
  assert.deepEqual(D.calls.asks, [{ kind: 'summary-followup', text: `## ${TODO_HEADING}\n- Find out X` }], 'once, with the answer text');
  assert.equal(D.calls.saved.length, 2);
  assert.equal(D.calls.saved[0].scope, 'summary:2026-11'); assert.equal(D.calls.saved[0].id, undefined, 'the first save creates the run\'s note'); assert.equal(D.calls.saved[1].id, 'n1', 'the follow-up updates THAT note by id');
  assert.equal(D.calls.saved[1].title, D.calls.saved[0].title); assert.match(D.calls.saved[0].title, / · \d{2}\/\d{2} \d{2}:\d{2}$/, 'titled with the run time');
  assert.equal(D.calls.saved[1].html, D.calls.saved[0].html + '<h3>跟进 · Follow-up</h3><p>' + BLOCK.text + '</p>');
  assert.equal(D.calls.saved[0].quiet, undefined, 'the turn\'s own save opens the note'); assert.equal(D.calls.saved[1].quiet, true, 'the follow-up\'s save is QUIET: no open, no pad or rail move');
  assert.equal(status(bar).textContent, '已添加跟进 · Follow-up added — 1 项待办 · 1 to-do');
  assert.equal(b.textContent, '已存 · Saved');
  await b.onclick();   // a tap after the follow-up: the block stays in the note
  assert.equal(D.calls.saved.length, 3); assert.equal(D.calls.saved[2].html, D.calls.saved[1].html); assert.equal(D.calls.saved[2].id, 'n1', 'a re-save updates its own note');
  assert.equal(D.calls.asks.length, 1, 'no second follow-up');
  const R = await drawer();
  const { b: rb } = R.decorate(false);
  assert.equal(rb.pending, undefined); await rb.onclick();
  assert.deepEqual(R.calls.asks, [], 'a replayed thread\'s answer, saved by the tap: no follow-up (it ran when the turn was fresh)');
  assert.equal(R.window.PADrawerSummary.TODO_HEADING, TODO_HEADING, 'the heading the prompt names = the one lib/summary-followup.mjs extracts (R3 across the sandbox boundary)');
});

test('pins: both hosts honour {quiet:true} — the note is written, the open is skipped (live = template)', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const NOTES = ["saveNote:async({id:runId,title,html,period,convoId,quiet})=>{\n    if(runId!=null){ const old=entryById(String(runId)); return old?updateSummaryNote(old,{title,html,convoId,quiet}):{ok:false,gone:true}; }",
    "if(!quiet) await openEntry(id,null,{keepRail:true}); return {ok:true,id}; },", "if(!quiet||curId===e.id) await openEntry(e.id,null,{keepRail:true}); return {ok:true,id:e.id};"];   // the note ON the pad reloads (test/summary-research-flow.test.mjs)
  for (const f of ['workspace/apps/notes/index.html', 'workspace.example/apps/notes/index.html']) for (const h of NOTES) assert.ok(read(f).includes(h), f + ': ' + h);
  const BIBLE = ["saveNote:async({id:runId,html,period,quiet,scope})=>{", "renderDots(); if(!quiet) await openNewDrawNote(k); return {ok:true,key:k,id:`file:${bookIdx}:${chapter}:${k}`}; },"];
  for (const f of ['workspace/apps/bible/index.html', 'workspace.example/apps/bible/index.html']) for (const h of BIBLE) assert.ok(read(f).includes(h), f + ': ' + h);
});

// The node's [title](url) source links stay TAPPABLE through the REAL note engine's mdToHtml (which writes a link
// as `text (url)`): block() lifts them out and back as <a href>, http(s) only, escaped; a fallback lane is said.
const ENGINE = fs.readFileSync(path.join(ROOT, 'web', 'note-ui.inline.html'), 'utf8');
const realMd = new Function(ENGINE.slice(ENGINE.indexOf('  const SCHEMA='), ENGINE.indexOf('\n  function Note(host, opts){')) + '\nreturn mdToHtml;')();
test('block: source links render as <a href> through the real mdToHtml; a javascript: link stays text; writerFallback is said on the status line', async () => {
  const text = '### Fasting research\n- Start with one 12-hour fast a week [1].\n- 来源 · Sources: [Fasting & prayer](https://www.desiringgod.org/fasting) · [IF basics](https://www.hopkinsmedicine.org/if) · [x](javascript:alert(1))';
  const win = { PAStore: { ask: async () => ({ ...BLOCK, text, writerFallback: 'Codex' }) }, PANote: { mdToHtml: realMd } };
  const F = loadFollowup(win, { createElement: mkEl }); const bar = mkEl('div'); const saved = [];
  const r = await F.run({ answer: 'a', html: '', period: 'p', scope: 's', title: 't', id: 'n1', hooks: { saveNote: async (o) => { saved.push(o); return { ok: true }; } }, bar });
  const html = saved[0].html;
  assert.ok(html.includes('<li>来源 · Sources: <a href="https://www.desiringgod.org/fasting">Fasting &amp; prayer</a> · '), html);
  assert.ok(html.includes('<a href="https://www.hopkinsmedicine.org/if">IF basics</a>'));
  assert.equal(/href="javascript/.test(html), false, 'only http(s) is lifted'); assert.equal(/PSFLINK/.test(html), false, 'no token left behind');
  assert.equal(r.status, '已添加跟进 · Follow-up added — 1 项待办 · 1 to-do — 经 Codex · via Codex');
});
