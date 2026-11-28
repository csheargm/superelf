// 试用 · Try it, the server side (docs/adr/0049, lib/selfpub/try.mjs): owner only, an owner-issued
// short-lived token is the only key, the page is walled by a sandbox CSP whose connect-src is the fake
// API path alone, and every /api/* under the token answers the fixed fake data — on a real node (web.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { selfpubFixture, tgit } from './helpers-selfpub.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { putChange, PENDING } from '../lib/selfpub/state.mjs';
import { takeSnapshot, snapshotMb, DEFAULT_TRY_SNAPSHOT_MB } from '../lib/selfpub/try-snapshot.mjs';
import { treeHash } from '../lib/selfpub/checkout.mjs';
import { issueTry, lookupTry, forgetTries, MAX_TRY_TOKENS, MAX_TRY_MINUTES, pageCsp, wrapperCsp, tryMinutes, DEFAULT_TRY_MINUTES } from '../lib/selfpub/try.mjs';
import { FAKE_API } from '../lib/selfpub/preview-page.mjs';

const MEMBER_TOKEN = 'test-member-token-0123456789abcdef';
const ID = 'tryab1', BRANCH = `self/20261127-${ID}`, MARK = 'try-change-mark-1127';
let port, root, web, fx, sroot, repo;
const call = (p, { token = OWNER_TOKEN, ...o } = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...o, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(o.headers || {}) } });
const issue = async (token = OWNER_TOKEN) => call(`/api/selfpub/${ID}/try`, { method: 'POST', body: '{}', token });
const setState = (state) => putChange(sroot, ID, { state });

before(async () => {
  fx = selfpubFixture({ web: true });
  sroot = fx.root; repo = path.join(sroot, 'repo');
  fs.mkdirSync(sroot, { recursive: true }); tgit(sroot, 'clone', '-q', fx.bare, repo); tgit(repo, 'checkout', '-qb', BRANCH);
  fs.appendFileSync(path.join(repo, 'web', 'home-v2.css'), `\n/* ${MARK} */\n`);
  putChange(sroot, ID, { who: 'owner', convo: 'c1', state: 'ready', branch: BRANCH, verifiedHash: treeHash(repo) });
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { selfpub_root: sroot, users: [{ id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
    { id: 'kid', name: 'Kid', role: 'member', token: MEMBER_TOKEN, workspace: 'workspace-kid' }] } });
  fs.mkdirSync(path.join(root, 'workspace-kid'));
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); if (root) rmTemp(root); if (fx) rmTemp(fx.d); });

test('a member, a signed-out caller and a wrong owner get no preview token', async () => {
  assert.equal((await issue(MEMBER_TOKEN)).status, 403);
  assert.equal((await issue('')).status, 401);
  assert.equal((await call('/api/selfpub/zzzz9/try', { method: 'POST', body: '{}' })).status, 404, 'no such change');
  assert.equal((await call(`/api/selfpub/${ID}/try`)).status, 405, 'GET is not a try');
});

test('the owner gets a token URL; the wrapper is sandboxed, script-free, and frames only the page path', async () => {
  const r = await issue(); assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.url, /^\/selfpub-try\/[a-f0-9]{48}\/$/); assert.equal(j.minutes, DEFAULT_TRY_MINUTES);
  assert.doesNotMatch(JSON.stringify(j), new RegExp(OWNER_TOKEN), 'never the session');
  const w = await call(j.url, { token: '' });
  assert.equal(w.status, 200);
  const csp = w.headers.get('content-security-policy');
  assert.match(csp, /^sandbox allow-scripts;/); assert.match(csp, /script-src 'none'/); assert.match(csp, /frame-ancestors 'self'/);
  assert.match(csp, new RegExp(`frame-src http://127\\.0\\.0\\.1:${port}${j.url}page/ https://127\\.0\\.0\\.1:${port}${j.url}page/;`), 'with schemes: WebKit matches a scheme-less source in an opaque document against nothing (R13 WebKit run)');
  const html = await w.text();
  assert.match(html, /<iframe sandbox="allow-scripts"/); assert.doesNotMatch(html, /allow-same-origin|<script/);
});

test('the page: the copy\'s shell + preamble, CSP sandbox with connect-src = the fake API path only', async () => {
  const { url } = await (await issue()).json();
  const r = await call(`${url}page/`, { token: '' });
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy'), connect = csp.split('; ').find((d) => d.startsWith('connect-src'));
  assert.equal(connect, `connect-src http://127.0.0.1:${port}${url}page/api/ https://127.0.0.1:${port}${url}page/api/`);
  assert.doesNotMatch(csp, /[ ;]127\.0\.0\.1:/, 'no scheme-less source anywhere (WebKit refuses them in an opaque document)');
  assert.match(csp, /^sandbox allow-scripts;/); assert.match(csp, /default-src 'none'/); assert.match(csp, /frame-src 'none'/); assert.match(csp, /form-action 'none'/);
  assert.doesNotMatch(csp, /'self'|\*|allow-same-origin/, 'no wildcard, no self: the real /api is not reachable');
  const html = await r.text();
  assert.match(html, new RegExp(MARK), 'the copy, not the node'); assert.match(html, /localStorage\.setItem\('pa_session','preview'\)/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await call(`${url}page/web/home-v2.css`, { token: '' })).status, 200);
  for (const bad of ['page/web/../../config.json', 'page/web/%2e%2e/%2e%2e/state.json', 'page/web/%E0%A4%A', 'page/other'])
    assert.equal((await call(url + bad, { token: '' })).status, 404, bad);
});

test('every /api/* under the token is the fixed fake owner, whatever the method or header; CORS preflight answers', async () => {
  const { url } = await (await issue()).json();
  const ping = await call(`${url}page/api/ping`, { token: '' });
  assert.deepEqual(await ping.json(), FAKE_API['/api/ping']); assert.equal(ping.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await (await call(`${url}page/api/profile`)).json(), FAKE_API['/api/profile'], 'the owner\'s Bearer changes nothing');
  const put = await call(`${url}page/api/profile`, { method: 'PUT', body: JSON.stringify({ name: 'Hacked' }) });
  assert.equal(put.status, 200); assert.deepEqual(await put.json(), FAKE_API['/api/profile']);
  assert.equal((await call('/api/profile')).status, 200);
  assert.notEqual((await (await call('/api/profile')).json()).name, 'Hacked', 'nothing real was written');
  const pre = await call(`${url}page/api/profile`, { method: 'OPTIONS', token: '', headers: { origin: 'null', 'access-control-request-method': 'PUT' } });
  assert.equal(pre.status, 204); assert.match(pre.headers.get('access-control-allow-headers'), /authorization/);
  assert.equal(pre.headers.get('access-control-allow-credentials'), null, 'never with credentials');
});

test('a made-up, expired or finished-change token is a 404; a change not waiting cannot be tried', async () => {
  assert.equal((await call(`/selfpub-try/${'a'.repeat(48)}/`, { token: '' })).status, 404);
  assert.equal((await call('/selfpub-try/short/', { token: '' })).status, 401, 'not a token shape: the ordinary auth wall');
  const { url } = await (await issue()).json();
  setState('publishing');
  try {
    assert.equal((await call(url, { token: '' })).status, 404, 'a change on its way is no longer previewed');
    const r = await issue(); assert.equal(r.status, 409); assert.equal((await r.json()).code, 'NOT_PENDING');
  } finally { setState('ready'); }
  assert.equal((await call(url, { token: '' })).status, 404, 'the token was dropped, not revived');
});

test('tokens: short-lived, bounded in number, minutes from config', () => {
  forgetTries();
  const t = issueTry({ id: 'x', who: 'owner', sroot: '/x', minutes: 1, now: 1000 });
  assert.ok(lookupTry(t, 1000 + 59999)); assert.equal(lookupTry(t, 1000 + 60000), null); assert.equal(lookupTry(t, 1000), null, 'gone for good');
  const first = issueTry({ id: 'x', who: 'owner', sroot: '/x', minutes: 5, now: 0 });
  for (let i = 0; i < MAX_TRY_TOKENS; i++) issueTry({ id: 'x', who: 'owner', sroot: '/x', minutes: 5, now: 0 });
  assert.equal(lookupTry(first, 1), null, 'the oldest goes past the cap');
  assert.equal(tryMinutes({ selfpub_try_minutes: 5 }), 5); assert.equal(tryMinutes({ selfpub_try_minutes: Infinity }), MAX_TRY_MINUTES); assert.equal(tryMinutes({}), DEFAULT_TRY_MINUTES); assert.equal(tryMinutes({ selfpub_try_minutes: -1 }), DEFAULT_TRY_MINUTES);
  assert.match(pageCsp('h:1', 'a'.repeat(48)), /connect-src http:\/\/h:1\/selfpub-try\/a{48}\/page\/api\/ https:\/\/h:1\/selfpub-try\/a{48}\/page\/api\/;/);
  assert.match(wrapperCsp('h:1', 'b'.repeat(48)), /frame-src http:\/\/h:1\/selfpub-try\/b{48}\/page\/ https:\/\/h:1\/selfpub-try\/b{48}\/page\/;/);
  forgetTries();
});

test('GPT review: every answer carries the sandbox CSP (an SVG is a document too); a top-level open is refused', async () => {
  fs.writeFileSync(path.join(repo, 'web', 'x.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>parent.alert(1)</script></svg>');
  putChange(sroot, ID, { verifiedHash: treeHash(repo) });
  const { url } = await (await issue()).json();
  const svg = await call(`${url}page/web/x.svg`, { token: '' });
  assert.equal(svg.status, 200); assert.match(svg.headers.get('content-security-policy'), /^sandbox allow-scripts;.*script-src 'unsafe-inline' http:\/\/127\.0\.0\.1/);
  for (const sub of ['', 'page/', 'page/web/x.svg'])
    assert.equal((await call(url + sub, { token: '', headers: { 'sec-fetch-dest': 'document' } })).status, 403, `top-level ${sub || 'wrapper'}`);
  assert.equal((await call(url, { token: '', headers: { 'sec-fetch-dest': 'iframe' } })).status, 200);
  const v6 = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: `${url}page/`, headers: { host: '[::1]:1' } }, (r) => { r.resume(); res(r.statusCode); }).on('error', rej));
  assert.equal(v6, 400, 'an IPv6 Host cannot go in a CSP host-source');   // fetch() would not send this Host
});

test('GPT + R13 review: a preview serves only the frozen verified copy — a later edit, a new file, an ignored file never reach it', async () => {
  const { url } = await (await issue()).json();
  const css = path.join(repo, 'web', 'home-v2.css'), was = fs.readFileSync(css);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'web/ignored.js\n'); fs.writeFileSync(path.join(repo, 'web', 'ignored.js'), 'x');
  putChange(sroot, ID, { verifiedHash: treeHash(repo) });
  const { url: url2 } = await (await issue()).json();
  try {
    assert.equal((await call(`${url2}page/web/ignored.js`, { token: '' })).status, 404, 'git-ignored: not part of the change, never served');
    fs.appendFileSync(css, '\n/* follow-up edit in progress */\n'); fs.writeFileSync(path.join(repo, 'web', 'late.js'), 'late');
    const page = await call(`${url2}page/`, { token: '' }), asset = await (await call(`${url2}page/web/home-v2.css`, { token: '' })).text();
    assert.equal(page.status, 200); assert.doesNotMatch(await page.text(), /follow-up edit/, 'the page: the verified bytes');
    assert.match(asset, new RegExp(MARK)); assert.doesNotMatch(asset, /follow-up edit/, 'an asset too, read after the edit');
    assert.equal((await call(`${url2}page/web/late.js`, { token: '' })).status, 404, 'a file written after the tap is not served');
    assert.equal((await call(url, { token: '' })).status, 404, 'a token from before the record changed is gone');
    const again = await issue(); assert.equal(again.status, 409, 'no new token for moved bytes'); assert.equal((await again.json()).code, 'NOT_PENDING');
  } finally {
    fs.writeFileSync(css, was); for (const f of ['web/late.js', 'web/ignored.js', '.gitignore']) fs.rmSync(path.join(repo, f), { force: true });
    putChange(sroot, ID, { verifiedHash: treeHash(repo) });
  }
});

test('R13 review: the preview ends with the owner\'s session (sign-out), never only at its TTL', async () => {
  const login = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: OWNER_TOKEN }) });   // a browser session (no PIN yet: the token signs in)
  assert.equal(login.status, 200); const { token: sess } = await login.json();
  const { url } = await (await issue(sess)).json();
  assert.equal((await call(url, { token: '' })).status, 200);
  assert.equal((await call('/api/logout', { method: 'POST', body: '{}', token: sess })).status, 200);
  assert.equal((await call(url, { token: '' })).status, 404, 'signed out: the preview link is dead');
});

test('snapshots: bounded in bytes; dropped with their token', () => {
  const dir = repo, h = treeHash(repo);
  assert.throws(() => takeSnapshot(dir, sroot, h, { maxMb: 0.001 }), /over 0\.001 MB/);
  assert.throws(() => takeSnapshot(dir, sroot, 'not-the-hash'), (e) => e.code === 'NOT_PENDING');
  const snap = takeSnapshot(dir, sroot, h);
  assert.ok(fs.existsSync(path.join(snap, 'web', 'index.html')));
  forgetTries(); const t = issueTry({ id: ID, who: 'owner', sroot, snap, minutes: 1 }); forgetTries();
  assert.equal(lookupTry(t), null); assert.equal(fs.existsSync(snap), false, 'the copy goes with the token');
  assert.equal(snapshotMb({ selfpub_try_snapshot_mb: 4 }), 4); assert.equal(snapshotMb({}), DEFAULT_TRY_SNAPSHOT_MB); assert.equal(snapshotMb({ selfpub_try_snapshot_mb: Infinity }), DEFAULT_TRY_SNAPSHOT_MB);
  assert.deepEqual(PENDING, ['ready', 'unverified'], 'one list of waiting states (R3), in lib/selfpub/state.mjs');
});
