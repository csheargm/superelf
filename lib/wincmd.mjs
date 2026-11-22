// Spawning an npm-installed CLI on Windows WITHOUT a shell · Windows 下免 shell 启动命令行工具
//
// THE PROBLEM. `claude` and `codex` install on Windows as .cmd shims, and Node cannot spawn a
// .cmd without a shell (it throws EINVAL — the CVE-2024-27980 hardening). So both call sites
// passed `shell: process.platform === 'win32'`. Under shell:true Node does NOT quote arguments:
// normalizeSpawnArguments joins [file, ...args] with a single space and hands the whole string to
// cmd.exe. Measured on this machine with /bin/sh, which joins identically:
//
//   spawn('node', ['-e', '…', 'a b', '<!--PA_CHAT_UI-->'], {shell:true})
//     → sh: syntax error near unexpected token `('        (nothing ran)
//   the same call with shell:false                        → ["a b","<!--PA_CHAT_UI-->"]
//
// runner.mjs pushed `--append-system-prompt <2000 chars, 29 lines, containing < > ">`, so on
// Windows every agent turn was shredded: split at each space, truncated at the first newline, and
// `<!--PA_CHAT_UI-->` read by cmd as a redirection.
//
// AND IT WAS AN INJECTION. That system prompt is user-writable: PUT /api/profile stores
// systemPrompts.global (web.mjs — cap() only truncates to 2000 chars, it filters nothing) and
// resolveSystemPrompts gives the profile override top precedence. On a Windows node any signed-in
// MEMBER could put `& whoami &` in Settings → Advanced and have cmd.exe run it as the server's
// account — defeating the confinement that strips --dangerously-skip-permissions for members.
// The bug is Windows-only; on macOS argv goes straight to execve.
//
// THE FIX. Resolve the shim to the real program and spawn it with shell:false, so Windows passes
// argv exactly the way macOS does. An .exe is spawned directly; a .cmd/.bat shim is read and the
// JS entrypoint it launches is run with our own node. Only if neither can be resolved do we fall
// back to a shell, and then the caller must refuse arguments cmd.exe cannot carry (see cmdSafe).
import fs from 'node:fs';
import path from 'node:path';

// npm's shim ends with something like:  "%_prog%"  "%dp0%\node_modules\…\cli.js" %*
const JS_IN_SHIM = /"([^"\r\n]*\.(?:js|mjs|cjs))"/i;

// A cmd.exe command line cannot carry a newline at all, and these characters stay special to it
// even inside double quotes in enough cases that quoting is not a defence worth trusting.
const CMD_UNSAFE = /[\r\n<>&|^%!"`]/;
export const cmdSafe = (s) => !CMD_UNSAFE.test(String(s));

// Walk PATH the way WINDOWS would, which is not the way POSIX does. Pure fs so a test can drive
// win32 behaviour from any platform.
//
// The empty extension is NOT tried by default, and that distinction cost a real install. `npm i -g`
// lays down THREE files: `claude` (a bash script, for Git Bash and WSL), `claude.cmd` and
// `claude.ps1`. Windows cannot execute the extensionless one at all — it is not on PATHEXT — but
// trying '' first found it, and spawning it gave:
//     spawn C:\Users\...\AppData\Roaming\npm\claude ENOENT
// on every single agent turn, while claude.cmd sat in the same directory. Windows resolves a bare
// command name only through PATHEXT, so this must too.
export function findOnPath(cmd, { pathEnv = '', pathext = '.COM;.EXE;.BAT;.CMD', sep = ';', allowBare = false } = {}) {
  if (path.isAbsolute(cmd) && fs.existsSync(cmd)) return cmd;
  const exts = [...(allowBare ? [''] : []), ...pathext.split(';').filter(Boolean)];
  // An explicit extension is honoured as written: `claude_cmd: "claude.cmd"` means that file.
  if (path.extname(cmd)) exts.unshift('');
  for (const dir of pathEnv.split(sep).filter(Boolean)) {
    for (const ext of exts) {
      const p = path.join(dir, cmd + ext);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* next candidate */ }
    }
  }
  return null;
}

// Read a .cmd/.bat shim and return the JS entrypoint it runs, resolved to an absolute path.
// %~dp0 / %dp0% both mean "the shim's own directory" and both appear in npm's generated shims.
export function jsFromShim(shimPath) {
  let text;
  try { text = fs.readFileSync(shimPath, 'utf8'); } catch { return null; }
  const m = JS_IN_SHIM.exec(text);
  if (!m) return null;
  const dir = path.dirname(shimPath);
  const raw = m[1].replace(/%~dp0\\?|%dp0%\\?/gi, dir + path.sep);
  // A shim always spells its path with backslashes. Normalising to the platform separator is what
  // makes this resolvable — and testable off Windows, which matters because the only machine
  // available to develop it on is a Mac.
  const norm = raw.replace(/[\\/]+/g, path.sep);
  const abs = path.isAbsolute(norm) ? norm : path.join(dir, norm);
  return fs.existsSync(abs) ? abs : null;
}

// Returns { file, args, shell, how } — spawn(file, [...args, ...yourArgs], { shell }).
// `how` is for diagnostics and tests: posix | exe | shim | unresolved.
export function spawnSpec(cmd, opts = {}) {
  const platform = opts.platform || process.platform;
  const node = opts.execPath || process.execPath;
  if (platform !== 'win32') return { file: cmd, args: [], shell: false, how: 'posix' };

  const env = opts.env || process.env;
  const found = opts.found !== undefined ? opts.found
    : findOnPath(cmd, { pathEnv: env.PATH || env.Path || '', pathext: env.PATHEXT || undefined });

  // An absolute path that is not there: a shell could only say "not recognized" on stderr and exit
  // 1, which the caller reads as the PROGRAM failing. Spawned directly, it fails to start (ENOENT)
  // the way it does on macOS, and the caller reports "Could not start" (lib/runner.mjs).
  // (path.win32: this branch is Windows', and its test drives it from a Mac. Checked on disk, not
  // through `found`: a test injects found:null to drive the shell fallback on a file that exists.)
  if (!found && path.win32.isAbsolute(cmd) && !fs.existsSync(cmd)) return { file: cmd, args: [], shell: false, how: 'absent' };
  if (found) {
    if (/\.(js|mjs|cjs)$/i.test(found)) return { file: node, args: [found], shell: false, how: 'shim' };
    if (/\.(cmd|bat)$/i.test(found)) {
      const js = opts.jsEntry !== undefined ? opts.jsEntry : jsFromShim(found);
      if (js) return { file: node, args: [js], shell: false, how: 'shim' };
    } else if (path.extname(found)) {
      return { file: found, args: [], shell: false, how: 'exe' };   // native .exe — spawn it directly
    }
    // Extensionless: a POSIX shell script npm ships beside the .cmd. Windows cannot run it, so
    // fall through to the unresolved path rather than handing spawn a guaranteed ENOENT.
  }
  // Could not resolve. Keep today's behaviour so the fast lanes still work, but flag it: the
  // caller MUST check cmdSafe on every argument before using this, or it is both broken and
  // exploitable. Failing loudly beats silently mangling the command line (R5).
  return { file: cmd, args: [], shell: true, how: 'unresolved' };
}
