// The agent lane's system prompt must reach the CLI WHOLE · 系统提示必须完整到达 CLI
//
// SCAR (2026-10-11): runClaude cut --append-system-prompt to 2000 chars, a number copied from the
// ollama lane — where it caps the app DIRECTIVE alone, not the joined prompt. The agent lane joins
// [guard, app directive, agentCapabilities], and agentCapabilities is ~4.4k chars by itself
// (language rule + the app contract read from superelf.md + the confined note). Measured: the
// confined note began at char ~4031 on /api/ask and ~4590 in chat. So no confined agent was ever
// told it was confined — it narrated permission prompts nobody can grant — and every lane, the
// owner's included, lost most of the app contract. Every unit test passed: each piece was right,
// and only the CLI's argv showed the cut. So this drives the REAL server with a fake `claude` that
// records its argv, and reads the prompt back from there.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { agentCapabilities, appContract, OVERRIDABLE_PROMPT_MAX } from '../lib/config.mjs';
import { REPLY_IN } from '../lib/ui-lang.mjs';
import { APPEND_SYSTEM_PROMPT_MAX } from '../lib/runner.mjs';
import { APP_ORIGIN_HEADER, APP_ORIGIN_VALUE } from '../lib/agent-origin.mjs';
import { ROOT } from './helpers-app.mjs';

const MEMBER_TOKEN = 'test-member-token-argv-0123456789';
const CONTRACT = appContract(ROOT);
// The header the shell relay adds to every agent-reaching app request (web/index.html appAgentInit),
// read by the server through appOriginated. Imported, never retyped (R3: lib/agent-origin.mjs).
const APP_HEADERS = { [APP_ORIGIN_HEADER]: APP_ORIGIN_VALUE };

let port, root, web, argvLog;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
    { id: 'kid', name: 'Kid', role: 'member', token: MEMBER_TOKEN, workspace: 'workspace-kid', agent: true },   // opted in to agent tools (F4-2)
  ] } });
  argvLog = path.join(root, 'argv.ndjson');
  const bin = path.join(root, 'fake-claude.mjs');
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdin.resume().on('end', () => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'OK' }) + '\\n'));
`);
  fs.chmodSync(bin, 0o755);
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = bin;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); });

test('BUDGET: the largest prompt a member or app can cause still fits under the runner cap', () => {
  // Both overridable pieces at their cap, then the server-owned text, joined as web.mjs joins them.
  // This fails the day superelf.md grows the contract past what argv may carry — before a member's
  // agent quietly stops being told it is confined again.
  const worst = ['g'.repeat(OVERRIDABLE_PROMPT_MAX), 'a'.repeat(OVERRIDABLE_PROMPT_MAX), agentCapabilities('member', CONTRACT)].join('\n\n');
  assert.ok(worst.length <= APPEND_SYSTEM_PROMPT_MAX, `worst case ${worst.length} > cap ${APPEND_SYSTEM_PROMPT_MAX}`);
});

const calls = () => (fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// One request → exactly one CLI run → the system prompt that run was given.
async function promptFor(route, token, body, headers = {}) {
  const n = calls().length;
  const res = await api(port, route, { method: 'POST', headers: { authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  const out = await res.text();   // the turn is over when the body ends
  assert.match(out, /OK/, `the fake CLI really answered: ${out.slice(0, 200)}`);
  const runs = calls().slice(n);
  assert.equal(runs.length, 1, `one request, one CLI run — got ${runs.length}`);
  const i = runs[0].indexOf('--append-system-prompt');
  assert.ok(i >= 0, `the flag must be passed: ${runs[0].join(' ').slice(0, 300)}`);
  return runs[0][i + 1];
}

// Whole, not "mentions": the bug left the first ~2000 chars intact, so a substring check on the
// opening of the capability text would have passed against the broken build.
function assertConfinedWhole(sp, who) {
  const caps = agentCapabilities('member', CONTRACT);
  assert.ok(sp.endsWith(caps), `${who}: the whole capability text must arrive, last (prompt ${sp.length} chars)`);
  assert.match(sp, /confined lane/, `${who}: told it is confined`);
  assert.match(sp, /never ask for one and never say you need permission/, `${who}: told no approver exists`);
  assert.match(sp, /give the best answer you can from what you do have\.$/, `${who}: down to the note's last sentence`);
}

test('a MEMBER in the main chat: the confined note reaches argv whole', async () => {
  assertConfinedWhole(await promptFor('/api/chat', MEMBER_TOKEN, { message: 'hi' }), 'member chat');
});

test('an APP request from a member, at the largest directive it may send: the note still arrives', async () => {
  // The worst case an app controls: a directive far past the cap. It must be cut to its own budget
  // and must not push the server-owned text out of the prompt.
  const directive = 'APP-DIRECTIVE-START ' + 'x'.repeat(OVERRIDABLE_PROMPT_MAX * 4);
  const sp = await promptFor('/api/chat', MEMBER_TOKEN, { message: 'hi', app: 'weather', system: directive }, APP_HEADERS);
  assertConfinedWhole(sp, 'member app chat');
  assert.ok(sp.includes(directive.slice(0, OVERRIDABLE_PROMPT_MAX)), 'the directive travels, up to its cap');
  assert.ok(!sp.includes(directive.slice(0, OVERRIDABLE_PROMPT_MAX + 1)), 'and not one char past it');
  assert.ok(sp.length <= APPEND_SYSTEM_PROMPT_MAX, `within the runner's cap: ${sp.length}`);
});

test("an app's ASK request from a member: the note reaches argv whole", async () => {
  // /api/ask sends ONLY agentCapabilities — and still lost the note, which shows the cap, not the
  // order, was the cut.
  const sp = await promptFor('/api/ask', MEMBER_TOKEN, { message: 'hi' }, APP_HEADERS);
  assertConfinedWhole(sp, 'member ask');
  assert.equal(sp, agentCapabilities('member', CONTRACT), 'and nothing but it');
});

test('an APP request in the OWNER\'s session is confined — and is told so, whole', async () => {
  // The owner's app turns run confined (lib/agent-origin.mjs), so they get the confined note — and
  // lost it to the same cut. The directive is again past its cap.
  const directive = 'APP-DIRECTIVE-START ' + 'x'.repeat(OVERRIDABLE_PROMPT_MAX * 4);
  assertConfinedWhole(await promptFor('/api/chat', OWNER_TOKEN, { message: 'hi', app: 'weather', system: directive }, APP_HEADERS), 'owner app chat');
  assertConfinedWhole(await promptFor('/api/ask', OWNER_TOKEN, { message: 'hi', app: 'weather' }, APP_HEADERS), 'owner app ask');
});

test('CONTROL: the owner\'s own chat is NOT told it is confined, and gets the whole contract', async () => {
  // Proves the recorder tells the lanes apart (R14) — and the owner lost the contract's tail too.
  const sp = await promptFor('/api/chat', OWNER_TOKEN, { message: 'hi' });
  assert.ok(!sp.includes('confined lane'), 'the owner is not confined');
  assert.ok(sp.endsWith(agentCapabilities('owner', CONTRACT)), `the owner's capability text arrives whole (${sp.length} chars)`);
});

test('the app ask carries the reply-language line: the page\'s word, else the account; a bilingual page follows the writer', async () => {
  const en = await promptFor('/api/ask', MEMBER_TOKEN, { message: 'hi', lang: 'en' }, APP_HEADERS);
  assert.equal(en, agentCapabilities('member', CONTRACT, REPLY_IN.en), 'English sent: the English line leads');
  const zh = await promptFor('/api/ask', MEMBER_TOKEN, { message: 'hi', lang: 'zh' }, APP_HEADERS);
  assert.ok(zh.startsWith(REPLY_IN.zh), 'zh sent: the 中文 line');
  const both = await promptFor('/api/ask', MEMBER_TOKEN, { message: 'hi', lang: 'both' }, APP_HEADERS);
  assert.equal(both, agentCapabilities('member', CONTRACT), 'a bilingual page: the follow-the-writer rule (CONTROL)');
});
