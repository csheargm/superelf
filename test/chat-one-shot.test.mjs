// oneShot: one answer for a component, not a conversation · 组件的一次性回答
//
// THE BUG (measured 2026-10-12 with the real CLI): the Journal's "AI设计 · Design with AI" sends
// one request through PAChat.complete → the shell relay → /api/chat → `claude -p --model sonnet`.
// With the user's adaptive thinking on, Sonnet drafted the whole SVG inside its thinking, hit the
// 32,000-token output cap with zero text, retried, and never answered (4 of 4 runs, >10 min). With
// `--settings '{"alwaysThinkingEnabled":false}'` a complete SVG came back in ~110-150 s. And when
// the studio gave up, nothing stopped: the server never killed the claude child, so retries piled
// up three claude processes holding every enqueue slot.
//
// So a request carrying `oneShot: true` (PAChat.complete sends it; the composer never does):
//   1. adds config.json's one_shot_args — by default `--settings {"alwaysThinkingEnabled":false}`,
//      thinking off (lib/one-shot.mjs; a custom or live-edited value: test/config-live-reload.test.mjs)
//      — and drops the app contract from the system prompt; nothing else;
//   2. is STOPPED when its caller leaves: the child is killed, "Cancelled" is stored, never the
//      killed child's raw stream-json, and the cancel is audited;
//   3. never spawns if its caller left while it was still queued;
//   4. never resumes and sends only its message (test/chat-one-shot-fresh.test.mjs, ADR 0008 item 9).
// Every one has a control (R14): a conversation turn keeps today's behaviour exactly — it is NOT
// killed when its stream drops, because the composer's pollForResult relies on the server finishing.
//
// END TO END (R6): the real web.mjs from this checkout on an ephemeral port, a throwaway root, and
// a FAKE `claude` (launched the way this OS launches the real one, test/helpers-platform.mjs) that
// records {ev, pid, argv, stdin} per spawn. Each test tags its messages and reads back only its own.
// On windows-latest the fake runs through the npm .cmd shim with shell:false, so the --settings
// JSON that test 1 parses back out of argv is the real Windows quoting round-trip.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor, api, OWNER_TOKEN, pidAlive as alive } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { flagValues } from './helpers-agent-lane.mjs';
import { agentCapabilities, appContract } from '../lib/config.mjs';
import { APP_ORIGIN_HEADER, APP_ORIGIN_VALUE } from '../lib/agent-origin.mjs';
import { cmdSafe } from '../lib/wincmd.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = appContract(ROOT);
const APP = 'journal';
// What the shell relay adds to every agent-reaching app request (web/index.html appAgentInit).
const APP_HDR = { [APP_ORIGIN_HEADER]: APP_ORIGIN_VALUE };
const CANCELLED_TEXT = '已取消 · Cancelled';

// The fake streams what the real CLI streams before its answer (the init line, a text delta), so a
// killed run leaves exactly the raw stream-json the server must never store. Instructions:
//   FAKE-SLOW <ms>     answer after <ms> — a run that is still in flight when its caller leaves
//   FAKE-GONE-EXIT     on --resume: print the CLI's "No conversation found" plus its empty error result, exit 1 (as the real one does)
// Only the CURRENT message instructs it (the history block replays old turns), as for the real CLI.
const fakeClaude = (log) => `#!/usr/bin/env node
import fs from 'node:fs'; import crypto from 'node:crypto';
const rec = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, ...o }) + '\\n');
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const argv = process.argv.slice(2), sid = crypto.randomUUID();
  rec({ ev: 'spawn', argv, stdin: s });
  const cur = s.includes('[Current message:]') ? s.slice(s.lastIndexOf('[Current message:]')) : s;
  if (argv.includes('--resume') && cur.includes('FAKE-GONE-EXIT')) {
    const gone = argv[argv.indexOf('--resume') + 1];
    process.stderr.write('No conversation found with session ID: ' + gone + '\\n');
    // The real CLI (2.x, measured 2026-11-12) ALSO prints an error result with NO text on stdout.
    // Without this line the fake hid the bug where that empty result masked the stderr reason.
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: gone }) + '\\n');
    // exitCode, not exit(): a pipe write is asynchronous on macOS, and exit() can drop it.
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'RAW-PARTIAL' } } }) + '\\n');
  const slow = /FAKE-SLOW (\\d+)/.exec(cur);
  setTimeout(() => {
    rec({ ev: 'finished', stdin: s });
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ANSWERED', session_id: sid }) + '\\n');
  }, slow ? Number(slow[1]) : 0);
});
`;

let port, root, web, log, seq = 0;
before(async () => {
  port = await freePort();
  // max_concurrent 1: one running turn holds the only enqueue slot, so the QUEUED test can wait behind it.
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, max_concurrent: 1 } });
  log = path.join(root, 'spawns.jsonl');
  const bin = path.join(root, 'fakebin');   // inside the root, under its package.json ("type": "module")
  fs.mkdirSync(bin);
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = writeFakeCli(bin, 'claude', fakeClaude(log));
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  web = startWeb(root);
  await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); if (root) rmTemp(root); });

const tag = (name) => `T-${name}-${++seq}-${Date.now()}`;
const records = (t, ev) => {
  let txt = ''; try { txt = fs.readFileSync(log, 'utf8'); } catch { /* nothing spawned yet — an empty list, asserted on by callers */ }
  return txt.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.ev === ev && r.stdin.includes(t));
};
const spawns = (t) => records(t, 'spawn');
const finished = (t) => records(t, 'finished');
const audits = () => {
  let txt = ''; try { txt = fs.readFileSync(path.join(root, 'audit.log'), 'utf8'); } catch { /* no audit yet — an empty list */ }
  return txt.split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const cancelAudit = (convoId) => audits().find((a) => a.ev === 'chat-cancelled' && a.convo === convoId);

// waitFor (helpers-web) polls a SYNCHRONOUS predicate; the stored conversation is read over HTTP.
async function storedTurn(convoId, count) {
  const until = Date.now() + 8000;
  for (;;) {
    const c = await (await api(port, `/api/convos/${convoId}`)).json();
    if (c.messages && c.messages.length >= count) return c;
    if (Date.now() > until) throw new Error(`convo ${convoId} never reached ${count} messages: ${JSON.stringify(c).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// One /api/chat request as the shell relays an app's 'chat': the origin header and the app slug.
// Read only up to its 'convo' line, so the test can leave mid-turn the way the studio does.
async function open(body) {
  const ac = new AbortController();
  const res = await api(port, '/api/chat', { method: 'POST', signal: ac.signal,
    headers: { authorization: `Bearer ${OWNER_TOKEN}`, ...APP_HDR }, body: JSON.stringify({ app: APP, ...body }) });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events = [];
  let buf = '';
  const until = async (pred) => {
    for (;;) {
      const hit = events.find(pred);
      if (hit) return hit;
      const { done, value } = await reader.read();
      if (done) throw new Error(`the stream ended without the event: ${JSON.stringify(events)}`);
      buf += dec.decode(value, { stream: true });
      for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) if (buf.slice(0, i).trim()) events.push(JSON.parse(buf.slice(0, i)));
    }
  };
  const convoId = (await until((e) => e.type === 'convo')).id;
  return { ac, convoId, done: () => until((e) => e.type === 'done') };
}

// The default one_shot_args, written out as the spec: this file's config.json sets none (asserted),
// so a oneShot turn carries the loader's default — thinking off.
const ONE_SHOT_DEFAULT = ['--settings', JSON.stringify({ alwaysThinkingEnabled: false })];
// Where `seq` starts as a contiguous run inside argv, or -1.
const runAt = (argv, seq) => argv.findIndex((_, i) => seq.every((x, j) => argv[i + j] === x));
// The prompt a run was given, and its argv with that prompt and the default one_shot_args taken out.
const promptOf = (argv) => argv[argv.indexOf('--append-system-prompt') + 1];
const rest = (argv) => {
  const a = [...argv];
  const i = runAt(a, ONE_SHOT_DEFAULT);
  if (i >= 0) a.splice(i, ONE_SHOT_DEFAULT.length);
  a[a.indexOf('--append-system-prompt') + 1] = '<prompt>';
  return a;
};
async function argvOf(name, extra) {
  const t = tag(name);
  const turn = await open({ message: `design a border ${t}`, ...extra });
  assert.equal((await turn.done()).text, 'ANSWERED', `${name}: the fake claude answered`);
  const s = spawns(t);
  assert.equal(s.length, 1, `${name}: one request, one CLI run`);
  return s[0].argv;
}

test('oneShot: the default one_shot_args (thinking off) and no app contract — nothing else changes (control: the same turn without it)', async () => {
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')).one_shot_args, undefined,
    'CONTROL: config.json sets no one_shot_args, so what arrives is the loader default');
  const plain = await argvOf('plain', {});
  const one = await argvOf('one', { oneShot: true });
  assert.ok(runAt(one, ONE_SHOT_DEFAULT) >= 0, `the default one_shot_args arrives whole, in order: ${JSON.stringify(one)}`);
  const settings = flagValues(one, '--settings');
  assert.equal(settings.length, 1, `exactly one --settings value: ${JSON.stringify(one)}`);
  assert.deepEqual(JSON.parse(settings[0]), { alwaysThinkingEnabled: false }, 'the JSON arrives whole and parses');
  // On a Windows node whose claude shim cannot be resolved, runner.mjs falls back to a shell that
  // cannot carry this value (the premise, pinned here), so it drops exactly this pair there, says
  // once that thinking stays on, and never mangles it (test/runner-shell-fallback.test.mjs).
  assert.equal(cmdSafe(settings[0]), false);
  assert.deepEqual(rest(one), rest(plain), 'every other flag is identical — --effort, model and confinement untouched');
  assert.ok(promptOf(one).endsWith(agentCapabilities('confined', null)), 'the language rule and the confined note still ride, last');
  assert.ok(!promptOf(one).includes('<!--PA_CHAT_UI-->') && !promptOf(one).includes(CONTRACT.slice(0, 80)), 'no app contract');
  // CONTROL: the conversation turn is exactly today's — and proves the harness sees what is absent above.
  assert.deepEqual(flagValues(plain, '--settings'), [], 'CONTROL: no --settings on a conversation turn');
  assert.ok(promptOf(plain).endsWith(agentCapabilities('confined', CONTRACT)), 'CONTROL: the whole contract on a conversation turn');
});

test('only the literal true is oneShot: "true" and 1 are conversation turns', async () => {
  const plain = await argvOf('lit-plain', {});
  for (const v of ['true', 1]) {
    const argv = await argvOf(`lit-${v}`, { oneShot: v });
    assert.deepEqual(flagValues(argv, '--settings'), [], `${JSON.stringify(v)}: no --settings`);
    assert.deepEqual(rest(argv), rest(plain), `${JSON.stringify(v)}: argv as a conversation turn`);
    assert.equal(promptOf(argv), promptOf(plain), `${JSON.stringify(v)}: the contract still rides`);
  }
});

test('oneShot: its caller leaves mid-run → the claude child is killed, "Cancelled" is stored, audited', async () => {
  const t = tag('cancel');
  const turn = await open({ message: `FAKE-SLOW 15000 ${t}`, oneShot: true });
  const [run] = await waitFor(() => (spawns(t).length ? spawns(t) : null), 'the fake claude to start');
  assert.ok(alive(run.pid), 'CONTROL: the child is running when the caller leaves');
  turn.ac.abort();
  await waitFor(() => !alive(run.pid), 'the claude child to be killed');
  const a = await waitFor(() => cancelAudit(turn.convoId), 'the chat-cancelled audit');
  assert.equal(a.who, 'owner');
  assert.equal(a.from, APP);
  const c = await storedTurn(turn.convoId, 2);
  assert.equal(c.messages.at(-1).text, CANCELLED_TEXT, 'the stored reply is the clean cancel');
  const stored = JSON.stringify(c.messages);
  assert.ok(!stored.includes('RAW-PARTIAL') && !stored.includes('"subtype"'), `no raw stream-json stored: ${stored.slice(0, 300)}`);
  assert.equal(finished(t).length, 0, 'the killed run never answered');
});

test('CONTROL: a conversation turn whose caller leaves is NOT killed — it finishes and is stored', async () => {
  const t = tag('keep');
  const turn = await open({ message: `FAKE-SLOW 1500 ${t}` });
  await waitFor(() => spawns(t).length, 'the fake claude to start');
  assert.equal(finished(t).length, 0, 'the caller leaves while the child is still running');
  turn.ac.abort();
  await waitFor(() => finished(t).length, 'the run to finish on its own', { timeoutMs: 8000 });
  const c = await storedTurn(turn.convoId, 2);
  assert.equal(c.messages.at(-1).text, 'ANSWERED', 'and its answer is stored for pollForResult');
  assert.equal(cancelAudit(turn.convoId), undefined, 'no cancel recorded');
});

test('oneShot still QUEUED when its caller leaves never spawns (control: a queued one that stays does)', async () => {
  const a = tag('hold'), b = tag('left'), c = tag('stays');
  const holder = await open({ message: `FAKE-SLOW 2500 ${a}` });
  await waitFor(() => spawns(a).length, 'the holder to take the only slot');
  const left = await open({ message: `design ${b}`, oneShot: true });
  const stays = await open({ message: `design ${c}`, oneShot: true });
  assert.equal(spawns(b).length + spawns(c).length, 0, 'both are queued behind the holder');
  left.ac.abort();
  assert.equal((await holder.done()).text, 'ANSWERED');
  assert.equal((await stays.done()).text, 'ANSWERED', 'CONTROL: the queued turn that stayed ran once the slot freed');
  assert.equal(spawns(c).length, 1, 'CONTROL: and the log sees a queued spawn');
  assert.equal(spawns(b).length, 0, 'the turn whose caller left never spawned');
  assert.ok(cancelAudit(left.convoId), 'its cancel is audited');
  assert.equal((await storedTurn(left.convoId, 2)).messages.at(-1).text, CANCELLED_TEXT);
});

// A oneShot turn never resumes (test/chat-one-shot-fresh.test.mjs), so a cancel can never meet this
// retry: only a conversation turn reaches it, and a conversation turn is never cancelled.
test('a conversation turn whose CLI session is gone is retried fresh, once', async () => {
  const t = tag('gone-retry');
  const first = await open({ message: `hello ${t}` });
  assert.equal((await first.done()).text, 'ANSWERED');
  const second = await open({ message: `FAKE-GONE-EXIT ${t}`, convoId: first.convoId });
  assert.equal((await second.done()).text, 'ANSWERED', 'the fresh retry answered');
  assert.deepEqual(spawns(t).map((s) => s.argv.includes('--resume')), [false, true, false], 'seed, resume, fresh retry');
  assert.ok(spawns(t)[2].stdin.startsWith('[Resuming conversation'), 'the fresh retry carries the history block');
});
