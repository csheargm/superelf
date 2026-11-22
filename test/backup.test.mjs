// backup.sh / restore.sh: encryption, retention, Google Drive, passphrases, overlapping runs
// (fixtures and fakes: helpers-backup.mjs; extra folders: backup-extra.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, SECRET, MARKER, makeNode, archives, restoredOk } from './helpers-backup.mjs';

test('a backup is encrypted, names this Mac, and restoring it gives back every kept file byte for byte', { skip }, () => {
  const n = makeNode();
  const r = n.run('backup.sh');
  assert.equal(r.status, 0, r.stderr);
  const [file] = archives(n.dir);
  assert.ok(file, 'one archive written');
  assert.ok(!fs.readFileSync(path.join(n.dir, file)).includes(MARKER), 'journal text is not readable in the archive');
  assert.deepEqual(fs.readdirSync(n.dir).filter((f) => f.startsWith('.')), [], 'no part file left');
  const out = path.join(n.base, 'restored');
  const rr = n.run('restore.sh', [path.join(n.dir, file), out]);
  assert.equal(rr.status, 0, rr.stderr);
  restoredOk(n, out);
  assert.ok(!fs.readFileSync(`${n.base}/security.calls`, 'utf8').includes(SECRET), 'the passphrase is never passed as an argument');
});

test('only the newest backup_keep archives of THIS Mac are kept; other files are never touched', { skip }, () => {
  const n = makeNode({ keep: 2 });
  assert.equal(n.run('backup.sh').status, 0);
  const prefix = archives(n.dir)[0].replace(/\d{4}-\d{2}-\d{2}\.tar\.gz\.gpg$/, '');
  for (const d of ['2020-01-01', '2020-01-02', '2020-01-03']) fs.writeFileSync(path.join(n.dir, `${prefix}${d}.tar.gz.gpg`), 'old');
  fs.writeFileSync(path.join(n.dir, 'superelf-OtherMac-2020-01-01.tar.gz.gpg'), 'another machine');
  fs.writeFileSync(path.join(n.dir, 'my-photos.zip'), 'mine');
  assert.equal(n.run('backup.sh').status, 0);
  const mine = archives(n.dir).filter((f) => f.startsWith(prefix));
  assert.deepEqual(mine.length, 2);
  assert.ok(mine.includes(`${prefix}2020-01-03.tar.gz.gpg`), 'the newest old one survives with today');
  assert.ok(fs.existsSync(path.join(n.dir, 'superelf-OtherMac-2020-01-01.tar.gz.gpg')), "another Mac's backup is left alone");
  assert.ok(fs.existsSync(path.join(n.dir, 'my-photos.zip')));
});

test('straight to Google Drive through rclone: upload, keep the newest, restore from the remote', { skip }, () => {
  const n = makeNode({ keep: 1, remote: true });
  assert.equal(n.run('backup.sh').status, 0);
  const [file] = archives(n.dir);
  assert.ok(file, 'uploaded to the remote');
  const prefix = file.replace(/\d{4}-\d{2}-\d{2}\.tar\.gz\.gpg$/, '');
  fs.writeFileSync(path.join(n.dir, `${prefix}2020-01-01.tar.gz.gpg`), 'old');
  assert.equal(n.run('backup.sh').status, 0);
  assert.deepEqual(archives(n.dir), [file], 'keep 1: the old remote copy is deleted');
  const out = path.join(n.base, 'restored');
  const rr = n.run('restore.sh', [`gdrive:superelf-backups/${file}`, out]);
  assert.equal(rr.status, 0, rr.stderr);
  restoredOk(n, out);
});

test('restore asks for the passphrase when the Keychain one does not open the backup', { skip }, () => {
  const n = makeNode();
  assert.equal(n.run('backup.sh').status, 0);
  fs.writeFileSync(`${n.base}/kc`, 'a-newer-passphrase');   // e.g. --setup was run again
  const out = path.join(n.base, 'restored');
  const rr = n.run('restore.sh', [path.join(n.dir, archives(n.dir)[0]), out], `${SECRET}\n`);
  assert.equal(rr.status, 0, rr.stderr);
  assert.match(rr.stderr, /does not open this backup/);
  restoredOk(n, out);
  const bad = n.run('restore.sh', [path.join(n.dir, archives(n.dir)[0]), path.join(n.base, 'r2')], 'wrong\n');
  assert.notEqual(bad.status, 0, 'a wrong typed passphrase fails');
  assert.ok(!fs.existsSync(path.join(n.base, 'r2')), 'and writes nothing');
});

test('two backups at once (a manual run and the nightly one) still leave a complete, restorable file', { skip }, async () => {
  const n = makeNode();
  const codes = await Promise.all([n.runAsync('backup.sh'), n.runAsync('backup.sh')]);
  assert.deepEqual(codes, [0, 0]);
  assert.deepEqual(fs.readdirSync(n.dir).filter((f) => f.startsWith('.')), [], 'no part file left');
  const out = path.join(n.base, 'restored');
  assert.equal(n.run('restore.sh', [path.join(n.dir, archives(n.dir)[0]), out]).status, 0);
  restoredOk(n, out);
});

test('no passphrase in the Keychain: refuses, writes nothing (the empty-passphrase trap)', { skip }, () => {
  const n = makeNode({ withPass: false });
  const r = n.run('backup.sh');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--setup/);
  assert.deepEqual(fs.readdirSync(n.dir), []);
});

test('a missing destination folder fails loudly; restore refuses a folder that is not empty', { skip }, () => {
  const n = makeNode();
  fs.rmSync(n.dir, { recursive: true });
  const r = n.run('backup.sh');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /folder missing/);
  const rr = n.run('restore.sh', [path.join(n.node, 'config.json'), n.node]);
  assert.notEqual(rr.status, 0);
  assert.match(rr.stderr, /not empty/);
});
