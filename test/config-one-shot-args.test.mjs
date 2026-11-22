// The one-shot config values (lib/one-shot.mjs, docs/adr/0008), as lib/config.mjs validateConfig
// loads them: one_shot_args (default, custom, invalid), one_shot_model (default, '', unknown,
// invalid), the fast_args default (thinking off), the --settings rule and its warnings. The server
// half (the argv a real turn gets, and a live edit) is test/config-live-reload.test.mjs and
// test/one-shot-lanes.test.mjs.
//
// THE --settings RULE (MEASURED 2026-10-12, Claude Code 2.1.161): the claude CLI honours only the
// FIRST --settings and ignores every later one entirely. A oneShot argv is claude_args, then
// one_shot_args, then — on a confined lane, which every app turn is — member_args; a fast-lane ask
// is fast_args, then member_args. An operator's --settings always wins: a default's (one_shot_args,
// fast_args) is DROPPED when claude_args or, on a confined turn, member_args carries one
// (yieldSettings, oneShotBaseArgs) — else member_args' would lose to it by position. The loader
// says so, and names the fix; it also warns when claude_args' silently beats member_args'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../lib/config.mjs';
import { oneShotBaseArgs, withoutSettings, hasSettings, oneShotModel, yieldSettings, withoutNoThinking } from '../lib/one-shot.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-oneshot-'));
fs.mkdirSync(path.join(root, 'workspace'), { recursive: true });
process.on('exit', () => rmTemp(root));
const base = (extra = {}) => ({ default_project: 'assistant', projects: { assistant: { dir: 'workspace' } }, ...extra });
// The documented default, written out here as the spec — never read back from the code under test.
const THINKING_OFF = ['--settings', '{"alwaysThinkingEnabled":false}'];

// Loads `extra` with console.warn captured; returns the loaded cfg and every warning line.
function load(t, extra) {
  const warn = t.mock.method(console, 'warn', () => {});
  const cfg = validateConfig(base(extra), root);
  const lines = warn.mock.calls.map((c) => c.arguments.join(' '));
  warn.mock.restore();
  return { cfg, lines, oneShotLines: lines.filter((l) => l.includes('one_shot_args')) };
}

test('unset → the default turns thinking off, silently', (t) => {
  const { cfg, oneShotLines } = load(t, {});
  assert.deepEqual(cfg.one_shot_args, THINKING_OFF);
  assert.deepEqual(oneShotLines, []);
});

test('config.example.json ships the loader default (R3: one value, two places, pinned)', (t) => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.ok(Array.isArray(example.one_shot_args), 'the example names the key');
  assert.deepEqual(example.one_shot_args, load(t, {}).cfg.one_shot_args);
});

test('a custom value is honoured as written, [] included', (t) => {
  for (const v of [[], ['--effort', 'low'], ['--settings', '{"probe":1}']]) {
    const { cfg, oneShotLines } = load(t, { one_shot_args: v });
    assert.deepEqual(cfg.one_shot_args, v, JSON.stringify(v));
    assert.deepEqual(oneShotLines, [], `${JSON.stringify(v)}: valid, so no warning`);
  }
});

test('an invalid value falls back to the default with a warning that names the key', (t) => {
  for (const v of ['--settings {}', ['--settings', 1], { a: 1 }, null, 7]) {
    const { cfg, oneShotLines } = load(t, { one_shot_args: v });
    assert.deepEqual(cfg.one_shot_args, THINKING_OFF, JSON.stringify(v));
    assert.equal(oneShotLines.length, 1, `${JSON.stringify(v)}: one warning`);
    assert.match(oneShotLines[0], /one_shot_args must be an array of strings/);
  }
});

// ── The --settings rule, as oneShotBaseArgs applies it to a oneShot turn's base argv ────────────
const OP = ['--model', 'sonnet', '--settings', '/etc/op.json'];
test('oneShotBaseArgs: an operator --settings ahead (claude_args) wins — exactly one --settings, its own; one_shot_args\' other flags ride', () => {
  const oneShot = ['--effort', 'low', ...THINKING_OFF];
  for (const lane of [OP, ['--model', 'sonnet', '--settings=/etc/op.json']]) {
    const argv = oneShotBaseArgs(lane, oneShot);
    assert.equal(argv.filter((a) => a === '--settings' || a.startsWith('--settings=')).length, 1, JSON.stringify(argv));
    assert.deepEqual(argv, [...lane, '--effort', 'low'], 'the lane\'s args, then one_shot_args minus its --settings');
  }
});

test('CONTROL: oneShotBaseArgs with no operator --settings keeps one_shot_args whole, in order', () => {
  assert.deepEqual(oneShotBaseArgs(['--model', 'sonnet'], THINKING_OFF), ['--model', 'sonnet', ...THINKING_OFF]);
  assert.deepEqual(oneShotBaseArgs(['--settingsx', 'a'], THINKING_OFF), ['--settingsx', 'a', ...THINKING_OFF], 'a flag that merely starts with --settings is not one');
  assert.deepEqual(oneShotBaseArgs(['--model', 'sonnet'], THINKING_OFF, ['--permission-mode', 'acceptEdits']), ['--model', 'sonnet', ...THINKING_OFF], 'member_args with no --settings');
});

// member_args sits BEHIND the default on a confined turn: kept, the default would be the FIRST
// --settings, the one the CLI applies, and the operator's member settings would be ignored.
test('a confined turn: member_args\' --settings makes the default yield — oneShot and fast lane alike; its other flags ride', () => {
  const member = ['--permission-mode', 'acceptEdits', '--settings', '/m.json'];
  assert.deepEqual(oneShotBaseArgs(['--model', 'sonnet'], ['--effort', 'low', ...THINKING_OFF], member), ['--model', 'sonnet', '--effort', 'low']);
  const fast = ['--model', 'haiku', '--dangerously-skip-permissions', ...THINKING_OFF];
  assert.deepEqual(yieldSettings(fast, member), ['--model', 'haiku', '--dangerously-skip-permissions']);
  assert.deepEqual(yieldSettings(fast, ['--settings=/m.json']), ['--model', 'haiku', '--dangerously-skip-permissions'], 'the = form too');
  assert.deepEqual(yieldSettings(fast, [], ['--permission-mode', 'acceptEdits']), fast, 'CONTROL: no operator --settings → the default whole');
  assert.deepEqual(yieldSettings(fast), fast, 'CONTROL: an unconfined turn passes no member_args');
});

// lib/runner.mjs's Windows shell fallback drops the SHIPPED default only (test/runner-shell-fallback.test.mjs).
test('withoutNoThinking drops exactly the shipped no-thinking pair, never an operator\'s own --settings', () => {
  assert.deepEqual(withoutNoThinking(['--model', 'haiku', ...THINKING_OFF, '-x']), ['--model', 'haiku', '-x']);
  for (const own of [['--settings', '{"alwaysThinkingEnabled":false,"x":1}'], ['--settings={"alwaysThinkingEnabled":false}'], ['--settings', '/etc/op.json']]) {
    assert.deepEqual(withoutNoThinking(['--model', 'haiku', ...own]), ['--model', 'haiku', ...own], JSON.stringify(own));
  }
});

test('withoutSettings drops both forms and only them; hasSettings sees both', () => {
  assert.deepEqual(withoutSettings(['-a', '--settings', '{"x":1}', '--settings=/f.json', '--settings', '-b', 'c']), ['-a', '-b', 'c'], 'a --settings whose next word is a flag drops alone');
  assert.equal(hasSettings(['--settings=/f']), true);
  assert.equal(hasSettings(['--settingsx']), false);
  assert.equal(hasSettings(undefined), false);
});

// ── The warnings: operator's settings win, and the fix is the operator's own settings file ───────
const FIX = /add "alwaysThinkingEnabled": false to your own settings file/;
test('claude_args passes --settings → one warning: oneShot turns drop one_shot_args\' --settings, the operator\'s win, the fix', (t) => {
  for (const flag of [['--settings', '/etc/op.json'], ['--settings=/etc/op.json']]) {
    const { lines } = load(t, { claude_args: ['--model', 'sonnet', ...flag] });
    const w = lines.filter((l) => l.includes('claude_args passes --settings'));
    assert.equal(w.length, 1, `${flag[0]}: exactly one warning`);
    assert.match(w[0], /oneShot turns drop one_shot_args' --settings: the operator's settings win/);
    assert.match(w[0], /oneShot turns run with the thinking setting in claude_args' settings/);
    assert.match(w[0], FIX);
  }
});

test('member_args passes --settings → confined turns drop one_shot_args\' AND fast_args\' --settings, the operator\'s win; one warning', (t) => {
  const { lines } = load(t, { member_args: ['--permission-mode', 'acceptEdits', '--settings', '/m.json'] });
  const w = lines.filter((l) => l.includes('member_args passes --settings'));
  assert.equal(w.length, 1);
  assert.match(w[0], /so every confined turn \(every app's turn, every member's\) drops the --settings of one_shot_args and fast_args: the operator's settings win/);
  assert.match(w[0], /those turns run with the thinking setting in member_args' settings/);
  assert.match(w[0], FIX);
  const onlyFast = load(t, { one_shot_args: [], member_args: ['--settings', '/m.json'] }).lines.filter((l) => l.includes('member_args passes'));
  assert.match(onlyFast[0], /drops the --settings of fast_args:/, 'one_shot_args [] has nothing to drop');
});

// Two OPERATOR values: nothing is dropped, both reach the CLI, and it applies the first.
test('claude_args AND member_args pass --settings → one warning: member_args\' are ignored on confined chat, oneShot and Verify turns', (t) => {
  const both = (l) => l.includes('claude_args and member_args both pass --settings');
  for (const extra of [{ claude_args: ['--settings', 'a.json'], member_args: ['--settings', 'b.json'] }, { claude_args: ['--settings=a.json'], member_args: ['--settings=b.json'], one_shot_args: [], fast_args: [] }]) {
    const w = load(t, extra).lines.filter(both);
    assert.equal(w.length, 1, JSON.stringify(extra));
    assert.match(w[0], /honours only the FIRST --settings and claude_args comes first, so on a confined chat, oneShot or Verify turn member_args' settings are IGNORED and claude_args' apply/);
  }
  assert.deepEqual(load(t, { claude_args: ['--settings', 'a.json'] }).lines.filter(both), [], 'CONTROL: claude_args alone');
  assert.deepEqual(load(t, { member_args: ['--settings', 'b.json'] }).lines.filter(both), [], 'CONTROL: member_args alone');
});

// SCAR (R13, 2026-10-12): with claude_args, member_args AND the defaults all passing --settings, the
// loader printed three warnings that contradicted each other. The member_args one said every
// confined turn — oneShot included — "runs with the thinking setting in member_args' settings",
// while the next said member_args' is IGNORED on a confined oneShot turn. The CLI applies the
// FIRST --settings, and on a confined chat, oneShot or Verify turn that is claude_args'. Each line
// now states one real outcome: oneShot turns → claude_args'; confined fast-lane asks (no
// claude_args in their argv) → member_args'; confined chat/oneShot/Verify → claude_args'.
const ALL_OPERATORS = { claude_args: ['--settings', 'a.json'], member_args: ['--permission-mode', 'acceptEdits', '--settings', 'b.json'] };
const clashLines = (lines) => lines.filter((l) => /passes --settings|both pass --settings/.test(l));
test('claude_args, member_args and both defaults pass --settings → three warnings, one per real outcome, none contradicting another', (t) => {
  const { cfg, lines } = load(t, ALL_OPERATORS);
  assert.ok(hasSettings(cfg.one_shot_args) && hasSettings(cfg.fast_args), 'CONTROL: both defaults carry --settings');
  const w = clashLines(lines);
  assert.equal(w.length, 3, w.join('\n'));
  const [oneShot, member, both] = w;
  assert.match(oneShot, /^\[config\] claude_args passes --settings, so oneShot turns drop one_shot_args' --settings: .*oneShot turns run with the thinking setting in claude_args' settings/);
  assert.match(member, /^\[config\] member_args passes --settings, so every confined fast-lane ask \(\/api\/ask, the job resolver.*\) drops the --settings of fast_args: the operator's settings win, and those asks run with the thinking setting in member_args' settings/);
  assert.match(member, FIX);
  assert.doesNotMatch(member, /one_shot_args|oneShot|every confined turn/, 'member_args\' never applies on a oneShot turn while claude_args\' is first');
  assert.match(both, /claude_args comes first, so on a confined chat, oneShot or Verify turn member_args' settings are IGNORED and claude_args' apply/);
  // The consistency check itself: no line says member_args' settings apply to a oneShot turn.
  for (const l of w) {
    if (/run with the thinking setting in member_args' settings/.test(l)) assert.doesNotMatch(l, /oneShot|one_shot_args/, l);
  }
});

test('claude_args and member_args pass --settings, fast_args none → no member_args line at all (its only default to drop is gone)', (t) => {
  const w = clashLines(load(t, { ...ALL_OPERATORS, fast_args: ['--model', 'haiku'] }).lines);
  assert.equal(w.length, 2, w.join('\n'));
  assert.match(w[0], /^\[config\] claude_args passes --settings, so oneShot turns drop one_shot_args' --settings/);
  assert.match(w[1], /claude_args and member_args both pass --settings/);
  assert.ok(!w.some((l) => l.includes('member_args passes --settings')), 'one_shot_args\' drop is claude_args\' outcome, said once');
});

test('CONTROL: no clash, no warning — the harness sees a silence when there is one', (t) => {
  const clash = (lines) => lines.filter((l) => /passes --settings/.test(l));
  const cases = [
    { what: 'nobody else passes --settings', extra: {} },
    { what: 'one_shot_args [] and a fast_args without --settings: nothing of ours to clash with member_args', extra: { one_shot_args: [], fast_args: ['--model', 'haiku'], member_args: ['--settings', 'b.json'] } },
    { what: 'one_shot_args []: nothing of ours to clash with claude_args', extra: { one_shot_args: [], claude_args: ['--settings', 'a.json'] } },
    { what: 'one_shot_args has no --settings', extra: { one_shot_args: ['--effort', 'low'], claude_args: ['--settings', 'a.json'] } },
    // fast_args never shares an argv with claude_args.
    { what: 'only fast_args passes --settings', extra: { fast_args: ['--settings', 'f.json'] } },
    { what: 'a flag that merely starts with --settings', extra: { claude_args: ['--settingsx', 'a'], member_args: ['--settingsx', 'b'] } },
  ];
  for (const { what, extra } of cases) assert.deepEqual(clash(load(t, extra).lines), [], what);
});

// ── fast_args: the background asks (/api/ask, the job resolver) ─────────────────────────────────
test('fast_args default: Haiku with thinking off; config.example.json ships the same (R3: pinned)', (t) => {
  const { cfg } = load(t, {});
  assert.deepEqual(cfg.fast_args, ['--model', 'haiku', '--dangerously-skip-permissions', ...THINKING_OFF]);
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.deepEqual(example.fast_args, cfg.fast_args);
});

test('CONTROL: a fast_args without the setting is honoured as written', (t) => {
  assert.deepEqual(load(t, { fast_args: ['--model', 'haiku'] }).cfg.fast_args, ['--model', 'haiku']);
});

// ── one_shot_model: which chat_models id answers a oneShot turn ───────────────────────────────
const modelLines = (lines) => lines.filter((l) => l.includes('one_shot_model'));
test('one_shot_model: unset → "claude", silently; config.example.json ships the same (R3: pinned)', (t) => {
  const { cfg, lines } = load(t, {});
  assert.equal(cfg.one_shot_model, 'claude');
  assert.deepEqual(modelLines(lines), []);
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.equal(example.one_shot_model, cfg.one_shot_model);
});

test('one_shot_model: a known id or "" is honoured silently', (t) => {
  for (const v of ['deepseek', '']) {
    const { cfg, lines } = load(t, { one_shot_model: v });
    assert.equal(cfg.one_shot_model, v);
    assert.deepEqual(modelLines(lines), [], JSON.stringify(v));
  }
});

test('one_shot_model: an unknown id → ONE warning at load, and requests keep their own model', (t) => {
  const { cfg, lines } = load(t, { one_shot_model: 'nope' });
  assert.equal(modelLines(lines).length, 1);
  assert.match(modelLines(lines)[0], /one_shot_model "nope" is not a chat_models id .*so oneShot requests use the model they ask for/);
  assert.equal(oneShotModel(cfg, 'deepseek'), 'deepseek');
  // The default is checked too: a chat_models without "claude" warns once.
  const custom = load(t, { chat_models: [{ id: 'local', label: 'L', group: 'Fast', provider: 'ollama', model: 'x' }] });
  assert.equal(modelLines(custom.lines).length, 1);
  assert.match(modelLines(custom.lines)[0], /one_shot_model "claude" is not a chat_models id \(local\)/);
});

// SCAR (R13): validated before the Research lane was appended to chat_models, so "research" — a lane
// a oneShot turn really can use — warned "not a chat_models id". Validated once the list is complete.
test('one_shot_model "research" with a Tavily key: no warning, and it answers (control: a truly unknown id still warns)', (t) => {
  const tavily = { tavily_key: 'tvly-test' };
  const { cfg, lines } = load(t, { ...tavily, one_shot_model: 'research' });
  assert.ok(cfg.chat_models.some((m) => m.id === 'research'), 'CONTROL: the Research lane is there');
  assert.deepEqual(modelLines(lines), [], 'no warning');
  assert.equal(oneShotModel(cfg, 'deepseek'), 'research', 'used');
  const unknown = load(t, { ...tavily, one_shot_model: 'nope' });
  assert.equal(modelLines(unknown.lines).length, 1);
  assert.match(modelLines(unknown.lines)[0], /one_shot_model "nope" is not a chat_models id \(.*research.*\)/);
  assert.equal(oneShotModel(unknown.cfg, 'deepseek'), 'deepseek', 'the request\'s model is used');
});

test('one_shot_model: not a string → the default, with a warning that names the key', (t) => {
  for (const v of [7, null, ['claude']]) {
    const { cfg, lines } = load(t, { one_shot_model: v });
    assert.equal(cfg.one_shot_model, 'claude', JSON.stringify(v));
    assert.match(modelLines(lines)[0], /one_shot_model must be a chat_models id or ""/);
  }
});

test('oneShotModel per request: a known id wins over the request\'s; "" and unknown keep the request\'s', () => {
  const chat_models = [{ id: 'claude' }, { id: 'deepseek' }];
  assert.equal(oneShotModel({ chat_models, one_shot_model: 'claude' }, 'deepseek'), 'claude');
  assert.equal(oneShotModel({ chat_models, one_shot_model: '' }, 'deepseek'), 'deepseek', 'CONTROL: "" = the request\'s model');
  assert.equal(oneShotModel({ chat_models, one_shot_model: 'nope' }, 'deepseek'), 'deepseek');
  assert.equal(oneShotModel({ chat_models, one_shot_model: 'claude' }, undefined), 'claude', 'a request with no model at all');
});
