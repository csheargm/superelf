// Auto-memory is OFF on every `claude` spawn · 每次启动 claude 都关闭自动记忆（auto-memory）
//
// THE HOLE (measured 2026-10-12, Claude Code 2.1.161, ADR 0002 amendment 2): the CLI's auto-memory
// is on by default, and its store is keyed by the cwd's git root. On the live install that is the
// checkout, so EVERY workspace (owner, members, apps) shares one store. A confined APP lane can write
// it, and every later run LOADS it, so an app could put text into the context of the owner's
// --dangerously-skip-permissions lane.
// THE FIX: every child env carries CLAUDE_CODE_DISABLE_AUTO_MEMORY=1, set LAST (lib/runner.mjs), which
// stops the load. (The write and the Read are denied separately: test/agent-claude-home.test.mjs.)
//
// Layers, all on the fake CLI (test/helpers-agent-lane.mjs), which emulates the measured memory rules:
//   1. every server spawn path, end to end over HTTP, with the server's OWN env set to '0', so the
//      value must come from the spawn, not be inherited;
//   2. the user flow: a memory already in the shared store reaches no owner or member run;
//   3. tools/fetch-daily-digest.mjs, which spawns the CLI itself, run from a copy in a throwaway root;
//   4. a census: every process start in non-test Node code is pinned by its text, and each claude
//      spawn passes claudeChildEnv(), so a spawn site cannot be added or changed unreviewed.
// R14: each "memory off" assertion has a control that the fake really ran, and the fake itself is
// shown to load a planted memory when the variable is absent.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { api, OWNER_TOKEN } from './helpers-web.mjs';
import { spawnSpec } from '../lib/wincmd.mjs';
import { APP_ORIGIN_HEADER, APP_ORIGIN_VALUE } from '../lib/agent-origin.mjs';
import { startLaneServer, assessDone, fakeMemoryDir, MEMORY_OFF_VAR, SKIP, MEMBER_TOKEN } from './helpers-agent-lane.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_HDR = { [APP_ORIGIN_HEADER]: APP_ORIGIN_VALUE };
// The server inherits this test process's env (helpers-web startWeb), so a parent that says '0' must
// not reach the child: the mechanism wins over anything in the environment.
const HOSTILE_PARENT_VALUE = '0';

let L;
before(async () => {
  process.env[MEMORY_OFF_VAR] = HOSTILE_PARENT_VALUE;
  L = await startLaneServer();
});
after(async () => { if (L) await L.stop(); });

// Every Claude spawn for this tag ran with auto-memory off, and at least `min` ran at all (CONTROL).
function assertMemoryOff(t, what, min = 1) {
  const cl = L.spawns(t).filter((s) => s.cli === 'claude');
  assert.ok(cl.length >= min, `${what}: CONTROL — the fake claude ran ${min}+ times (ran ${cl.length})`);
  for (const s of cl) {
    assert.equal(s.memory, null, `${what}: nothing loaded from the memory store`);
    const flags = s.argv.filter((a) => a.length < 60); // the system prompt is long and says nothing here
    assert.equal(s.env[MEMORY_OFF_VAR], '1', `${what}: the child saw ${MEMORY_OFF_VAR}=${s.env[MEMORY_OFF_VAR]}, must be '1', on ${JSON.stringify(flags)}`);
  }
  return cl;
}

// ── 1. Every spawn path ─────────────────────────────────────────────────────────────────

test('CONTROL: the server runs with the variable set to something else', () => {
  assert.equal(process.env[MEMORY_OFF_VAR], HOSTILE_PARENT_VALUE);
});

test('composer chat, owner (the unrestricted lane)', async () => {
  const t = L.tag('owner');
  await L.chat({ message: `hello ${t}` });
  const [s] = assertMemoryOff(t, 'owner composer');
  assert.ok(s.argv.includes(SKIP), 'CONTROL: this is the owner\'s unrestricted lane');
});

test('composer chat, member', async () => {
  const t = L.tag('member');
  await L.chat({ message: `hello ${t}` }, { token: MEMBER_TOKEN });
  assertMemoryOff(t, 'member composer');
});

test('an app\'s chat turn', async () => {
  const t = L.tag('app-chat');
  await L.chat({ message: `hello ${t}`, app: 'notes' }, { headers: APP_HDR });
  assertMemoryOff(t, 'app chat turn');
});

test('/api/ask', async () => {
  const t = L.tag('ask');
  assert.equal((await L.ask({ message: `q ${t}` }, { headers: APP_HDR })).text, 'ANSWERED');
  assertMemoryOff(t, 'app ask');
});

test('job resolve: chat-to-job from the composer, and /api/jobs/resolve', async () => {
  const c = L.tag('chat-job');
  await L.chat({ message: `every morning tell me the pollen ${c}` });
  assertMemoryOff(c, 'chat-to-job resolver + agent', 2);
  const t = L.tag('jobs-resolve');
  const r = await api(L.port, '/api/jobs/resolve', { method: 'POST', body: JSON.stringify({ prompt: `every morning tell me the pollen ${t}` }), headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
  await r.text();
  assertMemoryOff(t, '/api/jobs/resolve');
});

test('Verify panel and its summarizer', async () => {
  const t = L.tag('assess');
  const ev = await L.chat({ message: `hello ${t}`, assess: true });
  const a = ev.find((e) => e.type === 'assess');
  const fin = await assessDone(L.port, ev.find((e) => e.type === 'convo').id, a.aid);
  assert.equal(fin.models.filter((m) => m.ok).length, 2, 'CONTROL: two panel models answered, so the summarizer runs');
  const cl = assertMemoryOff(t, 'Verify panel', 3);
  assert.ok(cl.some((s) => s.argv.includes('opus-test')), 'CONTROL: the panel\'s Claude member was spawned');
  assert.ok(cl.some((s) => s.argv.includes('haiku')), 'CONTROL: the summarizer was spawned');
});

// ── 2. The user flow the hole allowed ───────────────────────────────────────────────────

// The memory store for a run in `cwd` (the fake records cwd as the CLI sees it, a realpath).
const storeText = (cwd) => {
  try { return fs.readFileSync(path.join(fakeMemoryDir(L.log, cwd), 'MEMORY.md'), 'utf8'); }
  catch { return ''; } // no store: the CONTROL assertion below fails and says so
};

test('a memory already in the store reaches no superelf run, the owner\'s or a member\'s', async () => {
  // As on the live node, where the shared store already holds the owner's memory. An app can no
  // longer plant one (test/agent-claude-home.test.mjs), so the store is seeded directly: this test is
  // about the LOAD, whoever wrote the file.
  const c = L.tag('seed-cwd');
  await L.chat({ message: `hello ${c}` }, { token: MEMBER_TOKEN });
  const [kid] = L.spawns(c);
  const store = fakeMemoryDir(L.log, kid.cwd);
  fs.mkdirSync(store, { recursive: true });
  fs.appendFileSync(path.join(store, 'MEMORY.md'), 'favourite-colour-teal\n');
  assert.match(storeText(kid.cwd), /favourite-colour-teal/, 'CONTROL: the store holds the memory');
  const cwds = [];
  for (const [who, body, opts] of [
    ['the owner\'s composer', {}, {}],
    ['a member\'s composer', {}, { token: MEMBER_TOKEN }],
    ['a member\'s app turn', { app: 'notes' }, { token: MEMBER_TOKEN, headers: APP_HDR }],
  ]) {
    const t = L.tag('recall');
    await L.chat({ message: `what is my favourite colour ${t}`, ...body }, opts);
    const [s] = assertMemoryOff(t, who);
    assert.equal(fakeMemoryDir(L.log, s.cwd), store, `CONTROL: ${who} runs against the same store`);
    cwds.push(s.cwd);
  }
  const [owner, member, memberApp] = cwds;
  assert.notEqual(owner, member, 'CONTROL: the owner\'s and the member\'s runs are in two workspaces');
  assert.equal(memberApp, member, 'CONTROL: the member\'s app turn runs in the member\'s workspace');
});

test('CONTROL: without the variable, the fake loads the planted memory', () => {
  const p = L.tag('fake-plant');
  const t = L.tag('fake-recall');
  const spec = spawnSpec(L.claudeCmd);
  const env = { ...process.env };
  delete env[MEMORY_OFF_VAR];
  const cwd = path.join(L.root, 'workspace');
  for (const msg of [`FAKE-REMEMBER fake-only-${p}`, `recall ${t}`]) {
    const r = spawnSync(spec.file, [...spec.args, '-p'], { cwd, env, input: msg, encoding: 'utf8', shell: spec.shell });
    assert.equal(r.status, 0, r.stderr);
  }
  const [s] = L.spawns(t);
  assert.equal(s.env[MEMORY_OFF_VAR], null);
  assert.match(String(s.memory), new RegExp(`fake-only-${p}`), 'the fake would show a leak, so its absence above means something');
});

// ── 3. The daily digest, which spawns the CLI without the runner ────────────────────────

test('tools/fetch-daily-digest.mjs runs claude with auto-memory off', () => {
  // The script finds workspace/ and tools/websearch.mjs next to ITS OWN file, so it runs from a copy
  // in a throwaway root: never the repo's workspace, and a stub search, so no network.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-digest-'));
  try {
    fs.mkdirSync(path.join(root, 'tools'));
    fs.copyFileSync(path.join(REPO, 'tools', 'fetch-daily-digest.mjs'), path.join(root, 'tools', 'fetch-daily-digest.mjs'));
    fs.writeFileSync(path.join(root, 'tools', 'websearch.mjs'), 'process.stdout.write(JSON.stringify({ results: [] }));\n');
    fs.symlinkSync(path.join(REPO, 'lib'), path.join(root, 'lib'));
    const t = L.tag('digest');
    const data = path.join(root, 'workspace', 'data', 'daily-digest');
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(path.join(data, 'topics.json'), JSON.stringify([{ key: 'k', name: t, icon: '-', query: 'q' }]));
    // process.env already carries the fake's PATH, PA_FAKE_LOG and the hostile '0'.
    const r = spawnSync(process.execPath, [path.join(root, 'tools', 'fetch-daily-digest.mjs')], { cwd: root, encoding: 'utf8', timeout: 60000 });
    assert.equal(r.status, 0, `the digest must finish: ${r.stderr}`);
    assertMemoryOff(t, 'daily digest');
  } finally { rmTemp(root); }
});

// ── 4. Census: no process start can be added or changed without review ─────────────────────

// Every reference, in non-test Node code, to a name imported from child_process, pinned by its text up
// to the end of its first argument: a call `execSync('git rev-parse HEAD'`, or a bare reference such as
// an alias or `promisify(execFile)`. A new file, a new reference, or an edited first argument (a git
// call turned into a claude call) fails here until it is reviewed and listed, so a claude spawn
// cannot be added without the env. Not seen: what a variable such as `spec` resolves to, and a new
// caller of an existing wrapper. ops/checks.ps1 (not Node) is the one documented exception, in ADR
// 0002 amendment 2. `claude: true` marks a file whose `spec.file` spawns run the claude CLI.
const PROCESS_STARTS = {
  'lib/codex.mjs': { why: 'the codex CLI: not claude, so no auto-memory', refs: ['spawn(spec.file'] },
  'lib/runner.mjs': { why: 'claude; taskkill', claude: true, refs: ["spawn('taskkill'", 'spawn(spec.file'] },
  'lib/note-ocr.mjs': { why: 'tools/panote-ocr (Apple Vision) and swiftc that builds it: not claude; a minimal env (OCR_CHILD_ENV_KEYS), never process.env', refs: ['execFile(s.file'] },
  'lib/vernotes.mjs': { why: 'git', refs: ["execFileSync('git'"] },
  'lib/version-auto.mjs': { why: 'git', refs: ["execFileSync('git'"] },
  'tools/fetch-daily-digest.mjs': { why: 'node tools/websearch.mjs (its claude run goes through lib/runner.mjs runClaude)',
    refs: ['execFileSync(process.execPath'] },
  'tools/gen-builtin-app-versions.mjs': { why: 'git log, show (builds lib/builtin-app-versions.json)', refs: ["execFileSync('git'"] },
  'tools/bump-version.mjs': { why: 'git log, merge-base (reads merges on main for the version bump)', refs: ["execFileSync('git'", "execFileSync('git'"] },
  'tools/privacy-scan.mjs': { why: 'git ls-files, rev-list, show (the public privacy scan)', refs: ["execFileSync('git'", "execFileSync('git'"] },
  'web.mjs': { why: 'git', refs: ["execFileSync('git'", "execFileSync('git'", "execSync('git rev-parse HEAD'", "execFileSync('git'"] },
};
const CHILD_PROCESS = /['"`](?:node:)?child_process['"`]/g;
const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g;

// The references in `src` to the names it imports from child_process, or null when it does not use
// child_process. Only the named-import form is read; any other reference (default, namespace,
// require, dynamic import, re-export) fails rather than being skipped.
function processStarts(f, src) {
  const refs = (src.match(CHILD_PROCESS) || []).length;
  if (!refs) return null;
  const named = [...src.matchAll(NAMED_IMPORT)];
  assert.equal(named.length, refs, `${f}: references child_process in a form this census cannot read; extend it`);
  const names = named.flatMap((m) => m[1].split(',').map((x) => x.trim().split(/\s+as\s+/).pop()).filter(Boolean));
  const body = src.replace(NAMED_IMPORT, '').replace(/^\s*\/\/.*$/gm, '');
  const out = [];
  for (const x of names) {
    for (const m of body.matchAll(new RegExp(`(?<![.\\w$])${x}(?![\\w$])(\\s*\\([^,)]*)?`, 'g'))) out.push(m[0].replace(/\s+/g, ''));
  }
  return out.sort();
}

test('census: every process start in non-test Node code is listed, and each claude spawn passes claudeChildEnv()', () => {
  const ls = spawnSync('git', ['ls-files', '*.mjs', '*.js', '*.cjs'], { cwd: REPO, encoding: 'utf8' });
  assert.equal(ls.status, 0, `git ls-files must run in the checkout: ${ls.stderr}`);
  const found = {};
  for (const f of ls.stdout.split('\n').filter((x) => x && !x.startsWith('test/') && !/^workspace[^/]*\//.test(x))) {
    const refs = processStarts(f, fs.readFileSync(path.join(REPO, f), 'utf8'));
    if (refs) found[f] = refs;
  }
  const listed = Object.fromEntries(Object.entries(PROCESS_STARTS).map(([f, e]) => [f, [...e.refs].map((r) => r.replace(/\s+/g, '')).sort()]));
  assert.deepEqual(found, listed, 'a process start was added, removed or changed: review it, then update PROCESS_STARTS');
  for (const [f, e] of Object.entries(PROCESS_STARTS)) {
    if (!e.claude) continue;
    const calls = [...fs.readFileSync(path.join(REPO, f), 'utf8').matchAll(/\bspawn(?:Sync)?\(spec\.file\b[\s\S]*?\}\)/g)];
    assert.equal(calls.length, 1, `${f}: CONTROL — its one claude spawn is found`);
    assert.match(calls[0][0], /env: claudeChildEnv\(\)/, `${f}: the claude spawn must pass env: claudeChildEnv()`);
    assert.equal((calls[0][0].match(/\benv\b/g) || []).length, 1, `${f}: nothing may set env again after claudeChildEnv()`);
  }
});
