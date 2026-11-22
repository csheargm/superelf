#!/usr/bin/env node
// Recover a lost password locally: node resetpin.mjs <username> <new-password>
// Requires access to this machine's files — that IS the authority (like Linux single-user mode).
import fs from 'node:fs';
import { hashPassword } from './lib/auth.mjs';
import { writeJsonFile } from './lib/webutil.mjs';  // atomic write, ONE definition (R3)
import { MIN_PASSWORD, passwordError } from './lib/owner.mjs';   // the ONE minimum (R3)
const [,, handle, pw] = process.argv;
if (!handle || !pw) { console.error(`usage: node resetpin.mjs <username> <new-password (${MIN_PASSWORD}+)>`); process.exit(1); }
if (passwordError(pw)) { console.error(`usage: node resetpin.mjs <username> <new-password (${MIN_PASSWORD}+)> — ${passwordError(pw)}`); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const u = (cfg.users || []).find((x) => (x.username || x.id) === handle.toLowerCase());
if (!u) { console.error(`no user with username "${handle}". Known: ${(cfg.users||[]).map(x=>x.username||x.id).join(', ')}`); process.exit(1); }
u.passHash = hashPassword(pw);
writeJsonFile('config.json', cfg);
// STOP FIRST, not just "restart after": a running server holds cfg.users in memory and
// writeUsers() (lib/users.mjs) rewrites config.json from THAT copy — so any user write
// while it runs (a PIN change, a registration) silently overwrites the reset you just made.
console.log(`Password reset for "${handle}".`);
console.log('If the server is running, restart it now so it reloads: ./stop.sh && ./start.sh');
