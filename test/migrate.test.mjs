// Building a migration bundle for a second node · 迁移包
//
// A person's data — config.json (every account and password hash) and every workspace — must
// arrive byte for byte, the source must be left exactly as it was, and a target that already holds
// someone's data must never be overwritten quietly. (Until 2026-10-12 the script also blanked the
// Telegram bot token in the copy; the bot was removed, docs/adr/0006, and config.json is now copied
// as it is.)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { needBash } from './helpers-platform.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'migrate.sh');

// A throwaway node, never the live one: this script copies workspaces, and a test that pointed at
// real family data would be exactly the mistake the standing rule forbids.
function fakeNode() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-mig-'));
  fs.mkdirSync(path.join(d, 'workspace', 'data'), { recursive: true });
  fs.mkdirSync(path.join(d, 'workspace-kid'), { recursive: true });
  fs.mkdirSync(path.join(d, 'workspace.example'), { recursive: true });
  fs.writeFileSync(path.join(d, 'workspace', 'data', 'a.txt'), 'note A');
  fs.writeFileSync(path.join(d, 'workspace-kid', 'b.txt'), 'kid note');
  fs.writeFileSync(path.join(d, 'workspace.example', 't.txt'), 'template');
  fs.writeFileSync(path.join(d, 'config.json'), JSON.stringify({
    default_project: 'assistant', agentmail_key: 'NOT-A-REAL-KEY-fixture-only',
    projects: { assistant: { dir: 'workspace' } },
    users: [{ id: 'owner', role: 'owner', workspace: 'workspace', passHash: 'x' }],
  }, null, 2));
  fs.copyFileSync(SCRIPT, path.join(d, 'migrate.sh'));
  return d;
}
const run = (cwd, args) => execFileSync('bash', [path.join(cwd, 'migrate.sh'), ...args], { cwd, encoding: 'utf8' });

test('config.json comes across byte for byte, and the source is left as it was', { skip: needBash }, () => {
  const src = fakeNode(); const out = path.join(src, 'bundle');
  try {
    const before = fs.readFileSync(path.join(src, 'config.json'));
    run(src, [out]);
    assert.ok(fs.readFileSync(path.join(out, 'config.json')).equals(before), 'the copy is the source, unchanged');
    // READ-ONLY on the source. If this ever fails, the node being moved just lost its accounts.
    assert.ok(fs.readFileSync(path.join(src, 'config.json')).equals(before), 'the source is untouched');
  } finally { rmTemp(src); }
});

test('everything that belongs to a person comes across; the committed template does not', { skip: needBash }, () => {
  const src = fakeNode(); const out = path.join(src, 'bundle');
  try {
    run(src, [out]);
    assert.equal(fs.readFileSync(path.join(out, 'workspace', 'data', 'a.txt'), 'utf8'), 'note A');
    assert.ok(fs.existsSync(path.join(out, 'workspace-kid', 'b.txt')), 'every member workspace');
    // workspace.example is in git; the clone already has it. Copying it would overwrite the
    // template with a stale one.
    assert.ok(!fs.existsSync(path.join(out, 'workspace.example')), 'the committed template is skipped');
    const u = JSON.parse(fs.readFileSync(path.join(out, 'config.json'), 'utf8')).users;
    assert.equal(u.length, 1);
    assert.equal(u[0].passHash, 'x', 'accounts and password hashes survive, or nobody can sign in');
  } finally { rmTemp(src); }
});

test('it refuses to overwrite a target that already holds data', { skip: needBash }, () => {
  // Clobbering a workspace is the one irreversible thing this script could do, so it is the one
  // thing it must not do quietly.
  const src = fakeNode(); const out = path.join(src, 'bundle');
  try {
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'someone-elses.txt'), 'precious');
    assert.throws(() => run(src, [out]), /not empty/);
    assert.equal(fs.readFileSync(path.join(out, 'someone-elses.txt'), 'utf8'), 'precious', 'untouched');
    run(src, [out, '--force']);   // and --force is the deliberate second ask
    assert.ok(fs.existsSync(path.join(out, 'config.json')));
  } finally { rmTemp(src); }
});

test('it will not run anywhere that is not a superelf node', { skip: needBash }, () => {
  const src = fakeNode();
  try {
    fs.rmSync(path.join(src, 'config.json'));
    assert.throws(() => run(src, [path.join(src, 'bundle')]), /no config\.json/);
  } finally { rmTemp(src); }
});
