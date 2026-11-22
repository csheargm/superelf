// One-time setup code · 一次性初始化码
//
// POST /api/setup used to make the FIRST VISITOR the owner. On a node reachable by others (a shared
// VM on a tailnet) that is a takeover. Loopback-only is not enough: `tailscale serve` proxies every
// tailnet request in from 127.0.0.1. So setup needs a code that only someone with the machine's
// console or files can read: written to <root>/setup-code (mode 0600) and printed to the server
// log at start, while the node still needs setup. It is deleted once the owner is created.
// The CLI (setup.mjs) needs no code: a shell on the machine is already that authority.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SETUP_CODE_FILE = 'setup-code';
const CODE_BYTES = 8;   // 64 bits, shown as 13 base32-ish chars; with login-guard backoff, unguessable

const fileOf = (root) => path.join(root, SETUP_CODE_FILE);

// The current code, minting one if none exists. Reused across restarts so a code read from the
// log stays valid until it is used.
export function ensureSetupCode(root) {
  const f = fileOf(root);
  try {
    const v = fs.readFileSync(f, 'utf8').trim();
    if (v) return v;
  } catch (e) { if (e.code !== 'ENOENT') throw new Error(`cannot read ${f}: ${e.message}`); }
  const code = crypto.randomBytes(CODE_BYTES).toString('base64url').toUpperCase().replace(/[-_]/g, 'X');
  fs.writeFileSync(f, code + '\n', { mode: 0o600 });
  return code;
}

// Constant-time compare against the file. No file (already used, or never minted) → false.
export function setupCodeOk(root, given) {
  let want;
  try { want = fs.readFileSync(fileOf(root), 'utf8').trim(); }
  catch (e) { if (e.code === 'ENOENT') return false; throw new Error(`cannot read setup code: ${e.message}`); }
  const a = Buffer.from(String(given || '').trim().toUpperCase()), b = Buffer.from(want);
  return !!want && a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function consumeSetupCode(root) {
  try { fs.unlinkSync(fileOf(root)); }
  catch (e) { if (e.code !== 'ENOENT') throw new Error(`cannot delete setup code: ${e.message}`); }
}
