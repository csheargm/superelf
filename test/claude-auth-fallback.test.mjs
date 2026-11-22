// END TO END (R6, docs/adr/0024): the real web.mjs from this checkout on an ephemeral port, a
// throwaway root, a FAKE `claude` that answers the way the real CLI answers when its sign-in has
// expired — the stream-json result line with is_error:true and the REAL 401 text, exit 1 (measured
// 2026-11-10) — and a FAKE `codex` that writes an answer to its -o file. Driven through the real
// chat route and the real model-check Run-now route:
//   1. a conversation turn on the Claude lane is answered by Codex, prefixed, and the state file
//      records the failure (not yet reported); the conversation keeps NO Claude session id and
//      stores Codex's as its Codex session;
//   2. a oneShot turn gets the sign-in line and never spawns Codex (R14 control: test 1 did);
//   2b. an app-originated (confined) turn gets the sign-in line and never spawns Codex either;
//   3. the model-check job briefs the sign-in ONCE (the turn's record is what it reports), then
//      is quiet, then says "works again" when the fake claude answers (a config edit renames the
//      fake's mode file — no restart), then is quiet again;
//   4. with an Ollama lane that cannot be checked (a closed port), the sign-in briefing still
//      goes out, carrying the model-check error, and the error is audited (R5).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor, api, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { CLAUDE_AUTH_FILENAME, CLAUDE_SIGNIN_EXPIRED, CLAUDE_SIGNIN_BACK, CODEX_FALLBACK_PREFIX, MODEL_CHECK_ERROR_PREFIX, readAuthState } from '../lib/claude-auth.mjs';
import { APP_ORIGIN_HEADER, APP_ORIGIN_VALUE } from '../lib/agent-origin.mjs';
import { CODEX_WORKING_STATUS } from '../lib/lane-codex.mjs';
import { REAL_401_REVOKED } from './helpers-claude-auth.mjs';

// The fake claude fails to authenticate while the file named by PA_FAKE_OK is absent — exactly the
// real CLI's output shape — and answers OK once it exists. It records every spawn's argv + stdin.
const fakeClaude = (log, okFile) => `#!/usr/bin/env node
import fs from 'node:fs'; import crypto from 'node:crypto';
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const sid = crypto.randomUUID();
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cli: 'claude', argv: process.argv.slice(2), stdin: s }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }) + '\\n');
  if (fs.existsSync(${JSON.stringify(okFile)})) {
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK', session_id: sid }) + '\\n');
    return;
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: ${JSON.stringify(REAL_401_REVOKED)}, session_id: sid }) + '\\n');
  process.exitCode = 1;
});
`;
const fakeCodex = (log) => `#!/usr/bin/env node
import fs from 'node:fs'; let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const a = process.argv.slice(2);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ cli: 'codex', argv: a, stdin: s }) + '\\n');
  fs.writeFileSync(a[a.indexOf('-o') + 1], 'CODEX-ANSWER');
  process.stdout.write('session id: 11111111-2222-3333-4444-555555555555\\n');
});
`;

let port, root, web, log, okFile, cfgPath, seq = 0;
before(async () => {
  port = await freePort();
  // Only agent lanes: an Ollama lane pointing nowhere would make runModelCheck throw (no lane checked).
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, chat_models: [
    { id: 'claude', label: 'Claude', group: 'Agent', provider: 'claude', model: null },
    { id: 'gpt', label: 'GPT (Codex)', group: 'Agent', provider: 'codex', model: null },
  ] } });
  log = path.join(root, 'spawns.jsonl');
  okFile = path.join(root, 'claude-signed-in');
  const bin = path.join(root, 'fakebin');
  fs.mkdirSync(bin);
  const claudeCmd = writeFakeCli(bin, 'claude', fakeClaude(log, okFile));
  writeFakeCli(bin, 'codex', fakeCodex(log));
  cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = claudeCmd;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;   // web.mjs spawns `codex` by name
  web = startWeb(root);
  await waitReady(port);
});
after(async () => { await stopWeb(web); });

const tag = () => `T-${++seq}-${Date.now()}`;
const spawns = (t) => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((s) => s.stdin.includes(t));
async function chat(body, headers = {}) {
  const r = await api(port, '/api/chat', { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${OWNER_TOKEN}`, ...headers } });
  assert.equal(r.status, 200);
  const lines = (await r.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { lines, convo: lines.find((l) => l.type === 'convo'), done: lines.find((l) => l.type === 'done'), error: lines.find((l) => l.type === 'error') };
}
const runCheck = async () => (await api(port, '/api/jobs/model-check/run', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).json();
const stateFile = () => path.join(root, CLAUDE_AUTH_FILENAME);
const auditLog = () => fs.readFileSync(path.join(root, 'audit.log'), 'utf8');

test('a conversation turn whose Claude sign-in has expired is answered by Codex, prefixed, and recorded', async () => {
  const t = tag();
  const r = await chat({ message: `hello ${t}`, model: 'claude' });
  assert.ok(r.done, `the turn ends with a done line: ${JSON.stringify(r.lines)}`);
  assert.equal(r.done.ok, true);
  assert.equal(r.done.text, `${CODEX_FALLBACK_PREFIX}\n\nCODEX-ANSWER`);
  assert.deepEqual(spawns(t).map((s) => s.cli), ['claude', 'codex'], 'Claude was really asked first, then Codex');
  assert.ok(spawns(t)[1].stdin.includes(`hello ${t}`), 'the SAME prompt went to Codex');
  assert.ok(r.lines.some((l) => l.type === 'status' && l.text === CODEX_WORKING_STATUS), 'the Codex status line was shown');
  const s = readAuthState(stateFile());
  assert.ok(s.failedAt > 0, 'the failure is recorded');
  assert.equal(s.reported, false, 'but not yet reported: the job briefs it');
  assert.equal(s.lastError, REAL_401_REVOKED);
  const stored = JSON.parse(fs.readFileSync(path.join(root, 'workspace', 'conversations', `${r.convo.id}.json`), 'utf8'));
  assert.equal(stored.sessionId, null, 'no Claude session was stored from the Codex answer');
  assert.equal(stored.codexSessionId, '11111111-2222-3333-4444-555555555555', 'Codex\'s session is the Codex session');
  assert.equal(stored.messages.at(-1).text, r.done.text, 'the prefixed answer is what the conversation keeps');
  const audit = fs.readFileSync(path.join(root, 'audit.log'), 'utf8');
  assert.ok(audit.includes('"claude-auth-failed"'), 'audited');
});

test('a oneShot turn gets the sign-in line and never falls back to Codex', async () => {
  const t = tag();
  const r = await chat({ message: `design ${t}`, model: 'claude', oneShot: true });
  assert.ok(r.done, JSON.stringify(r.lines));
  assert.equal(r.done.ok, false);
  assert.equal(r.done.text, CLAUDE_SIGNIN_EXPIRED);
  assert.deepEqual(spawns(t).map((s) => s.cli), ['claude'], 'no Codex spawn');
});

test('an app-originated (confined) conversation turn gets the sign-in line and never falls back to Codex', async () => {
  const t = tag();
  const r = await chat({ message: `hello ${t}`, model: 'claude', app: 'some-app' }, { [APP_ORIGIN_HEADER]: APP_ORIGIN_VALUE });
  assert.ok(r.done, JSON.stringify(r.lines));
  assert.equal(r.done.ok, false);
  assert.equal(r.done.text, CLAUDE_SIGNIN_EXPIRED);
  assert.deepEqual(spawns(t).map((s) => s.cli), ['claude'], 'no Codex spawn: confined turns never reach Codex');
});

test('the model-check job briefs the sign-in once, is then quiet, says "works again" once, then is quiet', async () => {
  const first = await runCheck();
  assert.ok(first.body && first.body.startsWith(CLAUDE_SIGNIN_EXPIRED), `the chat turn's record is briefed: ${JSON.stringify(first)}`);
  assert.match(first.body, /claude auth login/);
  assert.equal(readAuthState(stateFile()).reported, true);
  const probes = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((s) => s.stdin === 'Reply OK');
  assert.equal(probes.length, 1, 'ONE probe spawned');
  assert.ok(probes[0].argv.includes('--tools=') && probes[0].argv.includes('--strict-mcp-config'), 'no tool, no MCP');
  const second = await runCheck();
  assert.ok(!(second.body || '').includes(CLAUDE_SIGNIN_EXPIRED), `quiet the second time: ${JSON.stringify(second)}`);
  fs.writeFileSync(okFile, '');   // the owner signed in again
  const back = await runCheck();
  assert.ok(back.body.includes(CLAUDE_SIGNIN_BACK), JSON.stringify(back));
  assert.equal(readAuthState(stateFile()).failedAt, null, 'cleared');
  const quiet = await runCheck();
  assert.ok(!(quiet.body || '').includes(CLAUDE_SIGNIN_BACK) && !(quiet.body || '').includes(CLAUDE_SIGNIN_EXPIRED), JSON.stringify(quiet));
  // R14 control: with the sign-in back, a conversation turn is Claude's own again, no prefix.
  const t = tag();
  const r = await chat({ message: `hello ${t}`, model: 'claude' });
  assert.equal(r.done.text, 'OK');
  assert.deepEqual(spawns(t).map((s) => s.cli), ['claude']);
});

test('an Ollama outage does not lose the sign-in briefing: it carries the model-check error, audited', async () => {
  // An Ollama lane at the harness default ollama_url (port 9, refused at once) makes runModelCheck
  // throw; config.json is live (ADR 0011), so the lane appears in /api/models once reloaded.
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.chat_models.push({ id: 'local', label: 'Local', group: 'Local', provider: 'ollama', model: 'fake-model' });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const models = async () => (await api(port, '/api/models', { headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).json();
  await waitFor(async () => (await models()).some((m) => m.id === 'local'), 'the Ollama lane after the config reload');
  fs.rmSync(okFile);   // the sign-in expired again: a NEW episode
  const b = await runCheck();
  assert.ok(b.body && b.body.startsWith(CLAUDE_SIGNIN_EXPIRED), `the sign-in briefing survived the outage: ${JSON.stringify(b)}`);
  assert.ok(b.body.includes(MODEL_CHECK_ERROR_PREFIX), `and carries the model-check error: ${b.body}`);
  assert.equal(readAuthState(stateFile()).reported, true);
  const saved = await (await api(port, `/api/briefings/${b.briefing}`, { headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).json();
  assert.ok(saved.body.startsWith(CLAUDE_SIGNIN_EXPIRED) && saved.body.includes(MODEL_CHECK_ERROR_PREFIX), `the SAVED briefing has both: ${saved.body}`);
  assert.ok(auditLog().includes('"model-check-error"'), 'the outage is audited (R5)');
  // R14 control: with the episode reported, the same outage is the job's own failure again.
  const second = await runCheck();
  assert.ok(!(second.body || '').includes(CLAUDE_SIGNIN_EXPIRED), JSON.stringify(second));
  assert.ok(second.error, `no sign-in brief to carry it: the run fails: ${JSON.stringify(second)}`);
});
