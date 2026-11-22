// Sign-in attempt limiting · 登录尝试限制
//
// /api/login and /api/setup had no limit at all: a script could try PINs as fast as scrypt answers.
// Failures are counted per client IP AND per account; either one crossing FAIL_THRESHOLD locks that
// key with an exponential backoff (BASE_LOCK_MS, doubling per further failure, capped at
// MAX_LOCK_MS). A PIN success clears the account key only.
//
// In memory only (owner decision): a restart clears the counters. That is acceptable because a
// restart is not something an attacker can trigger, and the backoff makes online guessing slow.
//
// Parallel-safe by construction: check(), fail() and success() are synchronous, and the callers
// run check → verifyPassword (sync scrypt) → fail/success with no await between, so two requests
// cannot both pass a check that only one of them should have.
export const FAIL_THRESHOLD = 5;
export const BASE_LOCK_MS = 30_000;
export const MAX_LOCK_MS = 60 * 60_000;
const MAX_KEYS = 10_000;            // bound on memory: oldest entries are dropped past this

export function createLoginGuard() {
  const map = new Map();   // key → { fails, until }
  const lockFor = (fails) => Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (fails - FAIL_THRESHOLD));
  return {
    // → 0 when every key may try now, else the seconds until the latest lock ends.
    retryAfter(keys, now = Date.now()) {
      let until = 0;
      for (const k of keys) { const e = map.get(k); if (e && e.until > until) until = e.until; }
      return until > now ? Math.ceil((until - now) / 1000) : 0;
    },
    fail(keys, now = Date.now()) {
      for (const k of keys) {
        const e = map.get(k) || { fails: 0, until: 0 };
        e.fails += 1;
        if (e.fails >= FAIL_THRESHOLD) e.until = now + lockFor(e.fails);
        map.delete(k); map.set(k, e);   // re-insert: Map order = recency, for the bound below
      }
      // Over the bound, drop the oldest UNLOCKED entries: junk names must not evict a live lock.
      if (map.size > MAX_KEYS) for (const [k, e] of map) { if (map.size <= MAX_KEYS) break; if (e.until <= now) map.delete(k); }
    },
    success(keys) { for (const k of keys) map.delete(k); },
  };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export const isLoopback = (addr) => LOOPBACK.has(String(addr || ''));

// The client a failure is counted against. X-Forwarded-For is believed ONLY when the socket is
// loopback, i.e. a local reverse proxy (`tailscale serve`) sent it; without that every tailnet
// visitor would share one bucket and one person could lock everyone out. A remote socket never
// gets to pick its own bucket. (The proxy appends the real peer last, so the last hop is used.)
export function clientKey(req) {
  const remote = String((req.socket && req.socket.remoteAddress) || 'unknown');
  if (!isLoopback(remote)) return remote;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : remote;
}

export const lockedMessage = (sec) =>
  `Too many failed attempts. Try again in ${sec} s · 尝试次数过多，请 ${sec} 秒后再试`;
