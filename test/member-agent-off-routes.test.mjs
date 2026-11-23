// Agent tools off reaches EVERY agent route · 未开启 AI 工具的成员在所有通道都不启动 agent (F4-2, GPT review).
// /api/chat was gated; /api/ask (the shell broker's app 'ask') and the summary follow-up writers were not.
// A member without `agent: true` must get the plain refusal, and no claude/codex process may start.
// CONTROL: the same ask from the opted-in member really spawns the fake CLI.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { api } from './helpers-web.mjs';
import { APP_ORIGIN_HEADER, APP_ORIGIN_VALUE } from '../lib/agent-origin.mjs';
import { startLaneServer, LANE_USERS, MEMBER_TOKEN } from './helpers-agent-lane.mjs';
import { AGENT_OFF_TEXT } from '../lib/member-lanes.mjs';

const OFF_TOKEN = 'test-member-off-token-0123456789ab';
const APP_HDR = { [APP_ORIGIN_HEADER]: APP_ORIGIN_VALUE };
let L;
before(async () => {
  L = await startLaneServer({ extraConfig: { users: [...LANE_USERS,
    { id: 'mom', name: 'Mom', role: 'member', token: OFF_TOKEN, workspace: 'workspace-mom' }] } });
});
after(async () => { if (L) await L.stop(); });

test('/api/ask: a member with Agent tools off is refused and no agent starts', async () => {
  const t = L.tag('ask-off');
  const r = await L.ask({ message: `q ${t}` }, { token: OFF_TOKEN, headers: APP_HDR });
  assert.deepEqual(r, { ok: false, text: AGENT_OFF_TEXT });
  assert.equal(L.spawns(t).length, 0, 'no claude/codex spawn');
});

test('CONTROL: the opted-in member\'s ask runs the agent', async () => {
  const t = L.tag('ask-on');
  await L.ask({ message: `q ${t}` }, { token: MEMBER_TOKEN, headers: APP_HDR });
  assert.ok(L.spawns(t).length >= 1, 'the fake CLI ran');
});

test('/api/summary-followup: a member with Agent tools off starts no agent writer', async () => {
  const t = L.tag('fu-off');
  const r = await api(L.port, '/api/summary-followup', { method: 'POST', body: JSON.stringify({ text: `## Open to-dos\n- call the plumber ${t}` }), headers: { authorization: `Bearer ${OFF_TOKEN}` } });
  await r.text();
  assert.equal(L.spawns(t).length, 0, 'no claude/codex spawn for the follow-up');
});
