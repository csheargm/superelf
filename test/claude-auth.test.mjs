// lib/claude-auth.mjs: the sign-in watchdog at its edges. The exact result line the real CLI
// printed (measured 2026-11-10 with a wrong CLAUDE_CODE_OAUTH_TOKEN) is pinned, the state file's
// once-only rule is driven through checkClaudeAuth with a fake run, and every quiet case has a
// control that speaks (R14).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isAuthFailure, readAuthState, noteFailure, noteOk, needsReport, markReported, claudeAuthFor, checkClaudeAuth, mergeBriefs,
  CLAUDE_AUTH_FILENAME, CLAUDE_SIGNIN_EXPIRED, CLAUDE_SIGNIN_BACK, AUTH_PROBE_PROMPT, AUTH_PROBE_ARGS, AUTH_PROBE_TIMEOUT_MS } from '../lib/claude-auth.mjs';

import { REAL_401_RESULT, REAL_401_REVOKED } from './helpers-claude-auth.mjs';
const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-auth-')), CLAUDE_AUTH_FILENAME);
const CLAUDE_LANES = [{ id: 'claude', provider: 'claude', model: null }];

test('isAuthFailure: the CLI\'s own lines, and not an ordinary answer or a bare number', () => {
  for (const t of [REAL_401_RESULT, REAL_401_REVOKED, 'Please run /login', 'OAuth access token has been revoked', 'authentication_failed'])
    assert.equal(isAuthFailure(t), true, t);
  for (const t of ['OK', 'The server returned 401 for that URL', '', null, 'Task timed out after 30 min and was stopped.'])
    assert.equal(isAuthFailure(t), false, String(t));
});

test('state file: missing = nothing known; a failure opens an episode once; ok closes it; damaged throws', () => {
  const f = file();
  assert.deepEqual(readAuthState(f), { failedAt: null, lastError: '', reported: false, okAt: null });
  assert.equal(noteFailure(f, REAL_401_REVOKED, 1000), true, 'a NEW episode');
  assert.equal(noteFailure(f, REAL_401_RESULT, 2000), false, 'the same episode');
  const s = readAuthState(f);
  assert.equal(s.failedAt, 1000, 'the episode keeps its first time');
  assert.equal(s.lastError, REAL_401_RESULT, 'and the latest error');
  assert.equal(needsReport(s), true);
  markReported(f);
  assert.equal(needsReport(readAuthState(f)), false);
  assert.equal(noteOk(f, 3000), true, 'closing an episode says so');
  assert.deepEqual(readAuthState(f), { failedAt: null, lastError: '', reported: false, okAt: 3000 });
  assert.equal(noteOk(f, 4000), false, 'R14 control: ok after ok is quiet');
  fs.writeFileSync(f, '{not json');
  assert.throws(() => readAuthState(f));
  assert.equal(noteFailure(f, 'x', 5000), true, 'a damaged file is rebuilt by the record');
  assert.equal(readAuthState(f).failedAt, 5000);
});

test('claudeAuthFor: a chat turn\'s record audits the first failure only, and a record failure is audited, never thrown', () => {
  const f = file();
  const events = [];
  const a = claudeAuthFor(f, (ev, fields) => events.push({ ev, ...fields }));
  a.noteFailure(REAL_401_REVOKED);
  a.noteFailure(REAL_401_REVOKED);
  assert.deepEqual(events.map((e) => e.ev), ['claude-auth-failed']);
  assert.equal(readAuthState(f).reported, false, 'a chat turn never marks it reported: the job still briefs it');
  const bad = claudeAuthFor(path.join(f, 'under-a-file', CLAUDE_AUTH_FILENAME), (ev, fields) => events.push({ ev, ...fields }));
  bad.noteFailure('x');   // ENOTDIR on write
  assert.equal(events.at(-1).ev, 'claude-auth-error');
});

test('checkClaudeAuth: briefs ONCE per episode with the fix command, then once when it works again', async () => {
  const f = file();
  const calls = [];
  const failing = async (o) => { calls.push(o); return { ok: false, text: REAL_401_REVOKED, sessionId: null }; };
  const ok = async () => ({ ok: true, text: 'OK', sessionId: 'x' });
  const opts = { file: f, chatModels: CLAUDE_LANES, claudeCmd: 'claude', cwd: os.tmpdir() };
  const first = await checkClaudeAuth({ ...opts, run: failing, now: 1000 });
  assert.ok(first && first.body.startsWith(CLAUDE_SIGNIN_EXPIRED), 'the sign-in line with the fix command');
  assert.match(first.body, /claude auth login/);
  assert.equal(calls[0].prompt, AUTH_PROBE_PROMPT);
  assert.deepEqual(calls[0].extraArgs, [...AUTH_PROBE_ARGS], 'no tool, no MCP, haiku');
  assert.equal(calls[0].timeoutMs, AUTH_PROBE_TIMEOUT_MS);
  assert.equal(await checkClaudeAuth({ ...opts, run: failing, now: 2000 }), null, 'the next day: already reported, quiet');
  assert.equal(readAuthState(f).reported, true);
  const back = await checkClaudeAuth({ ...opts, run: ok, now: 3000 });
  assert.deepEqual(back, { body: CLAUDE_SIGNIN_BACK }, 'cleared by ok, said once');
  assert.equal(await checkClaudeAuth({ ...opts, run: ok, now: 4000 }), null, 'R14 control: ok after ok is quiet');
  const again = await checkClaudeAuth({ ...opts, run: failing, now: 5000 });
  assert.ok(again && again.body.startsWith(CLAUDE_SIGNIN_EXPIRED), 'a NEW episode is briefed again');
});

test('checkClaudeAuth: a chat turn that found it first is reported by the next run (once), and skipped with no Claude lane', async () => {
  const f = file();
  claudeAuthFor(f, () => {}).noteFailure(REAL_401_REVOKED);   // the chat turn
  const failing = async () => ({ ok: false, text: REAL_401_RESULT });
  const opts = { file: f, chatModels: CLAUDE_LANES, claudeCmd: 'claude', cwd: os.tmpdir(), run: failing };
  const r = await checkClaudeAuth(opts);
  assert.ok(r && r.body.startsWith(CLAUDE_SIGNIN_EXPIRED));
  assert.equal(await checkClaudeAuth(opts), null, 'once');
  let ran = 0;
  assert.equal(await checkClaudeAuth({ ...opts, chatModels: [{ id: 'gpt', provider: 'codex' }], run: async () => { ran++; } }), null);
  assert.equal(ran, 0, 'no Claude lane: no probe spawned');
});

test('checkClaudeAuth: a run that fails for another reason is no verdict — audited, state untouched (R14)', async () => {
  const f = file();
  const events = [];
  const opts = { file: f, chatModels: CLAUDE_LANES, claudeCmd: 'claude', cwd: os.tmpdir(), audit: (ev, x) => events.push({ ev, ...x }) };
  assert.equal(await checkClaudeAuth({ ...opts, run: async () => ({ ok: false, text: 'Task timed out after 1 min and was stopped.' }) }), null);
  assert.deepEqual(events.map((e) => e.ev), ['claude-auth-probe-unknown']);
  assert.equal(fs.existsSync(f), false, 'nothing recorded: not an ok, not a failure');
});

test('mergeBriefs: both quiet → null; one or both → joined', () => {
  assert.equal(mergeBriefs(null, null), null);
  assert.deepEqual(mergeBriefs({ body: 'a' }, null), { body: 'a' });
  assert.deepEqual(mergeBriefs({ body: 'a' }, { body: 'b' }), { body: 'a\n\nb' });
  assert.equal(mergeBriefs({ body: '  ' }), null, 'an empty body is not a briefing (R14)');
});
