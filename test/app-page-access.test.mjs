// An unshared app page is its author's and the owner's only (lib/app-page-access.mjs, ADR 0037).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { canViewAppPage, appIsShared, appPageToken, appPageCookie, APP_PAGE_COOKIE } from '../lib/app-page-access.mjs';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, OWNER_TOKEN } from './helpers-web.mjs';

const A = { id: 'alice', role: 'member' }, B = { id: 'bob', role: 'member' }, O = { id: 'owner', role: 'owner' };

test('decision: unshared → author and owner only; shared → anyone', () => {
  assert.equal(canViewAppPage({ authorId: 'alice', shared: false, viewer: A }), true);
  assert.equal(canViewAppPage({ authorId: 'alice', shared: false, viewer: O }), true);
  assert.equal(canViewAppPage({ authorId: 'alice', shared: false, viewer: B }), false);
  assert.equal(canViewAppPage({ authorId: 'alice', shared: false, viewer: null }), false);
  assert.equal(canViewAppPage({ authorId: 'alice', shared: true, viewer: null }), true);
  assert.equal(canViewAppPage({ authorId: 'alice', shared: 'yes', viewer: null }), false, 'only a real true shares');
});

test('meta: missing or broken meta.json is unshared', () => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir())  /* '/tmp' does not exist on Windows */, 'pa-meta-'));
  assert.equal(appIsShared(d), false);
  fs.writeFileSync(path.join(d, 'meta.json'), '{bad');
  assert.equal(appIsShared(d), false);
  fs.writeFileSync(path.join(d, 'meta.json'), '{"shared":true}');
  assert.equal(appIsShared(d), true);
});

test('cookie: path-scoped, HttpOnly, Strict; Secure only on https; token read from cookie first', () => {
  const c = appPageCookie({ headers: {}, socket: {} }, 'tok');
  assert.match(c, /^pa_app=tok; Path=\/app\/; HttpOnly; SameSite=Strict; Max-Age=/);
  assert.match(appPageCookie({ headers: { 'x-forwarded-proto': 'https' }, socket: {} }, 't'), /; Secure;/);
  assert.equal(appPageToken({ headers: { cookie: `x=1; ${APP_PAGE_COOKIE}=ck`, authorization: 'Bearer hd' } }), 'ck');
  assert.equal(appPageToken({ headers: { authorization: 'Bearer hd' } }), 'hd');
});

// ── the real web.mjs on a throwaway root: owner + two members ──
const TOK_A = 'alice-token-0123456789abcdefghij', TOK_B = 'bob-token-0123456789abcdefghijkl';
let port, root, inst;
const get = (p, headers = {}) => fetch(`http://127.0.0.1:${port}${p}`, { headers, redirect: 'manual' });
const bearer = (t) => ({ authorization: `Bearer ${t}` });
function mkApp(ws, slug, shared) {
  const d = path.join(root, ws, 'apps', slug);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'index.html'), `<!doctype html><title>${slug}</title><p>${slug}-body</p>`);
  fs.writeFileSync(path.join(d, 'app.js'), 'void 0;');
  fs.writeFileSync(path.join(d, 'data.json'), '{"secret":1}');
  fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify({ title: slug, shared }));
}
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
    { id: 'alice', name: 'Alice', role: 'member', token: TOK_A, workspace: 'workspace-alice', status: 'active' },
    { id: 'bob', name: 'Bob', role: 'member', token: TOK_B, workspace: 'workspace-bob', status: 'active' },
  ] } });
  mkApp('workspace-alice', 'diary', false);
  mkApp('workspace-alice', 'pub', true);
  inst = startWeb(root);
  await waitReady(port);
});
after(async () => { await stopWeb(inst); fs.rmSync(root, { recursive: true, force: true }); });

test('unshared app: 404 for member B and for anyone signed out, page and code alike', async () => {
  for (const f of ['', 'index.html', 'app.js']) {
    assert.equal((await get(`/app/alice/diary/${f}`)).status, 404, `anon ${f}`);
    assert.equal((await get(`/app/alice/diary/${f}`, bearer(TOK_B))).status, 404, `bob ${f}`);
    assert.equal((await get(`/app/alice/diary/${f}`, { cookie: `${APP_PAGE_COOKIE}=nope` })).status, 404, `forged cookie ${f}`);
  }
  assert.equal((await get('/app/alice/diary')).status, 404, 'no redirect reveals it either');
  assert.equal((await get('/app/alice/nosuch/')).status, 404, 'same answer as a missing app');
});

test('a member\'s app folder linked to another author\'s unshared app is 404, even for that member', async () => {
  const link = path.join(root, 'workspace-bob', 'apps', 'borrowed');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(path.join(root, 'workspace-alice', 'apps', 'diary'), link);
  try {
    for (const f of ['', 'app.js']) assert.equal((await get(`/app/bob/borrowed/${f}`, bearer(TOK_B))).status, 404, f);
  } finally { fs.unlinkSync(link); }
});

test('unshared app: the author and the owner load it', async () => {
  const a = await get('/app/alice/diary/', bearer(TOK_A));
  assert.equal(a.status, 200); assert.match(await a.text(), /diary-body/);
  assert.equal((await get('/app/alice/diary/', bearer(OWNER_TOKEN))).status, 200);
});

test('the real flow: ping sets the app cookie, and the cookie alone opens the author\'s page', async () => {
  const login = await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOK_A }) });
  const { token } = await login.json();
  assert.ok(token, 'token sign-in gave a session');
  const ping = await get('/api/ping', bearer(token));
  const sc = ping.headers.get('set-cookie') || '';
  assert.match(sc, /^pa_app=[^;]+; Path=\/app\/; HttpOnly; SameSite=Strict/);
  const cookie = sc.split(';')[0];
  assert.equal((await get('/app/alice/diary/', { cookie })).status, 200, 'iframe navigation carries only the cookie');
  const out = await fetch(`http://127.0.0.1:${port}/api/logout`, { method: 'POST', headers: bearer(token) });
  assert.match(out.headers.get('set-cookie') || '', /pa_app=;.*Max-Age=0/);
  assert.equal((await get('/app/alice/diary/', { cookie })).status, 404, 'logout revokes the cookie with the session');
});

test('shared app: loads for member B and signed out; data files stay 404 for everyone', async () => {
  assert.equal((await get('/app/alice/pub/', bearer(TOK_B))).status, 200);
  assert.equal((await get('/app/alice/pub/')).status, 200);
  for (const t of [null, TOK_A, OWNER_TOKEN]) {
    const h = t ? bearer(t) : {};
    assert.equal((await get('/app/alice/pub/data.json', h)).status, 404);
    assert.equal((await get('/app/alice/diary/data.json', h)).status, 404);
    assert.equal((await get('/app/alice/diary/meta.json', h)).status, 404);
  }
});

test('POST /app/-/signout ends the app cookie\'s session even when /api/logout never ran (offline sign-out)', async () => {
  const { token } = await (await fetch(`http://127.0.0.1:${port}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOK_A }) })).json();
  const cookie = ((await get('/api/ping', bearer(token))).headers.get('set-cookie') || '').split(';')[0];
  assert.equal((await get('/app/alice/diary/', { cookie })).status, 200);
  const r = await fetch(`http://127.0.0.1:${port}/app/-/signout`, { method: 'POST', headers: { cookie } });
  assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie') || '', /pa_app=;.*Max-Age=0/);
  assert.equal((await get('/app/alice/diary/', { cookie })).status, 404, 'the cookie is dead');
  assert.equal((await get('/api/ping', bearer(token))).status, 401, 'and so is its session');
});
