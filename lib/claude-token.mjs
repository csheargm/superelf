// Long-lived Claude token（长期令牌）— read from a FILE at every spawn, never cached, never logged.
//
// SCAR (2026-11-10): the Mac node's Keychain sign-in expired ("Failed to authenticate. API Error:
// 401 OAuth access token has been revoked") and every Claude turn failed until someone sat at the
// Mac and ran `claude auth login`. `claude setup-token` mints a long-lived token the CLI reads from
// CLAUDE_CODE_OAUTH_TOKEN. This module hands it to every child from a file the owner writes once:
//   cfg.claude_token_file (default <node root>/claude-token, lib/config.mjs), read at EVERY spawn
//   (docs/adr/0011: config, not hard-code — a renewed file applies to the next turn, no restart).
// File present with a non-empty trimmed line → the child's env carries it. Absent or blank → the env
// is unchanged and the CLI uses the Keychain login as before. The VALUE never reaches a log or an
// audit line: only "present" / "absent" is logged, and only when that changes.
// The file is not refused for a loose mode: it is warned about ONCE (R5: said, not swallowed) and
// still used, because refusing it would put the node back into the very outage this exists to end.
import fs from 'node:fs';
import path from 'node:path';

export const CLAUDE_TOKEN_FILENAME = 'claude-token';
export const CLAUDE_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
export const CLAUDE_TOKEN_MODE = 0o600;
export const defaultClaudeTokenFile = (root) => path.join(root, CLAUDE_TOKEN_FILENAME);

// A token source bound to its own once-only log memory. The module default below is what
// lib/runner.mjs uses; tests build their own with a captured log.
export function createClaudeTokenSource({ log = console.log, warn = console.warn } = {}) {
  let pathOf = () => null;   // web.mjs sets a GETTER over the live cfg, so a reload applies at once
  const lastState = new Map();   // file → 'present' | 'absent' | 'error:<message>'
  const warnedMode = new Set();
  const sayOnce = (file, state, say) => {
    if (lastState.get(file) === state) return;
    lastState.set(file, state);
    say();
  };
  // The trimmed first line, or null. Never throws: a token file that cannot be read must not stop
  // the spawn (the Keychain login may still work); the failure is logged once per message.
  const read = (file) => {
    let txt;
    try { txt = fs.readFileSync(file, 'utf8'); }
    catch (e) {
      if (e.code === 'ENOENT') { sayOnce(file, 'absent', () => log(`[claude-token] token file: absent (${file}) — the CLI uses its own login`)); return null; }
      sayOnce(file, `error:${e.message}`, () => warn(`[claude-token] token file: unreadable (${file}): ${e.message} — the CLI uses its own login`));
      return null;
    }
    const token = txt.split(/\r?\n/)[0].trim();
    if (!token) { sayOnce(file, 'absent', () => log(`[claude-token] token file: empty (${file}) — the CLI uses its own login`)); return null; }
    sayOnce(file, 'present', () => log(`[claude-token] token file: present (${file})`));
    if (process.platform !== 'win32' && !warnedMode.has(file)) {
      warnedMode.add(file);
      let mode = null;
      try { mode = fs.statSync(file).mode & 0o777; } catch (e) { warn(`[claude-token] cannot stat ${file}: ${e.message}`); }
      if (mode !== null && mode !== CLAUDE_TOKEN_MODE) warn(`[claude-token] ${file} has mode ${mode.toString(8)}, not 600 — still used; run: chmod 600 ${file}`);
    }
    return token;
  };
  return {
    setFile(fn) { pathOf = typeof fn === 'function' ? fn : () => fn; },
    file() { return pathOf() || null; },
    read,
    // The env addition for one spawn: {} when there is no file configured, present or readable.
    env() {
      const file = pathOf();
      if (!file) return {};
      const token = read(file);
      return token ? { [CLAUDE_TOKEN_ENV]: token } : {};
    },
  };
}

export const claudeToken = createClaudeTokenSource();
