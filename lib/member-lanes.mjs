// Members answer on a plain chat model · 成员默认使用普通聊天模型 (F4-2, owner decision 2026-11-23).
//
// The agent lanes (provider claude / codex — the host CLI with its skills, connectors and tools) are
// the owner's. A member uses them only when the owner turns on "AI 工具 · Agent tools" for that
// member (users[].agent === true in config.json). Everyone else gets the first plain lane that is
// still served, and is told so once per turn; with no plain lane at all the turn says that plainly.
import { isAgentLane } from './model-review-agent.mjs';

export const PLAIN_LANE_STATUS = '你的账号使用普通聊天模型 · Your account uses a plain chat model';
export const NO_PLAIN_LANE_TEXT = '没有可用的普通聊天模型，请让管理员设置 · No plain chat model is set up — ask the owner';

// A demo visitor (lib/demo.mjs) is not a family member: the demo node's own lanes and caps govern it, unchanged.
export const agentAllowed = (user) => !!user && (user.role === 'owner' || user.agent === true || user.demo === true);

// The lanes this user may pick (the /api/models chooser).
export const lanesFor = (user, models) => (agentAllowed(user) ? models : models.filter((m) => !isAgentLane(m)));

// The lane that really answers. `lane` null means the default agent lane (PA_CHAT_LANE in web.mjs).
// → { lane, status, blocked }: blocked = no plain lane exists for a member who may not use an agent.
export function memberLane(user, lane, models, served = () => true) {
  if (agentAllowed(user) || (lane && !isAgentLane(lane))) return { lane, status: null, blocked: false };
  const plain = (models || []).find((m) => !isAgentLane(m) && m.provider === 'ollama' && served(m)) || null;
  return plain ? { lane: plain, status: `${PLAIN_LANE_STATUS} — ${plain.label}`, blocked: false } : { lane: null, status: null, blocked: true };
}
