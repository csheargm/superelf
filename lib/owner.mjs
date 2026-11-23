// Creating the node's owner · 创建节点主账号
//
// This used to exist ONLY inside POST /api/setup, which meant the first account could only be made
// in a browser: install, start the server, find the machine's IP, open it, then fill in a form.
// A bootstrap that asks for a username and password at the command line is the natural place for
// it — the person is already at a terminal, and on a headless or remote node there may be no
// browser to hand.
//
// The rules live HERE so the route and the CLI cannot drift into disagreeing about what a valid
// owner is (R3). Two callers, one definition: web.mjs POST /api/setup, and setup.mjs.
import crypto from 'node:crypto';
import path from 'node:path';
import { hashPassword } from './auth.mjs';
import { loadProfileForUpdate, saveProfile } from './users.mjs';

// Names the router already means something by: /app/shared/..., /api/..., /admin/...
export const RESERVED_IDS = new Set(['shared', 'api', 'app', 'admin']);
export const idOkSlug = (s) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(s || '');
// ONE minimum for every place a PIN/password is newly set: setup (web + CLI), register, the
// profile change, the owner's add-member form and resetpin.mjs. Login does NOT check it, so a
// shorter PIN set before this rule keeps working until its holder changes it.
export const MIN_PASSWORD = 8;
export const passwordError = (pw) => (String(pw || '').length < MIN_PASSWORD
  ? `密码至少 ${MIN_PASSWORD} 位 · Password must be at least ${MIN_PASSWORD} characters` : null);

// A user is active unless explicitly 'pending'. This MUST match lib/users.mjs resolveUsers:149
// (`status: u.status === 'pending' ? 'pending' : 'active'`), because the two callers see different
// shapes — web.mjs passes RESOLVED users that always carry a status, while setup.mjs reads
// config.json RAW, where the field is usually absent. Testing `status === 'active'` therefore said
// "no owner" for every record on disk: running the CLI on an owned node reached applyOwnerSetup,
// which reuses the existing owner and would have overwritten their password without asking.
export const isActive = (u) => !!u && u.status !== 'pending';

// The ONE owner a node-wide job runs for (web.mjs JOBS ownerOnly): the first active owner. A node
// may have several, and each running it would mean duplicate probes and a briefing that reaches
// whichever owner the scheduler ticked first.
export const nodeOwnerId = (users) => ((users || []).find((u) => u.role === 'owner' && isActive(u)) || {}).id || null;

// Setup is open until an owner has a PASSWORD — not merely until an owner record exists, because
// config.example.json ships one. Once it closes it stays closed: the route refuses, and so does
// the CLI, or either would be a way to take over a running node.
export const needsSetup = (users) =>
  !(users || []).some((u) => u.role === 'owner' && isActive(u) && u.passHash);

// Pure check, no mutation, so a caller can report every problem before touching config.json.
export function validateOwner(users, username, password) {
  if (!idOkSlug(username) || RESERVED_IDS.has(username)) {
    return { ok: false, error: 'username: lowercase letters/numbers, no spaces · 用户名：小写字母或数字' };
  }
  const pwErr = passwordError(password);
  if (pwErr) return { ok: false, error: pwErr };
  if ((users || []).some((u) => (u.username || u.id) === username && u.role !== 'owner')) {
    return { ok: false, error: 'username taken · 用户名已被占用' };
  }
  return { ok: true };
}

// Mutates `users` in place and returns the owner. Reuses an existing credential-less owner rather
// than adding a second one, so a node that has been running without a password keeps its
// workspace and everything in it. The caller persists (writeUsers) and, on the server, creates a
// session — neither belongs here.
export function applyOwnerSetup({ users, root, username, name, password, provision }) {
  let owner = users.find((u) => u.role === 'owner') || users[0];
  if (!owner) {
    owner = { id: 'owner', role: 'owner', token: crypto.randomBytes(24).toString('base64url'),
      rel: 'workspace', workspace: path.join(root, 'workspace'), status: 'active' };
    users.push(owner);
    if (provision) provision(owner);
  }
  owner.username = username;
  owner.name = String(name || username).slice(0, 60);
  owner.role = 'owner';
  owner.status = 'active';
  owner.passHash = hashPassword(password);
  // Every user is addressed by a unique token (web.mjs:461 signs in with one). loadUsers mints one
  // on next start, but a config on disk should never be missing it in the meantime — an owner
  // record that predates passwords, or a hand-written one, arrives here without a token.
  if (!owner.token) owner.token = crypto.randomBytes(24).toString('base64url');
  // The two callers hand us different shapes: web.mjs passes RESOLVED users, whose `workspace` is
  // absolute, while setup.mjs reads config.json raw, where it is relative to the node's root. A
  // relative path resolves against process.cwd(), and saveProfile mkdir -p's — so running the
  // installer from anywhere but the node directory wrote the owner's profile into a brand-new
  // `workspace/` beside wherever the person happened to be standing, and the real one stayed empty.
  const rel = owner.workspace || owner.rel || 'workspace';
  const ws = path.isAbsolute(rel) ? rel : path.join(root, rel);
  // Read-before-write: a damaged profile must not be replaced by a blank default.
  const prof = loadProfileForUpdate(ws);
  prof.name = owner.name; prof.role = 'owner';
  saveProfile(ws, prof);
  return owner;
}
