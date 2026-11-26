// backup.sh / restore.sh with config "backup_extra": folders outside the node in the same archive,
// paused around their copy, each packed by its own tar (fixtures and fakes: helpers-backup.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { skip, MARKER, makeNode, archives, restoredOk } from './helpers-backup.mjs';
import { skipIf } from './helpers-skip.mjs';

// An agent-box-like folder outside the node: data to keep, a VM and caches to leave out.
const BOX_KEEP = ['agent/memory.md', 'agent/.env', 'agent/browser-logins/Default/Cookies', 'data/projects/site/index.html'];
const BOX_LEFT_OUT = ['vm', 'agent/cache', 'agent/home/.cache', 'agent/browser-logins/Default/Code Cache'];
const BOX_EXCLUDE = ['vm', 'agent/cache', '*/.cache', 'agent/browser-logins/*Cache'];
function makeBox(base, name = 'box') {
  const box = path.join(base, name);
  for (const rel of [...BOX_KEEP, ...BOX_LEFT_OUT.map((d) => `${d}/f`)]) {
    fs.mkdirSync(path.dirname(path.join(box, rel)), { recursive: true });
    fs.writeFileSync(path.join(box, rel), `${MARKER} ${rel}`);
  }
  fs.chmodSync(path.join(box, 'agent/.env'), 0o600);
  return box;
}
// A backup_extra entry for base/<name>, paused and resumed through the fake boxctl.
const pausedBox = (base, name, pause = 'pause') => {
  const dir = path.join(base, name), ctl = path.join(base, 'bin', 'boxctl');
  return { dir, exclude: BOX_EXCLUDE, pause: [ctl, pause, dir], resume: [ctl, 'resume', dir] };
};
const boxOk = (copy) => {
  for (const rel of BOX_KEEP) assert.equal(fs.readFileSync(path.join(copy, rel), 'utf8'), `${MARKER} ${rel}`, rel);
  for (const rel of BOX_LEFT_OUT) assert.ok(!fs.existsSync(path.join(copy, rel)), `${rel} left out`);
  assert.equal(fs.statSync(path.join(copy, 'agent/.env')).mode & 0o777, 0o600, 'a private file stays private');
};

test('backup_extra folders ride in the same encrypted archive and come back to their own paths', { skip }, async () => {
  const n = makeNode({ extra: (base) => [{ dir: path.join(base, 'box'), exclude: BOX_EXCLUDE }] });
  const box = makeBox(n.base);
  // A live socket (an agent's gateway.sock) cannot be archived; it must not fail the backup.
  const sock = net.createServer();
  await new Promise((res) => sock.listen(path.join(box, 'agent/g.sock'), res));
  const r = n.run('backup.sh');
  sock.close();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.trimEnd().endsWith(`; extra folders: ${box}`), `the log names the extra folder: ${r.stdout}`);
  const files = archives(n.dir);
  assert.equal(files.length, 1, 'one archive holds both');
  assert.ok(!fs.readFileSync(path.join(n.dir, files[0])).includes(MARKER), 'the extra folder is encrypted too');
  fs.rmSync(box, { recursive: true });   // a new machine: the folder is gone
  const out = path.join(n.base, 'restored');
  const rr = n.run('restore.sh', [path.join(n.dir, files[0]), out]);
  assert.equal(rr.status, 0, rr.stderr);
  assert.ok(rr.stdout.includes(`Restored ${box}.`), rr.stdout);
  restoredOk(n, out);
  boxOk(box);
});

test('restore never writes into a folder that has files: the copy goes beside it, and it says so', { skip }, () => {
  const n = makeNode({ extra: (base) => ['box', 'emptied'].map((d) => ({ dir: path.join(base, d), exclude: BOX_EXCLUDE })) });
  const box = makeBox(n.base), emptied = makeBox(n.base, 'emptied');
  assert.equal(n.run('backup.sh').status, 0);
  fs.writeFileSync(path.join(box, 'agent/memory.md'), 'changed since the backup');
  fs.rmSync(emptied, { recursive: true }); fs.mkdirSync(emptied);   // still there, but empty
  const rr = n.run('restore.sh', [path.join(n.dir, archives(n.dir)[0]), path.join(n.base, 'restored')]);
  assert.equal(rr.status, 0, rr.stderr);
  assert.equal(fs.readFileSync(path.join(box, 'agent/memory.md'), 'utf8'), 'changed since the backup', 'the live folder is untouched');
  const beside = fs.readdirSync(n.base).filter((f) => f.startsWith('box.restored-'));
  assert.equal(beside.length, 1, 'one copy beside it');
  boxOk(path.join(n.base, beside[0]));
  assert.ok(rr.stdout.includes(`beside it: ${path.join(n.base, beside[0])}`), rr.stdout);
  boxOk(emptied);
  assert.ok(rr.stdout.includes(`Restored ${emptied}.`), 'an empty folder is filled in place');
});

test('pause runs right before an extra folder is packed and resume right after: the copy is of the paused folder', { skip }, () => {
  const n = makeNode({ extra: (base) => [pausedBox(base, 'box')] });
  const box = makeBox(n.base);
  const r = n.run('backup.sh');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(n.calls(), ['pause box', 'resume box'], 'pause, then resume, once each');
  assert.ok(!fs.existsSync(path.join(box, 'FROZEN')), 'resumed when the backup is done');
  fs.rmSync(box, { recursive: true });
  const rr = n.run('restore.sh', [path.join(n.dir, archives(n.dir)[0]), path.join(n.base, 'restored')]);
  assert.equal(rr.status, 0, rr.stderr);
  restoredOk(n, path.join(n.base, 'restored'));
  boxOk(box);
  assert.ok(fs.existsSync(path.join(box, 'FROZEN')), 'the folder was packed while it was paused');
});

test('resume runs after a failed pause and on a signal; a failed pause skips only that folder, the node is still backed up', { skip }, () => {
  const n = makeNode({ extra: (base) => [
    pausedBox(base, 'box', 'pause-fails'),
    { ...pausedBox(base, 'stuck'), resume: [path.join(base, 'bin', 'no-such-program')] },
    { dir: path.join(base, 'other'), exclude: BOX_EXCLUDE },
  ] });
  const box = makeBox(n.base), stuck = makeBox(n.base, 'stuck'), other = makeBox(n.base, 'other');
  const r = n.run('backup.sh');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`pause failed \\(exit 3\\), extra folder skipped: ${box}$`, 'm'));
  assert.match(r.stderr, new RegExp(`skipped, its resume program cannot run: ${stuck} `));
  assert.deepEqual(n.calls(), ['pause-fails box', 'resume box'], 'resumed after the failed pause; a folder that could not be resumed is never paused');
  assert.ok(r.stdout.trimEnd().endsWith(`; extra folders: ${other}`), r.stdout);
  for (const d of [box, stuck, other]) fs.rmSync(d, { recursive: true });
  const rr = n.run('restore.sh', [path.join(n.dir, archives(n.dir)[0]), path.join(n.base, 'restored')]);
  assert.equal(rr.status, 0, rr.stderr);
  restoredOk(n, path.join(n.base, 'restored'));
  boxOk(other);
  assert.ok(!fs.existsSync(box) && !fs.existsSync(stuck), 'the skipped folders are not in the backup');

  fs.rmSync(n.dir, { recursive: true }); fs.mkdirSync(n.dir); fs.rmSync(`${n.base}/box.calls`);
  makeBox(n.base);
  n.setExtra([pausedBox(n.base, 'box', 'pause-signals')]);
  const rs = n.run('backup.sh');
  assert.equal(rs.status, 143, 'the signal ends the run');
  assert.deepEqual(n.calls(), ['pause-signals box', 'resume box'], 'resumed on the way out');
  assert.deepEqual(fs.readdirSync(n.dir), [], 'nothing written');
});

test('a pause that hangs is cut off: the folder is skipped, resume still runs, the night goes on', { skip }, () => {
  process.env.BACKUP_EXTRA_STEP_SECS = '1';
  let n; try { n = makeNode({ extra: (base) => [pausedBox(base, 'box', 'pause-hangs')] }); } finally { delete process.env.BACKUP_EXTRA_STEP_SECS; }
  const box = makeBox(n.base), t0 = Date.now(), r = n.run('backup.sh');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(Date.now() - t0 < 20000, 'the hung pause did not hold up the run');
  assert.match(r.stderr, new RegExp(`pause failed \\(exit 142\\), extra folder skipped: ${box}$`, 'm'));
  assert.deepEqual(n.calls(), ['pause-hangs box', 'resume box'], 'resumed after the cut-off pause');
  assert.equal(archives(n.dir).length, 1, 'the node is still backed up');
});

// A file the backup cannot open stands in for one deleted mid-read (that race cannot be timed):
// both fail that folder's tar, and bsdtar's copy then lacks an unknown part of the folder.
const asRoot = process.getuid?.() === 0;
test('an extra folder that cannot be read whole is skipped, never kept in part; the other folder and the node are backed up', { skip: skip || skipIf(asRoot, 'root-user', 'root reads every file') }, () => {
  const n = makeNode({ extra: (base) => ['broken', 'fine'].map((d) => ({ dir: path.join(base, d), exclude: BOX_EXCLUDE })) });
  const broken = makeBox(n.base, 'broken'), fine = makeBox(n.base, 'fine');
  fs.writeFileSync(path.join(broken, 'agent/unreadable'), MARKER, { mode: 0 });
  const r = n.run('backup.sh');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, new RegExp(`WARNING: ${broken} could not be read whole \\(tar exit [12], above\\), skipped tonight`));
  assert.ok(r.stdout.trimEnd().endsWith(`; extra folders: ${fine}`), r.stdout);
  for (const d of [broken, fine]) fs.rmSync(d, { recursive: true });
  const rr = n.run('restore.sh', [path.join(n.dir, archives(n.dir)[0]), path.join(n.base, 'restored')]);
  assert.equal(rr.status, 0, rr.stderr);
  restoredOk(n, path.join(n.base, 'restored'));
  boxOk(fine);
  assert.ok(!fs.existsSync(broken), 'no part of the folder that could not be read is restored');
});

test('backup_extra is read on every run: a missing folder is skipped with a warning, a bad entry stops before any write', { skip }, () => {
  const n = makeNode();
  n.setExtra([{ dir: path.join(n.base, 'not-there') }]);
  const r = n.run('backup.sh');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /extra folder missing, skipped: .*not-there/);
  assert.equal(archives(n.dir).length, 1, 'the node is still backed up');
  fs.rmSync(n.dir, { recursive: true }); fs.mkdirSync(n.dir);
  const a = path.join(n.base, 'a');
  fs.mkdirSync(path.join(a, 'b'), { recursive: true });
  fs.symlinkSync(a, path.join(n.base, 'link'));
  const bad = [
    [[{ dir: 'relative/folder' }], /absolute folder path/],
    [{ dir: '/x' }, /must be a list/],
    [[{ dir: n.node }], /overlaps the superelf folder/],
    [[{ dir: n.base }], /overlaps the superelf folder/],
    [[{ dir: n.dir }], /overlaps the backup folder/],
    [[{ dir: path.join(n.node, 'workspace'), exclude: ['../x'] }], /must list paths inside it/],
    [[{ dir: path.join(n.base, 'link') }], /is a link/],
    [[{ dir: a }, { dir: path.join(a, 'b') }], /overlaps .*\/a$/m],
    [[{ dir: a, pause: ['/bin/true'] }], /"pause" and "resume" of .* go together/],
    [[{ dir: a, pause: ['true'], resume: ['/bin/true'] }], /"pause" of .* must be a command list/],
    [[{ dir: a, pause: ['/bin/true'], resume: [] }], /"resume" of .* must be a command list/],
  ];
  for (const [list, why] of bad) {
    n.setExtra(list);
    const rb = n.run('backup.sh');
    assert.notEqual(rb.status, 0, JSON.stringify(list));
    assert.match(rb.stderr, why);
    assert.deepEqual(fs.readdirSync(n.dir), [], 'nothing written');
  }
});
