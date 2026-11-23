// lib/member-lanes.mjs — members default to a plain chat model; agent lanes are opt-in (F4-2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentAllowed, lanesFor, memberLane, PLAIN_LANE_STATUS } from '../lib/member-lanes.mjs';

const M = [
  { id: 'deepseek', label: 'DeepSeek', provider: 'ollama' },
  { id: 'glm', label: 'GLM', provider: 'ollama' },
  { id: 'research', label: 'Research', provider: 'research' },
  { id: 'claude', label: 'Claude', provider: 'claude' },
  { id: 'gpt', label: 'GPT', provider: 'codex' },
];
const owner = { id: 'owner', role: 'owner' }, kid = { id: 'kid', role: 'member' }, trusted = { id: 'teen', role: 'member', agent: true };

test('who may use agent lanes: the owner, and members the owner opted in', () => {
  assert.equal(agentAllowed(owner), true);
  assert.equal(agentAllowed(kid), false);
  assert.equal(agentAllowed(trusted), true);
  assert.equal(agentAllowed(null), false);
  assert.equal(agentAllowed({ id: 'v1', role: 'member', demo: true }), true, 'the public demo keeps its own lanes (not a family member)');
});

test('the chooser hides Claude and GPT from a member who was not opted in', () => {
  assert.deepEqual(lanesFor(kid, M).map((m) => m.id), ['deepseek', 'glm', 'research']);
  assert.deepEqual(lanesFor(trusted, M).map((m) => m.id), M.map((m) => m.id), 'CONTROL: opted in sees them all');
  assert.deepEqual(lanesFor(owner, M).map((m) => m.id), M.map((m) => m.id));
});

test('a member\'s default (no lane) or an agent pick answers on the first served plain lane, and says so', () => {
  const r = memberLane(kid, null, M);
  assert.equal(r.lane.id, 'deepseek'); assert.match(r.status, new RegExp(PLAIN_LANE_STATUS)); assert.equal(r.blocked, false);
  assert.equal(memberLane(kid, M[3], M).lane.id, 'deepseek', 'an explicit Claude pick (an app\'s default) is moved too');
  assert.equal(memberLane(kid, null, M, (m) => m.id !== 'deepseek').lane.id, 'glm', 'a lane no longer served is skipped');
  assert.deepEqual(memberLane(kid, M[1], M), { lane: M[1], status: null, blocked: false }, 'a plain pick stays');
  assert.deepEqual(memberLane(trusted, null, M), { lane: null, status: null, blocked: false }, 'CONTROL: opted in keeps the agent default');
  assert.equal(memberLane(kid, null, [M[3], M[4]]).blocked, true, 'no plain lane at all: blocked, never the agent');
});
