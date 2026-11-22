// The install surface · 安装面
//
// Everything here failed silently before, because nothing checked that the words and the files
// agreed: start.sh required a plist the repo never shipped, setup.mjs told Windows users to run a
// start.ps1 that did not exist, and config.example.json shipped one machine's absolute path plus
// a second user nobody asked for. A doc that names a file is a claim, and these are its tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const has = (f) => fs.existsSync(path.join(ROOT, f));

test('every file the scripts and docs tell someone to run actually exists', () => {
  // setup.mjs prints these as the next step; start.sh renders the plist from the template;
  // the README one-liners name the installers.
  for (const f of ['install.sh', 'install.ps1', 'start.sh', 'stop.sh', 'run.sh', 'deploy.sh',
    'start.ps1', 'stop.ps1', 'run.ps1', 'setup.mjs', 'resetpin.mjs', 'migrate.sh',
    'ops/checks.ps1', 'ops/com.superelf.web.plist.template', 'ops/superelf-web.service.template',
    'ops/service.sh', 'docs/vm-node.md', 'config.example.json']) {
    assert.ok(has(f), `${f} is referenced but missing`);
  }
});

test('setup.mjs names only launchers that exist', () => {
  // It used to print `.\start.ps1` when no such file was in the repo — the single instruction a
  // headless Windows node has, pointing at nothing.
  const src = read('setup.mjs');
  for (const m of src.matchAll(/'\s*(?:\.\\\\|\.\/)([\w.-]+\.(?:sh|ps1|mjs))/g)) {
    assert.ok(has(m[1]), `setup.mjs tells the user to run ${m[1]}, which does not exist`);
  }
});

test('no ops script points at a file that does not exist', () => {
  // start.ps1 described an ops/superelf-web-task.xml that was never written — the same class of
  // claim as start.sh's missing plist, caught here instead of by whoever went looking for it.
  for (const f of ['start.sh', 'stop.sh', 'run.sh', 'start.ps1', 'stop.ps1', 'run.ps1',
    'install.sh', 'install.ps1', 'deploy.sh']) {
    // The trailing [\w] matters: a prose reference ends in a full stop, and a greedy
    // [\w.-]+ swallows it, so the first version of this test reported the template missing.
    for (const m of read(f).matchAll(/\bops\/[\w.-]*\w/g)) {
      assert.ok(has(m[0]), `${f} references ${m[0]}, which does not exist`);
    }
  }
});

test('start.sh renders its launchd plist from a template that is committed', () => {
  const s = read('start.sh');
  assert.match(s, /com\.superelf\.web\.plist/, 'start.sh still depends on the plist');
  assert.ok(has('ops/com.superelf.web.plist.template'), 'so the template must ship');
  const tpl = read('ops/com.superelf.web.plist.template');
  for (const ph of ['__NODE__', '__ROOT__', '__PATH__', '__LOG__']) {
    assert.ok(tpl.includes(ph), `template needs ${ph}`);
  }
  // KeepAlive, not a crash-only restart: /api/admin/restart exits 0.
  assert.match(tpl, /<key>KeepAlive<\/key><true\/>/, 'restart-on-any-exit is the whole point');
  const inst = read('install.sh');
  for (const ph of ['__NODE__', '__ROOT__', '__PATH__', '__LOG__']) {
    assert.ok(inst.includes(ph), `install.sh must substitute ${ph}`);
  }
});

test('the Linux systemd unit is rendered from a committed template, restarting on ANY exit', () => {
  const tpl = read('ops/superelf-web.service.template');
  const inst = read('install.sh');
  for (const ph of ['__NODE__', '__ROOT__', '__PATH__']) {
    assert.ok(tpl.includes(ph), `template needs ${ph}`);
    assert.ok(inst.includes(ph), `install.sh must substitute ${ph}`);
  }
  // Restart=always, not on-failure: /api/admin/restart exits 0 (same reason as KeepAlive above).
  assert.match(tpl, /^Restart=always$/m, 'restart-on-any-exit is the whole point');
  assert.ok(!/^Restart=on-failure/m.test(tpl), 'never crash-only');
  assert.match(tpl, /^Environment="PATH=__PATH__"$/m, 'a user service has no login shell: PATH is explicit');
  assert.match(tpl, /^WantedBy=default\.target$/m, 'enabled into the user manager\'s boot target');
});

test('config.example.json carries no machine-specific paths and no phantom users', () => {
  const raw = read('config.example.json');
  const cfg = JSON.parse(raw);
  // It shipped a second project whose "dir" was an absolute path on the author's laptop: wrong
  // on anyone else's machine, and a detail about someone's disk that a fresh install should
  // never have carried in the first place.
  for (const [name, proj] of Object.entries(cfg.projects || {})) {
    assert.ok(!path.isAbsolute(proj.dir || ''), `project "${name}" must use a relative dir, got ${proj.dir}`);
  }
  assert.ok(!/\/Users\/|\/Applications\/|C:\\\\/.test(raw), 'no absolute path anywhere in the example');
  // It also shipped a second user "partner", which lib/users.mjs provisions on first load: a
  // workspace-partner/ nobody asked for, and an active member that scheduled jobs then ran for.
  assert.deepEqual(cfg.users, [], 'the owner is created by setup.mjs, not shipped in the example');
});

test('the example config has no real secrets, only placeholders', () => {
  const cfg = JSON.parse(read('config.example.json'));
  for (const k of ['public_base_url']) {
    assert.equal(cfg[k], '', `${k} must ship empty`);
  }
  // Removed with the daily brief and mail reading (2026-10-11, ADR 0004) and with the Telegram
  // bot (ADR 0006): a key nothing reads must not ship at all.
  for (const k of ['daily_brief_time', 'calendar_ics', 'gmail_user', 'gmail_app_password',
    'telegram_bot_token', 'allowed_user_ids', 'owner_chat_id', 'schedules', 'deep_args']) assert.ok(!(k in cfg), `${k} must not ship`);
});

test('npm test does not depend on the shell expanding a glob', () => {
  // cmd.exe (npm's script shell on Windows) never expands globs, so the bare `test/*.test.mjs`
  // reached node verbatim. Node expands it itself from v22 — which is why engines says 22.
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.test, /"test\/\*\.test\.mjs"/, 'the glob is quoted, so node expands it');
  assert.match(pkg.engines.node, />=\s*22/, 'and node must be new enough to do that');
});

test('both installers check the same Node floor the package declares', () => {
  // NEITHER installer hardcodes the number any more: both read engines.node at run time, so the
  // floor cannot drift from what the app actually requires (R3). Assert the source, not a literal.
  assert.match(read('install.sh'), /engines\.node/, 'install.sh reads the floor from package.json');
  assert.match(read('install.sh'), /-lt "\$FLOOR"/, 'and compares against it');
  // The Windows floor check lives in ops/checks.ps1, which the installer runs.
  assert.match(read('ops/checks.ps1'), /\$floor = \[int\]\$fm\.Groups\[1\]\.Value/, 'checks.ps1 reads the floor from package.json');
  assert.match(read('ops/checks.ps1'), /-lt \$floor/, 'and compares against it');
});

test('the Windows task runs the SUPERVISOR, never node and never a launcher that exits', () => {
  // Two things the action must not be, for two different reasons:
  //  - node directly: Task Scheduler restarts only on a NON-ZERO exit and /api/admin/restart exits
  //    0, so the in-app Restart button would be a permanent shutdown.
  //  - start.ps1: it Start-Process'd the supervisor and RETURNED, and Task Scheduler tears down a
  //    completed action's children — so the logon start killed the node it had just launched.
  //    This test previously asserted start.ps1 and was pinning that bug in place.
  const s = read('install.ps1');
  assert.match(s, /New-ScheduledTaskAction[\s\S]{0,300}run\.ps1/, 'the action runs run.ps1, which never returns');
  const act = s.slice(s.indexOf('New-ScheduledTaskAction'), s.indexOf('New-ScheduledTaskTrigger'));
  assert.ok(!/start\.ps1/.test(act), 'not start.ps1, which exits and takes the supervisor with it');
  assert.ok(!/-Execute\s+["']?node/.test(act), 'and never node directly');
  assert.match(s, /AtStartup/, 'an always-on box reboots for updates with nobody signed in');
  assert.match(s, /AtLogOn/, 'and still starts at logon');
  assert.match(s, /ExecutionTimeLimit/, 'Task Scheduler otherwise stops the task after 3 days');
});

test('BOTH installers install what is missing — one script, not a checklist', () => {
  // The README promises "one script does the whole install". That claim rots quietly if either
  // installer goes back to telling people to go away and come back, so pin it on both.
  const ps = read('install.ps1'), sh = read('install.sh');
  assert.match(ps, /Repair-Thing/, 'Windows: has a remediation path');
  assert.match(sh, /pkg_install/, 'macOS/Linux: has one too');
  for (const [name, src, rx] of [
    ['Windows Node', ps, /'node'/], ['Windows claude', ps, /'claude'/], ['Windows git', ps, /'git'/],
    ['posix Node', sh, /pkg_install "Node"/], ['posix claude', sh, /npm i -g @anthropic-ai\/claude-code/],
  ]) assert.match(src, rx, `${name} is installed, not merely reported`);
  // And neither may claim to do the one thing that cannot be automated.
  for (const [os, src] of [['install.ps1', ps], ['install.sh', sh]]) {
    assert.match(src, /sign in|sign-in/i, `${os} says sign-in is yours to do`);
  }
});

test('install.sh reads the Node floor from package.json, not a hardcoded number', () => {
  // Same source of truth as the Windows side (R3): a floor written out twice drifts.
  const sh = read('install.sh');
  assert.match(sh, /engines\.node/, 'the floor comes from package.json');
  // And it must not use the `node -p` form with embedded quotes that breaks on the Windows side —
  // the two installers deliberately share the habit so they cannot drift apart.
  assert.ok(!/node -v \| .*split\("/.test(sh), 'version read without embedded double quotes');
  assert.match(sh, /node -v \| sed/, 'reads node -v and parses it');
});

test('a node with no git still installs — git is for updates, not for running', () => {
  // A downloaded ZIP has no .git and no git binary. lib/vernotes.mjs and web.mjs's gitHead both
  // catch and carry on (vernotes names the "deployed tarball" case), so refusing to install would
  // block a perfectly workable node.
  const c = read('ops/checks.ps1');
  const gitFn = c.slice(c.indexOf('function Test-Git'), c.indexOf('function Test-LineEndings'));
  assert.ok(!/'FAIL' 'git'/.test(gitFn), 'a missing git must not be a FAIL');
  assert.match(gitFn, /'WARN' 'git'/, 'it is a WARN');
  assert.match(gitFn, /'git'$|'git'\s*$|'git'\n/m, 'and still offers to install it');
});

test('the installer FIXES what it can rather than only reporting it', () => {
  // The point of folding the checks in: a missing prerequisite should be installed, not turned
  // into homework. Only what genuinely needs a human is allowed to stop the install.
  const s = read('install.ps1');
  assert.match(s, /Repair-Thing/, 'there is a remediation path');
  for (const r of ['node', 'claude', 'git', 'standby-timeout-ac']) {
    assert.match(s, new RegExp(`'${r}'`), `it can fix: ${r}`);
  }
  // And it says plainly which three things it cannot do for you.
  assert.match(s, /sign-in|sign in/i, 'Claude sign-in is interactive');
  assert.match(s, /NoInstallDeps/, 'and you can opt out of all of it');
});

test('install.ps1 tells the user how to get past the default execution policy', () => {
  // Windows client defaults to Restricted, which refuses to run any .ps1 at all. An installer
  // that does not say this reads as "the download is broken".
  assert.match(read('install.ps1'), /ExecutionPolicy Bypass/, 'and it is in the header comment');
  assert.match(read('README.md'), /ExecutionPolicy Bypass/, 'the README one-liner carries it too');
});

test('README documents an install path for BOTH systems, and one that works for a private repo', () => {
  const r = read('README.md');
  assert.match(r, /install\.sh/, 'macOS/Linux installer named');
  assert.match(r, /install\.ps1/, 'Windows installer named');
  // The repo is private, so a curl|bash against raw.githubusercontent.com 404s without a token.
  // A clone is the honest instruction; if it ever goes public, that line can change.
  assert.ok(!/curl[^\n]*raw\.githubusercontent[^\n]*\|\s*(bash|sh)/.test(r),
    'no curl|bash one-liner: it cannot fetch a private repo, and would fail confusingly');
  assert.match(r, /git clone/, 'a clone the user is authenticated for');
  // gh is NOT a superelf dependency and is not on a stock Windows box. Telling someone to run it
  // to GET the repo is a dead end: the installer that could have installed gh is inside the repo.
  assert.ok(!/gh repo clone|gh auth login/.test(r), 'never instruct gh: it is absent on Windows and unused here');
  // Windows has no git either, so there must be a path that needs no command line at all.
  assert.match(r, /Download ZIP/, 'a zero-tool acquisition path for Windows');
});

test('README does not still tell people to hand-build a Task Scheduler entry', () => {
  const r = read('README.md');
  assert.ok(!/UNCHECK "stop after 3 days"/.test(r), 'that hand recipe is replaced by install.ps1');
  assert.ok(!/Node ≥ 20|Node 20\+/.test(r), 'the stated Node floor must match package.json engines');
});

test('the VM guide keeps its isolation promises, and the README sends Linux users to it', () => {
  // docs/vm-node.md is the ONLY thing standing between the agent and a family's Windows box, so the
  // load-bearing instructions are pinned: drift here is a silent hole, not a typo.
  const d = read('docs/vm-node.md');
  for (const must of [/No shared folders/, /Clipboard and drag-and-drop off/, /NAT networking, not bridged/,
    /No USB passthrough/, /UNTICKED/, /tag:superelf:443/, /--advertise-tags=tag:superelf/,
    /tailscale serve --bg --https=443 8787/, /Allow write\s+access" unticked/, /ONE active node/]) {
    assert.match(d, must, `vm-node.md still says ${must}`);
  }
  for (const range of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16']) {
    assert.ok(d.includes(`sudo ufw deny out to ${range}`), `outbound to ${range} is denied`);
  }
  // DNS by PORT, before the denies: Hyper-V's Default Switch picks a new subnet each Windows boot, so
  // a rule pinned to one resolver address went stale and blocked every lookup after a reboot.
  const dns = d.indexOf('sudo ufw allow out to any port 53');
  assert.ok(dns > -1 && dns < d.indexOf('sudo ufw deny out to 10.0.0.0/8'), 'DNS allowed by port, ahead of the denies');
  assert.ok(!/ufw allow out to <DNS>/.test(d), 'no DNS rule pinned to one address');
  // A running blank install writes its in-memory users over a migrated config.json: stop it first.
  assert.match(d, /`\.\/stop\.sh` FIRST/, 'the migration stops a running node before copying data in');
  // funnel is named only to forbid it — never as a command to run.
  assert.ok(!/^\s*(sudo )?tailscale funnel/m.test(d), 'never instruct tailscale funnel');
  assert.match(read('README.md'), /docs\/vm-node\.md/, 'the README links the guide');
});
