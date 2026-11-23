// The model chooser remembers, per app.
//
// SCAR: a user compared lanes on the same question, decided Mistral answered best for Bible
// study, and then had to re-pick it on EVERY visit — PAC_CURMODEL was in-memory only, so each
// app load fell back to PAC_MODELS[0] (DeepSeek). A preference you must restate every time is
// not a preference.
//
// The app cannot store it itself: an app runs sandboxed at an opaque origin (web/index.html
// sandbox="allow-scripts", no allow-same-origin) where localStorage, sessionStorage, IndexedDB
// and cookies ALL throw SecurityError — verified 2026-09-02, recorded at
// web/note-ui.inline.html:2284-2290.
//
// SECOND SCAR, and the reason this file changed: the shell kept it in its OWN localStorage
// ('pa_model:'+slug), which made it a per-DEVICE memory. A lane chosen on the Mac had to be
// chosen again on the iPhone, and clearing site data erased it. It now lives in the user's
// PROFILE (profile.appModels, PUT /api/profile) — the same server store appOrder and
// systemPrompts already use — so it follows the account.
//
// THREE GUARANTEES, each tested on BOTH sides of the wire:
//   1. an unknown model id is REFUSED, never stored;
//   2. a remembered lane the server has stopped offering falls back rather than being sent;
//   3. a failed WRITE is reported, never swallowed — and never "remembered" locally anyway.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SHELL, CHAT } from './helpers-app.mjs';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api as httpApi } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';   // TODO(R4 seam): this file is over budget; split by test group (one describe per file)

// ── the SHELL's store, run for real against a fetch we control ───────────────────────────────
// ME (the fetched profile) is the store now, and `api` is the write path — so the double this
// injects is an HTTP response, not a localStorage.
function loadStore({
  models = [{ id: 'deepseek' }, { id: 'mistral' }],
  me = {},
  respond = async () => ({ ok: true, json: async () => ({ ok: true }) }),
} = {}) {
  const src = SHELL;
  const from = src.indexOf('const frameSlug=()=>');
  const to = src.indexOf('function sendAppPrefs(');
  assert.ok(from > 0 && to > from, 'the model store is one contiguous block');
  const body = src.slice(from, to);
  const calls = [];
  const api = (url, opts) => { calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null }); return respond(url, opts); };
  // eslint-disable-next-line no-new-func
  const fn = new Function('ME', 'CHAT_MODELS', 'api', '$', `${body}; return {appModel, setAppModel, appModels};`);
  return { ...fn(me, models, api, () => ({ src: '' })), me, calls };
}

test('a chosen model is remembered for THAT app, and read back', async () => {
  const { appModel, setAppModel, me } = loadStore();
  assert.equal(appModel('bible'), null, 'nothing remembered to begin with');
  assert.deepEqual(await setAppModel('bible', 'mistral'), { ok: true });
  assert.equal(appModel('bible'), 'mistral', 'the choice survives');
  assert.deepEqual(me.appModels, { bible: 'mistral' }, 'and it landed on the profile object, not in localStorage');
  // Per app, not global: choosing a lane for one app must not move another app's.
  assert.equal(appModel('notes'), null, 'a different app is unaffected');
  await setAppModel('notes', 'deepseek');
  assert.equal(appModel('bible'), 'mistral', 'and still unaffected after');
  assert.deepEqual(me.appModels, { bible: 'mistral', notes: 'deepseek' }, 'both are kept');
});

test('the write goes to the PROFILE, carrying the whole map', async () => {
  // Full-object replace, mirroring systemPrompts/appOrder on the same route. Sending only the one
  // changed entry would make every save drop every other app's lane.
  const { setAppModel, calls } = loadStore({ me: { appModels: { notes: 'deepseek' } } });
  await setAppModel('bible', 'mistral');
  assert.equal(calls.length, 1, 'exactly one write');
  assert.equal(calls[0].url, '/api/profile');
  assert.equal(calls[0].opts.method, 'PUT');
  assert.deepEqual(calls[0].body, { appModels: { notes: 'deepseek', bible: 'mistral' } },
    'the app being changed AND every app already remembered');
});

test('an unknown lane is REFUSED, not stored — and costs no round trip', async () => {
  // R14: storing an id the server does not offer would be silently ignored on every future load,
  // which reads as "it did not remember" rather than as an error.
  const { appModel, setAppModel, calls } = loadStore();
  const r = await setAppModel('bible', 'gpt-9');
  assert.equal(r.ok, false);
  assert.match(r.error, /未知模型 · unknown model/);
  assert.equal(appModel('bible'), null, 'and nothing was written');
  assert.equal(calls.length, 0, 'an obvious mistake is caught before the network, not by it');
});

test('a missing app or model id is refused with a reason', async () => {
  const { setAppModel, calls } = loadStore();
  assert.equal((await setAppModel('', 'mistral')).ok, false, 'no app in view');
  assert.equal((await setAppModel('bible', '')).ok, false, 'no model id');
  assert.equal((await setAppModel('bible', null)).ok, false, 'a non-string id');
  assert.equal(calls.length, 0, 'none of them reach the server');
});

test('a failed WRITE is reported, and is NOT remembered locally', async () => {
  // The whole point of moving off localStorage is that the durable copy is the server's. An
  // optimistic local update after a refused write would show a lane no reload can reproduce —
  // the user sees it "remembered" and finds it gone tomorrow.
  const refused = loadStore({ respond: async () => ({ ok: false, status: 400, json: async () => ({ error: 'Unknown model · 未知模型: mistral' }) }) });
  const r = await refused.setAppModel('bible', 'mistral');
  assert.equal(r.ok, false, 'a refusal is REPORTED');
  assert.match(r.error, /无法保存 · could not save/);
  assert.match(r.error, /未知模型/, "and carries the SERVER's reason, not a generic one");
  assert.equal(refused.appModel('bible'), null, 'and nothing is remembered locally');
  assert.equal(refused.me.appModels, undefined, 'the profile object is untouched');

  // A network failure (offline, node asleep) is the same contract.
  const offline = loadStore({ respond: async () => { throw new Error('Failed to fetch'); } });
  const r2 = await offline.setAppModel('bible', 'mistral');
  assert.equal(r2.ok, false, 'a dropped request is REPORTED too');
  assert.match(r2.error, /无法保存 · could not save/);
  assert.equal(offline.appModel('bible'), null, 'and again nothing is remembered');

  // A non-2xx whose body is not JSON must still report, not throw.
  const junk = loadStore({ respond: async () => ({ ok: false, status: 500, json: async () => { throw new Error('not json'); } }) });
  const r3 = await junk.setAppModel('bible', 'mistral');
  assert.equal(r3.ok, false);
  assert.match(r3.error, /HTTP 500/, 'it falls back to the status rather than failing to report at all');
});

test('a profile that never loaded reads as "nothing remembered", not as a crash', () => {
  // settings.js loadProfile sets ME={} when the fetch fails. Every caller must survive that.
  for (const me of [{}, { appModels: null }, { appModels: 'nonsense' }]) {
    const { appModel } = loadStore({ me });
    assert.equal(appModel('bible'), null, `ME=${JSON.stringify(me)}`);
  }
});

test('the shell pushes the remembered lane with the rest of the prefs', () => {
  assert.match(SHELL, /wantModel:appModel\(frameSlug\(\)\)/, 'sent on every prefs push, keyed to the app in the frame');
  assert.match(SHELL, /m\.kind==='set-model'/, 'and the app can ask the shell to remember one');
  assert.match(SHELL, /reply\(await setAppModel\(appSlug, m\.model\)\)/,
    'AWAITED, using the slug the SHELL derives — an unawaited promise would reply {} and report nothing (R5)');
});

test('the old per-device localStorage key is gone, not merely unused (R1)', () => {
  // Left behind, it is a second store for the same fact: the next edit reads whichever one the
  // author happened to remember, and the two disagree per device.
  assert.ok(!/localStorage\.(get|set)Item\(MODEL_KEY/.test(SHELL), 'no reads or writes through it');
  assert.ok(!/const MODEL_KEY=/.test(SHELL), 'and the key itself is deleted');
  assert.ok(!/'pa_model:'/.test(SHELL.replace(/\/\/[^\n]*\n/g, '')),
    'the key string survives only in the comment recording why it went');
});

test('the app applies the remembered lane, and still refuses one the server dropped', () => {
  assert.match(CHAT, /if\(typeof m\.wantModel==='string'&&m\.wantModel\) PAC_WANTMODEL=m\.wantModel;/,
    'the remembered lane becomes the wanted lane');
  // It must be set BEFORE the fallback line, or "first in the list" wins and nothing changes.
  const set = CHAT.indexOf('PAC_WANTMODEL=m.wantModel');
  const fallback = CHAT.indexOf('PAC_CURMODEL=(PAC_WANTMODEL&&PAC_MODELS.some(x=>x.id===PAC_WANTMODEL))');
  assert.ok(set > 0 && fallback > set, 'and is applied before the first-in-list fallback runs');
  assert.match(CHAT, /PAC_MODELS\.some\(x=>x\.id===PAC_WANTMODEL\)\)\?PAC_WANTMODEL:PAC_MODELS\[0\]\.id/,
    'a remembered lane the server no longer offers falls back instead of being sent');
});

test('picking a model tells the shell, without blocking the pick', () => {
  const menu = /menu\.onclick=\(ev\)=>\{([\s\S]*?)\n      \};/.exec(CHAT);
  assert.ok(menu, 'the picker handler is one block');
  assert.match(menu[1], /PAC_CURMODEL=b\.dataset\.m/, 'the choice applies immediately');
  assert.match(menu[1], /kind:'set-model'/, 'and the shell is told to remember it');
  // Fire-and-forget on purpose: the choice is already live in this session, so a failed
  // postMessage costs the memory, not the turn the user is about to send.
  assert.match(menu[1], /try\{ parent\.postMessage[\s\S]*?\}catch\(e\)\{\}/, 'a failed post cannot break the picker');
});

// ── the SERVER half, over real HTTP ──────────────────────────────────────────────────────────
// The shell checks the model id too, but a client is not a trust boundary and its list can be
// stale, so the route is tested on its own. Real web.mjs, throwaway root, ephemeral port.
const MODELS = [{ id: 'deepseek', label: 'DeepSeek' }, { id: 'mistral', label: 'Mistral' }];
let port, root, web;
const profileFile = () => path.join(root, 'workspace', 'profile.json');
const readProfile = () => JSON.parse(fs.readFileSync(profileFile(), 'utf8'));
const put = (body) => httpApi(port, '/api/profile', { method: 'PUT', body: JSON.stringify(body) });

before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { chat_models: MODELS } });
  web = startWeb(root);
  await waitReady(port);
});
after(async () => { await stopWeb(web); rmTemp(root); });

test('PUT /api/profile stores a per-app lane, and GET hands it back', async () => {
  // R14 CONTROL: the happy path must work, or every refusal below proves only that the route
  // rejects everything.
  const r = await put({ appModels: { bible: 'mistral', notes: 'deepseek' } });
  assert.equal(r.status, 200, 'a valid map is accepted');
  assert.deepEqual(readProfile().appModels, { bible: 'mistral', notes: 'deepseek' }, 'and reaches the disk');
  const g = await (await httpApi(port, '/api/profile')).json();
  assert.deepEqual(g.appModels, { bible: 'mistral', notes: 'deepseek' }, 'GET publishes it so another device reads the same lane');
});

test('GET /api/profile answers {} for an account that has never picked one', async () => {
  // Not `undefined`. The shell reads ME.appModels through one accessor and a fresh account must
  // get an OBJECT, or every caller has to re-guard the shape. This is also what makes the
  // explicit `appModels:` line in the GET body do any work — the `{...prof}` spread already
  // carries the key whenever the profile happens to have one.
  const p = readProfile(); delete p.appModels;
  fs.writeFileSync(profileFile(), JSON.stringify(p, null, 2));
  const g = await (await httpApi(port, '/api/profile')).json();
  assert.deepEqual(g.appModels, {}, 'an empty map, not a missing key');
});

test('PUT /api/profile REFUSES a model this node does not offer, and stores nothing', async () => {
  await put({ appModels: { bible: 'mistral' } });                 // a known-good starting point
  const r = await put({ appModels: { bible: 'gpt-9' } });
  assert.equal(r.status, 400, 'refused loudly — a quiet drop reads to the user as "it did not remember"');
  assert.match((await r.json()).error, /Unknown model · 未知模型: gpt-9/, 'and names the id it rejected');
  assert.deepEqual(readProfile().appModels, { bible: 'mistral' }, 'the previous value is intact — nothing partial was written');
});

test('PUT /api/profile refuses a bad app name, a non-object, and an oversized map', async () => {
  await put({ appModels: { bible: 'mistral' } });
  for (const [what, body] of [
    ['a traversal-shaped slug', { appModels: { '../etc': 'mistral' } }],
    ['an array', { appModels: ['mistral'] }],
    ['a string', { appModels: 'mistral' }],
  ]) {
    const r = await put(body);
    assert.equal(r.status, 400, what);
  }
  // Too many entries is REFUSED, not truncated: a silent truncation loses whichever apps fell
  // off the end, which is the same "it did not remember" failure by another route.
  const huge = {}; for (let i = 0; i < 201; i++) huge['app' + i] = 'mistral';
  const r = await put({ appModels: huge });
  assert.equal(r.status, 400, 'over the cap');
  assert.match((await r.json()).error, /Too many apps · 应用过多/);
  assert.deepEqual(readProfile().appModels, { bible: 'mistral' }, 'and through all of it the stored map is untouched');
});

test('the model list the route validates against is the one /api/models publishes (R3)', async () => {
  // Two lists would drift, and the drift is invisible: the shell offers a lane the route then
  // refuses, or the route accepts one the shell never shows.
  const offered = await (await httpApi(port, '/api/models')).json();
  assert.deepEqual(offered.map((m) => m.id), MODELS.map((m) => m.id), 'the harness config is what is served');
  for (const m of offered) {
    assert.equal((await put({ appModels: { bible: m.id } })).status, 200, `${m.id} is offered, so it must be storable`);
  }
  const src = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  assert.match(src, /const known = new Set\(\(cfg\.chat_models \|\| \[\]\)\.map\(\(m\) => m\.id\)\);/,
    'and the route derives its set from cfg.chat_models rather than keeping a copy');
});

test('appModels does not disturb the other profile fields, prefs above all', async () => {
  // profile.prefs is an existing free-text STRING (the member's "how to answer me" note). The
  // first sketch of this feature nested the map under profile.prefs.appModels, which would have
  // replaced that text with an object.
  await httpApi(port, '/api/profile', { method: 'PUT', body: JSON.stringify({ prefs: 'short answers', about: 'notes about me' }) });
  await put({ appModels: { bible: 'mistral' } });
  const p = readProfile();
  assert.equal(typeof p.prefs, 'string', 'prefs is still a string');
  assert.equal(p.prefs, 'short answers', 'with its content intact');
  assert.equal(p.about, 'notes about me', 'and the neighbouring fields survive too');
  assert.deepEqual(p.appModels, { bible: 'mistral' }, 'appModels sits beside them, not inside prefs');
});

// ── per-app preference blobs（每个应用的偏好）─────────────────────────────────────────────────
// The same store, one field over: what an app's own ⚙ panel reads and writes. The SHAPE inside a
// blob is the app's business; the route owns only that it is a map of slug -> JSON object and
// that it stays small, because profile.json is read whole on every request.
test('PUT /api/profile stores a per-app preference blob, and GET hands it back', async () => {
  // R14 CONTROL for the refusals below.
  const prefs = { bible: { fontSize: 18, showDots: true, tags: ['study'] } };
  assert.equal((await put({ appPrefs: prefs })).status, 200);
  assert.deepEqual(readProfile().appPrefs, prefs, 'it reaches the disk verbatim — the app owns its own shape');
  const g = await (await httpApi(port, '/api/profile')).json();
  assert.deepEqual(g.appPrefs, prefs, 'and GET publishes it, so the panel opens on what was saved');
});

test('GET /api/profile answers {} appPrefs for an account that has never saved any', async () => {
  const p = readProfile(); delete p.appPrefs;
  fs.writeFileSync(profileFile(), JSON.stringify(p, null, 2));
  assert.deepEqual((await (await httpApi(port, '/api/profile')).json()).appPrefs, {});
});

test('PUT /api/profile refuses a bad blob and keeps the stored one intact', async () => {
  const good = { bible: { fontSize: 18 } };
  await put({ appPrefs: good });
  for (const [what, body] of [
    ['a traversal-shaped slug', { appPrefs: { '../etc': { a: 1 } } }],
    ['an array as the map', { appPrefs: [{ a: 1 }] }],
    ['a string as the map', { appPrefs: 'nope' }],
    ['an array as a blob', { appPrefs: { bible: [1, 2] } }],
    ['a string as a blob', { appPrefs: { bible: 'nope' } }],
    ['null as a blob', { appPrefs: { bible: null } }],
  ]) {
    const r = await put(body);
    assert.equal(r.status, 400, what);
    assert.ok((await r.json()).error, `${what}: and says why`);
  }
  // Oversized is REFUSED, not truncated: a silently shortened blob is a settings panel that
  // reports success and reopens on something the user never typed.
  const r = await put({ appPrefs: { bible: { blob: 'x'.repeat(9000) } } });
  assert.equal(r.status, 400, 'over the byte cap');
  assert.match((await r.json()).error, /Preferences too large · 偏好过大/);
  assert.deepEqual(readProfile().appPrefs, good, 'and after every one of them the stored blob is untouched');
});

test('appPrefs and appModels are independent fields on the same profile', async () => {
  // One store (R3), two facts. Writing one must not clear the other — they arrive in separate
  // PUTs, because the panel saves prefs while the composer's chooser saves the lane.
  await put({ appModels: { bible: 'mistral' } });
  await put({ appPrefs: { bible: { fontSize: 20 } } });
  const p = readProfile();
  assert.deepEqual(p.appModels, { bible: 'mistral' }, 'the lane survived the prefs write');
  assert.deepEqual(p.appPrefs, { bible: { fontSize: 20 } }, 'and the prefs are there');
  assert.equal(typeof p.prefs, 'string', 'and the free-text prefs field is still a string');
});
