// What this machine can actually run · 本机能跑什么
//
// A few tests need a POSIX tool or POSIX file permissions. On Windows they do not fail because
// the code is wrong — they fail because `bash` is not on PATH after a default Git for Windows
// install, or because chmod is a no-op. Guarding them here, in ONE place (R3), keeps `npm test`
// meaningful on a fresh Windows clone.
//
// These produce SKIPS, never silent passes: node --test reports "# skipped N" separately from
// "# pass N", so a suite that could not check something says so rather than claiming a clean run
// (R14 — an empty result is not a pass).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { rmTemp } from './helpers-tmp.mjs';

const have = (cmd, args) => {
  try { execFileSync(cmd, args, { stdio: 'ignore' }); return true; } catch { return false; }
};

export const HAS_BASH = have('bash', ['-c', 'exit 0']);
export const HAS_PWSH = have('pwsh', ['-NoProfile', '-Command', 'exit 0'])
  || have('powershell', ['-NoProfile', '-Command', 'exit 0']);
export const PWSH = have('pwsh', ['-NoProfile', '-Command', 'exit 0']) ? 'pwsh' : 'powershell';
// chmod has no effect on Windows: a directory made read-only still accepts writes from its owner,
// so a test that revokes permission to force a failure would assert against a write that succeeded.
export const HAS_POSIX_PERMS = process.platform !== 'win32';

// CI means exactly CI=true, the variable GitHub Actions sets (pinned by test/identity-leak.test.mjs).
export const IN_CI = process.env.CI === 'true';
// A wall-clock budget a test pins (simplify() "in well under 200 ms") is measured on this machine.
// A shared 2-core runner took 240–780 ms for what the Mac does in 70 (CI run 42978822886), so in
// CI the budget is multiplied, not dropped: a 5 s freeze still fails there, a slow runner does not.
export const CI_TIMING_FACTOR = IN_CI ? 5 : 1;
export const SIMPLIFY_BOUND_BASE_MS = 200;   // "well under 200 ms" on the Mac; also the floor a MUTANT must exceed (slower runners only raise it)
export const SIMPLIFY_BOUND_MS = SIMPLIFY_BOUND_BASE_MS * CI_TIMING_FACTOR;   // the one bound for stationery-simplify-budget / -share (R3)

export const needBash = !HAS_BASH && 'bash is not on PATH (default Git for Windows install)';
export const needPwsh = !HAS_PWSH && 'no PowerShell on PATH';
export const needPerms = !HAS_POSIX_PERMS && 'chmod is a no-op on Windows';

// The macOS/Linux ops scripts (install.sh, start/stop/run.sh, deploy.sh) driven in the ops sandbox:
// a PATH made of symlinks to POSIX tools plus recording fakes. A Windows node runs the .ps1 scripts
// instead, and Git Bash on Windows (present on CI runners) resolves tools to MSYS paths that a
// Windows symlink cannot point at. Windows is not a platform these scripts serve.
export const needPosixOps = needBash
  || (process.platform === 'win32' && 'the macOS/Linux ops scripts do not run on Windows (it has the .ps1 scripts)');

// flock(1) is util-linux: on every systemd distro deploy.sh runs on, absent on macOS. Its refusal
// path is tested everywhere against a fake; only the REAL tool's fd semantics need the real one.
export const needFlock = !have('flock', ['--version']) && 'no flock(1) on this machine (util-linux; macOS has none)';

// Windows has no POSIX signals: child.kill('SIGTERM') terminates the process outright, so a
// graceful SIGTERM handler (what launchd bootout and systemctl stop rely on) can never run there.
export const needPosixSignals = process.platform === 'win32'
  && 'Windows has no POSIX signals: kill(SIGTERM) terminates outright, no handler runs';

// Windows (and macOS by default) match file names case-insensitively; most Linux filesystems do
// not. A test that simulates Windows name resolution on THIS disk needs the Windows behaviour, so
// it is PROBED here, not assumed from process.platform: a case-sensitive APFS volume exists too.
const caseInsensitiveFs = () => {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-case-'));
    fs.writeFileSync(path.join(dir, 'probe.cmd'), '');
    return fs.existsSync(path.join(dir, 'PROBE.CMD'));
  } catch { return false; }   // cannot tell: treated as case-sensitive, so the test SKIPS (never passes)
  finally { if (dir) rmTemp(dir); }
};
export const needCaseInsensitiveFs = !caseInsensitiveFs()
  && 'this filesystem is case-sensitive; Windows name resolution (claude.cmd found via .CMD) cannot be simulated on it';

// A fake npm CLI that this OS can really launch · 本机真能启动的假命令行工具
//
// The agent-lane tests fake `claude` / `codex` with a node script. On POSIX an extensionless file
// with a shebang and the exec bit is a program. Windows honours neither, and lib/wincmd.mjs
// (correctly) refuses an extensionless file: it runs an .exe directly, or reads a .cmd/.bat shim
// for the JS entry it launches and runs that with node, shell:false. So on win32 the fake is laid
// out EXACTLY the way `npm i -g` lays out the real CLI — a JS entry plus the .cmd shim npm's
// cmd-shim writes — and the server goes through the same findOnPath → jsFromShim path a real
// Windows node takes, instead of a test-only shortcut.
//
// writeFakeCli(dir, name, source) → the command to configure (claude_cmd): the extensionless
// script on POSIX, the .cmd shim on win32. Either way `name` on PATH resolves to it too, which is
// how web.mjs finds `codex`. The JS source runs unchanged on both, so what it records (argv,
// stdin) is the same evidence on every OS.
const NPM_CMD_SHIM = (entry) => [
  '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
  'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entry}" %*`, '',
].join('\r\n');

export function writeFakeCli(dir, name, source, { platform = process.platform } = {}) {
  if (platform !== 'win32') {
    const bin = path.join(dir, name);
    fs.writeFileSync(bin, source);
    fs.chmodSync(bin, 0o755);
    return bin;
  }
  fs.writeFileSync(path.join(dir, `${name}.mjs`), source);
  const shim = path.join(dir, `${name}.cmd`);
  fs.writeFileSync(shim, NPM_CMD_SHIM(`${name}.mjs`));
  return shim;
}
