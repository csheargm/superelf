// Spawning an npm CLI on Windows without a shell · Windows 免 shell 启动
//
// Two spawn sites passed `shell: process.platform === 'win32'` so the `claude` / `codex` .cmd
// shims would resolve. Under shell:true Node joins argv with a single space and hands the string
// to the shell, unquoted — and runner.mjs pushes a 2000-char, 29-line --append-system-prompt whose
// content is USER-WRITABLE (PUT /api/profile systemPrompts.global only truncates, it filters
// nothing). So on a Windows node every agent turn was shredded AND any signed-in member could run
// commands as the server's account.
//
// These tests drive win32 behaviour from macOS through spawnSpec's injection points, because the
// only machine available is a Mac — a suite that silently skipped on darwin would prove nothing
// (test-harness fidelity). The first test uses a REAL spawn, so the premise itself is measured.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { spawnSpec, findOnPath, jsFromShim, cmdSafe } from '../lib/wincmd.mjs';
import { agentCapabilities, appContract } from '../lib/config.mjs';
import { needCaseInsensitiveFs } from './helpers-platform.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pa-wincmd-'));
const ECHO_ARGV = 'console.log(JSON.stringify(process.argv.slice(1)))';

test('THE PREMISE, measured: shell:true mangles argv, shell:false passes it verbatim', () => {
  // The whole fix rests on this. /bin/sh and cmd.exe differ in syntax but Node's argv JOIN is the
  // same code path on both (normalizeSpawnArguments), so measuring it here is measuring the bug.
  const args = ['-e', ECHO_ARGV, 'a b', '<!--PA_CHAT_UI-->'];
  const withShell = spawnSync('node', args, { shell: true, encoding: 'utf8' });
  const noShell = spawnSync('node', args, { shell: false, encoding: 'utf8' });

  assert.deepEqual(JSON.parse(noShell.stdout), ['a b', '<!--PA_CHAT_UI-->'], 'shell:false is verbatim');
  // CONTROL: if this ever starts matching, Node began quoting and the test above is vacuous.
  let shellArgv = null;
  try { shellArgv = JSON.parse(withShell.stdout); } catch { /* it did not even run — also a failure */ }
  assert.notDeepEqual(shellArgv, ['a b', '<!--PA_CHAT_UI-->'],
    'shell:true must NOT round-trip these args — if it does, re-derive the fix');
});

test('no spawn site still resolves a CLI with shell:true on win32', () => {
  // Enumerate, do not patch one site: three files had this pattern (runner, codex, the digest
  // tool). A grep-based invariant catches the fourth before it ships. The digest tool now runs
  // claude through runner.mjs runClaude (docs/adr/0008 item 4), so it is no longer a spawn site.
  const files = ['lib/runner.mjs', 'lib/codex.mjs'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/shell:\s*process\.platform\s*===\s*'win32'/.test(code),
      `${f} must go through spawnSpec, not shell:win32`);
    assert.ok(/spawnSpec\(/.test(code), `${f} must use the shared resolver`);
  }
});

test('posix is untouched: same command, no shell', () => {
  const s = spawnSpec('claude', { platform: 'darwin' });
  assert.deepEqual(s, { file: 'claude', args: [], shell: false, how: 'posix' });
});

test('win32 native .exe is spawned directly', () => {
  const s = spawnSpec('claude', { platform: 'win32', found: 'C:\\bin\\claude.exe' });
  assert.equal(s.file, 'C:\\bin\\claude.exe');
  assert.deepEqual(s.args, []);
  assert.equal(s.shell, false, 'no shell, so argv is verbatim');
  assert.equal(s.how, 'exe');
});

test('win32 .cmd shim resolves to node + the cli.js it launches', () => {
  const s = spawnSpec('claude', { platform: 'win32', found: 'C:\\npm\\claude.cmd',
    jsEntry: 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', execPath: 'C:\\node.exe' });
  assert.equal(s.file, 'C:\\node.exe');
  assert.deepEqual(s.args, ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js']);
  assert.equal(s.shell, false);
  assert.equal(s.how, 'shim');
});

test('an absolute .mjs claude_cmd runs under node on win32 — which is what the test fakes need', () => {
  // Several suites point claude_cmd at a fake .mjs with a #!/usr/bin/env node shebang. On macOS
  // the shebang and the exec bit carry it; Windows honours neither, so without this branch every
  // one of those suites would be unrunnable there. chmod 0o755 stays a harmless no-op.
  const s = spawnSpec('C:\\tmp\\fake.mjs', { platform: 'win32', execPath: 'C:\\node.exe',
    found: 'C:\\tmp\\fake.mjs' });
  assert.equal(s.file, 'C:\\node.exe');
  assert.deepEqual(s.args, ['C:\\tmp\\fake.mjs']);
  assert.equal(s.shell, false);
  assert.equal(s.how, 'shim');
});

test('an unresolvable shim falls back to a shell and SAYS SO, so the caller can refuse', () => {
  // Silent fallback would be the worst outcome: it works for fixed flags and corrupts (or
  // executes) free text. how:'unresolved' + shell:true is the signal runner.mjs checks.
  const s = spawnSpec('claude', { platform: 'win32', found: null });
  assert.equal(s.shell, true);
  assert.equal(s.how, 'unresolved');
});

// CI (windows-latest): a claude_cmd naming a file that is not there went through cmd.exe, which
// said "is not recognized" on stderr and exited 1 — read as the PROGRAM failing, not as a start
// failure. Spawned directly it is ENOENT, the macOS outcome, and runner.mjs says "Could not start".
test('an absolute path that does not exist is spawned directly, never through a shell', () => {
  const s = spawnSpec('C:\\tmp\\no-such-claude', { platform: 'win32', found: null });
  assert.deepEqual(s, { file: 'C:\\tmp\\no-such-claude', args: [], shell: false, how: 'absent' });
  const bare = spawnSpec('no-such-claude', { platform: 'win32', found: null });
  assert.equal(bare.how, 'unresolved', 'CONTROL: a bare name still falls back to the shell, which resolves PATHEXT');
});

test('cmdSafe rejects exactly what a cmd.exe command line cannot carry', () => {
  for (const bad of ['a\nb', 'a\rb', 'x<y', 'x>y', 'x&y', 'x|y', 'x^y', 'x%PATH%y', 'x!y', 'x"y', 'x`y']) {
    assert.equal(cmdSafe(bad), false, `must reject ${JSON.stringify(bad)}`);
  }
  // CONTROL: ordinary values, including a Windows path with a space (what broke codex), pass.
  for (const ok of ['C:\\Program Files\\superelf\\ws', '--append-system-prompt', 'a-uuid-1234', '/tmp/x.png']) {
    assert.equal(cmdSafe(ok), true, `must accept ${ok}`);
  }
});

test('the real system prompt is exactly what cmdSafe refuses', () => {
  // Not a synthetic string: build the prompt the server actually sends and assert it could never
  // have survived a cmd.exe command line. This is the finding, reproduced. The contract is built
  // the way web.mjs builds its APP_CONTRACT (a local there, not an export of lib/config.mjs), and
  // the role is one web.mjs's laneRole() really sends ('confined' | 'owner').
  const prompt = agentCapabilities('confined', appContract(ROOT));
  // Proof the contract is really in the prompt. A length check could not tell: without it the
  // prompt is still the language rule + confined note, ~800 chars. The marker is also a cmd.exe
  // redirection hazard on its own. Mutation: pass `undefined` as the contract and this fails.
  assert.ok(prompt.includes('<!--PA_CHAT_UI-->'), 'sanity: the app contract is in the prompt');
  assert.ok(prompt.includes('\n'), 'it is multi-line, which a cmd command line cannot carry at all');
  assert.equal(cmdSafe(prompt), false, 'so the guard must refuse it rather than mangle it');
});

test('findOnPath walks PATH with PATHEXT, like the OS would', { skip: needCaseInsensitiveFs }, () => {
  const dir = mk();
  try {
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\n');
    // Compared case-insensitively on purpose: PATHEXT is conventionally uppercase and both
    // Windows and macOS match a filename regardless of case, so the hit comes back as the
    // candidate that was tried (claude.CMD). That is fine - every consumer opens or spawns it,
    // and the .cmd/.bat test in spawnSpec is case-insensitive too.
    const hit = findOnPath('claude', { pathEnv: dir, pathext: '.EXE;.CMD' });
    assert.equal(String(hit).toLowerCase(), path.join(dir, 'claude.cmd').toLowerCase());
    assert.equal(findOnPath('nope', { pathEnv: dir, pathext: '.EXE;.CMD' }), null);
    // A directory named like the command must not count as finding it.
    fs.mkdirSync(path.join(dir, 'codex'));
    assert.equal(findOnPath('codex', { pathEnv: dir, pathext: '.EXE;.CMD' }), null, 'a directory is not the program');
  } finally { rmTemp(dir); }
});

test('jsFromShim reads npm\u2019s generated shim, including %~dp0', () => {
  const dir = mk();
  try {
    const nm = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'cli.js'), '// entry\n');
    const shim = path.join(dir, 'claude.cmd');
    fs.writeFileSync(shim, '@ECHO off\r\nSETLOCAL\r\n"%_prog%"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
    assert.equal(jsFromShim(shim), path.join(nm, 'cli.js'));

    // A shim whose target does not exist must NOT be returned — that would spawn node on a
    // missing file and report a confusing error instead of falling back.
    fs.writeFileSync(shim, '"%_prog%" "%~dp0\\node_modules\\gone\\cli.js" %*\r\n');
    assert.equal(jsFromShim(shim), null);
    fs.writeFileSync(shim, '@echo off\r\nrem nothing to find\r\n');
    assert.equal(jsFromShim(shim), null);
  } finally { rmTemp(dir); }
});

test('end to end on a fake Windows install: node + cli.js, verbatim argv', { skip: needCaseInsensitiveFs }, () => {
  // The closest a Mac gets to the real thing: a real shim on a real PATH, resolved by the real
  // code, then actually spawned with the resolved spec and a hostile argument.
  const dir = mk();
  try {
    const nm = path.join(dir, 'node_modules', 'claude-code');
    fs.mkdirSync(nm, { recursive: true });
    // slice(2), not slice(1): argv for a SCRIPT is [node, script, ...args], while `node -e`
    // (used above) has no script entry. Getting this wrong is what made the first run fail.
    fs.writeFileSync(path.join(nm, 'cli.js'), 'console.log(JSON.stringify(process.argv.slice(2)))\n');
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '"%_prog%" "%~dp0\\node_modules\\claude-code\\cli.js" %*\r\n');

    const spec = spawnSpec('claude', { platform: 'win32', execPath: process.execPath,
      env: { PATH: dir, PATHEXT: '.EXE;.CMD' } });
    assert.equal(spec.how, 'shim');
    assert.equal(spec.shell, false);

    const hostile = 'line one\nline two & whoami & <!--PA_CHAT_UI-->';
    const r = spawnSync(spec.file, [...spec.args, '--append-system-prompt', hostile], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(r.stdout), ['--append-system-prompt', hostile],
      'the whole prompt arrives as ONE argv entry, newlines and all');
  } finally { rmTemp(dir); }
});

test('THE npm LAYOUT: the extensionless bash script must never be chosen', { skip: needCaseInsensitiveFs }, () => {
  // `npm i -g` lays down THREE files side by side: `claude` (a POSIX shell script for Git Bash and
  // WSL), `claude.cmd` and `claude.ps1`. Windows cannot execute the extensionless one — it is not
  // on PATHEXT — and picking it produced, on a real machine, on EVERY agent turn:
  //     Could not start "claude": spawn C:\Users\...\AppData\Roaming\npm\claude ENOENT
  // while claude.cmd sat in the same directory. Windows resolves a bare command name through
  // PATHEXT only, so findOnPath must too.
  const dir = mk();
  try {
    const nm = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'cli.js'), 'console.log(JSON.stringify(process.argv.slice(2)))\n');
    fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\nexec node ...\n');        // the trap
    fs.writeFileSync(path.join(dir, 'claude.ps1'), '#!/usr/bin/env pwsh\n');
    fs.writeFileSync(path.join(dir, 'claude.cmd'),
      '"%_prog%" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');

    const hit = findOnPath('claude', { pathEnv: dir, pathext: '.COM;.EXE;.BAT;.CMD' });
    assert.match(String(hit).toLowerCase(), /claude\.cmd$/, 'the .cmd, never the bare script');

    const spec = spawnSpec('claude', { platform: 'win32', execPath: process.execPath,
      env: { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' } });
    assert.equal(spec.how, 'shim');
    assert.equal(spec.shell, false);
    assert.match(spec.args[0], /cli\.js$/, 'resolved through the shim to the real entrypoint');

    // And it actually runs, with argv intact — the whole point.
    const hostile = 'line one\nline two & whoami &';
    const r = spawnSync(spec.file, [...spec.args, '--append-system-prompt', hostile], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(r.stdout), ['--append-system-prompt', hostile]);
  } finally { rmTemp(dir); }
});

test('an extensionless hit is never mistaken for a native executable', () => {
  // Even if the bare file is the ONLY thing present, returning it as an .exe hands spawn a
  // guaranteed ENOENT. Better to report unresolved, which the caller already handles loudly.
  const s = spawnSpec('claude', { platform: 'win32', found: 'C:\\npm\\claude' });
  assert.equal(s.how, 'unresolved', 'not "exe"');
  assert.equal(s.shell, true, 'and the caller is told to guard its arguments');
});

test('an explicitly-configured extension is honoured as written', () => {
  // claude_cmd: "claude.cmd" must mean that file, not claude.cmd.cmd.
  const dir = mk();
  try {
    fs.writeFileSync(path.join(dir, 'claude.cmd'), '@echo off\n');
    assert.match(String(findOnPath('claude.cmd', { pathEnv: dir, pathext: '.COM;.EXE;.BAT;.CMD' })),
      /claude\.cmd$/);
  } finally { rmTemp(dir); }
});
