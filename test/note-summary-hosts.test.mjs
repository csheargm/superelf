// The Journal's side of period summaries (docs/plans/note-features.md E): SUMMARY_HOOKS over the REAL
// app source (helpers-app runApp, a real server). saveNote writes a NEW entry file and the index entry
// bound to the thread through the app's own writeNote / writeIndexNow and opens it; monthSummary reads
// that note's text back by the title the component passes; run opens the rail on the summary scope
// and sends the message there; a saveNote with that entry's id UPDATES it, keeping its ink (every run
// without an id is a new note: test/summary-keep-runs.test.mjs); both opens keep the rail as it is; onLink opens the note while the rail keeps the
// summary thread (owner 2026-11-11). Template and live copies are both run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, startHarness, runApp, until, settle } from './helpers-app.mjs';
import { loadRefs } from './helpers-summary.mjs';

const INDEX = { v: 1, entries: [{ id: 'e0', title: 'Note 0', created: 1, updated: 2, preview: 'p' }] };
const NOTEBOOK = { v: 2, id: 'nb', pages: [{ id: 'p0', strokes: [], pageHtml: '<div>landlord</div>', images: [] }] };

for (const app of ['notes (template)', 'notes (live)']) {
  test(`${app}: saveNote creates an entry bound to the thread through the app's own write path and opens it; monthSummary reads it back; run sends into the rail under the summary scope`, async () => {
    const h = await startHarness('notes');
    try {
      h.put('journal.json', INDEX); h.put('entry-e0.json', NOTEBOOK);
      // The split gate is PASplit's and is proven in test/split-view.test.mjs; the harness stub has no
      // gate, so this run opens it by hand — what is under test is where the turn goes once it is open.
      const gate = (src) => src.replace('const splitOn=()=>!!(window.PASplit&&PASplit.available&&PASplit.gateOpen());', 'const splitOn=()=>true;');
      const A = runApp(app, h.relay, ['DATA', 'S', 'SUMMARY_HOOKS', 'boot'], { clampTimers: true, mutate: gate });
      await until(() => A.S.entries.length === 1, 'boot to load the index');
      const html = '<div>AI 总结 · AI summary — 2026-10 #summary #ai</div><p>October was <b>wet</b>.</p>';
      const r = await A.SUMMARY_HOOKS.saveNote({ title: 'Summary · 总结 2026-10', html, period: '2026-10', convoId: 'c-77' });
      assert.equal(r.ok, true); assert.ok(r.id, 'the new entry id');
      const idx = JSON.parse(fs.readFileSync(h.file('journal.json'), 'utf8'));
      const e = idx.entries.find((x) => x.id === r.id);
      assert.ok(e, 'listed in journal.json'); assert.equal(e.title, 'Summary · 总结 2026-10'); assert.equal(e.chat, 'c-77', 'bound to the thread (the row shows ✨ and reopens it)');
      assert.equal(e.summary, '2026-10', 'the entry carries its period: a re-run finds it');
      assert.ok(e.created > 0 && e.updated === e.created, 'created now');
      const nb = JSON.parse(fs.readFileSync(h.file('entry-' + r.id + '.json'), 'utf8'));
      assert.equal(nb.pages.length, 1); assert.equal(nb.pages[0].pageHtml, html, 'page 0 is the first line + the converted answer');
      assert.deepEqual(nb.pages[0].strokes, []); assert.deepEqual(nb.pages[0].images, []);
      assert.equal(fs.readFileSync(h.file('entry-e0.json'), 'utf8'), JSON.stringify(NOTEBOOK), 'the other note is untouched');
      assert.equal(await A.SUMMARY_HOOKS.monthSummary('2026-10', 'Summary · 总结 2026-10'), 'AI 总结 · AI summary — 2026-10 #summary #ai October was wet .', 'the saved text, tags stripped');
      assert.equal(await A.SUMMARY_HOOKS.monthSummary('2026-10', '上月 · Last month Oct 2026'), 'AI 总结 · AI summary — 2026-10 #summary #ai October was wet .', 'found by its period, whatever the title reads today');
      assert.equal(await A.SUMMARY_HOOKS.monthSummary('2026-09', 'Summary · 总结 2026-09'), null, 'no such month');
      // A by-id save (its run's follow-up or re-save) updates exactly that entry: page 0's text replaced, the ink and page 2 kept.
      const nb1 = JSON.parse(fs.readFileSync(h.file('entry-' + r.id + '.json'), 'utf8')); nb1.pages[0].strokes = [{ t: 'pen', p: [[1, 2]] }]; nb1.pages.push({ id: 'p1', strokes: [], pageHtml: '<div>my own notes</div>', images: [] });
      h.put('entry-' + r.id + '.json', nb1);   // the owner wrote on the summary since
      const html2 = '<div>AI 总结 — 2026-10 #summary #ai · AI summary</div><p>October, again.</p>';
      const r2 = await A.SUMMARY_HOOKS.saveNote({ id: r.id, title: '上月 · Last month Oct 2026', html: html2, period: '2026-10', scope: 'summary:2026-10', convoId: 'c-78' });
      assert.deepEqual(r2, { ok: true, id: r.id }, 'the same entry');
      const idx2 = JSON.parse(fs.readFileSync(h.file('journal.json'), 'utf8'));
      assert.equal(idx2.entries.length, idx.entries.length, 'no second entry');
      const e2 = idx2.entries.find((x) => x.id === r.id);
      assert.equal(e2.title, '上月 · Last month Oct 2026'); assert.equal(e2.chat, 'c-78'); assert.ok(e2.updated > e2.created, 'updated now');
      const nb2 = JSON.parse(fs.readFileSync(h.file('entry-' + r.id + '.json'), 'utf8'));
      assert.equal(nb2.pages[0].pageHtml, html2, 'page 0 text replaced'); assert.deepEqual(nb2.pages[0].strokes, nb1.pages[0].strokes, 'the ink on it kept'); assert.equal(nb2.pages[1].pageHtml, '<div>my own notes</div>', 'the second page kept');
      const r3 = await A.SUMMARY_HOOKS.saveNote({ title: '本月 · This month Nov 2026', html: '<div>Nov</div>', period: '2026-11', scope: 'summary:2026-11', convoId: null });
      assert.ok(r3.ok && r3.id !== r.id, 'CONTROL: another period is another entry'); assert.equal(JSON.parse(fs.readFileSync(h.file('journal.json'), 'utf8')).entries.length, idx.entries.length + 1);
      const sent = await A.SUMMARY_HOOKS.run({ scope: 'summary:2026-10', label: 'Summary · 总结 2026-10', message: 'PROMPT\n\n## 2026-10-01' });
      assert.notEqual(sent, false, 'the turn was handed to the rail');
      const rail = A.captured.panels.find((p) => p.kind === 'chat');
      assert.ok(rail, 'the rail chat was mounted (1024 wide: the split gate is open)');
      assert.equal(rail.chat.openedKey, 'summary:2026-10', 'opened on the summary scope, not the note\'s');
      assert.deepEqual(rail.chat.sent, ['PROMPT\n\n## 2026-10-01'], 'exactly one message, as given');
      assert.equal(rail.opts.getLabel('summary:2026-10'), 'Journal 手写', 'without the component on the page the label falls back (the component labels it by period)');
      assert.equal(rail.opts.getConvoId('summary:2026-10'), undefined, 'a summary scope binds no entry until Save as note');
      assert.deepEqual(await rail.opts.setConvoId('summary:2026-10', 'c-1'), { ok: true }, 'and setConvoId writes nothing for it');
      A.stopPads();
    } finally { await h.stop(); }
  });
}

const gate = (src) => src.replace('const splitOn=()=>!!(window.PASplit&&PASplit.available&&PASplit.gateOpen());', 'const splitOn=()=>true;');
for (const app of ['notes (template)', 'notes (live)']) {
  test(`${app}: onLink({id,page}) — a tapped [n] link in a summary — opens that note on that page through openEntry's reveal path while the rail KEEPS the summary thread; saveNote's open keeps it too; a drawer open still follows the pref (CONTROL)`, async () => {
    const h = await startHarness('notes');
    try {
      h.put('journal.json', { v: 1, entries: [{ id: 'e0', title: 'Note 0', created: 1, updated: 2, preview: 'p', chat: 'c-0' }, { id: 'e1', title: 'Note 1', created: 3, updated: 4, preview: 'q', chat: 'c-1' }] });
      h.put('entry-e0.json', NOTEBOOK); h.put('entry-e1.json', { ...NOTEBOOK, pages: [NOTEBOOK.pages[0], { id: 'p1', strokes: [], pageHtml: '<div>page two</div>', images: [] }] });
      const A = runApp(app, h.relay, ['DATA', 'S', 'SUMMARY_HOOKS', 'boot', 'openEntry', 'curId:()=>curId'], { clampTimers: true, mutate: gate });
      await until(() => A.S.entries.length === 2, 'boot to load the index');
      await until(() => A.captured.splits.length === 1, 'boot to mount the rail'); await settle();
      const pad = A.captured.pads[0], rail = A.captured.splits[0], chat = A.captured.panels.find((p) => p.kind === 'chat').chat;
      assert.equal(rail.isCollapsed('chat'), true, 'boot: the last-edited note opens alone (pref off)');
      // The summary thread is on screen (the sheet's turn went through run).
      await A.SUMMARY_HOOKS.run({ scope: 'summary:2026-11', label: '本月 · This month Nov 2026', message: 'PROMPT' });
      assert.equal(rail.isCollapsed('chat'), false); assert.equal(chat.openedKey, 'summary:2026-11');
      await A.SUMMARY_HOOKS.onLink({ id: 'e1', page: 1 });
      assert.equal(A.curId(), 'e1', 'the linked note is the open one');
      assert.deepEqual(pad.reveals, [{ page: 1 }], 'the pad was asked to show page 1 (PANoteReveal flips there; nothing to paint)');
      assert.equal(pad.nb.pages.length, 2, 'and the reload happened first');
      assert.equal(rail.isCollapsed('chat'), false, 'the rail is NOT collapsed by the link (the bug: the summary vanished)');
      assert.equal(chat.openedKey, 'summary:2026-11', 'and NOT switched to the note\'s own conversation (the openAi pref path never runs here)');
      // The back pill's way home is the same hook with the summary note's id: the rail stays again.
      const r = await A.SUMMARY_HOOKS.saveNote({ title: '本月 · This month Nov 2026', html: '<div>s</div>', period: '2026-11', scope: 'summary:2026-11', convoId: 'c-9' });
      assert.equal(A.curId(), r.id, 'saving opened the summary note'); assert.equal(rail.isCollapsed('chat'), false); assert.equal(chat.openedKey, 'summary:2026-11', 'the thread that wrote it stays beside it');
      await A.SUMMARY_HOOKS.onLink({ id: 'e0', page: 0 }); await A.SUMMARY_HOOKS.onLink({ id: r.id, page: 0 });
      assert.equal(A.curId(), r.id); assert.equal(chat.openedKey, 'summary:2026-11'); assert.equal(rail.isCollapsed('chat'), false);
      // CONTROL: an ordinary open (the drawer row) still follows the pref — off, so the chat collapses.
      await A.openEntry('e1');
      assert.equal(rail.isCollapsed('chat'), true, 'a drawer open with the pref off closes the chat, as before');
      A.stopPads();
    } finally { await h.stop(); }
  });
}

test('a refused index write leaves no half-saved entry listed', async () => {
  const h = await startHarness('notes');
  try {
    h.put('journal.json', INDEX);
    const A = runApp('notes (live)', h.relay, ['DATA', 'S', 'SUMMARY_HOOKS', 'boot'], { clampTimers: true });
    await until(() => A.S.entries.length === 1, 'boot');
    fs.chmodSync(h.file('journal.json'), 0o444); fs.chmodSync(path.dirname(h.file('journal.json')), 0o555);
    const r = await A.SUMMARY_HOOKS.saveNote({ title: 'Summary · 总结 2026-10', html: '<div>x</div>', period: '2026-10', convoId: null });
    fs.chmodSync(path.dirname(h.file('journal.json')), 0o755); fs.chmodSync(h.file('journal.json'), 0o644);
    assert.equal(r.ok, false, 'the write that failed is reported');
    assert.deepEqual(A.S.entries.map((e) => e.id), ['e0'], 'the entry is not listed');
    A.stopPads();
  } finally { await h.stop(); }
});

// ── Review round: the hosts' system slot, the Bible's unbound summary thread, its rows' `created` ──
const SUM_HTML = fs.readFileSync(path.join(ROOT, 'web', 'drawer-summary.inline.html'), 'utf8');
const loadSummary = (win) => { loadRefs(win); const i = SUM_HTML.indexOf('<script id="pds-script">'); new Function('window', 'document', SUM_HTML.slice(SUM_HTML.indexOf('>', i) + 1, SUM_HTML.indexOf('</script>', i)))(win, { createElement: () => ({}) }); return win.PADrawerSummary; };   // eslint-disable-line no-new-func

for (const app of ['notes (template)', 'notes (live)']) {
  test(`${app}: the system slot answers a summary scope with the component's ONE line, every other key with the journal prompt`, async () => {
    const h = await startHarness('notes');
    try {
      h.put('journal.json', INDEX);
      const A = runApp(app, h.relay, ['S', 'askData', 'boot', 'win:window'], { clampTimers: true });
      await until(() => A.S.entries.length === 1, 'boot');
      const S = loadSummary(A.win);
      assert.equal(A.askData.system('summary:2026-11'), S.SYSTEM);
      assert.match(A.askData.system('note:e0'), /^You are helping with a personal handwritten journal/, 'a note thread keeps the journal prompt');
      assert.match(A.askData.system(undefined), /^You are helping with a personal handwritten journal/, 'and so does appPrompt (no key)');
      A.stopPads();
    } finally { await h.stop(); }
  });
}

for (const app of ['bible (template)', 'bible (live)']) {
  test(`${app}: a summary scope is bound into no chapter file (setConvoId ok, nothing written), gets the component's system line, and the listed rows carry created`, async () => {
    const h = await startHarness('bible');
    try {
      const rel = 'notes/43-3.json';
      h.put(rel, { notes: { v16: 'keep me' }, draws: {}, chat: { v16: 'c-old' }, titles: {} });
      h.state.notes = [{ bookIdx: 42, chapter: 3, book: 'John', title: 'Loved', verseKey: 'v16', preview: 'p', hasDraws: false, updated: 50, created: 40, pin: false },
        { bookIdx: 0, chapter: 1, book: 'Genesis', title: 'Old', verseKey: 'v1', preview: '', hasDraws: false, updated: 20, pin: false }];
      const A = runApp(app, h.relay, ['chatData', 'loadAnn', 'win:window', 'get ANN(){return ANN}', 'setCh:(b,c)=>{bookIdx=b;chapter=c;}'], { clampTimers: true });
      A.setCh(42, 3); await A.loadAnn();
      const S = loadSummary(A.win);   // on the page before any thread binds, as chat-ui carries it in the real page
      const before = fs.readFileSync(h.file(rel), 'utf8');
      assert.deepEqual(await A.chatData.setConvoId('summary:2026-11', 'c-1'), { ok: true });
      await settle(4);
      assert.equal(fs.readFileSync(h.file(rel), 'utf8'), before, 'the chapter file is untouched'); assert.equal(A.ANN.chat['summary:2026-11'], undefined, 'and the map carries no period');
      assert.deepEqual(await A.chatData.setConvoId('v16', 'c-2'), { ok: true }); await settle(4);
      assert.equal(JSON.parse(fs.readFileSync(h.file(rel), 'utf8')).chat.v16, 'c-2', 'CONTROL: a verse scope still binds');
      assert.equal(A.chatData.system('summary:2026-11'), S.SYSTEM);
      assert.match(A.chatData.system('v16'), /^You are a Bible study assistant/, 'a verse thread keeps the study prompt');
      const rows = (await A.chatData.listAugment()).map((r) => [r.id, r.updated, r.created]);
      assert.deepEqual(rows, [['file:42:3:v16', 50, 40], ['file:0:1:v1', 20, 0]], 'created as listed, 0 when the listing has none (the presets then fall back to updated)');
    } finally { await h.stop(); }
  });
}
