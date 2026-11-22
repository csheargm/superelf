// The Telegram bot was removed 2026-10-12 (docs/adr/0006). These guards pin the removal so it
// cannot creep back, and pin the legacy cleanup that a node updated from a bot-era
// build still needs. Every absence check has a CONTROL that proves the same check sees the thing
// when it is there (R14): a guard that cannot fail protects nothing.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sandbox, LINUX_FAKES } from './helpers-ops-sandbox.mjs';
import { needPosixOps } from './helpers-platform.mjs';
import { stripJsComments } from './helpers-code.mjs';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { MEMBER_TOKEN } from './helpers-agent-lane.mjs';
import { proposeAction } from '../lib/autonomy.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const tracked = () => execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);

// ── Ops: nothing starts, supervises, registers or configures the bot ─────────────────────────
// stop.sh and stop.ps1 are deliberately NOT in this list: they carry the legacy cleanup below.
const OPS_FILES = ['start.sh', 'run.sh', 'install.sh', 'deploy.sh', 'migrate.sh', 'ops/service.sh',
  'start.ps1', 'run.ps1', 'install.ps1', 'ops/checks.ps1', 'package.json', 'config.example.json'];
const NAMES_BOT = /\bbot\b|telegram|botfather/i;

test('no start, run or install script, package.json or the example config names the bot', () => {
  // CONTROL: lines the pre-removal files really carried are caught by the same check.
  for (const old of ['nohup ./run.sh bot >/dev/null 2>&1 &', "Register-SuperelfTask 'superelf-bot' 'bot'",
    '"bot": "node bot.mjs",', '"telegram_bot_token": "PASTE_TOKEN_FROM_BOTFATHER",',
    "param([ValidateSet('web', 'bot')][string]$Target = 'web')"]) {
    assert.match(old, NAMES_BOT, `the check must catch: ${old}`);
  }
  for (const f of OPS_FILES) {
    const s = read(f);
    assert.ok(s.split('\n').length > 10, `CONTROL: ${f} was read`);
    const hit = s.split('\n').find((l) => NAMES_BOT.test(l));
    assert.equal(hit, undefined, `${f} still names the bot: ${hit}`);
  }
  assert.ok(!('bot' in JSON.parse(read('package.json')).scripts), 'no npm run bot');
});

test('run.sh supervises web only: `run.sh bot` is refused', { skip: needPosixOps }, () => {
  const sb = sandbox({ fakes: LINUX_FAKES, state: ['userbus'] });
  const r = sb.run('run.sh', ['bot'], { FAKE_NODE_STOP: '1' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /usage: \.\/run\.sh web/);
  assert.ok(!/^node /m.test(sb.calls()), 'no node was launched');
  // CONTROL: the same sandbox, asked for web, does launch node — so the refusal is the guard.
  assert.match(sb.run('run.sh', ['web'], { FAKE_NODE_STOP: '1' }).out, /\[supervisor\] watching web\.mjs/);
  assert.match(sb.calls(), /^node web\.mjs$/m);
});

// ── LEGACY cleanup, until every node is clean (TODO(legacy-bot) in stop.sh and stop.ps1) ──────
// A `run.sh bot` loop started before the update survives `git pull` and restarts the deleted
// bot.mjs every 2 s. The first stop after the update must end it. Delete these two tests together
// with the legacy code.
test('stop.sh still ends a leftover bot loop and a stray bot.mjs node — and nothing else', { skip: needPosixOps }, () => {
  const leftovers = ['bash ./run.sh bot', '/bin/bash /home/u/superelf/run.sh bot', 'node bot.mjs',
    'node ./bot.mjs', '/usr/bin/node /home/u/superelf/bot.mjs'];
  const bystander = '/usr/bin/node /home/u/superelf/other.mjs';
  const sb = sandbox({ fakes: LINUX_FAKES, ps: [...leftovers, bystander] });
  const r = sb.run('stop.sh');
  assert.equal(r.code, 0, r.out);
  assert.match(sb.calls(), /^pkill -f /m, 'CONTROL: the fake pkill was reached');
  assert.equal(sb.ps(), bystander + '\n', `only the bystander is left:\n${sb.ps()}`);
  assert.match(r.out, /^web: stopped$/m, 'the status line names web only');
  assert.match(read('stop.sh'), /TODO\(legacy-bot\)[^\n]*one-time cleanup/, 'the cleanup says when it can go');
});

test('stop.ps1 stops, then unregisters, the superelf-bot task — idempotently, before any kill', () => {
  const s = read('stop.ps1').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const get = s.indexOf('Get-ScheduledTask -TaskName $botTask -ErrorAction Stop');
  const stop = s.indexOf('Stop-ScheduledTask -TaskName $botTask');
  const unreg = s.indexOf('Unregister-ScheduledTask -TaskName $botTask -Confirm:$false -ErrorAction Stop');
  const kill = s.search(/^Stop-Procs /m);
  assert.match(s, /\$botTask = 'superelf-bot'/);
  assert.ok(get > 0 && get < stop && stop < unreg && unreg < kill,
    'looked up first (no task = no-op), stopped, unregistered, and all before the processes die');
  assert.match(s.slice(get, unreg), /if \(\$legacyTask\) \{/, 'unregister runs only when the task exists');
  assert.match(s.slice(unreg, kill), /catch \{\s*\n\s*Write-Host [^\n]*could not unregister/, 'a failed unregister is said, not swallowed (R5)');
  assert.match(s, /\$nodeRe = '\(web\|bot\)\\\.mjs'/, 'a stray bot.mjs node is still killed');
  assert.match(s, /-match 'run\\\.ps1' \}\) 'supervisors'/, 'every run.ps1 loop, bot included, is killed');
  assert.match(read('stop.ps1'), /TODO\(legacy-bot\)[^\n]*one-time cleanup/, 'the cleanup says when it can go');
  // CONTROL: nothing else touches that task — the installer registers web only.
  assert.ok(!/superelf-bot/.test(read('install.ps1')) && !/superelf-bot/.test(read('start.ps1')));
  assert.match(read('install.ps1'), /Register-SuperelfTask \$TASK 'web'/, 'CONTROL: the web task is still registered');
});

// ── Code: the bot and the modules only it used are gone, and nothing imports them ─────────────
const REMOVED_MODULES = ['bot.mjs', 'lib/telegram.mjs', 'lib/approve-telegram.mjs', 'lib/stream.mjs',
  'lib/format.mjs', 'lib/sessions.mjs', 'lib/chunk.mjs'];
const REMOVED_TESTS = ['test/approve-telegram.test.mjs', 'test/stream.test.mjs', 'test/format.test.mjs',
  'test/sessions.test.mjs', 'test/chunk.test.mjs'];
// Every relative module a source imports (static, side-effect, dynamic or re-export), as a repo path.
const importsOf = (rel, src) => [...stripJsComments(src).matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)]
  .map((m) => path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));

test('bot.mjs and the bot-only modules are gone, with their tests', () => {
  const files = new Set(tracked());
  assert.ok(files.has('web.mjs') && files.has('lib/notify.mjs'), 'CONTROL: the listing sees the files that stay');
  for (const f of [...REMOVED_MODULES, ...REMOVED_TESTS]) {
    assert.ok(!files.has(f) && !fs.existsSync(path.join(ROOT, f)), `${f} must stay deleted`);
  }
});

test('no tracked file imports a removed module', () => {
  // CONTROL: each import form the scanner must see, resolved from where it is written.
  assert.deepEqual(importsOf('web.mjs', "import { Telegram } from './lib/telegram.mjs';"), ['lib/telegram.mjs']);
  assert.deepEqual(importsOf('test/x.test.mjs', "const m = await import('../lib/chunk.mjs');"), ['lib/chunk.mjs']);
  assert.deepEqual(importsOf('lib/a.mjs', "export { x } from './stream.mjs';"), ['lib/stream.mjs']);
  assert.deepEqual(importsOf('lib/a.mjs', "// import { x } from './format.mjs';"), [], 'a comment is not an import');
  assert.ok(importsOf('web.mjs', read('web.mjs')).includes('lib/notify.mjs'), 'CONTROL: the real web.mjs is parsed');
  // This file names the removed paths in its controls, as strings; it imports none of them.
  const sources = tracked().filter((f) => /\.(mjs|js)$/.test(f) && f !== 'test/removed-telegram.test.mjs');
  assert.ok(sources.length > 100, `CONTROL: the scan covers the repo (${sources.length} files)`);
  for (const f of sources) {
    const bad = importsOf(f, read(f)).filter((m) => REMOVED_MODULES.includes(m));
    assert.deepEqual(bad, [], `${f} imports a removed module`);
  }
});

// ── Config: no server code reads a removed key ────────────────────────────────────────────────
// telegram covers telegram_bot_token, telegram_id, telegramEnabled and userByTelegram. Comments may
// still tell the history; code may not name any of it.
const REMOVED_KEY = /telegram|allowed_user_ids|owner_chat_id|deep_args|\bschedules\b/i;
test('no server code names a removed config key', () => {
  // CONTROL: lines the pre-removal server really carried are caught; a comment is not.
  for (const old of ['cfg.telegramEnabled = !!(cfg.telegram_bot_token && !/PASTE_TOKEN/.test(cfg.telegram_bot_token));',
    'validated.allowed_user_ids = [...new Set([...(validated.allowed_user_ids || []), ...tg])];',
    "cfg.deep_args = cfg.deep_args || ['--model', 'claude-fable-5'];", 'cfg.schedules = cfg.schedules || [];',
    'const ownerId = () => cfg.owner_chat_id || cfg.allowed_user_ids[0];',
    "telegram_id: u.telegram_id ? Number(u.telegram_id) : null,"]) {
    assert.match(stripJsComments(old), REMOVED_KEY, `the check must catch: ${old}`);
  }
  assert.doesNotMatch(stripJsComments('// telegram_id was removed (docs/adr/0006)\nconst a = 1;'), REMOVED_KEY);
  const server = tracked().filter((f) => /^([^/]+|lib\/.+|tools\/.+)\.mjs$/.test(f));
  for (const f of ['web.mjs', 'lib/config.mjs', 'lib/users.mjs', 'lib/adminconfig.mjs', 'tools/fetch-daily-digest.mjs']) {
    assert.ok(server.includes(f), `CONTROL: the scan covers ${f}`);
  }
  for (const f of server) {
    const hit = stripJsComments(read(f)).split('\n').find((l) => REMOVED_KEY.test(l));
    assert.equal(hit, undefined, `${f} still names a removed key: ${hit}`);
  }
});

// ── The user flow (R6), against the REAL server booted with a bot-era config.json ─────────────
// Pins web.mjs BOOTING with every lib it imports, plus what happens to the old data: the keys are
// ignored, never offered, never leaked, and users[].telegram_id falls away on the next save.
const LEGACY = { telegram_bot_token: '123456:LEGACY-telegram-token-9f9f', allowed_user_ids: [4242], owner_chat_id: 4242,
  schedules: [{ name: 'brief', time: '07:30', prompt: 'p' }], deep_args: ['--model', 'x', '--dangerously-skip-permissions'] };
const servers = [];
after(async () => { for (const s of servers) await stopWeb(s); });

test('a bot-era config.json boots; its keys are not offered, not leaked, and telegram_id drops on save', async () => {
  const port = await freePort();
  const root = mkWebRoot({ port, extraConfig: { ...LEGACY, users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', telegram_id: 4242 },
    { id: 'kid', name: 'Kid', role: 'member', token: MEMBER_TOKEN, workspace: 'workspace-kid', telegram_id: 77 },
  ] } });
  servers.push(startWeb(root)); await waitReady(port);
  const J = (p, opt) => api(port, p, opt);
  const res = await J('/api/admin/config');
  assert.equal(res.status, 200, 'the server is up and answering with the legacy config');
  const rows = await res.json();
  assert.ok(rows.some((r) => r.key === 'agentmail_key'), 'CONTROL: the view lists the settings that remain');
  assert.ok(!rows.some((r) => r.key === 'telegram_bot_token'), 'the bot token is not offered');
  assert.ok(!JSON.stringify(rows).includes(LEGACY.telegram_bot_token), 'and its value never leaves the server');
  const put = await J('/api/admin/config', { method: 'PUT', body: JSON.stringify({ key: 'telegram_bot_token', value: 'x' }) });
  assert.equal(put.status, 400, 'nor can it be written');
  assert.match((await put.json()).error, /Unknown or non-editable key/, 'refused as a key that does not exist');
  // An admin edit that still sends telegram_id (an old cached client) saves the users.
  const edit = await J('/api/admin/users/kid', { method: 'PUT', body: JSON.stringify({ name: 'Kid Two', telegram_id: 99 }) });
  assert.equal(edit.status, 200);
  const disk = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
  assert.equal(disk.users.find((u) => u.id === 'kid').name, 'Kid Two', 'CONTROL: the save did write');
  assert.ok(disk.users.every((u) => !('telegram_id' in u)), 'no user keeps a telegram_id, the old or the sent one');
  for (const [k, v] of Object.entries(LEGACY)) assert.deepEqual(disk[k], v, `${k} is left in config.json as it was`);
});

// With the bot gone, this route is the ONLY way to decide an approval: the longevity app's Pending
// Approvals reaches it through the shell relay. The bot's tests covered approve, deny, a replay
// and a foreign id; they went with the bot, so the route is pinned here, end to end (R6).
test('approvals are decided through the web route alone: approve, replay, deny, never another user\'s', async () => {
  const port = await freePort();
  const root = mkWebRoot({ port, extraConfig: { users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
    { id: 'kid', name: 'Kid', role: 'member', token: MEMBER_TOKEN, workspace: 'workspace-kid' },
  ] } });
  const owner = { id: 'owner', workspace: path.join(root, 'workspace') };
  for (const id of ['a-yes', 'a-no']) proposeAction(owner, { id, type: 'noop', title: 'Once', payload: { flag: id }, created: Date.now() });
  servers.push(startWeb(root)); await waitReady(port);
  const decide = async (id, verb, { token = OWNER_TOKEN, query = '' } = {}) =>
    (await api(port, `/api/actions/${id}/${verb}${query}`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).json();
  const queue = async () => (await (await api(port, '/api/actions')).json()).map((a) => a.id).sort();
  assert.deepEqual(await queue(), ['a-no', 'a-yes'], 'CONTROL: both wait in the queue the longevity app reads');
  assert.deepEqual(await decide('a-no', 'deny', { token: MEMBER_TOKEN }), { error: 'not found' }, 'a member cannot reach the owner\'s action');
  assert.deepEqual(await queue(), ['a-no', 'a-yes'], 'and it is still pending');
  const yes = await decide('a-yes', 'approve', { query: '?via=telegram' });
  assert.deepEqual([yes.status, yes.wasPending], ['done', true], 'approved and executed; the old ?via is ignored');
  const again = await decide('a-yes', 'approve');
  assert.deepEqual([again.status, again.wasPending], ['done', false], 'a replay changes nothing');
  const no = await decide('a-no', 'deny');
  assert.deepEqual([no.status, no.wasPending], ['denied', true]);
  assert.deepEqual(await queue(), [], 'nothing is left pending');
  const rows = fs.readFileSync(path.join(root, 'audit.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    .filter((r) => r.action === 'a-yes' || r.action === 'a-no');
  assert.deepEqual(rows.map((r) => r.ev).sort(), ['action-denied', 'action-done'], 'one audit row per real decision: none for the replay or the member');
  assert.ok(rows.every((r) => !('via' in r) && r.who === 'owner'), 'the rows are the owner\'s, with no via field');
});
