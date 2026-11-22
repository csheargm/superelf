// deploy.sh, driven for real · 部署脚本（真实 git，假的 systemd）
//
// The happy path, the refusals and the health-driven rollback, run in the deploy sandbox
// (test/helpers-deploy-sandbox.mjs: real git, fake systemd). What the RUNNING server can do to the
// checkout during a deploy, and the guards against it, are in test/deploy-safety.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, git, put } from './helpers-deploy-sandbox.mjs';
import { needPosixOps } from './helpers-platform.mjs';

const opt = { skip: needPosixOps };

test('up to date: nothing to deploy, health is still checked, install is not run', opt, () => {
  const w = world();
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Up to date/);
  assert.match(w.calls(), /^systemctl --user is-active --quiet superelf-web$/m, 'CONTROL: the unit was asked');
  assert.match(w.calls(), /^curl .*http:\/\/127\.0\.0\.1:8787\/$/m, 'CONTROL: the port was probed, default 8787');
  assert.deepEqual(w.installs(), [], 'nothing pending, nothing installed');
});

test('up to date but unhealthy: says so and fails, rather than reporting success', opt, () => {
  const w = world();
  fs.writeFileSync(path.join(w.st, 'http'), '500');
  const r = w.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT healthy/);
  assert.match(w.calls(), /^journalctl --user -u superelf-web -n 40 --no-pager$/m, 'CONTROL: the journal was shown');
});

test('fast-forward + healthy: installs once, HEAD is origin/main, the range is printed', opt, () => {
  const w = world();
  const prev = w.head(), next = w.ship({ 'lib/a.mjs': 'export const a = 2;\n' }, 'feat: a is two');
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  assert.equal(w.head(), next, 'the node is on the new commit');
  assert.equal(w.installs().length, 1, `install.sh ran exactly once:\n${w.calls()}`);
  assert.match(w.installs()[0], new RegExp(`HEAD=${next}`), 'CONTROL: the stub ran on the NEW code');
  assert.match(r.out, /feat: a is two/, 'the incoming commit was listed');
  assert.match(r.out, /snapshot/, 'with the snapshot reminder');
  assert.match(r.out, new RegExp(`Deployed .*${prev.slice(0, 7)}\\.\\.${next.slice(0, 7)}`));
});

test('the health probe uses web_port from config.json when it is set', opt, () => {
  const w = world();
  fs.writeFileSync(path.join(w.node, 'config.json'), JSON.stringify({ web_port: 9123 }));
  const r = w.run();
  assert.equal(r.code, 0, r.out);
  assert.match(w.calls(), /^curl .*http:\/\/127\.0\.0\.1:9123\/$/m);
  assert.ok(!/:8787\//.test(w.calls()), 'and never the default');
});

for (const [mode, why] of [
  ['down', 'the unit is down and nothing answers'],
  ['stray', 'the unit is not active, though a stray process answers 200'],
  ['http', 'the unit is active but / answers 500'],
  ['flap', 'the port answers only every other probe'],
]) {
  test(`unhealthy after deploy (${why}): rolled back to PREV, reinstalled, exit 1`, opt, () => {
    const w = world();
    const prev = w.head(), next = w.ship({ BROKEN: mode }, 'feat: broken');
    const r = w.run();
    assert.equal(r.code, 1, r.out);
    assert.equal(w.head(), prev, 'HEAD is back on PREV');
    const ins = w.installs();
    assert.equal(ins.length, 2, `installed the new code, then the old:\n${w.calls()}`);
    assert.match(ins[0], new RegExp(`HEAD=${next}`), 'CONTROL: first install ran the new code');
    assert.match(ins[1], new RegExp(`HEAD=${prev}`), 'CONTROL: second install ran PREV');
    assert.match(w.calls(), /^journalctl --user -u superelf-web -n 40 --no-pager$/m, 'the journal was shown');
    assert.match(r.out, /ROLLED BACK/);
    assert.ok(!fs.existsSync(path.join(w.node, 'BROKEN')), 'the bad commit is gone from the tree');
  });
}

test('install.sh fails while the OLD process still answers: rolled back, never "Deployed"', opt, () => {
  const w = world();
  const prev = w.head();
  w.ship({ BROKEN: 'installfail' }, 'feat: install breaks');
  const r = w.run();
  assert.equal(r.code, 1, r.out);
  assert.ok(!/Deployed/.test(r.out), 'a healthy OLD process is not a successful deploy');
  assert.match(r.out, /could not enable superelf-web/, 'CONTROL: the stub failed as staged');
  assert.equal(w.head(), prev);
  assert.equal(w.installs().length, 2, 'the rollback re-installed PREV');
});

test('the rollback is unhealthy too: exit 3 and the operator is told to restore the snapshot', opt, () => {
  const w = world();
  fs.writeFileSync(path.join(w.st, 'always_broken'), 'down');
  const prev = w.head();
  w.ship({ 'lib/a.mjs': 'export const a = 3;\n' });
  const r = w.run();
  assert.equal(r.code, 3, r.out);
  assert.equal(w.head(), prev, 'still rolled back in git');
  assert.equal(w.installs().length, 2, 'CONTROL: both installs ran');
  assert.match(r.out, /ROLLBACK IS UNHEALTHY/);
  assert.match(r.out, /Restore the hypervisor snapshot/);
});

test('a tracked modification (a live app edit) refuses before fetching anything', opt, () => {
  const w = world();
  const prev = w.head(), seen = w.tracking();
  const app = path.join(w.node, 'workspace/apps/x/index.html');
  fs.writeFileSync(app, '<p>edited live by the agent</p>\n');
  w.ship({ 'lib/a.mjs': 'export const a = 4;\n' });
  const r = w.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /M workspace\/apps\/x\/index\.html/, 'CONTROL: the dirty-tree guard is what refused, naming the file');
  assert.match(r.out, /agent may have edited an app/);
  assert.equal(w.head(), prev, 'HEAD unchanged');
  assert.equal(w.tracking(), seen, 'nothing was fetched');
  assert.equal(fs.readFileSync(app, 'utf8'), '<p>edited live by the agent</p>\n', 'the edit survives');
  assert.deepEqual(w.installs(), []);
});

test('diverged history: refuses, with no merge and no reset', opt, () => {
  const w = world();
  put(path.join(w.node, 'lib/local.mjs'), 'export const l = 1;\n');
  git(w.node, 'add', '-A'); git(w.node, 'commit', '-qm', 'local');
  const local = w.head();
  const remote = w.ship({ 'lib/a.mjs': 'export const a = 5;\n' });
  const r = w.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /diverged/);
  assert.match(r.out, /\blocal$/m, 'the local commit is listed');
  assert.ok(!/shelf commits/.test(r.out), 'lib/ is not the shelf: no shelf advice for it');
  assert.equal(w.tracking(), remote, 'CONTROL: it did fetch, so the guard saw the divergence');
  assert.equal(w.head(), local, 'the local commit is untouched');
  assert.deepEqual(w.installs(), []);
});

test('not on main: refuses', opt, () => {
  const w = world();
  git(w.node, 'checkout', '-q', '-b', 'feature');
  w.ship({ 'lib/a.mjs': 'export const a = 6;\n' });
  const r = w.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /on branch 'feature'/, 'CONTROL: the branch guard is what refused');
  assert.equal(git(w.node, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature');
  assert.deepEqual(w.installs(), []);
});

test('the unit is not installed: refuses and points at install.sh', opt, () => {
  const w = world({ unit: false });
  const r = w.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /not installed .*Install the node first: \.\/install\.sh/);
  assert.match(w.calls(), /^systemctl --user show-environment$/m, 'CONTROL: the user bus was probed (service_kind)');
});

test('no user bus (su, cron): explains, refuses', opt, () => {
  const w = world({ state: [] });
  const r = w.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /cannot\s+reach your systemd user manager/, 'the shared explain_unreachable text (R3)');
  assert.deepEqual(w.installs(), []);
});

test('not Linux: exit 2, nothing touched', opt, () => {
  const w = world({ uname: 'Darwin' });
  const seen = w.tracking();
  w.ship({ 'lib/a.mjs': 'export const a = 7;\n' });
  const r = w.run();
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /This is Darwin/);
  assert.match(w.calls(), /^uname -s$/m, 'CONTROL: the fake uname was asked');
  assert.equal(w.tracking(), seen, 'nothing fetched');
});

test('--dry-run lists what would be deployed and changes nothing', opt, () => {
  const w = world();
  const prev = w.head(), next = w.ship({ 'lib/a.mjs': 'export const a = 8;\n' }, 'feat: eight');
  const r = w.run('--dry-run');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /feat: eight/, 'CONTROL: it did reach the incoming list');
  assert.match(r.out, /Dry run/);
  assert.equal(w.head(), prev, 'HEAD unchanged');
  assert.equal(w.tracking(), next, 'only the fetch happened');
  assert.deepEqual(w.installs(), []);
});

test('an incoming file that does not parse is rolled back BEFORE install.sh runs', opt, () => {
  const w = world();
  const prev = w.head();
  w.ship({ 'lib/bad.mjs': 'export const = ;\n' }, 'feat: typo');
  const r = w.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /SYNTAX ERROR: lib\/bad\.mjs/, 'CONTROL: the syntax gate is what caught it');
  assert.equal(w.head(), prev, 'rolled back');
  assert.deepEqual(w.installs(), [], 'the service was never touched');
});

test('an unknown option, or a missing ops/service.sh, is refused before anything runs', opt, () => {
  const w = world();
  const r = w.run('--force');
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /unknown option: --force/);
  assert.equal(w.calls(), '', 'not even uname was called');
  fs.rmSync(path.join(w.node, 'ops/service.sh'));
  const m = w.run();
  assert.equal(m.code, 1, m.out);
  assert.match(m.out, /ops\/service\.sh is missing/, 'the same guard the other ops scripts use');
  assert.match(w.calls(), /^uname -s$/m, 'CONTROL: it got past the platform check');
  assert.ok(!/systemctl|curl/.test(w.calls()), `nothing else was touched: ${w.calls()}`);
});

test('the syntax gate fails when web.mjs is not among the files it checks (R14), before install.sh', opt, () => {
  const w = world();
  const prev = w.head();
  w.ship({ 'web.mjs': null, 'server.mjs': 'export const s = 1;\n' }, 'refactor: rename web.mjs');
  const r = w.run();
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /web\.mjs is not among the files to check/, 'CONTROL: the R14 check is what failed');
  assert.ok(!/SYNTAX ERROR/.test(r.out), 'every file that WAS checked parses: only the R14 check can fail this');
  assert.equal(w.head(), prev, 'rolled back');
  assert.deepEqual(w.installs(), [], 'the service was never touched');
});
