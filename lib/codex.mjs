// Run GPT via the OpenAI Codex CLI, signed in with the user's ChatGPT subscription
// (no API billing). Codex is an AGENT, so this is an agent-lane alternative to Claude
// — slower than the fast chat models, but does text AND vision. Non-streaming: we ask
// Codex to write only its final message to a file (-o) and return that.
import { spawn } from 'node:child_process';
import { spawnSpec, cmdSafe } from './wincmd.mjs';
import { killChild } from './runner.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// The environment Codex runs with: an allow-list, never the node's whole process.env. Codex reviews
// untrusted diffs (the nightly review) and reads files; the node's own secrets (GitHub and mail tokens,
// API keys, CLAUDE_CODE_OAUTH_TOKEN) are not its business. Kept: what a CLI needs to run (PATH, HOME,
// locale, temp, proxy and CA settings, the Windows basics) and what Codex signs in with (CODEX_HOME's
// auth.json under HOME, or OPENAI_API_KEY / OPENAI_BASE_URL).
export const CODEX_ENV_KEYS = Object.freeze(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ',
  'TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'CODEX_HOME', 'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)']);
export const codexEnv = (env = process.env) => Object.fromEntries(CODEX_ENV_KEYS.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));

// resumeId: continue a prior Codex session for multi-turn memory. exec-level options
// go BEFORE the `resume` subcommand. Returns { ok, text, sessionId } — sessionId is
// parsed from Codex's stdout header so the caller can resume next turn.
export function runCodex({ codexCmd = 'codex', prompt, images = [], cwd, model, resumeId, timeoutMs = 300000 }) {
  return new Promise((resolve) => {
    const outFile = path.join(os.tmpdir(), 'codex-' + crypto.randomBytes(6).toString('hex') + '.txt');
    // read-only sandbox: it can read + reason + see images, but not modify files.
    const opts = ['exec', '--skip-git-repo-check', '--color', 'never', '--sandbox', 'read-only', '-o', outFile];
    if (model) opts.push('-m', model);
    for (const img of images) opts.push('-i', img);
    const args = resumeId ? [...opts, 'resume', resumeId] : opts;
    let child, out = '', err = '';
    // Resolve the .cmd shim and spawn WITHOUT a shell (lib/wincmd.mjs — ONE resolver, shared
    // with runner.mjs, R3). The comment here used to claim these args "are never interpolated
    // into a command string"; under shell:true that was false — Node joins argv unquoted, so an
    // image path or tmpdir under any folder with a space (C:\Program Files\...) was split at
    // that space, and every GPT turn failed with a file-not-found naming half a path.
    const spec = spawnSpec(codexCmd);
    if (spec.shell && args.some((a) => !cmdSafe(a))) {
      return resolve({ ok: false, text: `Cannot run "${codexCmd}" safely on Windows: it is not on PATH as an .exe or a readable .cmd shim, and an argument contains characters cmd.exe would reinterpret.` });
    }
    try { child = spawn(spec.file, [...spec.args, ...args], { cwd, shell: spec.shell, env: codexEnv() }); }
    catch (e) { return resolve({ ok: false, text: `Could not start codex: ${e.message}` }); }
    // killTree, not child.kill: on Windows a bare kill leaves the real codex process alive
    // holding our pipes, so 'close' never fires and the queue deadlocks — the scar runner.mjs
    // already carries. One definition, imported rather than re-spelled (R3).
    const timer = setTimeout(() => killChild(child), timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); }); // header carries the session id
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: `Could not run "${codexCmd}": ${e.message}. Is the Codex CLI installed and signed in (codex login)?` }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let text = ''; try { text = fs.readFileSync(outFile, 'utf8').trim(); } catch {}
      try { fs.unlinkSync(outFile); } catch {}
      const sessionId = ((out + '\n' + err).match(/session[ _]?id:\s*([0-9a-fA-F-]{36})/i) || [])[1] || resumeId || null;
      // code/signal: a caller that must not trust a crashed run's partial file checks them (lib/nightly-review/job.mjs).
      resolve(text ? { ok: true, text, sessionId, code, signal } : { ok: false, text: `Codex produced no output${err ? ' — ' + err.slice(-300).trim() : ''}`, sessionId, code, signal });
    });
    try { child.stdin.write(String(prompt || '')); child.stdin.end(); } catch {}
  });
}
