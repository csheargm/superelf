// /api/build and the HTML freshness rule (docs/adr/0026), on the real web.mjs.
//
// The shell's PAUpdate (web/update.js) asks /api/build to learn whether the node runs a newer
// build than the page it loaded with. HTML must say no-cache so a reload actually fetches it: an
// iPad's home-screen page lives for days and a heuristically cached page would "reload" to itself.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api } from './helpers-web.mjs';

let port, root, web;
before(async () => { port = await freePort(); root = mkWebRoot({ port }); web = startWeb(root); await waitReady(port); });
after(async () => { if (web) await stopWeb(web); });

test('GET /api/build: {build, version}, no auth (the shell page carries the same strings), no-store, nothing else', async () => {
  const r = await api(port, '/api/build');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store', 'never answered from a cache: the point is freshness');
  const j = await r.json();
  assert.deepEqual(Object.keys(j).sort(), ['build', 'version'], 'no other field — this route is unauthenticated');
  assert.equal(typeof j.build, 'string');
  assert.match(j.version, /^v\d+\.\d+\.\d+(\+\d+)?/, 'v<package>[+N] …');
  const shell = await (await api(port, '/')).text();
  assert.ok(shell.includes(`管家 · ${j.version}`), 'the footer the page loaded with is the string PAUpdate compares against');
});

test('every HTML answer says no-cache (revalidate each load); JSON stays no-store', async () => {
  fs.mkdirSync(`${root}/workspace/apps/one`, { recursive: true });
  fs.writeFileSync(`${root}/workspace/apps/one/index.html`, '<!doctype html><body><script>1</script></body>');
  for (const p of ['/', '/app/owner/one/']) {
    const r = await api(port, p);
    assert.equal(r.status, 200, p);
    assert.equal(r.headers.get('cache-control'), 'no-cache', `${p} is code: a reload must ask the server`);
  }
  assert.equal((await api(port, '/api/setup-status')).headers.get('cache-control'), 'no-store', 'CONTROL: JSON is unchanged');
  const web = fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8');
  assert.match(web, /const head = \{ 'cache-control': 'no-cache', etag, \.\.\.extra \};/, 'sendHtml() is the ONE source of the header (R3)');
  const direct = web.match(/\bsend\(res, \d+, 'text\/html[^\n]*/g) || [];
  assert.deepEqual(direct.map((l) => l.trim()), ["send(res, 200, 'text/html; charset=utf-8', html, head);"], 'the only direct text/html send() is sendHtml\'s own, so no HTML path can skip the header');
});
