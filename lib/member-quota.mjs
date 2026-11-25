// 成员用量计数 · A member's AI usage on a private node (ADR 0042 addendum).
//
// A member the owner has not opted in to Claude still gets Claude (no tools) in an app's chat, the
// no-tools editor lane (lib/app-edit-lane.mjs). Each such turn is one charge on a per-member daily
// counter, the demo's counter store and rule (lib/demo-quota.mjs makeQuotaStore: per UTC day, both
// or neither, a damaged file throws = fail closed). The cap is read from config.json at use time:
//   "member_limits": { "ai_calls_per_user_per_day": 30 }
export const MEMBER_QUOTA_FILE = 'member-quota.json';
export const MEMBER_AI_DEFAULT = 30;
// A damaged or unreadable counter file still refuses (fail closed), but in words that fit a private node: the
// store's own error names the demo (it is the demo's store), and a member here has never seen a demo.
export const MEMBER_QUOTA_BROKEN_TEXT = '用量记录无法读取，请主人检查 member-quota.json · The usage record cannot be read — ask the owner to check member-quota.json';
export const MEMBER_AI_LIMIT_TEXT = '今日 AI 次数已用完，请明天再来，或请主人调高上限 · Daily AI limit reached — please come back tomorrow, or ask the owner to raise it';

export function memberAiLimit(cfg) {
  const v = cfg && cfg.member_limits && typeof cfg.member_limits === 'object' ? cfg.member_limits.ai_calls_per_user_per_day : undefined;
  return Number.isInteger(v) && v >= 0 ? v : MEMBER_AI_DEFAULT;
}

// One charge. → { ok: true } or { ok: false, status: 429 (limit) | 503 (counter file broken), code, error } (bilingual, for the reply).
export function consumeMemberAiCall({ cfg, store, userId, now }) {
  let r;
  try { r = store.consume([[`member:${userId}`, memberAiLimit(cfg)]], now); }
  catch { return { ok: false, status: 503, code: 'member_ai_quota_unreadable', error: MEMBER_QUOTA_BROKEN_TEXT }; }   // R5: refused and said, never counted from zero
  return r.ok ? r : { ok: false, status: 429, code: 'member_ai_user', error: MEMBER_AI_LIMIT_TEXT };
}
