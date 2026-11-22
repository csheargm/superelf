// DEFECT — ATTACHING AN IMAGE TO THE MAIN CHAT SILENTLY TOOK ITS TOOLS AWAY.
//
// WHAT WAS PROVEN BROKEN, and is regressed here
//   web.mjs routed an attachment with `if (hasImage && (!chosen || chosen.provider==='ollama'))`.
//   The SHELL's main chat sends NO `model` field at all (web/index.html submitSend posts only
//   {message,convoId,attachments}), so `!chosen` was TRUE on every main-chat turn. Attaching a
//   screenshot therefore swapped the Claude AGENT lane (full tools) for cfg.vision_default — a
//   fast Ollama lane with NO tools — which then answered the fast-lane honesty guard's advice
//   verbatim: "you cannot do that in fast mode, switch the model selector to Claude". The shell
//   has no model selector. A real user attached a screenshot asking for a code fix and was told
//   the model could not patch code in fast mode.
//
// WHAT THIS FILE ASSERTS, and at which layer
//   1. The DECISION, extracted: the shipped PA_CHAT_LANE block is pulled out of web.mjs and RUN.
//      No re-implementation — if the extraction stops finding real code the suite says so.
//   2. END TO END over real HTTP: the real web.mjs, the repo's own readBody/BODY_LIMITS on
//      /api/chat and /api/upload, a real /api/upload round trip for the attachment, and a real
//      spawn of the Claude CLI — replaced by a stub BINARY that records the argv, cwd and the
//      prompt it was handed on stdin, and answers the CLI's real stream-json `result` shape.
//      That is what proves the agent lane actually RECEIVES the image: runClaude has no image
//      channel, so the file has to be named in the prompt or the agent answers about a picture
//      it cannot see (R14 — an unmentioned attachment is a failure, not a clean pass).
//   3. The fast lane runs against a real node:http Ollama stub speaking the real
//      /api/chat NDJSON shape, so the SYSTEM PROMPT that actually reaches a model is asserted —
//      including that the shell and app surfaces get different closing advice and that a
//      profile override still beats both.
//   4. R3 across the file boundary: the wording is pinned against lib/config.mjs's own
//      fastLaneGuard export. A forked copy in web.mjs fails the suite.
//
// R14: nothing here may pass vacuously. The controls run first — the stub CLI must really be
// spawned, the stub Ollama must really be reachable — and the central guard is mutation-tested
// by putting `!chosen` back into web.mjs's OWN source and watching the assertion go red.
//
// TODO(R4): this file is over the 300-line budget. Split section 1 (the extracted lane decision,
// pure, no server) from sections 2-3 (end to end over real HTTP with the stub CLI and stub Ollama)
// into two files, in a no-behaviour-change session.
//
// HONEST LIMIT (R14): the Codex lane is NOT driven over HTTP. `codex` is a real CLI signed into
// the user's ChatGPT subscription and spawning it would be a live side effect, so its behaviour
// is covered at the decision layer plus a source pin that it consumes the same resolver as every
// other lane. That boundary is stated, not hidden.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN, PNG_B64 } from './helpers-web.mjs';
import { fastLaneGuard, FAST_LANE_ADVICE, GUARD_DEFAULT_SURFACE } from '../lib/config.mjs';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined
import { MODEL_HEALTH_FILENAME } from '../lib/model-health.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
const SHELL_SRC = readShell(ROOT);

// The chat_models the stubbed lanes below stand in for. Ids/providers mirror lib/config.mjs's
// defaults; the two agent groups are what the bug demoted away from.
const MODELS = [
  { id: 'deepseek', label: 'DeepSeek · 中文', group: 'Fast', provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' },
  { id: 'glmflash', label: 'GLM Flash', group: 'Fast', provider: 'ollama', model: 'glm-5.3-flash:cloud' },
  { id: 'claude', label: 'Claude', group: 'Agent', provider: 'claude', model: null },
  { id: 'gpt', label: 'GPT (Codex)', group: 'Agent', provider: 'codex', model: null },
];

// ── 1. The shipped decision, extracted and executed ─────────────────────────────────────────
const LANE_BEGIN = '/* ══ PA_CHAT_LANE_BEGIN';
const LANE_END = '/* ══ PA_CHAT_LANE_END ══ */';
function laneSource(src = WEB_SRC) {
  const from = src.indexOf(LANE_BEGIN);
  const to = src.indexOf(LANE_END);
  assert.ok(from > 0 && to > from, 'the lane decision must stay one contiguous block between its markers');
  return src.slice(from, to);
}
function loadPickChatLane(src = WEB_SRC) {
  // eslint-disable-next-line no-new-func
  return new Function(`${laneSource(src)}\nreturn pickChatLane;`)();
}
// confined:false = the owner's own chat. A confined turn (an app's, a member's) never reaches
// Codex. The CHOSEN-lane half of that rule is pinned over HTTP in test/app-agent-confinement.test.mjs;
// the image-reroute half is decided below, because no config the node accepts reaches it any more.
const pick = (over = {}) => loadPickChatLane()({ chatModels: MODELS, visionDefault: 'glmflash', confined: false, ...over });

test('R14 control: the extraction finds REAL code, not a stub that agrees with the test', () => {
  const src = laneSource();
  assert.ok(/function pickChatLane/.test(src), 'the extracted block must define pickChatLane');
  assert.ok(/provider !== 'ollama'/.test(src), "the extracted block must carry the lane's own provider guard");
  // The defect's exact shape must be absent from the shipped source.
  assert.ok(!/!chosen \|\| chosen\.provider === 'ollama'/.test(src.replace(/\/\/[^\n]*/g, '')),
    'the "!chosen ||" demotion must not come back');
});

test('the no-model path is still REACHABLE from the shell — the precondition this file rests on', () => {
  // Was: "the shell main chat still sends NO model". v2.30.0 added a model pill to the shell
  // composer, so that sentence stopped being true and this pin fired — exactly as its own comment
  // said it would. The pin was right; what it should assert has moved.
  //
  // What is true now: the shell posts `model: SHELL_CURMODEL||undefined`, and SHELL_CURMODEL starts
  // null and is only given a default when the server exposes chat models. So `!chosen` is still a
  // live path — a node with no models configured, and any app whose PAChat sends none — and the
  // lane tests below still measure something the product does. The day the shell sends a model
  // UNCONDITIONALLY, this fires again and those tests need re-aiming.
  const send = SHELL_SRC.slice(SHELL_SRC.indexOf('async function submitSend()'));
  const body = send.slice(send.indexOf('const body=JSON.stringify('), send.indexOf('const sentBytes'));
  assert.ok(/attachments:fileAtts/.test(body), 'the shell main chat still posts attachments');
  assert.match(body, /model:\s*SHELL_CURMODEL\s*\|\|\s*undefined/,
    `the model must stay OMITTABLE — an unconditional model kills the !chosen path: ${body.trim()}`);
  // …and omittable in practice, not just in syntax: nothing may seed it before the models arrive.
  assert.match(SHELL_SRC, /let SHELL_CURMODEL=null/, 'SHELL_CURMODEL must start unset');
  assert.match(SHELL_SRC, /if\(CHAT_MODELS\.length\)\{[^}]*SHELL_CURMODEL=/,
    'a default may only be chosen when the server actually offers models');
});

test('no model + an image → the AGENT lane, not vision_default, and NO status line', () => {
  const r = pick({ model: undefined, hasImage: true });
  assert.equal(r.lane, null, 'no chosen lane stays null so chat() falls through to the Claude agent');
  assert.equal(r.status, null, 'nothing was rerouted, so nothing may claim a reroute happened');
});

test('an explicitly chosen text-only lane + an image → vision_default, WITH the status line', () => {
  const r = pick({ model: 'deepseek', hasImage: true });
  assert.equal(r.lane.id, 'glmflash');
  assert.match(r.status, /Image attached · 已附图片 — using GLM Flash/);
});

test('an explicitly chosen AGENT lane + an image → unchanged, no status line', () => {
  for (const id of ['claude', 'gpt']) {
    const r = pick({ model: id, hasImage: true });
    assert.equal(r.lane.id, id, `${id} keeps its own lane`);
    assert.equal(r.status, null, `${id} was not rerouted, so it may not announce one`);
  }
});

test('no image → nothing is ever rerouted, whatever the lane', () => {
  for (const model of [undefined, 'deepseek', 'glmflash', 'claude', 'gpt']) {
    const r = pick({ model, hasImage: false });
    assert.equal(r.status, null);
    assert.equal(r.lane && r.lane.id, model || undefined ? (model || undefined) : (r.lane && r.lane.id));
  }
  assert.equal(pick({ model: 'deepseek', hasImage: false }).lane.id, 'deepseek');
});

test('the vision lane picking itself is not a reroute, and a missing vision_default is not a crash', () => {
  assert.equal(pick({ model: 'glmflash', hasImage: true }).status, null, 'already the vision lane');
  assert.equal(pick({ model: 'glmflash', hasImage: true }).lane.id, 'glmflash');
  const gone = loadPickChatLane()({ chatModels: MODELS, visionDefault: 'nope', model: 'deepseek', hasImage: true });
  assert.equal(gone.lane.id, 'deepseek', 'no vision default configured → keep the chosen lane rather than blow up');
  assert.equal(gone.status, null);
});

test('a vision lane gone from Ollama hands the image to the agent; a gone chosen lane moves first', () => {
  // `gone` is lib/model-health.mjs goneModels(): { modelString: reason }.
  const visionGone = pick({ model: 'deepseek', hasImage: true, gone: { 'glm-5.3-flash:cloud': 'retired 2026-09-25' } });
  assert.equal(visionGone.lane, null, 'not the text-only lane, which would answer about a picture it never saw (R14), and not the 410 lane');
  assert.match(visionGone.status, /^Image attached · 已附图片 — GLM Flash is retired 2026-09-25, so Claude reads it/);
  const both = pick({ model: 'deepseek', hasImage: true, gone: { 'deepseek-v4.1-flash:cloud': 'retired 2026-09-25' } });
  assert.equal(both.lane.id, 'glmflash', 'the default moves to the first lane still served, which is the vision lane here');
  assert.match(both.status, /^DeepSeek · 中文 is retired 2026-09-25 — using GLM Flash/, 'and the move is stated');
  assert.equal(pick({ model: 'deepseek', hasImage: false, gone: {} }).status, null, 'R14 control: nothing gone, nothing said');
  // Chosen AND vision lane gone: the fallback (Mistral) is rerouted again, so it must not be named.
  const withMistral = [MODELS[0], { id: 'mistral', label: 'Mistral', group: 'Fast', provider: 'ollama', model: 'mistral-large-3:675b:cloud' }, ...MODELS.slice(1)];
  const twice = loadPickChatLane()({ chatModels: withMistral, visionDefault: 'glmflash', confined: false, model: 'deepseek', hasImage: true,
    gone: { 'deepseek-v4.1-flash:cloud': 'retired 2026-09-25', 'glm-5.3-flash:cloud': 'not found' } });
  assert.equal(twice.lane, null);
  assert.equal(twice.status, 'DeepSeek · 中文 is retired 2026-09-25; Image attached · 已附图片 — GLM Flash is not found, so Claude reads it · 看图模型不可用，改用 Claude',
    'the line names only the lane that really answers');
});

// R13 review, 2026-10-12: the Codex rule looked only at the CHOSEN lane, and the image reroute then
// returned vision_default unchecked. A confined turn on a fast lane with a picture attached reached
// Codex whenever vision_default named it. lib/config.mjs now refuses such a vision_default at load
// (test/config.test.mjs); the decision must still refuse it on its own.
const CODEX_NOTE = 'GPT (Codex) can read files outside this workspace, so this request uses Claude · 此请求改用 Claude（GPT 可读取工作区外的文件）';
test('a confined turn whose image would be rerouted to Codex goes to Claude instead, and says so', () => {
  for (const confined of [true, undefined]) {   // undefined: an origin nobody stated is confined (agentConfined)
    const r = pick({ model: 'deepseek', hasImage: true, visionDefault: 'gpt', confined });
    assert.equal(r.lane, null, `confined=${confined}: the agent lane (Claude, confined by agentArgs), never Codex`);
    assert.equal(r.status, `Image attached · 已附图片 — ${CODEX_NOTE}`, 'the reroute is said, in the image line\'s own style');
  }
  // CONTROLS (R14): the fix refuses Codex, not everything.
  assert.equal(pick({ model: 'deepseek', hasImage: true, visionDefault: 'gpt', confined: false }).lane.id, 'gpt',
    'the owner\'s own chat is not refused by the decision (lib/config.mjs refuses the setting)');
  const vision = pick({ model: 'deepseek', hasImage: true, confined: true });
  assert.equal(vision.lane.id, 'glmflash', 'a confined turn still gets the Ollama vision lane');
  assert.match(vision.status, /^Image attached · 已附图片 — using GLM Flash$/);
  // The chosen-Codex note is unchanged, with or without an image: nothing was rerouted for the image.
  for (const hasImage of [false, true]) {
    const r = pick({ model: 'gpt', hasImage, confined: true });
    assert.equal(r.lane, null);
    assert.equal(r.status, CODEX_NOTE);
  }
});

test('MUTATION: put `!chosen` back into web.mjs\'s own source and the main-chat case goes red', () => {
  // Reconstruct the HISTORICAL shape exactly, both halves of it: the outer guard let a null
  // `chosen` through, and the inner one announced/assigned the vision lane anyway.
  //   if (hasImage && (!chosen || chosen.provider === 'ollama')) { … if (!chosen || vd.id !== chosen.id) … }
  const before = "if (!hasImage || !chosen || chosen.provider !== 'ollama') return { lane: chosen, status: null };";
  const afterA = "if (!hasImage || (chosen && chosen.provider !== 'ollama')) return { lane: chosen, status: null };";
  const beforeB = 'if (!vd || vd.id === chosen.id) return { lane: chosen, status: null };';
  const afterB = 'if (!vd || (chosen && vd.id === chosen.id)) return { lane: chosen, status: null };';
  assert.ok(WEB_SRC.includes(before) && WEB_SRC.includes(beforeB), 'the mutation targets must still exist verbatim');
  const mutated = WEB_SRC.replace(before, afterA).replace(beforeB, afterB);
  assert.notEqual(mutated, WEB_SRC, 'the mutation matched nothing — it would prove nothing');
  const bad = loadPickChatLane(mutated)({ chatModels: MODELS, visionDefault: 'glmflash', model: undefined, hasImage: true });
  assert.equal(bad.lane.id, 'glmflash', 'the defect reproduces: the main chat is demoted to the no-tools lane');
  assert.match(bad.status, /Image attached/);
  // …and that is exactly what the shipped guard must NOT do.
  assert.equal(pick({ model: undefined, hasImage: true }).lane, null);
});

// ── 2/3. End to end over real HTTP ──────────────────────────────────────────────────────────
// A stub `claude` BINARY. runClaude spawns claudeCmd directly (no shell on darwin/linux), hands
// the prompt on stdin and parses stream-json from stdout — so this records what the real CLI
// would have received and answers the real `result` shape. It is the only thing replaced.
const FAKE_CLAUDE = `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// fileURLToPath, not URL.pathname: on Windows the pathname is /D:/..., which is no file path.
const capture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-calls.ndjson');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { stdin += d; });
process.stdin.on('end', () => {
  fs.appendFileSync(capture, JSON.stringify({ argv: process.argv.slice(2), stdin, cwd: process.cwd() }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', is_error: false,
    result: 'FAKE-CLAUDE-ANSWERED', session_id: '11111111-2222-3333-4444-555555555555' }) + '\\n');
});
`;

// A real node:http server speaking Ollama's real POST /api/chat NDJSON stream, recording every
// request body so the messages that actually reach a model can be asserted.
function startOllama() {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      try { calls.push({ url: req.url, body: JSON.parse(b) }); } catch { calls.push({ url: req.url, body: null, raw: b }); }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: 'FAST-LANE-ANSWERED' }, done: true }) + '\n');
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, calls, port: srv.address().port })));
}

let port, root, web, ollama, capturePath, wsPath;

before(async () => {
  ollama = await startOllama();
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: {
    chat_models: MODELS,
    vision_default: 'glmflash',
    ollama_url: `http://127.0.0.1:${ollama.port}`,
    task_timeout_minutes: 1,
    system_prompts: { apps: { bible: 'BIBLE-DIRECTIVE 中文' } },
  } });
  const bin = path.join(root, 'fake-claude.mjs');
  fs.writeFileSync(bin, FAKE_CLAUDE);
  fs.chmodSync(bin, 0o755);
  capturePath = path.join(root, 'claude-calls.ndjson');
  wsPath = path.join(root, 'workspace');
  // claude_cmd must be set AFTER the root exists (it is an absolute path into it).
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = bin;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  web = startWeb(root);
  await waitReady(port);
});

after(async () => {
  if (web) await stopWeb(web);
  if (ollama) ollama.srv.close();
});

const claudeCalls = () => (fs.existsSync(capturePath) ? fs.readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// Drive /api/chat for real and collect the NDJSON events the browser would have seen.
async function chat(body) {
  const before = { claude: claudeCalls().length, ollama: ollama.calls.length };
  const res = await api(port, '/api/chat', { method: 'POST', body: JSON.stringify(body) });
  assert.equal(res.status, 200, `chat should stream, got ${res.status}`);
  const text = await res.text();
  const events = text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return {
    events,
    statuses: events.filter((e) => e.type === 'status').map((e) => e.text),
    done: events.find((e) => e.type === 'done'),
    newClaude: claudeCalls().slice(before.claude),
    newOllama: ollama.calls.slice(before.ollama),
  };
}

async function upload(name = 'screenshot.png') {
  const r = await api(port, '/api/upload', { method: 'POST', body: JSON.stringify({ name, data: PNG_B64 }) });
  const j = await r.json();
  assert.ok(j.ok && j.path, `upload failed: ${JSON.stringify(j)}`);
  return { name: j.name, path: j.path };
}

test('R14 control: the harness really drives the server, the stub CLI and the stub Ollama', async () => {
  const agent = await chat({ message: 'plain question, no attachment' });
  assert.equal(agent.newClaude.length, 1, 'the default lane really spawned the Claude CLI');
  assert.equal(agent.done.text, 'FAKE-CLAUDE-ANSWERED');
  assert.equal(agent.newOllama.length, 0, 'a default turn must not touch a fast lane');
  const fast = await chat({ message: 'plain question', model: 'deepseek' });
  assert.equal(fast.newOllama.length, 1, 'the fast lane really reached the Ollama stub over HTTP');
  assert.equal(fast.newOllama[0].body.model, 'deepseek-v4.1-flash:cloud');
  assert.equal(fast.done.text, 'FAST-LANE-ANSWERED');
  assert.equal(fast.newClaude.length, 0);
  // The real upload route, the real cap, real bytes on disk.
  const att = await upload();
  assert.ok(fs.existsSync(path.join(wsPath, att.path)), 'the attachment is really on disk in the workspace');
});

test('THE FIX, end to end: an image on the main chat reaches the AGENT — with the image', async () => {
  const att = await upload('bug-report.png');
  const r = await chat({ message: 'fix the bug in this screenshot', attachments: [att] });
  // (a) no demotion
  assert.equal(r.newOllama.length, 0, 'the no-tools vision lane must never see a main-chat turn');
  assert.equal(r.newClaude.length, 1, 'the Claude agent lane answered');
  // (b) no status line, because nothing was rerouted
  assert.deepEqual(r.statuses.filter((s) => /Image attached/.test(s)), [],
    'a reroute that did not happen may not be announced');
  // (c) the agent actually RECEIVES the image. runClaude has no image channel — the CLI reads a
  //     prompt on stdin and sees a picture only by opening it with Read — so the path has to be
  //     in the prompt, relative to the cwd it was spawned in.
  const call = r.newClaude[0];
  assert.ok(call.stdin.includes('fix the bug in this screenshot'), 'the question survives');
  assert.ok(call.stdin.includes(att.path), `the attachment path must reach the agent — got: ${JSON.stringify(call.stdin)}`);
  assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(wsPath), 'the named path is relative to the cwd the CLI got');
  assert.ok(fs.existsSync(path.join(call.cwd, att.path)), 'and it resolves to a file that is really there');
});

test('a turn with NO attachment leaves the agent prompt byte-identical', async () => {
  const r = await chat({ message: 'just a question' });
  assert.equal(r.newClaude[0].stdin, 'just a question', 'no attachment → no bookkeeping bolted onto the prompt');
});

test('the vision lane gone from Ollama: an image on a fast lane reaches the AGENT with the file, over real HTTP', async () => {
  // The record the model-check job (or a turn that met a 410) writes — lib/model-health.mjs.
  const rec = path.join(root, MODEL_HEALTH_FILENAME);
  fs.writeFileSync(rec, JSON.stringify({ checked: Date.now(), gone: { 'glm-5.3-flash:cloud':
    { status: 410, error: 'glm-5.3-flash was retired at 2026-09-25 00:00:00 -0700 PDT', since: Date.now(), reported: true } } }));
  try {
    const att = await upload('chart-after-retirement.png');
    const r = await chat({ message: 'what is in this chart', model: 'deepseek', attachments: [att] });
    assert.equal(r.newOllama.length, 0, 'neither the text-only lane (cannot see it) nor the retired vision lane (410)');
    assert.equal(r.newClaude.length, 1, 'the agent lane answered');
    assert.ok(r.newClaude[0].stdin.includes(att.path), 'and was handed the image to open');
    assert.ok(r.statuses.some((t) => t.includes('GLM Flash is retired 2026-09-25, so Claude reads it')), JSON.stringify(r.statuses));
  } finally { fs.rmSync(rec, { force: true }); }
  const control = await chat({ message: 'what is in this chart', model: 'deepseek', attachments: [await upload('chart-again.png')] });
  assert.equal(control.newOllama[0].body.model, 'glm-5.3-flash:cloud', 'R14 control: with the record gone, the vision lane takes it again');
});

test('an explicitly chosen fast lane + an image DOES reroute, over real HTTP, and says so', async () => {
  const att = await upload('chart.png');
  const r = await chat({ message: 'what is in this chart', model: 'deepseek', attachments: [att] });
  assert.equal(r.newClaude.length, 0);
  assert.equal(r.newOllama.length, 1);
  assert.equal(r.newOllama[0].body.model, 'glm-5.3-flash:cloud', 'it really went to the configured vision lane');
  assert.ok(r.statuses.some((s) => /Image attached · 已附图片 — using GLM Flash/.test(s)), `status lines: ${JSON.stringify(r.statuses)}`);
  // and the vision lane really got the pixels, not just the filename
  const last = r.newOllama[0].body.messages[r.newOllama[0].body.messages.length - 1];
  assert.ok(Array.isArray(last.images) && last.images[0] === PNG_B64, 'the image bytes reach the vision lane');
});

test('an explicitly chosen Claude lane + an image is left alone', async () => {
  const att = await upload('ss.png');
  const r = await chat({ message: 'read this', model: 'claude', attachments: [att] });
  assert.equal(r.newOllama.length, 0);
  assert.equal(r.newClaude.length, 1);
  assert.deepEqual(r.statuses.filter((s) => /Image attached/.test(s)), []);
  assert.ok(r.newClaude[0].stdin.includes(att.path));
});

test('an attachment that is not on disk cannot conjure a reroute', async () => {
  // The client controls `path`. A stale/forged one must not demote the lane on the strength of
  // the array being non-empty (the old hasImage was `attachments.length > 0`, nothing more).
  const r = await chat({ message: 'hi', model: 'deepseek', attachments: [{ name: 'gone.png', path: 'uploads/never-existed.png' }] });
  assert.equal(r.newOllama.length, 1);
  assert.equal(r.newOllama[0].body.model, 'deepseek-v4.1-flash:cloud', 'no file → no vision reroute');
  assert.deepEqual(r.statuses.filter((s) => /Image attached/.test(s)), []);
});

test('a traversal in the client-supplied attachment path is refused, not joined', async () => {
  fs.writeFileSync(path.join(root, 'outside-secret.txt'), 'SECRET');
  const r = await chat({ message: 'read it', attachments: [{ name: 'x', path: '../outside-secret.txt' }] });
  assert.ok(!r.newClaude[0].stdin.includes('outside-secret'), 'a path outside the workspace never reaches a lane');
  assert.ok(r.newClaude[0].stdin.startsWith('read it\n\n1 attached file was not found'), 'the refused file is SAID not to be part of the turn (R14)');
});

// SCAR 2026-11-11 (owner screenshot): a summary turn with a page image answered "I can't open the attached
// page image" — the agent lane carried the FAST-lane guard ("You have NO tools"), so the real CLI never called
// Read (measured with sonnet; without the guard it Read the PNG and described it).
const sysArg = (call) => { const i = call.argv.indexOf('--append-system-prompt'); return i < 0 ? '' : call.argv[i + 1]; };
test('the AGENT lane never carries the fast-lane "NO tools" guard; the fast lane still does (CONTROL)', async () => {
  const att = await upload('page.png');
  const r = await chat({ message: 'summarise', model: 'claude', app: 'bible', attachments: [att] });
  assert.equal(r.newClaude.length, 1, 'the stub CLI really ran');
  const sp = sysArg(r.newClaude[0]);
  assert.ok(sp.includes('BIBLE-DIRECTIVE 中文'), 'the app directive still rides (skill-lanes)');
  assert.ok(!sp.includes(fastLaneGuard('app')) && !/You have NO tools/i.test(sp), 'no "NO tools" guard on the tool lane');
  assert.ok(r.newClaude[0].stdin.includes(att.path), 'the file is named for Read');
  const f = await chat({ message: 'x', model: 'deepseek', app: 'bible' });
  assert.equal(systemOf(f.newOllama[0])[0], fastLaneGuard('app'), 'CONTROL: the fast lane keeps its guard');
});

test('an attachment that is not on disk is said: a status line and a prompt note, never assumed seen (R14)', async () => {
  const att = await upload('here.png');
  const r = await chat({ message: 'look', model: 'claude', attachments: [att, { name: 'gone.png', path: 'uploads/pages/gone.png' }] });
  assert.ok(r.statuses.some((s) => /^1 attachment\(s\) not found — not sent · 1 个附件未找到/.test(s)), JSON.stringify(r.statuses));
  assert.ok(r.newClaude[0].stdin.includes('- ' + att.path) && r.newClaude[0].stdin.includes('1 attached file was not found'));
  const ok = await chat({ message: 'look', model: 'claude', attachments: [att] });
  assert.ok(!ok.newClaude[0].stdin.includes('not found') && !ok.statuses.some((s) => /not found/.test(s)), 'CONTROL: all present, nothing said');
});

// ── The surface-aware honesty guard ─────────────────────────────────────────────────────────
const systemOf = (call) => call.body.messages.filter((m) => m.role === 'system').map((m) => m.content);

test('the guard the SHELL gets keeps the honesty and drops the selector it does not have', async () => {
  const r = await chat({ message: 'change my code', model: 'deepseek' });
  const sys = systemOf(r.newOllama[0]);
  assert.equal(sys[0], fastLaneGuard('shell'), 'R3: web.mjs sends lib/config.mjs\'s wording, not a fork of it');
  assert.ok(/you have no tools/.test(sys[0]), 'the honest half survives');
  assert.ok(!/model selector/.test(sys[0]), 'the shell has no model selector — never send the user looking for one');
});

test('the guard an APP gets keeps the honesty AND names the selector that is really there', async () => {
  const r = await chat({ message: 'change my code', model: 'deepseek', app: 'bible' });
  const sys = systemOf(r.newOllama[0]);
  assert.equal(sys[0], fastLaneGuard('app'), 'R3: one source, app variant');
  assert.ok(/you have no tools/.test(sys[0]), 'the honest half is identical on both surfaces');
  assert.ok(/model selector/.test(sys[0]), 'a mini-app chat does have a chooser pill');
  assert.equal(sys[1], 'BIBLE-DIRECTIVE 中文', 'the app directive still rides alongside, unchanged');
});

test('the two surfaces differ ONLY in the closing advice clause (R3: the prompt is not forked)', () => {
  const app = fastLaneGuard('app');
  const shell = fastLaneGuard('shell');
  assert.notEqual(app, shell);
  assert.equal(app.replace(FAST_LANE_ADVICE.app, ''), shell.replace(FAST_LANE_ADVICE.shell, ''),
    'everything outside the advice clause must be byte-identical');
  assert.equal(fastLaneGuard('nonsense'), shell, 'an unknown surface falls back to the wording that invents no control');
  assert.ok(Object.keys(FAST_LANE_ADVICE).includes(GUARD_DEFAULT_SURFACE), 'the settings default names a real surface');
});

test('a profile override still wins on BOTH surfaces — precedence unchanged', async () => {
  const profile = path.join(wsPath, 'profile.json');
  const prior = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf8') : null;
  fs.writeFileSync(profile, JSON.stringify({ systemPrompts: { global: 'MY OWN GUARD 我的提示' } }));
  try {
    for (const body of [{ message: 'x', model: 'deepseek' }, { message: 'x', model: 'deepseek', app: 'bible' }]) {
      const r = await chat(body);
      assert.equal(systemOf(r.newOllama[0])[0], 'MY OWN GUARD 我的提示',
        `the user's override beats the built-in on ${body.app ? 'the app' : 'the shell'} surface too`);
    }
  } finally {
    if (prior === null) fs.unlinkSync(profile); else fs.writeFileSync(profile, prior);
  }
});

test('a configured system_prompts.global still beats the built-in (operator precedence)', () => {
  // Layer between the profile override and the built-in. validateConfig keeps the slot EMPTY
  // when unset precisely so fastLaneGuard(surface) can answer per turn; a configured value is
  // still carried through untouched.
  const src = WEB_SRC.slice(WEB_SRC.indexOf('function resolveSystemPrompts'));
  const line = src.slice(0, src.indexOf('\n', src.indexOf('const global =')));
  assert.match(line, /pick\(over\.global\)\s*\|\|\s*\(o\.agent === true \? null : \(pick\(sp\.global\)\s*\|\|\s*fastLaneGuard\(/,
    `precedence must read profile → config → built-in (the agent lane: profile only); got: ${line.trim()}`);
});

// ── R3 / boundary pins ──────────────────────────────────────────────────────────────────────
test('every lane resolves attachments through the ONE safeJoin-gated resolver (incl. Codex -i)', () => {
  const from = WEB_SRC.indexOf('async function chat(req, res, user');
  const to = WEB_SRC.indexOf('function startAssess(');
  assert.ok(from > 0 && to > from, 'chat() must still be the block between its own signature and startAssess');
  const code = WEB_SRC.slice(from, to).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  assert.ok(code.length > 2000, 'the slice really contains chat() — an empty slice would pass every check below');
  assert.equal((code.match(/path\.join\(wsDir\(user\), a\.path\)/g) || []).length, 0,
    'no lane may re-derive an attachment path from the client-supplied value');
  assert.match(code, /const imgs = files\.map\(\(f\) => f\.abs\)/, 'the Codex -i list comes from the shared resolver');
  assert.match(code, /prompt: message \+ attachmentPrompt\(files\)/, 'the Claude lane names the shared resolver\'s files');
  const resolver = WEB_SRC.slice(WEB_SRC.indexOf('function attachmentFiles'), WEB_SRC.indexOf('function attachmentPrompt'));
  assert.match(resolver, /safeJoin\(base, a\.path\)/, 'the one resolver goes through the repo\'s own traversal gate');
});
