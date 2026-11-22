// Linux service + the ops scripts, driven for real · Linux 服务（systemd 用户单元）
//
// On Linux install.sh used to print "Not macOS — skipping launchd", run a start.sh that only knew
// launchctl (so web.mjs never started), and close with "superelf runs at boot from now on". And the
// process patterns in start.sh/stop.sh were the literal "personal_agent/…" — the author's checkout
// name — so on a fresh `git clone …/superelf.git` status lied and stop left strays.
//
// These run the REAL scripts in a sandbox (test/helpers-ops-sandbox.mjs): only recording fakes on
// PATH, no real launchctl/systemctl/pkill reachable. Every test also asserts its fake was CALLED, so
// a branch that silently skipped the service cannot pass (R14).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sandbox, LINUX_FAKES, MAC_FAKES, MAC_ABSENT } from './helpers-ops-sandbox.mjs';
import { needPosixOps } from './helpers-platform.mjs';

const BOOT = /runs at boot from now on/;
// The placeholders by NAME: both templates mention "__PLACEHOLDERS__" in their header comment.
const LEFTOVER = /__(NODE|ROOT|PATH|LOG)__/;
const opt = { skip: needPosixOps };

test('Linux + systemd: install renders the unit, enables it, turns on linger, and says so', opt, () => {
  const sb = sandbox({ fakes: LINUX_FAKES, state: ['userbus'] });
  const r = sb.run('install.sh');
  assert.equal(r.code, 0, r.out);
  const unit = fs.readFileSync(sb.unitFile, 'utf8');
  assert.ok(!LEFTOVER.test(unit), `no placeholder left behind:\n${unit}`);
  assert.match(unit, /^Restart=always$/m, 'restart on ANY exit: /api/admin/restart exits 0');
  assert.match(unit, /^StartLimitIntervalSec=0$/m, 'and never give up on a crash loop');
  assert.match(unit, new RegExp(`^WorkingDirectory=${sb.repo}$`, 'm'));
  assert.match(unit, new RegExp(`^ExecStart="${sb.bin}/node" "${sb.repo}/web\\.mjs"$`, 'm'), 'absolute node path');
  assert.match(unit, new RegExp(`^Environment="PATH=${sb.bin}:`, 'm'), 'explicit PATH, node and claude dirs first');
  assert.match(unit, /^WantedBy=default\.target$/m);
  const c = sb.calls();
  assert.match(c, /^systemctl --user daemon-reload$/m, 'CONTROL: the fake systemctl was reached');
  assert.match(c, /^systemctl --user enable superelf-web$/m);
  assert.match(c, /^systemctl --user restart superelf-web$/m);
  assert.match(c, /^loginctl enable-linger famuser$/m, 'linger is what makes a user unit start at boot');
  assert.match(c, /^systemctl --user start superelf-web$/m, 'start.sh started it through systemd');
  assert.ok(!/launchctl/.test(c), 'nothing tried launchd');
  assert.match(r.out, BOOT, 'the claim is now true: enabled + linger on');
  assert.match(r.out, /journalctl --user -u superelf-web/, 'and it says where the logs are');
});

test('linger refused (no polkit, no sudo): the node runs, but the installer does NOT claim boot', opt, () => {
  const sb = sandbox({ fakes: LINUX_FAKES, state: ['userbus', 'linger_denied', 'sudo_denied'] });
  const r = sb.run('install.sh');
  assert.equal(r.code, 0, r.out);
  const c = sb.calls();
  assert.match(c, /^loginctl enable-linger famuser$/m, 'CONTROL: it tried as the user');
  assert.match(c, /^sudo loginctl enable-linger famuser$/m, 'CONTROL: then with sudo');
  assert.ok(!BOOT.test(r.out), 'never "runs at boot" with linger off');
  assert.match(r.out, /LINGER IS OFF/, 'said loudly');
  assert.match(r.out, /will NOT start at boot/);
  assert.match(r.out, /sudo loginctl enable-linger famuser/, 'with the exact fix');
});

test('linger: falls back to sudo, and trusts the RE-CHECK over exit codes', opt, () => {
  const sb = sandbox({ fakes: LINUX_FAKES, state: ['userbus', 'linger_denied'] });
  const r = sb.run('install.sh');
  assert.equal(r.code, 0, r.out);
  assert.match(sb.calls(), /^sudo loginctl enable-linger famuser$/m, 'CONTROL: sudo was used');
  assert.ok(fs.existsSync(`${sb.st}/linger`), 'and linger really is on');
  assert.match(r.out, BOOT);
  // Already on: nothing to enable, nothing to escalate.
  const sb2 = sandbox({ fakes: LINUX_FAKES, state: ['userbus', 'linger'] });
  assert.match(sb2.run('install.sh').out, /linger already on/);
  assert.match(sb2.calls(), /^loginctl show-user famuser --property=Linger --value$/m, 'CONTROL: it asked');
  assert.ok(!/enable-linger/.test(sb2.calls()), 'and did not re-enable');
});

// `enable --now` and `systemctl start` are no-ops on a running unit, so a re-run after a `git pull`
// — or after migrating config.json in — left the OLD process serving, and that process writes its
// in-memory users back over the migrated config.json. The fake counts real launches ("gen").
test('a re-run of install.sh RESTARTS a running unit, so new code and migrated data are live', opt, () => {
  const sb = sandbox({ fakes: LINUX_FAKES, state: ['userbus', 'linger'] });
  assert.equal(sb.run('install.sh').code, 0);
  const gen = () => fs.readFileSync(`${sb.st}/gen`, 'utf8').trim();
  assert.equal(gen(), '1', 'CONTROL: the first install launched node once');
  fs.writeFileSync(`${sb.base}/calls.log`, '');
  const r = sb.run('install.sh');
  assert.equal(r.code, 0, r.out);
  assert.match(sb.calls(), /^systemctl --user restart superelf-web$/m, 'CONTROL: the fake systemctl was reached');
  assert.equal(gen(), '2', 'the second run launched a FRESH process, not a no-op on the old one');
});

test('NO systemctl at all: no unit, no start, and no "runs at boot"', opt, () => {
  const sb = sandbox({ fakes: ['uname', 'sleep', 'claude', 'pgrep', 'pkill'] });
  const r = sb.run('install.sh');
  assert.equal(r.code, 0, r.out);
  assert.match(sb.calls(), /^uname -s$/m, 'CONTROL: the fake uname put us on Linux');
  assert.ok(!fs.existsSync(sb.unitFile), 'no unit written');
  assert.ok(!BOOT.test(r.out), 'the old lie is gone');
  assert.match(r.out, /NOT running and will NOT start at boot/);
  assert.match(r.out, /\.\/run\.sh web/, 'it says how to run it instead');
  assert.ok(!/Starting/.test(r.out), 'and does not pretend to start it');
});

test('systemctl present but no user bus (WSL without systemd, a container): same honesty', opt, () => {
  const sb = sandbox({ fakes: LINUX_FAKES });
  const r = sb.run('install.sh');
  assert.equal(r.code, 0, r.out);
  assert.match(sb.calls(), /^systemctl --user show-environment$/m, 'CONTROL: it probed the bus');
  assert.ok(!/enable/.test(sb.calls()), 'and enabled nothing');
  assert.ok(!BOOT.test(r.out));
  assert.match(r.out, /wsl\.conf/, 'with the WSL fix');
});

test('systemd-analyze, when present, gates the rendered unit', opt, () => {
  const ok = sandbox({ fakes: [...LINUX_FAKES, 'systemd-analyze'], state: ['userbus'] });
  assert.equal(ok.run('install.sh').code, 0);
  assert.ok(ok.calls().includes(`systemd-analyze --user verify ${ok.unitFile}`), 'CONTROL: verify ran');
  const bad = sandbox({ fakes: [...LINUX_FAKES, 'systemd-analyze'], state: ['userbus', 'analyze_fails'] });
  const r = bad.run('install.sh');
  // Advisory: verify can fail for reasons outside the unit, and enable/restart are the real gates.
  assert.equal(r.code, 0, 'a verify complaint does not abort the install');
  assert.match(r.out, /systemd-analyze reported problems/, 'but it is shown, never swallowed');
  assert.ok(bad.calls().includes(`systemctl --user enable superelf-web`), 'CONTROL: the install went on');
});

test('install.sh refuses to run as root (the service and data must belong to the user)', opt, () => {
  const sb = sandbox({ fakes: LINUX_FAKES, state: ['userbus'] });
  fs.rmSync(path.join(sb.bin, 'id'));
  fs.writeFileSync(path.join(sb.bin, 'id'), '#!/bin/bash\necho "id $*" >> "$FAKE_LOG"\n[ "$1" = -u ] && echo 0 || echo root\n', { mode: 0o755 });
  const r = sb.run('install.sh');
  assert.notEqual(r.code, 0);
  assert.match(r.out, /not root or sudo/);
  assert.ok(sb.calls().includes('id -u'), 'CONTROL: the fake id was asked');
  assert.ok(!fs.existsSync(path.join(sb.repo, 'config.json')) && !/systemctl/.test(sb.calls()), 'nothing was written or enabled');
});

test('a missing ops/service.sh stops every script before it can pkill with an empty pattern', opt, () => {
  for (const script of ['stop.sh', 'start.sh', 'run.sh', 'install.sh']) {
    const sb = sandbox({ fakes: LINUX_FAKES, state: ['userbus'], ps: ['/usr/bin/node /home/u/superelf/web.mjs'] });
    assert.equal(sb.run('stop.sh').code, 0, `CONTROL (${script}): the intact checkout runs`);
    assert.match(sb.calls(), /pkill|systemctl/, `CONTROL (${script}): the fakes are reachable`);
    fs.rmSync(path.join(sb.repo, 'ops/service.sh'));
    fs.writeFileSync(path.join(sb.base, 'calls.log'), '');
    const r = sb.run(script, script === 'run.sh' ? ['web'] : []);
    assert.notEqual(r.code, 0, `${script} must refuse`);
    assert.match(r.out, /ops\/service\.sh is missing/);
    assert.ok(!/pkill|pgrep|systemctl|node/.test(sb.calls()), `${script} touched nothing: ${sb.calls()}`);
  }
});

test('--no-service still installs no service and starts nothing', opt, () => {
  const sb = sandbox({ fakes: LINUX_FAKES, state: ['userbus'] });
  const r = sb.run('install.sh', ['--no-service']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /setup stub/, 'CONTROL: the rest of the install ran');
  assert.ok(!fs.existsSync(sb.unitFile));
  assert.ok(!/systemctl|loginctl/.test(sb.calls()), 'no service manager touched');
  assert.match(r.out, /Not started \(--no-service\)/);
});

test('start.sh / stop.sh on Linux go through systemctl --user, stop BEFORE the stray sweep', opt, () => {
  const sb = sandbox({ fakes: LINUX_FAKES, state: ['userbus'] });
  sb.run('install.sh');
  fs.writeFileSync(`${sb.base}/calls.log`, '');
  assert.match(sb.run('start.sh').out, /systemd user service superelf-web started/);
  assert.match(sb.calls(), /^systemctl --user start superelf-web$/m);
  const r = sb.run('stop.sh');
  assert.match(r.out, /superelf-web stopped/, r.out);
  const c = sb.calls();
  const stop = c.indexOf('systemctl --user stop superelf-web'), kill = c.indexOf('pkill');
  assert.ok(stop > -1 && kill > stop, 'stop the unit first, or Restart=always respawns what pkill kills');
  assert.equal(fs.readFileSync(`${sb.st}/active`, 'utf8').trim(), 'inactive');
});

test('stop.sh stops a unit that is between restarts ("activating"), not only an "active" one', opt, () => {
  const sb = sandbox({ fakes: LINUX_FAKES, state: ['userbus', 'enabled'], active: 'activating' });
  sb.run('install.sh', ['--no-service']);
  fs.mkdirSync(`${sb.env.HOME}/.config/systemd/user`, { recursive: true });
  fs.writeFileSync(sb.unitFile, '[Service]\n');
  sb.run('stop.sh');
  assert.match(sb.calls(), /^systemctl --user stop superelf-web$/m);
});

test('run.sh REFUSES web while the systemd unit owns it, and supervises when it does not', opt, () => {
  const sb = sandbox({ fakes: LINUX_FAKES, state: ['userbus', 'enabled'] });
  let r = sb.run('run.sh', ['web']);
  assert.equal(r.code, 1);
  assert.match(r.out, /refusing: web\.mjs is owned by the superelf-web systemd user service/);
  assert.match(sb.calls(), /^systemctl --user is-enabled --quiet superelf-web$/m, 'CONTROL: it asked systemd');
  const act = sandbox({ fakes: LINUX_FAKES, state: ['userbus'], active: 'active' });
  assert.match(act.run('run.sh', ['web']).out, /refusing/, 'active-but-not-enabled is owned too');
  // CONTROL: with no unit, the very same call supervises — the refusal above is the guard, not an
  // accident of the sandbox.
  const free = sandbox({ fakes: LINUX_FAKES, state: ['userbus'] });
  r = free.run('run.sh', ['web'], { FAKE_NODE_STOP: '1' });
  assert.match(r.out, /\[supervisor\] watching web\.mjs/);
  assert.match(free.calls(), /^node web\.mjs$/m, 'node was really launched');
});

// The unit is installed and running, but THIS shell has no user bus (su - user, sudo -iu user, cron).
// That used to read as "no service manager": run.sh supervised a second web.mjs (the EADDRINUSE
// duel), stop.sh pkill'd a node Restart=always respawns and said "stopped", start.sh said "none".
test('unit installed but the user bus is unreachable: every script refuses and says why', opt, () => {
  const sb = sandbox({ fakes: LINUX_FAKES, state: ['userbus', 'linger'] });
  assert.equal(sb.run('install.sh').code, 0);
  fs.rmSync(`${sb.st}/userbus`);
  const node = `/usr/bin/node ${sb.repo}/web.mjs`;
  fs.writeFileSync(`${sb.base}/ps.txt`, node + '\n');
  fs.writeFileSync(`${sb.base}/calls.log`, '');
  const WHY = /cannot\s+reach your systemd user manager/;
  let r = sb.run('run.sh', ['web'], { FAKE_NODE_STOP: '1' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, WHY);
  assert.ok(!/^node web\.mjs$/m.test(sb.calls()), 'no second web.mjs was launched');
  assert.match(sb.calls(), /^systemctl --user show-environment$/m, 'CONTROL: it probed the bus');
  r = sb.run('stop.sh');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, WHY);
  assert.ok(!/web: stopped/.test(r.out), 'never "stopped" while systemd still runs it');
  assert.ok(!/^pkill/m.test(sb.calls()), 'and no pkill for Restart=always to undo');
  assert.ok(sb.ps().includes(node));
  r = sb.run('start.sh');
  assert.match(r.out, WHY);
  assert.ok(!/no service manager here/.test(r.out), r.out);
  r = sb.run('install.sh');
  assert.notEqual(r.code, 0, 'the installer does not claim anything from here either');
  assert.match(r.out, WHY);
  assert.ok(!BOOT.test(r.out) && !/NOT running/.test(r.out), r.out);
  // CONTROL: with no unit file the same unreachable bus is plain "none" — the unit file decides.
  const none = sandbox({ fakes: LINUX_FAKES });
  assert.match(none.run('start.sh').out, /no service manager here/);
});

test('macOS branch is unchanged: plist rendered + linted, launchctl bootstrap, no systemd', opt, () => {
  const sb = sandbox({ uname: 'Darwin', fakes: MAC_FAKES, absent: MAC_ABSENT });
  const r = sb.run('install.sh');
  assert.equal(r.code, 0, r.out);
  const plist = fs.readFileSync(sb.plist, 'utf8');
  assert.ok(!LEFTOVER.test(plist), 'no placeholder left behind');
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.ok(plist.includes(`<string>${sb.repo}/web.mjs</string>`));
  const c = sb.calls();
  assert.match(c, /^plutil -lint /m, 'CONTROL: the plist was linted');
  assert.match(c, /^launchctl bootstrap gui\/\d+ .*com\.superelf\.web\.plist$/m);
  assert.ok(!/systemctl|loginctl/.test(c), 'no systemd on a Mac');
  assert.match(r.out, /\nDone\. superelf runs at boot from now on\.\n {2}\.\/start\.sh {4}start {8}\.\/stop\.sh {3}stop\n/);
  // stop.sh on the Mac still boots the launchd service out.
  assert.match(sb.run('stop.sh').out, /booted out/);
  assert.match(sb.calls(), /^launchctl bootout gui\/\d+\/com\.superelf\.web$/m);
  // start.sh, stop.sh and run.sh on the Mac never reach for systemd either — systemctl/loginctl are
  // RECORDING fakes here (MAC_ABSENT), so a call to one would leave a line in calls.log.
  assert.match(sb.run('start.sh').out, /bootstrapped/);
  assert.match(sb.run('run.sh', ['web']).out, /refusing: web\.mjs is owned by the com\.superelf\.web launchd/);
  sb.run('stop.sh');
  assert.equal(sb.calls().match(/^launchctl bootout /gm).length, 2, 'CONTROL: both stop.sh runs took the Mac path');
  assert.ok(!/^(systemctl|loginctl)/m.test(sb.calls()), `no systemd on a Mac:\n${sb.calls()}`);
  // CONTROL for that negative: the absent-fake really does record (and fails like a missing command).
  const probe = spawnSync(`${sb.bin}/systemctl`, ['--user', 'probe'], { env: sb.env });
  assert.equal(probe.status, 127);
  assert.match(sb.calls(), /^systemctl --user probe$/m);
});

for (const name of ['superelf', 'personal_agent']) {
  test(`process patterns follow the checkout's own name: "${name}"`, opt, () => {
    const mine = `/usr/bin/node /home/u/${name}/web.mjs`;
    const other = '/usr/bin/node /home/u/elsewhere/web.mjs';
    // A checkout whose name merely ENDS in this one ("supersuperelf") is another checkout too: only
    // the (^|[ /]) anchor in path_pattern keeps stop.sh from killing it.
    const suffix = `/usr/bin/node /home/u/super${name}/web.mjs`;
    const sb = sandbox({ name, fakes: LINUX_FAKES, ps: [mine, other, suffix] });
    assert.match(sb.run('start.sh').out, /web: up/, 'status sees the service-launched node');
    assert.match(sb.calls(), /^pgrep -f /m, 'CONTROL: the fake pgrep answered');
    sb.run('stop.sh');
    assert.ok(!sb.ps().includes(mine), 'stop.sh killed the stray from THIS checkout');
    assert.ok(sb.ps().includes(other), 'and left another checkout alone');
    assert.ok(sb.ps().includes(suffix), 'including one whose name ends in this one');
    // Bare manual runs are still caught, with or without ./ (a leftover bot: removed-telegram.test.mjs).
    const bare = sandbox({ name, fakes: LINUX_FAKES, ps: ['node ./web.mjs', 'node web.mjs'] });
    assert.match(bare.run('stop.sh').out, /strays: bare node web\/bot killed/);
    assert.equal(bare.ps().trim(), '');
  });
}

test('a regex metacharacter in the checkout name is escaped, not interpreted', opt, () => {
  const sb = sandbox({ name: 'super.elf', fakes: LINUX_FAKES, ps: ['/usr/bin/node /x/superXelf/web.mjs'] });
  assert.match(sb.run('start.sh').out, /web: down/, '"." must not match any character');
  const hit = sandbox({ name: 'super.elf', fakes: LINUX_FAKES, ps: ['/usr/bin/node /x/super.elf/web.mjs'] });
  assert.match(hit.run('start.sh').out, /web: up/, 'CONTROL: the literal name matches');
});

test('a path systemd would misread is escaped (%) or refused ($), never written broken', opt, () => {
  const pct = sandbox({ name: 'super%elf', fakes: LINUX_FAKES, state: ['userbus'] });
  assert.equal(pct.run('install.sh').code, 0);
  const unit = fs.readFileSync(pct.unitFile, 'utf8');
  assert.match(unit, /^WorkingDirectory=.*\/super%%elf$/m, '% is a systemd specifier: written as %%');
  const dollar = sandbox({ name: 'super$elf', fakes: LINUX_FAKES, state: ['userbus'] });
  const r = dollar.run('install.sh');
  assert.notEqual(r.code, 0, 'refused');
  assert.match(r.out, /cannot write a systemd unit for a path containing/);
  assert.match(dollar.calls(), /^uname -s$/m, 'CONTROL: it reached the Linux branch');
  assert.ok(!fs.existsSync(dollar.unitFile), 'and wrote nothing');
});
