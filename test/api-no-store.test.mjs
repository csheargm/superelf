// Personal data must never be cacheable by the browser · 个人数据不得被浏览器缓存
//
// SCAR: a laptop showed no conversations from the previous day. The server had them — the API
// returned all 12 — and the same account on a phone listed them correctly. Pressing Refresh on the
// laptop did nothing, because the fetch never reached the server: /api/* carried NO freshness
// information at all (no cache-control, no expires, no last-modified), which entitles a browser to
// cache the response heuristically, and one did.
//
// It is a privacy rule as much as a correctness one: notes, chats and health data should not be
// sitting in the disk cache of a shared family laptop.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';

let port, root, web;
before(async () => { port = await freePort(); root = mkWebRoot({ port }); web = startWeb(root); await waitReady(port); });
after(async () => { if (web) await stopWeb(web); });

const head = async (p) => (await api(port, p, { headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).headers;

test('every JSON API response says no-store', async () => {
  // A spread of routes that return the household's own data — a list, a single record, and a
  // settings surface — so this is not pinned to one lucky handler.
  for (const p of ['/api/jobs', '/api/profile', '/api/app-convos?app=bible', '/api/jobs/files']) {
    const h = await head(p);
    assert.equal(h.get('cache-control'), 'no-store', `${p} must not be cacheable`);
  }
});

test('CONTROL: the rule is type-scoped, not a blanket applied to everything', async () => {
  // If no-store were simply stamped on every response, the assertion above would pass while
  // telling us nothing about JSON specifically — and it would also stop the shell revalidating.
  const shell = await head('/');
  assert.equal(shell.get('cache-control'), 'no-cache',
    'the shell still revalidates with its ETag rather than being re-downloaded every time');
  const mani = await head('/manifest.webmanifest');
  assert.notEqual(mani.get('cache-control'), 'no-store', 'a static manifest is not personal data');
});

test('a route may still set its own cache-control', async () => {
  // The default is placed BEFORE the per-route overrides, so a route that deliberately wants
  // different caching is not silently overruled by this change.
  const web2 = await import('node:fs').then((fs) => fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8'));
  assert.match(web2, /\.\.\.\(type === 'application\/json' \? \{ 'cache-control': 'no-store' \} : \{\}\),[\s\S]{0,200}\.\.\.extra \}/,
    'the JSON default is spread before ...extra, so an explicit header still wins');
});
