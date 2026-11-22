// Which lane and which flags a one-shot ask gets (docs/adr/0008), end to end (R6): the REAL web.mjs
// from this checkout, a throwaway root, a FAKE `claude` that records its argv
// (test/helpers-agent-lane.mjs), and a FAKE Ollama (node:http, the real /api/chat NDJSON shape)
// that records what it was asked. config.json is edited while the server runs.
//
//   one_shot_model (owner request): a design goes to Claude whatever the Journal's Ask-AI model is.
//     A oneShot turn is answered by cfg.one_shot_model (default "claude"), read per request; ""
//     means the request's own model; an unknown id warns at load and keeps the request's model.
//     The interactive composer is never affected.
//   fast_args (the thinking audit): the background asks default to thinking off; a fast_args
//     without it is honoured; on a confined turn member_args' --settings wins: fast_args' is dropped,
//     because the CLI honours only the FIRST --settings and member_args comes after it. That holds
//     at EVERY call site of web.mjs fastBaseArgs (R6, enumerated): /api/ask, the chat() job
//     resolver and /api/jobs/resolve.
//
// R14: every claim has its control, and each lane is proved by what the OTHER side did NOT see — a
// turn that reached Claude never reached Ollama, and the reverse.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { startLaneServer, flagValues, MEMBER_TOKEN } from './helpers-agent-lane.mjs';
import { api, OWNER_TOKEN } from './helpers-web.mjs';
import { APP_ORIGIN_HEADER, APP_ORIGIN_VALUE } from '../lib/agent-origin.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const APP_HDR = { [APP_ORIGIN_HEADER]: APP_ORIGIN_VALUE };   // what the shell relay adds
const THINKING_OFF = JSON.stringify({ alwaysThinkingEnabled: false });   // the spec, written out
const RELOAD_MS = 15000;   // a poll (1 s) + the settle (2 polls), with a loaded machine's margin

let L, ollama, cfgPath, pid;
const asked = [];   // every request the fake Ollama received: { model, text }
before(async () => {
  ollama = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }).on('end', () => {
      const j = JSON.parse(b);
      asked.push({ model: j.model, text: j.messages.map((m) => m.content).join('\n') });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(`${JSON.stringify({ message: { role: 'assistant', content: 'OLLAMA-ANSWER' }, done: false })}\n${JSON.stringify({ done: true })}\n`);
    });
  });
  await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
  L = await startLaneServer({ extraConfig: { ollama_url: `http://127.0.0.1:${ollama.address().port}` } });
  cfgPath = path.join(L.root, 'config.json');
  pid = L.web.child.pid;
});
after(async () => {
  if (L) { await L.stop(); rmTemp(L.root); }
  if (ollama) await new Promise((r) => ollama.close(r));
});

const readCfg = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const saveCfg = (obj) => { const tmp = `${cfgPath}.tmp`; fs.writeFileSync(tmp, JSON.stringify(obj, null, 2)); fs.renameSync(tmp, cfgPath); };
const webLog = () => { try { return fs.readFileSync(L.web.logFile, 'utf8'); } catch { return ''; } };
function sameServer() {
  assert.equal(L.web.child.pid, pid);
  assert.equal(L.web.child.exitCode, null, 'the server never exited');
}

// One chat turn; which lane answered it, proved from both sides.
async function laneOf(name, body, headers = APP_HDR) {
  const t = L.tag(name);
  const ev = await L.chat({ message: `design ${t}`, ...body }, { headers });
  const done = ev.at(-1);
  assert.equal(done.type, 'done', `${name}: the turn finished: ${JSON.stringify(ev).slice(0, 300)}`);
  const claude = L.spawns(t).length, olla = asked.filter((a) => a.text.includes(t));
  if (claude === 1 && olla.length === 0) { assert.equal(done.text, 'ANSWERED'); return 'claude'; }
  if (claude === 0 && olla.length === 1) { assert.equal(done.text, 'OLLAMA-ANSWER'); assert.equal(olla[0].model, 'x', 'the deepseek entry'); return 'ollama'; }
  return assert.fail(`${name}: claude spawns ${claude}, ollama requests ${olla.length}`);
}
const JOURNAL_DESIGN = { app: 'journal', model: 'deepseek', oneShot: true };   // the Journal's Ask-AI model is an Ollama one
async function untilLane(want, what, body = JOURNAL_DESIGN) {
  const t0 = Date.now();
  while ((await laneOf(what, body)) !== want) {
    if (Date.now() - t0 > RELOAD_MS) assert.fail(`${what}: still not ${want} after ${RELOAD_MS} ms`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// One /api/ask (the shell broker's 'ask' kind) and the CLI run it got: { argv, settings (the
// one --settings the CLI applies: the first), … } (test/helpers-agent-lane.mjs).
async function askRun(name) {
  const t = L.tag(name);
  const r = await L.ask({ message: `ask ${t}`, app: 'tasks' }, { headers: APP_HDR });
  assert.equal(r.text, 'ANSWERED', `${name}: the fake claude answered`);
  const s = L.spawns(t);
  assert.equal(s.length, 1, `${name}: one ask, one CLI run`);
  return s[0];
}
const askArgv = async (name) => (await askRun(name)).argv;
async function untilAskSettings(want, what) {
  const t0 = Date.now();
  for (let last; ;) {
    last = flagValues(await askArgv(what), '--settings');
    if (JSON.stringify(last) === JSON.stringify(want)) return;
    if (Date.now() - t0 > RELOAD_MS) assert.fail(`${what}: still ${JSON.stringify(last)} after ${RELOAD_MS} ms, want ${JSON.stringify(want)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ── one_shot_model ──────────────────────────────────────────────────────────────────────────
test('the Journal set to an Ollama model: a oneShot design goes to Claude (one_shot_model default)', async () => {
  assert.equal(readCfg().one_shot_model, undefined, 'CONTROL: config.json sets none — this is the loader default');
  assert.equal(await laneOf('design', JOURNAL_DESIGN), 'claude');
});

test('CONTROL: the interactive composer is unaffected — the same model, no oneShot, goes to Ollama', async () => {
  assert.equal(await laneOf('journal-ask', { app: 'journal', model: 'deepseek' }), 'ollama', 'an app\'s Ask-AI turn');
  assert.equal(await laneOf('composer', { model: 'deepseek' }, {}), 'ollama', 'the shell\'s own composer');
});

test('one_shot_model "" → the request\'s model (control); a live change applies with no restart, and back', async () => {
  saveCfg({ ...readCfg(), one_shot_model: '' });
  await untilLane('ollama', 'empty');
  sameServer();
  saveCfg({ ...readCfg(), one_shot_model: 'claude' });
  await untilLane('claude', 'back-to-claude');
  sameServer();
});

test('an unknown one_shot_model: a warning at load, and the request\'s model is used', async () => {
  const warned = /one_shot_model "nope" is not a chat_models id/;
  assert.doesNotMatch(webLog(), warned, 'CONTROL: no warning before the edit');
  saveCfg({ ...readCfg(), one_shot_model: 'nope' });
  await untilLane('ollama', 'unknown');
  assert.match(webLog(), warned);
  saveCfg({ ...readCfg(), one_shot_model: 'claude' });
  await untilLane('claude', 'restored');
  sameServer();
});

// ── fast_args: the background asks ────────────────────────────────────────────────────────────
test('/api/ask: the default fast_args turns thinking off (Haiku)', async () => {
  assert.equal(readCfg().fast_args, undefined, 'CONTROL: config.json sets none — this is the loader default');
  const argv = await askArgv('ask-default');
  assert.deepEqual(flagValues(argv, '--settings'), [THINKING_OFF]);
  assert.deepEqual(flagValues(argv, '--model'), ['haiku']);
});

test('CONTROL: a config fast_args without the setting is honoured (live)', async () => {
  saveCfg({ ...readCfg(), fast_args: ['--model', 'haiku', '--dangerously-skip-permissions'] });
  await untilAskSettings([], 'ask-custom');
  sameServer();
});

// SCAR: member_args comes AFTER fast_args, and the CLI honours only the FIRST --settings, so kept
// whole the default's thinking-off blob would silently beat the operator's member settings.
test('/api/ask: member_args\' --settings wins — fast_args\' is dropped, the argv order is unchanged (control: the default alone)', async () => {
  assert.equal((await askRun('ask-custom-applied')).settings, null, 'CONTROL: the custom fast_args above carries none');
  const now = readCfg();
  delete now.fast_args;   // back to the default (thinking off)
  saveCfg(now);
  await untilAskSettings([THINKING_OFF], 'ask-default-back');
  assert.equal((await askRun('ask-default-on')).settings, THINKING_OFF, 'CONTROL: with no member settings the default applies');
  saveCfg({ ...now, member_args: ['--permission-mode', 'acceptEdits', '--settings', '{"probe":"member"}'] });
  await untilAskSettings(['{"probe":"member"}'], 'ask-member');   // exactly one: the operator's
  const run = await askRun('ask-order');
  assert.equal(run.settings, '{"probe":"member"}', 'what the CLI applies: member_args\'');
  // What confines the lane first (lib/agent-origin.mjs laneArgs), then fast_args, then member_args.
  const at = (x) => run.argv.indexOf(x);
  assert.ok(at('--disallowedTools') >= 0 && at('--disallowedTools') < at('--permission-mode') && at('--permission-mode') < at('haiku')
    && at('haiku') < at('{"probe":"member"}'), JSON.stringify(run.argv));
  assert.match(webLog(), /member_args passes --settings, so every confined turn .*drops the --settings of one_shot_args and fast_args/);
  sameServer();
});

// ── The other two fastBaseArgs call sites (R6: enumerate, don't patch one site) ───────────────
// Each is proved by what the CLI APPLIES (the fake records the first --settings): a site reverted to
// agentArgs(user, cfg.fast_args, origin) keeps fast_args' thinking-off pair ahead of member_args',
// so the CLI would apply ours and ignore the operator's member settings. member_args is still the
// '{"probe":"member"}' of the test above, fast_args the default.
const MEMBER = '{"probe":"member"}';
const JOB_ASK = (t) => `every morning tell me the pollen ${t}`;   // lib/jobs/intent.mjs: a recurring instruction
// The one fast-lane run that carried `t` (the resolver's ask: Haiku from fast_args).
function resolverRun(t, what) {
  const s = L.spawns(t).filter((x) => flagValues(x.argv, '--model').includes('haiku'));
  assert.equal(s.length, 1, `${what}: one resolver ask on the fast lane`);
  return s[0];
}

test('the chat() job resolver: a member\'s job-shaped turn applies member_args\' --settings (control: the owner\'s own turn, the default)', async () => {
  assert.ok(JSON.stringify(readCfg().member_args).includes('member'), 'CONTROL: member_args still passes --settings');
  const t = L.tag('resolver-member');
  await L.chat({ message: JOB_ASK(t) }, { token: MEMBER_TOKEN });
  const run = resolverRun(t, 'member');
  assert.equal(run.settings, MEMBER, 'what the CLI applies: member_args\'');
  assert.deepEqual(flagValues(run.argv, '--settings'), [MEMBER], 'exactly one: fast_args\' was dropped');
  // CONTROL: the owner's composer is unconfined — no member_args — so fast_args' default applies whole.
  const c = L.tag('resolver-owner');
  await L.chat({ message: JOB_ASK(c) });
  assert.equal(resolverRun(c, 'owner').settings, THINKING_OFF);
});

async function jobsResolveRun(name, { token = OWNER_TOKEN, headers = {} } = {}) {
  const t = L.tag(name);
  const r = await api(L.port, '/api/jobs/resolve', { method: 'POST', body: JSON.stringify({ prompt: JOB_ASK(t) }), headers: { authorization: `Bearer ${token}`, ...headers } });
  assert.equal(r.status, 400, `${name}: the fake answers no JSON, so nothing resolves: ${await r.text()}`);
  return resolverRun(t, name);
}
test('/api/jobs/resolve: a confined call (a member\'s, an app\'s) applies member_args\' --settings (control: the owner\'s own, the default)', async () => {
  for (const [who, opts] of [['member', { token: MEMBER_TOKEN }], ['owner-app', { headers: APP_HDR }]]) {
    const run = await jobsResolveRun(`jobs-resolve-${who}`, opts);
    assert.equal(run.settings, MEMBER, `${who}: what the CLI applies: member_args'`);
    assert.deepEqual(flagValues(run.argv, '--settings'), [MEMBER], `${who}: exactly one: fast_args' was dropped`);
  }
  assert.equal((await jobsResolveRun('jobs-resolve-owner')).settings, THINKING_OFF, 'CONTROL: unconfined, no member_args — the default applies');
  sameServer();
});
