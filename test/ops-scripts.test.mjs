// Ops-script ownership model（进程归属）— regression for the 6-agent scar:
// launchd (com.superelf.web, KeepAlive) OWNS web.mjs, yet stop.sh used a bare
// `pkill -f "node web.mjs"` (misses launchd's full-path invocation; what it
// killed, KeepAlive respawned) and start.sh spawned a run.sh supervisor that
// duelled launchd over the port (EADDRINUSE crash loop). The scripts are
// declarative infra, so the guard is textual: the invariants below failing
// means the ownership model regressed. Each script must also still parse.
// TODO(R4): over the 300-line budget. Split on the existing seams: everything from "The Windows
// side of the same ownership model" down moves to ops-windows.test.mjs, POSIX stays here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { needBash, needPwsh, PWSH } from './helpers-platform.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const has = (f) => fs.existsSync(path.join(ROOT, f));
const PS_SCRIPTS = ['start.ps1', 'stop.ps1', 'run.ps1', 'install.ps1', 'ops/checks.ps1'];
// Executable lines only — the scripts' own comments NAME the old broken
// patterns while explaining the scar, and must not trip the guards below.
const code1 = (f) => read(f).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('all POSIX ops scripts parse (bash -n)', { skip: needBash }, () => {
  for (const f of ['start.sh', 'stop.sh', 'run.sh', 'install.sh', 'deploy.sh', 'ops/service.sh']) {
    execFileSync('bash', ['-n', path.join(ROOT, f)]); // throws on syntax error
  }
});

test('all Windows ops scripts parse', { skip: needPwsh }, () => {
  // install.ps1 and preflight.ps1 are included here but NOT in the ownership-model test below:
  // they are one-shot scripts, not process owners.
  // The same guarantee for the .ps1 side. It runs wherever PowerShell exists — including macOS,
  // where PowerShell 7 installs from a plain tarball, which is how these were checked at all.
  for (const f of PS_SCRIPTS) {
    const out = execFileSync(PWSH, ['-NoProfile', '-Command',
      `$e=$null;[System.Management.Automation.Language.Parser]::ParseFile('${path.join(ROOT, f)}',[ref]$null,[ref]$e)|Out-Null;` +
      'if($e -and $e.Count){$e|%{Write-Output $_.Message};exit 1}'], { encoding: 'utf8' });
    assert.equal(out.trim(), '', `${f} must parse cleanly`);
  }
});

test('stop.sh: web stops via the service manager (bootout / systemctl stop), never a bare pkill', () => {
  const s = code1('stop.sh');
  assert.match(s, /launchctl bootout "\$DOMAIN\/\$WEB_SVC"/, 'launchd owns web — stop must unload the service');
  assert.match(s, /systemctl --user stop "\$WEB_UNIT"/, 'systemd owns web — stop the unit (Restart=always)');
  assert.ok(!/pkill -f "node (web|bot)\.mjs"/.test(s),
    'the old unanchored bare pattern is gone (missed full-path launchd invocations)');
  assert.match(s, /pkill -f "\$\(path_pattern 'web\|bot'\)"/, 'stray cleanup matches FULL-PATH invocations');
  assert.match(s, /pkill -f "\$\(bare_pattern 'web\|bot'\)"/, 'stray cleanup still matches anchored bare runs');
  assert.match(code1('ops/service.sh'), /\^node \(\\\\\.\/\)\?\(%s\)\\\\\.mjs\$/, 'the bare pattern is still ^node (\\./)?(…)\\.mjs$');
});

test('start.sh: web starts via launchctl bootstrap/kickstart or systemctl --user, never run.sh', () => {
  const s = code1('start.sh');
  assert.match(s, /launchctl bootstrap/, 'not-loaded service is bootstrapped from the plist');
  assert.match(s, /launchctl kickstart/, 'loaded service is kickstarted');
  assert.match(s, /systemctl --user start "\$WEB_UNIT"/, 'Linux: the systemd unit is started');
  // Lines that RUN something — the advice text may NAME ./run.sh web for a machine with no service.
  const runs = s.split('\n').filter((l) => !/\becho\b/.test(l)).join('\n');
  assert.ok(!/run\.sh web/.test(runs) && !/run\.sh "\$t"/.test(runs),
    'start.sh must never spawn a run.sh supervisor for web (the duelling-supervisor scar)');
});

test('run.sh: refuses to supervise web while the launchd service or the systemd unit owns it', () => {
  const s = code1('run.sh');
  assert.match(s, /launchctl print "gui\/\$\(id -u\)\/\$WEB_SVC"/, 'guard checks the owning launchd service');
  assert.match(s, /systemd_owns_web/, 'and the owning systemd unit');
  assert.match(s, /refusing[^\n]*launchd/, 'refusal is loud, not silent');
  assert.match(s, /refusing[^\n]*systemd/, 'on both systems');
});

test('both scripts document the ownership model at the top', () => {
  for (const f of ['start.sh', 'stop.sh']) {
    const head = read(f).split('\n').slice(0, 12).join('\n');
    assert.match(head, /Ownership model（进程归属）/, `${f} names the model (bilingual)`);
    assert.match(head, /launchd/i, `${f} states who owns web.mjs`);
    assert.match(head, /systemd/i, `${f} names the Linux owner too`);
  }
});

// ── The Windows side of the same ownership model（进程归属）────────────────────
// macOS and Windows reach the SAME guarantee by different mechanisms, and the difference is
// load-bearing: launchd KeepAlive restarts web.mjs on ANY exit, and POST /api/admin/restart
// exits 0, so the Windows supervisor must also restart on a clean exit. Task Scheduler's
// "restart on failure" fires only on a NON-ZERO exit, which is why it supervises start.ps1
// rather than node directly — get this wrong and the in-app Restart button is a permanent
// shutdown on the always-on box.

test('run.ps1: supervises on ANY exit, and refuses to duel a second supervisor', () => {
  const s = read('run.ps1');
  assert.match(s, /while \(\$true\)/, 'it is a restart loop, not a one-shot');
  assert.match(s, /refusing/, 'a duplicate supervisor is refused loudly, like run.sh');
  assert.match(s, /restart on failure|NON-ZERO|exits with code 0/i,
    'it records WHY a crash-only supervisor is wrong here');
});

test('start.ps1: web gets a run.ps1 supervisor and is never launched bare', () => {
  const s = code1('start.ps1');
  assert.match(s, /run\.ps1/, 'web is started through the supervisor');
  assert.ok(!/Start-Process\s+.*node.*web\.mjs/.test(s),
    'start.ps1 must never launch node web.mjs directly — nothing would restart it');
});

test('stop.ps1: supervisors die BEFORE the node processes they would restart', () => {
  const s = code1('stop.ps1');
  const sup = s.indexOf('run\\.ps1');
  const node = s.indexOf('-match $nodeRe');
  assert.ok(sup > -1 && node > -1, 'both targets are addressed');
  assert.ok(sup < node, 'kill supervisors first, or they respawn what stop just killed');
  assert.match(s, /taskkill/, 'taskkill /T kills the tree: node spawns claude, which spawns more');
});

test('every Windows ops script documents the ownership model at the top', () => {
  for (const f of ['start.ps1', 'stop.ps1', 'run.ps1']) {
    const head = read(f).split('\n').slice(0, 14).join('\n');
    assert.match(head, /[\u4e00-\u9fff]/, `${f} names it bilingually`);
    assert.match(head, /supervisor|launchd|KeepAlive/i, `${f} states who owns the process`);
  }
});

// ── The machine checks（机器自检）──────────────────────────────────────────────
// They live in ops/checks.ps1 and are run BY the installer: `install.ps1 -CheckOnly` is the
// read-only mode, so there is one definition of "is this machine ready" instead of a separate
// preflight script that could drift from what the installer actually enforces (R3).

// Strip comments AND string literals: the checks deliberately NAME remedies like `winget install`
// in their Fix text, and a naive grep reads that as the file doing it.
const bare = (f) => read(f)
  .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
  .replace(/@'[\s\S]*?'@/g, "''").replace(/@"[\s\S]*?"@/g, '""')
  .replace(/'[^'\n]*'/g, "''").replace(/"[^"\n]*"/g, '""');

test('ops/checks.ps1 only LOOKS — every mutation lives in the installer', () => {
  // install.ps1 -CheckOnly promises to change nothing, and it keeps that promise by running only
  // these. If a check ever installs or writes, that promise breaks silently.
  const s = bare('ops/checks.ps1');
  for (const bad of ['Set-ItemProperty', 'New-Item', 'Remove-Item', 'Out-File', 'Set-Content',
    'Add-Content', 'Register-ScheduledTask', 'Start-Process', 'Set-ExecutionPolicy', 'Copy-Item',
    'powercfg /change', 'winget install', 'Repair-Thing']) {
    assert.ok(!s.includes(bad), `ops/checks.ps1 must not ${bad}`);
  }
  // CONTROL: it does still READ what it reports on, so the above is not passing on an empty file.
  const raw = read('ops/checks.ps1');
  assert.match(raw, /'powercfg'/, 'reads the power scheme');
  assert.match(raw, /'\/query'/, 'by querying, never /change');
  assert.match(raw, /Get-NetTCPConnection/, 'and the listening ports');
  assert.match(raw, /excludedportrange/, 'and the reserved ranges, which look free but are not');
});

test('-CheckOnly returns before anything that changes the machine', () => {
  // Executable lines only: the remedies NAME .\start.ps1 in their advice text, and a raw indexOf
  // finds that comment long before the real call and reports a gate that is actually fine.
  const s = read('install.ps1').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const checkOnlyExit = s.indexOf('if ($CheckOnly)');
  assert.ok(checkOnlyExit > 0, 'there is a -CheckOnly early exit');
  for (const m of ['Copy-Item', 'Register-ScheduledTask', 'setup.mjs', 'start.ps1']) {
    assert.ok(s.indexOf(m) > checkOnlyExit, `${m} must be gated behind the -CheckOnly exit`);
  }
  // And remediation is skipped under -CheckOnly.
  assert.match(s, /-not \$CheckOnly[^\n]*-not \$NoInstallDeps/, 'repairs are skipped in check-only mode');
});

test('the installer trusts the RE-CHECK, not its own repair exit codes', () => {
  // "winget said 0" is not the same as "node is now on PATH". The only honest signal that a
  // machine is ready is running the checks again.
  const s = read('install.ps1');
  const repair = s.indexOf('Fixing what I can');
  const recheck = s.indexOf('Invoke-AllChecks', repair);
  const gate = s.indexOf('$fails = @($results');
  assert.ok(repair > 0 && recheck > repair, 'it re-runs every check after repairing');
  assert.ok(gate > recheck, 'and the go/no-go gate reads the RE-CHECKED results');
  assert.match(s, /Update-PathFromRegistry/, 'after winget, this process needs the new PATH');
});

test('the checks never report UNKNOWN as a pass', () => {
  const s = read('install.ps1');
  assert.match(s, /State -eq 'UNKNOWN'/, 'UNKNOWN is counted on its own');
  assert.match(s, /UNKNOWN is not a pass/, 'and the check-only line says so');
  assert.ok(!/UNKNOWN[^\n]*-eq 'PASS'|'PASS'[^\n]*UNKNOWN/.test(s), 'never merged with PASS');
});

test('the CLI is resolved through the SHIPPED resolver, not a lookalike', () => {
  const s = read('ops/checks.ps1');
  assert.match(s, /wincmd\.mjs/, 'loads the real resolver');
  assert.match(s, /spawnSpec\(/, 'and calls its real entry point');
  assert.match(s, /pathToFileURL/, 'by file URL: a bare C:\\ path is rejected as protocol c:');
  assert.match(s, /claude_cmd/, 'and asks about the command the app actually spawns');
  assert.ok(!/PATHEXT/.test(s), 'and does not re-derive resolution itself');
});

test('preflight.ps1 is gone, not left beside its replacement', () => {
  // R1/R7: two ways to check one machine is how they drift apart.
  assert.ok(!has('preflight.ps1'), 'folded into install.ps1 -CheckOnly');
  assert.ok(!/preflight\.ps1/.test(read('README.md')), 'and the README no longer sends anyone to it');
});

// ── .NET Framework vs .NET Core（5.1 与 7 的运行时差异）──────────────────────
// The first real Windows run died on `$psi.ArgumentList.Add(...)` before a single check finished.
// ProcessStartInfo.ArgumentList arrived in .NET Core 2.1; Windows PowerShell 5.1 runs on .NET
// FRAMEWORK, where the property does not exist, so it was $null. pwsh 7 on macOS — the only
// engine this repo can run — is .NET Core and has it, so it worked here and could never have
// worked there. A parse check cannot see this class of bug; only these can.

test('Invoke-Native does not assume a .NET Core-only API', () => {
  const s = read('ops/checks.ps1');
  assert.match(s, /Get-Member -Name ArgumentList/, 'it probes for ArgumentList rather than assuming it');
  assert.match(s, /\$psi\.Arguments = ConvertTo-NativeArgString/, 'and has a .NET Framework fallback');
  assert.match(s, /function ConvertTo-NativeArg\b/, 'with real CommandLineToArgvW quoting, not naive joining');
  // The fallback must be reachable for testing, or it ships unexercised — which is how the
  // original bug survived.
  assert.match(s, /PA_FORCE_ARG_STRING/, 'the 5.1 path can be forced on a modern engine to test it');
});

test('every check is isolated — one that throws cannot kill the run', () => {
  // What made the Windows failure unactionable was not the bug, it was losing the whole report to
  // a bare RuntimeException that named neither the check nor the line.
  const s = read('ops/checks.ps1');
  const all = s.slice(s.indexOf('function Invoke-AllChecks'));
  assert.match(all, /try \{[^}]*&\s*\$c\.f/, 'each check runs inside a try');
  assert.match(all, /catch \{[^}]*'UNKNOWN' \$c\.n/, 'and a throw becomes an UNKNOWN naming that check');
  assert.match(all, /the check itself failed/, 'carrying the real message, not swallowing it (R5)');
  // CONTROL: the list is real, so the assertions above are not passing on an empty loop.
  for (const n of ['Node', 'Claude Code', 'git', 'Port', 'Existing install']) {
    assert.ok(all.includes(`'${n}'`), `${n} is among the isolated checks`);
  }
});

// ── The Scheduled Task must BE the long-lived process ─────────────────────────
// Found on a real Windows box: the task ran start.ps1, which Start-Process'd run.ps1 and exited.
// Task Scheduler treats the action exiting as the task completing and tears down its remaining
// children — so the supervisor it had just spawned was killed with it. The node printed its
// listen line and was gone seconds later, with no "[supervisor] exited" line to explain it,
// because the supervisor died too. That broke the LOGON autostart exactly as badly as the manual
// start, and the installer reported success either way.

test('the scheduled task runs the supervisor itself, never a launcher that exits', () => {
  const s = read('install.ps1');
  const act = s.slice(s.indexOf('New-ScheduledTaskAction'), s.indexOf('New-ScheduledTaskTrigger'));
  assert.match(act, /run\.ps1/, 'the action runs run.ps1, which never returns');
  assert.ok(!/start\.ps1/.test(act), 'NOT start.ps1, which exits and takes the supervisor with it');
});

test('start.ps1 prefers the task, so the OS owns the detachment', () => {
  const s = read('start.ps1');
  const fn = s.slice(s.indexOf('function Start-Supervisor'), s.indexOf('if (-not (Test-Path'));
  assert.match(fn, /Start-ScheduledTask/, 'it starts the task when one exists');
  const taskAt = fn.indexOf('Start-ScheduledTask'), procAt = fn.indexOf('Start-Process');
  assert.ok(taskAt > 0 && procAt > taskAt, 'Start-Process is only the FALLBACK, after the task');
  // No recursion: the task runs run.ps1, so start.ps1 starting the task cannot re-enter itself.
  const inst = read('install.ps1');
  const act = inst.slice(inst.indexOf('New-ScheduledTaskAction'), inst.indexOf('New-ScheduledTaskTrigger'));
  assert.ok(!/start\.ps1/.test(act), 'and the task does not run start.ps1, so there is no loop');
});

test('stop.ps1 stops the TASKS before the processes they would restart', () => {
  const s = read('stop.ps1');
  const task = s.indexOf('Stop-ScheduledTask');
  // The first CALL, not `function Stop-Procs` — the definition is necessarily near the top and
  // comparing against it made this assertion meaningless.
  const kill = s.search(/^Stop-Procs /m);
  assert.ok(task > 0, 'it stops the scheduled tasks');
  assert.ok(kill > 0, 'and it does kill processes');
  assert.ok(task < kill, 'tasks first, or Task Scheduler restarts what stop just killed');
});

test('start.ps1 calls it up only when the PORT is serving', () => {
  // "a node.exe exists" is not "it is serving": run.ps1 restarts on every exit, so a crash loop
  // shows a process the whole time. The port is the only honest signal.
  const s = read('start.ps1');
  assert.match(s, /Test-Listening/, 'there is a real listening probe');
  assert.match(s, /web = 'up'/, 'and up is set from it');
  assert.match(s, /web\.log/, 'and a down result dumps the log instead of sending you hunting');
});

// ── A child's stderr must never kill the supervisor ───────────────────────────
// The first Windows node died on this. web.mjs shells out to git; in a tree with no .git — anyone
// who installed from a downloaded ZIP — git printed "fatal: not a git repository" on STDERR.
// Windows PowerShell 5.1 promotes native stderr to a NativeCommandError, and run.ps1 had
// ErrorActionPreference='Stop', so the supervisor terminated and took node with it. The server
// bound its port, logged the URL, and vanished — with nothing in the log to explain it, because
// the supervisor that would have written the explanation was the thing that died.
//
// NOTE ON VERIFICATION: PowerShell 7 does NOT convert native stderr to error records, so this
// cannot be reproduced on the engine this repo can run. These pin the guards; the evidence that
// it was real is the user's own NativeCommandError at run.ps1's `& node $script *>> $log`.

test('run.ps1 cannot be killed by anything its child writes or raises', () => {
  const s = read('run.ps1');
  const loop = s.slice(s.indexOf('while ($true)'));
  assert.match(loop, /try \{[\s\S]*?& node \$script/, 'the child runs inside a try');
  assert.match(loop, /catch \{[\s\S]*?raised:/, 'and a terminating error is logged, not fatal (R5)');
  // And the setting that covers the reported 5.1 case specifically.
  const pref = s.slice(0, s.indexOf('while ($true)'));
  assert.match(pref, /\$ErrorActionPreference = 'Continue'/, "stderr from a child is normal, not fatal");
  assert.ok(pref.lastIndexOf("'Continue'") > pref.lastIndexOf("'Stop'"), 'Continue is set AFTER the Stop default');
});

test('git is never allowed to print to a stderr the supervisor can see', () => {
  // execSync PIPES stdout but INHERITS stderr by default — that default is what leaked the git
  // fatal into PowerShell's lap. Every git call site must silence it explicitly.
  const web = read('web.mjs'), vn = read('lib/vernotes.mjs');
  assert.match(web, /GIT_QUIET = \{ stdio: \['ignore', 'pipe', 'ignore'\] \}/, 'web.mjs has one quiet spec');
  for (const m of web.matchAll(/exec(?:File)?Sync\('git'|execSync\('git/g)) {
    const tail = web.slice(m.index, m.index + 400);
    assert.ok(/GIT_QUIET|stdio: \['ignore', 'pipe', 'pipe'\]/.test(tail),
      `a git call at ${m.index} does not silence stderr`);
  }
  assert.match(vn, /stdio: \['ignore', 'pipe', 'ignore'\]/, 'vernotes silences it too');
});

test('sign-in is PROVEN, not assumed — it is the one prerequisite that silently breaks everything', () => {
  // `npm i -g` gives you a binary with no account. Until someone signs in, the node starts
  // perfectly and fails every single request — the worst failure shape there is, because nothing
  // looks wrong. This check used to report UNKNOWN because sign-in is interactive; but the STATE
  // is only interactive to CREATE, not to observe: `claude -p` answers headlessly when signed in.
  const s = read('ops/checks.ps1');
  const fn = s.slice(s.indexOf('function Test-ClaudeSignIn'), s.indexOf('function Test-Git'));
  assert.match(fn, /'-p'/, 'it actually asks the CLI to answer');
  assert.match(fn, /-TimeoutMs/, 'with a deadline, so a hung CLI cannot hang the installer');
  assert.match(fn, /'PASS' 'Claude sign-in'/, 'a real answer is a PASS');
  assert.match(fn, /'FAIL' 'Claude sign-in'/, 'and an auth error is a FAIL, not an UNKNOWN');
  assert.match(fn, /login\|log in\|sign \?in\|authenticat/, 'recognising what "not signed in" looks like');
  assert.match(fn, /spawnSpec/, 'through the shipped resolver, not a bare `claude`');
});

test('Invoke-Native reads asynchronously, or its timeout is decorative', () => {
  // ReadToEnd BLOCKS until the stream closes. Called before WaitForExit, a hung child would hang
  // the installer forever and the timeout would never be reached.
  // Executable lines only. The comment above this code EXPLAINS the hazard by naming WaitForExit,
  // and the first version of this assertion compared against that comment rather than the call —
  // the third time in this file a text assertion has matched its own documentation.
  const s = bare('ops/checks.ps1');
  const fn = s.slice(s.indexOf('function Invoke-Native'), s.indexOf('function Update-PathFromRegistry'));
  assert.match(fn, /ReadToEndAsync/, 'async reads');
  assert.ok(fn.indexOf('ReadToEndAsync') < fn.indexOf('WaitForExit'), 'started BEFORE the wait');
  assert.match(fn, /\$p\.Kill\(\)/, 'and a timed-out child is killed');
});
