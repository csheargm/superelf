// Claude sign-in watchdog（看门狗）— knows when the node's Claude CLI can no longer authenticate,
// says it once, and clears when it works again (docs/adr/0024).
//
// The CLI reports an expired or revoked login as a RESULT, not a crash: stream-json's final line is
// {type:'result', is_error:true, api_error_status:401, result:'Failed to authenticate. API Error:
// 401 …'} and the process exits 1 (measured 2026-11-10 on Claude Code with a wrong
// CLAUDE_CODE_OAUTH_TOKEN; the Keychain case reads "OAuth access token has been revoked").
// lib/runner.mjs hands that text back as { ok:false, text }, so every Claude caller sees it here.
//
// claude-auth.json (node root, gitignored runtime state), the model-health.json idea (lib/model-health.mjs):
//   { failedAt: <ms> | null, lastError: string, reported: bool, okAt: <ms> | null }
// `reported` is false while only a chat turn has seen the failure: the daily model-check job's
// probe still briefs it (once), or the turn that found it first would have silenced the owner's
// report. noteOk clears the episode, so the next expiry is briefed again.
import fs from 'node:fs';
import { writeJsonFile } from './atomicwrite.mjs';

export const CLAUDE_AUTH_FILENAME = 'claude-auth.json';
// The CLI's own words for "not signed in", every spelling met so far. `401` alone is NOT enough:
// a 401 from a tool's HTTP call inside an answer would read as an expired login.
const AUTH_FAILURE = /Failed to authenticate|OAuth access token has been revoked|Invalid bearer token|Please run \/login|API Error: 401\b|authentication_failed/i;
export const isAuthFailure = (text) => AUTH_FAILURE.test(String(text || ''));

// The ONE line every surface shows for the condition (R3): the chat reply, the briefing, the log.
export const CLAUDE_SIGNIN_EXPIRED = 'Claude sign-in on the Mac node has expired · 节点上的 Claude 登录已失效 — run: claude auth login (or renew the token file)';
// The ONE line a Codex-answered turn starts with (web.mjs agent lane → lib/lane-codex.mjs codexFallback).
export const CODEX_FALLBACK_PREFIX = 'Answered by GPT (Codex) because the Claude sign-in on the node expired · 由 GPT (Codex) 代答：节点上的 Claude 登录已失效';
export const CLAUDE_SIGNIN_BACK = 'Claude sign-in on the node works again · 节点上的 Claude 登录已恢复';
// What the model-check briefing says when Ollama could not be checked but the sign-in brief must still
// go out (web.mjs 'model-check' run): the prefix, then the runModelCheck error.
export const MODEL_CHECK_ERROR_PREFIX = 'Model check · 模型检查: ';
// What the daily probe asks, and how: no tool, no MCP, the cheapest tier, one minute.
export const AUTH_PROBE_PROMPT = 'Reply OK';
export const AUTH_PROBE_ARGS = Object.freeze(['--model', 'haiku', '--tools=', '--strict-mcp-config']);
export const AUTH_PROBE_TIMEOUT_MS = 60000;
const ERROR_TEXT_MAX = 300;

const emptyState = () => ({ failedAt: null, lastError: '', reported: false, okAt: null });
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// STRICT like readModelHealth: missing = nothing known, damaged = THROWS; the wrapper below decides.
export function readAuthState(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return emptyState(); throw e; }
  const o = JSON.parse(txt);
  if (!isObj(o)) throw new Error(`${CLAUDE_AUTH_FILENAME} is not an object`);
  return { failedAt: Number(o.failedAt) || null, lastError: typeof o.lastError === 'string' ? o.lastError : '',
    reported: o.reported === true, okAt: Number(o.okAt) || null };
}

// A damaged file is rebuilt by the write rather than blocking the record: the record is what matters now.
const readOrEmpty = (file) => { try { return readAuthState(file); } catch { return emptyState(); } };

// Returns true when this starts a NEW failure episode (nothing failed before, or it was ok since).
export function noteFailure(file, error, now = Date.now()) {
  const s = readOrEmpty(file);
  const fresh = !s.failedAt;
  writeJsonFile(file, { failedAt: s.failedAt || now, lastError: String(error || '').slice(0, ERROR_TEXT_MAX), reported: fresh ? false : s.reported, okAt: s.okAt });
  return fresh;
}

// Returns true when a failure episode is being closed (so a "works again" line is due).
export function noteOk(file, now = Date.now()) {
  const s = readOrEmpty(file);
  const wasFailed = !!s.failedAt;
  writeJsonFile(file, { failedAt: null, lastError: '', reported: false, okAt: now });
  return wasFailed;
}

export const needsReport = (state) => !!(state && state.failedAt && !state.reported);

export function markReported(file) {
  const s = readOrEmpty(file);
  writeJsonFile(file, { ...s, reported: true });
}

// The two things web.mjs needs per turn, bound to the node's file and audit log. A damaged or
// unwritable file never fails the turn that met the auth failure (its own error is what the user
// sees); the failure to record is audited (R5), never silent.
export function claudeAuthFor(file, audit) {
  return {
    file,
    noteFailure(error) {
      try { if (noteFailure(file, error)) audit('claude-auth-failed', { error: String(error || '').slice(0, ERROR_TEXT_MAX) }); }
      catch (e) { audit('claude-auth-error', { error: String((e && e.message) || e) }); }
    },
  };
}

// The daily probe (web.mjs JOBS 'model-check'): one cheap Claude run. Briefs ONCE per failure
// episode — `reported` is written before the briefing is stored, the model-health trade-off — and
// once when it works again after one. null = nothing to say. Skipped (null) when no Claude lane is
// configured. A run that fails for another reason (timeout, CLI missing) is NOT an auth verdict:
// it is audited and the state is left as it was (R14: never a vacuous ok).
export async function checkClaudeAuth({ file, chatModels, claudeCmd, cwd, run, audit = () => {}, now = Date.now() }) {
  if (!(chatModels || []).some((m) => m && m.provider === 'claude')) return null;
  const r = await run({ claudeCmd, extraArgs: [...AUTH_PROBE_ARGS], cwd, prompt: AUTH_PROBE_PROMPT, timeoutMs: AUTH_PROBE_TIMEOUT_MS });
  if (r && r.ok && !isAuthFailure(r.text)) {
    return noteOk(file, now) ? { body: CLAUDE_SIGNIN_BACK } : null;
  }
  if (!isAuthFailure(r && r.text)) {
    audit('claude-auth-probe-unknown', { error: String((r && r.text) || '').slice(0, ERROR_TEXT_MAX) });
    return null;
  }
  noteFailure(file, r.text, now);
  const s = readOrEmpty(file);
  if (!needsReport(s)) return null;
  markReported(file);
  return { body: `${CLAUDE_SIGNIN_EXPIRED}\nSince · 自: ${new Date(s.failedAt).toISOString()}\n${s.lastError}` };
}

// Two optional briefing parts into one (the model check's and the probe's): null when both are quiet.
export function mergeBriefs(...parts) {
  const bodies = parts.filter((p) => p && typeof p.body === 'string' && p.body.trim()).map((p) => p.body);
  return bodies.length ? { body: bodies.join('\n\n') } : null;
}
