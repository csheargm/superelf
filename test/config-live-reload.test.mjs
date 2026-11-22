// Live config, end to end (R6, docs/adr/0011): the REAL web.mjs from this checkout, a throwaway root,
// a FAKE `claude` that records its argv (test/helpers-agent-lane.mjs). config.json is edited while
// the server runs, and the very next oneShot turn's argv shows the edit — the same process, no
// restart. A bad edit (invalid JSON) leaves the last good config in force, and is audited. The
// --settings rule (an operator's always wins, docs/adr/0008) is checked on a real argv, and on what
// the CLI would apply: the fake records the FIRST --settings, as the real CLI honours only that one
// (test/helpers-agent-lane.mjs). Accounts
// stay in memory, and the watcher's reload never writes config.json (a users[] edit caught mid-save
// is not persisted); the explicit admin reload still loads in full (control).
//
// Each step waits for the effect it claims, never a fixed sleep: the watcher polls (1 s) and reloads
// once the file has been quiet for two polls, so a step retries a fresh oneShot turn until its argv
// changes, bounded.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startLaneServer, flagValues, MEMBER_TOKEN } from './helpers-agent-lane.mjs';
import { waitFor, api, OWNER_TOKEN, LISTEN_PREFIX } from './helpers-web.mjs';
import { APP_ORIGIN_HEADER, APP_ORIGIN_VALUE } from '../lib/agent-origin.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const APP_HDR = { [APP_ORIGIN_HEADER]: APP_ORIGIN_VALUE };   // what the shell relay adds (the Journal's path)
const BOOT = '{"probe":"boot"}', LIVE = '{"probe":"live"}';
const RELOAD_MS = 15000;   // a poll (1 s) + the settle (2 polls), with a loaded machine's margin

let L, cfgPath, pid;
before(async () => {
  L = await startLaneServer({ extraConfig: { one_shot_args: ['--settings', BOOT] } });
  cfgPath = path.join(L.root, 'config.json');
  pid = L.web.child.pid;
});
after(async () => { if (L) { await L.stop(); rmTemp(L.root); } });

const readCfg = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
// An editor's save: a temp file renamed over config.json (a new inode under the same name).
const saveCfg = (obj) => { const tmp = `${cfgPath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, cfgPath); };
const audits = () => {
  let txt = ''; try { txt = fs.readFileSync(path.join(L.root, 'audit.log'), 'utf8'); } catch { /* no audit yet — an empty list */ }
  return txt.split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const webLog = () => { try { return fs.readFileSync(L.web.logFile, 'utf8'); } catch { return ''; } };
// The server is the one booted in before(): same pid, still running, booted once.
function sameServer() {
  assert.equal(L.web.child.pid, pid);
  assert.equal(L.web.child.exitCode, null, 'the server never exited');
  assert.equal(webLog().split(LISTEN_PREFIX).length - 1, 1, 'it booted exactly once');
}

// One turn as the Journal sends it (an app turn through the shell relay), and the CLI run it got.
async function runOf(name, extra = { oneShot: true }) {
  const t = L.tag(name);
  const ev = await L.chat({ app: 'journal', message: `design ${t}`, ...extra }, { headers: APP_HDR });
  assert.equal(ev.at(-1).type, 'done');
  const s = L.spawns(t);
  assert.equal(s.length, 1, `${name}: one turn, one CLI run`);
  return s[0];
}
const argvOf = async (name, extra) => (await runOf(name, extra)).argv;
// Every --settings value in argv order, both forms: "--settings x" and "--settings=x".
const allSettings = (argv) => argv.flatMap((a, i) => (a === '--settings' ? [argv[i + 1]] : a.startsWith('--settings=') ? [a.slice('--settings='.length)] : []));
const settingsOf = async (name) => allSettings(await argvOf(name));
// Retries fresh oneShot turns until the argv shows the edit (the reload is asynchronous).
async function untilSettings(want, what) {
  const t0 = Date.now();
  for (let last; ;) {
    last = await settingsOf(what);
    if (JSON.stringify(last) === JSON.stringify(want)) return;
    if (Date.now() - t0 > RELOAD_MS) assert.fail(`${what}: still ${JSON.stringify(last)} after ${RELOAD_MS} ms, want ${JSON.stringify(want)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('boot: one_shot_args from config.json rides a oneShot turn (control: a conversation turn does not)', async () => {
  assert.deepEqual(await settingsOf('boot'), [BOOT]);
  assert.deepEqual(flagValues(await argvOf('boot-plain', {}), '--settings'), [], 'CONTROL: no oneShot, no one_shot_args');
});

test('live: an edit to one_shot_args reaches the next oneShot turn — same process, no restart', async () => {
  saveCfg({ ...readCfg(), one_shot_args: ['--settings', LIVE] });
  await untilSettings([LIVE], 'live');
  sameServer();
});

test('a bad edit: the server keeps answering on the last good value, and audits config-reload-failed', async (t) => {
  const good = readCfg();
  // If an assertion below fails, the next tests still start from a file that parses.
  t.after(() => { try { readCfg(); } catch { saveCfg({ ...good, one_shot_args: [] }); } });
  // An unquoted value — JSON.parse's message then QUOTES the file around it, here the web_token.
  const text = JSON.stringify(good, null, 2).replace(`"${good.web_token}"`, good.web_token);
  assert.notEqual(text, JSON.stringify(good, null, 2), 'CONTROL: the edit really broke the file');
  fs.writeFileSync(cfgPath, text);
  const a = await waitFor(() => audits().find((x) => x.ev === 'config-reload-failed'), 'the config-reload-failed audit', { timeoutMs: RELOAD_MS });
  assert.match(a.error, /not valid JSON/, 'the reason is recorded');
  assert.ok(!a.error.includes(good.web_token.slice(0, 8)), `no part of the file's text reaches the audit: ${a.error}`);
  assert.deepEqual(await settingsOf('after-bad'), [LIVE], 'the last good one_shot_args is still in force');
  sameServer();
  // Recovery: a good edit after the bad one applies, and [] is honoured — nothing is added.
  saveCfg({ ...good, one_shot_args: [] });
  await untilSettings([], 'recovered-empty');
  sameServer();
});

// main's model-check keys (ADR 0007) ride the same watcher. The job's schedule is a getter over
// cfg.model_check_time, so a reload moves it with no restart; the read-only load keeps the accounts,
// so nodeOwnerId still names the owner and the member still gets no ownerOnly job; and the HH:MM
// check refuses a bad time on this path too, keeping the last good one.
const modelCheckRow = async (token = OWNER_TOKEN) => {
  const r = await api(L.port, '/api/jobs', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  return (await r.json()).find((x) => x.name === 'model-check');
};
async function untilSchedule(want, what) {
  const t0 = Date.now();
  for (let last; ;) {
    last = (await modelCheckRow()).schedule;
    if (last === want) return;
    if (Date.now() - t0 > RELOAD_MS) assert.fail(`${what}: still ${last} after ${RELOAD_MS} ms, want ${want}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
test('model_check_time is live too: a reload moves the model-check schedule, a bad time keeps the last good one, the owner still runs it', async () => {
  assert.equal((await modelCheckRow()).schedule, 'daily · 每日 06:00', 'CONTROL: the loader default');
  assert.equal(await modelCheckRow(MEMBER_TOKEN), undefined, 'CONTROL: ownerOnly — the member has no model-check row');
  saveCfg({ ...readCfg(), model_check_time: '21:15' });
  await untilSchedule('daily · 每日 21:15', 'model-check-moved');
  assert.equal(await modelCheckRow(MEMBER_TOKEN), undefined, 'after the read-only reload the member still has none');
  saveCfg({ ...readCfg(), model_check_time: '25:00' });
  await waitFor(() => audits().find((x) => x.ev === 'config-reload-failed' && /model_check_time: not HH:MM/.test(x.error)), 'the refused time audited', { timeoutMs: RELOAD_MS });
  assert.equal((await modelCheckRow()).schedule, 'daily · 每日 21:15', 'the last good time is still in force');
  const now = readCfg();
  delete now.model_check_time;   // a key with a default goes back to it (docs/adr/0011, Exceptions)
  saveCfg(now);
  await untilSchedule('daily · 每日 06:00', 'model-check-default');
  sameServer();
});

// docs/adr/0008: the claude CLI honours only the FIRST --settings, and an operator's always wins.
test('an operator --settings in claude_args wins: a oneShot turn carries exactly one, the operator\'s (control: none → one_shot_args\')', async () => {
  const warned = /claude_args passes --settings, so oneShot turns drop one_shot_args' --settings: the operator's settings win/;
  assert.doesNotMatch(webLog(), warned, 'CONTROL: no warning before the clashing edit');
  // CONTROL: no operator --settings → one_shot_args' rides, with its other flags.
  saveCfg({ ...readCfg(), one_shot_args: ['--settings', '{"probe":"one"}', '--effort', 'low'] });
  await untilSettings(['{"probe":"one"}'], 'no-operator');
  for (const [form, op] of [['pair', ['--settings', '{"probe":"operator"}']], ['equals', ['--settings={"probe":"operator"}']]]) {
    saveCfg({ ...readCfg(), claude_args: ['--dangerously-skip-permissions', ...op] });
    await untilSettings(['{"probe":"operator"}'], `operator-${form}`);   // exactly one: the operator's
    const run = await runOf(`operator-${form}-flags`);
    assert.equal(run.settings, '{"probe":"operator"}', `${form}: what the CLI applies`);
    assert.deepEqual(flagValues(run.argv, '--effort'), ['low'], `${form}: one_shot_args' other flags still ride`);
    assert.deepEqual(allSettings(await argvOf(`operator-${form}-plain`, {})), ['{"probe":"operator"}'], `${form}: CONTROL: a conversation turn has the operator's too`);
  }
  await waitFor(() => warned.test(webLog()), 'the clash warning in the server log');
  sameServer();
});

// member_args comes AFTER one_shot_args on a confined turn, and the CLI honours only the FIRST
// --settings: kept, one_shot_args' default would silently beat the operator's member settings
// (possibly hardening). So a confined turn drops one_shot_args' --settings (lib/one-shot.mjs).
test('member_args\' --settings wins on a confined oneShot turn: one_shot_args\' is dropped, its other flags ride', async () => {
  const now = readCfg();
  delete now.claude_args;
  saveCfg({ ...now, one_shot_args: ['--settings', '{"probe":"one"}', '--effort', 'low'], member_args: ['--permission-mode', 'acceptEdits', '--settings', '{"probe":"member"}'] });
  await untilSettings(['{"probe":"member"}'], 'member-wins');   // exactly one: the operator's
  const run = await runOf('member-wins-applied');
  assert.equal(run.settings, '{"probe":"member"}', 'what the CLI applies: member_args\'');
  assert.deepEqual(flagValues(run.argv, '--effort'), ['low'], 'one_shot_args\' other flags still ride');
  await waitFor(() => /member_args passes --settings, so every confined turn .*drops the --settings of one_shot_args and fast_args/.test(webLog()), 'the member_args warning in the server log');
  sameServer();
});

// Both operator values: two --settings reach the CLI, and it applies the FIRST — claude_args'.
// Under a last-wins model this test fails (it would see member_args'), which is the point.
// The loader's lines for this reload agree with what the CLI applied: member_args' is named only for
// the confined fast-lane asks, never for this confined oneShot turn (SCAR: it used to say "every
// confined turn" runs with member_args' while the next line said it is IGNORED there).
test('claude_args AND member_args pass --settings: the CLI applies claude_args\' (first), member_args\' is ignored, and the loader says so', async () => {
  const everyConfined = () => webLog().split('member_args passes --settings, so every confined turn').length - 1;
  const before = everyConfined();
  assert.ok(before >= 1, 'CONTROL: the member_args-only edit above logged the every-confined-turn line');
  saveCfg({ ...readCfg(), claude_args: ['--dangerously-skip-permissions', '--settings', '{"probe":"operator"}'] });
  await untilSettings(['{"probe":"operator"}', '{"probe":"member"}'], 'both-operators');   // argv order: claude_args, then member_args
  assert.equal((await runOf('both-operators-applied')).settings, '{"probe":"operator"}', 'the first one is the one applied');
  await waitFor(() => /claude_args and member_args both pass --settings.*on a confined chat, oneShot or Verify turn member_args' settings are IGNORED and claude_args' apply/.test(webLog()), 'the claude_args + member_args warning in the server log');
  assert.match(webLog(), /member_args passes --settings, so every confined fast-lane ask \(\/api\/ask, the job resolver.*\) drops the --settings of fast_args: /, 'member_args\' outcome, named for the asks only');
  assert.equal(everyConfined(), before, 'this reload never claims member_args\' applies to every confined turn');
  sameServer();
});

// docs/adr/0011 item 6: the server writes accounts itself (memory first, the file after an await), so
// the watcher leaves them as they are in memory. A hand edit of users[] waits for a restart or
// POST /api/admin/reload-config; removing someone at once is the admin page's job.
test('accounts are not reloaded by the watcher: a hand-removed member still signs in until a restart', async () => {
  const asKid = async () => (await api(L.port, '/api/convos', { headers: { authorization: `Bearer ${MEMBER_TOKEN}` } })).status;
  assert.equal(await asKid(), 200, 'CONTROL: the member signs in before the edit');
  // The clash keys of the step above are deleted, so they go back to their defaults (no --settings).
  const now = readCfg();
  delete now.claude_args; delete now.member_args;
  saveCfg({ ...now, users: now.users.filter((u) => u.id !== 'kid'), one_shot_args: ['--settings', '{"probe":"accounts"}'] });
  await untilSettings(['{"probe":"accounts"}'], 'accounts');   // proves this very edit was reloaded
  assert.equal(await asKid(), 200, 'the in-memory account list is untouched');
  sameServer();
});

// ── The watcher's reload never writes config.json (docs/adr/0011 item 4) ──────────────────────────
// SCAR (R13 finding, confirmed): the watcher's reload ran the full loadConfig, whose resolveUsers
// normalizes users[] and writes it back. A hand edit caught mid-save — the owner's role mistyped,
// so "no owner" and users[0] is promoted — was persisted by a reload nobody asked for, and the
// next restart would have booted with the wrong owner. Run LAST: the control promotes the kid.
const MID_EDIT_USERS = [
  { id: 'kid', name: 'Kid', role: 'member', token: MEMBER_TOKEN, workspace: 'workspace-kid' },
  { id: 'owner', name: 'Owner', role: 'ownr', token: OWNER_TOKEN, workspace: 'workspace' },   // the typo
  { id: 'newbie', name: 'New', role: 'member', token: 'GENERATE', workspace: 'workspace-newbie' },   // a token to generate, a workspace to provision
];
const rolesAs = async (token) => {
  const r = await api(L.port, '/api/admin/users', { headers: { authorization: `Bearer ${token}` } });
  return r.status === 200 ? Object.fromEntries((await r.json()).map((u) => [u.id, u.role])) : r.status;
};

test('a users[] edit caught mid-save (owner role mistyped) leaves config.json byte-identical after the watcher reload; memory accounts unchanged', async () => {
  const roles = { owner: 'owner', kid: 'member' };
  assert.deepEqual(await rolesAs(OWNER_TOKEN), roles, 'CONTROL: the accounts in memory before the edit');
  saveCfg({ ...readCfg(), users: MID_EDIT_USERS, one_shot_args: ['--settings', '{"probe":"mid-edit"}'] });
  const saved = fs.readFileSync(cfgPath);
  await untilSettings(['{"probe":"mid-edit"}'], 'mid-edit');   // this very edit was reloaded (any write it made is done)
  assert.ok(fs.readFileSync(cfgPath).equals(saved), `config.json was rewritten by the watcher:\n${fs.readFileSync(cfgPath, 'utf8').slice(0, 600)}`);
  assert.ok(!fs.existsSync(path.join(L.root, 'workspace-newbie')), 'no workspace was provisioned');
  assert.deepEqual(await rolesAs(OWNER_TOKEN), roles, 'the accounts in memory are unchanged');
  assert.equal(await rolesAs(MEMBER_TOKEN), 403, 'and the kid is still not an owner');
  sameServer();
});

// Asserts the end state, not "the file changed here": the test above already proves the watcher
// wrote nothing, so the only writer left is this reload — and a broken watcher fails above alone.
test('CONTROL: POST /api/admin/reload-config still loads in full — it normalizes and writes users[], and provisions', async () => {
  const r = await api(L.port, '/api/admin/reload-config', { method: 'POST', body: '{}' });
  assert.equal(r.status, 200, await r.text());
  const users = Object.fromEntries(readCfg().users.map((u) => [u.id, u]));
  assert.equal(users.kid.role, 'owner', 'no valid owner in the file, so users[0] was promoted and saved');
  assert.equal(users.owner.role, 'member', 'the mistyped role was normalized and saved');
  assert.ok(users.newbie.token && users.newbie.token !== 'GENERATE', 'a token was generated and saved');
  assert.ok(fs.existsSync(path.join(L.root, 'workspace-newbie')), 'the new workspace was provisioned');
  assert.deepEqual(await rolesAs(MEMBER_TOKEN), { kid: 'owner', owner: 'member', newbie: 'member' }, 'memory took the file\'s accounts');
  sameServer();
});
