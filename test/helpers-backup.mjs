// Fixtures for the backup.sh / restore.sh tests (backup.test.mjs, backup-extra.test.mjs): the
// real scripts, real tar and gpg, on a throwaway node folder. Fakes on PATH only: `security` (the
// macOS Keychain; it answers from a file the test controls) and `rclone` (maps "gdrive:<path>" to
// a local folder), so no test can reach the real Keychain or Google Drive; plus `boxctl`, a program
// a backup_extra entry pauses and resumes. Skipped where gpg or bash is missing (Windows CI).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { skipIf } from './helpers-skip.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
export const skip = skipIf(process.platform === 'win32', 'posix-only', 'needs bash and gpg')
  || skipIf(!has('gpg') || !has('bash'), 'no-gpg', 'needs bash and gpg');
export const SECRET = 'test-passphrase-not-real';
export const MARKER = 'JOURNAL-PRIVATE-MARKER-7f3a';
const ARCHIVE = /^superelf-.+-\d{4}-\d{2}-\d{2}\.tar\.gz\.gpg$/;

// A node folder with data, things the backup must leave out, and backup_dir = `dest`
// (a local folder, or "gdrive:superelf-backups" served by the fake rclone from base/remote).
// `extra(base)` returns the backup_extra list, if any.
// `linux`: the Linux path — the passphrase in a 0600 file named by backup_pass_file, no Keychain.
export function makeNode({ keep = 2, withPass = true, remote = false, extra, linux = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-backup-'));
  const node = path.join(base, 'node'), bin = path.join(base, 'bin');
  const dir = remote ? path.join(base, 'remote', 'superelf-backups') : path.join(base, 'drive');
  for (const d of [node, dir, bin, `${node}/lib`, `${node}/workspace/data/notes`, `${node}/.claude/worktrees/x`, `${node}/bible-data`]) fs.mkdirSync(d, { recursive: true });
  for (const s of ['backup.sh', 'restore.sh', 'lib/backup-extra.sh']) fs.copyFileSync(path.join(ROOT, s), path.join(node, s));
  const backupDir = remote ? 'gdrive:superelf-backups' : dir;
  const setExtra = (list) => fs.writeFileSync(`${node}/config.json`, JSON.stringify({ web_token: 'tok', backup_dir: backupDir, backup_keep: keep, ...(linux && { backup_pass_file: `${base}/pass` }), ...(list && { backup_extra: list }) }));
  setExtra(extra?.(base));
  fs.writeFileSync(`${node}/workspace/data/notes/entry.json`, JSON.stringify({ text: MARKER }));
  fs.writeFileSync(`${node}/audit.log`, 'kept: it is data\n');
  fs.writeFileSync(`${node}/web.log`, 'left out\n');
  fs.writeFileSync(`${node}/.claude/worktrees/x/f`, 'left out\n');
  fs.writeFileSync(`${node}/bible-data/c.json`, 'left out\n');
  fs.writeFileSync(`${base}/kc`, SECRET);
  if (linux && withPass) fs.writeFileSync(`${base}/pass`, `${SECRET}\n`, { mode: 0o600 });
  fs.writeFileSync(`${bin}/security`, `#!/bin/sh\necho "$*" >> "${base}/security.calls"\n${withPass ? '' : 'exit 44\n'}case "$*" in *-w*) cat "${base}/kc"; echo;; esac\n`, { mode: 0o755 });
  const r = (p) => `"${base}/remote/$(echo "${p}" | sed 's/^gdrive://')"`;
  fs.writeFileSync(`${bin}/rclone`, `#!/bin/sh
case "$1" in
  mkdir) mkdir -p ${r('$2')};;
  copyto) case "$2" in gdrive:*) cp ${r('$2')} "$3";; *) cp "$2" ${r('$3')};; esac;;
  lsf) ls -1 ${r('$3')};;
  deletefile) rm -f ${r('$2')};;
  *) exit 9;;
esac\n`, { mode: 0o755 });
  // boxctl <verb> <folder>: logs "<verb> <folder name>" to base/box.calls. pause marks the folder
  // FROZEN and resume clears it, so the archive shows whether the folder was packed while paused;
  // pause-fails exits 3; pause-hangs never returns; pause-signals sends the backup SIGTERM (its
  // grandparent: the watchdog that runs it is its parent).
  fs.writeFileSync(`${bin}/boxctl`, `#!/bin/sh
echo "$1 $(basename "$2")" >> "${base}/box.calls"
case "$1" in
  pause) touch "$2/FROZEN";;
  resume) rm -f "$2/FROZEN";;
  pause-fails) exit 3;;
  pause-hangs) sleep 60;;
  pause-signals) kill -TERM "$(ps -o ppid= -p $PPID | tr -d ' ')";;
esac\n`, { mode: 0o755 });
  const calls = () => (fs.existsSync(`${base}/box.calls`) ? fs.readFileSync(`${base}/box.calls`, 'utf8').trim().split('\n') : []);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, SUPERELF_BACKUP_PLATFORM: linux ? 'Linux' : 'Darwin' };
  const run = (script, args = [], input, more = {}) => spawnSync('bash', [path.join(node, script), ...args], { env: { ...env, ...more }, encoding: 'utf8', input });
  const runAsync = (script) => new Promise((res) => {
    const c = spawn('bash', [path.join(node, script)], { env });
    c.on('close', (code) => res(code));
  });
  return { base, node, dir, backupDir, run, runAsync, setExtra, calls };
}
export const archives = (dir) => fs.readdirSync(dir).filter((f) => ARCHIVE.test(f)).sort();
export const restoredOk = (n, out) => {
  for (const rel of ['workspace/data/notes/entry.json', 'audit.log', 'config.json', 'backup.sh', 'lib/backup-extra.sh']) {
    assert.deepEqual(fs.readFileSync(path.join(out, rel)), fs.readFileSync(path.join(n.node, rel)), rel);
  }
  for (const rel of ['web.log', '.claude/worktrees', 'bible-data']) assert.ok(!fs.existsSync(path.join(out, rel)), `${rel} left out`);
  // Exactly the node's own entries: nothing of the extra folders is left inside the restored node.
  const kept = fs.readdirSync(n.node).filter((f) => !['web.log', 'bible-data'].includes(f)).sort();
  assert.deepEqual(fs.readdirSync(out).sort(), kept, 'the restored node holds only its own files');
};

