// Demo sign-in, as a visitor meets it (lib/demo-auth.mjs, lib/demo-routes.mjs, lib/demo-boot.mjs):
// the REAL web.mjs in demo mode with a stub Supabase (its JWKS) and a stub Ollama. A signed-out
// visitor is refused AI with the bilingual prompt; a valid token chats, counted per Supabase sub;
// expired / forged / wrong-issuer / wrong-audience tokens are refused; two members never see each
// other's apps; sign-out ends the session and the token binding.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { DEMO_SIGNIN, DEMO_SIGNIN_BAD, DEMO_BLOCKED, AUTH_HEADER, sbUserId, makeSupabaseVerifier, makeSigninGate } from '../lib/demo-auth.mjs';
import { SIGNIN_LABELS } from '../lib/demo-boot.mjs';
import { DEMO_COOKIE, DEMO_DELETE_PATH } from '../lib/demo.mjs';
const NOTICE = '第三方云端模型 · AI answers come from third-party cloud models <b>';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KID = 'test-kid';
const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

let sb, ollama, web, root, port, iss, ipSeq = 0;
function jwt(claims = {}, { key = privateKey, kid = KID, alg = 'ES256' } = {}) {
  const head = b64({ alg, kid, typ: 'JWT' });
  const body = b64({ sub: 'user-a', aud: 'authenticated', iss, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  return `${head}.${body}.${sig}`;
}
const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));

// A SLOW turn is held at the fake model until the test releases it, so the delete check sees the
// turn in flight however slow the runner is. A fixed sleep raced a busy CI runner (the delete got 200).
const SLOW_ARRIVAL_MS = 10000;
let slowArrived = () => {}, releaseSlow = () => {}, slowHeld = Promise.resolve();
const holdNextSlowTurn = () => {
  slowHeld = new Promise((r) => { releaseSlow = r; });
  const arrived = new Promise((r) => { slowArrived = r; });
  let timer;
  const late = new Promise((_, no) => { timer = setTimeout(() => no(new Error('the SLOW turn never reached the model')), SLOW_ARRIVAL_MS); });
  return Promise.race([arrived, late]).finally(() => clearTimeout(timer));
};

before(async () => {
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256', use: 'sig' };
  sb = await listen(http.createServer((req, res) => {
    if (req.url === '/auth/v1/.well-known/jwks.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ keys: [jwk] })); }
    res.writeHead(404); res.end();
  }));
  ollama = await listen(http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; }); req.on('end', async () => {
      if (body.includes('SLOW')) { slowArrived(); await slowHeld; }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: 'FAST-ANSWER' }, done: true }) + '\n'); });
  }));
  const url = `http://127.0.0.1:${sb.address().port}`;
  iss = `${url}/auth/v1`;
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [], ollama_url: `http://127.0.0.1:${ollama.address().port}`,
    chat_models: [{ id: 'fast', label: 'Fast', group: 'Fast', provider: 'ollama', model: 'fake' }],
    demo: { enabled: true, behind_cloudflare: true, notice: NOTICE, blocked_users: ['blocked-sub', ' Bad@Example.COM '], ai_calls_per_user_per_day: 2, ai_calls_per_ip_per_day: 100, new_users_per_ip_per_day: 50,
      auth: { supabase_url: url, supabase_anon_key: 'public-anon', required: true } } } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  web = startWeb(root); await waitReady(port);
});
after(async () => { await stopWeb(web); sb.close(); ollama.close(); rmTemp(root); });

const req = (p, { token, ip, sbToken, ...opts } = {}) => fetch(`http://127.0.0.1:${port}${p}`, { ...opts, headers: {
  'content-type': 'application/json', 'cf-connecting-ip': ip || '203.0.113.9',
  ...(token ? { authorization: `Bearer ${token}` } : {}), ...(sbToken ? { [AUTH_HEADER]: sbToken } : {}) } });
async function start(sbToken, { ip = `198.51.100.${++ipSeq}`, token } = {}) {
  const r = await req('/api/demo/start', { method: 'POST', ip, sbToken, token });
  return { r, j: await r.json(), ip };
}
const chat = (v, message = 'hi') => req('/api/chat', { method: 'POST', token: v.j.token, ip: v.ip, body: JSON.stringify({ message }) });

test('signed out: the shell shows the sign-in control (no banner), and AI is refused with the bilingual prompt', async () => {
  const shell = await (await req('/')).text();
  assert.ok(!shell.includes('demoSigninTip'), 'no sign-in banner under the header (owner 2026-11-22)');
  assert.ok(shell.includes(SIGNIN_LABELS.in.split(' · ')[0]) && shell.includes('/auth/v1/otp'));
  assert.ok(shell.includes('"anonKey":"public-anon"'), 'the client gets the public values from config');
  assert.ok(shell.includes("code_challenge_method:'s256'") && shell.includes("auth('pkce'"), 'the magic link is PKCE-bound to this browser');
  assert.ok(!/hs\.get\('access_token'\)\)put|keep\(hs/.test(shell), 'tokens in a #fragment are never adopted (login CSRF)');
  const anon = await start();
  assert.equal(anon.r.status, 200);
  assert.match(anon.j.uid, /^anon-/);
  const r = await chat(anon);
  assert.equal(r.status, 401);
  const j = await r.json();
  assert.equal(j.code, 'demo_signin');
  assert.equal(j.error, DEMO_SIGNIN);
  assert.match(j.error, /Sign in.*登录/);
  assert.equal((await req('/api/apps', { token: anon.j.token })).status, 200, 'the sample apps stay open signed out');
});

test('a valid token chats; the AI cap counts per Supabase user, across sessions and networks', async () => {
  const a = await start(jwt({ sub: 'quota-user' }));
  assert.equal(a.r.status, 200, JSON.stringify(a.j));
  assert.equal(a.j.uid, sbUserId('quota-user'));
  const first = await chat(a);
  assert.equal(first.status, 200);
  assert.match(await first.text(), /FAST-ANSWER/);
  assert.equal((await chat(a)).status, 200);
  const again = await start(jwt({ sub: 'quota-user' }));   // a new browser, another network
  assert.equal(again.j.uid, a.j.uid, 'the same sub is the same visitor');
  assert.equal((await chat(again)).status, 429, 'the per-user cap follows the sub, not the session or IP');
  const b = await start(jwt({ sub: 'quota-other' }), { ip: again.ip });
  assert.equal((await chat(b)).status, 200, 'another member has their own count');
  const re = await start(jwt({ sub: 'quota-other', exp: Math.floor(Date.now() / 1000) + 7200 }), { ip: b.ip, token: b.j.token });
  assert.equal(re.j.token, b.j.token, 'a refreshed token is rebound to the live session, not a new one');
});

test('expired, forged, wrong-issuer, wrong-audience and unsigned tokens are refused', async () => {
  const bad = {
    expired: jwt({ exp: Math.floor(Date.now() / 1000) - 5 }),
    forged: jwt({}, { key: other }),
    unknownKid: jwt({}, { kid: 'nope' }),
    issuer: jwt({ iss: 'https://evil.supabase.co/auth/v1' }),
    audience: jwt({ aud: 'anon' }),
    anonymousUser: jwt({ is_anonymous: true }),
    hs256: jwt({}, { alg: 'HS256' }),
    noKid: jwt({}, { kid: '' }),
    none: `${b64({ alg: 'none' })}.${b64({ sub: 'user-a', aud: 'authenticated', iss, exp: 9e9 })}.`,
    garbage: 'not-a-jwt',
  };
  for (const [name, t] of Object.entries(bad)) {
    const v = await start(t);
    assert.equal(v.r.status, 401, name);
    assert.equal(v.j.code, 'demo_signin', name);
    assert.equal(v.j.error, DEMO_SIGNIN_BAD, name);
  }
});

test('a bound token is re-checked on every request: once it expires, chat and the workspace are refused', async () => {
  const v = await start(jwt({ sub: 'short-lived', exp: Math.floor(Date.now() / 1000) + 2 }));
  assert.equal(v.r.status, 200);
  assert.equal((await chat(v)).status, 200);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal((await chat(v)).status, 401);
  assert.equal((await req('/api/ping', { token: v.j.token })).status, 401, 'the node session ends with the sign-in, not 30 days later');
  assert.equal((await req('/api/convos', { token: v.j.token })).status, 401, 'no private workspace route either');
  const out = await req('/api/logout', { method: 'POST', token: v.j.token, ip: v.ip });
  assert.equal(out.status, 200, 'an expired member can still sign out');
  const back = await start(jwt({ sub: 'short-lived', iat: Math.floor(Date.now() / 1000) + 1 }), { ip: v.ip, token: v.j.token });   // a sign-in after the sign-out
  assert.equal(back.r.status, 200);
  assert.notEqual(back.j.token, v.j.token, 'a fresh token mints a fresh session; the revoked one stays dead');
  assert.equal((await chat(back)).status, 200);
});

test("two members never see each other's apps", async () => {
  const a = await start(jwt({ sub: 'apps-a' })), b = await start(jwt({ sub: 'apps-b' }));
  const appsA = path.join(root, `workspace-${a.j.uid}`, 'apps');
  fs.cpSync(path.join(appsA, 'notes'), path.join(appsA, 'only-a'), { recursive: true });
  const names = async (v) => (await (await req('/api/apps', { token: v.j.token })).json()).map((x) => x.name);
  assert.ok((await names(a)).includes('only-a'));
  assert.ok(!(await names(b)).includes('only-a'));
  assert.ok(!fs.readFileSync(path.join(root, 'demo-users.json'), 'utf8').includes('apps-a'), 'the sub itself is never stored');
});

test('sign-out ends the session and the binding; the next visit is signed out', async () => {
  const v = await start(jwt({ sub: 'leaver' }));
  const out = await req('/api/logout', { method: 'POST', token: v.j.token, ip: v.ip });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie') || '', new RegExp(`${DEMO_COOKIE}=;.*Max-Age=0`));
  assert.equal((await req('/api/ping', { token: v.j.token })).status, 401);
  const stale = await start(jwt({ sub: 'leaver', iat: Math.floor(Date.now() / 1000) - 60 }), { ip: v.ip });
  assert.equal(stale.r.status, 401, 'a token issued before the sign-out (another tab) cannot mint a new session');
  await stopWeb(web); web = startWeb(root); await waitReady(port);
  const afterRestart = await start(jwt({ sub: 'leaver', iat: Math.floor(Date.now() / 1000) - 60 }), { ip: v.ip });
  assert.equal(afterRestart.r.status, 401, 'the sign-out cutoff survives a restart');
  const next = await start(undefined, { ip: v.ip });
  assert.match(next.j.uid, /^anon-/);
  assert.equal((await chat(next)).status, 401);
});

test("each node session's AI ends at its own token's exp, not kept alive by another browser", async () => {
  const short = await start(jwt({ sub: 'two-tabs', exp: Math.floor(Date.now() / 1000) + 2 }));
  const long = await start(jwt({ sub: 'two-tabs' }));
  assert.equal(short.j.uid, long.j.uid);
  assert.notEqual(short.j.token, long.j.token);
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal((await chat(short)).status, 401, 'the old session is not refreshed by the other browser');
  assert.equal((await chat(long)).status, 200);
});

test('concurrent verifications share one JWKS fetch, and a failed fetch backs off', async () => {
  let calls = 0, fail = false;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'ES256' };
  const fetchImpl = async () => { calls++; await new Promise((r) => setTimeout(r, 20));
    if (fail) throw new Error('down'); return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) }; };
  const cfg = { demo: { auth: { supabase_url: iss.replace('/auth/v1', '') } } };
  const v = makeSupabaseVerifier({ fetchImpl });
  const all = await Promise.all(Array.from({ length: 20 }, () => v.verify(jwt(), cfg)));
  assert.ok(all.every((x) => x.ok));
  assert.equal(calls, 1);
  fail = true;
  const v2 = makeSupabaseVerifier({ fetchImpl });
  await assert.rejects(v2.verify(jwt(), cfg));
  await assert.rejects(v2.verify(jwt(), cfg), /recently unreachable/);
  assert.equal(calls, 2, 'no second fetch inside the backoff');
});

test('the notice under the chat box comes from config, as plain text', async () => {
  const shell = await (await req('/')).text();
  assert.ok(shell.includes(JSON.stringify(NOTICE).replace(/</g, '\\u003c')), 'config text, escaped');
  assert.ok(shell.includes("n.id='demoNotice'") && shell.includes('f.appendChild(n)'));
});

test('blocked users (by Supabase id or email) get 403 on AI; others are not affected', async () => {
  for (const claims of [{ sub: 'blocked-sub' }, { sub: 'some-sub', email: 'bad@example.com' }]) {
    const v = await start(jwt(claims));
    assert.equal(v.r.status, 200, 'a blocked user may still browse and delete their data');
    const r = await chat(v);
    assert.equal(r.status, 403);
    const j = await r.json();
    assert.equal(j.code, 'demo_blocked');
    assert.equal(j.error, DEMO_BLOCKED);
  }
  const ok = await start(jwt({ sub: 'fine-sub', email: 'good@example.com' }));
  assert.equal((await chat(ok)).status, 200);
});

test("delete my account removes only that member's workspace and quota rows, then signs out", async () => {
  const a = await start(jwt({ sub: 'del-a' })), b = await start(jwt({ sub: 'del-b' }));
  assert.equal((await chat(a)).status, 200);
  assert.equal((await chat(b)).status, 200);
  const wsA = path.join(root, `workspace-${a.j.uid}`), wsB = path.join(root, `workspace-${b.j.uid}`);
  assert.ok(fs.existsSync(path.join(wsA, 'conversations')) && fs.existsSync(path.join(wsB, 'conversations')));
  const quota = () => JSON.parse(fs.readFileSync(path.join(root, 'demo-quota.json'), 'utf8')).counts;
  assert.ok(quota()[`user:${a.j.uid}`] && quota()[`user:${b.j.uid}`]);
  const inFlight = holdNextSlowTurn();
  const slow = chat(a, 'SLOW');
  try {
    await inFlight;
    assert.equal((await req(DEMO_DELETE_PATH, { method: 'POST', token: a.j.token, ip: a.ip })).status, 409, 'not while a turn can still write');
  } finally { releaseSlow(); }
  const sr = await slow;
  assert.equal(sr.status, 200);
  await sr.text();   // the turn finishes (and saves) before the delete
  const anon = await start();
  assert.equal((await req(DEMO_DELETE_PATH, { method: 'POST', token: anon.j.token })).status, 403, 'a guest has no account to delete');
  assert.equal((await req(DEMO_DELETE_PATH, { method: 'POST' })).status, 401);
  const del = await req(DEMO_DELETE_PATH, { method: 'POST', token: a.j.token, ip: a.ip });
  assert.equal(del.status, 200);
  assert.ok(!fs.existsSync(wsA), "A's apps, chats and app data are gone");
  assert.ok(fs.existsSync(path.join(wsB, 'apps')) && fs.readdirSync(path.join(wsB, 'conversations')).length, "B's data is untouched");
  assert.equal(quota()[`user:${a.j.uid}`], undefined);
  assert.ok(quota()[`user:${b.j.uid}`], "B's quota row stays");
  assert.equal((await req('/api/ping', { token: a.j.token })).status, 401, 'A is signed out');
  assert.equal((await chat(b)).status, 200, 'B still works');
  const shell = await (await req('/')).text();
  assert.match(shell, /sign-in email stays registered.*登录邮箱账户保留/, 'the confirm says the sign-in account is kept');
});

test('the block list holds for signed-in members even when sign-in is optional', async () => {
  const cfg = { demo: { blocked_users: ['blocked-sub'], auth: { supabase_url: iss.replace('/auth/v1', ''), required: false } } };
  const gate = makeSigninGate({ cfg });
  const user = { id: sbUserId('blocked-sub'), signedIn: true };
  gate.bind('bearer-1', user.id, jwt({ sub: 'blocked-sub' }), Math.floor(Date.now() / 1000) + 3600);
  assert.equal((await gate.check(user, 'bearer-1')).status, 403);
  assert.equal(await gate.check({ id: 'anon-0000000000000000', signedIn: false }, 'x'), null, 'guests pass when sign-in is optional');
});

// An app's 'ask' (lib/demo-ask.mjs): the chat's sign-in gate, then an Ollama answer as {ok,text}; no agent.
test("an app's ask needs a sign-in, then answers from the demo lane and saves no conversation", async () => {
  const anon = await start();
  const no = await req('/api/ask', { method: 'POST', token: anon.j.token, ip: anon.ip, body: JSON.stringify({ message: 'pollen?' }) });
  assert.equal(no.status, 401);
  assert.equal((await no.json()).error, DEMO_SIGNIN);
  const v = await start(jwt({ sub: 'asker' }));
  const before = (await (await req('/api/convos', { token: v.j.token, ip: v.ip })).json()).length;
  assert.ok(Number.isInteger(before), 'the convo list is a list');
  const r = await req('/api/ask', { method: 'POST', token: v.j.token, ip: v.ip, body: JSON.stringify({ message: 'pollen?' }) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, text: 'FAST-ANSWER' });
  assert.equal((await (await req('/api/convos', { token: v.j.token, ip: v.ip })).json()).length, before, 'nothing saved');
});
