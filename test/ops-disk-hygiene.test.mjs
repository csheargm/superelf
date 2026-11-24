// ops/demo/disk-hygiene.sh (sourced by the VM rebuilds) and the image's agent-CLI run check.
// The real helper runs in bash with recording fakes for df and docker (no real Docker is reached).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function sandbox(freeKb, dockerExit = 0) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'diskhyg-'));
  const log = path.join(t, 'calls.log');
  fs.writeFileSync(path.join(t, 'df'), `#!/bin/sh\necho "df $*" >> "${log}"\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "/dev/sda1 47000000 1 ${freeKb} 95% /"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(t, 'docker'), `#!/bin/sh\necho "docker $*" >> "${log}"\nexit ${dockerExit}\n`, { mode: 0o755 });
  const run = (fn, env = {}) => spawnSync('bash', ['-c', `. "${ROOT}/ops/demo/disk-hygiene.sh"; ${fn} t`],
    { encoding: 'utf8', env: { ...process.env, DF: path.join(t, 'df'), DOCKER: path.join(t, 'docker'), ...env } });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  return { run, calls, done: () => fs.rmSync(t, { recursive: true, force: true }) };
}

test('guard refuses below 3 GB free on / with a clear message, passes at or above', () => {
  const low = sandbox(2 * 1048576);
  const r = low.run('superelf_disk_guard');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /only 2 GB free on \/, a build needs 3 GB/);
  assert.deepEqual(low.calls(), ['df -Pk /'], 'the fake df was reached (R14)');
  low.done();
  const ok = sandbox(3 * 1048576);
  assert.equal(ok.run('superelf_disk_guard').status, 0);
  ok.done();
});

test('the floor is config (SUPERELF_MIN_FREE_GB) and junk values or unreadable df fail closed', () => {
  const s = sandbox(5 * 1048576);
  assert.equal(s.run('superelf_disk_guard', { SUPERELF_MIN_FREE_GB: '6' }).status, 1);
  assert.equal(s.run('superelf_disk_guard', { SUPERELF_MIN_FREE_GB: 'x' }).status, 1);
  s.done();
  const bad = sandbox('n/a');
  assert.match(bad.run('superelf_disk_guard').stderr, /cannot read free disk space/);
  bad.done();
});

test('prune removes only dangling images and build cache: never volumes, never -a on images', () => {
  const s = sandbox(1);
  assert.equal(s.run('superelf_prune').status, 0);
  assert.deepEqual(s.calls(), ['docker image prune -f', 'docker builder prune -af']);
  s.done();
  const f = sandbox(1, 1);
  const r = f.run('superelf_prune');
  assert.equal(r.status, 0, 'a failed prune is a warning, not a failed deploy');
  assert.match(r.stderr, /warning: docker image prune failed/);
  f.done();
});

test('rebuild-demo guards before the build, prunes only after the healthy check, defaults to a 1 GB disk', () => {
  const s = read('ops/demo/rebuild-demo.sh');
  const guard = s.indexOf('superelf_disk_guard'), build = s.indexOf('compose build'), prune = s.indexOf('superelf_prune'), up = s.indexOf('echo "Up.');
  assert.ok(guard > 0 && guard < build, 'guard before build');
  assert.ok(prune > s.indexOf('Registered tunnel connection') && prune < up, 'prune after the health and tunnel checks');
  assert.match(s, /DISK_GB=\$\{DEMO_DISK_GB:-1\}/);
  assert.match(read('ops/demo/.env.example'), /^DEMO_DISK_GB=1$/m);
});

test('image build installs optional deps and fails unless every agent CLI runs', () => {
  const d = read('ops/demo/Dockerfile');
  assert.match(d, /npm install -g [^\n]*--include=optional \$AGENT_CLIS/);
  assert.match(d, /@anthropic-ai\/claude-code@\*\) b=claude;;/);
  assert.match(d, /@openai\/codex@\*\) b=codex;;/);
  assert.match(d, /"\$b" --version >\/dev\/null \|\| \{[^}]*exit 1; \}/);
  assert.match(d, /\*\) echo "no run check known for \$c[^"]*" >&2; exit 1;;/, 'an unknown CLI fails closed');
});
