// A skill（技能）must behave the same whichever lane answers.
//
// SCAR: resolveSystemPrompts was called only inside the ollama branch, so the Bible app's
// "reply in Chinese, keep English keywords" directive applied on the fast lanes and was
// silently DROPPED whenever the Claude agent answered. Same question, two behaviours, with
// nothing anywhere to explain the difference — the worst shape a bug can take, because the
// user cannot even describe it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude, APPEND_SYSTEM_PROMPT_MAX } from '../lib/runner.mjs';
import { OVERRIDABLE_PROMPT_MAX } from '../lib/config.mjs';
import { ollamaMessages, agentPrompt, buildSummaryPrompt } from '../lib/assess.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
const ASSESS = fs.readFileSync(path.join(ROOT, 'lib', 'assess.mjs'), 'utf8');

// A stub CLI that echoes its own argv, so we can see exactly what the lane was given.
const stub = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-skill-'));
  const bin = path.join(d, 'fake.mjs');
  fs.writeFileSync(bin, '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"result",subtype:"success",result:JSON.stringify(process.argv.slice(2))}));\n');
  fs.chmodSync(bin, 0o755);
  return { d, bin };
};
const argvFor = async (systemPrompt) => {
  const { d, bin } = stub();
  const r = await runClaude({ claudeCmd: bin, cwd: d, prompt: 'hi', systemPrompt, timeoutMs: 20000 });
  return JSON.parse(r.text);
};

test('the agent lane actually receives the skill', async () => {
  const argv = await argvFor('请用中文回答，关键术语保留英文');
  const i = argv.indexOf('--append-system-prompt');
  assert.ok(i >= 0, `the flag must be passed, got: ${argv.join(' ')}`);
  assert.equal(argv[i + 1], '请用中文回答，关键术语保留英文', 'verbatim, not summarised');
});

test('no skill means no flag — never an empty directive', async () => {
  for (const v of [undefined, null, '', '   ', 42, {}]) {
    assert.ok(!(await argvFor(v)).includes('--append-system-prompt'), `${JSON.stringify(v)} must add nothing`);
  }
});

test('the skill is capped ONCE, where it is resolved, so every lane gets the same bound', () => {
  // The 2000 used to live in two places that only looked alike: the ollama lane cut the app
  // directive, and runClaude cut the WHOLE joined prompt — dropping the agent's capability text
  // (test/agent-prompt-argv.test.mjs). Now one cap, in the one resolver both lanes call (R3).
  assert.equal(OVERRIDABLE_PROMPT_MAX, 2000);
  assert.match(WEB, /const pick = \(v\) => \(typeof v === 'string' && v\.trim\(\) \? v\.trim\(\)\.slice\(0, OVERRIDABLE_PROMPT_MAX\) : null\);/,
    'resolveSystemPrompts caps every piece it returns');
  assert.ok(!/prompts\.app\.slice\(0, 2000\)/.test(WEB), 'and no lane in web.mjs keeps a private copy');
});

test('the Verify panel trusts that cap — it gets the resolver\'s output and cuts nothing again', () => {
  // lib/assess.mjs kept three literal 2000 slices of its own. Redundant once the resolver capped,
  // and a second number that could drift below it — cutting a directive the chat lanes send whole.
  assert.match(WEB, /prompts: resolveSystemPrompts\(user, app, system\), fastModelId,/, 'the panel gets the resolved, capped prompts');
  const builders = ASSESS.replace(/\/\/[^\n]*/g, '').match(/export function (ollamaMessages|agentPrompt|buildSummaryPrompt)[\s\S]*?\n\}/g) || [];
  assert.equal(builders.length, 3, 'the scan really covers all three builders — a rewrite must not drop one from it');
  // The directive itself, by any cutting method, or any fixed-length slice. (History slices such as
  // convoMessages.slice(0, -1) are not a cut of the directive.)
  const recut = /(prompts\.(app|global)|appDirective)\s*\.\s*(slice|substring|substr)\(|\.slice\(0, \d+\)/;
  assert.ok(!recut.test(builders.join('\n')), 'no prompt builder in lib/assess.mjs re-cuts the directive');
  const full = 'D'.repeat(OVERRIDABLE_PROMPT_MAX - 1) + 'Z';   // the largest directive the resolver lets through
  const prompts = { global: 'G', app: full };
  assert.ok(ollamaMessages(prompts, []).some((m) => m.content === full), 'ollama panel: whole');
  assert.ok(agentPrompt(prompts, [], 'Q').includes(full), 'agent panel: whole');
  assert.ok(buildSummaryPrompt({ sysPrompt: 'S', question: 'Q', results: [], answers: {}, skipped: [], appDirective: full }).includes(full), 'summarizer: whole');
});

test('the runner caps only what argv cannot carry — far above any skill', async () => {
  const argv = await argvFor('x'.repeat(APPEND_SYSTEM_PROMPT_MAX * 2));
  assert.equal(argv[argv.indexOf('--append-system-prompt') + 1].length, APPEND_SYSTEM_PROMPT_MAX);
  assert.ok(APPEND_SYSTEM_PROMPT_MAX >= 4 * OVERRIDABLE_PROMPT_MAX, 'room for both skills AND the capability text');
});

test('BOTH lanes resolve the skill the same way — one function, two callers', () => {
  // The bug was one caller. Count them: the ollama branch and the agent branch.
  const calls = (WEB.match(/resolveSystemPrompts\(user, app, system\)/g) || []).length;
  assert.ok(calls >= 2, `every lane that answers must resolve the skill, found ${calls} call(s)`);
  // Both resolved prompts must travel, in that order. Deliberately a PREFIX match, not the whole
  // array: the lane also appends server-owned capability text that no profile override may delete
  // (agentCapabilities), and forbidding anything after `app` would make this test fail on an
  // addition it has no opinion about.
  assert.match(WEB, /systemPrompt: \[agentPrompts\.global, agentPrompts\.app[,\]]/,
    'and the agent lane must actually pass what it resolved');
  // Precedence stays one definition (R3): profile override → config → built-in.
  assert.equal((WEB.match(/function resolveSystemPrompts/g) || []).length, 1);
});

test('the global skill and the app skill both travel, in order', async () => {
  // web.mjs joins them global-then-app; the app directive is the more specific, so it comes
  // last and wins where they disagree.
  const joined = ['GLOBAL RULE', 'APP RULE'].filter(Boolean).join('\n\n');
  const argv = await argvFor(joined);
  const v = argv[argv.indexOf('--append-system-prompt') + 1];
  assert.ok(v.indexOf('GLOBAL RULE') < v.indexOf('APP RULE'), 'app directive last — more specific wins');
});
