// PAOrigin (web/offline-origin.js) — the home-node fallback, docs/plans/offline-first.md §6: the
// broker's api() base switches to config `local_origin` ONLY when the public name fails /api/build
// and the local one answers the SAME build; never on a different build, never while the public
// name answers; back to the public name once it is heard again. Then the broker as shipped
// (helpers-shell-broker) between two stand-in nodes over real HTTP, and the node's side: the CORS
// pairing (lib/local-origin.mjs) on the real web.mjs, local_origin in /api/offline-config, the
// config gate. Timers are stubbed (fakeClock); nothing here waits on a real setTimeout.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { SHELL, ORIGIN_CORE, loadShellBroker } from './helpers-shell-broker.mjs';
import { fakeIndexedDB, lineStub, standInNode, settle } from './helpers-offline.mjs';
import { fakeClock } from './helpers-sandbox-app.mjs';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { localOriginSetting, corsHeaders } from '../lib/local-origin.mjs';
import { CONFIG_FIELDS } from '../lib/adminconfig.mjs';
import { OFFLINE_CONFIG_PATH } from '../lib/offline.mjs';

// eslint-disable-next-line no-new-func
const { makeOrigin, ORIGIN_NOTE_MS } = new Function(`${ORIGIN_CORE}\nreturn { makeOrigin, ORIGIN_NOTE_MS };`)();
const LOCAL = 'https://mac.local:8787';
const FOOTER = '管家 · v1.0.0+3 · b1';   // the footer line PAUpdate/PASW read: the build is its tail

// makeOrigin on fakes: `nodes` maps an origin ('' = public) to the /api/build answer or null (away).
function unit({ nodes, local = LOCAL, loaded = 'b1' }) {
  const clock = fakeClock(), bases = [], states = [];
  const o = makeOrigin({ fetchBuild: async (origin) => nodes[origin] || null, localOrigin: () => local, loadedBuild: () => loaded,
    setBase: (b) => bases.push(b), state: (p) => states.push(p), setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  return { o, clock, bases, states };
}

test('public answers: reachable, no switch — even with a local name of the same build on offer', async () => {
  const u = unit({ nodes: { '': { build: 'b1' }, [LOCAL]: { build: 'b1' } } });
  assert.equal(await u.o.reachable(), true);
  assert.deepEqual(u.bases, [], 'the base never moved');
  assert.deepEqual(u.states, [], 'nothing on the line');
  assert.equal(u.o.status().last, 'public');
});

test('public fails, local answers the same build: the base switches once, the line says Home node for ORIGIN_NOTE_MS', async () => {
  const u = unit({ nodes: { [LOCAL]: { build: 'b1' } } });
  assert.equal(await u.o.reachable(), true);
  assert.deepEqual(u.bases, [LOCAL]);
  assert.deepEqual(u.states, [{ home: true }]);
  assert.equal(u.o.base(), LOCAL);
  assert.equal(await u.o.reachable(), true, 'asked again while still on the home name');
  assert.deepEqual(u.bases, [LOCAL], 'no second switch, no second note');
  u.clock.advance(ORIGIN_NOTE_MS - 1);
  assert.deepEqual(u.states, [{ home: true }], 'still on the line');
  u.clock.advance(1);
  assert.deepEqual(u.states, [{ home: true }, { home: false }], 'then gone');
});

test('public fails, local answers a DIFFERENT build: never switched, and a base already on it is dropped', async () => {
  const u = unit({ nodes: { [LOCAL]: { build: 'b2' } } });
  assert.equal(await u.o.reachable(), false);
  assert.deepEqual(u.bases, []);
  assert.equal(u.o.status().last, 'different-build');
  const nodes = { [LOCAL]: { build: 'b1' } };
  const w = unit({ nodes });
  assert.equal(await w.o.reachable(), true); assert.equal(w.o.base(), LOCAL);
  nodes[LOCAL] = { build: 'b2' };   // the node updated under the session, the public name still away
  assert.equal(await w.o.reachable(), false);
  assert.equal(w.o.base(), '', 'dropped: a different build is not this session\'s node');
  assert.deepEqual(w.bases, [LOCAL, '']);
});

test('a base on the home name goes back to the public name the moment it answers; no local name or no build → unreachable, untouched', async () => {
  const nodes = { [LOCAL]: { build: 'b1' } };
  const u = unit({ nodes });
  assert.equal(await u.o.reachable(), true);
  assert.equal(u.o.base(), LOCAL);
  nodes[''] = { build: 'b1' };
  assert.equal(await u.o.reachable(), true);
  assert.equal(u.o.base(), '', 'back on the public name');
  assert.deepEqual(u.bases, [LOCAL, '']);
  const none = unit({ nodes: { [LOCAL]: { build: 'b1' } }, local: '' });
  assert.equal(await none.o.reachable(), false); assert.equal(none.o.status().last, 'no-local'); assert.deepEqual(none.bases, []);
  const away = unit({ nodes: {} });
  assert.equal(await away.o.reachable(), false); assert.equal(away.o.status().last, 'local-away');
  const noBuild = unit({ nodes: { [LOCAL]: { build: 'b1' } }, loaded: '' });
  assert.equal(await noBuild.o.reachable(), false, 'a page that does not know its build never switches (fail closed)'); assert.deepEqual(noBuild.bases, []);
});

test('the shell as served: api() prefixes API_BASE with the same Bearer; PAOrigin sits before PASync; PAUpdate still asks the public name', () => {
  const API = /^let API_BASE='';[^\n]*\nconst api=[^\n]*$/m.exec(SHELL)[0];
  const calls = [];
  // eslint-disable-next-line no-new-func
  const fn = new Function('fetch', 'T', `${API}\nreturn { api, set:(b)=>{ API_BASE=b; } };`)((u, o) => { calls.push([u, o.headers.authorization]); }, 'tok');
  fn.api('/api/build'); fn.set(LOCAL); fn.api('/api/save-data', { headers: { 'content-type': 'application/json' } }); fn.set(''); fn.api('/api/x');
  assert.deepEqual(calls, [['/api/build', 'Bearer tok'], [LOCAL + '/api/save-data', 'Bearer tok'], ['/api/x', 'Bearer tok']]);
  const at = (m) => SHELL.indexOf(m);
  assert.ok(at('/* ══ PA_OFFLINE_END ══ */') < at('/* ══ PA_ORIGIN_BEGIN ══ */') && at('/* ══ PA_ORIGIN_END ══ */') < at('/* ══ PA_SYNC_BEGIN ══ */'), 'PAOffline, PAOrigin, then PASync');
  assert.match(SHELL, /fetchJson:async\(p\)=>\{ const r=await fetch\(p,\{cache:'no-store'\}\)/, 'PAUpdate fetches /api/build on this page\'s origin, not through api(): a build seen only on the home name must never reload the page');
  assert.match(SHELL, /fetchBuild:async\(o\)=>\{ try\{ const r=await fetch\(o\+ORIGIN_BUILD_URL,\{cache:'no-store'\}\)/, 'the question is never answered from a cache (web/sw.js hard rule)');
  assert.match(SHELL, /localOrigin:\(\)=>\{ const v=PASW\.recall\(OFF_LOCAL_ORIGIN_KEY\);/, 'the remembered config value');
  assert.match(SHELL, /if\(typeof cfg\.local_origin==='string'\) d\.remember\(OFF_LOCAL_ORIGIN_KEY,cfg\.local_origin\);/, 'remembered on every online read of the config');
  assert.equal(SHELL.split("'家中节点 · Home node'").length, 2, 'the sentence is written once (R3)');
});

// ── The broker as shipped (R6): the public name dead, the home name up — a queued save drains to the
// home name, the next save goes there directly with the same Bearer, the public name takes over again.
const nb = (updated) => JSON.stringify({ v: 3, id: 'n1', created: 1, updated, template: 'plain', pages: [{ id: 'p', created: 1, updated, strokes: [], pageHtml: 'x', images: [] }] });
async function deadPort() { const n = standInNode(new Map()); const port = await n.listen(); await n.close(); return port; }
const broker = (publicUrl, localUrl, { footer = FOOTER } = {}) => {
  const f = fakeIndexedDB(), line = lineStub(), clock = fakeClock();
  const B = loadShellBroker(publicUrl, { app: 'notes', timers: clock, offline: { idb: f.idb, line, footer, recall: (k) => (k === 'pa_local_origin' ? localUrl : null) } });
  return { B, f, line, clock };
};

test('broker flow: public dead, home name up with the same build → the drain lands there, the line says Home node, later saves go there with the Bearer; public back → base restored', async () => {
  const port = await deadPort(), publicUrl = `http://127.0.0.1:${port}`;
  const local = standInNode(new Map()); const localUrl = `http://127.0.0.1:${await local.listen()}`;
  try {
    const { B, line, clock } = broker(publicUrl, localUrl);
    await B.post({ id: 1, kind: 'save-data', path: 'entry-e1.json', data: nb(10) }); await settle();
    assert.equal(B.reply(1).offline, true, 'the public name refused the connection: queued');
    assert.equal(line.textContent, '离线 · Offline — 保存在本设备 · saving on this device · 请检查 Tailscale 或节点 · check Tailscale or the node · 待同步 1 · 1 to sync');
    B.triggers.online[0](); await settle(200);
    assert.deepEqual(local.posts, ['data/notes/entry-e1.json'], 'the queued save went to the home name');
    assert.equal(local.auth, 'Bearer test-token', 'the same session token');
    assert.equal(B.base(), localUrl);
    assert.equal(line.textContent, '家中节点 · Home node');
    clock.advance(ORIGIN_NOTE_MS); assert.equal(line.textContent, '', 'briefly');
    await B.post({ id: 2, kind: 'save-data', path: 'entry-e1.json', data: nb(20) }); await settle();
    assert.equal(B.reply(2).ok, true); assert.equal(B.reply(2).offline, undefined, 'saved on the node, not queued');
    assert.deepEqual(local.posts, ['data/notes/entry-e1.json', 'data/notes/entry-e1.json']);
    await B.post({ id: 3, kind: 'data', path: 'entry-e1.json' }); await settle();
    assert.equal(JSON.parse(B.reply(3).text).updated, 20, 'reads too');
    // The public name answers again. The base stays on the home name for the session (the drain asks
    // only when something is queued); when the home name goes away too, the next queued save's drain
    // hears the public name first and goes back to it.
    const pub = standInNode(new Map()); await pub.listen(port);
    try {
      await B.post({ id: 4, kind: 'save-data', path: 'entry-e1.json', data: nb(30) }); await settle();
      assert.equal(B.base(), localUrl, 'nothing queued: no question asked, the session stays on the home name');
      assert.equal(local.posts.length, 3); assert.deepEqual(pub.posts, []);
      await local.close();
      await B.post({ id: 5, kind: 'save-data', path: 'entry-e1.json', data: nb(40) }); await settle();
      assert.equal(B.reply(5).offline, true, 'the home name gone too: queued');
      B.triggers.visible[0](); await settle(200);
      assert.equal(B.base(), '', 'the public name answered first: back to it');
      assert.deepEqual(pub.posts, ['data/notes/entry-e1.json']); assert.equal(B.origin.status().last, 'public');
    } finally { await pub.close(); }
  } finally { await local.close().catch(() => { /* already closed above on the happy path */ }); }
});

test('broker flow: a home name with a DIFFERENT build is never used (the save stays queued, the line stays Offline); no name remembered → the same', async () => {
  const publicUrl = `http://127.0.0.1:${await deadPort()}`;
  const other = standInNode(new Map(), { build: 'b2' }); const otherUrl = `http://127.0.0.1:${await other.listen()}`;
  try {
    const { B, line, f } = broker(publicUrl, otherUrl);
    await B.post({ id: 1, kind: 'save-data', path: 'entry-e1.json', data: nb(10) }); await settle();
    assert.equal(await B.sync.drain(), 'unreachable');
    assert.deepEqual(other.posts, []); assert.equal(B.base(), ''); assert.equal(B.origin.status().last, 'different-build');
    assert.equal(line.textContent, '离线 · Offline — 保存在本设备 · saving on this device · 请检查 Tailscale 或节点 · check Tailscale or the node · 待同步 1 · 1 to sync');
    assert.equal(f.rows('pa-offline', 'writes').length, 1);
    const { B: C } = broker(publicUrl, null);
    await C.post({ id: 1, kind: 'save-data', path: 'entry-e1.json', data: nb(10) }); await settle();
    assert.equal(await C.sync.drain(), 'unreachable'); assert.equal(C.origin.status().last, 'no-local'); assert.equal(C.base(), '');
  } finally { await other.close(); }
});

test('broker flow: while the public name answers, a home name of the same build is never asked', async () => {
  const pub = standInNode(new Map()); const publicUrl = `http://127.0.0.1:${await pub.listen()}`;
  const local = standInNode(new Map()); const localUrl = `http://127.0.0.1:${await local.listen()}`;
  try {
    const { B } = broker(publicUrl, localUrl);
    await B.post({ id: 1, kind: 'save-data', path: 'entry-e1.json', data: nb(10) }); await settle();
    assert.equal(B.reply(1).offline, undefined);
    assert.equal(await B.sync.drain(), 'empty'); assert.equal(B.base(), '');
    assert.deepEqual(pub.posts, ['data/notes/entry-e1.json']); assert.deepEqual(local.posts, []); assert.equal(local.auth, '');
  } finally { await pub.close(); await local.close(); }
});

// ── The node: the CORS pairing on the real web.mjs, local_origin served, the config gate.
const PUB = 'https://node.example.net';
let port, root, web;
before(async () => { port = await freePort(); root = mkWebRoot({ port, extraConfig: { public_base_url: PUB, local_origin: `http://127.0.0.1:${port}` } }); web = startWeb(root); await waitReady(port); });
after(async () => { if (web) await stopWeb(web); });
// node:http, so the Host header can be set (fetch owns it).
const raw = (method, p, headers = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
  r.on('error', reject); r.end();
});

test('node: the preflight and the headers answer ONLY the pairing (Origin = public_base_url, Host = local_origin); everything else is as before', async () => {
  const pre = await raw('OPTIONS', '/api/save-data', { origin: PUB, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers['access-control-allow-origin'], PUB);
  assert.match(pre.headers['access-control-allow-headers'], /authorization/);
  assert.match(pre.headers['access-control-allow-headers'], /content-encoding/, 'relayCall\'s gzip-packed saves');
  assert.match(pre.headers['access-control-allow-methods'], /\bPOST\b/);
  assert.equal(pre.headers.vary, 'origin');
  const build = await raw('GET', '/api/build', { origin: PUB });
  assert.equal(build.status, 200); assert.equal(build.headers['access-control-allow-origin'], PUB);
  assert.equal(JSON.parse(build.body).build.length > 0, true);
  const data = await raw('GET', '/api/offline-config', { origin: PUB, authorization: `Bearer ${OWNER_TOKEN}` });
  assert.equal(data.status, 200); assert.equal(data.headers['access-control-allow-origin'], PUB, 'an authenticated JSON answer carries it too');
  const other = await raw('GET', '/api/build', { origin: 'https://evil.example' });
  assert.equal(other.status, 200); assert.equal(other.headers['access-control-allow-origin'], undefined, 'another origin: no CORS');
  const wrongHost = await raw('GET', '/api/build', { origin: PUB, host: `localhost:${port}` });
  assert.equal(wrongHost.headers['access-control-allow-origin'], undefined, 'the request did not arrive on the local name');
  const sameOrigin = await raw('GET', '/api/build');
  assert.equal(sameOrigin.headers['access-control-allow-origin'], undefined, 'no Origin: a same-origin call, untouched');
  const strayPreflight = await raw('OPTIONS', '/api/save-data', { origin: 'https://evil.example' });
  assert.notEqual(strayPreflight.status, 204, 'a preflight outside the pairing is not answered');
});

test('node: /api/offline-config carries local_origin (read at use time); the config gate; the settings row', async () => {
  const r = await api(port, OFFLINE_CONFIG_PATH);
  assert.equal((await r.json()).local_origin, `http://127.0.0.1:${port}`);
  assert.equal(localOriginSetting(undefined), ''); assert.equal(localOriginSetting(''), '');
  assert.equal(localOriginSetting('https://mac.local:8787/'), 'https://mac.local:8787', 'the trailing slash dropped');
  for (const bad of ['mac.local', 'ftp://x', 'https://x/?q=1', 'https://u:p@x', 42]) assert.throws(() => localOriginSetting(bad), /local_origin/, `refused: ${bad}`);
  const cfg = { local_origin: 'https://mac.local:8787', public_base_url: PUB };
  assert.equal(corsHeaders({ headers: { origin: PUB, host: 'mac.local:8787' } }, cfg)['access-control-allow-origin'], PUB);
  assert.equal(corsHeaders({ headers: { origin: PUB, host: 'mac.local:8787' } }, { ...cfg, public_base_url: '' }), null, 'no public name configured: no pairing');
  assert.equal(corsHeaders({ headers: { origin: PUB, host: 'mac.local:8787' } }, { ...cfg, local_origin: '' }), null, 'no local name configured: no pairing');
  const row = CONFIG_FIELDS.find((f) => f.key === 'local_origin');
  assert.ok(row && row.kind === 'value' && row.boot === false, 'editable from Node settings, applied without a restart');
  assert.equal(row.validate('https://mac.local:8787/'), 'https://mac.local:8787');
  assert.throws(() => row.validate('not a url'), /基址无效/);
});
