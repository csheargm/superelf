// Creating the node's owner · 创建主账号
//
// The first account could only be made in a browser: start the server, find the machine's IP, open
// it, fill in a form. At install time the person is already at a terminal, and a headless node may
// have no browser. setup.mjs does it there — and shares its rules with POST /api/setup through
// lib/owner.mjs, so the two cannot drift into disagreeing about what a valid owner is.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { needsSetup, validateOwner, applyOwnerSetup, isActive, RESERVED_IDS, MIN_PASSWORD } from '../lib/owner.mjs';
import { verifyPassword } from '../lib/auth.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
const CLI = fs.readFileSync(path.join(ROOT, 'setup.mjs'), 'utf8');
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-owner-'));

test('setup is open until an owner has a PASSWORD, not merely until one exists', () => {
  // config.example.json ships an owner record. If "an owner exists" closed setup, a fresh install
  // could never create credentials at all.
  assert.equal(needsSetup([{ id: 'owner', role: 'owner', status: 'active' }]), true, 'no passHash yet');
  assert.equal(needsSetup([{ id: 'owner', role: 'owner', status: 'active', passHash: 'x' }]), false);
  assert.equal(needsSetup([]), true);
});

test('the rules reject what the web form rejects', () => {
  const users = [{ id: 'kid', username: 'kid', role: 'member' }];
  assert.equal(validateOwner(users, 'Alice', 'secret123').ok, false, 'uppercase');
  assert.equal(validateOwner(users, 'has space', 'secret123').ok, false, 'spaces');
  assert.equal(validateOwner(users, 'kid', 'secret123').ok, false, 'taken by a member');
  assert.equal(validateOwner(users, 'alice', 'short').ok, false, `under ${MIN_PASSWORD} chars`);
  for (const r of RESERVED_IDS) assert.equal(validateOwner(users, r, 'secret123').ok, false, `reserved: ${r}`);
  assert.equal(validateOwner(users, 'alice', 'secret123').ok, true, 'CONTROL: a good one passes');
});

test('an existing credential-less owner is REUSED, so its workspace survives', () => {
  // A node that has been running without a password must not end up with a second owner and an
  // abandoned workspace full of notes.
  const d = mk();
  try {
    const ws = path.join(d, 'workspace'); fs.mkdirSync(ws, { recursive: true });
    const users = [{ id: 'owner', role: 'owner', token: 'keepme', rel: 'workspace', workspace: ws, status: 'active' }];
    const owner = applyOwnerSetup({ users, root: d, username: 'alice', name: 'Alice', password: 'secret123' });
    assert.equal(users.length, 1, 'no second owner was added');
    assert.equal(owner.token, 'keepme', 'the existing token is kept');
    assert.equal(owner.workspace, ws, 'and so is the workspace');
    assert.equal(owner.username, 'alice');
    assert.ok(verifyPassword('secret123', owner.passHash), 'the password verifies');
    assert.ok(!/secret123/.test(JSON.stringify(owner)), 'and is stored hashed, never in the clear');
  } finally { rmTemp(d); }
});

test('the CLI never takes a password as an argument', () => {
  // An argv password lands in shell history and in `ps` output for every user on the box.
  assert.ok(!/process\.argv/.test(CLI), 'setup.mjs reads no argv at all');
  assert.match(CLI, /hidden: true/, 'it prompts, hidden');
  assert.match(CLI, /Confirm password/, 'and asks twice, because it echoes nothing');
});

test('the CLI refuses on an already-owned node, and writes nothing on any refusal', () => {
  assert.match(CLI, /if \(!needsSetup\(cfg\.users\)\)/, 'same gate as the route');
  assert.match(CLI, /node resetpin\.mjs/, 'and points at the recovery tool instead');
  // Every failure path must exit before writeJsonFile — a half-written config.json would lock the
  // owner out of their own node.
  const writeAt = CLI.indexOf('writeJsonFile(CFG, cfg)');
  for (const guard of ['Passwords do not match', 'if (!v.ok) fail']) {
    assert.ok(CLI.indexOf(guard) < writeAt, `"${guard}" is checked before anything is written`);
  }
});

test('route and CLI share ONE definition of a valid owner', () => {
  for (const [name, src] of [['web.mjs', WEB], ['setup.mjs', CLI]]) {
    assert.match(src, /from '\.\/lib\/owner\.mjs'|from '\.\.\/lib\/owner\.mjs'/, `${name} imports the shared rules`);
    assert.match(src, /validateOwner\(/, `${name} validates through them`);
  }
  // R1: the copies that used to live in web.mjs are gone, not merely shadowed.
  assert.ok(!/^const RESERVED_IDS = new Set/m.test(WEB), 'web.mjs no longer defines RESERVED_IDS');
  assert.ok(!/^function needsSetup\(\)/m.test(WEB), 'nor needsSetup');
  assert.ok(!/^const idOkSlug =/m.test(WEB), 'nor idOkSlug');
});

test('a raw config.json record with NO status still closes setup', () => {
  // The two callers see different shapes. web.mjs passes RESOLVED users, which always carry a
  // status; setup.mjs reads config.json raw, where the field is usually absent — on this node
  // every one of the five users omits it. Checking `status === 'active'` therefore reported "no
  // owner" for a fully configured node, and running the CLI there reached applyOwnerSetup, which
  // reuses the existing owner and would have overwritten their password without asking.
  const rawOwner = { id: 'owner', role: 'owner', passHash: 'x' };   // exactly what is on disk
  assert.equal(needsSetup([rawOwner]), false, 'an owner with a password closes setup, status or not');
  assert.equal(isActive(rawOwner), true, 'missing status means active, as resolveUsers decides');
  assert.equal(isActive({ status: 'pending' }), false, 'only an explicit pending is inactive');
  // CONTROL: it must still be OPEN when the owner genuinely has no password, or a fresh install
  // could never be set up at all.
  assert.equal(needsSetup([{ id: 'owner', role: 'owner' }]), true);
});

test('the active rule matches lib/users.mjs, which is what the server actually applies', () => {
  const users = fs.readFileSync(path.join(ROOT, 'lib', 'users.mjs'), 'utf8');
  assert.match(users, /status: u\.status === 'pending' \? 'pending' : 'active'/,
    'resolveUsers still defaults anything not pending to active — if this changes, isActive must too');
});

test('a relative workspace resolves against the NODE, not the shell you happen to be standing in', () => {
  // setup.mjs reads config.json RAW, where `workspace` is relative ("workspace"); web.mjs passes
  // RESOLVED users, where it is absolute. A relative path resolves against process.cwd(), and
  // saveProfile mkdir -p's — so `node /path/to/node/setup.mjs` run from home wrote the owner's
  // profile into a NEW ~/workspace and left the real one empty. Measured before the fix.
  const root = mk(), elsewhere = mk(), cwd = process.cwd();
  try {
    process.chdir(elsewhere);
    const users = [{ id: 'owner', role: 'owner', workspace: 'workspace' }];   // raw shape, relative
    applyOwnerSetup({ users, root, username: 'alice', name: 'Alice', password: 'secret123' });
    assert.ok(fs.existsSync(path.join(root, 'workspace', 'profile.json')), 'profile lands in the node');
    assert.ok(!fs.existsSync(path.join(elsewhere, 'workspace')), 'no stray workspace beside the cwd');
  } finally { process.chdir(cwd); rmTemp(root);
    rmTemp(elsewhere); }
});

test('an absolute workspace is left alone (the shape web.mjs passes)', () => {
  const root = mk(), ws = path.join(mk(), 'somewhere-else');
  try {
    const users = [{ id: 'owner', role: 'owner', workspace: ws, rel: 'workspace' }];
    applyOwnerSetup({ users, root, username: 'alice', name: 'Alice', password: 'secret123' });
    assert.ok(fs.existsSync(path.join(ws, 'profile.json')), 'honoured verbatim');
    assert.ok(!fs.existsSync(path.join(root, 'workspace')), 'not re-resolved against root');
  } finally { rmTemp(root); rmTemp(path.dirname(ws)); }
});

test('an owner record with no token gets one, and it is unique', () => {
  // Every user is addressed by a unique token (web.mjs signs in with one). An owner record that
  // predates passwords, or a hand-written config, arrives here without one.
  const root = mk();
  try {
    const a = [{ id: 'owner', role: 'owner', workspace: 'workspace' }];
    const b = [{ id: 'owner', role: 'owner', workspace: 'workspace' }];
    const o1 = applyOwnerSetup({ users: a, root, username: 'alice', name: 'C', password: 'secret123' });
    const o2 = applyOwnerSetup({ users: b, root, username: 'alice', name: 'C', password: 'secret123' });
    assert.ok(o1.token && o1.token.length >= 20, 'minted');
    assert.notEqual(o1.token, o2.token, 'not a fixed string');
    const keep = [{ id: 'owner', role: 'owner', workspace: 'workspace', token: 'already-mine' }];
    assert.equal(applyOwnerSetup({ users: keep, root, username: 'alice', name: 'C', password: 'secret123' }).token,
      'already-mine', 'an existing token is never rotated out from under a signed-in client');
  } finally { rmTemp(root); }
});

test('the password is stored only as a hash', () => {
  const root = mk();
  try {
    const users = [{ id: 'owner', role: 'owner', workspace: 'workspace' }];
    const o = applyOwnerSetup({ users, root, username: 'alice', name: 'C', password: 'secret123' });
    assert.ok(!JSON.stringify(users).includes('secret123'), 'no plaintext anywhere in the record');
    assert.equal(verifyPassword('secret123', o.passHash), true);
    assert.equal(verifyPassword('secret124', o.passHash), false, 'CONTROL: a wrong one fails');
  } finally { rmTemp(root); }
});

test('a fresh node ends up with exactly ONE owner', () => {
  // The old route built the owner object but never pushed it into cfg.users — upsertUser did that.
  // The shared helper pushes, so the route now pushes AND upserts; upsertUser matches on id and
  // merges (web.mjs:400), so this stays one record. Worth pinning: two owners means two workspaces.
  const root = mk();
  try {
    const users = [];
    const o = applyOwnerSetup({ users, root, username: 'alice', name: 'Alice', password: 'secret123' });
    assert.equal(users.length, 1, 'one record');
    assert.equal(users.filter((u) => u.role === 'owner').length, 1, 'one owner');
    assert.equal(users[0], o, 'and it is the one returned, so the caller upserts the same object');
    assert.equal(needsSetup(users), false, 'setup is now closed');
  } finally { rmTemp(root); }
});

test('config.json stores a RELATIVE workspace, so the install can be copied to another OS', () => {
  // An absolute POSIX path is absolute on Windows too: path.isAbsolute('/Users/alice/ws') is true
  // on win32, where it resolves against the current drive to C:\Users\alice\ws — a different,
  // empty folder that lib/users.mjs auto-provisions. Copying a Mac node to the Windows box (the
  // whole point of a second always-on node) would silently bring up empty accounts.
  const root = mk();
  try {
    fs.writeFileSync(path.join(root, 'config.json'),
      JSON.stringify({ default_project: 'assistant', projects: { assistant: { dir: 'workspace' } }, users: [] }));
    fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
    fs.cpSync(path.join(ROOT, 'lib'), path.join(root, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'setup.mjs'), path.join(root, 'setup.mjs'));
    execFileSync(process.execPath, [path.join(root, 'setup.mjs')], {
      cwd: root, input: 'alice\nAlice\nsecret123\nsecret123\n', encoding: 'utf8',
    });
    const u = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).users[0];
    assert.equal(u.workspace, 'workspace', 'relative, not this machine\u2019s absolute path');
    assert.ok(!path.isAbsolute(u.workspace), 'must not be absolute on any platform');
    assert.equal(u.rel, undefined, 'the in-memory-only field is not persisted');
    assert.ok(fs.existsSync(path.join(root, 'workspace', 'profile.json')), 'and the profile still landed');
  } finally { rmTemp(root); }
});
