// resetpin.mjs — the last-resort account recovery path ("I lost my password").
//
// It had NO coverage, which is the worst place to have none: if it breaks, the only way
// back into a self-hosted instance breaks with it, and nobody finds out until someone is
// already locked out. Runs the REAL script as a child process against a throwaway config
// — never the live one (writes against real accounts are not a test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyPassword } from '../lib/auth.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'resetpin.mjs');

const CONFIG = {
  web_token: 'fake-token', require_approval: false,
  users: [
    { id: 'alice', name: 'Alice', role: 'owner', status: 'active', token: 'tok-a', passHash: 'scrypt$00$00', workspace: 'workspace' },
    { id: 'bob', username: 'bobby', name: 'Bob', role: 'member', status: 'active', token: 'tok-b', passHash: null, workspace: 'workspace-bob' },
  ],
};
function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resetpin-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(CONFIG, null, 2));
  return dir;
}
const run = (dir, args) => execFileSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
const cfgOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));

test('resets by user id, and the new password verifies', () => {
  const dir = sandbox();
  run(dir, ['alice', 'new-pin-1234']);
  const u = cfgOf(dir).users.find((x) => x.id === 'alice');
  assert.ok(verifyPassword('new-pin-1234', u.passHash), 'the new password must work');
  assert.equal(verifyPassword('wrong', u.passHash), false);
  assert.notEqual(u.passHash, 'scrypt$00$00', 'the old hash must be replaced');
});

test('resets by the separate username field, not only the id', () => {
  const dir = sandbox();
  run(dir, ['bobby', 'bob-pin-9999']);
  assert.ok(verifyPassword('bob-pin-9999', cfgOf(dir).users.find((x) => x.id === 'bob').passHash));
});

test('the handle is case-insensitive, like the login route', () => {
  const dir = sandbox();
  run(dir, ['ALICE', 'caps-pin-1234']);
  assert.ok(verifyPassword('caps-pin-1234', cfgOf(dir).users.find((x) => x.id === 'alice').passHash));
});

test('it touches ONLY the named account and keeps the rest of config.json', () => {
  const dir = sandbox();
  run(dir, ['alice', 'new-pin-1234']);
  const c = cfgOf(dir);
  assert.equal(c.users.find((x) => x.id === 'bob').passHash, null, "another user's PIN must not change");
  assert.equal(c.web_token, 'fake-token', 'unrelated config keys must survive');
  assert.equal(c.require_approval, false);
  assert.equal(c.users.length, 2, 'no user added or dropped');
  for (const u of c.users) assert.ok(u.token && u.workspace, 'tokens and workspaces survive');
});

test('an unknown handle is refused — and lists the handles that exist', () => {
  const dir = sandbox();
  assert.throws(() => run(dir, ['nosuchuser', 'whatever-1234']), (e) => {
    assert.match(String(e.stderr), /no user with username "nosuchuser"/);
    assert.match(String(e.stderr), /alice/, 'it must name the real handles, or recovery is guesswork');
    return true;
  });
  assert.equal(cfgOf(dir).users.find((x) => x.id === 'alice').passHash, 'scrypt$00$00', 'config untouched on refusal');
});

test('a too-short PIN is refused before anything is written', () => {
  const dir = sandbox();
  assert.throws(() => run(dir, ['alice', 'ab']), (e) => /usage:/.test(String(e.stderr)));
  assert.throws(() => run(dir, ['alice']), (e) => /usage:/.test(String(e.stderr)));
  assert.equal(cfgOf(dir).users.find((x) => x.id === 'alice').passHash, 'scrypt$00$00');
});

test('it leaves no stray temp file beside config.json', () => {
  const dir = sandbox();
  run(dir, ['alice', 'new-pin-1234']);
  assert.deepEqual(fs.readdirSync(dir), ['config.json'], 'a leftover .tmp is a half-written config waiting to confuse someone');
});

test('it tells the operator to restart, and warns that a running server can clobber the reset', () => {
  // writeUsers() rewrites config.json from the server's IN-MEMORY users, so a reset applied
  // while it runs is silently undone by the next user write.
  const out = run(sandbox(), ['alice', 'new-pin-1234']);
  assert.match(out, /Password reset for "alice"/);
  assert.match(out, /stop\.sh && \.\/start\.sh/, 'the operator must be told how to make it take effect');
  const src = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(src, /writeJsonFile/, 'the atomic shared writer, not a private copy (R3)');
});
