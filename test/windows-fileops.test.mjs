// File operations that behave differently on Windows · Windows 下文件操作差异
//
// POSIX rename() replaces the destination atomically no matter who has it open. Windows refuses
// while ANY process holds a handle — Defender scanning the file superelf just wrote, Search
// indexing it, a backup agent. It is a burst of microseconds, invisible on macOS, and it turned
// two different operations into failures: a routine save answering 500, and a deleted member's
// workspace silently staying put for the next person given that username.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renameWithRetry, writeFileAtomic } from '../lib/atomicwrite.mjs';
import { slugOk, RESERVED_DEVICE_NAMES } from '../lib/webutil.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-winfs-'));

test('renameWithRetry succeeds first time when nothing is in the way', () => {
  const d = mk();
  try {
    fs.writeFileSync(path.join(d, 'a'), 'x');
    renameWithRetry(path.join(d, 'a'), path.join(d, 'b'));
    assert.equal(fs.readFileSync(path.join(d, 'b'), 'utf8'), 'x');
  } finally { rmTemp(d); }
});

test('a transient EPERM is retried on win32, and the LAST attempt still throws', () => {
  // The retry lives behind fs.renameSync, so the only honest way to test it off Windows is to
  // drive the real loop with a stubbed fs — mocking the platform AND the failure it produces.
  const realRename = fs.renameSync;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

    let calls = 0;
    fs.renameSync = () => { calls++; if (calls < 3) { const e = new Error('busy'); e.code = 'EPERM'; throw e; } };
    renameWithRetry('from', 'to');
    assert.equal(calls, 3, 'it kept trying until the handle was released');

    // Never an unbounded loop: a destination held open for ever must still surface as an error.
    calls = 0;
    fs.renameSync = () => { calls++; const e = new Error('busy'); e.code = 'EPERM'; throw e; };
    assert.throws(() => renameWithRetry('from', 'to'), /busy/, 'gives up and rethrows');
    assert.ok(calls > 1 && calls <= 8, `bounded attempts, got ${calls}`);

    // A REAL failure must not be retried at all — retrying ENOSPC just delays the bad news.
    calls = 0;
    fs.renameSync = () => { calls++; const e = new Error('no space'); e.code = 'ENOSPC'; throw e; };
    assert.throws(() => renameWithRetry('from', 'to'), /no space/);
    assert.equal(calls, 1, 'ENOSPC fails immediately');
  } finally {
    fs.renameSync = realRename;
    Object.defineProperty(process, 'platform', realPlatform);
  }
});

test('CONTROL: off win32 the same transient error is NOT retried', () => {
  // Without this the test above could pass on a build that retries everywhere, and the platform
  // condition would be untested.
  // The platform is SET, as the test above sets win32: left to the host, this control failed on a
  // Windows runner, where the retry it rules out is exactly the right behaviour.
  const realRename = fs.renameSync;
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    let calls = 0;
    fs.renameSync = () => { calls++; const e = new Error('busy'); e.code = 'EPERM'; throw e; };
    assert.throws(() => renameWithRetry('from', 'to'), /busy/);
    assert.equal(calls, 1, 'macOS/Linux have no such transient, so no retry and no hidden latency');
  } finally {
    fs.renameSync = realRename;
    Object.defineProperty(process, 'platform', realPlatform);
  }
});

test('writeFileAtomic publishes through the retrying rename', () => {
  // The whole point of the change: the save path inherits the retry rather than re-implementing it.
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'atomicwrite.mjs'), 'utf8');
  assert.match(src, /renameWithRetry\(tmp, f\)/, 'writeFileAtomic uses it');
  assert.ok(!/fs\.renameSync\(tmp, f\)/.test(src), 'and not a bare renameSync');
  const d = mk();
  try {
    const f = path.join(d, 'state.json');
    writeFileAtomic(f, '{"v":1}');
    writeFileAtomic(f, '{"v":2}');
    assert.equal(fs.readFileSync(f, 'utf8'), '{"v":2}', 'overwrite still works');
    assert.deepEqual(fs.readdirSync(d), ['state.json'], 'no tmp litter');
  } finally { rmTemp(d); }
});

test('deleting a member never silently leaves their workspace in place', () => {
  // This is a privacy boundary, not tidiness: provisioning reuses any directory that exists, so
  // a tombstone that quietly failed hands one person's conversations and notes to the next
  // account given that username. The old code was `catch { /* leave in place if rename fails */ }`.
  const web = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  // Anchored on a string unique to MEMBER deletion: web.mjs has three DELETE handlers, and a
  // bare indexOf found an unrelated one that of course had no tombstone.
  const i = web.indexOf('cannot delete the last owner');
  assert.ok(i > 0, 'the member-delete handler is still there');
  const block = web.slice(i, i + 2200);
  assert.match(block, /renameWithRetry\(target\.workspace/, 'the tombstone retries');
  // Executable lines only. The replacement comment QUOTES the old silent catch while explaining
  // why it was wrong, and the first version of this assertion matched its own documentation —
  // the same trap test/ops-scripts.test.mjs records for the shell scripts.
  const exec = web.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/leave in place if rename fails/.test(exec), 'the silent catch is gone from the CODE');
  assert.match(block, /tombstoned/, 'the outcome is tracked');
  assert.match(block, /audit\('delete', \{[^}]*tombstoned/, 'and audited either way (R5)');
  assert.match(block, /warning:/, 'and reported to the caller, not swallowed');
});

test('an app slug can never be a Windows device name', () => {
  // Every slug becomes a directory name. On Windows "con", "aux", "nul", "com1".."lpt9" resolve
  // to DEVICES at any path and with any extension, so such an app cannot be created at all —
  // and only there, which is the kind of bug that reaches a user before it reaches a test.
  for (const n of RESERVED_DEVICE_NAMES) assert.equal(slugOk(n), false, `${n} must be refused`);
  assert.equal(RESERVED_DEVICE_NAMES.size, 22, 'con/prn/aux/nul + com1-9 + lpt1-9');
  // CONTROL: ordinary slugs, including ones that merely START with a reserved word, still pass.
  for (const ok of ['bible', 'journal', 'contacts', 'console', 'com', 'lpt', 'aux-notes', 'nul-app']) {
    assert.equal(slugOk(ok), true, `${ok} must still be allowed`);
  }
});

test('shutdown listens for the signals Windows can actually deliver', () => {
  // Windows delivers no SIGTERM: Node emits it only when another Node process calls process.kill,
  // and stop.ps1 uses taskkill /F, which nothing can catch. SIGINT and SIGBREAK do arrive.
  const web = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  assert.match(web, /\['SIGTERM', 'SIGINT', 'SIGBREAK'\]/, 'all three are registered');
  assert.match(web, /const shutdown = \(sig\)/, 'one handler, not three copies (R3)');
  assert.match(web, /shuttingDown/, 'and it is idempotent, so two signals do not double-close');
});
