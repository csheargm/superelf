import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonFile } from './webutil.mjs';
import { readJson, readJsonForUpdate } from './readjson.mjs';

const idOk = (s) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(s || '');

function profilePath(workspace) { return path.join(workspace, 'profile.json'); }
// READ-ONLY profile load — null means "nothing usable to show", which is
// correct for the display callers (publicUser, the GET, prompt resolution).
export function loadProfile(workspace) { return readJson(profilePath(workspace), null); }
// READ-BEFORE-WRITE profile load. EMPTY-OVERWRITE CLASS (2026-09-02 round 2):
// every writer did `loadProfile(ws) || {}` and then saved the merged object, so
// an unreadable profile.json became {} and the save wiped about / prefs /
// systemPrompts / mail lists while answering ok:true. Throws instead
// (file_unreadable → 500) — an absent profile still returns `fallback`,
// because a first save is normal.
const isProfile = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
// The name people see for an account (F5-9): the name they chose (profile, else the account record),
// else their username — never the internal id ("owner"), which is a slug no one picked.
export const NO_NAME = '家人 · Family member';
export function displayName(u) {
  if (!u) return NO_NAME;
  const prof = loadProfile(u.workspace) || {};
  const pick = [prof.name, u.name, u.username].map((v) => String(v || '').trim()).find((v) => v && !(v === u.id && u.username && u.username !== u.id));
  return pick || NO_NAME;
}

export function loadProfileForUpdate(workspace, fallback = {}) {
  return readJsonForUpdate(profilePath(workspace), fallback, { expect: isProfile });
}
// Atomic (R3, lib/webutil.mjs): a profile is user-typed content, and the bare
// writeFileSync this replaces truncated it BEFORE writing — a crash there left
// exactly the unreadable file the guard above now refuses to overwrite.
export function saveProfile(workspace, prof) { fs.mkdirSync(workspace, { recursive: true }); writeJsonFile(profilePath(workspace), prof); }
export function ageFromYear(birthYear, thisYear) { return birthYear ? Math.max(0, thisYear - birthYear) : null; }

// Email shape check（邮箱格式）— ONE definition (R3): the profile PUT whitelist
// (web.mjs briefingEmail) validates writes with it, and lib/notify.mjs re-checks
// at the delivery boundary so a hand-edited profile.json can't inject junk
// (the effectiveHealthThresholds re-sanitize precedent below).
export const emailOk = (s) => typeof s === 'string' && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

// Per-user health-threshold overrides (docs/design/ios-health-ingestion.md §3).
// `defaults` (cfg.health_thresholds) defines the ONLY accepted keys; values must
// be finite non-negative numbers. Returns the sanitized override object, or
// null when the input is not a plain object (caller then leaves the profile as is).
export function sanitizeHealthThresholds(input, defaults) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const [k, v] of Object.entries(input))
    if (k in (defaults || {}) && typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  return out;
}

// Effective thresholds = config defaults overlaid with the profile's overrides
// (re-sanitized on read, so a hand-edited profile.json can't inject junk).
export function effectiveHealthThresholds(profile, defaults) {
  const over = sanitizeHealthThresholds(profile && profile.healthThresholds, defaults) || {};
  return { ...defaults, ...over };
}

// Seed a profile.json on first provision so the agent has name/age/role from day one.
function seedProfile(rec) {
  let existing;
  // Seed ONLY when the file is genuinely absent. loadProfile() returns null for
  // "absent" AND for "damaged", and seeding on the second one would replace a
  // recoverable profile with a blank default — the empty-overwrite class this
  // round is about. R5: leaving a damaged file untouched IS the correct silent
  // outcome here; it stays on disk for repair, and every write path answers
  // 500 file_unreadable until it is fixed.
  try { existing = loadProfileForUpdate(rec.workspace, null); } catch { return; }
  if (existing) return;
  saveProfile(rec.workspace, { name: rec.name, role: rec.role, birthYear: rec.birthYear, about: '', prefs: '' });
}

// Normalizes cfg.users into a list of isolated accounts, each with its own
// workspace dir. Backward-compatible: an old single-token config becomes one
// owner user. Generates missing tokens and provisions missing workspaces from
// workspace.example. Returns { users, byToken, byId, changed }.
// A users[].telegram_id left from the removed Telegram bot (docs/adr/0006) is not carried into
// the record, so writeUsers drops it from config.json on the next save.
// provision:false (lib/config.mjs loadConfig readOnly): no workspace created, no profile seeded —
// the accounts are resolved in memory only, and writing `changed` back is the caller's call.
export function resolveUsers(cfg, root, { provision = true } = {}) {
  let changed = false;
  let raw = Array.isArray(cfg.users) ? cfg.users : null;

  if (!raw) {
    // Legacy: synthesize a single owner from web_token + default project dir.
    raw = [{ id: 'owner', name: 'owner', role: 'owner', token: cfg.web_token, workspace: cfg.projects?.[cfg.default_project]?.rel || 'workspace' }];
    changed = true;
  }

  const example = path.join(root, 'workspace.example');
  const users = raw.map((u, i) => {
    const id = idOk(u.id) ? u.id : `user${i + 1}`;
    if (id !== u.id) changed = true;
    let token = u.token;
    if (!token || /GENERATE|PASTE/.test(token)) { token = crypto.randomBytes(24).toString('base64url'); changed = true; }
    const rel = u.workspace || (id === 'owner' ? 'workspace' : `workspace-${id}`);
    const workspace = path.isAbsolute(rel) ? rel : path.join(root, rel);
    // Auto-provision an isolated workspace from the template on first run.
    if (provision && !fs.existsSync(workspace)) {
      if (fs.existsSync(example)) { fs.cpSync(example, workspace, { recursive: true }); console.log(`[users] provisioned workspace for "${id}" at ${workspace}`); }
      else fs.mkdirSync(path.join(workspace, 'memory'), { recursive: true });
    }
    const role = u.role === 'owner' ? 'owner' : 'member';
    const rec = { id, username: (u.username || id), name: u.name || id, token, workspace, rel, role, birthYear: u.birthYear || null, passHash: u.passHash || null, status: u.status === 'pending' ? 'pending' : 'active', agent: u.agent === true };
    if (provision && rec.status === 'active') seedProfile(rec);
    return rec;
  });

  const seenTok = new Set(), seenId = new Set(), seenWs = new Set();
  for (const u of users) {
    if (seenTok.has(u.token)) throw new Error(`duplicate token for "${u.id}" — each user needs a unique token`);
    if (seenId.has(u.id)) throw new Error(`duplicate user id "${u.id}"`);
    if (seenWs.has(u.workspace)) throw new Error(`two users share workspace "${u.rel}" — each user needs their own`);
    seenTok.add(u.token); seenId.add(u.id); seenWs.add(u.workspace);
  }

  // Guarantee an owner exists (legacy configs / hand-edits may omit the role).
  if (users.length && !users.some((x) => x.role === 'owner')) { users[0].role = 'owner'; changed = true; }
  const byToken = new Map(users.map((u) => [u.token, u]));
  const byId = new Map(users.map((u) => [u.id, u]));
  return { users, byToken, byId, changed };
}

// Persist generated tokens / normalized users back into config.json.
export function writeUsers(root, users) {
  const p = path.join(root, 'config.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  raw.users = users.map((u) => ({ id: u.id, username: u.username && u.username !== u.id ? u.username : undefined, name: u.name, role: u.role, birthYear: u.birthYear || undefined, token: u.token, workspace: u.rel, passHash: u.passHash || undefined, status: u.status && u.status !== 'active' ? u.status : undefined, agent: u.agent === true ? true : undefined }));
  writeJsonFile(p, raw); // atomic (shared helper, R3): never leave config.json half-written
}
