// PAStore — the one guarded first read of an app's data file（先读后存）, web/store.inline.html.
//
// THE RULE (dd2dac9, b0c82aa): only the shell's code 'not-found' is a first run. Any other failed
// read, and a file that does not parse or has the wrong shape, is reported and refuses saves, as
// does a save made before the read is back: the app's state is still empty or default, and saving
// it would replace the user's file. Seven apps carried a hand-written copy; they now share this one.
// Here the REAL file is run (never restated) against a broker the test answers by hand, and a REAL
// web.mjs proves every committed app page receives it ahead of its own script. Each app's own flows
// through it are test/app-read-guard.test.mjs and test/app-read-guard-more.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, scriptOf, settle, until, deferred } from './helpers-app.mjs';
import { codeOnly } from './helpers-code.mjs';
import { committedApps, execScripts, SYNTHETIC, withServedPages } from './helpers-every-page.mjs';
import { boot as bootApp, srcOf, withHarness, writesTo } from './helpers-sandbox-app.mjs';

const HELPER = scriptOf(fs.readFileSync(path.join(ROOT, 'web', 'store.inline.html'), 'utf8'));
const MARKER = '<!--PA_STORE_UI-->';
const NOT_SAVED = ' — not saved · 未保存';
const FAMILY = { shape: (d) => (Array.isArray(d && d.members) ? '' : 'no members list'), unreadable: (why) => `Family unreadable (${why})` };
// The shell's failure replies (web/index.html relayCall + relayFail): every one but 'not-found'.
const FAILURES = ['unauthorized', 'server-error', 'network', 'too-large', 'bad-request', 'relay-error'];
const failure = (code) => ({ ok: false, code, error: `${code} error`, text: `The ${code} sentence · 句子` });

// The component alone, with the shell played by `answer(request)`: an object replies, a promise
// replies when it settles. Every 'message' listener hears every reply, as in a browser.
function boot(answer = () => ({ ok: true })) {
  const listeners = [], sent = [];
  const reply = (id, r) => { for (const fn of listeners) fn({ data: { pa: 'res', id, ...r } }); };
  const ctx = vm.createContext({
    addEventListener: (type, fn) => { if (type === 'message') listeners.push(fn); },
    parent: { postMessage: (m, origin) => { sent.push({ ...m, origin }); Promise.resolve(answer(m)).then((r) => reply(m.id, r)); } },
  });
  vm.runInContext(HELPER, ctx);
  const saves = () => sent.filter((m) => m.kind === 'save-data');
  return { S: ctx.PAStore, sent, saves, reply, ctx, rerun: () => vm.runInContext(HELPER, ctx) };
}
const reads = (text) => (m) => (m.kind === 'data' ? { ok: true, text } : { ok: true });
// A value out of the component's vm realm, as plain JSON: its objects carry another realm's prototype.
const plain = (v) => JSON.parse(JSON.stringify(v));

test("'not-found' is a first run: nothing to report, and saves go to the broker as given", async () => {
  const { S, sent, saves } = boot((m) => (m.kind === 'data' ? { ok: false, code: 'not-found', error: 'not found', text: 'Not found' } : { ok: true }));
  const f = S.file('family-data.json', FAMILY);
  assert.deepEqual(plain(await f.load()), { state: 'first' });
  assert.equal(f.loaded, true);
  assert.equal(f.error, '');
  assert.equal(await f.save({ members: [] }), '', 'saved');
  assert.equal(await f.save('{"members":[]}'), '');
  assert.deepEqual(plain(sent[0]), { pa: 'req', id: sent[0].id, kind: 'data', path: 'family-data.json', origin: '*' });
  assert.deepEqual(plain(saves().map((m) => [m.path, m.data])), [['family-data.json', { members: [] }], ['family-data.json', '{"members":[]}']],
    'path and data reach the broker untouched — an object stays an object, a string a string');
});

test('a good read answers the parsed file', async () => {
  const saved = { members: [{ name: 'Ann' }] };
  const { S, saves } = boot(reads(JSON.stringify(saved)));
  const f = S.file('family-data.json', FAMILY);
  assert.deepEqual(plain(await f.load()), { state: 'ok', value: saved });
  assert.equal(f.loaded, true);
  assert.equal(await f.save('x'), '');
  assert.equal(saves().length, 1);
});

test("every other failed read is reported in the shell's words, and refuses saves", async () => {
  for (const code of FAILURES) {
    const { S, saves } = boot((m) => (m.kind === 'data' ? failure(code) : { ok: true }));
    const f = S.file('family-data.json', FAMILY);
    assert.deepEqual(plain(await f.load()), { state: 'failed', text: `The ${code} sentence · 句子` }, code);
    assert.equal(f.loaded, false, `${code}: not loaded`);
    assert.equal(f.error, `The ${code} sentence · 句子`);
    assert.equal(await f.save({ members: [] }), `The ${code} sentence · 句子${NOT_SAVED}`, `${code}: the save says why`);
    assert.equal(saves().length, 0, `${code}: and is never sent — the empty family would replace the real one`);
  }
});

test('a failed read with no sentence uses the bare error, and one with no words at all still refuses', async () => {
  const bare = boot(() => ({ ok: false, code: 'server-error', error: 'server error · 服务器错误' }));
  const f = bare.S.file('a.json');
  assert.equal(plain(await f.load()).text, 'server error · 服务器错误');
  // R14: a failure must never count as loaded because it came without words.
  const mute = boot(() => ({ ok: false, code: 'server-error' }));
  const g = mute.S.file('a.json');
  assert.equal(plain(await g.load()).state, 'failed');
  assert.equal(g.loaded, false);
  assert.match(await g.save('x'), /\S — not saved/);
  assert.equal(mute.saves().length, 0);
});

test("a file that does not parse, or has the wrong shape, is unreadable in the app's words", async () => {
  for (const [text, why] of [['{not json', /JSON/], [JSON.stringify({ kids: [] }), /^no members list$/], ['null', /^no members list$/]]) {
    const { S, saves } = boot(reads(text));
    const f = S.file('family-data.json', FAMILY);
    const r = plain(await f.load());
    assert.equal(r.state, 'failed', text);
    assert.match(r.text, /^Family unreadable \(.+\)$/, `${text}: the app's sentence`);
    assert.match(r.text.slice('Family unreadable ('.length, -1), why, `${text}: around the reason`);
    assert.match(await f.save('x'), /^Family unreadable .* — not saved · 未保存$/);
    assert.equal(saves().length, 0, `${text}: no save over a file that was there but unreadable`);
  }
  // With no shape, any JSON is the right shape; with no wording, the reason is the sentence.
  const any = boot(reads('[1,2]'));
  assert.deepEqual(plain(await any.S.file('a.json').load()), { state: 'ok', value: [1, 2] });
  const bare = boot(reads('{not json'));
  assert.match(plain(await bare.S.file('a.json').load()).text, /JSON/);
});

test("a save before the read, or while it is in flight, is refused in the app's loading words", async () => {
  const { promise: held, resolve: release } = deferred();
  const { S, saves } = boot((m) => (m.kind === 'data' ? held.then(() => ({ ok: true, text: '{"members":[]}' })) : { ok: true }));
  const f = S.file('family-data.json', FAMILY);
  assert.equal(await f.save('x'), 'Still loading · 加载中' + NOT_SAVED, 'before load() is even called');
  const loading = f.load();
  assert.equal(await f.save('x'), 'Still loading · 加载中' + NOT_SAVED, 'while the read is in flight');
  const own = S.file('topics.json', { loading: '加载中…' });
  assert.equal(await own.save('x'), '加载中…' + NOT_SAVED, "an app's own words for it");
  assert.equal(saves().length, 0);
  release();
  await loading;
  assert.equal(await f.save('x'), '', 'once read, the save goes');
  assert.equal(saves().length, 1);
});

test("a failed save answers the shell's sentence, and never '' — '' means saved", async () => {
  let answer = { ok: false, code: 'server-error', error: 'server error · 服务器错误', text: 'Data not saved · 未保存 — server error' };
  const { S } = boot((m) => (m.kind === 'data' ? { ok: false, code: 'not-found' } : answer));
  const f = S.file('a.json');
  await f.load();
  assert.equal(await f.save('x'), 'Data not saved · 未保存 — server error');
  answer = { ok: false, code: 'server-error', error: 'server error · 服务器错误' };
  assert.equal(await f.save('x'), 'Save failed · 保存失败: server error · 服务器错误', 'a failure the shell did not word');
  answer = { ok: false, code: 'too-large' };
  assert.equal(await f.save('x'), 'Save failed · 保存失败: too-large', 'nor even explained');
  answer = { ok: true };
  assert.equal(await f.save('x'), '');
});

// Tasks' list is markdown (ADR 0010 "Tasks", ADR 0014): its own parse, the same guard, the same save-data.
const MD = { parse: (t) => t, shape: (d) => (typeof d === 'string' ? '' : 'no text') };
test("a file that is not JSON is read by the app's parse, and its shape still decides", async () => {
  const md = boot(reads('## Today\n- [ ] Call Mom'));
  assert.deepEqual(plain(await md.S.file('tasks.md', MD).load()), { state: 'ok', value: '## Today\n- [ ] Call Mom' });
  const none = boot(() => ({ ok: true }));
  const f = none.S.file('tasks.md', MD);
  assert.deepEqual(plain(await f.load()), { state: 'failed', text: 'no text' }, 'a reply with no text is not an empty list');
  assert.match(await f.save('x'), /^no text — not saved/);
  assert.equal(none.sent.filter((m) => m.kind !== 'data').length, 0, 'nothing is sent');
});

test('a markdown file is saved as its text, through save-data, behind the same guard', async () => {
  let read = failure('server-error');
  const { S, sent } = boot((m) => (m.kind === 'data' ? read : { ok: true }));
  const writes = () => sent.filter((m) => m.kind !== 'data');
  const f = S.file('tasks.md', MD);
  assert.equal(await f.save('- [ ] a'), 'Still loading · 加载中' + NOT_SAVED, 'before the read');
  await f.load();
  assert.equal(await f.save('- [ ] a'), `The server-error sentence · 句子${NOT_SAVED}`, 'after a failed read');
  assert.equal(writes().length, 0, 'never sent: the one task would replace the list');
  read = { ok: false, code: 'not-found' };
  await f.load();
  assert.equal(await f.save('- [ ] a'), '', 'a first run saves');
  assert.deepEqual(plain(writes().map(({ kind, what, path, data }) => ({ kind, what, path, data }))),
    [{ kind: 'save-data', what: 'data', path: 'tasks.md', data: '- [ ] a' }], 'the text as it is, and nothing else');
});

test("an app's words wrap a failed read; the refusal repeats them", async () => {
  const { S } = boot(() => failure('server-error'));
  const f = S.file('topics.json', { failed: (t) => `Topics not loaded: ${t}`, loading: '加载中…' });
  assert.equal(plain(await f.load()).text, 'Topics not loaded: The server-error sentence · 句子');
  assert.equal(await f.save('x'), 'Topics not loaded: The server-error sentence · 句子' + NOT_SAVED);
});

test('load can be retried: until a read succeeds, the last failure is what a save says', async () => {
  let fail = true;
  let release = () => {};
  const { S, saves } = boot((m) => {
    if (m.kind !== 'data') return { ok: true };
    if (fail) return failure('network');
    return new Promise((r) => { release = () => r({ ok: true, text: '[]' }); });
  });
  const f = S.file('topics.json');
  await f.load();
  fail = false;
  const retry = f.load();
  await settle();
  assert.equal(await f.save('x'), 'The network sentence · 句子' + NOT_SAVED, 'during the retry the last reason stands');
  release();
  assert.deepEqual(plain(await retry), { state: 'ok', value: [] });
  assert.equal(f.loaded, true);
  assert.equal(f.error, '');
  assert.equal(await f.save('x'), '');
  assert.equal(saves().length, 1);
});

test('files are independent: one that failed never blocks one that loaded', async () => {
  const { S, saves } = boot((m) => (m.kind !== 'data' ? { ok: true } : m.path === 'posts.json' ? failure('server-error') : { ok: false, code: 'not-found' }));
  const posts = S.file('posts.json'), prayers = S.file('prayers.json');
  await posts.load(); await prayers.load();
  assert.match(await posts.save({ posts: [] }), / — not saved/);
  assert.equal(await prayers.save({ prayers: [] }), '');
  assert.deepEqual(saves().map((m) => m.path), ['prayers.json']);
});

test("its broker answers only its own ids, and an app's ids never reach it", async () => {
  const { S, sent, reply } = boot(() => new Promise(() => {}));   // the shell never answers by itself
  const f = S.file('a.json');
  let settled = false;
  f.load().then(() => { settled = true; });
  assert.match(sent[0].id, /^pas\d+$/, 'string ids, so an app counting 1, 2, 3 never shares one');
  reply(1, { ok: true, text: '[]' });
  await settle();
  assert.equal(settled, false, "an app's reply is not the component's");
  reply(sent[0].id, { ok: true, text: '[]' });
  await settle();
  assert.equal(settled, true);
  reply(sent[0].id, { ok: true, text: '[]' });   // a second reply to an answered id is ignored
});

test('a second copy on the page keeps the first instance and its files', async () => {
  const { S, rerun, ctx } = boot((m) => (m.kind === 'data' ? { ok: false, code: 'not-found' } : { ok: true }));
  const f = S.file('a.json');
  await f.load();
  rerun();
  assert.equal(ctx.PAStore, S);
  assert.equal(await f.save('x'), '');
});

// The guard has one copy now. Only PAStore decides what a read's 'not-found' means — except
// Allergy, which deliberately does not block (each check replaces pollen.json whole), and the
// apps whose stores are their own components (PANote's NOT_FOUND_CODES, diabetes' STORE_NOT_FOUND).
test("no committed app hand-writes the guarded first read: only Allergy compares a read's code to 'not-found'", () => {
  const HAND_WRITTEN = /\.code\s*[!=]==?\s*['"]not-found['"]/;
  const found = committedApps().filter(({ html }) => HAND_WRITTEN.test(codeOnly(html))).map(({ slug }) => slug);
  assert.deepEqual(found, ['ws-allergy']);
  const users = committedApps().filter(({ html }) => /\bPAStore\.file\(/.test(html)).map(({ slug }) => slug).sort();
  assert.deepEqual(users, ['ex-tasks', 'sh-productivity-hub', 'ws-brainstorm', 'ws-calendar', 'ws-daily-digest', 'ws-family',
    'ws-productivity-hub', 'ws-rental-hunt', 'ws-tasks'], 'the apps that save (with the shelf hub and the Tasks template) read through it');
});

// ── Each app's own shape and words ─────────────────────────────────────────────────────────
// The rule is shared; what shape each file must have, and the sentence that says it has not, are
// each app's own. `null` is the wrong shape for every one of them: an app whose shape accepted
// anything would save over a file it could not use, and the read-guard suites only feed them
// files that do not parse. Run as served, against the real relay (helpers-sandbox-app.mjs).
const SHAPES = [
  ['workspace/apps', 'family', 'family-data.json', 'familyFile', 'Family file unreadable · 家庭文件无法读取 (no members list)'],
  ['workspace/apps', 'productivity-hub', 'productivity-hub.json', 'hubFile', 'Data file unreadable · 数据文件无法读取 (not a saved state)'],
  ['shared-apps', 'productivity-hub', 'productivity-hub.json', 'hubFile', 'Data file unreadable · 数据文件无法读取 (not a saved state)'],
  ['workspace/apps', 'daily-digest', 'data/daily-digest/topics.json', 'topicsFile', '主题未能读取 · Topics not loaded: not a topic list'],
  ['workspace/apps', 'brainstorm', 'sessions.json', 'sessionsFile', 'Sessions file unreadable · 记录文件无法读取 (not a session list)'],
  ['workspace/apps', 'calendar', 'calendar-notes.json', 'notesFile', 'Notes file unreadable · 笔记文件无法读取 (not a notes map)'],
  ['workspace/apps', 'rental-hunt', 'rental-hunt-history.json', 'historyFile', 'Search history unreadable · 搜索记录无法读取 (not a history list)',
    { PAChat: { fullscreen: () => ({ open() {}, send() {}, newChat() {} }) } }],
];
for (const [dir, slug, file, handle, says, extra] of SHAPES) {
  test(`${dir}/${slug}: a ${file} of the wrong shape is unreadable, in the app's words, and refuses saves`, () => withHarness(slug, async (h) => {
    h.put(file, 'null');
    const app = bootApp(srcOf(dir, slug), h.relay, extra);
    await until(() => app.run(`${handle}.error`) !== '', 'the read is back');
    assert.equal(app.run(`${handle}.error`), says);
    assert.equal(app.run(`${handle}.loaded`), false);
    assert.equal(await app.run(`${handle}.save('{}')`), says + NOT_SAVED);
    assert.equal(writesTo(h, file), 0, 'nothing is written over the file');
  }));
}

// ── Served: every committed app page carries it, ahead of the app's own script ─────────────
test('every committed app page gets PAStore once, ahead of its own script, right after PATwoTap (real web.mjs)', async () => {
  const committed = committedApps();
  await withServedPages([...committed, ...SYNTHETIC("typeof PAStore.file")], async (served) => {
    for (const { slug } of committed) {
      const html = await served(slug);
      assert.equal(html.includes(MARKER), false, `${slug}: no marker survives`);
      assert.equal(html.split('var PAStore = PAStore ||').length - 1, 1, `${slug}: exactly one PAStore`);
      const scripts = execScripts(html);
      assert.match(scripts[0], /var PATwoTap = PATwoTap \|\|/, `${slug}: PATwoTap first`);
      assert.match(scripts[1], /var PAStore = PAStore \|\|/, `${slug}: then PAStore, before any script of the page's own`);
    }
    for (const slug of ['syn-head-script', 'syn-no-head']) {
      const html = await served(slug);
      assert.ok(html.startsWith('<!doctype html>'), `${slug}: never ahead of the doctype (that is quirks mode)`);
      const ctx = vm.createContext({ setTimeout, clearTimeout, addEventListener() {}, parent: { postMessage() {} } });
      for (const s of execScripts(html)) vm.runInContext(s, ctx);
      assert.equal(ctx.early, 'function', `${slug}: the page's own script can use it at top level`);
    }
    assert.equal((await served('syn-static')).includes('PAStore'), false, 'a page with no script of its own gets nothing');
  });
});
