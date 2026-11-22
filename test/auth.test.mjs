import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { hashPassword, verifyPassword, Sessions, appendAudit, readAudit } from '../lib/auth.mjs';

test('password hash verifies correctly and rejects wrong', () => {
  const h = hashPassword('1234');
  assert.ok(verifyPassword('1234', h));
  assert.ok(!verifyPassword('12345', h));
  assert.ok(!verifyPassword('', h));
  assert.ok(!verifyPassword('1234', 'garbage'));
});

test('each hash has a unique salt', () => {
  assert.notEqual(hashPassword('x'), hashPassword('x'));
});

test('sessions create/resolve/expire/destroy', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-s-')), 's.json');
  const s = new Sessions(f);
  const now = 1_000_000;
  const tok = s.create('mia', now);
  assert.equal(s.resolve(tok, now + 1000), 'mia');
  assert.equal(s.resolve(tok, now + 40 * 24 * 3600 * 1000), null); // expired
  const t2 = s.create('bob', now);
  s.destroy(t2);
  assert.equal(s.resolve(t2, now), null);
});

test('sessions persist across instances and revoke by user', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-s2-')), 's.json');
  const s1 = new Sessions(f);
  const now = 5_000_000;
  const tok = s1.create('kid', now);
  const s2 = new Sessions(f); // reloads from disk
  assert.equal(s2.resolve(tok, now + 1), 'kid');
  s2.destroyUser('kid');
  assert.equal(new Sessions(f).resolve(tok, now + 1), null);
});

test('audit append + read newest-first', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-a-')), 'audit.log');
  appendAudit(f, { at: 1, ev: 'register', who: 'a' });
  appendAudit(f, { at: 2, ev: 'approve', who: 'a' });
  const rows = readAudit(f, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ev, 'approve'); // newest first
});
