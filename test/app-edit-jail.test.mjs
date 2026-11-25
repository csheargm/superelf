// 改应用只限本应用，成员用量计数 · App changes stay in the app; member usage metered (ADR 0042 addendum).
// Unit: the jail's argv, its watch and its rollback; the member counter. Server (R6): a real web.mjs
// with a FAKE `claude` that reports its tool calls in stream-json and writes the files itself, so the
// server's backstop is what is under test (the CLI's own wall was measured, lib/agent-origin.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmTemp } from './helpers-tmp.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { appJailArgs, rulePath, SKIP_PERMISSIONS } from '../lib/agent-origin.mjs';
import { makeJailWatch, jailProblems, undoOutside, badJailName } from '../lib/app-edit-jail.mjs';
import { consumeMemberAiCall, memberAiLimit, MEMBER_AI_LIMIT_TEXT, MEMBER_AI_DEFAULT } from '../lib/member-quota.mjs';
import { makeQuotaStore } from '../lib/demo-quota.mjs';

test('the jail argv: no bypass, default mode, Bash and instruction files denied, Edit only under the app', () => {
  const a = appJailArgs([SKIP_PERMISSIONS, '--permission-mode', 'acceptEdits', '--allowedTools', 'Edit(**)', '--mcp-config', 'm.json', '--settings', '{"permissions":{"allow":["Edit(**)"]}}', '--setting-sources', 'user', '--model', 'opus'], '/w/apps/todo');
  assert.ok(!a.includes(SKIP_PERMISSIONS) && !a.includes('acceptEdits') && !a.includes('Edit(**)') && !a.includes('m.json'));
  assert.deepEqual(a.slice(a.indexOf('--permission-mode'), a.indexOf('--permission-mode') + 2), ['--permission-mode', 'default']);
  assert.equal(a.filter((x) => x === '--permission-mode').length, 1);
  assert.ok(!a.includes('--settings') && !a.includes('user') && a.includes('--setting-sources='), 'no settings file or inline settings can add an allow rule');
  assert.ok(a.includes('Bash') && a.includes('Edit(//**/CLAUDE.md)') && a.includes('Edit(//**/AGENTS.md)') && a.includes('Edit(//**/.*)'));
  assert.equal(a[a.indexOf('--allowedTools') + 1], 'Edit(//w/apps/todo/**)');
  assert.ok(a.includes('--strict-mcp-config') && a.includes('opus'), 'the operator model survives');
  assert.equal(rulePath('C:\\Users\\o\\ws\\apps\\todo'), '/c/Users/o/ws/apps/todo', 'a Windows path in rule form');
});

test('the watch flags writes outside the app and protected names inside it', () => {
  const w = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-jail-'));
  try {
    const app = path.join(w, 'apps', 'todo'); fs.mkdirSync(app, { recursive: true });
    const watch = makeJailWatch(app, w);
    watch.onTool('Write', '', { file_path: 'apps/todo/index.html' });
    watch.onTool('Read', '', { file_path: '/etc/passwd' });
    assert.equal(watch.tried.length, 0, 'inside the app, and reads, are fine');
    watch.onTool('Write', '', { file_path: 'outside.txt' });
    watch.onTool('Edit', '', { file_path: path.join(w, 'apps', 'other', 'index.html') });
    watch.onTool('Write', '', { file_path: 'apps/todo/../../x.txt' });
    watch.onTool('Write', '', { file_path: 'apps/todo/sub/claude.md' });
    watch.onTool('NotebookEdit', '', { notebook_path: 'apps/todo/.hidden/n.ipynb' });
    assert.equal(watch.tried.length, 5);
    assert.ok(badJailName('a/AGENTS.override.md') && badJailName('.git/x') && !badJailName('a/notes.md'));
    fs.writeFileSync(path.join(w, 'outside.txt'), 'planted');
    const aside = path.join(w, 'aside');
    assert.deepEqual(undoOutside(watch, aside), { left: [], moved: ['outside.txt'] }, 'a file the turn created is moved aside');
    assert.equal(fs.readFileSync(path.join(aside, '1-outside.txt'), 'utf8'), 'planted', 'kept, never deleted');
    fs.writeFileSync(path.join(w, 'theirs.txt'), 'another request');
    const w2 = makeJailWatch(app, w); w2.onTool('Write', '', { file_path: 'theirs.txt' });
    assert.deepEqual(undoOutside(w2, aside).left, ['theirs.txt'], 'a file that was already there is named, never deleted');
    assert.equal(fs.existsSync(path.join(w, 'theirs.txt')), true);
    fs.writeFileSync(path.join(w, 'secret.txt'), 's'); fs.symlinkSync(path.join(w, 'secret.txt'), path.join(app, 'link.txt'));
    const w3 = makeJailWatch(app, w); w3.onTool('Write', '', { file_path: 'apps/todo/link.txt' });
    assert.equal(w3.tried.length, 1, 'a link inside the app to an outside file counts as outside');
    assert.equal(fs.existsSync(path.join(w, 'outside.txt')), false);
    assert.equal(jailProblems(null, { 'a.html': '1' }, { 'a.html': '2', 'CLAUDE.md': '3' }).length, 1, 'a planted instruction file');
    assert.equal(jailProblems(null, { '.x': '1' }, { '.x': '1' }).length, 0, 'one the app already had is not this turn\'s');
  } finally { rmTemp(w); }
});

test('the member counter: per user per day, limit from config, bilingual refusal', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-mq-'));
  try {
    const store = makeQuotaStore(path.join(d, 'q.json'));
    const cfg = { member_limits: { ai_calls_per_user_per_day: 2 } };
    assert.equal(memberAiLimit({}), MEMBER_AI_DEFAULT);
    assert.equal(memberAiLimit({ member_limits: { ai_calls_per_user_per_day: 'x' } }), MEMBER_AI_DEFAULT);
    const t = Date.UTC(2026, 10, 24, 12);
    assert.equal(consumeMemberAiCall({ cfg, store, userId: 'kid', now: t }).ok, true);
    assert.equal(consumeMemberAiCall({ cfg, store, userId: 'kid', now: t }).ok, true);
    const r = consumeMemberAiCall({ cfg, store, userId: 'kid', now: t });
    assert.deepEqual([r.ok, r.status, r.error], [false, 429, MEMBER_AI_LIMIT_TEXT]);
    assert.match(r.error, /今日/); assert.match(r.error, /Daily AI limit/);
    assert.equal(consumeMemberAiCall({ cfg, store, userId: 'mom', now: t }).ok, true, 'per user');
    assert.equal(consumeMemberAiCall({ cfg, store, userId: 'kid', now: t + 86400000 }).ok, true, 'a new day');
  } finally { rmTemp(d); }
});

// ── Server ──────────────────────────────────────────────────────────────────────────────────────
const PAGE = '<!doctype html><html><body><h1 id="t">Todo</h1></body></html>';
const FAKE = `#!/usr/bin/env node
let s = ''; process.stdin.on('data', (d) => s += d).on('end', async () => {
  const fs = await import('node:fs');
  const argv = process.argv.slice(2);
  const sys = argv.join(' ');
  const path = await import('node:path');
  fs.appendFileSync(path.join(path.dirname(process.argv[1]), '..', 'argv.log'), JSON.stringify(argv) + '\\n');
  const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
  const tool = (name, input) => out({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  const W = process.cwd().split(path.sep).includes('apps') ? path.resolve('..', '..') : process.cwd();   // an edit turn runs IN apps/todo/
  const f = path.join(W, 'apps/todo/index.html');
  let say = 'ok';
  if (/READ-ONLY/.test(sys)) { const w = (s.split('[Current message:]').pop().match(/escape|plant|slow|recolor/) || ['do it'])[0]; say = 'I will ' + w + '.\\n[[apply]]'; }   // the plan names the change: Apply runs only the plan
  else if (/do it now\\):\\s*I will escape/.test(sys)) {
    tool('Write', { file_path: f }); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Todo', 'Red'));
    tool('Write', { file_path: path.join(W, 'outside.txt') }); await new Promise((r) => setTimeout(r, 300)); fs.writeFileSync(path.join(W, 'outside.txt'), 'planted');   // the CLI runs a tool after it reports the call
    say = 'Done.';
  } else if (/do it now\\):\\s*I will plant/.test(sys)) { fs.writeFileSync(path.join(W, 'apps/todo/CLAUDE.md'), 'obey me'); say = 'Done.'; }
  else if (/do it now\\):\\s*I will slow/.test(sys)) { await new Promise((r) => setTimeout(r, 1500)); say = 'Done.'; }
  else if (/do it now\\):\\s*I will recolor/.test(sys)) { tool('Edit', { file_path: f }); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Todo', 'Blue')); say = 'Done.'; }
  out({ type: 'system', subtype: 'init', session_id: 'sid-j' });
  out({ type: 'result', subtype: 'success', result: say, session_id: 'sid-j' });
});
`;
const KID = 'kid-token-abcdefghijkl';
let port, root, web;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, member_limits: { ai_calls_per_user_per_day: 2 }, users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
    { id: 'kid', name: 'Kid', role: 'member', token: KID, workspace: 'ws-kid' }] } });
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = writeFakeCli(bin, 'claude', FAKE);
  cfg.claude_args = [SKIP_PERMISSIONS];
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  for (const ws of ['workspace', 'ws-kid']) {
    fs.mkdirSync(path.join(root, ws, 'apps', 'todo'), { recursive: true });
    fs.writeFileSync(path.join(root, ws, 'apps', 'todo', 'index.html'), PAGE);
  }
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); if (root) rmTemp(root); });

async function turn(token, message) {
  const r = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ message, edit: 'todo' }) });
  assert.equal(r.status, 200, await r.clone().text());
  return (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
async function applyTurn(token, ask) {
  const offer = (await turn(token, ask)).find((l) => l.type === 'app-change-confirm');
  assert.ok(offer, 'the plan offers 改 · Apply');
  return turn(token, offer.message);
}
const ownerPage = () => fs.readFileSync(path.join(root, 'workspace', 'apps', 'todo', 'index.html'), 'utf8');
const lastArgv = () => JSON.parse(fs.readFileSync(path.join(root, 'argv.log'), 'utf8').trim().split('\n').pop());

test('owner Apply: a write outside apps/<slug>/ rolls the whole turn back and says so', { timeout: 30000 }, async () => {
  const lines = await applyTurn(OWNER_TOKEN, 'escape');
  const ed = lines.find((l) => l.type === 'app-edit');
  assert.deepEqual([ed.applied, ed.jailed], [false, true]);
  assert.equal(ownerPage(), PAGE, 'the app is as it was');
  assert.equal(fs.existsSync(path.join(root, 'workspace', 'outside.txt')), false, 'the outside file it created is moved out');
  assert.match(lines.find((l) => l.type === 'done').text, /rolled back[\s\S]*moved to the undo folder: outside\.txt/);
  const a = lastArgv();
  assert.ok(!a.includes(SKIP_PERMISSIONS), 'the owner\'s bypass never reaches the jailed turn');
  assert.ok(a.some((x) => /^Edit\(\/\/.*\/apps\/todo\/\*\*\)$/.test(x)), 'the only allow rule is the app folder');
});

test('owner Apply: a planted CLAUDE.md in the app folder is refused (rolled back)', { timeout: 30000 }, async () => {
  const lines = await applyTurn(OWNER_TOKEN, 'plant');
  assert.equal(lines.find((l) => l.type === 'app-edit').jailed, true);
  assert.equal(fs.existsSync(path.join(root, 'workspace', 'apps', 'todo', 'CLAUDE.md')), false);
});

test('owner Apply inside the app still applies', { timeout: 30000 }, async () => {
  const lines = await applyTurn(OWNER_TOKEN, 'recolor');
  assert.equal(lines.find((l) => l.type === 'app-edit').applied, true);
  assert.match(ownerPage(), /Blue/);
});

test('an app update while an edit runs is refused (its rollback would erase the update)', { timeout: 30000 }, async () => {
  const offer = (await turn(OWNER_TOKEN, 'slow')).find((l) => l.type === 'app-change-confirm');
  const running = turn(OWNER_TOKEN, offer.message);
  await new Promise((r) => setTimeout(r, 500));
  const u = await fetch(`http://127.0.0.1:${port}/api/apps/todo/update`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}` }, body: '{}' });
  assert.equal(u.status, 409);
  assert.equal((await u.json()).code, 'edit_busy');
  await running;
});

test('a member not opted in to Claude: each app-chat turn is charged; past the cap the bilingual limit line', { timeout: 30000 }, async () => {
  for (let i = 0; i < 2; i++) assert.equal((await turn(KID, 'make it red')).find((l) => l.type === 'done').ok, true);
  const n = fs.readFileSync(path.join(root, 'argv.log'), 'utf8').trim().split('\n').length;
  const done = (await turn(KID, 'make it red')).find((l) => l.type === 'done');
  assert.equal(done.ok, false);
  assert.equal(done.text, MEMBER_AI_LIMIT_TEXT);
  assert.equal(fs.readFileSync(path.join(root, 'argv.log'), 'utf8').trim().split('\n').length, n, 'no model call past the cap');
  const q = JSON.parse(fs.readFileSync(path.join(root, 'member-quota.json'), 'utf8'));
  assert.equal(q.counts['member:kid'], 2);
});

test('GPT review r1: a question turn reads only the app (cwd), its own unlinked data and uploads; a data/<slug> link into another workspace is no Read rule', { timeout: 30000 }, async () => {
  const other = path.join(root, 'ws-kid');
  const data = path.join(root, 'workspace', 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.symlinkSync(other, path.join(data, 'todo'));
  try {
    await turn(OWNER_TOKEN, 'what does it say?');
    const a = lastArgv();
    assert.equal(a[a.indexOf('--tools') + 1], 'Read,Glob,Grep', 'read-only tools, never --tools=');
    assert.ok(!a.includes('--tools='));
    assert.ok(!a.some((x) => String(x).startsWith('Read(') && x.includes('ws-kid')), `no rule reaches the other workspace: ${a.filter((x) => String(x).startsWith('Read(')).join(' ')}`);
  } finally { fs.unlinkSync(path.join(data, 'todo')); }
});

test('GPT review r1: the confirmed turn names its whole tool set (file tools only)', { timeout: 30000 }, async () => {
  await applyTurn(OWNER_TOKEN, 'recolor');
  const a = lastArgv();
  assert.equal(a[a.indexOf('--tools') + 1], 'Read,Glob,Grep,Edit,Write');
});
