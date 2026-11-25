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
const PLAN_MAX = 4000, STORE_MAX = 500;
// Leading match only: an attachment line the composer appends after the label must not turn a real tap into an unconfirmed turn.
const APPLY_RE = /^\s*改 · Apply \(([A-Za-z0-9_-]{12,32})\)(?![A-Za-z0-9_-])/;

const store = new Map();   // id → { who, slug, plan, at }
const refuse = (error) => Object.assign(new Error(error), { status: 403, code: 'bad_confirm' });
export const CONFIRM_REFUSED = '这个确认已失效，请重新说明要改什么 · This confirmation is no longer valid — say again what to change';

export const applyMessage = (id) => `${APPLY_LABEL} (${id})`;
export function applyIdOf(message) { const m = APPLY_RE.exec(String(message || '')); return m ? m[1] : null; }

function prune(now) {
  for (const [id, v] of store) if (now - v.at > CONFIRM_TTL_MS) store.delete(id);
  while (store.size >= STORE_MAX) store.delete(store.keys().next().value);   // oldest first: Map keeps insertion order
}

export function mintConfirm({ who, slug, plan, request }, now = Date.now()) {
  if (!who || !slug) throw new Error('confirm needs a user and an app · 确认需要用户和应用');
  prune(now);
  const id = crypto.randomBytes(12).toString('base64url');
  store.set(id, { who, slug, plan: String(plan || '').slice(0, PLAN_MAX), request: String(request || '').slice(0, PLAN_MAX), at: now });
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
  if (!s.includes(PLAN_MARKER)) return { text: s, offered: false };
  return { text: s.split(PLAN_MARKER).join('').replace(/\s+$/, ''), offered: true };
}
