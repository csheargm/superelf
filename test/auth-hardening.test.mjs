// Login hardening, as a user meets it (R6): a REAL web.mjs over real HTTP (helpers-web.mjs).
// Fresh install → setup needs the one-time code; brute force → lockout; short PIN refused on
// register and change; register waits for approval; ?t= no longer signs in; the config API token
// no longer signs in once a password exists; the server listens on 127.0.0.1 by default.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { SETUP_CODE_FILE } from '../lib/setup-code.mjs';
import { FAIL_THRESHOLD } from '../lib/login-guard.mjs';

const roots = [], webs = [];
async function boot() {
  const port = await freePort();
  const root = mkWebRoot({ port });
  const web = startWeb(root);
  roots.push(root); webs.push(web);
  await waitReady(port);
  const call = (p, { body, token, method } = {}) => fetch(`http://127.0.0.1:${port}${p}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { port, root, web, call };
}
let A, B;
before(async () => { A = await boot(); B = await boot(); });
after(async () => { for (const w of webs) await stopWeb(w); for (const r of roots) rmTemp(r); });

const PW = 'correct-horse-1';

test('fresh install: the API token signs in only while the account has no PIN, then setup needs the code', async () => {
  // Bootstrap still works before any password exists (the documented "No PIN yet" link).
  const pre = await A.call('/api/login', { body: { token: OWNER_TOKEN } });
  assert.equal(pre.status, 200, 'token bootstrap before a PIN exists');
  const preTok = (await pre.json()).token;
  const squat = await A.call('/api/register', { body: { username: 'boss', password: 'longer-pin-1' } });
  assert.equal(squat.status, 403, 'no registration before the owner exists (it would be promoted to owner)');

  const codeFile = path.join(A.root, SETUP_CODE_FILE);
  assert.ok(fs.existsSync(codeFile), 'a setup code file is written at start');
  const code = fs.readFileSync(codeFile, 'utf8').trim();
  assert.match(A.web.bootLog(), new RegExp(`setup code[^\\n]*${code}`), 'and printed to the server log');

  const none = await A.call('/api/setup', { body: { username: 'boss', password: PW } });
  assert.equal(none.status, 403, 'first visitor without the code is refused');
  const wrong = await A.call('/api/setup', { body: { username: 'boss', password: PW, setupCode: 'NOPE' } });
  assert.equal(wrong.status, 403);
  const short = await A.call('/api/setup', { body: { username: 'boss', password: 'short7!', setupCode: code } });
  assert.equal(short.status, 400, '7 characters is under the minimum');
  assert.match((await short.json()).error, /8/);

  const [ok, race] = await Promise.all([
    A.call('/api/setup', { body: { username: 'boss', password: PW, setupCode: code } }),
    A.call('/api/setup', { body: { username: 'evil', password: PW, setupCode: code } }),
  ]);
  assert.deepEqual([ok.status, race.status].sort(), [200, 403], 'two racing setups make exactly one owner');
  assert.ok(!fs.existsSync(codeFile), 'the code is deleted after use');
  const again = await A.call('/api/setup', { body: { username: 'x', password: PW, setupCode: code } });
  assert.equal(again.status, 403, 'setup closes for good');

  assert.equal((await A.call('/api/ping', { token: preTok })).status, 401, 'the bootstrap session does not outlive setup');
  const post = await A.call('/api/login', { body: { token: OWNER_TOKEN } });
  assert.equal(post.status, 401, 'once the owner has a password, the config token makes no session');
  const api = await A.call('/api/ping', { token: OWNER_TOKEN });
  assert.equal(api.status, 200, 'it stays an API key (Bearer) for the Shortcuts');
  const pin = await A.call('/api/profile', { method: 'PUT', token: OWNER_TOKEN, body: { password: 'attacker-pin-1' } });
  assert.equal(pin.status, 403, 'the API key cannot replace the PIN');
  const adm = await A.call('/api/admin/users', { body: { id: 'evil2', role: 'owner', password: 'attacker-pin-1' }, token: OWNER_TOKEN });
  assert.equal(adm.status, 403, 'nor create another owner');
});

test('a session token in ?t= no longer signs in; the header does', async () => {
  const winner = (await A.call('/api/setup-status').then((r) => r.json())).needsSetup;
  assert.equal(winner, false);
  const r = await A.call('/api/login', { body: { username: 'boss', password: PW } });
  const who = r.status === 200 ? 'boss' : 'evil';   // whichever racer won above
  const s = r.status === 200 ? await r.json() : await (await A.call('/api/login', { body: { username: 'evil', password: PW } })).json();
  assert.ok(s.token, `signed in as ${who}`);
  assert.equal((await A.call(`/api/ping?t=${encodeURIComponent(s.token)}`)).status, 401, '?t= is ignored');
  assert.equal((await A.call('/api/ping', { token: s.token })).status, 200);

  const change = await A.call('/api/profile', { method: 'PUT', token: s.token, body: { password: '1234' } });
  assert.equal(change.status, 400, 'a short new PIN is refused loudly, not silently dropped');
  const other = await (await A.call('/api/login', { body: { username: who, password: PW } })).json();
  const good = await A.call('/api/profile', { method: 'PUT', token: s.token, body: { password: 'another-good-1' } });
  assert.equal(good.status, 200);
  assert.equal((await A.call('/api/ping', { token: s.token })).status, 200, 'the session that changed the PIN stays');
  assert.equal((await A.call('/api/ping', { token: other.token })).status, 401, 'every other session of that user is revoked');
});

test('register: short PIN refused; a new account waits for approval by default', async () => {
  const short = await A.call('/api/register', { body: { username: 'kid', password: '1234' } });
  assert.equal(short.status, 400);
  const r = await A.call('/api/register', { body: { username: 'kid', password: 'longer-pin-1' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).pending, true, 'require_approval defaults to true');
  assert.equal((await A.call('/api/login', { body: { username: 'kid', password: 'longer-pin-1' } })).status, 401, 'pending cannot sign in');
});

test('brute force: the account locks after the threshold, with a bilingual retry-after', async () => {
  const code = fs.readFileSync(path.join(B.root, SETUP_CODE_FILE), 'utf8').trim();
  assert.equal((await B.call('/api/setup', { body: { username: 'own', password: PW, setupCode: code } })).status, 200);
  for (let i = 0; i < FAIL_THRESHOLD; i += 1) {
    assert.equal((await B.call('/api/login', { body: { username: 'own', password: `guess-${i}` } })).status, 401);
  }
  const locked = await B.call('/api/login', { body: { username: 'own', password: PW } });
  assert.equal(locked.status, 429, 'even the right password waits out the lock');
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.match((await locked.json()).error, /Try again in \d+ s · .*秒/);
});

test('the server listens on 127.0.0.1 by default, not on the LAN', async () => {
  assert.match(A.web.bootLog(), /bound to 127\.0\.0\.1/);
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!lan) return;   // no external interface on this machine: the log line above is the proof
  await assert.rejects(fetch(`http://${lan.address}:${A.port}/api/setup-status`), 'not reachable on the LAN address');
});
