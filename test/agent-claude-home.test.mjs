// A confined lane can neither write nor read the CLI's own home · 受限通道不能读写 ~/.claude
//
// THE HOLE (measured 2026-10-12, Claude Code 2.1.161, ADR 0012): the CLI lets every lane
// Write and Read its auto-memory store, ~/.claude/projects/<git root>/memory/. Turning the load off
// (test/agent-auto-memory.test.mjs) left both open: an app could still plant text that the owner's
// own interactive Claude Code sessions in the checkout load, and could read the owner's memory.
// THE FIX: every confined lane's `--disallowedTools` also carries `Edit(~/.claude/**)` and
// `Read(~/.claude/**)` (lib/agent-origin.mjs CONFINED_DENY_ARGS). An explicit deny beats the CLI's
// own allow for its store (measured).
//
// Layers: laneArgs driven directly, then each confined path end to end over HTTP on the fake CLI
// (test/helpers-agent-lane.mjs), which honours exactly those two rules: a member's own chat, its
// chat-to-job resolver and /api/jobs/resolve, an app's chat turn and /api/ask (owner's and member's),
// and the Verify panel (an app's and a member's). R14: the owner's composer,
// which carries no deny, writes and reads the store through the same fake, so the absence of a
// write or a read below means something.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ORIGIN_HEADER, APP_ORIGIN_VALUE, laneArgs } from '../lib/agent-origin.mjs';
import { api } from './helpers-web.mjs';
import { startLaneServer, assessDone, fakeMemoryDir, flagValues, CONFINED_DENIES, SKIP, MEMBER_TOKEN } from './helpers-agent-lane.mjs';

const APP_HDR = { [APP_ORIGIN_HEADER]: APP_ORIGIN_VALUE };
const SEED = 'seeded-owner-memory';

// STORE: the one memory store every workspace of the checkout shares (the lane root has a .git),
// seeded with something to read, as the live store holds the owner's memory.
let L, STORE;
const storeText = () => {
  try { return fs.readFileSync(path.join(STORE, 'MEMORY.md'), 'utf8'); }
  catch { return ''; } // no store yet: the assertions that need one fail and say so
};
after(async () => { if (L) await L.stop(); });
before(async () => {
  L = await startLaneServer();
  const t = L.tag('cwd');
  await L.chat({ message: `hello ${t}` });
  STORE = fakeMemoryDir(L.log, L.spawns(t)[0].cwd);
  fs.mkdirSync(STORE, { recursive: true });
  fs.writeFileSync(path.join(STORE, 'MEMORY.md'), `${SEED}\n`);
});

test('laneArgs: every confined lane denies Bash and ~/.claude; the owner\'s composer does not', () => {
  const base = ['--dangerously-skip-permissions'];
  const member = ['--permission-mode', 'acceptEdits'];
  const denies = (args) => flagValues(args, '--disallowedTools');
  assert.deepEqual(denies(laneArgs({ role: 'owner' }, base, member, { fromApp: false })), [], 'CONTROL: the owner\'s own chat is untouched');
  for (const [what, user, origin] of [
    ['a member\'s own chat', { role: 'member' }, { fromApp: false }],
    ['an app turn, owner', { role: 'owner' }, { fromApp: true, app: 'notes' }],
    ['an app turn, member', { role: 'member' }, { fromApp: true, app: 'notes' }],
    ['an unstated origin', { role: 'owner' }, undefined],
  ]) {
    const args = laneArgs(user, base, member, origin);
    assert.deepEqual(denies(args), CONFINED_DENIES, what);
    assert.equal(args.filter((a) => a === '--disallowedTools').length, 1, `${what}: one --disallowedTools, carrying every rule`);
  }
});

// A turn whose message asks the fake to write the store (FAKE-REMEMBER) and read it
// (FAKE-READ-MEMORY): every Claude spawn it causes carries the denies, nothing was read, and the store
// is unchanged. `settle` waits for spawns that run after the reply (the Verify panel).
async function assertHomeClosed(what, send, { min = 1, settle } = {}) {
  const was = storeText();
  const t = L.tag('home');
  const reply = await send(`FAKE-REMEMBER planted-${t} FAKE-READ-MEMORY ${t}`);
  if (settle) await settle(reply);
  const cl = L.spawns(t).filter((s) => s.cli === 'claude');
  assert.ok(cl.length >= min, `${what}: CONTROL — the fake claude ran ${min}+ times (ran ${cl.length})`);
  for (const s of cl) assert.equal(s.read, null, `${what}: the store was read`);
  assert.equal(storeText(), was, `${what}: the store was written`);
  for (const s of cl) assert.deepEqual(flagValues(s.argv, '--disallowedTools'), CONFINED_DENIES, `${what}: the denies reached the spawn`);
  return cl;
}
const chat = (body, opts) => (message) => L.chat({ message, ...body }, opts);

test('CONTROL: the owner\'s composer, which has no deny, writes and reads the store', async () => {
  const t = L.tag('owner');
  await L.chat({ message: `FAKE-REMEMBER owner-wrote-${t} FAKE-READ-MEMORY ${t}` });
  const [s] = L.spawns(t);
  assert.ok(s.argv.includes(SKIP), 'the unrestricted lane');
  assert.match(String(s.read), new RegExp(SEED), 'the fake reads the store when the lane may');
  assert.match(storeText(), new RegExp(`owner-wrote-${t}`), 'the fake writes the store when the lane may');
});

test('a member\'s own chat', async () => {
  await assertHomeClosed('member composer', chat({}, { token: MEMBER_TOKEN }));
});

test('an app\'s chat turn, in the owner\'s session and in a member\'s', async () => {
  await assertHomeClosed('owner app chat', chat({ app: 'notes' }, { headers: APP_HDR }));
  await assertHomeClosed('member app chat', chat({ app: 'notes' }, { token: MEMBER_TOKEN, headers: APP_HDR }));
});

test('/api/ask, in the owner\'s session and in a member\'s', async () => {
  for (const [who, token] of [['owner', undefined], ['member', MEMBER_TOKEN]]) {
    await assertHomeClosed(`${who} app ask`, async (message) => {
      assert.equal((await L.ask({ message }, { token, headers: APP_HDR })).text, 'ANSWERED');
    });
  }
});

test('a member\'s chat-to-job resolver, and /api/jobs/resolve', async () => {
  await assertHomeClosed('member chat-to-job', (m) => L.chat({ message: `every morning tell me the pollen ${m}` }, { token: MEMBER_TOKEN }), { min: 2 });
  await assertHomeClosed('member /api/jobs/resolve', async (m) => {
    const r = await api(L.port, '/api/jobs/resolve', { method: 'POST', body: JSON.stringify({ prompt: `every morning tell me the pollen ${m}` }), headers: { authorization: `Bearer ${MEMBER_TOKEN}` } });
    await r.text(); // its status is not the point: the fake's reply is no job, so this 400s after the spawn
  });
});

test('the Verify panel, an app\'s and a member\'s', async () => {
  for (const [what, body, opts] of [
    ['app Verify panel', { app: 'notes', assess: true }, { headers: APP_HDR }],
    ['member Verify panel', { assess: true }, { token: MEMBER_TOKEN }],
  ]) {
    const settle = (ev) => assessDone(L.port, ev.find((e) => e.type === 'convo').id, ev.find((e) => e.type === 'assess').aid, opts.token);
    const cl = await assertHomeClosed(what, chat(body, opts), { min: 2, settle });
    assert.ok(cl.some((s) => s.argv.includes('opus-test')), `${what}: CONTROL — the panel's own Claude call was spawned and checked`);
  }
});
