import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonFile } from './webutil.mjs';

// --- Password hashing (scrypt; no external deps) ---
export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pw), salt, 32);
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  let dk;
  try { dk = crypto.scryptSync(String(pw), Buffer.from(saltHex, 'hex'), 32); } catch { return false; }
  const a = Buffer.from(hashHex, 'hex');
  return a.length === dk.length && crypto.timingSafeEqual(a, dk);
}

// --- Server-side sessions (file-backed so logins survive restarts) ---
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
// A removed member's own browser is told why it was signed out (and only it: the mark sits on that
// member's sessions, so no one learns whether some other username exists). The shell reads the code.
export const ACCOUNT_REMOVED_CODE = 'account_removed';
export const ACCOUNT_REMOVED_BODY = JSON.stringify({ error: 'account removed · 账号已被移除', code: ACCOUNT_REMOVED_CODE });

export class Sessions {
  constructor(file) { this.file = file; this.map = this._load(); }
  _load() { try { return new Map(Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8')))); } catch { return new Map(); } }
  _save() { writeJsonFile(this.file, Object.fromEntries(this.map)); } // atomic (shared helper, R3)
  create(userId, now) {
    const token = crypto.randomBytes(24).toString('base64url');
    this.map.set(token, { userId, expires: now + SESSION_MS });
    this._save();
    return token;
  }
  resolve(token, now) {
    if (!token) return null;
    const s = this.map.get(token);
    if (!s) return null;
    if (s.expires < now) { this.map.delete(token); this._save(); return null; }
    return s.removed ? null : s.userId;
  }
  // True while `token` is a not-yet-expired session of an account that was removed (removeUser).
  wasRemoved(token, now) {
    const s = token ? this.map.get(token) : null;
    return !!(s && s.removed && s.expires >= now);
  }
  destroy(token) { if (this.map.delete(token)) this._save(); }
  // Keep only the newest `keep` sessions of one user (Map order is creation order).
  trimUser(userId, keep) {
    const mine = [...this.map].filter(([, s]) => s.userId === userId).map(([t]) => t);
    const drop = mine.slice(0, Math.max(0, mine.length - keep));
    for (const t of drop) this.map.delete(t);
    if (drop.length) this._save();
  }
  // A new PIN revokes every other session of that user (e.g. one opened with the API key).
  destroyUserExcept(userId, keep) {
    let changed = false;
    for (const [t, s] of this.map) if (s.userId === userId && t !== keep) { this.map.delete(t); changed = true; }
    if (changed) this._save();
  }
  // Removing an account: its sessions stop working at once but stay, marked, until they expire.
  removeUser(userId) {
    let changed = false;
    for (const s of this.map.values()) if (s.userId === userId && !s.removed) { s.removed = true; changed = true; }
    if (changed) this._save();
  }
  destroyUser(userId) { // revoke all sessions for a removed/blocked account
    let changed = false;
    for (const [t, s] of this.map) if (s.userId === userId) { this.map.delete(t); changed = true; }
    if (changed) this._save();
  }
}

// --- Append-only audit log ---
// The timestamp is stamped HERE so the entry shape has ONE author (R3 — web.mjs
// and the since-removed bot each carried a private `{ at, ev, ...extra }` wrapper
// that could drift apart and fracture the approval audit trail). An entry that already
// carries `at` keeps it (spread order).
export function appendAudit(file, entry) {
  try { fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); } catch { /* logging must never break a request */ }
}
// The ONE audit() both processes use: makeAudit(cfg.auditFile) → (ev, extra).
export const makeAudit = (file) => (ev, extra) => appendAudit(file, { ev, ...extra });
export function readAudit(file, limit = 100) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-limit).reverse().map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
