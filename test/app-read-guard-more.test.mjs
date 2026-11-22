// A FAILED read must never become an empty start — the same guard as test/app-read-guard.test.mjs,
// for Brainstorm, Calendar and Rental Hunt (one table, so each app is checked the same way),
// and Allergy, which only has to SAY so. Run for real: each app's own script as served, the shell
// relay and a real node:http server over a throwaway directory (helpers-sandbox-app.mjs).
//
// THE BUG (2026-10-12): each of these took any failed or unparseable read of its data file as
// "nothing saved yet", so the next save — a new session, a note, a post, a search — wrote that
// empty state over the user's file. Calendar also sent its notes as `text`, a field the shell never
// forwards, so every Calendar save was refused while the page said "Saved." (its R14 control below
// is that regression test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { settle, until } from './helpers-app.mjs';
import { htmlOf, srcOf, boot, writesTo, readFails, saveFails, textOf, fileText, unreadable, withHarness, heldReads,
  refusedOrSent, SHELL_SAVE_FAILED, SHELL_NOTE_SAVE_FAILED } from './helpers-sandbox-app.mjs';

const elOf = (app, id) => app.run(`document.getElementById('${id}')`);
// A file that does not parse is reported in the app's own words; a failed read, in the shell's (`said`).
const UNREADABLE = /unreadable/i;
const answerAsk = (text, relay) => (m) => (m.kind === 'ask' ? Promise.resolve({ ok: true, text }) : relay(m));

// Each app: its data file, a saved copy, where it shows a read failure (`status`) and a refused save
// (`refusal`), the user's save action (`act`, never awaited: some go on to a chat that never answers
// here), what the R14 control's first save must contain (`wrote` → `want`), the empty-state prompt
// a first run shows and a failed read must not (`empty`), and the button that waits for a good read
// (`gate`). `last` is the final file the app reads on boot.
const APPS = [
  {
    slug: 'brainstorm', file: 'sessions.json', status: 'status', refusal: 'status',
    saved: JSON.stringify([{ id: 'bs1', topic: 'Garden', createdAt: 1, convoId: null, msgs: [], ideas: [] }]),
    act: (app) => { elOf(app, 'sheet-inp').value = 'Roses'; app.run('startSession()'); },   // ＋ 新建 → 开始探索
    wrote: (d) => d.map((s) => s.topic), want: ['Roses'],
    empty: { id: 'list-view', re: /还没有头脑风暴记录/ }, gate: 'new-btn',
  },
  {
    slug: 'calendar', file: 'calendar-notes.json', status: 'status', refusal: 'save-status',
    saved: JSON.stringify({ '2026-10-01': 'Dentist' }),
    act: (app) => { app.run("openDetail('2026-10-12')"); elOf(app, 'note-area').value = 'Call Mom'; elOf(app, 'save-btn').on.click(); },
    wrote: (d) => d['2026-10-12'], want: 'Call Mom',
  },
  {
    slug: 'rental-hunt', file: 'rental-hunt-history.json', status: 'status', refusal: 'status',
    saved: JSON.stringify([{ loc: 'Boston, MA', ts: '2026-10-01T00:00:00.000Z', count: 10 }]),
    extra: { PAChat: { fullscreen: () => ({ open() {}, send() {}, newChat() {} }) } },
    ask: JSON.stringify([{ id: 1, address: 'Unit 1', neighborhood: 'Downtown', price: 2000, beds: 1, baths: 1,
      sqft: 700, type: 'apartment', amenities: [], petFriendly: true, walkScore: 80, description: 'Bright.', highlight: 'Light' }]),
    act: (app) => { elOf(app, 'locInput').value = 'Austin, TX'; app.run('doSearch()'); },   // a search saves it to history
    wrote: (d) => d.map((x) => x.loc), want: ['Austin, TX'],
  },
];

// Boots the app; `ready()` resolves once its boot reads have come back and been handled.
function start(a, h, relay = h.relay) {
  const seen = new Set();
  const watched = async (m) => { const r = await relay(m); if (m.kind === 'data') seen.add(m.path); return r; };
  const app = boot(srcOf('workspace/apps', a.slug), a.ask ? answerAsk(a.ask, watched) : watched, a.extra);
  const ready = async () => { await until(() => seen.has(a.last || a.file), 'the boot reads are back'); await settle(); };
  return { app, ready };
}
const firstSave = (h, a) => until(() => fs.existsSync(h.file(a.file)), 'the first save lands');

for (const a of APPS) {
  for (const [why, prep, said] of unreadable(a.file, a.saved)) {
    test(`${a.name || a.slug}: when ${why}, the next save cannot overwrite the saved file`, () => withHarness(a.slug, async (h) => {
      prep(h);
      const before = fileText(h, a.file);
      const { app, ready } = start(a, h);
      await ready();
      const shown = a.empty ? textOf(app, a.empty.id) + (app.els[a.empty.id]?.innerHTML || '') : '';
      a.act(app);
      await refusedOrSent(app, h, a.file, a.refusal);
      assert.equal(writesTo(h, a.file), 0, 'no save was sent over the unread file');
      assert.equal(fileText(h, a.file), before);
      assert.match(textOf(app, a.status), said || UNREADABLE, 'the reason is on screen');
      if (a.empty) assert.doesNotMatch(shown, a.empty.re, 'a failed read is not shown as an empty start');
      if (a.gate) assert.equal(elOf(app, a.gate).disabled, true, `${a.gate} stays off`);
    }));
  }

  test(`${a.name || a.slug}: a save made while the first read is in flight is refused`, () => withHarness(a.slug, async (h) => {
    h.put(a.file, a.saved);
    const read = heldReads(h.relay);
    const { app, ready } = start(a, h, read.relay);
    a.act(app);
    await refusedOrSent(app, h, a.file, a.refusal);
    assert.equal(writesTo(h, a.file), 0, 'no save before the read returns');
    if (a.gate) assert.match(htmlOf('workspace/apps', a.slug), new RegExp(`id="${a.gate}"[^>]*\\bdisabled\\b`), `${a.gate} starts off`);
    read.release();
    await ready();
    assert.equal(fileText(h, a.file), a.saved);
  }));

  // R14 control: the guard must not also block the genuine first run.
  test(`${a.name || a.slug}: no saved file yet starts empty, and the first save works`, () => withHarness(a.slug, async (h) => {
    const { app, ready } = start(a, h);
    await ready();
    if (a.empty) assert.match(app.els[a.empty.id]?.innerHTML || '', a.empty.re, 'a first run shows its empty prompt');
    if (a.gate) assert.equal(elOf(app, a.gate).disabled, false, `${a.gate} is on once the read is in`);
    a.act(app);
    await firstSave(h, a);
    assert.deepEqual(a.wrote(JSON.parse(fileText(h, a.file))), a.want);
    assert.doesNotMatch(textOf(app, a.status), /\S/, 'nothing to report');
  }));

  test(`${a.name || a.slug}: a failed save is shown, not dropped`, () => withHarness(a.slug, async (h) => {
    h.put(a.file, a.saved);
    const { app, ready } = start(a, h);
    await ready();
    h.state.fault = saveFails(a.file);
    a.act(app);
    await until(() => SHELL_SAVE_FAILED.test(textOf(app, a.refusal)), 'the failure is on screen');
    assert.equal(fileText(h, a.file), a.saved);
  }));
}

test('calendar: Clear after a failed read says so, and keeps the day open', () => withHarness('calendar', async (h) => {
  const cal = APPS.find((a) => a.slug === 'calendar');
  h.put(cal.file, cal.saved);
  h.state.fault = readFails(cal.file);
  const { app, ready } = start(cal, h);
  await ready();
  app.run("openDetail('2026-10-01')");
  await elOf(app, 'clear-btn').on.click();
  assert.equal(writesTo(h, cal.file), 0, 'no save was sent over the unread file');
  assert.match(textOf(app, 'save-status'), /not saved/);
  assert.equal(elOf(app, 'detail').classList.contains('open'), true, 'the day stays open, so the failure is seen');
}));

// ── Allergy: a check REPLACES pollen.json by design (last city + cached result), so a failed read
// does not block saving; it only has to be shown instead of reading as "no city yet".
const ALLERGY = { slug: 'allergy', file: 'pollen.json', saved: JSON.stringify({ location: 'Boston, MA', result: {}, fetched: 0 }),
  ask: JSON.stringify({ overall_level: 'Low', score: 2, description: 'Calm.', triggers: [], tips: [] }) };
const checkCity = (app) => { elOf(app, 'loc-input').value = 'Austin, TX'; elOf(app, 'loc-btn').onclick(); };

for (const [why, prep, said] of unreadable(ALLERGY.file, ALLERGY.saved)) {
  test(`allergy: when ${why}, it says so, and checking a city still saves it`, () => withHarness('allergy', async (h) => {
    prep(h);
    const { app, ready } = start(ALLERGY, h);
    await ready();
    assert.match(textOf(app, 'status'), said || UNREADABLE, 'not passed off as "no city yet"');
    checkCity(app);
    await until(() => writesTo(h, ALLERGY.file) > 0 && JSON.parse(fileText(h, ALLERGY.file)).location === 'Austin, TX',
      'the city just checked is saved');
  }));
}

// R14 control: a first run reports nothing.
test('allergy: no saved city yet starts quietly, and the first check is saved', () => withHarness('allergy', async (h) => {
  const { app, ready } = start(ALLERGY, h);
  await ready();
  assert.equal(textOf(app, 'status'), '');
  checkCity(app);
  await until(() => fs.existsSync(h.file(ALLERGY.file)), 'the first check is saved');
  assert.equal(JSON.parse(fileText(h, ALLERGY.file)).location, 'Austin, TX');
}));

// Allergy saves through its own raw broker call, not PAStore, and names no `what`, so it still reads
// the shell's default noun: "Note not saved" for a pollen check. TODO: apps/allergy sends what:'data'
// (a live workspace app: its own change), and this flips to SHELL_SAVE_FAILED.
test('allergy: a failed save is shown, not dropped', () => withHarness('allergy', async (h) => {
  const { app, ready } = start(ALLERGY, h);
  await ready();
  h.state.fault = saveFails(ALLERGY.file);
  checkCity(app);
  await until(() => SHELL_NOTE_SAVE_FAILED.test(textOf(app, 'status')), 'the failure is on screen');
}));
