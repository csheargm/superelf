// Every summary run is its own note, on a blank page (owner 2026-11-12: "the summary function overwrites the
// previous summary within the same date range ... keep the result of different runs ... use blank background
// pages"). Over the REAL hosts (helpers-app runApp, a real server, both twins): two runs of This week leave two
// notes with distinct run-time titles and both texts; run 2's follow-up (the REAL PASummaryFollowup) lands only
// in run 2's note; a follow-up whose note was deleted says so and creates nothing; the year preset reads the
// NEWEST run of a month; a new summary notebook is template 'plain'; a run title's link label has no doubled
// date. Mutation control: the old upsert-by-period path, put back into the host, fails the two-runs check.
// R11 — searched: "runTitleOf", "gone:true", "template:'plain'", "newestSummary" — no duplicates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startHarness, runApp, until, settle } from './helpers-app.mjs';
import { loadFollowup, loadRefs } from './helpers-summary.mjs';

const INDEX = { v: 1, entries: [{ id: 'e0', title: 'Note 0', created: 1, updated: 2, preview: 'p' }] };
const RUN1 = new Date(2026, 10, 12, 14, 52).getTime(), RUN2 = new Date(2026, 10, 12, 16, 5).getTime();
const mkEl = (tag) => { const kids = []; return { tagName: tag, className: '', textContent: '', children: kids, appendChild(k) { kids.push(k); return k; }, setAttribute(k, v) { this['@' + k] = v; } }; };
const BLOCK = { ok: true, heading: '跟进 · Follow-up', text: '- researched', items: [{ item: 'x', kind: 'research', ok: true }], partial: false };
const UPSERT = (src) => src.replace('if(runId!=null){ const old=entryById(String(runId));',
  '{ const up=newestSummary(period); if(up) return updateSummaryNote(up,{title,html,convoId,quiet}); } if(runId!=null){ const old=entryById(String(runId));');

async function boot(app, mutate) {
  const h = await startHarness('notes'); h.put('journal.json', INDEX);
  const A = runApp(app, h.relay, ['S', 'SUMMARY_HOOKS', 'boot', 'deleteById', 'curId:()=>curId', 'win:window'], { clampTimers: true, mutate });
  await until(() => A.S.entries.length === 1, 'boot to load the index'); await settle();
  A.win.PA_SUMMARY_NOW = RUN1; loadRefs(A.win, { createElement: mkEl });
  return { h, A, Title: A.win.PASummaryTitle };
}
const readNb = (h, id) => JSON.parse(fs.readFileSync(h.file('entry-' + id + '.json'), 'utf8'));
async function twoRuns(A, Title) {
  const one = { title: Title.runTitleOf('2026-W46', RUN1), html: '<div>run one</div>', period: '2026-W46', scope: 'summary:2026-W46', convoId: 'c-1' };
  const two = { title: Title.runTitleOf('2026-W46', RUN2), html: '<div>run two</div>', period: '2026-W46', scope: 'summary:2026-W46', convoId: 'c-2' };
  return { r1: await A.SUMMARY_HOOKS.saveNote(one), r2: await A.SUMMARY_HOOKS.saveNote(two), one, two };
}

for (const app of ['notes (template)', 'notes (live)']) {
  test(`${app}: two runs of This week are two notes (distinct run-time titles, both texts, blank 'plain' page); run 2's follow-up lands only in run 2's note`, async () => {
    const { h, A, Title } = await boot(app);
    try {
      const { r1, r2, one, two } = await twoRuns(A, Title);
      assert.equal(one.title, '本周 · This week Nov 9–15, 2026 · 11/12 14:52', 'the human period title + the run\'s local time');
      assert.ok(r1.ok && r2.ok && r1.id !== r2.id, 'two entries');
      const idx = JSON.parse(fs.readFileSync(h.file('journal.json'), 'utf8')).entries.filter((x) => x.summary === '2026-W46');
      assert.deepEqual(idx.map((x) => x.title).sort(), [one.title, two.title].sort(), 'both listed, told apart by their titles');
      assert.equal(readNb(h, r1.id).pages[0].pageHtml, '<div>run one</div>'); assert.equal(readNb(h, r2.id).pages[0].pageHtml, '<div>run two</div>');
      assert.equal(readNb(h, r1.id).template, 'plain', 'a new summary notebook is the blank page (no ruled default, no stationery design)');
      assert.equal(readNb(h, r1.id).design, undefined);
      A.win.PAStore = { ask: async () => BLOCK };
      const F = loadFollowup(A.win, { createElement: mkEl });
      const f = await F.run({ answer: 'x', html: two.html, period: two.period, scope: two.scope, title: two.title, id: r2.id, convoId: 'c-2', hooks: A.SUMMARY_HOOKS, bar: mkEl('div') });
      assert.equal(f.ok, true, f.status);
      assert.ok(readNb(h, r2.id).pages[0].pageHtml.startsWith('<div>run two</div><h3>跟进 · Follow-up</h3>'), 'run 2\'s note carries its follow-up');
      assert.equal(readNb(h, r1.id).pages[0].pageHtml, '<div>run one</div>', 'run 1\'s note is untouched');
      assert.equal(JSON.parse(fs.readFileSync(h.file('journal.json'), 'utf8')).entries.length, 3, 'the follow-up created nothing');
      A.stopPads();
    } finally { await h.stop(); }
  });

  test(`${app}: a follow-up whose note was deleted meanwhile says so on the bar and creates no note`, async () => {
    const { h, A, Title } = await boot(app);
    try {
      const { r2, two } = await twoRuns(A, Title);
      await A.deleteById(r2.id); await settle();
      const before = JSON.parse(fs.readFileSync(h.file('journal.json'), 'utf8')).entries.length;
      A.win.PAStore = { ask: async () => BLOCK };
      const F = loadFollowup(A.win, { createElement: mkEl }); const bar = mkEl('div');
      const f = await F.run({ answer: 'x', html: two.html, period: two.period, scope: two.scope, title: two.title, id: r2.id, hooks: A.SUMMARY_HOOKS, bar });
      assert.equal(f.ok, false); assert.equal(bar.children[0].textContent, '跟进未保存 · Follow-up not saved — 该总结笔记已删除 · its summary note was deleted');
      assert.equal(JSON.parse(fs.readFileSync(h.file('journal.json'), 'utf8')).entries.length, before, 'no new note');
      assert.equal(A.S.entries.some((x) => x.id === r2.id), false);
      A.stopPads();
    } finally { await h.stop(); }
  });

  test(`${app}: the year preset reads the NEWEST saved run of a month`, async () => {
    const { h, A, Title } = await boot(app);
    try {
      await A.SUMMARY_HOOKS.saveNote({ title: Title.runTitleOf('2026-10', RUN1), html: '<div>older</div>', period: '2026-10', convoId: null, quiet: true });
      A.S.entries.find((x) => x.summary === '2026-10').created = 1000;   // the older run, whatever ms the two saves share
      await A.SUMMARY_HOOKS.saveNote({ title: Title.runTitleOf('2026-10', RUN2), html: '<div>newer</div>', period: '2026-10', convoId: null, quiet: true });
      assert.equal(await A.SUMMARY_HOOKS.monthSummary('2026-10', 'x'), 'newer');
      A.stopPads();
    } finally { await h.stop(); }
  });

  test(`${app}: MUTATION CONTROL — the old upsert by period put back fails the two-runs check`, async () => {
    const { h, A, Title } = await boot(app, UPSERT);
    try {
      const { r1, r2 } = await twoRuns(A, Title);
      assert.equal(r1.id, r2.id, 'the mutation took: run 2 replaced run 1');
      assert.notEqual(readNb(h, r1.id).pages[0].pageHtml, '<div>run one</div>', 'run one\'s text is gone under the old behaviour');
      A.stopPads();
    } finally { await h.stop(); }
  });
}

for (const app of ['bible (template)', 'bible (live)']) {
  test(`${app}: two runs are two 'plain' notes in the chapter; a by-id save updates only its own; a deleted one answers gone`, async () => {
    const h = await startHarness('bible');
    try {
      h.put('notes/43-3.json', { notes: {}, draws: {}, chat: {}, titles: {} });
      const A = runApp(app, h.relay, ['BIBLE_SUMMARY', 'loadAnn', 'get ANN(){return ANN}', 'get BOOTED(){return _booted}', 'setCh:(b,c)=>{bookIdx=b;chapter=c;}'], { clampTimers: true });
      // The boot load restores reading.json first (PAReadingHistory), so its own loadAnn lands later: wait for it,
      // or it resets ANN under this test's saves.
      for (let i = 0; i < 200 && !A.BOOTED; i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(A.BOOTED, 'the boot load resolved');
      A.setCh(42, 3); await A.loadAnn();
      const r1 = await A.BIBLE_SUMMARY.saveNote({ html: '<div>one</div>', period: '2026-W46', quiet: true });
      const r2 = await A.BIBLE_SUMMARY.saveNote({ html: '<div>two</div>', period: '2026-W46', quiet: true });
      assert.ok(r1.ok && r2.ok && r1.key !== r2.key, 'two notes');
      const draws = JSON.parse(fs.readFileSync(h.file('notes/43-3.json'), 'utf8')).draws;
      assert.equal(draws[r1.key].pages[0].pageHtml, '<div>one</div>'); assert.equal(draws[r2.key].pages[0].pageHtml, '<div>two</div>');
      assert.equal(draws[r1.key].template, 'plain');
      const u = await A.BIBLE_SUMMARY.saveNote({ id: r2.id, html: '<div>two+fu</div>', period: '2026-W46', quiet: true });
      assert.equal(u.key, r2.key); const d2 = JSON.parse(fs.readFileSync(h.file('notes/43-3.json'), 'utf8')).draws;
      assert.equal(d2[r2.key].pages[0].pageHtml, '<div>two+fu</div>'); assert.equal(d2[r1.key].pages[0].pageHtml, '<div>one</div>');
      const g = await A.BIBLE_SUMMARY.saveNote({ id: 'file:42:3:free-1', html: 'x', period: '2026-W46', quiet: true });
      assert.deepEqual(g, { ok: false, gone: true }); assert.equal(Object.keys(A.ANN.draws).length, 2, 'nothing created');
      // The reader moves to John 4 before run 2's follow-up lands (review 2026-11-12): it is written to John 3's file, John 4 untouched.
      h.put('notes/43-4.json', { notes: {}, draws: {}, chat: {}, titles: {}, pins: { v1: true } });
      A.setCh(42, 4); await A.loadAnn();
      const off = await A.BIBLE_SUMMARY.saveNote({ id: r2.id, html: '<div>two+late</div>', period: '2026-W46', quiet: true });
      assert.ok(off.ok && off.id === r2.id, 'the run note in its own chapter, not gone');
      const j3 = JSON.parse(fs.readFileSync(h.file('notes/43-3.json'), 'utf8')), j4 = JSON.parse(fs.readFileSync(h.file('notes/43-4.json'), 'utf8'));
      assert.equal(j3.draws[r2.key].pages[0].pageHtml, '<div>two+late</div>'); assert.equal(j3.draws[r1.key].pages[0].pageHtml, '<div>one</div>');
      assert.equal(j3.draws[r2.key].template, 'plain', 'every other field kept');
      assert.deepEqual(j4.draws, {}, 'the chapter on screen got nothing'); assert.deepEqual(j4.pins, { v1: true });
      assert.deepEqual(await A.BIBLE_SUMMARY.saveNote({ id: 'file:42:3:free-1', html: 'x', period: '2026-W46', quiet: true }), { ok: false, gone: true }, 'a deleted run in another chapter is still gone');
    } finally { await h.stop(); }
  });
}

for (const app of ['bible (template)', 'bible (live)']) {
  test(`${app}: a run asked in John 3 whose FIRST save comes after the reader moved to John 4 is a new note in John 3; CONTROL: unmoved, it is in the chapter on screen`, async () => {
    const h = await startHarness('bible');
    try {
      h.put('notes/43-3.json', { notes: {}, draws: {}, chat: {}, titles: {} });
      h.put('notes/43-4.json', { notes: {}, draws: {}, chat: {}, titles: {}, pins: { v1: true } });
      const A = runApp(app, h.relay, ['BIBLE_SUMMARY', 'loadAnn', 'get ANN(){return ANN}', 'get BOOTED(){return _booted}', 'setCh:(b,c)=>{bookIdx=b;chapter=c;}', 'mark:(s)=>{SUMMARY_AT[s]={b:bookIdx,ch:chapter};}'], { clampTimers: true });
      for (let i = 0; i < 200 && !A.BOOTED; i++) await new Promise((r) => setTimeout(r, 10));
      A.setCh(42, 3); await A.loadAnn();
      A.mark('summary:2026-W46');                                          // what run() records, the line pinned below
      const c = await A.BIBLE_SUMMARY.saveNote({ html: '<div>here</div>', period: '2026-W46', scope: 'summary:2026-W46', quiet: true });
      assert.ok(c.ok && c.id.startsWith('file:42:3:'), 'CONTROL: unmoved, the chapter on screen');
      A.mark('summary:2026-W47');
      A.setCh(42, 4); await A.loadAnn();
      const r = await A.BIBLE_SUMMARY.saveNote({ html: '<div>late</div>', period: '2026-W47', scope: 'summary:2026-W47', quiet: true });
      assert.ok(r.ok && r.id === `file:42:3:${r.key}`, JSON.stringify(r));
      const j3 = JSON.parse(fs.readFileSync(h.file('notes/43-3.json'), 'utf8')), j4 = JSON.parse(fs.readFileSync(h.file('notes/43-4.json'), 'utf8'));
      assert.equal(j3.draws[r.key].pages[0].pageHtml, '<div>late</div>'); assert.equal(j3.draws[r.key].template, 'plain'); assert.equal(j3.draws[r.key].summary, '2026-W47');
      assert.equal(j3.draws[c.key].pages[0].pageHtml, '<div>here</div>', 'the earlier note is kept');
      assert.deepEqual(j4.draws, {}, 'John 4 got nothing'); assert.deepEqual(j4.pins, { v1: true }); assert.deepEqual(A.ANN.draws, {});
    } finally { await h.stop(); }
  });
}

test('run() records the chapter a summary was asked in, in both Bibles', () => {
  for (const p of ['workspace/apps/bible/index.html', 'workspace.example/apps/bible/index.html']) {
    const src = fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
    assert.match(src, /run:async\(\{scope,message,images,model\}\)=>\{[^\n]*\n\s*SUMMARY_AT\[scope\]=\{b:bookIdx,ch:chapter\};/, p);
  }
});

test('a run title reads cleanly: its link label has no repeated date, displayTitle keeps the run time, scopeOfLabel finds the period', () => {
  const win = { PA_SUMMARY_NOW: RUN1 }; const R = loadRefs(win); const Title = win.PASummaryTitle;
  const t = Title.runTitleOf('2026-W46', RUN1);
  assert.equal(Title.scopeOfLabel(t), 'summary:2026-W46'); assert.equal(Title.displayTitle(t), t);
  const l = R.label({ n: 3, title: t, day: '2026-11-12' });
  assert.equal(l.includes('2026-11-12'), false, l); assert.ok(l.startsWith('[3] 本周 · This week Nov 9–15, 2026'), l);
  assert.equal(R.label({ n: 1, title: 'Roof', day: '2026-11-09' }), '[1] Roof · 2026-11-09', 'CONTROL: a plain note keeps its day');
});
