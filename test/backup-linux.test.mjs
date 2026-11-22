// backup.sh / restore.sh on Linux (the demo VM): no Keychain — the passphrase comes from the
// owner-only file config.json "backup_pass_file" names (fixtures: helpers-backup.mjs, linux: true).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { skip, SECRET, MARKER, makeNode, archives, restoredOk } from './helpers-backup.mjs';

test('Linux: a nightly backup reads the passphrase file, never the Keychain, and restores with it', { skip }, () => {
  const n = makeNode({ linux: true, remote: true });
  const r = n.run('backup.sh');
  assert.equal(r.status, 0, r.stderr);
  const [file] = archives(n.dir);
  assert.ok(file, 'uploaded to the remote');
  assert.ok(!fs.readFileSync(path.join(n.dir, file)).includes(MARKER), 'encrypted');
  assert.ok(!fs.existsSync(`${n.base}/security.calls`), 'the Keychain is never asked on Linux');
  const out = path.join(n.base, 'restored');
  const rr = n.run('restore.sh', [`gdrive:superelf-backups/${file}`, out], '', { SUPERELF_BACKUP_PASS_FILE: `${n.base}/pass` });
  assert.equal(rr.status, 0, rr.stderr);
  restoredOk(n, out);
});

test('Linux: a passphrase file others can read, or none at all, refuses and writes nothing', { skip }, () => {
  const n = makeNode({ linux: true });
  fs.chmodSync(`${n.base}/pass`, 0o644);
  const r = n.run('backup.sh');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /readable by others/);
  fs.rmSync(`${n.base}/pass`);
  const r2 = n.run('backup.sh');
  assert.notEqual(r2.status, 0);
  assert.match(r2.stderr, /--setup/);
  assert.deepEqual(fs.readdirSync(n.dir), []);
});

test('Linux: --setup writes an owner-only passphrase file once and keeps an existing one', { skip }, () => {
  const n = makeNode({ linux: true, withPass: false });
  const r = n.run('backup.sh', ['--setup']);
  assert.equal(r.status, 0, r.stderr);
  const st = fs.statSync(`${n.base}/pass`);
  assert.equal(st.mode & 0o077, 0, 'closed to group and other');
  const first = fs.readFileSync(`${n.base}/pass`, 'utf8');
  assert.notEqual(first.trim(), SECRET);
  assert.match(n.run('backup.sh', ['--setup']).stdout, /already exists/);
  assert.equal(fs.readFileSync(`${n.base}/pass`, 'utf8'), first, 'not replaced');
  assert.equal(n.run('backup.sh').status, 0, 'the new passphrase backs up');
});

test('Linux: a blank first line is no passphrase; an unattended restore never falls back to a prompt', { skip }, () => {
  const n = makeNode({ linux: true });
  assert.equal(n.run('backup.sh').status, 0);
  const file = path.join(n.dir, archives(n.dir)[0]);
  fs.writeFileSync(`${n.base}/pass`, '\n', { mode: 0o600 });
  assert.match(n.run('backup.sh').stderr, /first line/);
  fs.writeFileSync(`${n.base}/wrong`, 'not-it\n', { mode: 0o600 });
  const rr = n.run('restore.sh', [file, path.join(n.base, 'r1')], `${SECRET}\n`, { SUPERELF_BACKUP_PASS_FILE: `${n.base}/wrong` });
  assert.notEqual(rr.status, 0, 'a typed passphrase on stdin is not asked for');
  assert.ok(!fs.existsSync(path.join(n.base, 'r1')));
  fs.chmodSync(`${n.base}/wrong`, 0o644);
  assert.match(n.run('restore.sh', [file, path.join(n.base, 'r2')], '', { SUPERELF_BACKUP_PASS_FILE: `${n.base}/wrong` }).stderr, /readable by others/);
});

test('the demo backup container: SUPERELF_NODE_DIR + SUPERELF_BACKUP_EXTRA=off never run a configured pause', { skip }, () => {
  const n = makeNode({ linux: true, extra: (base) => {
    fs.mkdirSync(`${base}/box`);
    return [{ dir: `${base}/box`, pause: [`${base}/bin/boxctl`, 'pause', `${base}/box`], resume: [`${base}/bin/boxctl`, 'resume', `${base}/box`] }];
  } });
  const copy = path.join(n.base, 'image-copy');
  fs.mkdirSync(`${copy}/lib`, { recursive: true });
  for (const s of ['backup.sh', 'lib/backup-extra.sh']) fs.copyFileSync(path.join(n.node, s), path.join(copy, s));
  const r = spawnSync('bash', [`${copy}/backup.sh`], { encoding: 'utf8',
    env: { ...process.env, PATH: `${n.base}/bin:${process.env.PATH}`, SUPERELF_BACKUP_PLATFORM: 'Linux', SUPERELF_NODE_DIR: n.node, SUPERELF_BACKUP_EXTRA: 'off' } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(n.calls(), [], 'no pause or resume ran');
  assert.equal(archives(n.dir).length, 1, 'the node folder was backed up');
});

test('SUPERELF_BACKUP_DIR / _PASS_FILE override what a (web-writable) config.json says', { skip }, () => {
  const n = makeNode({ linux: true });
  const cfgFile = `${n.node}/config.json`;
  const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...c, backup_dir: `${n.base}/attacker`, backup_pass_file: `${n.base}/attacker-pass` }));
  const r = n.run('backup.sh', [], '', { SUPERELF_BACKUP_DIR: n.dir, SUPERELF_BACKUP_PASS_FILE: `${n.base}/pass` });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(archives(n.dir).length, 1, 'written where the environment says');
  assert.ok(!fs.existsSync(`${n.base}/attacker`));
});

test('the root backup refuses a SUPERELF_NODE_DIR that is a link', { skip }, () => {
  const n = makeNode({ linux: true });
  fs.symlinkSync(n.node, `${n.base}/link`);
  const r = n.run('backup.sh', [], '', { SUPERELF_NODE_DIR: `${n.base}/link` });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /not a link/);
});

test('the demo container: no data-disk marker, no backup and no restore, and nothing written', { skip }, () => {
  const n = makeNode({ linux: true });
  const more = { SUPERELF_REQUIRE_MARKER: `${n.base}/no-marker`, TMPDIR: `${n.base}/should-not-exist` };
  assert.match(n.run('backup.sh', [], '', more).stderr, /not mounted/);
  assert.match(n.run('restore.sh', ['x', `${n.base}/r`], '', more).stderr, /not mounted/);
  assert.ok(!fs.existsSync(`${n.base}/should-not-exist`));
  assert.deepEqual(fs.readdirSync(n.dir), []);
});

test('a local backup_dir inside the node folder is refused (it would archive its own archives)', { skip }, () => {
  const n = makeNode({ linux: true });
  fs.mkdirSync(`${n.node}/backups`);
  const r = n.run('backup.sh', [], '', { SUPERELF_BACKUP_DIR: `${n.node}/backups` });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /inside the folder/);
});

test('the demo container: no backup while a restore is running or unfinished', { skip }, () => {
  const n = makeNode({ linux: true });
  fs.writeFileSync(`${n.base}/.restoring`, '');
  const r = n.run('backup.sh', [], '', { SUPERELF_BUSY_MARKER: `${n.base}/.restoring` });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /restore is running/);
  assert.deepEqual(fs.readdirSync(n.dir), []);
});

test('a node folder with no config.json is never archived', { skip }, () => {
  const n = makeNode({ linux: true });
  const empty = `${n.base}/empty-node`; fs.mkdirSync(empty);
  const r = n.run('backup.sh', [], '', { SUPERELF_NODE_DIR: empty, SUPERELF_BACKUP_DIR: n.dir, SUPERELF_BACKUP_PASS_FILE: `${n.base}/pass` });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no config.json/);
  assert.deepEqual(fs.readdirSync(n.dir), []);
});
