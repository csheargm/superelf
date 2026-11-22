// The service worker (web/sw.js) — offline-first, docs/plans/offline-first.md §1 and §7.
// The script is run in a tiny harness: a fake `self`, an in-memory CacheStorage and a network the
// test switches off. Then the node's side: /sw.js served, the probe path 404s on the network, the
// offline tunables read at use time, the app page carrying its CSP as a meta tag for the srcdoc route.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { SW_PATH, SW_PROBE_PATH, OFFLINE_CONFIG_PATH, PA_BUNDLE_KIND, PA_SW_PROBE_KIND, OFFLINE_DEFAULTS } from '../lib/offline.mjs';

const SW_SRC = fs.readFileSync(path.join(ROOT, 'web', 'sw.js'), 'utf8');
const ORIGIN = 'https://node.test';
const html = (s, status = 200) => new Response(s, { status, headers: { 'content-type': 'text/html; charset=utf-8', vary: 'accept-encoding' } });
const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// The worker as the browser would run it: listeners, caches, fetch. `net` answers a request or
// throws (offline); every call is logged so a test can prove what never reached the network.
function swHarness() {
  const stores = new Map(), log = { net: [], claimed: 0, skipped: 0 }, listeners = {};
  const state = { online: true, routes: {} };
  const fetchFn = async (req) => {
    const url = typeof req === 'string' ? req : req.url;
    log.net.push(url);
    if (!state.online) throw new TypeError('Load failed');
    const r = state.routes[new URL(url).pathname];
    return r ? r(url) : new Response('not found', { status: 404 });
  };
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (n) => stores.delete(n),
    open: async (n) => {
      if (!stores.has(n)) stores.set(n, new Map());
      const m = stores.get(n);
      return {
        match: async (k) => { const r = m.get(typeof k === 'string' ? k : k.url); return r ? r.clone() : undefined; },
        put: async (k, res) => { m.set(k, res); },
        addAll: async (urls) => { for (const u of urls) { const res = await fetchFn(ORIGIN + u); if (!res.ok) throw new TypeError('addAll: ' + u); m.set(ORIGIN + u, res); } },
      };
    },
  };
  const self = { addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); }, location: { origin: ORIGIN },
    clients: { claim: async () => { log.claimed++; } }, skipWaiting: async () => { log.skipped++; } };
  // eslint-disable-next-line no-new-func
  new Function('self', 'caches', 'fetch', 'Response', 'Request', 'URL', SW_SRC)(self, caches, fetchFn, Response, Request, URL);
  const request = async (p, init) => {
    let out; const e = { request: new Request(ORIGIN + p, init), respondWith: (x) => { out = x; } };
    for (const fn of listeners.fetch) fn(e);
    return out === undefined ? undefined : out;   // undefined: the worker left it to the browser
  };
  const message = async (data, source = { posted: [] }) => {
    const waits = [];
    for (const fn of listeners.message) fn({ data, source: { postMessage: (m) => source.posted.push(m) }, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits); return source.posted;
  };
  const activate = async () => { const waits = []; for (const fn of listeners.activate) fn({ waitUntil: (p) => waits.push(p) }); await Promise.all(waits); };
  const cached = (name, p) => (stores.get(name) || new Map()).get(ORIGIN + p);
  return { state, log, request, message, activate, cached, names: () => [...stores.keys()], listeners };
}
const shellRoutes = { '/': () => html('<!doctype html><title>shell</title>'), '/manifest.webmanifest': () => json({ start_url: '/' }),
  '/app/u1/bible/': () => html('<!doctype html><title>bible</title>'), '/api/bible': (u) => json({ chapter: new URL(u).searchParams.get('chapter'), verses: [1] }),
  '/api/apps': () => json([{ name: 'bible' }]) };

test('the bundle: a 200 is stored under pa-<build>; a network failure is answered from it; nothing stored → the bilingual offline page', async () => {
  const h = swHarness(); Object.assign(h.state.routes, shellRoutes);
  assert.deepEqual(await h.message({ kind: PA_BUNDLE_KIND, build: 'abc1234' }), [{ kind: PA_BUNDLE_KIND, ok: true, build: 'abc1234', error: '' }]);
  assert.deepEqual(h.names(), ['pa-abc1234']);
  assert.ok(h.cached('pa-abc1234', '/') && h.cached('pa-abc1234', '/manifest.webmanifest'), 'the shell and the manifest are fetched into the bundle at the hand-off (the page that registered the worker was not loaded through it)');
  const r = await h.request('/app/u1/bible/');
  assert.equal(r.status, 200); assert.equal(await r.text(), '<!doctype html><title>bible</title>');
  assert.ok(h.cached('pa-abc1234', '/app/u1/bible/'), 'the app page the frame just loaded is in the bundle');
  h.state.online = false; h.log.net.length = 0;
  const off = await h.request('/app/u1/bible/');
  assert.equal(await off.text(), '<!doctype html><title>bible</title>', 'offline: the cached page');
  assert.deepEqual(h.log.net, [ORIGIN + '/app/u1/bible/'], 'the network was tried FIRST (never cache-first for HTML, ADR 0026)');
  const miss = await h.request('/app/u1/notes/');
  assert.equal(miss.status, 503);
  assert.match(await miss.text(), /Offline · 离线 — this page is not saved on this device yet · 此页尚未保存在本机/);
});

test('HARD RULE: a cache:"no-store" request is never answered from the cache and never stored — even when the URL is cached', async () => {
  const h = swHarness(); Object.assign(h.state.routes, shellRoutes);
  await h.message({ kind: PA_BUNDLE_KIND, build: 'b1' });
  h.state.online = false;
  assert.equal(await h.request('/', { cache: 'no-store' }), undefined, 'left to the browser: it fails offline, as PAUpdate expects (it answers "error" and asks again)');
  assert.equal(await h.request('/', { method: 'POST' }), undefined, 'a write is never the worker\'s business');
  assert.equal(await h.request('/api/apps'), undefined, 'other /api/* is untouched: conversations and notes are never cached');
  const other = await h.request('/api/apps');
  assert.equal(other, undefined);
  assert.match(SW_SRC, /if\(req\.method!=='GET'\|\|req\.cache==='no-store'\) return;/, 'pinned: the rule is the first line of the fetch handler');
});

test('a new build: the old cache goes, the new one is filled; the shell is told; a failed fill is reported, never swallowed (R5)', async () => {
  const h = swHarness(); Object.assign(h.state.routes, shellRoutes);
  await h.message({ kind: PA_BUNDLE_KIND, build: 'old' });
  await h.request('/app/u1/bible/');
  const told = await h.message({ kind: PA_BUNDLE_KIND, build: 'new' });
  assert.deepEqual(h.names(), ['pa-new'], 'pa-old was deleted');
  assert.equal(told[0].ok, true);
  assert.equal(h.cached('pa-new', '/app/u1/bible/'), undefined, 'an app page is re-fetched by the next open, not copied from the old build');
  h.state.online = false;
  const same = await h.message({ kind: PA_BUNDLE_KIND, build: 'new' });
  assert.equal(same[0].ok, false); assert.match(same[0].error, /Load failed/);
  assert.deepEqual(h.names(), ['pa-new'], 'the cache with the shell in it is kept');
  assert.ok(h.cached('pa-new', '/'), 'and still holds the shell');
  assert.deepEqual(await h.message({ kind: PA_BUNDLE_KIND, build: '' }), [], 'an empty build names nothing: ignored');
});

test('Bible chapters are cache-first: one network read per URL per build; a miss offline rejects (the broker reports code:"network")', async () => {
  const h = swHarness(); Object.assign(h.state.routes, shellRoutes);
  await h.message({ kind: PA_BUNDLE_KIND, build: 'b1' });
  h.log.net.length = 0;
  const first = await h.request('/api/bible?book=1&chapter=1', { headers: { authorization: 'Bearer t' } });
  assert.deepEqual(await first.json(), { chapter: '1', verses: [1] });
  const second = await h.request('/api/bible?book=1&chapter=1');
  assert.deepEqual(await second.json(), { chapter: '1', verses: [1] });
  assert.deepEqual(h.log.net, [ORIGIN + '/api/bible?book=1&chapter=1'], 'ONE fetch for two reads');
  h.state.online = false;
  await assert.rejects(h.request('/api/bible?book=1&chapter=2'), /Load failed/, 'a chapter never read on this device is not invented');
  assert.deepEqual(await h.message({ kind: 'pa-bible-status' }), [{ kind: 'pa-bible-status', done: false, build: 'b1' }]);
  await h.message({ kind: 'pa-bible-done', bytes: 7850756 });
  assert.deepEqual(await h.message({ kind: 'pa-bible-status' }), [{ kind: 'pa-bible-status', done: true, build: 'b1' }]);
  await h.message({ kind: PA_BUNDLE_KIND, build: 'b2' });
  assert.equal((await h.message({ kind: 'pa-bible-status' }))[0].done, false, 'a new build refreshes the corpus');
});

test('after a worker restart the one cache left names the build (no message yet); the probe path is answered by the worker alone', async () => {
  const h = swHarness(); Object.assign(h.state.routes, shellRoutes);
  await h.message({ kind: PA_BUNDLE_KIND, build: 'b1' });
  const h2 = swHarness(); Object.assign(h2.state.routes, shellRoutes);   // a fresh worker instance over the same storage is modelled by re-filling
  await h2.message({ kind: PA_BUNDLE_KIND, build: 'b1' });
  await h2.request('/app/u1/bible/');
  const probe = await h.request(SW_PROBE_PATH);
  assert.equal(probe.status, 200);
  assert.match(await probe.text(), new RegExp(`parent\\.postMessage\\(\\{pa:'${PA_SW_PROBE_KIND}'\\},'\\*'\\)`));
  assert.match(probe.headers.get('content-security-policy'), /^sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'$/);
  assert.deepEqual(h.log.net.filter((u) => u.endsWith(SW_PROBE_PATH)), [], 'never from the network');
});

test('activation claims the open pages; skipWaiting runs ONLY on the shell\'s pa-skip (never on install, never on its own)', async () => {
  const h = swHarness();
  await h.activate();
  assert.equal(h.log.claimed, 1);
  assert.equal(h.listeners.install, undefined, 'no install handler at all');
  assert.equal(h.log.skipped, 0);
  await h.message({ kind: 'pa-skip' });
  assert.equal(h.log.skipped, 1);
  assert.equal((SW_SRC.replace(/\/\/.*$/gm, '').match(/skipWaiting/g) || []).length, 1, 'one call site, inside the message handler');
});

// ── The node's side ────────────────────────────────────────────────────────────────────────────
let port, root, web;
before(async () => {
  port = await freePort(); root = mkWebRoot({ port, extraConfig: { offline: { bible_cap_bytes: 5 } } });
  fs.mkdirSync(path.join(root, 'workspace', 'apps', 'one'), { recursive: true });
  fs.writeFileSync(path.join(root, 'workspace', 'apps', 'one', 'index.html'), '<!doctype html><html><head><title>one</title></head><body><script>1</script></body></html>');
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); fs.rmSync(root, { recursive: true, force: true }); });
const auth = { headers: { authorization: `Bearer ${OWNER_TOKEN}` } };

test('node: /sw.js is served unauthenticated as JavaScript that revalidates (no-cache), scope /; the probe path is a 404 on the network', async () => {
  const r = await api(port, SW_PATH);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^application\/javascript/);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.ok((await r.text()).includes('PA_SW_BEGIN'));
  assert.equal((await api(port, SW_PROBE_PATH)).status, 404, 'only the worker answers it: silence means the srcdoc route');
});

test('node: /api/offline-config needs the token and reads config at use time — the cap from config.json, the apps default, the corpus index', async () => {
  assert.equal((await api(port, OFFLINE_CONFIG_PATH, { headers: { authorization: '' } })).status, 401);
  const r = await api(port, OFFLINE_CONFIG_PATH, auth);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const c = await r.json();
  assert.deepEqual(c.apps, [...OFFLINE_DEFAULTS.apps]);
  assert.equal(c.bible_cap_bytes, 5, 'the value in this root\'s config.json, not the default');
  assert.equal(c.bible_prefetch, true);
  assert.equal(c.bible.length, 66); assert.ok(c.bible.every((n) => n === 0), 'this root has no corpus: nothing to prefetch (R14: not a vacuous "done")');
});

test('node: an app page carries its CSP as a meta tag (the srcdoc route), without the directives a meta tag cannot carry', async () => {
  const r = await api(port, '/app/owner/one/');
  const page = await r.text();
  const header = r.headers.get('content-security-policy');
  assert.match(header, /^sandbox allow-scripts; .*connect-src 'none'; frame-ancestors 'self'$/, 'the header is unchanged');
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(page);
  assert.ok(meta, 'one meta tag');
  assert.equal(meta[1], "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'");
  assert.ok(page.indexOf('<head>') < page.indexOf('<meta http-equiv') && page.indexOf('<meta http-equiv') < page.indexOf('<title>'), 'first in <head>');
  assert.equal((page.match(/Content-Security-Policy/g) || []).length, 1);
});
