// Units for the login hardening helpers; the user flows are in auth-hardening.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoginGuard, clientKey, loginKeys, FAIL_THRESHOLD, IP_FAIL_THRESHOLD, BASE_LOCK_MS, MAX_LOCK_MS } from '../lib/login-guard.mjs';
import { ensureSetupCode, setupCodeOk, consumeSetupCode, SETUP_CODE_FILE } from '../lib/setup-code.mjs';
import { bindHostFor, DEFAULT_BIND_HOST } from '../lib/bind.mjs';
import { MIN_PASSWORD, passwordError } from '../lib/owner.mjs';

test('guard: locks at the threshold, doubles, caps, and a success clears it', () => {
  const g = createLoginGuard(), k = ['ip:1', 'acct:a'];
  for (let i = 0; i < FAIL_THRESHOLD - 1; i += 1) g.fail(k, 0);
  assert.equal(g.retryAfter(k, 0), 0, 'under the threshold: no lock');
  g.fail(k, 0);
  assert.equal(g.retryAfter(k, 0), BASE_LOCK_MS / 1000);
  g.fail(k, 0);
  assert.equal(g.retryAfter(k, 0), (2 * BASE_LOCK_MS) / 1000, 'doubles');
  for (let i = 0; i < 30; i += 1) g.fail(k, 0);
  assert.equal(g.retryAfter(k, 0), MAX_LOCK_MS / 1000, 'capped');
  assert.equal(g.retryAfter(['acct:a'], MAX_LOCK_MS + 1), 0, 'expires');
  g.success(k);
  assert.equal(g.retryAfter(k, 0), 0);
});

test('guard: junk keys never evict a live lock', () => {
  const g = createLoginGuard();
  for (let i = 0; i < FAIL_THRESHOLD; i += 1) g.fail(['acct:owner'], 0);
  for (let i = 0; i < 10_050; i += 1) g.fail([`acct:junk${i}`], 0);
  assert.ok(g.retryAfter(['acct:owner'], 0) > 0);
});

test('clientKey: X-Forwarded-For only from a loopback proxy', () => {
  const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientKey(req('100.1.2.3', '9.9.9.9')), '100.1.2.3', 'a remote client cannot pick its bucket');
  assert.equal(clientKey(req('127.0.0.1', '1.1.1.1, 100.5.5.5')), '100.5.5.5', 'behind tailscale serve: the last hop');
  assert.equal(clientKey(req('::1')), '::1');
});

test('setup code: minted once, compared in constant time, gone after use', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-setupcode-'));
  try {
    const c = ensureSetupCode(root);
    assert.equal(ensureSetupCode(root), c, 'reused across restarts');
    // Windows has no POSIX mode bits: Node reports every writable file as 0o666, so the check
    // would test Node, not this code. The file's privacy there rests on the user profile ACL.
    if (process.platform !== 'win32') assert.equal((fs.statSync(path.join(root, SETUP_CODE_FILE)).mode & 0o077), 0, 'owner-only file');
    assert.equal(setupCodeOk(root, c.toLowerCase()), true, 'case-insensitive');
    assert.equal(setupCodeOk(root, 'x'), false);
    consumeSetupCode(root);
    assert.equal(setupCodeOk(root, c), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bind host: 127.0.0.1 by default, config wins, demo keeps all interfaces', () => {
  assert.equal(bindHostFor({}, false), DEFAULT_BIND_HOST);
  assert.equal(bindHostFor({ bind_host: '100.64.0.7' }, false), '100.64.0.7');
  assert.equal(bindHostFor({}, true), '0.0.0.0');
  assert.throws(() => bindHostFor({ bind_host: 7 }, false), /bind_host/);
});

test('one password minimum', () => {
  assert.equal(MIN_PASSWORD, 8);
  assert.ok(passwordError('1234567'));
  assert.equal(passwordError('12345678'), null);
});

test('loginKeys: one name locks only (IP + that name); the IP alone needs the much higher backstop', () => {
  const g = createLoginGuard();
  const req = { socket: { remoteAddress: '100.1.2.3' }, headers: {} };
  const ben = loginKeys(req, { username: 'Ben' });
  for (let i = 0; i < FAIL_THRESHOLD; i += 1) g.fail(ben, 0);
  assert.ok(g.retryAfter(ben, 0) > 0, 'ben is locked');
  assert.equal(g.retryAfter(loginKeys(req, { username: 'mom' }), 0), 0, 'mom on the same IP is not');
  assert.equal(g.retryAfter(loginKeys(req, { token: 'x' }), 0), 0, 'the token path has its own counter');
  assert.equal(g.retryAfter(loginKeys({ socket: { remoteAddress: '100.9.9.9' }, headers: {} }, { username: 'ben' }), 0), 0, 'another client is not');
  assert.ok(IP_FAIL_THRESHOLD > FAIL_THRESHOLD * 5);
  for (let i = FAIL_THRESHOLD; i < IP_FAIL_THRESHOLD; i += 1) g.fail(loginKeys(req, { username: `n${i}` }), 0);
  assert.ok(g.retryAfter(loginKeys(req, { username: 'mom' }), 0) > 0, 'backstop: many names from one IP lock the IP');
});
