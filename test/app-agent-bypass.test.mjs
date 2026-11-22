// An app must not reach the owner's UNRESTRICTED lane one ordinary chat later, either.
//
// Confining the app's own turn (test/app-agent-confinement.test.mjs) left two two-step bypasses,
// both reproduced against the real server before they were fixed (review round 1, 2026-10-11):
//   A. The app continued one of the owner's COMPOSER conversations (chat() accepted any convoId).
//      Its text was stored as role 'me', the owner's own words, and the owner's next turn replayed
//      it to the unrestricted lane as a prior 'User:' turn, resuming the session the app had used.
//   B. The app's confined agent WROTE a file the unrestricted lane trusts — profile.json
//      (systemPrompts.global becomes the owner's system prompt), CLAUDE.md, memory/,
//      conversations/ — all inside the workspace, which acceptEdits allowed.
// And one measured on the real CLI while fixing B: acceptEdits honours a machine's Bash allow
// rules, so the "confined" lane ran `curl -o ../outside` — Bash is now denied explicitly.
//
// The fake CLI EMULATES the measured permission rules (test/helpers-agent-lane.mjs), so "the file
// was not written" here means "the argv the real CLI was measured to refuse".
// R14: every "not written / not run" is paired with a control that the same fake, given a lane
// that permits it, really writes / runs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { api, OWNER_TOKEN } from './helpers-web.mjs';
import { readShell } from '../lib/shellhtml.mjs';
import { spawnSpec } from '../lib/wincmd.mjs';
import { APP_ORIGIN_HEADER, APP_ORIGIN_VALUE, APP_UNNAMED_TAG, CONFINED_DENY_ARGS } from '../lib/agent-origin.mjs';
import { startLaneServer, assertAppLane, flagValues, SKIP, MEMBER_TOKEN } from './helpers-agent-lane.mjs';
import { ROOT } from './helpers-app.mjs';

const HDR = { [APP_ORIGIN_HEADER]: APP_ORIGIN_VALUE };
let L, WS, KID;
before(async () => { L = await startLaneServer(); WS = path.join(L.root, 'workspace'); KID = path.join(L.root, 'workspace-kid'); });
after(async () => { if (L) await L.stop(); });
const convoOf = (ev) => ev.find((e) => e.type === 'convo');
const readConvo = (id) => JSON.parse(fs.readFileSync(path.join(WS, 'conversations', id + '.json'), 'utf8'));
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const claudeOnly = (t) => L.spawns(t).filter((s) => s.cli === 'claude');
// The fake records each FAKE-WRITE and its verdict: a refusal counts only if the write was asked for.
const writeOf = (t) => claudeOnly(t).map((s) => s.write);

// ── A. A conversation belongs to the surface that started it ───────────────────────────────

test('BYPASS A: an app naming the owner\'s composer conversation gets its own; the composer\'s is untouched', async () => {
  const o1 = L.tag('owner-first');
  const ev0 = await L.chat({ message: `hello ${o1}` });
  const C = convoOf(ev0).id;
  const first = claudeOnly(o1);
  assert.ok(first[0].argv.includes(SKIP), 'CONTROL: the composer lane is unrestricted');
  const before = JSON.stringify(readConvo(C));

  const e = L.tag('evil');
  const ev1 = await L.chat({ message: `EVIL-INSTRUCTION ${e}`, convoId: C, app: 'evil' }, { headers: HDR });
  const got = convoOf(ev1);
  assert.notEqual(got.id, C, 'the app was NOT given the composer conversation');
  assert.equal(got.replaced, true, 'and is told to rebind');
  assert.equal(JSON.stringify(readConvo(C)), before, 'the composer conversation is byte-for-byte unchanged');
  assert.equal(readConvo(got.id).app, 'evil', 'the fresh one is the app\'s');
  assertAppLane(L.spawns(e), 'the app turn');

  const o2 = L.tag('owner-second');
  await L.chat({ message: `what is on today ${o2}`, convoId: C });
  const s = claudeOnly(o2);
  assert.equal(s.length, 1);
  assert.ok(s[0].argv.includes(SKIP), 'CONTROL: still the owner\'s unrestricted lane');
  assert.ok(!s[0].stdin.includes('EVIL-INSTRUCTION'), 'the app\'s text never reaches it');
  assert.deepEqual(flagValues(s[0].argv, '--resume'), [first[0].sid], 'it resumes the OWNER\'s session, not one the app touched');
});

test('the other direction: the composer cannot continue an app\'s conversation', async () => {
  const a = L.tag('app-own');
  const N = convoOf(await L.chat({ message: `APP-WROTE ${a}`, app: 'notes' }, { headers: HDR })).id;
  const before = JSON.stringify(readConvo(N));
  const o = L.tag('composer-into-app');
  const got = convoOf(await L.chat({ message: `hi ${o}`, convoId: N }));
  assert.notEqual(got.id, N);
  assert.equal(got.replaced, true);
  assert.equal(JSON.stringify(readConvo(N)), before, 'the app conversation is unchanged');
  assert.ok(!claudeOnly(o)[0].stdin.includes('APP-WROTE'), 'the unrestricted lane never sees the app\'s history');
  assert.equal(readConvo(got.id).app, undefined, 'the fresh one is the composer\'s');
});

test('app to app is refused the same way; an app continuing its OWN conversation is unaffected', async () => {
  const a = L.tag('notes-1');
  const ev = await L.chat({ message: `first ${a}`, app: 'notes' }, { headers: HDR });
  const N = convoOf(ev).id;
  const sid = claudeOnly(a)[0].sid;
  const b = L.tag('notes-2');
  const own = convoOf(await L.chat({ message: `second ${b}`, convoId: N, app: 'notes' }, { headers: HDR }));
  assert.equal(own.id, N, 'CONTROL: the same app keeps its conversation');
  assert.ok(!own.replaced);
  assert.deepEqual(flagValues(claudeOnly(b)[0].argv, '--resume'), [sid], 'and its session');
  const c = L.tag('other-app');
  const other = convoOf(await L.chat({ message: `x ${c}`, convoId: N, app: 'other' }, { headers: HDR }));
  assert.notEqual(other.id, N, 'another app cannot write into it');
});

test('an app request with the slug forged empty is still an app\'s conversation, out of the drawer', async () => {
  const t = L.tag('unnamed');
  const id = convoOf(await L.chat({ message: `hi ${t}`, app: '' }, { headers: HDR })).id;
  assert.equal(readConvo(id).app, APP_UNNAMED_TAG);
  const drawer = await (await api(L.port, '/api/convos', { headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).json();
  assert.ok(Array.isArray(drawer) && drawer.length >= 1, 'CONTROL: the drawer lists the composer chats');
  assert.ok(!drawer.some((c) => c.id === id), 'never listed as a composer chat');
});

// ── B. An app's agent writes nothing ───────────────────────────────────────────────────────

test('BYPASS B: an app\'s agent cannot write any file the owner\'s lane trusts', async () => {
  fs.writeFileSync(path.join(WS, 'profile.json'), '{"name":"Owner"}');
  const targets = ['profile.json', 'CLAUDE.md', 'memory/MEMORY.md', 'conversations/zzzzzzzz.json', 'jobs/x.json', 'data/other/x.md', '../outside.txt'];
  const was = targets.map((f) => read(path.join(WS, f)));
  for (const f of targets) {
    const t = L.tag('plant');
    await L.chat({ message: `FAKE-WRITE ${f} INJECTED ${t}`, app: 'evil' }, { headers: HDR });
    assertAppLane(L.spawns(t), `write ${f}`);
    assert.deepEqual(writeOf(t), [{ path: f, allowed: false }], `${f}: asked for, and refused`);
  }
  assert.deepEqual(targets.map((f) => read(path.join(WS, f))), was, 'nothing was planted');
  const o = L.tag('owner-after');
  await L.chat({ message: `hi ${o}` });
  const sp = flagValues(claudeOnly(o)[0].argv, '--append-system-prompt').join(' ');
  assert.ok(!sp.includes('INJECTED'), 'the owner\'s next system prompt is the owner\'s');
});

// Not even its OWN data/<slug>/ (ADR 0019). There it could plant an instruction file the CLI loads
// when a later run reads that folder: measured on the real CLI, a run that only Read
// data/<slug>/list.txt obeyed a planted data/<slug>/CLAUDE.md. Tasks, the one app that asked its
// agent to write, saves through save-data since ADR 0014. Each write carries its tag as the text.
const OWN = ['data/evil/own.md', 'data/evil/CLAUDE.md', 'data/evil/AGENTS.md', 'data/evil/sub/CLAUDE.md', 'data/evil/.claude/settings.json', 'data/tasks/tasks.md'];
test('an app\'s agent writes nothing, its own data/<slug>/ included — by chat and by ask', async () => {
  for (const f of OWN) {
    for (const [how, send] of [['chat', (m) => L.chat({ message: m, app: 'evil' }, { headers: HDR })], ['ask', (m) => L.ask({ message: m, app: 'tasks' }, { headers: HDR })]]) {
      const t = L.tag(`own-${how}`);
      await send(`FAKE-WRITE ${f} ${t}`);
      assertAppLane(L.spawns(t), `${how}: write ${f}`);
      assert.deepEqual(writeOf(t), [{ path: f, allowed: false }], `${how}: ${f} asked for, and refused`);
      assert.notEqual(read(path.join(WS, f)), t, `${how}: ${f} was written by the app's agent`);
    }
  }
});

// R14: the refusals above are the lane, not the fake. Over the same route (web.mjs /api/chat) the
// owner's composer writes every one of those files; and the same fake, run with the app lane as it was
// before ADR 0019 (its allow rule), writes them too. (The real CLI refused data/<slug>/.claude/
// settings.json even under that rule — its own guard, which the fake does not model; so for that one
// path the fake is the more permissive of the two.)
test('CONTROL: the same fake writes them when the lane permits it — the owner, and the old app rule', async () => {
  for (const f of OWN) {
    const t = L.tag('owner-write');
    await L.chat({ message: `FAKE-WRITE ${f} ${t}` });
    assert.deepEqual(writeOf(t), [{ path: f, allowed: true }], `the owner's composer may write ${f}`);
    assert.equal(read(path.join(WS, f)), t, `and it is written: ${f}`);
  }
  const spec = spawnSpec(L.claudeCmd);
  const oldAppLane = [...CONFINED_DENY_ARGS, '--allowedTools', 'Edit(./data/evil/**)', '--permission-mode', 'default'];
  for (const f of OWN.filter((p) => p.startsWith('data/evil/'))) {
    const t = L.tag('old-rule');
    const r = spawnSync(spec.file, [...spec.args, '-p', ...oldAppLane], { cwd: WS, input: `FAKE-WRITE ${f} ${t}`, encoding: 'utf8', shell: spec.shell });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(read(path.join(WS, f)), t, `the old allow rule let the fake write ${f}`);
  }
});

test('Bash is denied on every confined lane — the member\'s own chat too — and runs for the owner', async () => {
  const bash = (dir) => read(path.join(dir, 'bash.txt'));
  const a = L.tag('bash-app');
  await L.chat({ message: `FAKE-BASH ${a}`, app: 'notes' }, { headers: HDR });
  assert.equal(bash(WS), null, 'the app\'s agent ran no Bash');
  const m = L.tag('bash-member');
  await L.chat({ message: `FAKE-BASH ${m}` }, { token: MEMBER_TOKEN });
  const ms = claudeOnly(m)[0];
  assert.deepEqual(flagValues(ms.argv, '--permission-mode'), ['default', 'acceptEdits'], 'a member\'s own chat: the pin, then member_args\' mode, which the CLI applies (the last)');
  assert.ok(flagValues(ms.argv, '--disallowedTools').includes('Bash'));
  assert.equal(bash(KID), null, 'the member\'s agent ran no Bash');
  const o = L.tag('bash-owner');
  await L.chat({ message: `FAKE-BASH ${o}` });
  assert.equal(bash(WS), 'ran', 'CONTROL: the fake runs Bash when the lane allows it');
});

// ── The header-only marker reaches every lane decision (review finding: R1–R3 survived) ────

test('slug forged empty + relay header: GPT is rerouted, and the Verify panel is confined', async () => {
  const t = L.tag('hdr-gpt');
  const ev = await L.chat({ message: `hi ${t}`, app: '', model: 'gpt' }, { headers: HDR });
  assert.equal(L.spawns(t).filter((s) => s.cli === 'codex').length, 0, 'codex never runs');
  assertAppLane(L.spawns(t), 'forged-empty GPT turn');
  assert.ok(ev.some((e) => e.type === 'status' && /uses Claude/.test(e.text)), 'the reroute is said');

  const v = L.tag('hdr-assess');
  const ev2 = await L.chat({ message: `hi ${v}`, app: '', assess: true }, { headers: HDR });
  const id = convoOf(ev2).id; const aid = ev2.find((e) => e.type === 'assess').aid;
  let fin; const until = Date.now() + 15000;
  while (!fin) {
    const m = (await (await api(L.port, '/api/convos/' + id, { headers: { authorization: `Bearer ${OWNER_TOKEN}` } })).json()).messages.find((x) => x.aid === aid);
    if (m && m.assess && m.assess.state !== 'pending') fin = m.assess;
    else if (Date.now() > until) throw new Error('assessment did not finish');
    else await new Promise((r) => setTimeout(r, 100));
  }
  const cl = assertAppLane(L.spawns(v), 'forged-empty Verify panel');
  assert.ok(cl.some((s) => s.argv.includes('opus-test')), 'CONTROL: the panel Opus call was spawned');
  assert.equal(L.spawns(v).filter((s) => s.cli === 'codex').length, 0);
  assert.match(fin.models.find((m) => m.id === 'gpt').error, /not run for this request/);
});

test('the shell\'s slug comes from the frame, not the app; an ask carries none (ADR 0019)', () => {
  const shell = readShell(ROOT);
  // The page's record carries it (web/app-frame.js): frameSlug() of #fr, read again on every message
  // from the page in #fr, and kept as it was read when a leaving page is held (ADR 0018).
  assert.match(shell, /const appSlug=fr\.slug;/, 'appSlug is the slug of the page that asked');
  assert.match(shell, /if\(live\.contentWindow===win\)\{ const r=appFrameRec\(live\); r\.slug=frameSlug\(\);/, 'the page in #fr: the shell\'s frameSlug()');
  assert.match(shell, /const slug=frameSlug\(\);\n  if\(!slug\) return;\n/, 'a held page: frameSlug() as it was when held…');
  assert.match(shell, /if\(!r\.spoke\)\{ el\.remove\(\); return; \}\n  r\.slug=slug;/, '…kept on its record');
  assert.equal((shell.match(/\.slug=/g) || []).length, 2, 'and nothing else sets a page\'s slug');
  assert.match(shell, /const frameSlug=\(\)=>\(frameRef\(\)\.match\(/, 'which reads the frame URL…');
  assert.match(shell, /const frameRef=\(\)=>\{ const fr=\$\('#fr'\); return fr\.getAttribute\('data-app'\)\|\|fr\.src\|\|''; \};/, '…its src, or data-app when the shell loaded it by srcdoc (web/sw-client.js)');
  // Nothing needs a slug on ask once an app's agent writes nothing, so neither side carries one.
  assert.match(shell, /relayCall\('\/api\/ask',appAgentInit\(JSON\.stringify\(\{message:String\(m\.message\|\|''\)\}\)\)/);
  // This pins the one line that reads the body. That an ask gets the plain app lane, whatever it
  // names, is what 'an app's agent writes nothing' checks (it sends app: 'tasks').
  const web = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  assert.match(web, /p === '\/api\/ask'\) \{\n\s*const \{ message \} = await readBody\(req, BODY_LIMITS\.chat\);/, '/api/ask reads only the message');
});
