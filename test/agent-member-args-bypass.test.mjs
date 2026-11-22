// The bypass in member_args reaches no confined lane · member_args 里的绕过参数到不了受限通道
//
// THE HOLE (R13 review, 2026-10-12): laneArgs stripped --dangerously-skip-permissions from `base`
// only. config.json `member_args` is appended after it, so an operator who put the bypass there gave
// it to a member's own chat AND to every app turn (owner's and member's), beside the deny list.
// Measured since (lib/agent-origin.mjs): the denies hold under the bypass, but the bypass voids the
// cwd boundary and `default` mode, so such a lane could write next to config.json.
// THE FIX: laneArgs strips every spelling of the bypass from base and member_args together
// (lib/agent-origin.mjs withoutBypass).
//
// The real web.mjs on the fake CLI (test/helpers-agent-lane.mjs), booted with member_args carrying
// the bypass in every spelling the CLI accepts, one pair a struck token would join (R13 round 2),
// and a flag left without its value at the end, which takes the next token as the CLI does (R13
// round 1: it must find nothing that confines there). Each lane is checked by argv AND by effect: a write
// OUTSIDE its cwd (what the bypass grants), Bash, and the store. R14: the owner's composer, which
// keeps the bypass and carries no deny, does all three through the same fake.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ORIGIN_HEADER, APP_ORIGIN_VALUE } from '../lib/agent-origin.mjs';
import { api } from './helpers-web.mjs';
import { startLaneServer, assertAppLane, assessDone, fakeMemoryDir, flagValues, isBypassArg, CONFINED_DENIES, SKIP, MEMBER_TOKEN } from './helpers-agent-lane.mjs';

const APP_HDR = { [APP_ORIGIN_HEADER]: APP_ORIGIN_VALUE };
const MEMBER_ARGS = ['--permission-mode', 'acceptEdits', SKIP, '--permission-mode', 'bypassPermissions',
  '--permission-mode=bypassPermissions', '--permission-mode', SKIP, 'bypassPermissions', '--model'];
let L, WS, KID, STORE;
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };   // absent: asserted on by callers
const storeText = () => read(path.join(STORE, 'MEMORY.md')) || '';
after(async () => { if (L) await L.stop(); });
before(async () => {
  L = await startLaneServer({ extraConfig: { member_args: MEMBER_ARGS } });
  WS = path.join(L.root, 'workspace'); KID = path.join(L.root, 'workspace-kid');
  const t = L.tag('cwd');
  await L.chat({ message: `hello ${t}` });
  STORE = fakeMemoryDir(L.log, L.spawns(t)[0].cwd);
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(path.join(STORE, 'MEMORY.md'), 'seeded\n');
});

// One turn asking the fake for a write outside the cwd (into the root, beside config.json), Bash, a
// store write and a store read. Every Claude spawn it causes lacks the bypass and carries the
// denies, and none of the four happened. Only the argv check and the outside write tell the fix from
// the base: the denies were there too, and they hold under the bypass (measured; the fake honours
// them). Bash and the store are checked because every confined lane must keep them shut.
async function assertNoBypass(what, dir, send, { min = 1, settle } = {}) {
  fs.rmSync(path.join(dir, 'bash.txt'), { force: true });
  const was = storeText();
  const t = L.tag('nobypass');
  const reply = await send(`FAKE-WRITE ../planted-${t}.txt X FAKE-BASH FAKE-REMEMBER planted-${t} FAKE-READ-MEMORY ${t}`);
  if (settle) await settle(reply);
  const cl = L.spawns(t).filter((s) => s.cli === 'claude');
  assert.ok(cl.length >= min, `${what}: CONTROL — the fake claude ran ${min}+ times (ran ${cl.length})`);
  for (const s of cl) {
    assert.ok(!s.argv.some(isBypassArg), `${what}: the bypass reached the spawn ${JSON.stringify(s.argv)}`);   // a --settings JSON naming the mode is its own route, checked by effect below
    assert.deepEqual(flagValues(s.argv, '--disallowedTools'), CONFINED_DENIES, `${what}: the denies`);
    assert.equal(s.read, null, `${what}: the store was read`);
  }
  assert.equal(read(path.join(L.root, `planted-${t}.txt`)), null, `${what}: wrote outside its cwd`);
  assert.equal(read(path.join(dir, 'bash.txt')), null, `${what}: Bash ran`);
  assert.equal(storeText(), was, `${what}: the store was written`);
  return cl;
}
const chat = (body, opts) => (message) => L.chat({ message, ...body }, opts);

test('CONTROL: the owner\'s composer keeps the bypass, and the fake then writes outside, runs Bash, writes the store', async () => {
  fs.rmSync(path.join(WS, 'bash.txt'), { force: true });
  const t = L.tag('owner');
  await L.chat({ message: `FAKE-WRITE ../planted-${t}.txt X FAKE-BASH FAKE-REMEMBER owner-${t} ${t}` });
  assert.ok(L.spawns(t)[0].argv.includes(SKIP), 'the unrestricted lane');
  assert.equal(read(path.join(L.root, `planted-${t}.txt`)), 'X');
  assert.equal(read(path.join(WS, 'bash.txt')), 'ran');
  assert.match(storeText(), new RegExp(`owner-${t}`));
  fs.rmSync(path.join(WS, 'bash.txt'), { force: true });
});

test('a member\'s own chat: member_args\' mode stays, its bypass does not', async () => {
  const [s] = await assertNoBypass('member composer', KID, chat({}, { token: MEMBER_TOKEN }));
  // The pin first, then member_args' own mode: the CLI applies the last (measured).
  assert.deepEqual(flagValues(s.argv, '--permission-mode'), ['default', 'acceptEdits']);
});

test('an app\'s chat turn and /api/ask, in the owner\'s session and in a member\'s', async () => {
  for (const [who, token, dir] of [['owner', undefined, WS], ['member', MEMBER_TOKEN, KID]]) {
    assertAppLane(await assertNoBypass(`${who} app chat`, dir, chat({ app: 'notes' }, { token, headers: APP_HDR })), `${who} app chat`);
    assertAppLane(await assertNoBypass(`${who} app ask`, dir, async (message) => {
      assert.equal((await L.ask({ message, app: 'notes' }, { token, headers: APP_HDR })).text, 'ANSWERED');
    }), `${who} app ask`);
  }
});

test('a member\'s chat-to-job resolver, and /api/jobs/resolve', async () => {
  await assertNoBypass('member chat-to-job', KID, (m) => L.chat({ message: `every morning tell me the pollen ${m}` }, { token: MEMBER_TOKEN }), { min: 2 });
  await assertNoBypass('member /api/jobs/resolve', KID, async (m) => {
    const r = await api(L.port, '/api/jobs/resolve', { method: 'POST', body: JSON.stringify({ prompt: `every morning tell me the pollen ${m}` }), headers: { authorization: `Bearer ${MEMBER_TOKEN}` } });
    await r.text(); // its status is not the point: the fake's reply is no job, so this 400s after the spawn
  });
});

test('the Verify panel, an app\'s in the owner\'s session and a member\'s', async () => {
  for (const [what, dir, body, opts] of [
    ['owner app Verify panel', WS, { app: 'notes', assess: true }, { headers: APP_HDR }],
    ['member Verify panel', KID, { assess: true }, { token: MEMBER_TOKEN }],
  ]) {
    const settle = (ev) => assessDone(L.port, ev.find((e) => e.type === 'convo').id, ev.find((e) => e.type === 'assess').aid, opts.token);
    const cl = await assertNoBypass(what, dir, chat(body, opts), { min: 2, settle });
    assert.ok(cl.some((s) => s.argv.includes('opus-test')), `${what}: CONTROL — the panel's own Claude call was spawned and checked`);
  }
});

// THE SETTINGS ROUTE (R13 round 1, 2026-10-13): a `--settings` whose permissions.defaultMode is the
// bypass IS the bypass on a lane whose argv names no mode (measured); a mode on argv beats it. So
// every confined lane pins one. Last in this file: it edits member_args live (read at use, ADR 0011)
// to carry only that --settings, and waits until a member's spawn shows it. CONTROL (R14): the same
// edit gives claude_args only that --settings, so the owner's composer, which is unconfined and
// pins nothing, runs on it: the fake applies the settings' bypass there and writes outside.
const RELOAD_MS = 15000;   // a poll (1 s) + the settle (2 polls), with a loaded machine's margin
test('a --settings defaultMode bypass in member_args applies to no confined lane', async () => {
  const BYPASS = JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } });
  const cfgPath = path.join(L.root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  fs.writeFileSync(`${cfgPath}.tmp`, JSON.stringify({ ...cfg, claude_args: ['--settings', BYPASS], member_args: ['--settings', BYPASS] }, null, 2));
  fs.renameSync(`${cfgPath}.tmp`, cfgPath);
  for (const t0 = Date.now(); ;) {
    const t = L.tag('reload');
    await L.chat({ message: `hi ${t}` }, { token: MEMBER_TOKEN });
    if (L.spawns(t)[0].settings === BYPASS) break;   // CONTROL: the operator's settings reach the spawn
    if (Date.now() - t0 > RELOAD_MS) assert.fail(`member_args not reloaded after ${RELOAD_MS} ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
  const o = L.tag('owner-settings');
  await L.chat({ message: `FAKE-WRITE ../planted-${o}.txt X ${o}` });
  assert.ok(!L.spawns(o)[0].argv.includes(SKIP), 'CONTROL: no bypass flag on the owner\'s lane now');
  assert.equal(read(path.join(L.root, `planted-${o}.txt`)), 'X', 'CONTROL: the fake applies a settings defaultMode when argv names no mode');
  const [s] = await assertNoBypass('member composer, settings route', KID, chat({}, { token: MEMBER_TOKEN }));
  assert.equal(s.settings, BYPASS, 'the settings rode along');
  assert.deepEqual(flagValues(s.argv, '--permission-mode'), ['default'], 'and the pinned mode beats it');
  assertAppLane(await assertNoBypass('owner app chat, settings route', WS, chat({ app: 'notes' }, { headers: APP_HDR })), 'owner app chat, settings route');
});
