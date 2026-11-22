// lib/config-watch.mjs — the stat-polling watcher behind live config (docs/adr/0011), on a temp
// file: one save → one reload (a burst too, and a save that straddles a poll), a bad file → onError
// and the watcher carries on (an onError that throws too), an editor's rename-write is seen,
// unwatch stops it (a pending reload included), and a watcher never keeps a process alive. The
// server half — a real web.mjs picking an edit up — is test/config-live-reload.test.mjs.
//
// TIMING AT THE PRODUCTION RATIO. Every watcher here runs the shipped interval scaled down by SCALE
// and nothing else: the module derives its debounce from the interval it is given, so these tests
// see exactly the shipped debounce/interval ratio. A test-only debounce would test another watcher.
// "Seen" is observed, not guessed: a second fs.watchFile listener on the same file shares the
// watcher's poller (Node keeps one StatWatcher per file), so it fires at the very polls the
// watcher sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { watchConfig, CONFIG_WATCH_INTERVAL_MS, debounceFor } from '../lib/config-watch.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const MODULE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'config-watch.mjs');
const SCALE = 10;
const POLL = CONFIG_WATCH_INTERVAL_MS / SCALE;      // 100 ms
const DEBOUNCE = debounceFor(POLL);                  // what the module will wait at that interval
const SETTLE_MS = DEBOUNCE + 2 * POLL + 300;         // long enough for a second reload to show up
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, what, ms = 5000) => {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) assert.fail(`timed out waiting for ${what}`); await sleep(5); }
};

// A temp config file and a reload that does what web.mjs's does: parse, and only then commit.
function fixture(t, first) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-cfgwatch-'));
  t.after(() => rmTemp(dir));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(first));
  const s = { file, good: first, loads: 0, errors: [], seen: 0 };
  s.reload = () => { s.good = JSON.parse(fs.readFileSync(file, 'utf8')); s.loads += 1; };
  s.watch = (opts = {}) => {
    const un = watchConfig(file, s.reload, { intervalMs: POLL, onError: (e) => s.errors.push(e), ...opts });
    t.after(un);
    const spy = () => { s.seen += 1; };   // the same poller's changes, counted
    fs.watchFile(file, { persistent: false, interval: POLL }, spy);
    t.after(() => fs.unwatchFile(file, spy));
    return un;
  };
  // Resolves once a poll has seen the file change `n` times in all.
  s.seenBy = (n) => until(() => s.seen >= n, `poll #${n} to see the change`);
  return s;
}
// The poller's first stat is its baseline: an edit before it would be the baseline, not a change.
const baseline = () => sleep(POLL * 1.5);

test('the shipped ratio: a reload waits longer than one poll (a debounce under the interval merges nothing)', () => {
  assert.ok(debounceFor(CONFIG_WATCH_INTERVAL_MS) > CONFIG_WATCH_INTERVAL_MS,
    `debounce ${debounceFor(CONFIG_WATCH_INTERVAL_MS)} ms vs interval ${CONFIG_WATCH_INTERVAL_MS} ms`);
  assert.equal(debounceFor(POLL) / POLL, debounceFor(CONFIG_WATCH_INTERVAL_MS) / CONFIG_WATCH_INTERVAL_MS, 'scaled only proportionally');
});

test('one save → exactly one reload, with the new content', async (t) => {
  const s = fixture(t, { v: 1 });
  s.watch(); await baseline();
  fs.writeFileSync(s.file, JSON.stringify({ v: 2, more: 'x' }));
  await until(() => s.loads === 1, 'the reload');
  await sleep(SETTLE_MS);
  assert.equal(s.loads, 1, 'exactly one');
  assert.deepEqual(s.good, { v: 2, more: 'x' });
  assert.deepEqual(s.errors, []);
});

test('a burst: a second save one poll after the first was SEEN is still ONE reload, of the last content', async (t) => {
  const s = fixture(t, { v: 1 });
  s.watch(); await baseline();
  fs.writeFileSync(s.file, JSON.stringify({ v: 2 }));
  await s.seenBy(1);   // the first save has been seen: the debounce is armed
  fs.writeFileSync(s.file, JSON.stringify({ v: 3, last: true }));
  await s.seenBy(2);
  await until(() => s.loads >= 1, 'the reload');
  await sleep(SETTLE_MS);
  assert.equal(s.loads, 1, 'one reload for the burst');
  assert.deepEqual(s.good, { v: 3, last: true });
  assert.deepEqual(s.errors, []);
});

test('a save that straddles a poll (truncated at one, complete at the next) → one reload, no error', async (t) => {
  const s = fixture(t, { v: 1 });
  s.watch(); await baseline();
  fs.writeFileSync(s.file, '');   // the editor has truncated the file…
  await s.seenBy(1);              // …and a poll caught it there
  fs.writeFileSync(s.file, JSON.stringify({ v: 2, whole: true }));   // the write completes
  await s.seenBy(2);              // one poll later
  await until(() => s.loads >= 1 || s.errors.length >= 1, 'a reload');
  await sleep(SETTLE_MS);
  assert.deepEqual(s.errors.map(String), [], 'no false config-reload-failed');
  assert.equal(s.loads, 1, 'exactly one reload');
  assert.deepEqual(s.good, { v: 2, whole: true });
});

test('an editor’s rename-write (a new inode under the same name) is seen', async (t) => {
  const s = fixture(t, { v: 1 });
  s.watch(); await baseline();
  const tmp = `${s.file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ v: 2, renamed: true }));
  fs.renameSync(tmp, s.file);
  await until(() => s.loads === 1, 'the reload after a rename-write');
  assert.deepEqual(s.good, { v: 2, renamed: true });
});

test('invalid JSON → onError, no successful reload, the last good value stays; the watcher carries on', async (t) => {
  const s = fixture(t, { v: 1 });
  s.watch(); await baseline();
  fs.writeFileSync(s.file, '{"v": 2,');   // half-written
  await until(() => s.errors.length === 1, 'onError');
  assert.ok(s.errors[0] instanceof SyntaxError, `the reload's own error is handed over: ${s.errors[0]}`);
  assert.equal(s.loads, 0, 'no successful reload');
  assert.deepEqual(s.good, { v: 1 }, 'the last good value is still in force');
  fs.writeFileSync(s.file, JSON.stringify({ v: 3, fixed: true }));
  await until(() => s.loads === 1, 'the reload once the file is good again');
  assert.deepEqual(s.good, { v: 3, fixed: true });
  assert.equal(s.errors.length, 1);
});

test('an async reload that rejects reaches onError too', async (t) => {
  const s = fixture(t, { v: 1 });
  const un = watchConfig(s.file, async () => { await sleep(5); throw new Error('refused by the validator'); },
    { intervalMs: POLL, onError: (e) => s.errors.push(e) });
  t.after(un); await baseline();
  fs.writeFileSync(s.file, JSON.stringify({ v: 2 }));
  await until(() => s.errors.length === 1, 'onError');
  assert.equal(s.errors[0].message, 'refused by the validator');
});

// R4: with no finally, a throwing onError left `running` true, and every later change queued behind
// a reload that never ends — the watcher stopped for good. Its rejection was unhandled too.
test('an onError that throws (once) is logged with both errors, and the next edit still reloads', async (t) => {
  const s = fixture(t, { v: 1 });
  const logged = [];
  t.mock.method(console, 'error', (...a) => logged.push(a));
  let throws = 1;
  s.watch({ onError: (e) => { s.errors.push(e); if (throws-- > 0) throw new Error('audit.log is not writable'); } });
  await baseline();
  fs.writeFileSync(s.file, '{"v": 2,');   // a bad save: onError runs, and throws
  await until(() => logged.length === 1, 'the logged onError failure');
  assert.match(String(logged[0][0]), /onError threw while reporting a failed reload/);
  assert.ok(logged[0].some((x) => x instanceof Error && x.message === 'audit.log is not writable'), 'the onError failure is logged');
  assert.ok(logged[0].some((x) => x instanceof SyntaxError), 'and so is the reload failure it was reporting');
  fs.writeFileSync(s.file, JSON.stringify({ v: 3, after: true }));
  await until(() => s.loads === 1, 'the next edit to reload');
  assert.deepEqual(s.good, { v: 3, after: true });
  assert.equal(s.errors.length, 1, 'that edit loaded cleanly');
});

test('unwatch stops it — a save after it, and a reload already pending, never run', async (t) => {
  const s = fixture(t, { v: 1 });
  const un = s.watch(); await baseline();
  fs.writeFileSync(s.file, JSON.stringify({ v: 2, pending: true }));
  await s.seenBy(1);   // seen: the debounce timer is armed, the reload not yet run
  assert.equal(s.loads, 0, 'CONTROL: the reload was still pending when unwatch ran');
  un();
  await sleep(SETTLE_MS);
  assert.equal(s.loads, 0, 'the pending reload was cancelled');
  fs.writeFileSync(s.file, JSON.stringify({ v: 3, after: true }));
  await sleep(SETTLE_MS);
  assert.equal(s.loads, 0, 'a save after unwatch is not seen');
  // CONTROL: the same steps on a watcher left on do reload — the waits above are long enough to see one.
  const c = fixture(t, { v: 1 });
  c.watch(); await baseline();
  fs.writeFileSync(c.file, JSON.stringify({ v: 2, pending: true }));
  await c.seenBy(1);
  await sleep(SETTLE_MS);
  assert.equal(c.loads, 1, 'CONTROL: a watcher left on reloads');
});

test('a watcher never keeps a process alive (persistent:false, unref’d timer)', (t) => {
  const s = fixture(t, { v: 1 });
  const src = `import { watchConfig } from ${JSON.stringify(pathToFileURL(MODULE).href)};
    watchConfig(${JSON.stringify(s.file)}, () => {}, { intervalMs: 20 });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', src], { timeout: 5000, encoding: 'utf8' });
  assert.equal(r.error, undefined, `the process had to be killed: it was still alive after 5 s (${r.error && r.error.code})`);
  assert.equal(r.status, 0, r.stderr);
});
