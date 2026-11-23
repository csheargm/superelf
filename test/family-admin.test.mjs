// Family accounts, as the owner meets them in Settings (R6): a REAL web.mjs over real HTTP.
// Overnight test 2026-11-22:
//   F5-1 "Add member" showed "Give them this token (shown once):" with an EMPTY token — the route
//        answered {ok,id,hasPin} only, so an owner-added member could never sign in.
//   F5-2 the per-member "token" button only said "delete and re-add" — no way to hand over access.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

let port, root, web;
const call = (p, { body, token = OWNER_TOKEN, method } = {}) => fetch(`http://127.0.0.1:${port}${p}`, {
  method: method || (body ? 'POST' : 'GET'),
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
before(async () => { port = await freePort(); root = mkWebRoot({ port }); web = startWeb(root); await waitReady(port); });
after(async () => { await stopWeb(web); rmTemp(root); });

test('F5-1: a member added with no password gets a sign-in token that works', async () => {
  const r = await call('/api/admin/users', { body: { id: 'mia', name: 'Mia' } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(typeof j.token, 'string', 'the token the dialog shows once');
  assert.ok(j.token.length >= 20, 'and it is not empty');
  const login = await call('/api/login', { token: null, body: { token: j.token } });
  assert.equal(login.status, 200, 'the member signs in with it');
});

test('F5-1: a member added WITH a password signs in by name + password; no token is handed out', async () => {
  const r = await call('/api/admin/users', { body: { id: 'ben', name: 'Ben', password: 'ben-start-pass-1' } });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.hasPin, true);
  assert.equal(j.token, undefined, 'a token cannot sign in once a password exists, so none is shown');
  const login = await call('/api/login', { token: null, body: { username: 'ben', password: 'ben-start-pass-1' } });
  assert.equal(login.status, 200);
});

test('F5-2: the owner resets a member password; the old one and old sessions stop working', async () => {
  await call('/api/admin/users', { body: { id: 'ann', name: 'Ann', password: 'ann-first-pass-1' } });
  const s = await (await call('/api/login', { token: null, body: { username: 'ann', password: 'ann-first-pass-1' } })).json();
  assert.equal((await call('/api/ping', { token: s.token })).status, 200, 'CONTROL: her session works before the reset');
  const short = await call('/api/admin/users/ann', { method: 'PUT', body: { password: 'x' } });
  assert.equal(short.status, 400, 'a too-short password is refused');
  const ok = await call('/api/admin/users/ann', { method: 'PUT', body: { password: 'ann-new-pass-22' } });
  assert.equal(ok.status, 200);
  assert.equal((await call('/api/ping', { token: s.token })).status, 401, 'her old session is signed out');
  assert.equal((await call('/api/login', { token: null, body: { username: 'ann', password: 'ann-first-pass-1' } })).status, 401, 'old password refused');
  assert.equal((await call('/api/login', { token: null, body: { username: 'ann', password: 'ann-new-pass-22' } })).status, 200, 'new password works');
});
