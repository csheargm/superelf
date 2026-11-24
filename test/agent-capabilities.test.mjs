// What the agent is told it can DO · 告知 agent 的真实能力
//
// SCAR: a family member's weather app answered "I need permission to run the websearch tool".
// Nobody could grant it — there is no approver. The instructions the agent was working from lived
// in the member's workspace CLAUDE.md, which told every user to shell out to
// `node ../tools/websearch.mjs`: unfollowable in a confined lane, and pointing outside the
// workspace besides.
//
// The deeper fault is WHERE those instructions lived. A workspace is copied from the template
// once, at provisioning (`!existsSync(workspace)`), and never updated again — so the day a
// capability changes, every existing workspace is wrong, with no migration path. Capability facts
// therefore belong to the server and are re-read every turn.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentCapabilities, appContract, REPLY_LANGUAGE_RULE } from '../lib/config.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');

test('every lane is told how an app reaches the web, owner or not', () => {
  for (const role of ['owner', 'member', undefined]) {
    const t = agentCapabilities(role, appContract(ROOT));
    assert.match(t, /`websearch`/, `${role}: the kind is named`);
    assert.match(t, /results:\[\{title,url,snippet\}\]/, `${role}: and its result shape`);
    // The failure contract travels WITH the kinds list — an app that renders ok:false as an answer
    // is the bug that started all of this, and it is stated once, in superelf.md.
    assert.match(t, /A failure is `\{ok:false, code, error, text\}`/, `${role}: and what a failure looks like`);
  }
});

test('only a non-owner is told it is confined — and an unknown role counts as confined', () => {
  // Confinement starts with the absence of the owner's bypass (web.mjs agentArgs), so anything that is
  // not exactly 'owner' must get the note. Guessing "privileged" for an unrecognised role would
  // tell a member it can run Bash.
  assert.ok(!agentCapabilities('owner').includes('confined lane'), 'the owner is not confined and is not told it is');
  for (const role of ['member', 'guest', '', null, undefined]) {
    const t = agentCapabilities(role);
    assert.match(t, /confined lane/, `${JSON.stringify(role)} is treated as confined`);
    assert.match(t, /never ask for one/, 'and told that asking for permission reaches no one');
  }
});

test('the note is appended OUTSIDE the overridable prompt chain', () => {
  // A profile systemPrompts.global override REPLACES the guard prompt. If the capability list
  // rode inside that chain, a user who customised their assistant's personality would silently
  // delete the only description of what it can do.
  // laneRole, not user.role: the owner's APP request runs confined, so it is told it is
  // (test/app-agent-confinement.test.mjs drives that over HTTP).
  // A oneShot turn (PAChat.complete) drops only the app contract; test/chat-one-shot.test.mjs
  // reads both prompts back from argv.
  assert.match(WEB, /systemPrompt: agentSystemPrompt\(\[agentPrompts\.global, agentPrompts\.app, origin\.fromApp \? noChangeRule\(chatRole\) : null\], agentCapabilities\(laneRole\(user, origin\), oneShot \? null : APP_CONTRACT\), turnFacts\)/,
    'the chat agent lane appends it after the override chain');
  assert.match(WEB, /5 \* 60000, agentCapabilities\(laneRole\(user, origin\), APP_CONTRACT\)\)/,
    'and the app ask lane sends the same one');
  assert.match(WEB, /const APP_CONTRACT = appContract\(ROOT\);/, 'read ONCE at boot, from the one file');
});

test('there is ONE capability text, not one per lane', () => {
  // Two copies would drift, and the lane a user happened to be on would decide what the machine
  // claimed it could do (R3).
  const defs = WEB.match(/const ASK_SYSTEM/g) || [];
  assert.equal(defs.length, 0, 'the earlier lane-local copy is gone');
  assert.equal((WEB.match(/agentCapabilities\(/g) || []).length, 2, 'both lanes call the shared one');
});

test('the shipped template documents the same broker call the server promises', () => {
  // New workspaces still get written instructions; they must not contradict the system prompt.
  const tpl = fs.readFileSync(path.join(ROOT, 'workspace.example', 'CLAUDE.md'), 'utf8');
  assert.match(tpl, /kind: 'websearch'/, 'the template teaches the broker');
  // Whitespace-tolerant: the prose is hard-wrapped, and pinning the line breaks would make this
  // fail on a reflow that changed nothing.
  assert.match(tpl.replace(/\s+/g, ' '), /only the owner's lane may run them/, 'and is honest about who may shell out');
});

test('the app contract reaches the agent by being READ from superelf.md, not restated', () => {
  // The contract already existed — clause (a) of superelf.md has always said every app mounts
  // PAChat at <!--PA_CHAT_UI-->, and test/app-contract.test.mjs enforces it. It was restated here
  // in prose instead, which meant a future edit to superelf.md would have had to be made twice,
  // and the copy nobody remembered becomes a lie the agent is told with full confidence.
  const md = fs.readFileSync(path.join(ROOT, 'superelf.md'), 'utf8');
  const contract = appContract(ROOT);
  // Every line of it must come from the file — that is what "not a copy" means operationally.
  for (const line of contract.split('\n').map((l) => l.trim()).filter((l) => l.length > 40)) {
    if (line.startsWith('Broker kinds an app may use')) continue;   // the one connecting phrase
    assert.ok(md.includes(line), `not from superelf.md: ${line.slice(0, 60)}`);
  }
  for (const c of ['**(a)', '**(b)', '**(c)', '**(d)']) assert.ok(contract.includes(c), `clause ${c} travels`);
  assert.match(contract, /<!--PA_CHAT_UI-->/, 'so the agent learns the marker from the contract itself');
});

test('a truncated or clause-less contract STOPS the node instead of shipping quietly', () => {
  // The failure that matters: if extraction silently returned '', every app generated from then
  // on would lose its Ask-AI surface and nothing would report it. Losing a clause must be loud.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-contract-'));
  try {
    fs.writeFileSync(path.join(dir, 'superelf.md'), '# superelf.md\n\n## Something else\n\ntext\n');
    assert.throws(() => appContract(dir), /four clauses/, 'a missing section throws');
    fs.writeFileSync(path.join(dir, 'superelf.md'),
      '# x\n\n## The four clauses\n\n**(a) one**\n\n**(b) two**\n\n**(c) three**\n');
    assert.throws(() => appContract(dir), /\*\*\(d\)/, 'a dropped clause throws, naming it');
  } finally { rmTemp(dir); }
});

test('the hand-written copies are gone', () => {
  // R1: the point of the change was deletion, so this fails if one creeps back.
  const cfg = fs.readFileSync(path.join(ROOT, 'lib', 'config.mjs'), 'utf8');
  assert.ok(!/AGENT_APP_CHAT_NOTE/.test(cfg), 'no second copy of clause (a)');
  assert.ok(!/AGENT_BROKER_NOTE/.test(cfg), 'no second copy of the broker kinds');
  // What legitimately stays: rules that are NOT properties of an app, so they do not belong in
  // superelf.md either. Duplication pointing the other way would be just as wrong.
  assert.match(cfg, /REPLY_LANGUAGE_RULE/, 'which language to answer in is a runtime rule');
  assert.match(cfg, /AGENT_CONFINED_NOTE/, 'and so is what this lane may touch');
  assert.ok(!md_has(path.join(ROOT, 'superelf.md'), 'English in, English out'), 'and neither leaked into the contract');
});
function md_has(p, needle) { return fs.readFileSync(p, 'utf8').includes(needle); }

test('every lane is told to answer in the language it was written to', () => {
  // MEASURED before the fix: the same English question asked as a member came back in Chinese on
  // 2 of 3 runs, and as the owner on 0 of 2. Nothing in either prompt chain was Chinese — the
  // difference was how much steering each workspace's CLAUDE.md carried, and with weak steering
  // the model drifted toward the language of the product's own bilingual chrome.
  for (const role of ['owner', 'member', undefined]) {
    assert.match(agentCapabilities(role), /English in, English out/, `${role}: the rule travels`);
  }
  // It must FOLLOW the person, not pin one language: this household writes both. A rule that just
  // said "answer in English" would pass a naive check and break every Chinese speaker in the house.
  assert.match(REPLY_LANGUAGE_RULE, /中文 进，中文 出/, 'Chinese in, Chinese out');
  assert.ok(!/always (answer|reply) in English/i.test(REPLY_LANGUAGE_RULE), 'never pins one language');
});

test('the rule reaches the FAST lanes too, outside the override chain', () => {
  // It matters most there: most configured fast lanes are Chinese-trained models. And it sits
  // after prompts.global, which a profile override REPLACES — being answered in your own language
  // must not be something a customised assistant can lose.
  const web = fs.readFileSync(path.join(ROOT, 'web.mjs'), 'utf8');
  assert.match(web, /const sys = \[prompts\.global, prompts\.app, REPLY_LANGUAGE_RULE, origin\.fromApp \? noChangeRule\(chatRole\) : null, turnFacts\(\)\]/,
    'the fast lane appends it after the overridable prompts');
  assert.equal((web.match(/REPLY_LANGUAGE_RULE/g) || []).length, 2, 'imported once, used once — the agent lane gets it via agentCapabilities');
});
