// An agent request that ORIGINATES IN AN APP runs confined — even in the owner's session.
//
// THE HOLE (2026-10-11): the broker relays an app's 'chat' / 'ask' to /api/chat and /api/ask with
// the signed-in user's token, and agentArgs gave the OWNER --dangerously-skip-permissions. So any
// app opened by the owner — a member-authored shelf app included — could make the owner's agent
// run any command. Two more lanes leaked the same way and are pinned here too:
//   · the Verify panel (lib/assess.mjs) read cfg.claude_args RAW — the bypass for EVERY account;
//   · the Codex lane runs `--sandbox read-only`, which still READS anywhere (measured: `codex
//     sandbox -c sandbox_mode="read-only" -- cat ../secret.txt` printed the parent's file).
//
// Layers:
//   1. END TO END over real HTTP: the real web.mjs from this checkout on an ephemeral port, a
//      throwaway root, and FAKE `claude` / `codex` binaries (test/helpers-agent-lane.mjs) that record argv.
//      Each test tags its message with a unique token and reads back ONLY the spawns that carried
//      it, so one test can never pass on another's spawn.
//   2. STATIC: the shell relay adds the marker on every agent-reaching kind through ONE helper,
//      the composer never does, and the header name is one literal on both sides (R3).
// R14: every assertion of "flag absent" is paired with a control that the fake CLI really ran
// (and, for each lane, a control that the SAME harness sees the flag when it is there).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { api, OWNER_TOKEN, PNG_B64 } from './helpers-web.mjs';
import { readShell } from '../lib/shellhtml.mjs';
import { APP_CSP } from '../lib/offline.mjs';
import { APP_ORIGIN_HEADER, APP_ORIGIN_VALUE, appOriginated, agentConfined } from '../lib/agent-origin.mjs';
import { startLaneServer, assertAppLane, assessDone as assessDoneOn, SKIP, MEMBER_TOKEN } from './helpers-agent-lane.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
const SHELL = readShell(ROOT);

let L, port;
before(async () => { L = await startLaneServer(); port = L.port; });
after(async () => { if (L) await L.stop(); });
const tag = (n) => L.tag(n);
const spawns = (t) => L.spawns(t);
const chat = (body, o) => L.chat(body, o);
const ask = (message, o) => L.ask({ message }, o);
const APP_HDR = { [APP_ORIGIN_HEADER]: APP_ORIGIN_VALUE };
// Every Claude spawn for this tag is an app lane (helpers-agent-lane.mjs): nothing writable.
const assertConfined = (t, what) => assertAppLane(spawns(t), what);

// ── END TO END ───────────────────────────────────────────────────────────────────────────

test('CONTROL: the owner\'s own composer chat keeps the unrestricted lane', async () => {
  const t = tag('composer');
  const ev = await chat({ message: `hello ${t}` });
  assert.equal(ev.find((e) => e.type === 'done').text, 'ANSWERED');
  const cl = spawns(t).filter((s) => s.cli === 'claude');
  assert.equal(cl.length, 1, 'the fake claude ran once');
  assert.ok(cl[0].argv.includes(SKIP), 'the harness SEES the bypass when it is there — so its absence below means something');
});

test('owner + app chat (relay header + slug) → confined', async () => {
  // "and told so" is asserted in test/agent-prompt-argv.test.mjs, which reads the WHOLE system
  // prompt back from argv. (lib/runner.mjs used to cut it at 2000 chars, so the confined note never
  // reached any confined spawn.) The lane choice (laneRole) is pinned statically in
  // test/agent-capabilities.test.mjs.
  const t = tag('owner-app');
  await chat({ message: `hello ${t}`, app: 'notes' }, { headers: APP_HDR });
  assertConfined(t, 'owner app chat');
});

test('slug forged EMPTY but the relay header present → still confined', async () => {
  const t = tag('forged');
  await chat({ message: `hello ${t}`, app: '' }, { headers: APP_HDR });
  assertConfined(t, 'forged-empty app');
});

test('slug present but header missing → confined (either marker suffices)', async () => {
  const t = tag('slug-only');
  await chat({ message: `hello ${t}`, app: 'notes' });
  assertConfined(t, 'slug-only app');
});

test('a job-shaped message from an app never reaches the resolver in the owner lane', async () => {
  // The chat→job resolver ran on `!app`, so a forged-empty slug used to send it there with the
  // owner's fast_args (bypass included). CONTROL first: from the composer it does run unconfined.
  const c = tag('job-composer');
  await chat({ message: `every morning tell me the pollen ${c}` });
  const cs = spawns(c).filter((s) => s.cli === 'claude');
  assert.equal(cs.length, 2, 'CONTROL: from the composer the resolver runs, then the agent answers');
  assert.ok(cs.every((s) => s.argv.includes(SKIP)), 'CONTROL: both unrestricted for the owner\'s own chat');
  const t = tag('job-app');
  await chat({ message: `every morning tell me the pollen ${t}`, app: '' }, { headers: APP_HDR });
  const cl = assertConfined(t, 'job-shaped app message');
  assert.equal(cl.length, 1, 'the resolver must not run at all for an app turn — only the confined agent answers');
});

test('member + app chat → confined (unchanged)', async () => {
  const t = tag('member-app');
  await chat({ message: `hello ${t}`, app: 'notes' }, { token: MEMBER_TOKEN, headers: APP_HDR });
  assertConfined(t, 'member app chat');
});

test('owner + app ask → confined; /api/ask is app-only, so even without the header', async () => {
  const t1 = tag('ask-hdr');
  assert.equal((await ask(`q ${t1}`, { headers: APP_HDR })).text, 'ANSWERED');
  assertConfined(t1, 'owner ask with header');
  const t2 = tag('ask-nohdr');
  await ask(`q ${t2}`);
  assertConfined(t2, 'owner ask without header');
});

test('Codex lane: owner composer may use it; an app turn is rerouted to confined Claude', async () => {
  const c = tag('codex-composer');
  const ev = await chat({ message: `hello ${c}`, model: 'gpt' });
  assert.equal(ev.find((e) => e.type === 'done').text, 'CODEX-ANSWER', 'CONTROL: the fake codex answered');
  const cx = spawns(c).filter((s) => s.cli === 'codex');
  assert.equal(cx.length, 1, 'CONTROL: codex really spawned and argv captured');
  assert.ok(cx[0].argv.includes('read-only'));

  for (const [who, token] of [['owner', OWNER_TOKEN], ['member', MEMBER_TOKEN]]) {
    const t = tag(`codex-app-${who}`);
    const ev2 = await chat({ message: `hello ${t}`, app: 'notes', model: 'gpt' }, { token, headers: APP_HDR });
    assert.equal(spawns(t).filter((s) => s.cli === 'codex').length, 0, `${who}: codex must not run for an app turn`);
    assertConfined(t, `${who} app turn that chose GPT`);
    assert.ok(ev2.some((e) => e.type === 'status' && /uses Claude/.test(e.text)), `${who}: the reroute is SAID, not silent`);
  }
});

// R13 review, 2026-10-12: the test above checks the CHOSEN lane only, and so did web.mjs. A
// confined app turn on a fast lane with an image was rerouted to vision_default unchecked — Codex,
// when vision_default named it. Two layers now: lib/config.mjs refuses that vision_default at boot
// (what this test meets), and PA_CHAT_LANE refuses Codex for a confined turn after every reroute
// (test/chat-image-lane.test.mjs, at the decision layer: no config the node accepts reaches it).
// CONTROL: LANE_CONFIG with vision_default 'deepseek' is the server every other test here boots.
test('vision_default naming Codex: refused at boot, so no confined image turn can reach Codex', async () => {
  let V;
  try { V = await startLaneServer({ extraConfig: { vision_default: 'gpt' } }); } catch (e) {
    // THIS refusal, not just any failed boot (R14): a server that died of anything else would
    // spawn no codex either.
    assert.match(e.message, /exited before it was ready/);
    assert.match(e.message, /vision_default: lane "gpt" is provider "codex" — must be an ollama lane/);
    return;
  }
  // It started, so the setting was accepted: drive the turn the review reproduced.
  try {
    const up = await (await api(V.port, '/api/upload', { method: 'POST', body: JSON.stringify({ name: 'shot.png', data: PNG_B64 }) })).json();
    assert.ok(up.ok, `CONTROL: the image is really on disk: ${JSON.stringify(up)}`);
    const t = V.tag('vision-gpt');
    const ev = await V.chat({ message: `what is in this picture ${t}`, app: 'notes', model: 'deepseek',
      attachments: [{ name: up.name, path: up.path }] }, { headers: APP_HDR });
    const status = ev.filter((e) => e.type === 'status').map((e) => e.text);
    assert.equal(V.spawns(t).filter((s) => s.cli === 'codex').length, 0, `a confined app turn spawned codex; status: ${JSON.stringify(status)}`);
    assertAppLane(V.spawns(t), 'confined image turn with vision_default gpt');
    assert.fail('the node accepted a vision_default naming a Codex lane; lib/config.mjs must refuse it at boot');
  } finally { await V.stop(); }
});

const assessDone = (convoId, aid) => assessDoneOn(port, convoId, aid);

test('Verify panel: unrestricted for the owner\'s composer, confined (no Codex) for an app', async () => {
  // CONTROL: the composer's panel runs Opus with the bypass AND Codex, then the summarizer.
  const c = tag('assess-composer');
  let ev = await chat({ message: `hello ${c}`, assess: true });
  let a = ev.find((e) => e.type === 'assess');
  await assessDone(ev.find((e) => e.type === 'convo').id, a.aid);
  const cs = spawns(c);
  assert.ok(cs.some((s) => s.cli === 'claude' && s.argv.includes('opus-test') && s.argv.includes(SKIP)), 'CONTROL: panel Opus ran unrestricted');
  assert.ok(cs.some((s) => s.cli === 'codex'), 'CONTROL: panel Codex ran');

  const t = tag('assess-app');
  ev = await chat({ message: `hello ${t}`, app: 'notes', assess: true }, { headers: APP_HDR });
  a = ev.find((e) => e.type === 'assess');
  const fin = await assessDone(ev.find((e) => e.type === 'convo').id, a.aid);
  const cl = assertConfined(t, 'app Verify panel');
  assert.ok(cl.some((s) => s.argv.includes('opus-test')), 'CONTROL: the panel Opus call itself was spawned');
  assert.equal(spawns(t).filter((s) => s.cli === 'codex').length, 0, 'Codex never runs on an app panel');
  assert.match(fin.models.find((m) => m.id === 'gpt').error, /not run for this request/);
});

// ── STATIC: the relay and the predicate ─────────────────────────────────────────────────

const BROKER = (() => {
  const a = SHELL.indexOf('/* ── Broker (for sandboxed apps) ── */');
  const b = SHELL.indexOf("if(kind==='response')", a);
  assert.ok(a > 0 && b > a, 'the broker block is found');
  return SHELL.slice(a, b);
})();

// Server routes whose handler reaches an agent lane, DERIVED from web.mjs rather than listed.
function agentRoutes() {
  const out = new Set();
  const parts = WEB_SRC.split(/(?=if \(req\.method === ')/);
  for (const seg of parts) {
    const m = /^if \(req\.method === '(?:POST|GET|PUT|PATCH)' && p === '(\/api\/[^']+)'/.exec(seg);
    if (m && /\bchat\(req|runAgent\(|runClaude\(|runCodex\(|runAssessment\(/.test(seg)) out.add(m[1]);
  }
  return out;
}

test('the relay marks EVERY agent-reaching broker kind through the one helper', () => {
  const routes = agentRoutes();
  for (const r of ['/api/chat', '/api/ask', '/api/jobs/resolve']) assert.ok(routes.has(r), `derived agent routes include ${r}: ${[...routes]}`);
  let used = 0;
  for (const r of routes) {
    const re = new RegExp(`'${r.replace(/\//g, '\\/')}'(.{0,40})`, 'g');
    for (const m of BROKER.matchAll(re)) {
      assert.match(m[1], /^,appAgentInit\(/, `broker call to ${r} must go through appAgentInit: ${m[0]}`);
      used++;
    }
  }
  assert.ok(used >= 2, `CONTROL: the scan found the chat and ask relays (found ${used})`);
  // `signal` rides along so chat-cancel can close a chat relay; it cannot touch the header.
  assert.match(SHELL, /function appAgentInit\(body,signal\)\{\s*return \{method:'POST',headers:\{'content-type':'application\/json',\[APP_ORIGIN_HEADER\]:APP_ORIGIN_VALUE\},body,signal\};/,
    'the helper always adds the header — it is not conditional on the slug');
});

test('the composer never sends the marker', () => {
  const s = SHELL.slice(SHELL.indexOf('async function sendTurn('));   // submitSend's turn body (F4-3 wrapped it for the Stop button)
  const fn = s.slice(0, s.indexOf('\n}\n'));
  assert.ok(/api\('\/api\/chat'/.test(fn), 'CONTROL: this is the composer\'s chat call');
  assert.ok(!/appAgentInit|APP_ORIGIN/.test(fn), 'the composer must not mark itself as an app');
  assert.equal((SHELL.match(/appAgentInit\(/g) || []).length, 4, 'one definition + the three broker relays (chat, ask, summary-followup), nothing else');
});

test('R3: the header literal is identical in the shell and lib/agent-origin.mjs', () => {
  const m = /const APP_ORIGIN_HEADER='([^']+)', APP_ORIGIN_VALUE='([^']+)'/.exec(SHELL);
  assert.ok(m, 'the shell declares it once');
  assert.equal(m[1], APP_ORIGIN_HEADER);
  assert.equal(m[2], APP_ORIGIN_VALUE);
});

test('an app cannot call /api itself — the premise the marker rests on', () => {
  // The policy lives once in lib/offline.mjs (R3, shared with the demo app's meta tag); web.mjs
  // serves exactly that constant on every /app/ response.
  assert.match(APP_CSP, /^sandbox allow-scripts; default-src 'none';.*connect-src 'none'$/, 'apps are served sandboxed with no network');
  assert.ok(!/allow-same-origin/.test(APP_CSP), 'and at an opaque origin');
  assert.match(WEB_SRC, /const csp = APP_CSP;\n[^]*?'content-security-policy': csp \+/, 'the /app/ route sends that policy');
  assert.match(SHELL, /<iframe id="fr" sandbox="allow-scripts"/, 'the frame is sandboxed by the shell as well');
  // The page in #fr, or a page held while it leaves; run by test/app-leave.test.mjs (ADR 0018).
  assert.match(BROKER, /const fr=appFrameOf\(e\.source\); if\(!fr\) return;/, 'only an app frame is relayed');
});

test('appOriginated / agentConfined, driven directly', () => {
  assert.equal(appOriginated({}, {}), false);
  assert.equal(appOriginated({}, { app: '  ' }), false);
  assert.equal(appOriginated({}, { app: 'notes' }), true);
  assert.equal(appOriginated({ [APP_ORIGIN_HEADER]: APP_ORIGIN_VALUE }, { app: '' }), true);
  assert.equal(appOriginated({ [APP_ORIGIN_HEADER]: 'junk' }, {}), true, 'any value fails closed');
  const owner = { role: 'owner' };
  assert.equal(agentConfined(owner, { fromApp: false }), false);
  assert.equal(agentConfined(owner, { fromApp: true }), true);
  assert.equal(agentConfined(owner, undefined), true, 'unstated origin = confined');
  assert.equal(agentConfined(owner, { fromApp: 0 }), true, 'only an explicit false');
  assert.equal(agentConfined({ role: 'member' }, { fromApp: false }), true);
  assert.equal(agentConfined(null, { fromApp: false }), true);
});
