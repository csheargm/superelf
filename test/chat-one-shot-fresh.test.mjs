// oneShot is ONE self-contained answer: no --resume, no history block · 一次性请求：不续接会话，不附历史
//
// THE BUG (measured 2026-10-13 on the live node, from the Claude CLI transcript of one Journal
// stationery conversation): the studio's design and every tweak reuse ONE convoId. On the Claude
// lane chat() then (1) resumed the CLI session, which already held every earlier turn and every full
// SVG, (2) prepended the history block (the last 10 messages, each a 20-40 KB SVG) and (3) sent the
// tweak prompt, which carries the current SVG again. Context per turn: 25k → 27k → 55k → 82k → 145k
// → 313k tokens. Past ~200k the CLI needs the 1M-context mode, which a subscription bills as usage
// credits, so every further tweak failed with "API Error: Usage credits required for 1M context".
//
// So a oneShot turn (docs/adr/0008 item 9) spawns the CLI WITHOUT --resume, sends EXACTLY its
// message, still stores both halves of the turn in the conversation, and never becomes the
// conversation's CLI session. CONTROL (R14): a conversation turn in the same conversation still
// resumes the conversation's session and still carries the history block, as before.
//
// END TO END (R6): the real web.mjs from this checkout and a FAKE `claude` that records argv, stdin
// and the session id it answered with (test/helpers-agent-lane.mjs). Each turn's message carries its
// own tag, and a turn's spawn is the FIRST carrying it (a later turn's history block may replay it).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startLaneServer, flagValues } from './helpers-agent-lane.mjs';
import { APP_ORIGIN_HEADER, APP_ORIGIN_VALUE } from '../lib/agent-origin.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const APP = 'journal';
const APP_HDR = { [APP_ORIGIN_HEADER]: APP_ORIGIN_VALUE };   // what the shell relay adds
// web.mjs buildHistoryPrompt's frame, written out as the spec: its opening and the current message.
const HISTORY_HEAD = '[Resuming conversation — prior context:]';
const CURRENT_HEAD = '[Current message:]\nUser: ';
const TWEAKS = 6;           // the live conversation failed on its sixth turn
const SVG_PATHS = 800;      // ~31 KB of SVG per prompt, the size of a real design
const NO_GROWTH = 1.05;     // the largest prompt over the smallest: tag digits only, never a turn

let L;
before(async () => { L = await startLaneServer(); });
after(async () => { if (L) { await L.stop(); rmTemp(L.root); } });

const readConvo = (id) => JSON.parse(fs.readFileSync(path.join(L.root, 'workspace', 'conversations', `${id}.json`), 'utf8'));
// A studio prompt is self-contained: the tweak carries the CURRENT svg (web/stationery-studio.inline.html).
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1100">${'<path d="M10 10L790 10" stroke="#88a"/>'.repeat(SVG_PATHS)}</svg>`;
const tweakMsg = (t) => `Revise this stationery SVG.\nChange: a warmer border ${t}\n\nCurrent SVG:\n${svg}`;

// One app turn as the shell relays it; returns the conversation id and THIS turn's spawn.
async function turn(t, body) {
  const ev = await L.chat({ app: APP, ...body }, { headers: APP_HDR });
  const done = ev.find((e) => e.type === 'done');
  assert.equal(done && done.text, 'ANSWERED', `${t}: the fake claude answered: ${JSON.stringify(ev).slice(0, 300)}`);
  const spawn = L.spawns(t).filter((s) => s.cli === 'claude')[0];
  assert.ok(spawn, `${t}: CONTROL — the fake claude really ran`);
  return { convoId: ev.find((e) => e.type === 'convo').id, spawn };
}
// A conversation the way the Journal's chat starts one: a conversation turn, which gets a CLI session.
async function seeded() {
  const s = L.tag('seed');
  const { convoId, spawn } = await turn(s, { message: `hello ${s}` });
  assert.equal(readConvo(convoId).sessionId, spawn.sid, 'CONTROL: a conversation turn records its CLI session');
  return { convoId, sid: spawn.sid };
}

test('oneShot in a conversation with turns and a CLI session: no --resume, the prompt is the message only', async () => {
  const { convoId, sid } = await seeded();
  const t = L.tag('tweak');
  const msg = tweakMsg(t);
  const one = await turn(t, { message: msg, convoId, oneShot: true });
  assert.equal(one.convoId, convoId, 'it is stored in the conversation it named');
  assert.deepEqual(flagValues(one.spawn.argv, '--resume'), [], `no --resume: ${JSON.stringify(one.spawn.argv)}`);
  assert.ok(!one.spawn.stdin.includes(HISTORY_HEAD), 'no history block');
  assert.equal(one.spawn.stdin, msg, 'the prompt is exactly the message');
  assert.equal(readConvo(convoId).sessionId, sid, 'the conversation keeps its own CLI session, not the oneShot\'s');
});

test(`${TWEAKS} oneShot turns in one conversation each send the same prompt size — no growth; every turn is stored`, async () => {
  const tags = [], msgs = [], spawns = [];
  let convoId = null;
  for (let i = 0; i < TWEAKS; i++) {
    tags.push(L.tag(`studio${i}`));
    msgs.push(tweakMsg(tags[i]));
    // The studio's first design starts the conversation; every tweak names it.
    const r = await turn(tags[i], { message: msgs[i], ...(convoId ? { convoId } : {}), oneShot: true, label: 'stationery' });
    if (convoId) assert.equal(r.convoId, convoId, `turn ${i}: the same conversation`);
    convoId = r.convoId;
    spawns.push(r.spawn);
  }
  const sizes = spawns.map((s) => s.stdin.length);
  assert.ok(Math.min(...sizes) >= svg.length, `CONTROL: every prompt carries the ~31 KB svg: ${sizes}`);
  assert.ok(Math.max(...sizes) / Math.min(...sizes) <= NO_GROWTH, `prompt sizes do not grow turn on turn: ${sizes}`);
  spawns.forEach((s, i) => {
    assert.deepEqual(flagValues(s.argv, '--resume'), [], `turn ${i}: no --resume`);
    assert.equal(s.stdin, msgs[i], `turn ${i}: exactly the message, no history block`);
  });
  const c = readConvo(convoId);
  assert.equal(c.messages.length, 2 * TWEAKS, 'the stored conversation records every oneShot turn, both halves');
  msgs.forEach((m, i) => {
    assert.deepEqual([c.messages[2 * i].role, c.messages[2 * i].text], ['me', m], `turn ${i}: the request`);
    assert.deepEqual([c.messages[2 * i + 1].role, c.messages[2 * i + 1].text], ['md', 'ANSWERED'], `turn ${i}: the answer`);
  });
  assert.equal(c.sessionId, null, 'a conversation of oneShot turns only has no CLI session to resume');
});

test('CONTROL: a conversation turn in the same conversation still resumes ITS session and carries the history block', async () => {
  const { convoId, sid } = await seeded();
  const shots = [L.tag('shotA'), L.tag('shotB')];
  for (const t of shots) await turn(t, { message: tweakMsg(t), convoId, oneShot: true });
  const t = L.tag('followup');
  const msg = `and a darker ink ${t}`;
  const next = await turn(t, { message: msg, convoId });
  assert.deepEqual(flagValues(next.spawn.argv, '--resume'), [sid], 'it resumes the conversation\'s session, not a oneShot\'s');
  assert.ok(next.spawn.stdin.startsWith(HISTORY_HEAD), 'the history block still rides');
  for (const s of shots) assert.ok(next.spawn.stdin.includes(s), `the block carries the oneShot turn the session never saw (${s})`);
  assert.ok(next.spawn.stdin.endsWith(CURRENT_HEAD + msg), 'and ends with the current message');
  assert.equal(readConvo(convoId).sessionId, next.spawn.sid, 'a conversation turn records its session, as before');
});
