import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { hashPassword, verifyPassword, Sessions, appendAudit, readAudit } from '../lib/auth.mjs';
import { skipIf } from './helpers-skip.mjs';

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
  const now = 1_000_000;
  const s = new Sessions(f, now);
  const tok = s.create('mia', now);
  assert.equal(s.resolve(tok, now + 1000), 'mia');
  assert.equal(s.resolve(tok, now + 40 * 24 * 3600 * 1000), null); // expired
  const t2 = s.create('bob', now);
  s.destroy(t2);
  assert.equal(s.resolve(t2, now), null);
});

test('sessions persist across instances and revoke by user', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-s2-')), 's.json');
  const now = 5_000_000;
  const s1 = new Sessions(f, now);
  const tok = s1.create('kid', now);
  const s2 = new Sessions(f, now); // reloads from disk
  assert.equal(s2.resolve(tok, now + 1), 'kid');
  s2.destroyUser('kid');
  assert.equal(new Sessions(f, now).resolve(tok, now + 1), null);
});

test('expired sessions, removed-member marks included, are pruned on load and on save', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-s3-')), 's.json');
  const now = 9_000_000; const DAY = 24 * 3600 * 1000;
  const s = new Sessions(f, now);
  const gone = s.create('gone', now); s.removeUser('gone');
  const live = s.create('live', now);
  assert.equal(s.wasRemoved(gone, now + 1), true, 'the mark stays while unexpired');
  const later = now + 31 * DAY;
  const fresh = s.create('new', later); // a save at `later` sweeps both expired records
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(f, 'utf8'))).sort(), [fresh].sort());
  assert.equal(s.wasRemoved(gone, now + 1), false);
  assert.equal(s.resolve(live, now + 1), null);
  // load-time sweep: write an expired removed record straight to disk, reload later
  fs.writeFileSync(f, JSON.stringify({ a: { userId: 'x', expires: now, removed: true }, b: { userId: 'y', expires: later + DAY } }));
  const r = new Sessions(f, later);
  assert.deepEqual([...r.map.keys()], ['b']);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(f, 'utf8'))), ['b'], 'the sweep is written back');
});

test('a failed load-time cleanup write does not stop startup', { skip: skipIf(process.platform === 'win32', 'posix-only', 'POSIX dir modes') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-s4-')); const f = path.join(dir, 's.json');
  fs.writeFileSync(f, JSON.stringify({ old: { userId: 'x', expires: 1 }, live: { userId: 'y', expires: 1e15 } }));
  fs.chmodSync(dir, 0o500); // the atomic write's temp file cannot be created
  try {
    const s = new Sessions(f, 1000);
    assert.equal(s.resolve('live', 1000), 'y', 'live sessions survive');
    assert.equal(s.map.has('old'), false);
  } finally { fs.chmodSync(dir, 0o700); }
});

test('audit append + read newest-first', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-a-')), 'audit.log');
  appendAudit(f, { at: 1, ev: 'register', who: 'a' });
  appendAudit(f, { at: 2, ev: 'approve', who: 'a' });
  const rows = readAudit(f, 10);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ev, 'approve'); // newest first
});
