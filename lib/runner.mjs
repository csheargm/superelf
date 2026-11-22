import { spawn } from 'node:child_process';
import { sanitizeLine } from './webutil.mjs';
import { spawnSpec, cmdSafe } from './wincmd.mjs';
import { withoutNoThinking } from './one-shot.mjs';
import { claudeToken } from './claude-token.mjs';

// One short human-readable hint of what a tool call is doing — flattened and
// truncated by the ONE shared sanitizer (R3: lib/webutil.mjs sanitizeLine).
function toolBrief(input = {}) {
  const v = input.file_path || input.command || input.query || input.url || input.prompt || '';
  return sanitizeLine(v, 60);
}

// On win32 with shell:true the child is a cmd.exe wrapper; TerminateProcess on it
// leaves the real claude process running (and holding our pipes, so 'close' never
// fires and the queue deadlocks). taskkill /T /F kills the whole tree.
function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else child.kill('SIGTERM');
  } catch { /* already dead — nothing to do */ }
}

export function killChild(child) { killTree(child); }

// Parses Claude Code stream-json output (NDJSON). onDelta fires per text token
// (live streaming); onBlock fires when an assistant message completes.
export function createStreamParser({ onDelta, onBlock, onTool } = {}) {
  let buf = '';
  let final = null;
  let lastText = '';
  const feedLine = (line) => {
    const t = line.trim();
    if (!t.startsWith('{')) return;
    let j;
    try { j = JSON.parse(t); } catch { return; } // partial/garbled line: wait for more
    if (j.type === 'stream_event') {
      if (j.event?.type === 'content_block_delta' && j.event.delta?.type === 'text_delta') onDelta?.(j.event.delta.text);
    } else if (j.type === 'assistant' && j.message?.content) {
      for (const c of j.message.content) {
        if (c.type === 'tool_use') onTool?.(c.name, toolBrief(c.input));
      }
      const text = j.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
      if (text) { lastText = text; onBlock?.(text); }
    } else if (j.type === 'result') {
      final = {
        ok: j.is_error !== true,
        text: String(j.result ?? j.error ?? lastText ?? ''),
        sessionId: j.session_id || null,
        alreadyStreamed: String(j.result ?? '') === lastText,
      };
    }
  };
  return {
    feed(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { feedLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    },
    finish() { if (buf.trim()) feedLine(buf); return final; },
  };
}

// The cap on the WHOLE --append-system-prompt, set by what argv can carry rather than by a prompt
// budget. It used to be 2000, "the same cap the ollama lane applies". It never was the same: the
// ollama lane capped the app directive alone, while this cut the joined prompt, whose LAST part is
// ~4.4k chars of server-owned text (agentCapabilities). So no confined agent was ever told it was
// confined, and every lane lost most of the app contract (test/agent-prompt-argv.test.mjs).
// 20000 leaves ~12.7k of Windows' 32,767-char command line for quoting and every other flag (the
// rest of argv is under 300 chars: the flags, the resume id and the claude_cmd path), and is far
// inside Linux's 128 KiB per-argument limit at 3 bytes a char. The overridable pieces are capped at
// their source (OVERRIDABLE_PROMPT_MAX), so no member or app can reach it. Raised from 16000 on
// 2026-11-11: the app contract (superelf.md's Broker API section, read whole by appContract) grew
// past 12.5k with the drawer, note-page-image and summary-followup kinds, so the worst case
// (2 × OVERRIDABLE_PROMPT_MAX + the member capability text) reached 17.3k. The contract is
// server-owned text that must arrive whole; cutting it is the bug this cap exists to prevent.
export const APPEND_SYSTEM_PROMPT_MAX = 20000;

// The caller's skill/directive, appended to the CLI's own system prompt. Without this the agent
// lane silently ignored every app directive the fast lanes honour — the same question answered
// differently depending on the model chosen, with nothing to explain why.
function systemPromptArgs(systemPrompt) {
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) return [];
  const sp = systemPrompt.trim();
  // Unreachable by design, so a cut is never quiet: what it drops is the capability text at the end.
  if (sp.length > APPEND_SYSTEM_PROMPT_MAX) console.warn(`[runner] --append-system-prompt cut from ${sp.length} to ${APPEND_SYSTEM_PROMPT_MAX} chars; the end of the agent's capability text is lost`);
  return ['--append-system-prompt', sp.slice(0, APPEND_SYSTEM_PROMPT_MAX)];
}

// The argv to run through cmd.exe, or null when it cannot be carried safely (lib/wincmd.mjs: the
// shell fallback for a claude_cmd that resolves to no .exe and no readable .cmd shim). The default
// no-thinking --settings (lib/one-shot.mjs NO_THINKING_ARGS: fast_args, one_shot_args) is a JSON
// value cmd.exe would reinterpret, so it is DROPPED here — thinking stays on, said once — rather
// than refusing runs that worked before that default existed (the job resolver). Not a repo path
// to a settings file instead: Node joins a shell's argv unquoted, so a checkout under a path with a
// space would split it. Anything else cmd.exe cannot carry still refuses the run (R5).
let warnedThinkingOn = false;
function shellSafeArgs(args, claudeCmd) {
  const out = withoutNoThinking(args);
  if (out.length !== args.length && !warnedThinkingOn) {
    warnedThinkingOn = true;
    console.warn(`[runner] "${claudeCmd}" resolves to no .exe or readable .cmd shim, so it runs through cmd.exe, which cannot carry the --settings JSON that turns thinking off: those runs keep thinking on. Install Claude Code so "${claudeCmd}" resolves, or set claude_cmd to the full path of its cli.js.`);
  }
  return out.every((a) => cmdSafe(a)) ? out : null;
}

// Env every `claude` child gets, set LAST so nothing in the parent's env can undo it. Mechanism, not
// a tunable: no config key reads it (ADR 0002 amendment 2). The CLI keys its auto-memory store by the
// cwd's GIT ROOT, so every workspace in this checkout shares one store with the owner's own Claude Code
// sessions. A confined app lane could write it, and every later run loaded it, the owner's unrestricted
// lane included (measured on Claude Code 2.1.161). This variable stops the LOAD. It does not stop a
// Write or a Read of the store, and `autoMemoryEnabled:false` does not either. It is an env var, not a
// --settings, because the CLI reads only the first --settings on argv.
const CLAUDE_MECHANISM_ENV = Object.freeze({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
// Plus the long-lived token when the node's token file holds one (lib/claude-token.mjs, read at
// EVERY spawn so a renewed file needs no restart; web.mjs names the file from the live cfg).
export function claudeChildEnv() {
  return { ...process.env, ...CLAUDE_MECHANISM_ENV, ...claudeToken.env() };
}

// specOpts: a test hook — lib/wincmd.mjs spawnSpec's injection points (platform, found), so the
// Windows shell fallback is driven from any OS (test/runner-shell-fallback.test.mjs).
export function runClaude({ claudeCmd, extraArgs = [], cwd, prompt, systemPrompt, resumeId, timeoutMs, onDelta, onBlock, onTool, onChild, specOpts }) {
  return new Promise((resolve) => {
    // --verbose is required by the CLI when combining -p with stream-json output.
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', ...extraArgs];
    // Defense in depth: a resumeId reaches argv, so only a UUID-shaped value from the stored
    // conversation is ever accepted. Kept even though argv no longer passes through a shell —
    // the cheap check outlives whatever the spawn path becomes next.
    if (resumeId && /^[0-9a-fA-F-]{8,64}$/.test(resumeId)) args.push('--resume', resumeId);
    args.push(...systemPromptArgs(systemPrompt));
    // Windows: resolve the .cmd shim to the real program and spawn it WITHOUT a shell, so argv
    // arrives exactly as it does on macOS (lib/wincmd.mjs — ONE resolver, shared with codex.mjs).
    // The comment that used to sit here said "all args are fixed flags or a UUID"; that stopped
    // being true the day --append-system-prompt was added directly above, and under shell:true
    // Node joins argv unquoted — so a 29-line system prompt was shredded, and a member-writable
    // profile override became cmd.exe injection. Both are gone with shell:false.
    const spec = spawnSpec(claudeCmd, specOpts);
    // Unresolvable shim: the only remaining path is a shell, which cannot carry every argument.
    const argv = spec.shell ? shellSafeArgs(args, claudeCmd) : args;
    if (!argv) {
      return resolve({ ok: false, sessionId: null, text: `Cannot run "${claudeCmd}" safely on Windows: it is not on PATH as an .exe or a readable .cmd shim, and an argument contains characters cmd.exe would reinterpret. Install Claude Code so "${claudeCmd}" resolves, or set claude_cmd to the full path of its cli.js.` });
    }
    const child = spawn(spec.file, [...spec.args, ...argv], { cwd, shell: spec.shell, env: claudeChildEnv() });
    onChild?.(child);   // web.mjs cancelOnClose: a oneShot caller that leaves kills this child
    const t0 = Date.now();
    let tFirst = 0;
    const parser = createStreamParser({
      onDelta: (t) => { if (!tFirst) { tFirst = Date.now(); console.log(`[timing] first text after ${((tFirst - t0) / 1000).toFixed(1)}s`); } onDelta?.(t); },
      onBlock, onTool,
    });
    let err = '', raw = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    // Decoded by the stream, never per chunk: String(chunk) turned a multi-byte character split
    // across two pipe reads into U+FFFD, so a Chinese answer (the daily digest's) came back garbled.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { raw += d; parser.feed(d); });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, text: `Could not start "${claudeCmd}": ${e.message}. Is Claude Code installed and on PATH?`, sessionId: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        // timedOut: a caller with its own timeout (tools/fetch-daily-digest.mjs) words its own message.
        resolve({ ok: false, timedOut: true, text: `Task timed out after ${Math.round(timeoutMs / 60000)} min and was stopped. Try a narrower request, or raise task_timeout_minutes.`, sessionId: null });
        return;
      }
      const final = parser.finish();
      // An error result with no text (a dead --resume: the reason is on stderr only) takes stderr
      // as its text, so callers can see WHY (web.mjs retries "No conversation found" without resume).
      if (final && !final.ok && !final.text.trim() && err.trim()) final.text = err.trim();
      if (final) { resolve(final); return; }
      const fallback = (raw || err).trim();
      resolve({ ok: code === 0, text: fallback || `claude exited with code ${code}`, sessionId: null });
    });
    child.stdin.on('error', () => {}); // child may exit before stdin flushes; close handler reports it
    child.stdin.write(prompt);
    child.stdin.end();
  });
}
