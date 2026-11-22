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
    try { child = spawn(spec.file, [...spec.args, ...args], { cwd, shell: spec.shell, env: process.env }); }
    catch (e) { return resolve({ ok: false, text: `Could not start codex: ${e.message}` }); }
    // killTree, not child.kill: on Windows a bare kill leaves the real codex process alive
    // holding our pipes, so 'close' never fires and the queue deadlocks — the scar runner.mjs
    // already carries. One definition, imported rather than re-spelled (R3).
    const timer = setTimeout(() => killChild(child), timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); }); // header carries the session id
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, text: `Could not run "${codexCmd}": ${e.message}. Is the Codex CLI installed and signed in (codex login)?` }); });
    child.on('close', () => {
      clearTimeout(timer);
      let text = ''; try { text = fs.readFileSync(outFile, 'utf8').trim(); } catch {}
      try { fs.unlinkSync(outFile); } catch {}
      const sessionId = ((out + '\n' + err).match(/session[ _]?id:\s*([0-9a-fA-F-]{36})/i) || [])[1] || resumeId || null;
      resolve(text ? { ok: true, text, sessionId } : { ok: false, text: `Codex produced no output${err ? ' — ' + err.slice(-300).trim() : ''}`, sessionId });
    });
    try { child.stdin.write(String(prompt || '')); child.stdin.end(); } catch {}
  });
}
