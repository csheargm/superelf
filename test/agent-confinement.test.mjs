// A member's agent must not be able to read or edit the server.
//
// THE HOLE THIS CLOSES (verified 2026-09-09, fixed 2026-09-11): every account got the same agent
// lane. `claude_args` is ['--dangerously-skip-permissions'] and cwd is a starting directory, not
// a sandbox — and each member's workspace sits ONE LEVEL BELOW config.json (web_token, API keys,
// password hashes), web.mjs and lib/. So any signed-in family member could ask their chat to read
// the config or edit the server, running as the owner's Unix user. The product claimed a trust
// boundary it did not have.
//
// THE BOUNDARY BEGAN AS THE ABSENCE OF --dangerously-skip-permissions (today: that, explicit denies
// and a pinned mode ahead of the operator's args — lib/agent-origin.mjs). Measured against the real CLI in
// a throwaway sandbox on 2026-09-11 — every row run, none assumed:
//
//   skip-permissions + --add-dir <own workspace>   read ../notes.txt      → LEAKED the contents
//   --permission-mode default                      read ../notes.txt      → CANNOT-READ
//   --permission-mode default                      write ./x.txt          → CANNOT-WRITE  ← too strict
//   --permission-mode acceptEdits                  read ../notes.txt      → CANNOT-READ
//   --permission-mode acceptEdits                  `cat ../notes.txt`     → CANNOT-READ  (Bash too)
//   --permission-mode acceptEdits                  write ./x.txt          → DONE
//
// Two conclusions that shaped the code, both contradicting the backlog's option (a):
//   · --add-dir CANNOT confine. It only ADDS directories to the allowed set, so aiming it at the
//     cwd is a no-op. Shipping it would have implied a guarantee it does not provide.
//   · `default` is too strict — it denies writes INSIDE the workspace, which would leave a family
//     member unable to build their own app at all. acceptEdits is the mode that both allows local
//     work and denies escape.
//
// RE-MEASURED 2026-10-11 (Claude Code 2.1.161), and two rows had changed underneath us:
//   --permission-mode acceptEdits                  `curl -s -o ../outside.html …` → RAN, wrote outside
//   --permission-mode acceptEdits                  write profile.json / CLAUDE.md → DONE (trusted by the owner lane)
// The machine's ~/.claude/settings.json had gained a `Bash(curl *)` allow rule, and acceptEdits
// honours it. So every confined lane now carries an explicit `--disallowedTools Bash` (a deny beats
// any allow), and an APP's lane is `default` with no allow rule: it writes nothing (ADR 0019). The
// full table is in lib/agent-origin.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { laneArgs, convoTag, convoReachable, APP_UNNAMED_TAG } from '../lib/agent-origin.mjs';
import { CONFINED_DENIES, SKIP, isBypassArg } from './helpers-agent-lane.mjs';

const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
const CONFIG = fs.readFileSync(path.join(ROOT, 'lib', 'config.mjs'), 'utf8');

test('the member lane drops the permission bypass — where the boundary starts', () => {
  assert.match(CONFIG, /cfg\.member_args = cfg\.member_args \|\| \['--permission-mode', 'acceptEdits', '--strict-mcp-config'\];/,
    'members run under acceptEdits');
  assert.ok(!/member_args[^\n]*dangerously-skip-permissions/.test(CONFIG),
    'and never with the bypass');
});

test('agentArgs delegates to the ONE lane resolver, with the operator\'s member_args', () => {
  const fn = /function agentArgs\(user, base, origin\)\{?([\s\S]*?)\n\}/.exec(WEB);
  assert.ok(fn, 'agentArgs exists');
  // WHO is unrestricted, and what a confined lane may do, are decided in ONE place
  // (lib/agent-origin.mjs laneArgs). Pinned end to end in test/app-agent-*.test.mjs.
  assert.match(fn[1], /^\s*\{\s*return laneArgs\(user, base, cfg\.member_args, origin\);\s*$/, 'agentArgs is only the delegation');
});

test('laneArgs behaves, driven directly', () => {
  const MEMBER = ['--permission-mode', 'acceptEdits'];
  // Bash, and the CLI's own home (its auto-memory store and session transcripts), denied explicitly.
  const DENIES = ['--disallowedTools', ...CONFINED_DENIES];
  // What confines a lane comes FIRST and pins `default` (lib/agent-origin.mjs: the measured table).
  const PIN = ['--permission-mode', 'default'];
  // An app's turn writes nothing (ADR 0019): no allow rule, so `default` refuses every edit.
  const APP = [...DENIES, ...PIN];
  const base = ['--dangerously-skip-permissions'];
  const lane = (user, b, origin) => laneArgs(user, b, MEMBER, origin);
  assert.deepEqual(lane({ role: 'owner' }, base, { fromApp: false }), base, 'the owner\'s own chat is untouched');
  // A member's OWN chat: bypass stripped even if an operator hand-edits it back in, member mode,
  // and Bash denied explicitly (acceptEdits honours a machine's Bash allow rules — measured).
  // member_args' mode comes after the pin, and the CLI applies the last one (measured).
  assert.deepEqual(lane({ role: 'member' }, base, { fromApp: false }), [...DENIES, ...PIN, ...MEMBER]);
  assert.deepEqual(lane({ role: 'member' }, ['--dangerously-skip-permissions', '--model', 'x'], { fromApp: false }),
    [...DENIES, ...PIN, '--model', 'x', ...MEMBER], 'other flags are preserved');
  // An app's turn — the owner's or a member's: default mode, nothing writable.
  const app = [...APP, '--model', 'x'];
  assert.deepEqual(lane({ role: 'owner' }, ['--dangerously-skip-permissions', '--model', 'x'], { fromApp: true, app: 'notes' }), app);
  assert.deepEqual(lane({ role: 'member' }, ['--model', 'x'], { fromApp: true, app: 'notes' }), app);
  // An origin nobody stated is the strictest lane, with nothing writable (fails closed).
  for (const who of [{ role: 'owner' }, { role: 'member' }, null, {}, { role: 'Owner' }]) {
    const a = lane(who, base, undefined);
    assert.ok(!a.includes('--dangerously-skip-permissions'), `${JSON.stringify(who)}: confined`);
    assert.deepEqual(a, [...DENIES, ...PIN], `${JSON.stringify(who)}: nothing writable`);
  }
  // No slug grants a write: a real one (Tasks' included) gets exactly what a broken one gets.
  for (const slug of ['notes', 'tasks', '', '../x', 'a/b', 'A', '*', 'x**']) {
    assert.deepEqual(lane({ role: 'owner' }, [], { fromApp: true, app: slug }), [...DENIES, ...PIN], `slug ${JSON.stringify(slug)}`);
  }
  // An operator's permission flags cannot widen an app lane, in either spelling.
  assert.deepEqual(laneArgs({ role: 'owner' }, ['--allowedTools', 'Edit', 'Write', '--permission-mode=acceptEdits', '--allowed-tools=Edit'], ['--permission-mode', 'bypassPermissions'], { fromApp: true, app: 'notes' }), APP);
  // The bypass put back in member_args (config.json, not admin-editable) reaches no confined lane
  // (R13 review 2026-10-12: only `base` was stripped). Each lane is exactly what it is without it.
  const withSkip = [...MEMBER, SKIP];
  for (const [what, user, origin, want] of [
    ['a member\'s own chat', { role: 'member' }, { fromApp: false }, [...DENIES, ...PIN, ...MEMBER]],
    ['an app turn, owner', { role: 'owner' }, { fromApp: true, app: 'notes' }, APP],
    ['an app turn, member', { role: 'member' }, { fromApp: true, app: 'notes' }, APP],
    ['an unstated origin', { role: 'owner' }, undefined, [...DENIES, ...PIN]],
  ]) assert.deepEqual(laneArgs(user, base, withSkip, origin), want, what);
});

// Every spelling of the bypass the CLI could be handed, in member_args or in base, on every confined
// lane: the flag, its `=` form, the opt-in that makes it available, and the mode that IS it.
test('laneArgs: no spelling of the bypass reaches a confined lane', () => {
  const spellings = [[SKIP], [`${SKIP}=true`], ['--allow-dangerously-skip-permissions'], ['--allow-dangerously-skip-permissions=1'],
    ['--permission-mode', 'bypassPermissions'], ['--permission-mode=bypassPermissions'],
    // R13 round 2: a struck token between the flag and the mode must not join them into the bypass.
    ['--permission-mode', SKIP, 'bypassPermissions'], ['--permission-mode', '--allow-dangerously-skip-permissions', 'bypassPermissions'],
    ['--permission-mode', '--permission-mode=bypassPermissions', 'bypassPermissions'], ['--permission-mode', `${SKIP}=1`, SKIP, 'bypassPermissions']];
  const MEMBER = ['--permission-mode', 'acceptEdits'];
  for (const s of spellings) {
    for (const [user, origin] of [[{ role: 'member' }, { fromApp: false }], [{ role: 'owner' }, { fromApp: true, app: 'notes' }],
      [{ role: 'member' }, { fromApp: true, app: 'notes' }], [{ role: 'owner' }, undefined]]) {
      for (const [base, member] of [[['--model', 'x'], [...MEMBER, ...s]], [['--model', 'x', ...s], MEMBER]]) {
        const a = laneArgs(user, base, member, origin);
        assert.ok(!a.some(isBypassArg), `${JSON.stringify(s)} via ${base.length > 2 ? 'base' : 'member_args'}, ${JSON.stringify([user, origin])}: ${JSON.stringify(a)}`);
        assert.ok(a.includes('--model'), 'other flags are preserved');
      }
    }
  }
  // A member's own chat keeps its own mode when the bypass mode is struck beside it.
  assert.deepEqual(laneArgs({ role: 'member' }, [], [...MEMBER, '--permission-mode', 'bypassPermissions'], { fromApp: false }).slice(-2), MEMBER);
  // CONTROL: the owner's own chat is untouched, bypass included.
  assert.deepEqual(laneArgs({ role: 'owner' }, [SKIP], MEMBER, { fromApp: false }), [SKIP]);
});

// R13 round 1 (2026-10-13), each row measured on the real CLI (lib/agent-origin.mjs):
//   a mode on argv beats a --settings defaultMode, which can be the bypass → every confined lane pins one;
//   a flag missing its value takes the next token, even `--disallowedTools` → what confines comes first.
test('laneArgs: every confined lane pins a mode, and nothing the operator wrote can swallow its denies', () => {
  const head = ['--disallowedTools', ...CONFINED_DENIES];
  const lanes = [[{ role: 'member' }, { fromApp: false }], [{ role: 'owner' }, { fromApp: true, app: 'notes' }], [{ role: 'owner' }, undefined]];
  const settingsBypass = ['--settings', JSON.stringify({ permissions: { defaultMode: 'bypassPermissions' } })];
  for (const [user, origin] of lanes) {
    for (const member of [[], settingsBypass, ['--model', SKIP], ['--model'], ['--']]) {
      const a = laneArgs(user, ['--model', 'x'], member, origin);
      const at = (s) => JSON.stringify([user, origin, member, a]) + ' ' + s;
      assert.deepEqual(a.slice(0, head.length), head, at('the denies come first'));
      assert.equal(a.indexOf('--permission-mode'), a.lastIndexOf('--permission-mode'), at('one mode: the pin'));
      assert.equal(a[a.indexOf('--permission-mode') + 1], 'default', at('pinned default'));
      assert.ok(a.indexOf('--permission-mode') < a.indexOf('--model'), at('before any operator flag'));
    }
  }
});

test('convoTag / convoReachable: a conversation belongs to the surface that started it', () => {
  assert.equal(convoTag({ fromApp: false }), undefined, 'the composer');
  assert.equal(convoTag({ fromApp: true, app: 'notes' }), 'notes');
  assert.equal(convoTag({ fromApp: true, app: '' }), APP_UNNAMED_TAG, 'an app without a slug is still an app');
  assert.equal(convoTag(undefined), APP_UNNAMED_TAG, 'unstated = not the composer (fails closed)');
  assert.equal(convoReachable({ app: undefined }, { fromApp: false }), true);
  assert.equal(convoReachable({ app: null }, { fromApp: false }), true, 'an older null tag is the composer\'s too');
  assert.equal(convoReachable({}, { fromApp: true, app: 'notes' }), false, 'an app may not write into the composer\'s history');
  assert.equal(convoReachable({ app: 'notes' }, { fromApp: false }), false, 'the composer may not resume an app\'s');
  assert.equal(convoReachable({ app: 'notes' }, { fromApp: true, app: 'other' }), false);
  assert.equal(convoReachable({ app: 'notes' }, { fromApp: true, app: 'notes' }), true);
});

test('EVERY agent lane is resolved through agentArgs — none left raw', () => {
  // The hole was not one route: fast_args carries the bypass too (as did the daily-brief
  // synthesiser, removed 2026-10-11, and the Telegram bot's deep_args, removed 2026-10-12). A
  // lane that still passes cfg.*_args directly is an unconfined lane.
  // Check the ARGUMENT that reaches the runner, not merely whether a line mentions cfg.*_args —
  // an earlier version of this assertion flagged the correctly-wrapped calls and passed the one
  // that mattered, which is the wrong way round for a security test.
  // Three forms carry args to the runner: an inline `extraArgs:` value, a `const extraArgs =`
  // that shorthand forwards, and runAgent's second positional argument. All three are checked.
  const inline = [...WEB.matchAll(/extraArgs:\s*([^,\n]+)/g)].map((m) => m[1].trim());
  const assigned = [...WEB.matchAll(/const extraArgs\s*=\s*([^;\n]+)/g)].map((m) => m[1].trim());
  // The floor was 2 while the daily-brief synthesiser carried an inline `extraArgs:`; it was
  // removed 2026-10-11, leaving the chat lane's `const extraArgs`. The floor still proves the
  // regexes match something, and the runClaude census below proves no call escapes them.
  assert.ok(assigned.length >= 1, `expected the chat lane's extraArgs, found ${assigned.length}`);
  // Every runClaude call in web.mjs is either runAgent's (checked through its callers below) or
  // forwards `opts`, built from the checked `const extraArgs`. A NEW call with any other shape
  // must be added to this census deliberately — that is the point.
  const calls = [...WEB.matchAll(/runClaude\(\{([^}]*)\}/g)].map((m) => m[1].trim());
  assert.ok(calls.length >= 2, `expected several runClaude calls, found ${calls.length}`);
  for (const c of calls) {
    assert.ok(/^claudeCmd: cfg\.claude_cmd, extraArgs, cwd, prompt: message/.test(c) || /^\.\.\.opts,/.test(c) || /extraArgs:\s*agentArgs\(/.test(c),
      `a runClaude call whose args are not resolved through agentArgs: ${c}`);
  }
  for (const v of [...inline, ...assigned]) {
    assert.ok(/agentArgs\(/.test(v), `an extraArgs value bypasses the resolver: ${v}`);
  }
  // `(?<!function )` excludes the DECLARATION, whose second parameter is literally named
  // extraArgs — matching it made the test fail on its own definition.
  const runAgentArgs = [...WEB.matchAll(/(?<!function )runAgent\([^,]+,\s*([^,]+),/g)].map((m) => m[1].trim());
  assert.ok(runAgentArgs.length >= 2, `expected several runAgent calls, found ${runAgentArgs.length}`);
  for (const v of runAgentArgs) {
    assert.ok(/agentArgs\(/.test(v), `a runAgent call bypasses the resolver: ${v}`);
  }
  // …and the lanes that DO exist go through it.
  assert.ok((WEB.match(/agentArgs\(user,/g) || []).length >= 4,
    'the chat, resolver, assess and app-agent lanes all resolve through it');
});
