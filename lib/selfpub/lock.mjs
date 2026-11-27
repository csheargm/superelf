// 一次只做一个改动 · The core lane's lock: one core change in flight per node (docs/adr/0044 §1).
// <selfpub_root>/.lock holds who owns it: { pid, proc, owner, host, boot, start, at }.
//   proc  — a random id of THIS process (its lineage); pid alone is not an identity: in a container the
//           node is PID 1 after every restart, so a dead run's "PID 1" looked alive forever (2026-11-27).
//   owner — a random id of this acquisition: release removes only its own lock.
//   start — the owner pid's start time (Linux /proc), so a reused pid is told apart.
// The holder touches the file every maxAge/HEARTBEATS_PER_AGE, so a running publish is never stolen; a lock
// whose owner is gone, or that stopped beating for maxAgeMs (selfpub_lock_max_ms, read per acquire), is reclaimed.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublishError } from '../publish/collect.mjs';

export const DEFAULT_LOCK_MAX_MS = 30 * 60 * 1000;   // many sync git calls (120 s timeout each) can block a beat in a row
export const MIN_LOCK_MAX_MS = 5 * 60 * 1000;        // floor for the config value: above one blocked git call with room to spare
export const HEARTBEATS_PER_AGE = 6;                 // beats per max age: several may be missed before the lock expires
const PROC_ID = crypto.randomUUID();

export const lockOptions = (cfg = {}) => {
  const ms = Number(cfg.selfpub_lock_max_ms);
  return { maxAgeMs: Number.isFinite(ms) && ms > 0 ? Math.max(MIN_LOCK_MAX_MS, ms) : DEFAULT_LOCK_MAX_MS };
};

const readOr = (f, fallback) => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return fallback; /* not Linux, or no /proc: that check is skipped */ } };
// Field 22 of /proc/<pid>/stat (start time in ticks since boot); the comm field may hold spaces, so split after ')'.
export const startOf = (pid) => { const s = readOr(`/proc/${pid}/stat`, ''); return s ? s.slice(s.lastIndexOf(')') + 2).split(' ')[19] || null : null; };
export const hostIdentity = () => ({ host: os.hostname(), boot: readOr('/proc/sys/kernel/random/boot_id', null) });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; /* EPERM: alive, another uid */ } };
const localEnv = () => ({ proc: PROC_ID, pid: process.pid, ...hostIdentity(), alive, startOf });

// Why the lock is stale ('' = respected). rec: the parsed file; ageMs: since its last beat.
export function lockVerdict(rec, ageMs, maxAgeMs, env) {
  if (ageMs > maxAgeMs) return 'expired';
  if (rec.proc === env.proc) return '';                // ours: the holder in this process beats it
  if (rec.host !== env.host) return '';                // another machine's process: cannot be checked, only age reclaims it
  if (rec.boot && env.boot && rec.boot !== env.boot) return 'rebooted';
  if (rec.pid === env.pid) return 'pid-reused';        // our pid but not our process: a previous run (the PID-1 case)
  if (!env.alive(rec.pid)) return 'dead';
  const now = rec.start ? env.startOf(rec.pid) : null;
  return now && now !== rec.start ? 'pid-reused' : '';
}

function readLock(f) {
  let text, st;
  try { text = fs.readFileSync(f, 'utf8'); st = fs.statSync(f); } catch { return null; /* no lock file: nothing to reclaim */ }
  let rec;
  try { rec = JSON.parse(text); } catch { rec = null; /* the old pid-only format, or garbage */ }
  return { rec: rec && typeof rec === 'object' && Number.isInteger(rec.pid) ? rec : null, ageMs: Date.now() - st.mtimeMs };
}

// Write-then-link: the lock appears whole or not at all, so a reader never sees it half written.
function createLock(f, rec) {
  const tmp = `${f}.${rec.owner}`;
  fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  try { fs.linkSync(tmp, f); return true; } catch (e) { if (e.code === 'EEXIST') return false; throw e; } finally { fs.rmSync(tmp, { force: true }); }
}

const ownedBy = (f, owner) => { const l = readLock(f); return !!(l && l.rec && l.rec.owner === owner); };

// Returns a release function; a held lock refuses (IN_FLIGHT). The old pid-only file predates this code
// (the node restarted to load it), so it is stale. Known limit: reclaim is check-then-unlink (docs/TODO.md).
export function acquireLock(root, { maxAgeMs = DEFAULT_LOCK_MAX_MS } = {}) {
  const f = path.join(root, '.lock');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const env = localEnv();
  const held = readLock(f);
  if (held && (!held.rec || lockVerdict(held.rec, held.ageMs, maxAgeMs, env))) fs.rmSync(f, { force: true });
  const owner = crypto.randomUUID();
  const rec = { pid: env.pid, proc: env.proc, owner, host: env.host, boot: env.boot, start: startOf(env.pid), at: Date.now() };
  if (!createLock(f, rec)) throw new PublishError('IN_FLIGHT', '已有一个 superelf 改动在进行 · Another superelf change is already in progress');
  const beat = setInterval(() => {
    try { if (ownedBy(f, owner)) { const t = new Date(); fs.utimesSync(f, t, t); } }
    catch { /* a missed beat is safe: the lock only expires after HEARTBEATS_PER_AGE of them */ }
  }, Math.max(1, Math.floor(maxAgeMs / HEARTBEATS_PER_AGE)));
  beat.unref();
  return () => { clearInterval(beat); if (ownedBy(f, owner)) fs.rmSync(f, { force: true }); };
}
