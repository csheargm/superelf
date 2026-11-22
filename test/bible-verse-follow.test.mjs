// Bible verse-follow (owner spec 2026-11-13): ONE verse selected at a time; a tap never opens a
// pane; an OPEN rail pane follows the selection — to the new verse's own thread / note, or it
// closes when that verse has none; deselecting shows the whole-Bible state; following never sends;
// a long-press still force-explains. Driven on BOTH copies of the real host source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, runApp, until, settle } from './helpers-app.mjs';

const WIDE = (src) => src.replace('const splitOn=()=>!!(window.PASplit&&PASplit.available&&PASplit.gateOpen());', 'const splitOn=()=>true;');
const EXPORTS = ['TOP', 'selV', 'selectVerse', 'longPressVerse', 'get ANN(){return ANN}', '_booted:()=>_booted',
  'load', 'jumpToRef', 'get drawPad(){return drawPad}', 'doc:()=>document'];
const verse = () => { const s = new Set(); return { classList: { add: (c) => s.add(c), remove: (c) => s.delete(c), toggle() {}, contains: (c) => s.has(c) } }; };

async function boot(app) {
  const h = await startHarness('bible');
  const A = runApp(app, h.relay, EXPORTS, { clampTimers: true, globals: { PATips: { register() {} } }, mutate: WIDE });
  await until(() => A._booted(), 'boot');
  await settle();
  const rail = A.captured.splits[0], chat = A.captured.panels.find((p) => p.kind === 'chat').chat;
  return { h, A, rail, chat };
}

for (const app of ['bible (template)', 'bible (live)']) {
  test(`${app}: one verse at a time; a tap opens no pane`, async () => {
    const { h, A, rail } = await boot(app);
    try {
      const a = verse(), b = verse();
      A.selectVerse(1, a); A.selectVerse(3, b);
      assert.deepEqual([...A.selV], [3], 'the second tap MOVES the selection');
      assert.equal(rail.isCollapsed('chat') && rail.isCollapsed('note'), true, 'a tap opens no pane');
      A.selectVerse(3, b);
      assert.equal(A.selV.size, 0, 'tapping the selected verse clears it');
      A.stopPads();
    } finally { await h.stop(); }
  });

  test(`${app}: an open chat follows — thread, none (closes), deselect (general); never sends`, async () => {
    const { h, A, rail, chat } = await boot(app);
    try {
      A.ANN.chat.v3 = 'convo-v3';
      A.selectVerse(16, verse());
      await A.TOP.chat.onclick();                       // the top bar asks about 3:16 (today's behaviour)
      const sent = chat.sent.length;
      assert.equal(chat.openedKey, 'v16');
      A.selectVerse(3, verse());
      assert.equal(chat.openedKey, 'v3', 'follows to the verse that has a thread');
      assert.equal(rail.isCollapsed('chat'), false);
      A.selectVerse(5, verse());
      assert.equal(rail.isCollapsed('chat'), true, 'a verse with no thread closes the pane');
      await A.TOP.chat.onclick(); const sent2 = chat.sent.length;   // re-open on v5 by hand
      A.selectVerse(5, verse());                         // a second tap clears it
      assert.equal(chat.openedKey, 'general', 'deselect shows the whole-Bible thread');
      assert.equal(rail.isCollapsed('chat'), false);
      assert.equal(chat.sent.length, sent2, 'following never sends');
      assert.ok(sent2 >= sent);
      A.stopPads();
    } finally { await h.stop(); }
  });

  test(`${app}: an open note follows — note, none (closes), deselect (general)`, async () => {
    const { h, A, rail } = await boot(app);
    try {
      A.ANN.draws.v3 = { v: 1 };
      await A.TOP.note.onclick();
      assert.equal(rail.isCollapsed('note'), false);
      A.selectVerse(3, verse()); await settle();
      assert.equal(rail.isCollapsed('note'), false, 'follows to the verse that has a note');
      A.selectVerse(5, verse()); await settle();
      assert.equal(rail.isCollapsed('note'), true, 'a verse with no note closes the pane');
      A.stopPads();
    } finally { await h.stop(); }
  });

  test(`${app}: long-press still force-explains the held verse`, async () => {
    const { h, A, rail, chat } = await boot(app);
    try {
      A.selectVerse(1, verse());
      A.longPressVerse(7, verse()); await settle();
      assert.deepEqual([...A.selV], [7]);
      assert.equal(rail.isCollapsed('chat'), false);
      assert.match(chat.sent[chat.sent.length - 1] || '', /3:7/);
      A.stopPads();
    } finally { await h.stop(); }
  });

  test(`${app}: an open chat follows a chapter change (general) and a reference jump (that verse)`, async () => {
    const { h, A, rail, chat } = await boot(app);
    try {
      A.ANN.chat.v3 = 'convo-v3';
      A.selectVerse(3, verse());
      await A.TOP.chat.onclick();
      assert.equal(chat.openedKey, 'v3');
      await A.load(); await settle();
      assert.equal(A.selV.size, 0);
      assert.equal(chat.openedKey, 'general', 'a new chapter shows the whole-Bible thread, not the old verse');
      assert.equal(rail.isCollapsed('chat'), false);
      const d = A.doc(), qsa = d.querySelectorAll, v16 = Object.assign(verse(), { dataset: { n: '16' }, scrollIntoView() {} });
      d.querySelectorAll = (sel) => (sel === '.verse' ? [v16] : qsa(sel));   // the harness DOM renders no verses
      A.jumpToRef(42, 3, [16]);
      await until(() => A.selV.has(16), 'jump selects 3:16');
      await settle();
      assert.equal(rail.isCollapsed('chat'), true, 'the jumped-to verse has no thread: the side chat closes, not stuck on v3');
      d.querySelectorAll = qsa;
      A.stopPads();
    } finally { await h.stop(); }
  });

  test(`${app}: a note auto-close waits for the pad save`, async () => {
    const { h, A, rail } = await boot(app);
    try {
      A.ANN.draws.v3 = { v: 1 };
      A.selectVerse(3, verse());
      await A.TOP.note.onclick(); await settle();
      assert.equal(rail.isCollapsed('note'), false);
      let release; const real = A.drawPad.flush; let flushed = 0;
      A.drawPad.flush = () => { flushed++; return new Promise((r) => { release = r; }); };
      A.selectVerse(5, verse());
      await settle();
      assert.equal(flushed, 1, 'the save runs first');
      assert.equal(rail.isCollapsed('note'), false, 'the pane stays until the save resolves');
      release(true); await settle();
      assert.equal(rail.isCollapsed('note'), true, 'then it closes');
      A.drawPad.flush = real;
      A.stopPads();
    } finally { await h.stop(); }
  });
}
