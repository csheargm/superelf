// PAAppPrefs — the page's ONE chain for this app's server-side prefs (web/app-prefs.inline.html), driven
// through the REAL drawer (chat-ui, helpers-stationery loadChatUi) and the REAL pen sheet (web/ink-pen.inline.html)
// against the REAL shell block (web/index.html appSettingsOf / saveAppSettings, extracted and run): the store
// is not a laxer fake, it is the shell's own code (memory rule: mocks keep the real system's guards).
// What is proved, as the owner uses it:
//   1. a drawer sort tap keeps the app's prompt override (the live bug: the drawer sent no systemPrompt);
//   2. a drawer write and a pen write within one round trip both persist (two chains lost one key);
//   3. a pen choice made while a prefs read is in flight stays on screen and on the server;
//   4. the settings dialog's explicit clear ('' prompt) still clears.
// Each has a mutation control: the fix reverted, the same assertion fails (R14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ENG_PALETTE, fakeEl, scriptOf } from './helpers-app.mjs';
import { loadChatUi, APP_PREFS_SRC } from './helpers-stationery.mjs';
import { loadShellAppSettings } from './helpers-shell-broker.mjs';
import { tick, pickMore } from './helpers-drawer-search.mjs';

const PEN_SRC = scriptOf(fs.readFileSync(path.join(ROOT, 'web', 'ink-pen.inline.html'), 'utf8'));
const SETTINGS_UI = fs.readFileSync(path.join(ROOT, 'web', 'settings-ui.inline.html'), 'utf8');
const SLUG = 'bible', PROMPT = 'Study aid', RED = ENG_PALETTE.COLORS[13];
// The shell fix reverted: a non-string systemPrompt CLEARS again (the line as it was before this change).
const SHELL_OLD = (s) => s.replace(/  if\(typeof systemPrompt==='string'\)\{ if\(systemPrompt\.trim\(\)\) nextApps\[slug\]=systemPrompt\.trim\(\); else delete nextApps\[slug\]; \}/,
  "  if(typeof systemPrompt==='string'&&systemPrompt.trim()) nextApps[slug]=systemPrompt.trim(); else delete nextApps[slug];");
const NO_OVERRIDE = (s) => s.replace('systemPrompt:override});', '});');                       // the drawer's old write: no systemPrompt
const NO_OVERLAY = (s) => s.replace('for(const k of Object.keys(local)) o[k]=local[k].v;', ''); // a reply overwrites a local change
const OWN_IDS = (s) => s.replace("'pap'+", "'pq'+").replace('if(window.PAAppPrefs) return;', '');

// The frame's window and the shell behind it: every request answered by the real shell block on a microtask
// (one round trip), or held when `hold` says so; replies go to every listener on the window, as postMessage does.
function page({ me, shellMutate, hold = () => false } = {}) {
  const shell = loadShellAppSettings({ me, mutate: shellMutate });
  const on = [], held = [];
  const deliver = (m) => Promise.resolve(m.kind === 'app-settings' ? { ok: true, ...shell.appSettingsOf(SLUG) }
    : m.kind === 'set-app-settings' ? shell.saveAppSettings(SLUG, m.prefs, m.systemPrompt) : { ok: true })
    .then((r) => on.slice().forEach((f) => f({ data: { pa: 'res', id: m.id, ...r } })));
  const parent = { postMessage: (m) => { if (!(m && m.pa === 'req')) return; if (hold(m)) held.push(m); else queueMicrotask(() => deliver(m)); } };
  const win = { addEventListener: (t, f) => { if (t === 'message') on.push(f); }, PANote: { palette: ENG_PALETTE, SAVE_TIMEOUT_MS: 20000 } };
  const release = () => { const all = held.splice(0); all.forEach(deliver); return all.length; };
  return { win, parent, me, release, held };
}
function loadPrefs(p, src = APP_PREFS_SRC, w = p.win) {
  // eslint-disable-next-line no-new-func
  new Function('window', 'parent', 'setTimeout', 'clearTimeout', src)(w, p.parent, () => 0, () => {});
  return w.PAAppPrefs;
}
function attachPen(p, prefs) {
  const doc = { createElement: (t) => fakeEl(t), body: fakeEl('body') };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', 'parent', PEN_SRC)(p.win, doc, p.parent);
  const anchor = { pen: () => ({ t: 'pen', c: '#0f6355', w: 2 }), setPen() {}, onPen() {} };
  return p.win.PAInkPen.attach({ anchor, container: fakeEl('verses'), palette: ENG_PALETTE, prefs });
}
const meWith = (prefs = {}) => ({ appPrefs: { [SLUG]: prefs }, systemPrompts: { apps: { [SLUG]: PROMPT } } });
async function drawerOn(p, appPrefsSrc) {
  // loadChatUi puts the SHIPPED PAAppPrefs on the window; a mutated one is loaded first and wins (the idempotence guard).
  if (appPrefsSrc) loadPrefs(p, appPrefsSrc);
  const { PAChat, window } = loadChatUi({ win: p.win, parent: p.parent });
  const d = PAChat.listDrawer({ title: 'Notes', items: async () => [], onOpen: () => {}, onDelete: async () => {} });
  await d.refresh(); await window.PAAppPrefs.whenIdle(); await tick(5);
  return { d, window };
}

// ═══ 1. the drawer keeps the prompt override ═════════════════════════════════════════════════
for (const [name, shellMutate, appPrefsSrc, kept] of [
  ['shipped', undefined, undefined, true],
  ['shell reverted only (the component still re-sends the override)', SHELL_OLD, undefined, true],
  ['component reverted only (the shell keeps an absent prompt)', undefined, NO_OVERRIDE(APP_PREFS_SRC), true],
  ['mutation control: both reverted (the live bug)', SHELL_OLD, NO_OVERRIDE(APP_PREFS_SRC), false],
]) {
  test(`${name}: a drawer sort tap ${kept ? 'keeps' : 'WIPES'} the app's system-prompt override`, async () => {
    const p = page({ me: meWith({ hiddenTags: ['x'] }), shellMutate });
    const { d, window } = await drawerOn(p, appPrefsSrc);
    await pickMore(d, 'Sort'); await window.PAAppPrefs.whenIdle();
    assert.equal(p.me.appPrefs[SLUG].noteSort, 'updated', 'the order was written');
    assert.deepEqual(p.me.appPrefs[SLUG].hiddenTags, ['x'], 'merged into the stored prefs');
    assert.equal((p.me.systemPrompts.apps || {})[SLUG], kept ? PROMPT : undefined);
  });
}

// ═══ 2. two writers, one round trip ══════════════════════════════════════════════════════════
for (const [name, two, both] of [['shipped: one chain', false, true], ['mutation control: the pen on a chain of its own', true, false]]) {
  test(`${name} — a drawer write and a pen write within one round trip ${both ? 'both persist' : 'lose one key'}`, async () => {
    let holding = false;
    const p = page({ me: meWith(), hold: () => holding });
    const { d, window } = await drawerOn(p);
    const penPrefs = two ? loadPrefs(p, OWN_IDS(APP_PREFS_SRC), Object.assign(Object.create(p.win), { addEventListener: p.win.addEventListener })) : window.PAAppPrefs;
    const pen = attachPen(p, penPrefs); await penPrefs.whenIdle();
    holding = true;                           // the shell answers in rounds: every request in flight together
    const sort = pickMore(d, 'Sort'); await tick(8);                    // the sort's read is in flight, unanswered…
    const choice = pen.choose({ c: RED });                               // …when the pen choice is made
    for (let i = 0; i < 12; i++) { await tick(1); p.release(); }
    await sort; await choice; await window.PAAppPrefs.whenIdle(); await penPrefs.whenIdle();
    const stored = p.me.appPrefs[SLUG];
    assert.equal(stored.noteSort === 'updated' && !!stored.inkPen && stored.inkPen.c === RED, both, JSON.stringify(stored));
    assert.equal(p.me.systemPrompts.apps[SLUG], PROMPT, 'and the override survives either way');
  });
}

// ═══ 3. a pen choice during an in-flight read ════════════════════════════════════════════════
for (const [name, src, kept] of [['shipped', APP_PREFS_SRC, true], ['mutation control: no local overlay on a reply', NO_OVERLAY(APP_PREFS_SRC), false]]) {
  test(`${name}: a pen choice made while a prefs read is in flight is ${kept ? 'kept' : 'LOST'} on screen and on the server`, async () => {
    let holding = true;
    const p = page({ me: meWith({ inkPen: { t: 'pen', size: 'thin', c: '#1d4ed8' } }), hold: (m) => holding && m.kind === 'app-settings' });
    const prefs = loadPrefs(p, src);
    const pen = attachPen(p, prefs);          // attach reads — held in flight
    await tick(0);
    assert.equal(p.held.length, 1, 'the read is in flight');
    const saved = pen.choose({ c: RED });     // the user picks red before it answers
    holding = false; p.release();             // the stale read answers blue
    await saved; await prefs.whenIdle();
    assert.equal(pen.choice().c === RED, kept, 'on screen: ' + pen.choice().c);
    assert.equal(p.me.appPrefs[SLUG].inkPen.c === RED, kept, 'on the server: ' + p.me.appPrefs[SLUG].inkPen.c);
  });
}

// ═══ 4. the settings dialog's explicit clear ═════════════════════════════════════════════════
for (const [name, mutate, cleared] of [['shipped', undefined, true], ['mutation control: a blank string kept like an absent one', (s) => s.replace('else delete nextApps[slug]; }', '}'), false]]) {
  test(`${name}: the settings dialog's '' prompt ${cleared ? 'clears' : 'does NOT clear'} the override; an absent prompt keeps it`, async () => {
    const me = meWith({ a: 1 });
    const shell = loadShellAppSettings({ me, mutate });
    assert.equal((await shell.saveAppSettings(SLUG, { a: 2 })).ok, true);
    assert.equal(me.systemPrompts.apps[SLUG], PROMPT, 'a prefs-only write (no systemPrompt) keeps the override');
    assert.equal((await shell.saveAppSettings(SLUG, { a: 3 }, '')).ok, true);
    assert.equal((me.systemPrompts.apps || {})[SLUG], cleared ? undefined : PROMPT);
  });
}
test('every set-app-settings caller: the dialog always sends its textarea\'s string; PAAppPrefs always sends the override it read', () => {
  assert.match(SETTINGS_UI, /req\(\{kind:'set-app-settings',prefs:pr\.value,systemPrompt:pTa\.value,/, 'the dialog: a string, \'\' when emptied (the explicit clear)');
  assert.match(APP_PREFS_SRC, /req\(\{kind:'set-app-settings',prefs,systemPrompt:override\}\)/);
  const writers = ['chat-ui.inline.html', 'ink-pen.inline.html'].filter((f) => /kind:'set-app-settings'/.test(fs.readFileSync(path.join(ROOT, 'web', f), 'utf8')));
  assert.deepEqual(writers, [], 'the drawer and the pen write only through PAAppPrefs');
});
