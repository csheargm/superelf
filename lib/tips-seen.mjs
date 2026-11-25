// The shell's first-use tips already dismissed（已关闭的首次提示）— profile.tipsSeen, so a tip closed on the
// phone stays closed on the Mac (ADR 0030). App pages keep theirs in appPrefs[slug].tipsSeen; this list is the
// shell's own (home ⋯, Publish, Change this app, Activity log, Needs attention, the demo build pill).
// Ids are short keys; anything else is dropped. Capped so profile.json (read whole per request) stays small.
export const TIP_ID_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;
export const TIPS_SEEN_MAX = 200;
export function tipsSeenOf(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x) => typeof x === 'string' && TIP_ID_RE.test(x)))].slice(-TIPS_SEEN_MAX);
}
