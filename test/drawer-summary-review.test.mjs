// Review round of the period summaries（按时期总结, docs/plans/note-features.md E): the photo tick is
// remembered before the pages arrive and is dead while a send runs; the confirm line carries the
// note-text reply's own `pending` / `truncated`; a throwing host rail is said WITH its error, a bare
// false as busy; ONE system line (SYSTEM) and the inverse of titleOf (scopeOfLabel); chat-ui passes
// the thread's key to opts.system, snapshots the thread under Save as note, and gives a summary
// thread reopened from the Chats list its scope back so the button appears again. attach() stays
// under the R4 budget with the sheet hoisted into buildSheet. Same fakes as test/drawer-summary.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, CHAT } from './helpers-app.mjs';
import { WHERE, tick } from './helpers-drawer-search.mjs';
import { loadChatUi } from './helpers-stationery.mjs';
import { loadRefs } from './helpers-summary.mjs';

const SUM_HTML = fs.readFileSync(path.join(ROOT, 'web', 'drawer-summary.inline.html'), 'utf8');
const SRC = SUM_HTML.slice(SUM_HTML.indexOf('>', SUM_HTML.indexOf('<script id="pds-script">')) + 1, SUM_HTML.indexOf('</script>', SUM_HTML.indexOf('<script id="pds-script">')));
const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime();
const at = (y, m, d) => new Date(y, m - 1, d, 9, 0, 0).getTime();
const rows = () => [{ id: 'a', title: 'Roof', created: at(2026, 11, 9), doc: { path: 'entry-a.json' } }];
const PAGES = [{ path: 'entry-a.json', scope: '', page: 0, src: { typed: 'Rain', ink: '', photo: 'SLIDE' } }];
function mkEl(tag) { const on = {}, kids = []; return { tagName: String(tag).toUpperCase(), className: '', innerHTML: '', textContent: '', disabled: false, checked: false, on, children: kids,
  appendChild(k) { kids.push(k); return k; }, addEventListener: (t, fn) => (on[t] ||= []).push(fn), setAttribute(k, v) { this['@' + k] = v; }, remove() { this.removed = true; } }; }
const load = (win = {}) => { loadRefs(win, { createElement: mkEl }); new Function('window', 'document', SRC)(win, { createElement: mkEl }); return win.PADrawerSummary; };   // eslint-disable-line no-new-func

// A chat host for PAChat.mount: the stationery helper's element, with children a test can walk.
const el = (tag) => { const kids = [], qs = {}; return { tagName: tag, children: kids, style: {}, dataset: {}, className: '', value: '', classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
  appendChild: (k) => { kids.push(k); return k; }, addEventListener() {}, removeEventListener() {}, setAttribute() {}, getAttribute: () => null, querySelector: (s) => (qs[s] ||= el('div')), querySelectorAll: () => [], focus() {}, isConnected: true, remove() { this.isConnected = false; },
  getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }), get firstChild() { return kids[0] ?? null; } }; };
// chat-ui RUN against a shell stub that answers its requests: a convo load (`messages`), a turn (one done event), render-md, an empty convo list.
function chatWithShell(messages, reqs = []) {
  const listeners = [];   // chat-ui registers more than one 'message' listener; every one gets the reply
  const parent = { postMessage: (m) => { if (!m || m.pa !== 'req') return; reqs.push(m.kind === 'chat' ? 'chat:' + m.system : m.kind);   // a turn is recorded with the system line it carried
    const r = m.kind === 'convo' ? { ok: true, data: { messages } } : m.kind === 'chat' ? { done: true, ev: { type: 'done', text: 'More' } }
      : m.kind === 'render-md' ? { ok: true, html: '<p>x</p>' } : { ok: true, convos: [] };
    setTimeout(() => listeners.forEach((f) => f({ data: { pa: 'res', id: m.id, ...r } })), 0); } };
  const { PAChat, window } = loadChatUi({ win: { addEventListener: (t, f) => { if (t === 'message') listeners.push(f); } }, parent });
  load(window);
  return PAChat;
}
// The drawer with the component attached; `fetch` answers PANoteText.fetch, `run` is the host rail.
async function drawer({ fetch = async () => ({ ok: true, pages: PAGES }), run = async () => true } = {}) {
  const calls = { run: [] };
  const win = { PA_SUMMARY_NOW: NOW, PANote: { SEARCH_TXT: WHERE, search: async () => ({ ok: true, hits: [] }) }, PANoteText: { fetch } };
  const { PAChat, window } = loadChatUi({ win });
  load(window);
  let api = null; const real = window.PADrawerSummary.attach; window.PADrawerSummary.attach = (c) => (api = real(c));
  PAChat.lane = () => ({ id: 'claude', label: 'Claude' });
  const d = PAChat.listDrawer({ title: 'Notes', items: async () => rows(), onOpen: () => {}, onDelete: async () => {}, summary: { run: async (t) => { calls.run.push(t); return run(t); } } });
  await d.refresh(); await tick(5);
  const part = (cls) => api.el.children[0].children.find((k) => k.className === cls);
  return { api: () => api, calls, line: () => part('pds-line').textContent, send: () => part('pds-btns').children[1], tick: () => part('pds-tick').children[0] };
}

test('the photo tick is remembered before the pages arrive, and is dead (no re-plan, no Send) while a send runs', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  const D = await drawer({ fetch: async () => { await gate; return { ok: true, pages: PAGES }; } });
  const opening = D.api().open();
  assert.equal(D.api().togglePhoto(true), false, 'no pages yet: nothing to plan');
  assert.equal(D.api().state().photo, true, 'but the choice is kept');
  release(); await opening;
  assert.equal(D.line(), '发送 1 页 · 10 字到 Claude · Send 1 page · 10 characters to Claude (离开本机 · off this Mac)', 'planned with the photo text the tick asked for before the reply; "1 page", never "1 pages" (F3-10)');
  let done; const S = await drawer({ run: () => new Promise((r) => { done = r; }) });
  await S.api().open(); await S.api().togglePhoto(true);
  const sending = S.api().send(); await tick(2);
  assert.equal(S.tick().disabled, true, 'the tick is disabled while sending'); assert.equal(S.send().disabled, true);
  assert.equal(await S.api().togglePhoto(false), false, 'a toggle while busy re-plans nothing');
  assert.equal(S.send().disabled, true, 'and never re-enables Send'); assert.equal(S.api().state().photo, false, 'the choice is still recorded');
  done(true); assert.equal(await sending, true);
});

test('the confirm line says the reply\'s own pending pages and a cut listing (new TXT keys), and keeps them on a re-plan', async () => {
  const D = await drawer({ fetch: async () => ({ ok: true, pages: PAGES, pending: 2, truncated: true }) });
  await D.api().open();
  assert.equal(D.api().state().pending, 2); assert.equal(D.api().state().truncated, true);
  assert.equal(D.line(), '发送 1 页 · 4 字到 Claude · Send 1 page · 4 characters to Claude (离开本机 · off this Mac) · 2 页待转写 · 2 pending · 不完整 · incomplete');
  await D.api().togglePhoto(true);
  assert.match(D.line(), / · 2 页待转写 · 2 pending · 不完整 · incomplete$/, 'the photo re-plan keeps the reply\'s honesty');
  const P = await drawer({ fetch: async () => ({ ok: true, pages: PAGES, pending: 0, truncated: false }) });
  await P.api().open();
  assert.doesNotMatch(P.line(), /pending|incomplete/, 'CONTROL: nothing appended when there is nothing to say');
});

test('a host rail that throws is said with its error (R5); a bare false is the busy line; both leave a retry possible', async () => {
  const T = await drawer({ run: async () => { throw new Error('rail closed'); } });
  await T.api().open();
  assert.equal(await T.api().send(), false);
  assert.equal(T.line(), '无法发送 · Could not send — rail closed'); assert.equal(T.send().disabled, false); assert.equal(T.tick().disabled, false);
  const B = await drawer({ run: async () => false });
  await B.api().open();
  assert.equal(await B.api().send(), false); assert.equal(B.line(), '正在回答中 · Still answering');
});

test('ONE exported system line, bilingual; scopeOfLabel is the inverse of titleOf and null for any other label', () => {
  const S = load({});
  assert.equal(typeof S.SYSTEM, 'string'); assert.match(S.SYSTEM, /language the notes are written in/); assert.match(S.SYSTEM, /笔记所用的语言/);
  assert.notEqual(S.SYSTEM, S.SUMMARY_PROMPT, 'the system line is not the user turn');
  for (const p of ['2026-11', '2026', '2026-W46', '2026-03-03..2026-10-15']) assert.equal(S.scopeOfLabel(S.titleOf(p)), 'summary:' + p, p);
  for (const l of ['John 3:16', 'Summary · 总结 ', 'Summary · 总结', '', null, undefined, 42]) assert.equal(S.scopeOfLabel(l), null, String(l));
});

test('chat-ui: opts.system gets the thread\'s key (send\'s snapshot); the Save as note bubble binds the thread it was rendered in; a summary thread reopened from the list gets its scope back and the button', async () => {
  const seen = { system: [], saved: [], reqs: [] };
  const PAChat = chatWithShell([{ role: 'me', text: 'summarise' }, { role: 'md', text: '# Nov' }], seen.reqs);
  const mount = el('div');
  const chat = PAChat.mount(mount, { system: (k) => { seen.system.push(k); return 'S'; }, getLabel: (k) => k, summary: { run: async () => true, saveNote: async (o) => { seen.saved.push(o); return { ok: true }; } } });
  await chat.openConvo('c-9', { id: 'c-9', label: 'Summary · 总结 2026-11', title: 'summarise' });
  await tick(10);
  const log = mount.querySelector('.pac-log');
  const bars = log.children.filter((k) => k.className === 'pac-acts ai');
  assert.equal(bars.length, 1, 'one AI answer rendered');
  const save = bars[0].children.find((k) => k.className === 'pac-ab pds-savenote');
  assert.ok(save, 'Save as note is offered on the reopened summary thread');
  await save.onclick();
  assert.deepEqual(seen.saved.map((o) => [o.period, o.convoId]), [['2026-11', 'c-9']], 'bound to the conversation the bubble was rendered in');
  assert.equal(await chat.send('and the todos?'), true, 'a follow-up goes through');
  await tick(10);
  assert.deepEqual(seen.system, ['summary:2026-11'], 'the host\'s system slot saw the restored summary scope');
  assert.deepEqual(seen.reqs.filter((k) => k.startsWith('chat')), ['chat:S'], 'one turn, carrying the host\'s system line for that scope');
});

test('CONTROL: a verse thread reopened from the list gets no Save as note; attach() is under the R4 budget with the sheet hoisted to buildSheet', async () => {
  const PAChat = chatWithShell([{ role: 'md', text: 'Grace' }]);
  const mount = el('div');
  const chat = PAChat.mount(mount, { summary: { run: async () => true, saveNote: async () => ({ ok: true }) } });
  await chat.openConvo('c-1', { id: 'c-1', label: 'John 3:16', title: 'q' }); await tick(10);
  const bars = mount.querySelector('.pac-log').children.filter((k) => k.className === 'pac-acts ai');
  assert.equal(bars.length, 1); assert.equal(bars[0].children.some((k) => k.className === 'pac-ab pds-savenote'), false, 'a verse label restores no summary scope');
  const body = SRC.slice(SRC.indexOf('  function attach(c){'), SRC.indexOf('\n  }\n', SRC.indexOf('  function attach(c){')) + 4);
  assert.ok(body.split('\n').length <= 50, 'attach() is ' + body.split('\n').length + ' lines');
  assert.ok(SRC.indexOf('  function buildSheet(a){') > 0 && SRC.indexOf('  function buildSheet(a){') < SRC.indexOf('  function attach(c){'), 'buildSheet is module-level, above attach');
  assert.match(SRC, /function open\(\)\{ \(\{ov,presets,els\}=buildSheet\(\{choose,togglePhoto,cancel,send\}\)\);/, 'open() builds the sheet through it');
  assert.match(CHAT, /const sys=\(typeof opts\.system==='function'\?opts\.system\(k\):opts\.system\);/, 'send() passes its snapshot key to the host\'s system slot');
  assert.match(CHAT, /addActions\(thinking,'ai',final, q, k\);/, 'and to the actions bar');
  assert.match(CHAT, /decorate\(bar,rawText,\{el:bubble,key:scopeKey===undefined\?key:scopeKey,convo:\(c=>\(\)=>c\)\(curConvo\),hooks:opts\.summary\|\|null,fresh:scopeKey!==undefined,prompt\}\)/, 'decorate gets both snapshots, the bubble, whether this is the send path and the prompt it answers');
  assert.match(CHAT, /const PS=window\.PADrawerSummary; if\(PS&&meta\) key=\(PS\.isScope\(meta\.scope\)\?meta\.scope:PS\.scopeOfLabel\(meta\.label\)\)\|\|null;/, 'openConvo restores the scope from a stored scope, else the label');
});
