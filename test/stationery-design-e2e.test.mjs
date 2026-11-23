// The Journal's "AI设计 · Design with AI", END TO END through every part the 2026-10-12 fix touched:
//   picker (Design / Cancel · 取消) → studio → PAChat.complete (chat-ui) → the shell's broker relay
//   → the REAL web.mjs → `claude`.
//
// SCAR (measured 2026-10-12, real CLI): with adaptive thinking on, Sonnet drafted the whole SVG
// inside its thinking, hit the 32,000-token output cap and never answered; the studio gave up after
// 5 minutes, cancelling nothing, and retries piled up three claude processes. Each part has its own
// tests against a stand-in neighbour (stationery-flow: picker + studio; chat-cancel: PAChat + shell;
// chat-one-shot: web.mjs). This file runs them TOGETHER, so the parts are proved to agree on the
// interface — `oneShot` arriving in argv as thinking-off, and a Cancel tap arriving at the claude
// child as a kill — not merely each to agree with a fake of the other.
//
// FIDELITY (R14): every part is the shipped source (helpers-stationery mountStudio + loadComplete,
// helpers-shell-broker), wired as the Journal wires them — its host line is
// `ai:(message,o)=>PAChat.complete(message,o)`. The server is this checkout's web.mjs on an
// ephemeral port in a throwaway root. Only `claude` is fake, launched the way this OS launches the
// real one (helpers-platform writeFakeCli).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor, api, OWNER_TOKEN, pidAlive as alive } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { flagValues } from './helpers-agent-lane.mjs';
import { mountStudio, loadComplete, svg } from './helpers-stationery.mjs';
import { loadShellBroker } from './helpers-shell-broker.mjs';

const GOOD = svg('<rect width="816" height="1056" fill="#fffaf2"/><circle cx="60" cy="60" r="30" fill="#f2b8c6"/>');
const CANCELLED = '已取消 · Cancelled';
const THINKING_OFF = JSON.stringify({ alwaysThinkingEnabled: false });
const SLOW = { timeoutMs: 15000 };   // a fresh node start for the fake can take seconds on a loaded machine

// Records {ev, pid, argv, stdin} per spawn and streams the CLI's init line. It then answers GOOD at
// once — or, when the request says FAKE-HANG, only after 30 s: the run that does not end while the
// person waits (bounded, so a build that never kills it leaves no orphan behind).
const fakeClaude = (log) => `#!/usr/bin/env node
import fs from 'node:fs'; import crypto from 'node:crypto';
const rec = (o) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, ...o }) + '\\n');
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const sid = crypto.randomUUID();
  rec({ ev: 'spawn', argv: process.argv.slice(2), stdin: s });
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid }) + '\\n');
  setTimeout(() => {
    rec({ ev: 'finished', stdin: s });
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: ${JSON.stringify(GOOD)}, session_id: sid }) + '\\n');
  }, s.includes('FAKE-HANG') ? 30000 : 0);
});
`;

let port, root, web, log, seq = 0;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port });
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

const tag = (name) => `E2E-${name}-${++seq}-${Date.now()}`;
const lines = (file) => { let txt = ''; try { txt = fs.readFileSync(file, 'utf8'); } catch { /* not written yet — an empty list, asserted on by callers */ }
  return txt.split('\n').filter(Boolean).map((l) => JSON.parse(l)); };
const runs = (t, ev) => lines(log).filter((r) => r.ev === ev && r.stdin.includes(t));
const cancelAudit = (convo) => lines(path.join(root, 'audit.log')).find((a) => a.ev === 'chat-cancelled' && a.convo === convo);
async function storedReply(convo) {   // the server saves after the run ends: poll the real route
  const until = Date.now() + SLOW.timeoutMs;
  for (;;) {
    const c = await (await api(port, `/api/convos/${convo}`)).json();
    if (c.messages && c.messages.length >= 2) return c.messages.at(-1).text;
    if (Date.now() > until) throw new Error(`convo ${convo} never stored a reply: ${JSON.stringify(c).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// One Journal page in front of the real server, with `desc` typed into "Describe the stationery…".
function journal(desc) {
  const B = loadShellBroker(`http://127.0.0.1:${port}`, { token: OWNER_TOKEN });
  const { complete, posted } = loadComplete((m, reply) => B.route(m, reply));
  const page = mountStudio(undefined, undefined, (message, o) => complete(message, o));
  page.host.querySelectorAll('textarea')[0].value = desc;
  const chat = () => posted.find((m) => m.kind === 'chat');
  const convo = () => { const e = chat() && B.out.find((x) => x.id === chat().id && x.ev && x.ev.type === 'convo'); return e && e.ev.id; };
  return { ...page, B, posted, chat, convo };
}

test('CONTROL: Design → the answer comes back through every part and is drawn; the run was one-shot', async () => {
  const t = tag('design'), J = journal(`pink dots ${t}`);
  J.btn('✨').click(); J.btn('Design ·').click();
  await waitFor(() => J.drawn(), 'the draft to be drawn', SLOW);
  assert.equal(J.say(), '', 'no message left over');
  const [run, ...more] = runs(t, 'spawn');
  assert.equal(more.length, 0, 'one tap, one claude run');
  assert.deepEqual(flagValues(run.argv, '--settings'), [THINKING_OFF], 'oneShot crossed PAChat → shell → server and turned thinking off');
  assert.equal(runs(t, 'finished').length, 1, 'the run answered on its own');
  assert.deepEqual(J.posted.map((m) => m.kind), ['chat'], 'nothing was cancelled');
  assert.ok((await storedReply(J.convo())).includes('<svg'), 'the answer is what the server stored');
  assert.equal(cancelAudit(J.convo()), undefined);
});

test('Cancel · 取消 mid-run: the claude child is KILLED, the page says Cancelled, the server stores and audits it', async () => {
  const t = tag('cancel'), J = journal(`FAKE-HANG ${t}`);
  J.btn('✨').click(); J.btn('Design ·').click();
  const [run] = await waitFor(() => (runs(t, 'spawn').length ? runs(t, 'spawn') : null), 'claude to start', SLOW);
  assert.deepEqual(flagValues(run.argv, '--settings'), [THINKING_OFF]);
  assert.ok(alive(run.pid), 'CONTROL: the run is still going when the person taps Cancel');
  J.btn('Cancel ·').click();
  assert.equal(J.say(), CANCELLED, 'the page answers at once');
  assert.equal(J.btn('Design ·').disabled, false, 'busy is over');
  assert.equal(J.btn('Try again ·').style.display, '');
  await waitFor(() => !alive(run.pid), 'the claude child to be killed', SLOW);
  const cancel = J.posted.find((m) => m.kind === 'chat-cancel');
  assert.equal(cancel && cancel.chatId, J.chat().id, 'ONE chat-cancel, naming the chat request');
  await waitFor(() => J.B.done(J.chat().id), 'the shell relay to end', SLOW);
  assert.equal(J.B.done(J.chat().id).code, 'cancelled', 'the shell says cancelled, never "network"');
  await waitFor(() => cancelAudit(J.convo()), 'the chat-cancelled audit', SLOW);
  assert.equal(await storedReply(J.convo()), CANCELLED, 'the clean cancel is stored, not the killed run’s stream-json');
  assert.equal(runs(t, 'finished').length, 0, 'the killed run never answered');
  assert.equal(J.drawn(), false, 'and nothing was drawn');
});
