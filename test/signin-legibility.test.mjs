// Signing in must say WHY it was refused.
//
// SCAR: the server answers a bad PIN with 401 {"error":"wrong username or PIN"}, the
// shell's mapper captured that reason — and then relayText's `unauthorized` branch threw
// it away and printed "Signed out · 登录已过期 … Sign in again, then retry" at a person who
// was, at that moment, signing in. It reads as a session/logout bug (it was reported as
// one: "login issues on other browsers after I logout") while the real cause — a wrong
// PIN — was never shown. The audit log said ok:false the whole time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined
import { loadRelayCore } from './helpers-shell-broker.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHELL = readShell(ROOT);
// Source pins scan CODE, not prose — a comment that quotes the sentence it warns about
// must not trip the pin that counts it (same helper as test/broker-relay.test.mjs).
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

// The REAL mapper, run — not a retyped copy.
const R = loadRelayCore(async () => {});
const SERVER_401 = 'Wrong username or password · 用户名或密码错误';

test('a refused sign-in shows the server reason, not "signed out"', async () => {
  const f = await R.relayHttpFail(new Response(JSON.stringify({ error: SERVER_401 }), { status: 401 }));
  assert.equal(f.code, 'unauthorized', 'the code is still the shared one — no new vocabulary');
  const shown = R.relayText(f, 0, 'credentials');
  assert.match(shown, /Wrong username or password/, 'the actual reason must reach the user');
  assert.match(shown, /用户名或密码错误/, 'bilingual, house style');
  assert.equal(/Signed out/.test(shown), false, 'nobody signing in was "signed out"');
  assert.equal(/Sign in again/.test(shown), false, 'telling someone on the sign-in form to sign in again is circular');
});

test('an expired session STILL gets the sign-in-again sentence — the other context is unchanged', async () => {
  const f = await R.relayHttpFail(new Response(JSON.stringify({ error: 'bad token' }), { status: 401 }));
  for (const what of ['note', 'photo', 'content', 'request', 'message']) {
    const shown = R.relayText(f, 0, what);
    assert.match(shown, /登录已过期 · Signed out/, `${what}: a lost session must still say so`);
    assert.match(shown, /Sign in again, then retry/, `${what}: and give the remedy`);
    assert.equal(/bad token/.test(shown), false, `${what}: the raw server token is less useful than the house sentence`);
  }
});

test('a 403 in the sign-in context is refused legibly too', async () => {
  const f = await R.relayHttpFail(new Response(JSON.stringify({ error: 'Account not approved · 账号未批准' }), { status: 403 }));
  const shown = R.relayText(f, 0, 'credentials');
  assert.match(shown, /Account not approved/);
  assert.equal(/Signed out/.test(shown), false);
});

test('a sign-in 401 with no server reason still says something specific', async () => {
  const f = await R.relayHttpFail(new Response('', { status: 401 }));
  const shown = R.relayText(f, 0, 'credentials');
  assert.ok(shown.trim().length > 0, 'never blank');
  assert.equal(/Signed out/.test(shown), false);
  assert.match(shown, /[一-鿿]/, 'bilingual even in the fallback');
});

test('the sign-in call site declares its context', () => {
  assert.match(SHELL, /token:tok\|\|undefined\}\)\}\),'credentials'\)/,
    "doAuth must pass 'credentials' — that is what selects the right sentence");
});

test('the server states the reason bilingually', () => {
  const web = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  assert.match(web, /Wrong username or password · 用户名或密码错误/, 'the 401 body carries the bilingual reason');
  assert.equal(/"wrong username or PIN"/.test(web), false, 'the English-only version is gone');
});

test('other 401 renderings did not drift: still exactly one house sign-out sentence', () => {
  const n = (codeOnly(SHELL).match(/登录已过期 · Signed out/g) || []).length;
  assert.equal(n, 1, 'one sentence, one place (R3)');
});

test('the sign-in form asks for a password, not only a PIN (any password is accepted)', () => {
  const html = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="lpin" type="password" placeholder="密码或 PIN · Password or PIN"/);
  assert.match(html, /No password yet: sign in with access token/);
  assert.equal(/No PIN yet/.test(html), false, 'the PIN-only hint is gone');
});

test('no server reason asks for a PIN only', () => {
  const web = fs.readFileSync(new URL('../web.mjs', import.meta.url), 'utf8');
  assert.equal(/Sign in with your PIN|Wrong username or PIN/.test(web), false);
});
