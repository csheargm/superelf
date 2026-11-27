// The core lane's one-change-at-a-time lock (lib/selfpub/lock.mjs, docs/adr/0044 §1).
// SCAR (2026-11-27): in the container the lock file said "1"; PID 1 is always alive there (it is the
// node itself after a restart), so the old pid-only rule never reclaimed it and it was removed by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock, lockVerdict, lockOptions, hostIdentity, DEFAULT_LOCK_MAX_MS, MIN_LOCK_MAX_MS } from '../lib/selfpub/lock.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const LOCK_MODULE = fileURLToPath(new URL('../lib/selfpub/lock.mjs', import.meta.url));
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'selfpub-lock-')));
const lockFile = (d) => path.join(d, '.lock');
const writeRec = (d, rec) => fs.writeFileSync(lockFile(d), JSON.stringify(rec));
const backdate = (d, ms) => { const t = new Date(Date.now() - ms); fs.utimesSync(lockFile(d), t, t); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A child node process that takes the lock and holds it (heartbeating) until killed.
async function holder(d, maxAgeMs) {
  const src = `import { acquireLock } from ${JSON.stringify(LOCK_MODULE)};
    acquireLock(${JSON.stringify(d)}, { maxAgeMs: ${maxAgeMs} }); process.stdout.write('held\\n'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', (c) => reject(new Error(`holder exited ${c}`))); });
  return child;
}
const stop = (child) => new Promise((r) => { child.once('exit', r); child.kill('SIGKILL'); });

test('PID-1 lock left by a previous container run is reclaimed (the 2026-11-27 incident)', () => {
  const d = tmp();
  try {
    // The new node is PID 1 again: same pid, same host, same boot — but a different process.
    writeRec(d, { pid: process.pid, proc: 'previous-container-run', ...hostIdentity(), at: Date.now() });
    acquireLock(d)();
    // The literal incident file: the old format, just "1".
    fs.writeFileSync(lockFile(d), '1');
    acquireLock(d)();
  } finally { rmTemp(d); }
});

test('PID 1 alive but started at a different time (another process owns pid 1 now): stale', () => {
  const rec = { pid: 1, proc: 'old', host: 'h', boot: 'b', start: '100' };
  const env = { proc: 'new', pid: 7, host: 'h', boot: 'b', alive: () => true, startOf: () => '999' };
  assert.equal(lockVerdict(rec, 0, 60000, env), 'pid-reused');
  assert.equal(lockVerdict(rec, 0, 60000, { ...env, startOf: () => '100' }), '', 'CONTROL: the same start identity is the live owner');
  assert.equal(lockVerdict(rec, 0, 60000, { ...env, boot: 'other' }), 'rebooted');
  assert.equal(lockVerdict(rec, 0, 60000, { ...env, alive: () => false }), 'dead');
  assert.equal(lockVerdict({ ...rec, host: 'elsewhere' }, 0, 60000, env), '', 'an owner on another host cannot be checked: only age reclaims it');
  assert.equal(lockVerdict({ ...rec, host: 'elsewhere' }, 60001, 60000, env), 'expired');
});

test('a live lock is respected: in this process and held by another running process', async () => {
  const d = tmp();
  let child;
  try {
    const rel = acquireLock(d);
    assert.throws(() => acquireLock(d), { code: 'IN_FLIGHT' });
    rel();
    child = await holder(d, DEFAULT_LOCK_MAX_MS);
    assert.throws(() => acquireLock(d), { code: 'IN_FLIGHT' }, 'a running publish in another process keeps its lock');
    await stop(child); child = null;
    acquireLock(d)();   // its process is gone: reclaimed
  } finally { if (child) await stop(child); rmTemp(d); }
});

test('a held lock heartbeats: past max age, a live holder is never stolen', async () => {
  const d = tmp();
  const maxAgeMs = 400;
  let child;
  try {
    child = await holder(d, maxAgeMs);
    await sleep(maxAgeMs * 2);
    assert.throws(() => acquireLock(d, { maxAgeMs }), { code: 'IN_FLIGHT' });
    const own = tmp();
    const rel = acquireLock(own, { maxAgeMs });
    backdate(own, maxAgeMs * 10);
    await sleep(maxAgeMs);
    assert.ok(Date.now() - fs.statSync(lockFile(own)).mtimeMs < maxAgeMs, 'this process beats its own lock too');
    rel(); rmTemp(own);
  } finally { if (child) await stop(child); rmTemp(d); }
});

test('age-based expiry: an owner that stopped beating past max age is reclaimed', () => {
  const d = tmp();
  try {
    // An owner on another host (a shared volume): liveness cannot be checked, so only age decides.
    writeRec(d, { pid: 4242, proc: 'other', host: 'other-host', boot: 'x', at: Date.now() });
    assert.throws(() => acquireLock(d, { maxAgeMs: 60000 }), { code: 'IN_FLIGHT' }, 'CONTROL: young, it is respected');
    backdate(d, 60001);
    acquireLock(d, { maxAgeMs: 60000 })();
  } finally { rmTemp(d); }
});

test('release removes only its own lock, never one that replaced it', () => {
  const d = tmp();
  try {
    const rel = acquireLock(d);
    writeRec(d, { pid: 4242, proc: 'other', host: 'other-host', at: Date.now() });   // reclaimed and re-taken elsewhere
    rel();
    assert.ok(fs.existsSync(lockFile(d)), 'the newer owner keeps its lock');
  } finally { rmTemp(d); }
});

test('max lock age is config read at use time, with a floor', () => {
  assert.equal(lockOptions({}).maxAgeMs, DEFAULT_LOCK_MAX_MS);
  assert.equal(lockOptions({ selfpub_lock_max_ms: 3600000 }).maxAgeMs, 3600000);
  assert.equal(lockOptions({ selfpub_lock_max_ms: 1 }).maxAgeMs, MIN_LOCK_MAX_MS, 'a tiny value cannot let a slow git call lose its lock');
  assert.equal(lockOptions({ selfpub_lock_max_ms: 'x' }).maxAgeMs, DEFAULT_LOCK_MAX_MS);
});
