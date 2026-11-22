#!/usr/bin/env node
// Create this node's owner account, from the terminal · 在终端创建本节点主账号
//
//   node setup.mjs
//
// Until now the first account could only be made in a browser: start the server, find the
// machine's IP, open it, fill in a form. At install time the person is already at a terminal, and
// a headless or remote node may have no browser at all. Same rules as the web form — both call
// lib/owner.mjs, so they cannot drift (R3).
//
// THE PASSWORD IS PROMPTED, NEVER AN ARGUMENT. An argv password lands in shell history, in `ps`
// output for every user on the box, and in any script that wraps this. resetpin.mjs takes one in
// argv because it is a recovery tool run under duress; a first-run installer has no such excuse.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { writeJsonFile } from './lib/webutil.mjs';   // atomic write, ONE definition (R3)
import { needsSetup, validateOwner, applyOwnerSetup, MIN_PASSWORD } from './lib/owner.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CFG = path.join(ROOT, 'config.json');

// Built on readline's `line` events, not rl.question(). question() did not resolve here on either
// a pipe or a real pty (verified both), while line/close events work reliably — so this queues
// answers and hands them to whoever is waiting. It also means a closed stdin resolves to '' rather
// than hanging for ever, and an empty answer simply fails validation and writes nothing.
const isTTY = !!process.stdin.isTTY;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY });
let muted = false;
rl._writeToOutput = (s) => { if (!muted) rl.output.write(s); };

const pending = [];      // answers that arrived before anyone asked
const waiting = [];      // askers waiting for a line
rl.on('line', (l) => { muted = false; const w = waiting.shift(); if (w) w(l); else pending.push(l); });
rl.on('close', () => { muted = false; while (waiting.length) waiting.shift()(null); });

function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  return new Promise((resolve) => {
    const deliver = (line) => { if (hidden) process.stdout.write('\n'); resolve(line == null ? '' : String(line).trim()); };
    if (pending.length) return deliver(pending.shift());
    waiting.push(deliver);
    // Nothing is echoed at all rather than masking with stars: a visible length is still
    // information, and someone is often reading over a shoulder at install time.
    if (hidden && isTTY) muted = true;
  });
}

const fail = (msg) => { console.error(msg); rl.close(); process.exit(1); };

if (!fs.existsSync(CFG)) {
  fail('config.json not found. Copy config.example.json to config.json first, then run this again.\n'
     + '未找到 config.json：请先由 config.example.json 复制生成。');
}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); }
catch (e) { fail(`config.json is not valid JSON: ${e.message}`); }
cfg.users = Array.isArray(cfg.users) ? cfg.users : [];

// Closed once an owner has a password, exactly as the web route is. Otherwise anyone with a shell
// on this machine could take over a running node — and file access is already that authority, but
// it should at least require the deliberate act resetpin.mjs is.
if (!needsSetup(cfg.users)) {
  const who = cfg.users.find((u) => u.role === 'owner');
  fail(`This node already has an owner ("${(who && (who.username || who.id)) || 'owner'}").\n`
     + 'To change its password: node resetpin.mjs <username> <new-password>');
}

const username = (await ask('Owner username (lowercase, no spaces) · 用户名: ')).toLowerCase();
const name = await ask(`Display name · 显示名 [${username}]: `) || username;
const password = await ask(`Password (${MIN_PASSWORD}+ characters) · 密码: `, { hidden: true });
const again = await ask('Confirm password · 再输一次: ', { hidden: true });

if (password !== again) fail('Passwords do not match. Nothing was written. · 两次输入不一致，未做任何修改。');
const v = validateOwner(cfg.users, username, password);
if (!v.ok) fail(`${v.error}\nNothing was written. · 未做任何修改。`);

applyOwnerSetup({ users: cfg.users, root: ROOT, username, name, password });
// config.json stores each workspace RELATIVE to the node root — the shape lib/users.mjs
// writeUsers persists (`workspace: u.rel`). applyOwnerSetup returns a record carrying both,
// because web.mjs needs the absolute path in memory; this is the one place that writes the RAW
// file, so it collapses to the relative form here. An absolute POSIX path is not merely ugly on
// Windows: path.isAbsolute('/Users/alice/…') is true on win32 too, so it resolves against the
// current drive to C:\Users\alice\… — a different, empty directory that lib/users.mjs then
// auto-provisions. Copy a Mac install to Windows and every account comes up blank, with nothing
// reported as wrong.
for (const u of cfg.users) if (u.rel) { u.workspace = u.rel; delete u.rel; }
writeJsonFile(CFG, cfg);
rl.close();

console.log(`\nOwner "${username}" created. · 主账号已创建。`);
console.log('Start the node, then sign in with these credentials:');
console.log('  ./start.sh            (macOS, Linux)');
console.log('  .\\start.ps1           (Windows)');
console.log('Then open http://localhost:8787. For phones: tailscale serve, or set bind_host in config.json (README).');
