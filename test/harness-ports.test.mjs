// R14 — the harness's own port allocator, because a flaky harness reports flaky results.
//
// The suite failed about one run in six, always in a file that boots the REAL web.mjs, never
// when that file ran alone: empty-overwrite, fail-legibility, note-whole-file, diabetes-store,
// app-load — the victim moved, which is the signature of a race rather than a defect in any of
// them. Cause: freePort() bound port 0, read the number, CLOSED the socket and returned it, so
// the port was free until the child bound it. `node --test` runs these files as parallel
// processes, and two of them could be handed the same number.
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { freePort, releasePort, portWindowFor, PORT_POOL, PORT_WINDOW as SPAN, mkWebRoot, startWeb, stopWeb, waitReady, lockFileFor, pidAlive, STALE_EMPTY_MS, FETCH_BLOCKED_PORTS } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skipIf, skipBecause } from './helpers-skip.mjs';
// SPAN: windows are SPAN-wide and SPAN-aligned, so "different" implies "disjoint".

// Can `p` be bound: on 127.0.0.1 (bindable), or on every interface, as web.mjs binds (listensLikeWeb)?
const listensOn = (p, host) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen({ port: p, host }, () => s.close(() => resolve(true)));
});
const bindable = (p) => listensOn(p, '127.0.0.1'), listensLikeWeb = (p) => listensOn(p, undefined);
// The port the NEXT freePort() call tries first: one past the last, wrapping inside the window, and
// past any port fetch() refuses (freePort skips those).
const nextAfter = (p) => { const w = portWindowFor(process.pid); let n = p; do n = w + ((n - w + 1) % SPAN); while (FETCH_BLOCKED_PORTS.has(n)); return n; };

test('CONTROL: the OLD allocator really did hand out a port it no longer held', async () => {
  // Verbatim what freePort used to do. This is not a hypothetical race: the moment it resolves,
  // the port it just promised is bindable by ANY other process — which is exactly how two test
  // files ended up on one port. If this control ever fails, the test below proves nothing.
  const released = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  assert.equal(await bindable(released), true,
    'the old implementation returned a port that was already free for anyone to take');
});

test('near-consecutive pids (files spawned together) get disjoint windows', () => {
  // Test files are spawned together, so their pids are near-consecutive — the case that must
  // never collide. Same pid must be stable, or a process would wander out of its own window.
  const pid = process.pid;
  for (let d = 1; d <= 8; d += 1) {
    const gap = Math.abs(portWindowFor(pid) - portWindowFor(pid + d));
    assert.notEqual(gap, 0, `pids ${pid} and ${pid + d} share a window`);
    assert.equal(gap % SPAN, 0, 'windows are SPAN-aligned, so distinct windows cannot overlap');
  }
  assert.equal(portWindowFor(pid), portWindowFor(pid), 'a pid maps to one window');
});

test('every port handed out is in this process\'s window, and no port is handed out twice', async () => {
  const mine = portWindowFor(process.pid);
  const seen = new Set();
  const held = [];
  try {
    for (let i = 0; i < 4; i += 1) {
      const p = await freePort();
      assert.ok(p >= mine && p < mine + SPAN, `${p} is outside this process's window ${mine}..${mine + SPAN - 1}`);
      assert.equal(seen.has(p), false, `${p} was handed out twice — two servers in one file would collide`);
      seen.add(p);
      // Hold it, the way a booted web.mjs would: the NEXT call must not offer it again just
      // because the allocator's own probe socket was closed.
      held.push(await new Promise((r) => { const s = net.createServer(); s.listen(p, '127.0.0.1', () => r(s)); }));
    }
  } finally { for (const s of held) s.close(); }
});

test('a port already held by something else is never handed out', async () => {
  // The probe is what makes a pid-window collision self-heal instead of producing two servers on
  // one port. Squatting on arbitrary ports would prove nothing — the allocator's cursor has
  // already moved past them, and an earlier test in this file moved it further. So squat on
  // EXACTLY the port the next call is about to return.
  const first = await freePort();
  const next = nextAfter(first);   // the port the next call tries first
  const squatter = await new Promise((r, j) => {
    const s = net.createServer();
    s.once('error', j);
    s.listen(next, '127.0.0.1', () => r(s));
  });
  try {
    const got = await freePort();
    assert.notEqual(got, next, 'handed out a port something else is listening on');
  } finally { squatter.close(); }
});

test('a just-released port is not handed straight back out', async () => {
  // What the cursor is for. stopWeb releases its port's lock, and the port is then bindable while
  // the old server may still be vacating it, so neither the probe nor the lock would refuse it.
  const released = await freePort(); releasePort(released);   // released, as stopWeb does
  assert.equal(await bindable(released), true, 'precondition: the probe alone would re-offer it');
  assert.notEqual(await freePort(), released, 'the next server would land on a port still being vacated');
});

test('the live node\'s port is not in the pool at all', () => {
  // 8787 is the family's real server. mkWebRoot refuses it, but the allocator must never
  // produce it in the first place.
  for (const pid of [1, 2, 999, 12345, 65535]) {
    const w = portWindowFor(pid);
    assert.ok(8787 < w || 8787 >= w + SPAN, `window ${w} contains the live port`);
  }
});

// The range the OS hands out for listen(0) and outbound connections, read from THIS machine.
// null = cannot read it here; the live check below then SKIPS (counted), it never passes.
const ephemeralRange = () => {
  try {
    if (process.platform === 'linux') {
      const [lo, hi] = fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
      return { lo, hi };
    }
    if (process.platform === 'darwin') {
      const get = (k) => Number(execFileSync('sysctl', ['-n', k], { encoding: 'utf8' }).trim());
      return { lo: get('net.inet.ip.portrange.first'), hi: get('net.inet.ip.portrange.last') };
    }
    if (process.platform === 'win32') {
      const out = execFileSync('netsh', ['int', 'ipv4', 'show', 'dynamicport', 'tcp'], { encoding: 'utf8' });
      const [start, count] = [...out.matchAll(/:\s*(\d+)/g)].map((m) => Number(m[1]));
      return { lo: start, hi: start + count - 1 };
    }
  } catch { return null; }   // no /proc, no sysctl, localised netsh: unknown, so the check skips
  return null;
};
const RANGE = ephemeralRange();
const rangeOk = RANGE && Number.isInteger(RANGE.lo) && Number.isInteger(RANGE.hi) && RANGE.lo <= RANGE.hi;

test('the pool sits below every OS\'s DEFAULT ephemeral range (Linux starts at 32768)', () => {
  // Static, so it holds on the Mac too: the pool was once chosen against the macOS/Windows range
  // only, and half of it was ephemeral on the Linux CI runner.
  assert.ok(PORT_POOL.hi <= 32768, `pool ${PORT_POOL.lo}..${PORT_POOL.hi} reaches into Linux's ephemeral range`);
  for (const pid of [1, 2, 999, 12345, 65535, 4194303]) {
    const w = portWindowFor(pid);
    assert.ok(w >= PORT_POOL.lo && w + SPAN <= PORT_POOL.hi, `window ${w} is outside the pool`);
  }
});

test('the pool is disjoint from THIS machine\'s ephemeral range', { skip: skipIf(!rangeOk, 'env-moot', 'cannot read this OS\'s ephemeral port range') }, () => {
  // listen(0) in a parallel test file, or any outbound connection, takes a port from this range.
  // A pool port inside it can be taken between the probe's close and web.mjs's bind.
  assert.ok(PORT_POOL.hi <= RANGE.lo || PORT_POOL.lo > RANGE.hi,
    `pool ${PORT_POOL.lo}..${PORT_POOL.hi - 1} overlaps the ephemeral range ${RANGE.lo}..${RANGE.hi}`);
});

test('a port held on another interface is never handed out if web.mjs could not bind it', async (t) => {
  // Shaped like the CI runner's own connections: something holds the port on a NON-loopback address.
  const ip = Object.values(os.networkInterfaces()).flat().find((a) => a.family === 'IPv4' && !a.internal)?.address;
  if (!ip) { t.skip(skipBecause('env-moot', 'no non-loopback IPv4 interface to hold a port on')); return; }
  const next = nextAfter(await freePort());
  const squatter = await new Promise((r, j) => { const s = net.createServer(); s.once('error', j); s.listen(next, ip, () => r(s)); });
  try {
    // CONTROL (R14): the assertion below can only fail where the old 127.0.0.1-only probe is FOOLED:
    // it sees the port free while web.mjs's every-interface bind fails. Elsewhere (macOS lets the
    // two binds coexist) the old helper passes too, so the test SKIPS rather than claim a pass.
    // Measured, not assumed by OS name; on Linux it is asserted, so it can never quietly become a skip.
    const looksFree = await bindable(next);
    const webBinds = await listensLikeWeb(next);
    const fooled = looksFree && !webBinds;
    if (process.platform === 'linux') {
      assert.equal(fooled, true, 'precondition: on Linux a 127.0.0.1 probe misses a holder that blocks web.mjs '
        + `(127.0.0.1 probe says free: ${looksFree}; web.mjs-style bind succeeds: ${webBinds})`);
    } else if (!fooled) {
      t.skip(skipBecause('env-moot', `a 127.0.0.1 probe is not fooled on ${process.platform}, so this cannot tell the old probe from the new`));
      return;
    }
    const got = await freePort();
    assert.equal(await listensLikeWeb(got), true, `${got} was handed out, but web.mjs could not bind it`);
  } finally { squatter.close(); }
});

// ── Two files sharing a window (pids WINDOWS apart), 2026-10-13 ─────────────────────────────────
// The probe releases its port before the child binds, so two processes in one window could both be
// handed it. A lock file per port reserves it across processes. Seen in a full run: every HTTP test
// of one file answered 401 — another root's server, reached through the shared port.
// Plant a lock for `p` the way another process would (O_EXCL), on a port that is free; null when the
// port is busy or a real lock already holds it — then the test has nothing to prove and says so.
async function plant(p, pid) {
  if (!(await bindable(p))) return null;
  fs.mkdirSync(path.dirname(lockFileFor(p)), { recursive: true });
  try { fs.writeFileSync(lockFileFor(p), String(pid), { flag: 'wx' }); return p; }
  catch (e) { if (e.code === 'EEXIST') return null; throw e; }
}

test('a port another LIVE process has reserved is never handed out', async (t) => {
  const next = nextAfter(await freePort());
  if (!(await plant(next, process.ppid))) return t.skip(skipBecause('env-moot', `${next} is busy or already reserved: nothing to prove`));
  try {
    assert.notEqual(await freePort(), next, `${next} is reserved by pid ${process.ppid} (the runner) and must be skipped`);
  } finally { if (fs.readFileSync(lockFileFor(next), 'utf8') === String(process.ppid)) fs.rmSync(lockFileFor(next)); }
});

test('a reservation whose owner is gone is taken over', async (t) => {
  const next = nextAfter(await freePort());
  const dead = spawnSync(process.execPath, ['-e', '']).pid;   // exited by the time spawnSync returns
  if (pidAlive(dead)) return t.skip(skipBecause('env-moot', `pid ${dead} was reused at once (Windows recycles pids): nothing to prove`));
  if (!(await plant(next, dead))) return t.skip(skipBecause('env-moot', `${next} is busy or already reserved: nothing to prove`));
  assert.equal(await freePort(), next, `a lock left by dead pid ${dead} must not hold ${next} forever`);
  assert.equal(fs.readFileSync(lockFileFor(next), 'utf8'), String(process.pid), 'and it is now this process\'s');
});

// waitReady used to accept ANY answer on the port; with the port taken by another server, the
// child cannot bind, so it must not be reported ready. CONTROL: once the squatter goes, the same
// child binds (web.mjs retries its listen) and waitReady does report it.
test('waitReady does not take another server\'s answer for this child being ready', async () => {
  const port = await freePort();
  const squatter = http.createServer((q, r) => r.end('{}'));
  await new Promise((r) => squatter.listen(port, '127.0.0.1', r));   // the address web.mjs binds by default (lib/bind.mjs)
  const root = mkWebRoot({ port });
  const web = startWeb(root);
  try {
    await assert.rejects(waitReady(port, { timeoutMs: 1200 }), /not by this child/);
    await new Promise((r) => squatter.close(r));
    await waitReady(port, { timeoutMs: 8000 });
    assert.ok(fs.existsSync(path.join(root, 'setup-code')), 'a bind won on a RETRY still mints the setup code');
  } finally { await stopWeb({ ...web, root }); squatter.close(); rmTemp(root); }   // a COPY, as web-lifecycle passes
  const held = () => { try { return fs.readFileSync(lockFileFor(port), 'utf8'); } catch { return null; /* no lock: released */ } };
  assert.notEqual(held(), String(process.pid), 'stopWeb released the port\'s reservation');
});

// A root restarted after stopWeb still holds the LAST boot's listen line in its web.log (append):
// waitReady must judge only this boot's lines, or another process on the freed port passes for it.
test('a restarted root is not ready on its previous boot\'s listen line', async () => {
  const port = await freePort();
  const root = mkWebRoot({ port });
  const first = startWeb(root);
  try { await waitReady(port); } finally { await stopWeb(first); }
  const squatter = http.createServer((q, r) => r.end('{}'));
  await new Promise((r) => squatter.listen(port, '127.0.0.1', r));
  const second = startWeb(root);
  try {
    await assert.rejects(waitReady(port, { timeoutMs: 1200 }), /not by this child/);
    await new Promise((r) => squatter.close(r));
    await waitReady(port, { timeoutMs: 8000 });   // CONTROL: once the port is free, this boot binds and counts
  } finally { await stopWeb(second); squatter.close(); rmTemp(root); }
});

// A lock with no pid yet is being written; one that stays empty was abandoned and is taken over.
test('an empty lock is skipped while fresh and taken over once stale', async (t) => {
  const next = nextAfter(await freePort());
  if (!(await plant(next, ''))) return t.skip(skipBecause('env-moot', `${next} is busy or already reserved: nothing to prove`));
  assert.notEqual(await freePort(), next, 'a fresh empty lock is still being written: skipped');
  const then = (Date.now() - STALE_EMPTY_MS - 1000) / 1000;
  fs.utimesSync(lockFileFor(next), then, then);
  const got = [];   // the cursor moved past `next`; walk the window round to it
  for (let i = 0; i < SPAN && !got.includes(next); i += 1) got.push(await freePort());
  assert.ok(got.includes(next), `a stale empty lock must not hold ${next} forever`);
  assert.equal(fs.readFileSync(lockFileFor(next), 'utf8'), String(process.pid));
});

// On exit a process removes only the locks that still name it: after a take-over race another
// process may own one. A child reserves a port; the lock is then rewritten to name THIS process;
// when the child exits, the lock must survive.
test('a process exiting removes only the locks that still name it', async () => {
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers-web.mjs');
  const other = portWindowFor(process.pid + 2);   // a valid window, never this file's own (the empty-lock test fills that)
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `const { freePort } = await import(${JSON.stringify(pathToFileURL(helper).href)}); console.log(await freePort()); process.stdin.once('data', () => process.exit(0));`],
    { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, PA_TEST_PORT_WINDOW: String(other) } });
  const exited = new Promise((r) => child.once('exit', r));
  let port;
  try {
    port = Number(await new Promise((r) => child.stdout.once('data', (d) => r(String(d).trim()))));
    assert.equal(fs.readFileSync(lockFileFor(port), 'utf8'), String(child.pid), 'CONTROL: the child holds it');
    fs.writeFileSync(lockFileFor(port), String(process.pid));   // as if this process had taken it over
    child.stdin.write('go\n');
    await exited;
    assert.equal(fs.readFileSync(lockFileFor(port), 'utf8'), String(process.pid), 'the child left the lock it no longer owned');
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }   // a failed assertion must not leave it running
    if (port) fs.rmSync(lockFileFor(port), { force: true });
  }
});

// A port fetch() refuses is never handed out. A child process pinned to the window that holds it
// walks it until past the blocked port. CONTROL: fetch really refuses it (undici: "bad port"), and the child was
// handed ports on both sides of it, so it did walk across it.
test('a port fetch() refuses is never handed out', async (t) => {
  for (const p of FETCH_BLOCKED_PORTS) {
    assert.ok(p >= PORT_POOL.lo && p < PORT_POOL.hi, `${p} is in the pool, so a process's window can reach it`);
    await assert.rejects(fetch(`http://127.0.0.1:${p}/`), (e) => /bad port/.test(String(e.cause && e.cause.message)), 'CONTROL: fetch refuses it');
    const start = PORT_POOL.lo + Math.floor((p - PORT_POOL.lo) / SPAN) * SPAN;
    if (start === portWindowFor(process.pid)) return t.skip(skipBecause('env-moot', `this file's own window holds ${p}, and its tests already hold that window's ports`));
    const helper = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'helpers-web.mjs')).href;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const { freePort } = await import(${JSON.stringify(helper)}); const got = [];
       for (let i = 0; i < ${SPAN} && !(got.at(-1) > ${p}); i += 1) {   // stop once past ${p}: hold no more of the window than that
         try { got.push(await freePort()); } catch (e) { if (!/no free port/.test(e.message)) throw e; break; /* window exhausted */ }
       }
       console.log(JSON.stringify(got));`], { env: { ...process.env, PA_TEST_PORT_WINDOW: String(start) }, encoding: 'utf8' });
    const got = JSON.parse(out);
    assert.ok(!got.includes(p), `${p} was handed out`);
    assert.ok(got.some((x) => x < p) && got.some((x) => x > p), `CONTROL: the walk crossed ${p} (${got.length} ports handed)`);
  }
});
