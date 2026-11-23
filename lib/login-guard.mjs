// Sign-in attempt limiting · 登录尝试限制
//
// /api/login and /api/setup had no limit at all: a script could try PINs as fast as scrypt answers.
// Failures are counted per (client IP + account) at FAIL_THRESHOLD, and per client IP alone at the
// much higher IP_FAIL_THRESHOLD as a backstop (loginKeys). On a home node the whole family shares one
// IP, so one member's typos must not lock everyone else out; the token path has its own (IP + #token)
// counter for the same reason. A key crossing its threshold locks with an exponential backoff (BASE_LOCK_MS, doubling per further failure, capped at
// MAX_LOCK_MS). A PIN success clears the account key only.
//
// In memory only (owner decision): a restart clears the counters. That is acceptable because a
// restart is not something an attacker can trigger, and the backoff makes online guessing slow.
//
// Parallel-safe by construction: check(), fail() and success() are synchronous, and the callers
// run check → verifyPassword (sync scrypt) → fail/success with no await between, so two requests
// cannot both pass a check that only one of them should have.
export const FAIL_THRESHOLD = 5;
export const IP_FAIL_THRESHOLD = 50;   // per client IP across all names: a backstop, not the main limit
// per account across ALL client IPs: a backstop so guesses spread over many addresses still add up
// (GPT review). Higher than FAIL_THRESHOLD so one member's own typos lock only their IP+account key.
export const ACCOUNT_FAIL_THRESHOLD = 20;
const IP_PREFIX = 'ip:', USER_PREFIX = 'user:';
const thresholdFor = (key) => (key.startsWith(IP_PREFIX) ? IP_FAIL_THRESHOLD : key.startsWith(USER_PREFIX) ? ACCOUNT_FAIL_THRESHOLD : FAIL_THRESHOLD);
export const BASE_LOCK_MS = 30_000;
export const MAX_LOCK_MS = 60 * 60_000;
const MAX_KEYS = 10_000;            // bound on memory: oldest entries are dropped past this

export function createLoginGuard() {
  const map = new Map();   // key → { fails, until }
  const lockFor = (fails, limit) => Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (fails - limit));
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
        const limit = thresholdFor(k);
        if (e.fails >= limit) e.until = now + lockFor(e.fails, limit);
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

// /api/login keys: [IP backstop, IP + account, account backstop]. A token attempt counts under its own '#token' name.
export function loginKeys(req, body) {
  const ip = clientKey(req);
  const who = String((body && body.username) || (body && body.token ? '#token' : '')).toLowerCase().slice(0, 40);
  return [`${IP_PREFIX}${ip}`, `acct:${ip}|${who}`, `${USER_PREFIX}${who}`];
}

export const lockedMessage = (sec) =>
  `Too many failed attempts. Try again in ${sec} s · 尝试次数过多，请 ${sec} 秒后再试`;
