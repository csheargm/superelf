// The image names the commit it holds · 镜像记录自己的提交 (lib/buildid.mjs REVISION).
// Scar 2026-11-23: the VM footer read "v5.0.0 · ca28633" on today's code and PAUpdate (ADR 0026)
// never fired, because the image carried no REVISION and the node folder kept one from an older
// deploy. Now the Dockerfile writes REVISION from a REQUIRED build arg, the rebuild scripts get
// the sha from ops/demo/revision.sh, and the entrypoint's copy replaces the folder's file on start.
// Docker is not needed: the Dockerfile and compose wiring are checked statically, revision.sh and
// the Dockerfile's own RUN line are executed in bash, and the entrypoint's tar copy is simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { readRevision, readRevisionDate } from '../lib/buildid.mjs';
import { ROOT } from './helpers-panote-routing.mjs';

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const DOCKERFILE = read('ops/demo/Dockerfile');
const SHA_A = 'a'.repeat(40), SHA_B = 'b'.repeat(40);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-rev-'));

// The Dockerfile's REVISION RUN line, run in bash with the given build args.
const stampRun = () => {
  const m = /^RUN (printf '%s' "\$REVISION"[\s\S]*?> \/opt\/superelf\/REVISION)$/m.exec(DOCKERFILE);
  assert.ok(m, 'the Dockerfile has the REVISION RUN line');
  return m[1].replace(/\\\n/g, ' ');
};
const runStamp = (args, out) => spawnSync('bash', ['-c', stampRun().replaceAll('/opt/superelf/REVISION', out)], { env: { PATH: process.env.PATH, ...args }, encoding: 'utf8' });

test('the Dockerfile declares REVISION/REVISION_DATE and writes REVISION after the code COPY', () => {
  assert.match(DOCKERFILE, /^ARG REVISION$/m);
  assert.match(DOCKERFILE, /^ARG REVISION_DATE$/m);
  assert.ok(DOCKERFILE.indexOf('> /opt/superelf/REVISION') > DOCKERFILE.indexOf('COPY . /opt/superelf'), 'written after COPY, so nothing from the context can replace it');
  for (const f of ['ops/demo/docker-compose.yml']) {
    const y = read(f);
    assert.match(y, /REVISION: \$\{SUPERELF_REVISION:-\}/, `${f} passes the sha`);
    assert.match(y, /REVISION_DATE: \$\{SUPERELF_REVISION_DATE:-\}/, `${f} passes the date`);
  }
  const rb = read('ops/demo/rebuild-demo.sh');
  const src = rb.indexOf('superelf_revision "$(cd ../.. && pwd)" || die'), build = rb.indexOf('\ncompose build\n');
  assert.ok(src > 0 && build > src, 'rebuild-demo.sh resolves the revision BEFORE compose build, and stops if it cannot');
});

test('the build stamp: right args write sha + date; a missing or bad arg FAILS the build (no silent stale stamp)', () => {
  const d = tmp(), out = path.join(d, 'REVISION');
  const ok = runStamp({ REVISION: SHA_A, REVISION_DATE: '2026-11-23' }, out);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readFileSync(out, 'utf8'), `${SHA_A}\n2026-11-23\n`);
  assert.equal(readRevision(d), SHA_A); assert.equal(readRevisionDate(d), '2026-11-23');
  for (const [args, why] of [[{}, 'no args'], [{ REVISION: SHA_A }, 'no date'], [{ REVISION: 'ca28633', REVISION_DATE: '2026-11-23' }, 'a short sha'], [{ REVISION: 'x; rm -rf /', REVISION_DATE: '2026-11-23' }, 'junk']]) {
    fs.rmSync(out, { force: true });
    const r = runStamp(args, out);
    assert.notEqual(r.status, 0, `${why}: the build fails`);
    assert.match(r.stderr, /build arg REVISION/, `${why}: and says why`);
    assert.equal(fs.existsSync(out), false, `${why}: no REVISION written`);
  }
});

// revision.sh in bash: prints "sha date" or fails.
const revision = (root) => spawnSync('bash', ['-c', `set -euo pipefail; . "$1"; superelf_revision "$2"; echo "$SUPERELF_REVISION $SUPERELF_REVISION_DATE"`, '_', path.join(ROOT, 'ops/demo/revision.sh'), root], { encoding: 'utf8' });
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: '2026-11-23T10:00:00Z', GIT_AUTHOR_DATE: '2026-11-23T10:00:00Z' } }).trim();

test('revision.sh: a deploy-vm REVISION, or the git checkout; neither, or the two disagreeing, refuses', () => {
  const plain = tmp();
  let r = revision(plain);
  assert.notEqual(r.status, 0, 'no REVISION, no .git: refused'); assert.match(r.stderr, /no commit sha/);
  fs.writeFileSync(path.join(plain, 'REVISION'), `${SHA_A}\n2026-11-22\n`);
  r = revision(plain); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), `${SHA_A} 2026-11-22`);
  fs.writeFileSync(path.join(plain, 'REVISION'), 'ca28633\n');
  assert.notEqual(revision(plain).status, 0, 'a short or dateless REVISION is refused');

  const repo = tmp();
  git(repo, 'init', '-q'); fs.writeFileSync(path.join(repo, 'f'), '1'); git(repo, 'add', 'f'); git(repo, 'commit', '-qm', 'one');
  const head = git(repo, 'rev-parse', 'HEAD');
  r = revision(repo); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), `${head} 2026-11-23`, 'a checkout: git HEAD and its date');
  fs.writeFileSync(path.join(repo, 'REVISION'), `${head}\n2026-11-23\n`);
  assert.equal(revision(repo).status, 0, 'REVISION matching HEAD is fine');
  fs.writeFileSync(path.join(repo, 'REVISION'), `${SHA_A}\n2026-11-22\n`);
  r = revision(repo);
  assert.notEqual(r.status, 0, 'a REVISION left by an older deploy next to a newer HEAD: refused, never guessed');
  assert.match(r.stderr, /REVISION says aaaaaaa but git HEAD is/);
});

test('entrypoint copy (simulated): the image REVISION replaces the stale one in the node folder', () => {
  const ep = read('ops/demo/entrypoint.sh');
  const copy = /^tar -C \/opt\/superelf -cf - \. \| tar -C "\$NODE_DIR" -xf -$/m;
  assert.match(ep, copy, 'the entrypoint copies the whole image folder (REVISION included)');
  const image = tmp(), node = tmp();
  fs.writeFileSync(path.join(image, 'web.mjs'), '// today');
  assert.equal(runStamp({ REVISION: SHA_B, REVISION_DATE: '2026-11-23' }, path.join(image, 'REVISION')).status, 0);
  fs.writeFileSync(path.join(node, 'REVISION'), `${SHA_A}\n`);   // the 11-22 leftover
  execFileSync('bash', ['-c', ep.match(copy)[0].replace('/opt/superelf', '"$1"').replace('"$NODE_DIR"', '"$2"'), '_', image, node]);
  assert.equal(readRevision(node), SHA_B, 'the node now names the code it runs');
  assert.equal(readRevisionDate(node), '2026-11-23');
});
