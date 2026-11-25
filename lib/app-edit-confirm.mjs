// 改 · Apply — the confirm step of the one app chat (docs/plans/unified-app-chat.md, ADR 0042).
//
// A change request in the app's chat is answered with a PLAN first; the reply ends with PLAN_MARKER,
// which the server strips and turns into ONE server-minted confirm id. PAChat shows 「改 · Apply」;
// the tap sends applyMessage(id) as the next turn. Only that turn may write the app, and only once:
// the id is bound to the user, the app and the plan it was minted for, and lives CONFIRM_TTL_MS.
// No id → no write: an unconfirmed edit turn that changed the app anyway is rolled back
// (lib/app-edit.mjs finishAppEdit). A forged id, or one typed from someone else's turn, is refused.
// In memory only: a restart forgets pending plans, so the user taps Apply again after re-asking.
import crypto from 'node:crypto';

export const CONFIRM_TTL_MS = 10 * 60 * 1000;
export const APPLY_LABEL = '改 · Apply';
export const PLAN_MARKER = '[[apply]]';
export const PLAN_MAX = 4000;
const STORE_MAX = 500;
export const PLAN_TOO_LONG = '⚠ 计划太长，无法确认；请把要改的拆小一点 · This plan is too long to confirm; ask for a smaller change';
// The label line alone, then only further lines: an attachment line the composer appends after the label must not turn a real tap into an unconfirmed turn.
const APPLY_RE = /^\s*改 · Apply \(([A-Za-z0-9_-]{12,32})\)\s*(?:\n|$)/;

const store = new Map();   // id → { who, slug, plan, at }
const refuse = (error) => Object.assign(new Error(error), { status: 403, code: 'bad_confirm' });
export const CONFIRM_REFUSED = '这个确认已失效，请重新说明要改什么 · This confirmation is no longer valid — say again what to change';

export const applyMessage = (id) => `${APPLY_LABEL} (${id})`;
export function applyIdOf(message) { const m = APPLY_RE.exec(String(message || '')); return m ? m[1] : null; }

function prune(now) {
  for (const [id, v] of store) if (now - v.at > CONFIRM_TTL_MS) store.delete(id);
  while (store.size >= STORE_MAX) store.delete(store.keys().next().value);   // oldest first: Map keeps insertion order
}

export function mintConfirm({ who, slug, plan, request, convo }, now = Date.now()) {
  if (!who || !slug) throw new Error('confirm needs a user and an app · 确认需要用户和应用');
  prune(now);
  // A new plan replaces this chat's earlier ones (GPT review r1): a second "yes" never applies a plan the user revised.
  if (convo) for (const [k, v] of store) if (v.who === who && v.slug === slug && v.convo === convo) store.delete(k);
  const id = crypto.randomBytes(12).toString('base64url');
  store.set(id, { who, slug, convo: convo || null, plan: String(plan || '').slice(0, PLAN_MAX), request: String(request || '').slice(0, PLAN_MAX), at: now });
  return id;
}

// {plan, request} the id was minted for, stored apart so a long request never pushes out the plan the user saw (request: the user's own words); the id is gone after this call whatever the outcome (single use).
export function consumeConfirm(id, { who, slug }, now = Date.now()) {
  const v = typeof id === 'string' ? store.get(id) : undefined;
  if (v) store.delete(id);
  if (!v || v.who !== who || v.slug !== slug || now - v.at > CONFIRM_TTL_MS) throw refuse(CONFIRM_REFUSED);
  return { plan: v.plan, request: v.request };
}

// The reply of an unconfirmed turn → its text without the marker, and whether it offered a change.
export function planOffer(text) {
  const s = String(text || '');
  // Only a reply that ENDS with the marker offers (GPT review r1): one quoted mid-answer is not a plan.
  if (!s.includes(PLAN_MARKER)) return { text: s, offered: false };
  // On its own final line, after a plan (GPT review r2): a sentence ending in the marker, or the marker alone, offers nothing.
  const lines = s.trimEnd().split('\n');
  const before = lines.slice(0, -1).join('\n').split(PLAN_MARKER).join('').trim();
  if (lines[lines.length - 1].trim() !== PLAN_MARKER || !before) return { text: s.split(PLAN_MARKER).join(''), offered: false };
  return { text: s.split(PLAN_MARKER).join('').replace(/\s+$/, ''), offered: true };
}

// THE one rule for concrete values in an app change (R3): the plan, the Apply turn and its reply all use it.
// Owner report 2026-11-24: "make it green" was planned as the app's "green accent" token, which was blue.
export const CONCRETE_VALUE_RULE = [
  'When the user names a colour, size, text or other value, use that literal value (e.g. a green hex such as #2e7d32, 18px, the exact words),',
  "never a theme variable or token (var(--accent) and the like) unless you have read its actual value in this app's files and it is what they asked for.",
  'In the plan, name the literal value you will set. After the change, describe only what your edit literally set, quoting the value; never claim a colour or effect you did not check.',
].join(' ');
// What the confirmed turn's model is told as ITS message (web.mjs): the plan, never the button's id.
export const applyNowPrompt = (plan) => `${APPLY_LABEL}: the user tapped Apply. Make this confirmed change now, then say in one or two plain sentences what you changed, quoting the value you set. ${CONCRETE_VALUE_RULE}\n${String(plan || '')}`;

// 说「好」也能改 · A short typed yes counts as the tap (owner report 2026-11-24: "yes, I want…" got tool talk, no change).
// Known limits (a heuristic): only a message made of these words alone, ≤ YES_MAX chars, counts; "yes but bigger",
// "好，再大一点" or any other words stay a normal turn. Negations never match ("不好", "no").
const YES_WORDS = ['yes please', 'go ahead', 'do it', 'apply it', 'please do', 'sounds good', 'make it so', 'go for it', 'yes', 'yeah', 'yep', 'yup', 'y',
  'ok', 'okay', 'sure', 'apply', 'proceed', 'confirm', 'confirmed', 'go',
  '好的', '好吧', '好', '可以', '行', '改吧', '改', '确认', '确定', '是的', '是', '对', '嗯', '没问题', '就这样', '照做', '请改'];   // no thanks/谢谢/please alone: an acknowledgment is not a yes (GPT review r1)
const YES_MAX = 40;
const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const YES_ALT = YES_WORDS.slice().sort((a, b) => b.length - a.length).map(esc).join('|');
const YES_RE = new RegExp(`^(?:${YES_ALT})(?:\\s*(?:${YES_ALT}))*$`, 'u');
export function isTypedConfirm(message) {
  if (/[?？]/.test(String(message || ''))) return false;   // "Apply?" is a question, not a command (GPT review r1)
  const s = String(message || '').toLowerCase().replace(/[\s.!?。！？,，~～、…:：;；'"“”‘’()（）]+/gu, ' ').trim();
  return !!s && s.length <= YES_MAX && YES_RE.test(s);
}
// The newest unexpired plan for this user, app AND conversation (a yes in another chat never applies it); not consumed here.
export function pendingConfirm({ who, slug, convo }, now = Date.now()) {
  if (!who || !slug || !convo) return null;
  let hit = null;
  for (const [id, v] of store) if (v.who === who && v.slug === slug && v.convo === convo && now - v.at <= CONFIRM_TTL_MS) hit = { id, plan: v.plan };
  return hit;
}

// A read-only turn must never talk about tools or sessions (owner report 2026-11-24: "the Edit tool is disabled in this session").
export const TOOL_TALK_RE = /Edit tool|Write tool|tool setup|session[\u2019']s tool|disabled in this session|re-enabled/i;
export const REOFFER_LINE = '要我按上面的计划修改吗？点「改 · Apply」· Shall I make the change above? Tap Apply.';
export const ASK_AGAIN_LINE = '请说一下要改什么，我先给出计划，你点「改 · Apply」后才会改 · Say what to change; I will plan it first, and nothing changes until you tap Apply.';
// The backstop: a tool-talk reply → the pending plan again with its button (id: reuse it), or a plain ask.
export function toolTalkReplacement(text, key, now = Date.now()) {
  if (!TOOL_TALK_RE.test(String(text || ''))) return null;
  const p = pendingConfirm(key, now);
  return p ? { text: `${p.plan}\n\n${REOFFER_LINE}`, id: p.id } : { text: ASK_AGAIN_LINE, id: null };
}
