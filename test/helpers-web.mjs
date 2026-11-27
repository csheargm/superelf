// HTTP-level harness (R6): boots the REAL web.mjs as a child process — the
// exact committed module, copied byte-identical into a throwaway root whose
// lib/ and web/ are symlinks back to the repo — with a throwaway config,
// throwaway owner, throwaway workspace, and a port from this process's window (below the OS's
// ephemeral range, reserved across processes — see freePort). Test-harness
// fidelity rule: no route logic is re-implemented or mocked here; requests go
// over real HTTP to the real server. NEVER the live config.json, NEVER live
// workspaces, NEVER port 8787 (the live node) — enforced below, not assumed.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OWNER_TOKEN = 'test-owner-token-0123456789abcdef';
export const FAKE_OCR_CMD = path.join(REPO, 'test', 'fixtures', 'fake-panote-ocr.mjs');   // see the file's header
// A 1x1 PNG — real bytes, so decodeBase64Strict on /api/upload accepts it the way it accepts a
// real screenshot. (Hand-written "not-really-base64" would be rejected and prove nothing.)
export const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const LIVE_PORT = 8787; // the family node — tests must never touch it

// A free port from this process's window, reserved across processes (see reservePort below).
//
// `node --test` runs these files as PARALLEL PROCESSES. The previous implementation — bind 0,
// read the number, close, return it — handed the SAME number to two files whenever the kernel
// reused the just-closed port, because the port is genuinely free between that close and the
// child's bind. The old comment here called the race acceptable on the grounds that web.mjs
// retries a failed listen. That reasoning only covers the loser that CANNOT BIND. The real
// damage is the other loser: it binds nothing, its `waitReady` reaches the WINNER's server, and
// every assertion after that reads another test's root — so a "must 404" test sees a 200 and a
// "wrote nothing" test sees a file the other root wrote. Both of those were observed. It was the
// ~1-run-in-6 suite flake that never reproduced when a file ran alone.
//
// Deriving the window from the pid keeps files spawned together (near-consecutive pids) in
// different windows, and the bind probe below keeps a port that something else already holds from
// being handed out at all. Pids WINDOWS apart still share a window, and the probe releases its port
// before the child binds: the cross-process reservation below closes that.
//
// The pool must sit BELOW every OS's ephemeral range. SCAR (2026-10-11, first Linux CI runs): it
// was 20000..49000, chosen against the macOS/Windows range (49152+). Linux's default range is
// 32768..60999, so most of the pool was ephemeral there: between the probe's close and web.mjs's
// bind, a parallel file's listen(0) or an outbound connection could take the port, web.mjs used up
// its listen retries, and api-no-store failed with "web not ready within 10000ms". Never on a Mac.
const PORT_LO = 10000;                 // above the well-known ports and the live node's 8787…
const PORT_HI = 32768;                 // …and below the LOWEST default ephemeral start (Linux 32768)
export const PORT_POOL = Object.freeze({ lo: PORT_LO, hi: PORT_HI });   // [lo, hi), asserted in harness-ports
// Ports fetch() refuses outright ("bad port", the Fetch standard's port-blocking list): the only one in
// the pool is 10080. A server bound there boots fine and every request to it fails — seen: a full run
// where one file's waitReady saw only "fetch failed" for 10 s although web.mjs had logged its bind.
export const FETCH_BLOCKED_PORTS = Object.freeze(new Set([10080]));
export const PORT_WINDOW = 64;        // ports one process may hand out (windows are this wide and aligned)
const WINDOW = PORT_WINDOW;
const WINDOWS = Math.floor((PORT_HI - PORT_LO) / WINDOW);
export const portWindowFor = (pid) => PORT_LO + (pid % WINDOWS) * WINDOW;
// The live node can never be handed out because it sits outside the pool entirely. Asserted, not
// assumed — moving PORT_LO below it would silently put the family's port back in play.
if (LIVE_PORT >= PORT_LO && LIVE_PORT < PORT_HI) throw new Error(`port pool must exclude the live node's ${LIVE_PORT}`);

// Free means free on BOTH addresses that matter, because the OSes disagree about which binds
// conflict (measured 2026-10-11): web.mjs binds 127.0.0.1 by default (lib/bind.mjs), every interface with bind_host 0.0.0.0 —
// and the tests connect to 127.0.0.1. On Linux a port held on another address passes a 127.0.0.1
// probe yet fails web.mjs's bind; on macOS a wildcard and a 127.0.0.1 listener coexist, so only a
// 127.0.0.1 probe sees a loopback squatter, which would then answer the tests instead of web.mjs.
const bindableOn = (p, host) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen({ port: p, host }, () => s.close(() => resolve(true)));
});
const bindable = async (p) => await bindableOn(p, undefined) && bindableOn(p, '127.0.0.1');

// A RESERVATION across processes (2026-10-13). The windows above come from pid % WINDOWS, so two
// concurrent files CAN share one, and the bind probe releases the port before the child binds: both
// could be handed it, and the loser's waitReady reached the winner's server (seen: every HTTP test
// of one file answered 401 — the other root's tokens). A port is handed out only by the process
// that created its lock file (O_EXCL); a lock whose owner process is gone is taken over.
// Residual race, accepted (R13): two processes that both see the same DEAD owner at the same instant
// can both take the lock over; the loser's child then cannot bind and waitReady fails LOUDLY (below),
// never by reaching the other root. It needs a crash-left lock plus two files in one window at once.
const LOCK_DIR = path.join(os.tmpdir(), 'pa-test-ports');
export const STALE_EMPTY_MS = 5000;   // a lock with no pid yet is being written; older than this, it was abandoned
export const lockFileFor = (p) => path.join(LOCK_DIR, `${p}.lock`);
const myLocks = new Set();
// kill(pid, 0) sends nothing: ESRCH means no such process (dead), EPERM means it exists (alive) — under
// another user, which a child of these tests never is. The one copy for every test (R3).
export const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const mine = (f) => { try { return fs.readFileSync(f, 'utf8') === String(process.pid); } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
function reservePort(p) {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const f = lockFileFor(p);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { fs.writeFileSync(f, String(process.pid), { flag: 'wx' }); myLocks.add(f); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = NaN, age = 0;
      try { owner = Number(fs.readFileSync(f, 'utf8')); age = Date.now() - fs.statSync(f).mtimeMs; }
      catch (r) { if (r.code !== 'ENOENT') throw r; continue; /* released meanwhile: try again */ }
      const unwritten = !Number.isInteger(owner) || owner <= 0;
      if (unwritten ? age < STALE_EMPTY_MS : pidAlive(owner)) return false;   // held, or still being written
      try { fs.unlinkSync(f); } catch (u) { if (u.code !== 'ENOENT') throw u; /* another process took it over first */ }
    }
  }
  return false;
}
// Only a lock that still names this process is removed: after the race above another may own it.
// Exported for harness-ports (here: stopWeb, and freePort when its probe fails).
export function releasePort(p) {
  const f = lockFileFor(p);
  if (mine(f)) fs.unlinkSync(f);
  myLocks.delete(f);
}
// An exit handler must not throw: Node would skip the handlers after it, reapAll among them, and
// orphan live servers. A lock it cannot remove is left to the next run, which takes over a dead owner's.
process.on('exit', () => {
  for (const f of myLocks) { try { if (mine(f)) fs.unlinkSync(f); } catch { /* see above: never throw here */ } }
});

// The cursor: a port stopWeb just released is unreserved and bindable at once, while the old server
// may still be vacating it, so the next call must not hand it straight back. (The locks keep two
// LIVE servers in one file apart.)
let handed = 0;
// PA_TEST_PORT_WINDOW pins this process's window (harness-ports pins child processes with it: one to
// the window holding a fetch-blocked port, one away from its own); it must be a window start inside
// the pool, or it is refused.
const windowStart = () => {
  const pinned = process.env.PA_TEST_PORT_WINDOW;
  if (pinned === undefined) return portWindowFor(process.pid);
  const w = Number(pinned);
  if (!Number.isInteger(w) || w < PORT_LO || w + WINDOW > PORT_HI || (w - PORT_LO) % WINDOW) throw new Error(`PA_TEST_PORT_WINDOW=${pinned} is not a window start in the pool`);
  return w;
};
export async function freePort() {
  const start = windowStart();
  for (let i = 0; i < WINDOW; i += 1) {
    const p = start + ((handed + i) % WINDOW);
    if (FETCH_BLOCKED_PORTS.has(p) || !reservePort(p)) continue;   // reserved first, so no other process probes a port this one holds
    if (await bindable(p)) { handed = (handed + i + 1) % WINDOW; return p; }
    releasePort(p);
  }
  throw new Error(`no free port in ${start}..${start + WINDOW - 1} (this process's window)`);
}

// A throwaway server root: real web.mjs (copy), symlinked lib/ + web/, and a
// minimal valid config. `extraConfig` overlays config.json (e.g. public_base_url).
export function mkWebRoot({ port, extraConfig = {} }) {
  if (!Number.isInteger(port) || port === LIVE_PORT) throw new Error(`refusing port ${port} — tests never bind the live node's port`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-web-'));
  fs.copyFileSync(path.join(REPO, 'web.mjs'), path.join(root, 'web.mjs'));
  fs.copyFileSync(path.join(REPO, 'package.json'), path.join(root, 'package.json'));
  // superelf.md too: web.mjs reads the app contract out of it AT BOOT (appContract), and throws
  // if a clause is missing rather than starting with a silently empty contract. A root without it
  // is not a root the real server could run from, so the harness would be testing a fiction.
  fs.copyFileSync(path.join(REPO, 'superelf.md'), path.join(root, 'superelf.md'));
  // tools/ is symlinked too: web.mjs imports tools/websearch.mjs for the brokered search
  // route. It also has to sit OUTSIDE every workspace here exactly as it does in the real
  // root, or the test that proves a member cannot reach it would be testing its own fixture.
  for (const d of ['lib', 'web', 'tools']) fs.symlinkSync(path.join(REPO, d), path.join(root, d));
  fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    default_project: 'assistant',
    projects: { assistant: { dir: 'workspace' } },
    web_port: port,
    web_token: 'test-web-token-abcdefgh',
    users: [{ id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' }],
    // NEVER the real model service. The defaults are localhost:11434 (real cloud inference) and
    // ollama.com, and the server's own scheduler runs the model-check job on any tick after its
    // time: a harness server alive for a minute would have probed both. Port 9 refuses at once;
    // a test that needs Ollama passes its own stub in extraConfig.
    ollama_url: 'http://127.0.0.1:9',
    ollama_catalog_url: '',
    // NEVER the real Vision tool either: a saved notebook with strokes starts the OCR queue
    // (lib/note-ocr-queue.mjs), which on a Mac would compile and run tools/panote-ocr in the
    // background of every harness server. The fake answers the same contract deterministically.
    note_ocr_cmd: FAKE_OCR_CMD,
    ...extraConfig,
  }, null, 2));
  return root;
}

// What web.mjs logs from its listen callback, and only there (web.mjs server.listen): proof that THIS
// child bound its port. The one copy for every test that waits on a boot (R3).
export const LISTEN_PREFIX = '[web] http://localhost:';
export const LISTEN_LINE = (port) => `${LISTEN_PREFIX}${port} `;

// The instance most recently started for each port, so waitReady can say WHY a server never came
// up. SCAR (CI, 2026-10-11): "web on :38176 not ready within 10000ms" and nothing else — the child's
// own log, which said why, was deleted with its temp root.
const STARTED = new Map();               // port → the startWeb() instance that will bind it
const LOG_FDS = new Map();               // child → the parent's open fd on its web.log (stopWeb closes it)
const LOG_TAIL_LINES = 20;

// Spawn `node web.mjs` in a root; stdout+stderr go to <root>/web.log so tests
// can assert on boot messages (listen retries, graceful shutdown).
export function startWeb(root) {
  const logFile = path.join(root, 'web.log');
  // Where THIS boot's log starts: a root restarted after stopWeb still holds the last boot's listen
  // line, which must not count as this child having bound (waitReady reads only from here on).
  let logStart = 0;
  try { logStart = fs.statSync(logFile).size; } catch (e) { if (e.code !== 'ENOENT') throw e; /* first boot in this root */ }
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, [path.join(root, 'web.mjs')], { cwd: root, stdio: ['ignore', fd, fd] });
  LIVE.add(child);                       // tracked so an interrupted run cannot orphan it (see reapAll)
  child.once('exit', () => LIVE.delete(child));
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const read = () => { try { return fs.readFileSync(logFile); } catch { return Buffer.alloc(0); /* no log written yet */ } };
  LOG_FDS.set(child, fd);                // closed in stopWeb — see LOG_FDS
  const inst = { child, exited, logFile, log: () => read().toString('utf8'), bootLog: () => read().subarray(logStart).toString('utf8') };
  // The port comes from the config the child itself reads, so it is the port it will try to bind.
  let port;
  try { port = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).web_port; }
  catch { /* no readable config: the child fails at boot on its own, and waitReady still times out loudly — only without the log tail */ }
  if (Number.isInteger(port)) STARTED.set(port, inst);
  return inst;
}

// Poll a public route until the server answers (any HTTP status = bound) AND, for a server started
// here, its own log says it bound (web.mjs logs `[web] http://localhost:<port>` from its listen
// callback only): an answer from ANOTHER process on the port is not this server being ready. A
// failure carries the child's exit status and the tail of its web.log; a child that has already
// exited fails at once instead of spending the rest of the budget polling a dead process.
export async function waitReady(port, { timeoutMs = 10000 } = {}) {
  const inst = STARTED.get(port);
  const fail = (what) => new Error(`web on :${port} ${what}${inst
    ? `\n--- last ${LOG_TAIL_LINES} lines of ${inst.logFile} ---\n${inst.log().trimEnd().split('\n').slice(-LOG_TAIL_LINES).join('\n')}`
    : ''}`);
  const until = Date.now() + timeoutMs;
  for (;;) {
    let refused;
    try {
      await fetch(`http://127.0.0.1:${port}/api/setup-status`);
      if (!inst || inst.bootLog().includes(LISTEN_LINE(port))) return;
      refused = 'answered, but not by this child (its log has no listen line)';
    } catch (e) { refused = e.cause?.code || e.message; }
    if (inst && (inst.child.exitCode !== null || inst.child.signalCode !== null)) {
      throw fail(`exited before it was ready (code ${inst.child.exitCode}, signal ${inst.child.signalCode})`);
    }
    if (Date.now() > until) throw fail(`not ready within ${timeoutMs}ms (last attempt: ${refused})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Poll until `fn` returns truthy (log-line waits) — bounded, never forever. `fn` may be async: its
// promise is awaited, never counted as truthy (a pending promise once made a wait pass at once).
export async function waitFor(fn, what, { timeoutMs = 8000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// SCAR (2026-09-02): stopWeb only runs when a test reaches its cleanup. A run that
// is interrupted — a timed-out foreground call, Ctrl-C, a throwing test — left real
// servers alive; 3 orphans and 12 temp roots were found on the dev machine. These
// handlers are the backstop: whatever happens to the runner, the children die with it.
const LIVE = new Set();
const reapAll = () => { for (const c of LIVE) { try { c.kill('SIGKILL'); } catch { /* already gone */ } } LIVE.clear(); };
process.on('exit', reapAll);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { reapAll(); process.exit(130); });   // exit(130) = killed by signal, keeps the runner's failure visible
}

// Stop a child: SIGTERM (the graceful path under test elsewhere), SIGKILL as
// cleanup backstop only.
export async function stopWeb(inst) {
  if (inst.child.exitCode === null && inst.child.signalCode === null) {
    inst.child.kill('SIGTERM');
    const killer = setTimeout(() => inst.child.kill('SIGKILL'), 8000);
    await inst.exited;
    clearTimeout(killer);
  }
  // Close the parent's handle on <root>/web.log BEFORE the caller removes the root: Windows refuses
  // rmdir while any handle inside is open (CI EBUSY, 2026-11-11). Keyed by child, not by the inst
  // object, because callers pass copies — and a closed fd number must never be closed twice.
  const fd = LOG_FDS.get(inst.child);
  if (fd !== undefined) { LOG_FDS.delete(inst.child); fs.closeSync(fd); }
  // Its port is free again: release the reservation, so a file's locks follow its live servers
  // (a file may boot more servers in its life than a window holds).
  for (const [port, i] of STARTED) if (i.child === inst.child) { STARTED.delete(port); releasePort(port); }   // by child: callers pass copies
  return inst.exited;
}

export const api = (port, p, opts = {}) => fetch(`http://127.0.0.1:${port}${p}`, {
  ...opts,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}`, ...(opts.headers || {}) },
});

// The page in the shell's app frame (#fr), by its ELEMENT: on the srcdoc route (WebKit, web/sw-client.js)
// its URL is about:srcdoc, so a lookup by URL found nothing and a test read null (CI flake v5.37.1).
// Call after waiting for something inside the app: the app loads into a fresh #fr (web/app-frame.js).
export async function shellAppFrame(page) {
  const el = await page.$('#fr');
  const fr = el && await el.contentFrame();
  if (!fr) throw new Error('no page in #fr');
  return fr;
}
