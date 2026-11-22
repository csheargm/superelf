// "Open AI notes with the note" · 打开笔记时显示 AI 对话 — an ACCOUNT app pref, default OFF (owner
// 2026-11-12: one place for a setting, on the account). A note that carries an AI conversation opens
// alone unless appPrefs[slug].openAi is true; ✨ / the ☰ chat row still reopen the bound thread by hand.
// It is set in the app's ⚙ Settings dialog (web/settings-rows.inline.html, test/settings-rows.test.mjs),
// pushed by the shell in {pa:'prefs'}, held in ONE place (PANote.prefs()) and read by the hosts at the
// moment a note opens, so a change applies to the next note opened without a reload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENGINE, SHELL, APP_SRC, between, stripComments, startHarness, runApp, until, settle } from './helpers-app.mjs';

const E = stripComments(ENGINE);
const LABEL = 'Open AI notes with the note · 打开笔记时显示 AI 对话';

test('shell: openAi is the app\'s account pref, pushed with the pad prefs and again after a Settings save; no device key', () => {
  assert.doesNotMatch(SHELL, /pa_openai/, 'the device key is gone (R1): a device that had it follows the account now');
  assert.doesNotMatch(SHELL, /typeof m\.openAi/, 'and so is the kind:\'pref\' openAi handler');
  assert.match(SHELL, /openAi:\(appPrefsMap\(\)\[frameSlug\(\)\]\|\|\{\}\)\.openAi===true,/, 'pushed from THIS app\'s appPrefs, default false');
  assert.match(SHELL, /const saved=await saveAppSettings\(appSlug, m\.prefs, m\.systemPrompt, m\.appPrompt\); reply\(saved\);\n\s*if\(saved\.ok\) sendAppPrefs\(false\);/,
    'a confirmed Settings save re-pushes the prefs, so the open app reads the new value on its next note');
});

test('engine: the pad sheet no longer has the row; ONE getter; a host never parses the message', () => {
  assert.equal(ENGINE.includes(LABEL), false, 'the label is not in the pad any more (it lives in the ⚙ dialog)');
  assert.doesNotMatch(E, /pan-openaicb|OPEN_AI_PREF_LABEL/, 'no checkbox row, no label constant');
  assert.doesNotMatch(E, /kind:'pref',openAi/, 'the pad reports nothing to the shell');
  assert.match(E, /prefs:\(\)=>Object\.assign\(\{\},PREFS\)/, 'exported as PANote.prefs()');
  for (const app of ['notes (template)', 'notes (live)', 'bible (template)', 'bible (live)']) {
    assert.doesNotMatch(APP_SRC[app], /m\.openAi/, `${app} reads PANote.prefs(), not the message`);
  }
});

// The engine's REAL PREFS block, lifted from the source rather than retyped (as helpers-app lifts
// the title API): default false, true after the shell's push, untouched by anything else.
function prefsApi() {
  const block = between(ENGINE, '  // ── Device prefs a HOST reads', '\n  // ── Note search（笔记搜索）──');
  assert.ok(block && block.includes('function applyPrefs'), 'the engine still carries the PREFS block');
  const listeners = [];
  const win = { addEventListener: (t, f) => { if (t === 'message') listeners.push(f); } };
  const src = block.replace(/\n\s*\/\/ ── Note search（笔记搜索）──$/, '');   // between() keeps both markers
  // eslint-disable-next-line no-new-func
  const out = new Function('window', `${src}\nreturn {prefs:()=>Object.assign({},PREFS)};`)(win);
  return { prefs: out.prefs, push: (data) => listeners.forEach((f) => f({ data })) };
}

test('PANote.prefs().openAi is false until the shell pushes true, and only a boolean openAi moves it', () => {
  const api = prefsApi();
  assert.equal(api.prefs().openAi, false, 'default');
  api.push({ pa: 'prefs', printInk: true, noFlip: true });
  assert.equal(api.prefs().openAi, false, 'a push without the key changes nothing');
  api.push({ pa: 'prefs', openAi: 'yes' });
  assert.equal(api.prefs().openAi, false, 'a non-boolean is ignored');
  api.push({ pa: 'req', openAi: true });
  assert.equal(api.prefs().openAi, false, 'only the prefs message');
  api.push({ pa: 'prefs', openAi: true });
  assert.equal(api.prefs().openAi, true, 'true after the push');
  const snap = api.prefs(); snap.openAi = false;
  assert.equal(api.prefs().openAi, true, 'the getter hands out a copy');
  api.push({ pa: 'prefs', openAi: false });
  assert.equal(api.prefs().openAi, false, 'and back');
});

const NOTEBOOK = { v: 2, id: 'nb', pages: [{ id: 'p0', strokes: [], pageHtml: '<div>x</div>', images: [] }] };
const INDEX = { v: 1, entries: [
  { id: 'e0', title: 'Note 0', created: 1, updated: 2, preview: 'p', chat: 'c-0' },
  { id: 'e1', title: 'Note 1', created: 3, updated: 4, preview: 'q', chat: 'c-1' }] };
const gate = (src) => src.replace('const splitOn=()=>!!(window.PASplit&&PASplit.available&&PASplit.gateOpen());', 'const splitOn=()=>true;');

for (const app of ['notes (template)', 'notes (live)']) {
  test(`${app}: a note with a conversation opens ALONE when the pref is off; ✨ reopens the thread; on, it opens with it — read per open`, async () => {
    const h = await startHarness('notes');
    try {
      h.put('journal.json', INDEX); h.put('entry-e0.json', NOTEBOOK); h.put('entry-e1.json', NOTEBOOK);
      const A = runApp(app, h.relay, ['DATA', 'S', 'boot', 'openEntry', 'curId:()=>curId'], { clampTimers: true, mutate: gate });
      await until(() => A.S.entries.length === 2, 'boot to load the index');
      // Boot opens the last-edited note and calls syncAsk, which is what mounts the rail (ensureRail).
      await until(() => A.captured.splits.length === 1, 'boot to mount the rail'); await settle();
      const rail = A.captured.splits[0], chat = A.captured.panels.find((p) => p.kind === 'chat').chat;
      assert.ok(rail && chat, 'the rail and its chat slot exist (1024 wide)');
      assert.equal(rail.isCollapsed('chat'), true, 'boot: the last-edited note has a chat and still opens alone');
      await A.openEntry('e1');
      assert.equal(A.curId(), 'e1');
      assert.equal(rail.isCollapsed('chat'), true, 'pref off: the chat slot stays collapsed');
      assert.equal(chat.openedKey, undefined, 'and no thread was loaded');
      // The hand path the owner keeps: ✨ in the pad's top bar (onAsk → openAsk) opens THIS note's scope,
      // which PAChat resolves to the bound conversation through getConvoId.
      const pad = A.captured.pads[0];
      await pad.opts.onAsk();
      assert.equal(rail.isCollapsed('chat'), false, '✨ expands the chat');
      assert.equal(chat.openedKey, 'note:e1', 'on the open note\'s scope');
      assert.equal(chat.opts.getConvoId('note:e1'), 'c-1', 'which is the bound thread');
      // Opening another note with the pref still off closes it again: a chat left on screen reads as
      // belonging to the note now open.
      await A.openEntry('e0');
      assert.equal(rail.isCollapsed('chat'), true, 'pref off: the next note opens alone too');
      // Toggle live: the owner ticks the ⚙ row, Save stores appPrefs.notes.openAi and the shell
      // re-pushes; what the shell pushes (its real sendAppPrefs over that ME) applies to the NEXT note.
      A.captured.prefs.openAi = shellPush({ appPrefs: { notes: { noteSort: 'created', openAi: true } } }).openAi;
      assert.equal(A.captured.prefs.openAi, true, 'the shell pushes the account value');
      await A.openEntry('e1');
      assert.equal(rail.isCollapsed('chat'), false, 'pref on: the conversation opens with the note');
      assert.equal(chat.openedKey, 'note:e1', 'on that note\'s scope');
      A.captured.prefs.openAi = shellPush({ appPrefs: { notes: { noteSort: 'created' } } }).openAi;
      await A.openEntry('e0');
      assert.equal(rail.isCollapsed('chat'), true, 'off again: the next open is alone');
      A.stopPads();
    } finally { await h.stop(); }
  });
}

test('journal host: syncAsk reads PANote.prefs() at the moment of the open (pinned in both copies)', () => {
  for (const app of ['notes (template)', 'notes (live)']) {
    assert.match(APP_SRC[app], /if\(e&&e\.chat&&PANote\.prefs\(\)\.openAi\)\{ rail\.open\(\); rail\.expand\('chat'\);/, app);
  }
});

test('bible host: opening a note expands the NOTE slot only — the chat is never opened by a note open (both copies)', () => {
  for (const app of ['bible (template)', 'bible (live)']) {
    const raw = between(APP_SRC[app], 'async function openDrawFull(', '\nasync function openNewDrawNote(');
    assert.ok(raw, `${app}: openDrawFull found`);
    const body = stripComments(raw);
    assert.match(body, /rail\.expand\('note'\)/, `${app}: the note slot`);
    assert.doesNotMatch(body, /expand\('chat'\)|railChat\.open|openConvo/, `${app}: no chat opened with the note`);
    assert.match(raw, /PANote\.prefs\(\)\.openAi/, `${app}: the pref is named where the rule is`);
  }
});

test('the hunks are identical in the shipped copy and the template', () => {
  for (const [live, tpl] of [['notes (live)', 'notes (template)'], ['bible (live)', 'bible (template)']]) {
    const a = between(APP_SRC[live], 'function syncAsk(){', '\n}') || between(APP_SRC[live], 'async function openDrawFull(', '_drawScope is repointed');
    const b = between(APP_SRC[tpl], 'function syncAsk(){', '\n}') || between(APP_SRC[tpl], 'async function openDrawFull(', '_drawScope is repointed');
    assert.ok(a && b && a.length > 50, live);
    assert.equal(a, b, `${live} and ${tpl} carry the same hunk`);
  }
});

// ── The shell pushes the pad prefs BEFORE the models settle ──────────────────────────────────
// SCAR: the journal boots on its last note and syncAsk reads PANote.prefs().openAi right then. The
// shell's one push waited on Promise.race([chatModelsFresh, 3 s]) — after that boot — so with the
// pref ON the note opened without its chat. Two pushes now: the stored prefs on load, the full set
// (models, newFeatureKeys) once the list settles.
function shellOnload({ seen = new Set(), me = { appPrefs: { notes: { openAi: true } } }, slug = 'notes' } = {}) {
  const from = SHELL.indexOf('function sendAppPrefs(');
  const to = SHELL.indexOf('\n// Bound by CLASS');
  const onload = /^\$\('#fr'\)\.onload=.*$/m.exec(SHELL);
  assert.ok(from > 0 && to > from && onload, 'sendAppPrefs and the frame onload are findable');
  const posted = [];
  const fr = { src: `/app/owner/${slug}/`, contentWindow: { postMessage: (m) => posted.push(m) } };
  let settle;
  const models = new Promise((r) => { settle = r; });
  const appPrefsMap = /^function appPrefsMap\(\)\{.*$/m.exec(SHELL);   // the shell's own reader of ME.appPrefs
  assert.ok(appPrefsMap, 'appPrefsMap is findable');
  const stubs = {
    $: () => fr, FS_STEPS: [1], fsIdx: 0, CHAT_MODELS: [{ id: 'fast' }], appModel: () => 'fast', frameSlug: () => slug, ME: me,
    localStorage: { getItem: () => '1' }, RELAY_LIMITS: { upload: 1, chat: 1 },
    frameOwnBar: () => false, fsTitle: () => '',   // the app's own bar (ADR 0032): not under test here
    window: { _PA_NEW_KEYS: { 'feat:x': 1, 'feat:seen': 1 } }, _SEEN: seen, chatModelsFresh: models, MODELS_WAIT_MS: 3000,
    setTimeout: () => 0,   // the bounded wait never fires here: only the models promise settles the second push
  };
  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(stubs), `${appPrefsMap[0]}\n${SHELL.slice(from, to)}\n${onload[0]}`)(...Object.values(stubs));
  return { posted, load: () => fr.onload(), settle };
}

test('shell: the stored pad prefs reach the frame on load, before the models promise resolves', async () => {
  const s = shellOnload({ seen: new Set(['feat:seen']) });
  const done = s.load();
  assert.equal(s.posted.length, 1, 'one push synchronously on load');
  assert.equal(s.posted[0].pa, 'prefs');
  assert.equal(s.posted[0].openAi, true, 'carrying the account\'s appPrefs.notes.openAi');
  assert.equal(s.posted[0].printInk, true, 'and the other pad prefs');
  assert.equal('models' in s.posted[0], false, 'no list yet: PAChat takes its lane from the FIRST list it sees');
  assert.equal('wantModel' in s.posted[0], false);
  assert.equal('newFeatureKeys' in s.posted[0], false, 'blue dots are announced once, on the settled push');
  s.settle(); await done;
  assert.equal(s.posted.length, 2, 'then the settled push');
  assert.deepEqual(s.posted[1].models, [{ id: 'fast' }]);
  assert.equal(s.posted[1].wantModel, 'fast');
  assert.deepEqual(s.posted[1].newFeatureKeys, ['feat:x'], 'unseen keys only (_SEEN filtered), once');
  assert.equal(s.posted[1].openAi, true, 'the pad prefs again — the handlers are idempotent');
});

// What the shell pushes for this ME, through its real sendAppPrefs (the synchronous first push).
function shellPush(me, slug = 'notes') { const s = shellOnload({ me, slug }); s.load(); return s.posted[0]; }

test('shell: openAi follows the account per app — true only for ===true, false otherwise (a device key never counts)', () => {
  assert.equal(shellPush({ appPrefs: { notes: { openAi: true } } }).openAi, true);
  assert.equal(shellPush({ appPrefs: { notes: { openAi: true } } }, 'bible').openAi, false, 'per app: the Journal\'s choice is not the Bible\'s');
  assert.equal(shellPush({ appPrefs: { bible: { openAi: true } } }, 'bible').openAi, true);
  assert.equal(shellPush({ appPrefs: { notes: { openAi: 'yes' } } }).openAi, false, 'a non-boolean is off');
  assert.equal(shellPush({ appPrefs: { notes: {} } }).openAi, false, 'default off — even though every localStorage key reads "1" here');
  assert.equal(shellPush(null).openAi, false, 'no profile yet: off');
});
