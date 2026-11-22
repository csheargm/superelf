// DEFECT — A SHELL LEFT OPEN FOR DAYS KEPT OFFERING A LANE THE SERVER HAD STOPPED SERVING.
//
// WHAT WAS BROKEN
//   web/index.html read /api/models once, at boot, into CHAT_MODELS, and sendAppPrefs posted that
//   same list to every app opened afterwards. ADR 0007 makes /api/models leave out an Ollama lane
//   that answered 404/410, but a shell that never reloads (the iOS home-screen app) never asked
//   again. The app's chooser kept the gone lane's label while the server answered on another lane,
//   and said so only in a status line that disappears at the first token.
//
// WHAT THIS FILE ASSERTS, as the user meets it
//   The REAL web.mjs in a throwaway root serves /api/models. The shell's own code runs against it:
//   its `api`, its boot block, openApp, the frame's onload and sendAppPrefs, all cut from
//   web/index.html. The lane is retired after boot through the writer a chat turn uses
//   (recordGone), so the server's answer changes the way it does on the node. The list checked is
//   the one the next app receives in its pa:'prefs' message.
//
// THE MAIN CHAT'S OWN CHOOSER, from the same read. It was drawn at boot and on a pick only, so a
// lane picked there kept its label after the server stopped serving it. After every read it now
// stands where a fresh load would put it: a pick still served is kept; a gone one gives way to the
// boot default; no models means no lane. The label checked is the shell's own #shellModel.
//
// R14: the control runs first. The lane must be in the first app's list, or "gone from the second"
// proves nothing. A failed refresh must leave the last GOOD list: an empty or missing list is a
// failure here, never a clean result.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, OWNER_TOKEN } from './helpers-web.mjs';
import { SHELL, between } from './helpers-app.mjs';
import { runShell } from './helpers-shell-dom.mjs';
import { MODEL_HEALTH_FILENAME, recordGone } from '../lib/model-health.mjs';
import { localDateStr } from '../lib/schedule.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const MODELS = [
  { id: 'fast', label: 'Fast One', group: 'Fast', provider: 'ollama', model: 'fast-one:cloud' },
  { id: 'old', label: 'Old Model', group: 'Fast', provider: 'ollama', model: 'old-model:0731-cloud' },
  { id: 'deep', label: 'Deep One', group: 'Deep', provider: 'ollama', model: 'deep-one:cloud' },
  { id: 'claude', label: 'Claude', group: 'Agent', provider: 'claude', model: null },
];
const ids = (list) => (Array.isArray(list) ? list.map((m) => m.id) : list);

let port, root, web;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { chat_models: MODELS } });
  // The server's own scheduler runs model-check on a tick after its time. Marking it done today
  // keeps that run out of this file, so only this test writes the health record.
  fs.writeFileSync(path.join(root, 'workspace', 'job-runs.json'), JSON.stringify({ 'model-check': localDateStr(new Date()) }));
  web = startWeb(root);
  await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); if (root) rmTemp(root); });

const healthFile = () => path.join(root, MODEL_HEALTH_FILENAME);
const retire = (model) => recordGone(healthFile(), model, { status: 410, serverError: `${model} was retired at 2026-09-25` });
const unretireAll = () => fs.rmSync(healthFile(), { force: true });
// The real server refusing the shell's session: every request in `fn` carries a token it rejects.
async function withWrongToken(fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (u, opt) => realFetch(u, { ...opt, headers: { ...opt.headers, authorization: 'Bearer wrong-token' } });
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}

// ── the shell, cut from the served web/index.html ───────────────────────────────────────────
function cut(src, from, to, what) {
  const s = between(src, from, to);
  assert.ok(s !== null, `${what} is findable in web/index.html`);
  return s.slice(0, -to.length);   // `between` keeps both ends; the end marker belongs to the next part
}
const line = (src, re, what) => { const m = re.exec(src); assert.ok(m, `${what} is findable in web/index.html`); return m[0]; };

// `net` decides what the shell's fetch meets: the real server, a dropped connection, a request that
// never answers, or a 200 with no lanes — what the real server answers once every configured lane is
// gone (reaching it for real needs a config with no agent lane, which this root cannot be).
// `timer` stands in for setTimeout so the bounded wait can be fired at once.
function shellFlow(src = SHELL, net = { mode: 'up' }, timer = setTimeout) {
  const dom = runShell(src);
  dom.fr.src = 'about:blank';
  const fetchImpl = (p, opt) => {
    if (net.mode === 'down') return Promise.reject(new TypeError('Failed to fetch'));
    if (net.mode === 'hang') return new Promise(() => {});
    if (net.mode === 'empty') return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    const go = () => fetch(`http://127.0.0.1:${port}${p}`, opt);
    return net.delayMs ? new Promise((r) => setTimeout(r, net.delayMs)).then(go) : go();
  };
  const parts = [
    // api() prefixes API_BASE (the home node's name while the public one is away); the declaration must come
    // with it, or api() throws ReferenceError and refreshChatModels keeps an empty list (the silent catch).
    line(src, /^let API_BASE='';[^\n]*\nconst api=\(p,opt=\{\}\)=>.*$/m, 'the shell api with its API_BASE'),
    cut(src, 'let CHAT_MODELS=[];', '\nfunction applyShellFontScale(){', 'the model list block'),
    cut(src, 'const frameRef=()=>', '\n// Bound by CLASS', 'frameRef, frameSlug … sendAppPrefs'),   // frameRef: src, or data-app on the srcdoc route
    line(src, /^\$\('#fr'\)\.onload=.*$/m, "the frame's onload"),
    line(src, /^function openApp\(uid,slug,title\)\{.*$/m, 'openApp'),
    line(src, /^let SHELL_CURMODEL=null.*$/m, 'SHELL_CURMODEL'),
    line(src, /^function renderShellModelBtn\(\)\{.*$/m, 'renderShellModelBtn'),
    line(src, /^function renderShellVfy\(\)\{.*$/m, 'renderShellVfy'),
    line(src, /^\$\('#shellVfy'\)\.onclick=.*$/m, "the Verify pill's tap"),
    // Absent before the redraw existed; the behaviour tests below, not this slice, decide pass/fail.
    between(src, 'function syncShellModel(){', '\n}\n') || '',
    // A pick through the chooser's own menu handler, handed a tapped item for `id`.
    `function pick(id){ const menu={remove(){}};\n${line(src, /^\s*menu\.onclick=\(ev\)=>\{ const b=ev\.target\.closest\('\[data-m\]'\).*$/m, "the main chat chooser's pick")}
  menu.onclick({ target: { closest: () => ({ dataset: { m: id } }) } }); }`,
    `async function bootModels(){${cut(src, '  applyShellFontScale();   // the saved', '\n  // Fetch the profile', 'the boot model block')}\n}`,
  ];
  const stubs = {
    $: dom.$, fetch: fetchImpl, T: OWNER_TOKEN, ME: {}, UID: 'owner', setTimeout: timer,
    applyShellFontScale: () => {}, promoteApp: () => {}, closeDrawer: () => {}, shellBehindApp: dom.shellBehindApp,
    frameOwnBar: () => false, fsTitle: () => '',   // the app's own bar (ADR 0032): not under test here
    // openApp leaves the app before it, holding that page while it saves (web/app-frame.js). Not under
    // test here (test/app-leave.test.mjs runs it): these flows read only the prefs each app is sent, on one #fr.
    appFrameLeave: () => {},
    // openApp loads the frame through PASW (web/sw-client.js). The src route, as a browser online takes it; the
    // srcdoc route is test/offline-sw-client.test.mjs's.
    PASW: { frameLoad: (u, slug) => { dom.fr.src = `/app/${u}/${slug}/`; } },
    FS_STEPS: [1], fsIdx: 0, localStorage: { getItem: () => null }, RELAY_LIMITS: { upload: 1, chat: 1 }, _SEEN: new Set(), window: {},
  };
  // eslint-disable-next-line no-new-func
  const run = new Function(...Object.keys(stubs), `${parts.join('\n')}
return { bootModels, openApp, pick, models: () => CHAT_MODELS, cur: () => SHELL_CURMODEL, verifyOn: () => shellVerifyOn };`)(...Object.values(stubs));
  // An app opens: openApp sets the frame's src, then the browser fires the frame's load. The load
  // posts the pad prefs at once (no models) and the full prefs once the list settles; these flows
  // read the models, so the message under test is the LAST one that carries a list.
  const openAndLoad = async (slug) => {
    const n = dom.posted.length;
    run.openApp('owner', slug, slug);
    await dom.fr.onload();
    const since = dom.posted.slice(n).map((p) => p.m);
    assert.ok(since.length >= 1 && since.every((m) => m.pa === 'prefs'), `opening ${slug} posts pa:'prefs'`);
    const withList = since.filter((m) => Array.isArray(m.models));
    assert.equal(withList.length, 1, `opening ${slug} posts exactly one pa:'prefs' that carries the list`);
    return withList[0];
  };
  // The markup starts both pills hidden (style="display:none", which the stub does not parse), so
  // a pill counts as shown only once the shell's code sets display to ''.
  const pill = (id) => ({ label: dom.$(`#${id}`).textContent, shown: dom.$(`#${id}`).style.display === '' });
  return { ...run, net, openAndLoad, chooser: () => pill('shellModel'), verify: () => pill('shellVfy'), tapVerify: () => dom.$('#shellVfy').onclick() };
}

test('USER FLOW: a lane removed from /api/models after boot is gone from the next opened app', async (t) => {
  t.after(unretireAll);
  const s = shellFlow();
  await s.bootModels();
  // Control: the lane really was offered, to the shell and to the first app.
  assert.deepEqual(ids(s.models()), ['fast', 'old', 'deep', 'claude'], 'boot read the real server');
  assert.deepEqual(ids((await s.openAndLoad('notes')).models), ['fast', 'old', 'deep', 'claude'], 'the first app got the gone-to-be lane');

  retire('old-model:0731-cloud');   // a chat turn met a 410, days after this shell booted

  const next = await s.openAndLoad('bible');
  assert.deepEqual(ids(next.models), ['fast', 'deep', 'claude'], 'the next app no longer offers the retired lane');
});

test('a lane that comes back reappears in the next opened app too', async (t) => {
  t.after(unretireAll);
  retire('old-model:0731-cloud');
  const s = shellFlow();
  await s.bootModels();
  assert.deepEqual(ids((await s.openAndLoad('notes')).models), ['fast', 'deep', 'claude']);
  unretireAll();                    // a model-check run saw it answer
  assert.deepEqual(ids((await s.openAndLoad('notes')).models), ['fast', 'old', 'deep', 'claude']);
});

test('a failed refresh keeps the last good list: a dropped connection, and a refusal from the server', async () => {
  const s = shellFlow();
  await s.bootModels();
  const good = ['fast', 'old', 'deep', 'claude'];
  s.net.mode = 'down';
  assert.deepEqual(ids((await s.openAndLoad('notes')).models), good, 'offline: the last good list, not an empty one');
  assert.deepEqual(ids(s.models()), good, 'and the shell itself still holds it');

  // The real server refusing the request (an expired session) answers {error}, not a list.
  const refused = shellFlow();
  await refused.bootModels();
  await withWrongToken(async () => {
    assert.deepEqual(ids((await refused.openAndLoad('notes')).models), good, 'a 401 body never replaces the list');
  });
});

test("the app waits for the refresh openApp started, so its FIRST prefs carry the fresh list", async (t) => {
  // PAChat picks its lane from the first prefs message only (`if(!PAC_CURMODEL…)`), so a second,
  // corrected post would come too late. The frame's load must wait for the refresh.
  t.after(unretireAll);
  const s = shellFlow();
  await s.bootModels();
  retire('old-model:0731-cloud');
  s.net.delayMs = 150;              // the refresh lands after the frame's load event
  assert.deepEqual(ids((await s.openAndLoad('notes')).models), ['fast', 'deep', 'claude']);
});

test('a refresh that never answers does not hold the app: the wait is bounded, and the last good list goes', async () => {
  const fire = (fn) => { fn(); return 0; };   // the bound elapses at once
  const s = shellFlow(SHELL, { mode: 'up' }, fire);
  await s.bootModels();
  s.net.mode = 'hang';
  assert.deepEqual(ids((await s.openAndLoad('notes')).models), ['fast', 'old', 'deep', 'claude']);
});

test('SHELL_CURMODEL starts null; it is chosen only when the server offers models — at boot or at the first read that brings them', async () => {
  const offline = shellFlow(SHELL, { mode: 'down' });
  await offline.bootModels();
  assert.equal(offline.cur(), null, 'no models at boot: the main chat sends no model');
  assert.equal(offline.chooser().shown, false, 'and shows no chooser');
  offline.net.mode = 'up';
  assert.deepEqual(ids((await offline.openAndLoad('notes')).models), ['fast', 'old', 'deep', 'claude'], 'a later open fetches the list');
  assert.equal(offline.cur(), 'claude', 'and the main chat now stands where a load with models puts it');
  assert.deepEqual(offline.chooser(), { label: 'Claude ▾', shown: true }, 'its chooser is drawn with that lane');
  assert.equal(offline.verify().shown, true, 'and Verify appears with it');

  const online = shellFlow();
  await online.bootModels();
  assert.equal(online.cur(), 'claude', 'the boot default when models are offered');
  assert.deepEqual(online.chooser(), { label: 'Claude ▾', shown: true });
});

test("USER FLOW: a lane picked in the main chat that the server stops serving gives way to the boot default — label and lane", async (t) => {
  t.after(unretireAll);
  const s = shellFlow();
  await s.bootModels();
  s.pick('old');
  // Control: the pick took, so a reset below is the read's doing.
  assert.equal(s.cur(), 'old');
  assert.deepEqual(s.chooser(), { label: 'Old Model ▾', shown: true });

  retire('old-model:0731-cloud');
  await s.openAndLoad('notes');
  assert.equal(s.cur(), 'claude', 'the main chat no longer sends the gone lane');
  assert.deepEqual(s.chooser(), { label: 'Claude ▾', shown: true }, 'and its label names the lane it sends');
});

test('a lane picked in the main chat that is still served is kept, label and lane', async (t) => {
  t.after(unretireAll);
  const s = shellFlow();
  await s.bootModels();
  s.pick('fast');
  retire('old-model:0731-cloud');   // another lane goes
  await s.openAndLoad('notes');
  assert.equal(s.cur(), 'fast', 'a redraw must not throw away a pick the server still serves');
  assert.deepEqual(s.chooser(), { label: 'Fast One ▾', shown: true });
});

test('a read that returns no lanes: the main chat sends no lane and no Verify, and shows neither, as a load with no models does', async () => {
  const s = shellFlow();
  await s.bootModels();
  s.pick('fast');
  s.tapVerify();
  // Control: Verify really was on and shown, so "off and hidden" below is the read's doing.
  assert.equal(s.verifyOn(), true);
  assert.equal(s.verify().shown, true);
  s.net.mode = 'empty';
  assert.deepEqual((await s.openAndLoad('notes')).models, [], "a 200's empty list is the server's real answer");
  assert.equal(s.cur(), null, 'no lane is sent');
  assert.equal(s.chooser().shown, false, 'and no chooser is shown');
  // The composer sends `assess: shellVerifyOn`, so a Verify left on behind a hidden pill would keep
  // asking for a panel the user can no longer see or switch off.
  assert.equal(s.verifyOn(), false, 'Verify is switched off');
  assert.equal(s.verify().shown, false, 'and its pill is hidden');
});

// ── R14: each guard can fail ────────────────────────────────────────────────────────────────
const mutate = (from, to, src = SHELL) => { assert.ok(src.includes(from), `mutation target present: ${from}`); return src.replace(from, to); };
async function flowFails(src, flow) { await assert.rejects(flow(src), assert.AssertionError); }

test('MUTATION: openApp without the refresh — the retired lane comes back', async (t) => {
  t.after(unretireAll);
  await flowFails(mutate('refreshChatModels(); PASW.frameLoad(uid,slug);', 'PASW.frameLoad(uid,slug);'), async (src) => {
    const s = shellFlow(src); await s.bootModels(); retire('old-model:0731-cloud');
    assert.deepEqual(ids((await s.openAndLoad('bible')).models), ['fast', 'deep', 'claude']);
  });
});
test('MUTATION: the old onload, which does not wait — the first prefs carry the stale list', async (t) => {
  t.after(unretireAll);
  const onload = line(SHELL, /^\$\('#fr'\)\.onload=.*$/m, "the frame's onload");
  await flowFails(mutate(onload, "$('#fr').onload=sendAppPrefs;"), async (src) => {
    const s = shellFlow(src); await s.bootModels(); retire('old-model:0731-cloud'); s.net.delayMs = 150;
    assert.deepEqual(ids((await s.openAndLoad('notes')).models), ['fast', 'deep', 'claude']);
  });
});
test('MUTATION: the old boot read, which takes any answer — a refusal replaces the list', async () => {
  // The old read took the body of any answer and kept it, list or not.
  const oldRead = mutate('if(Array.isArray(list)){', 'if(list){', mutate('list=r.ok?await r.json():null;', 'list=await r.json();'));
  await flowFails(oldRead, async (src) => {
    const s = shellFlow(src); await s.bootModels();
    await withWrongToken(async () => {
      assert.deepEqual(ids((await s.openAndLoad('notes')).models), ['fast', 'old', 'deep', 'claude']);
    });
  });
});
test('MUTATION: a read without the redraw — the main chat keeps the gone lane and its label', async (t) => {
  t.after(unretireAll);
  await flowFails(mutate('CHAT_MODELS=list; syncShellModel();', 'CHAT_MODELS=list;'), async (src) => {
    const s = shellFlow(src); await s.bootModels(); s.pick('old'); retire('old-model:0731-cloud');
    await s.openAndLoad('notes');
    assert.deepEqual(s.chooser(), { label: 'Claude ▾', shown: true });
  });
});
test('MUTATION: a redraw that resets every pick — a lane still served is thrown away', async () => {
  await flowFails(mutate('if(!CHAT_MODELS.some(x=>x.id===SHELL_CURMODEL))', 'if(1)'), async (src) => {
    const s = shellFlow(src); await s.bootModels(); s.pick('fast');
    await s.openAndLoad('notes');
    assert.equal(s.cur(), 'fast');
  });
});
