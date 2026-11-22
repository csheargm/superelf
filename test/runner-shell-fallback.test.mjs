// The Windows shell fallback keeps the fast lanes running · Windows shell 回退不再拒绝快速通道
//
// lib/wincmd.mjs spawnSpec falls back to a shell (how:'unresolved', shell:true) when claude_cmd
// resolves to no .exe and no readable .cmd shim, and lib/runner.mjs then refuses any argument
// cmd.exe cannot carry. The no-thinking default (lib/one-shot.mjs NO_THINKING_ARGS, now in fast_args
// and one_shot_args) is a JSON value with double quotes, so on such a node it refused runs that used
// to work — the job resolver among them (R13 finding). runner.mjs now drops exactly that pair there,
// says once that thinking stays on, and runs; anything else cmd.exe cannot carry is still refused.
//
// The wincmd test style: win32 is driven from any OS through spawnSpec's injection points
// (runClaude's specOpts), and the run is REAL — Node's shell:true join is the same code path on
// /bin/sh and cmd.exe (test/wincmd.test.mjs, THE PREMISE). The fake is launchable on this OS
// (writeFakeCli) and records the argv it really received.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runClaude } from '../lib/runner.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const THINKING_OFF = ['--settings', JSON.stringify({ alwaysThinkingEnabled: false })];   // the spec, written out
const FAST_DEFAULT = ['--model', 'haiku', '--dangerously-skip-permissions', ...THINKING_OFF];
const UNRESOLVED = { platform: 'win32', found: null };   // spawnSpec → { shell: true, how: 'unresolved' }

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-shellfb-'));
after(() => rmTemp(dir));
const log = path.join(dir, 'runs.jsonl');
const FAKE = writeFakeCli(dir, 'claude', `#!/usr/bin/env node
import fs from 'node:fs';
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), stdin: s }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'ANSWERED', session_id: 's' }) + '\\n');
});
`);
const runs = (prompt) => {
  let txt = ''; try { txt = fs.readFileSync(log, 'utf8'); } catch { /* no run yet — an empty list, asserted on */ }
  return txt.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.stdin === prompt);
};
let seq = 0;
async function run(extraArgs, { specOpts, systemPrompt } = {}) {
  const prompt = `P-${++seq}`;
  const r = await runClaude({ claudeCmd: FAKE, extraArgs, cwd: dir, prompt, systemPrompt, timeoutMs: 30000, specOpts });
  return { r, runs: runs(prompt) };
}
const settingsIn = (argv) => argv.filter((a, i) => a === '--settings' || argv[i - 1] === '--settings');

test('fallback: the default fast_args runs without its no-thinking pair, and says so ONCE (it used to be refused)', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const first = await run(FAST_DEFAULT, { specOpts: UNRESOLVED });
  assert.equal(first.r.text, 'ANSWERED', `the run went ahead: ${first.r.text}`);
  assert.equal(first.runs.length, 1, 'one call, one CLI run');
  assert.deepEqual(settingsIn(first.runs[0].argv), [], 'the --settings pair was dropped');
  assert.deepEqual(first.runs[0].argv.slice(-3), ['--model', 'haiku', '--dangerously-skip-permissions'], 'every other flag rides, in order');
  const second = await run(FAST_DEFAULT, { specOpts: UNRESOLVED });
  assert.equal(second.r.text, 'ANSWERED');
  const lines = warn.mock.calls.map((c) => c.arguments.join(' '));
  assert.equal(lines.length, 1, `one warning for two runs: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /runs through cmd\.exe, which cannot carry the --settings JSON that turns thinking off: those runs keep thinking on/);
});

test('CONTROL: a resolved spawn (no shell) keeps the pair whole — the drop is the fallback\'s alone', async () => {
  const { r, runs: got } = await run(FAST_DEFAULT);
  assert.equal(r.text, 'ANSWERED');
  assert.deepEqual(settingsIn(got[0].argv), THINKING_OFF);
});

test('fallback still refuses what cmd.exe cannot carry: an operator\'s own --settings JSON, a multi-line prompt — nothing spawned', async () => {
  for (const [what, extraArgs, systemPrompt] of [
    ['an operator\'s own --settings JSON', ['--model', 'haiku', '--settings', '{"alwaysThinkingEnabled":false,"x":1}'], undefined],
    ['the = form of the same default', ['--settings={"alwaysThinkingEnabled":false}'], undefined],
    ['a multi-line system prompt', FAST_DEFAULT, 'line one\nline two'],
  ]) {
    const { r, runs: got } = await run(extraArgs, { specOpts: UNRESOLVED, systemPrompt });
    assert.equal(r.ok, false, what);
    assert.match(r.text, /Cannot run ".*" safely on Windows/, what);
    assert.equal(got.length, 0, `${what}: nothing was spawned`);
  }
});
