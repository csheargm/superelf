// 应用对话不再假装已修改 · An app chat never claims a change it cannot make.
//
// SCAR (owner, try.superelf.app, 2026-11-24): in Calendar Planner's own chat a guest asked for a
// Day / Week / Month / Year switcher, said "yes", and was told "Done — the Calendar Planner now has a
// Day / Week / Month / Year view switcher". Nothing changed. No app chat can write: an app's agent
// is confined and writes nothing (lib/agent-origin.mjs), a fast lane has no tools, and the demo's
// app chat is a plain Ollama call. The model invented the action.
//
// Three layers, every one in THIS file (R3):
//   1. APP_CHAT_NO_CHANGE_RULE — sent on every no-write lane, OUTSIDE the override chain (a profile
//      or config prompt cannot remove it), with the real way for this person (changePath).
//   2. A one-tap offer — {type:'app-change'} — when the user asked for a change: PAChat shows
//      改这个应用 · Change this app, which opens the owner's panel prefilled (web/app-edit.js).
//   3. A backstop — claimsChange: a reply that still says done/added/已添加… about the app gets
//      NO_CHANGE_NOTE appended. KNOWN LIMITS: a regex heuristic. It misses a claim worded another
//      way ("your calendar is ready") and may flag a reply that only quotes such words; the pinned
//      cases are in test/app-chat-honesty.test.mjs. Appending a true note is the safe failure.
export const CHANGE_APP_LABEL = '改这个应用 · Change this app';   // the same words as the panel's menu item (web/app-edit.js ITEM)
export const NO_CHANGE_NOTE = '（此对话不能修改应用 · This chat can\'t change the app）';
export const NO_BUTTON_NOTE = '（这里没有「改这个应用」按钮，修改应用只对主人开放 · There is no Change this app button here; only the owner can change apps）';
export const CHANGE_REQUEST_MAX = 2000;

// Who is asking decides the real way. 'owner' = the owner's node; 'member' = a member there; 'demo' = a demo visitor.
export const CHANGE_PATHS = Object.freeze({
  owner: `The real way: tap "${CHANGE_APP_LABEL}" under your reply, or the app's ⋯ menu → ${CHANGE_APP_LABEL}. That panel can change the app.`,
  member: 'The real way: changing apps is only open to the owner of this superelf for now, so say that plainly and suggest asking the owner.',
  demo: 'The real way on this demo: go back to the home screen and ask the main chat to make or change an app (for example "make a calendar app with day, week, month and year views"); the main chat can build apps.',
});
export const changePathOf = (role) => CHANGE_PATHS[role] || CHANGE_PATHS.member;

export const APP_CHAT_NO_CHANGE_RULE =
  'This chat CANNOT change this app or any app: it has no tool that writes files, whatever model answers. '
  + 'Never say or suggest that you have done, added, changed, fixed, updated or built anything in the app '
  + '(no "Done", "I\'ve added", "the app now has", 已添加, 已完成, 已更新, 已修改), and never ask "shall I do it?" '
  + 'as if you could. If the user asks for a change, say plainly that this chat cannot make it, and give the real way.';
export const noChangeRule = (role) => `${APP_CHAT_NO_CHANGE_RULE} ${changePathOf(role)}`;

// ── 2. The user asked for a change (cheap, on the user's words) ─────────────────────────
const EN_WANT = /\b(?:add|allow|change|make|let\s+(?:me|us|users?)|enable|remove|delete|include|support|put|fix|turn|show|hide|switch|rename|redesign|update|improve|implement|build|modify|edit|customi[sz]e|adjust|tweak)\b/i;
const EN_ASK = /\b(?:can|could|would|will)\s+you\b|\bplease\b|\bi\s+(?:want|need|would\s+like)\b|\bcan\s+(?:it|this|the\s+app)\b|^\s*(?:add|allow|change|make|let|enable|remove|include|put|fix|turn|show|hide|switch|rename)\b/i;
const ZH_WANT = /(加|添加|增加|改|修改|换|删|删除|去掉|显示|隐藏|支持|允许|做成|变成|设置)/;
const ZH_ASK = /(能不能|能否|可以|可不可以|请|帮我|我想|我要|希望|给我)/;
export const asksForChange = (msg) => {
  const s = String(msg || '');
  return (EN_WANT.test(s) && EN_ASK.test(s)) || (ZH_WANT.test(s) && ZH_ASK.test(s));
};
// "yes" to "shall I add it?" carries no request: the newest earlier user message that asked for one does.
export function changeRequestOf(message, priorUserTexts = []) {
  const all = [...priorUserTexts, message].map((t) => String(t || ''));
  for (let i = all.length - 1; i >= 0; i--) if (asksForChange(all[i])) return all[i].trim().slice(0, CHANGE_REQUEST_MAX);
  return '';
}

// ── 3. The backstop: a completion claim about the app ───────────────────────────────────
const EN_CLAIM = /(?:^|\n)\s*(?:done|all\s+set)\b|\b(?:i\s+(?:just\s+)?(?:added|changed|updated|modified|implemented|built|fixed|enabled|created)|i(?:'|’)?ve\s+(?:now\s+)?(?:added|changed|updated|modified|implemented|built|fixed|made|enabled|created|included)|i\s+have\s+(?:now\s+)?(?:added|changed|updated|modified|implemented|built|fixed|made|enabled|created|included)|(?:has|have)\s+been\s+(?:added|changed|updated|modified|implemented|enabled|created)|now\s+(?:has|includes|supports|shows|lets|offers|comes\s+with))\b/i;
const EN_APP = /\b(?:app|view|views|button|feature|switcher|screen|page|option|mode|tab|toggle|menu|layout|calendar)\b/i;
const ZH_CLAIM = /(?:已经?|已)(?:添加|完成|更新|修改|加上|加入|实现|改好|做好|增加|启用)|改好了|加好了|搞定/;
const ZH_APP = /(应用|功能|按钮|视图|页面|界面|选项|模式|菜单|日历)/;
export const claimsChange = (text) => {
  const s = String(text || '');
  return (EN_CLAIM.test(s) && EN_APP.test(s)) || (ZH_CLAIM.test(s) && ZH_APP.test(s));
};

// The whole post-turn decision for a no-write lane. Returns {note, offer}: `note` is appended to the
// reply (stored and streamed), `offer` is the {type:'app-change'} line (null when there is nothing to offer).
// `canEdit`: this person can open Change this app on this app (the owner, in an app's chat).
export function honestReply({ reply, message, priorUserTexts, inApp, canEdit }) {
  const claimed = claimsChange(reply) && !String(reply || '').includes(NO_CHANGE_NOTE);   // (NO_BUTTON_NOTE names the label: `points` below ignores it)
  const request = inApp ? changeRequestOf(message, priorUserTexts) : '';
  // ONE decision for the words and the button (owner report 2026-11-24, Red Flags: "tap Change this app under my reply", no button):
  // a reply that points to the panel always carries it, for the owner only (the member/demo paths never name it).
  const points = String(reply || '').split(NO_BUTTON_NOTE).join('').includes(CHANGE_APP_LABEL);
  const offer = canEdit && (request || claimed || points) ? { type: 'app-change', label: CHANGE_APP_LABEL, request: request || String(message || '').trim().slice(0, CHANGE_REQUEST_MAX) } : null;
  const falseButton = points && !canEdit;   // no offer → the words must not promise one
  return { note: [claimed ? NO_CHANGE_NOTE : '', falseButton ? NO_BUTTON_NOTE : ''].filter(Boolean).join('\n'), offer };
}

// honestReply, applied: streams the note and the offer through `line` and returns the reply as stored.
// `prior` = the conversation's earlier messages ({role:'me'|'md', text}).
export function finishHonest({ reply, message, prior, inApp, canEdit, line }) {
  const priorUserTexts = (prior || []).filter((m) => m && m.role === 'me').slice(-4).map((m) => m.text);
  const h = honestReply({ reply, message, priorUserTexts, inApp, canEdit });
  if (h.note) line({ type: 'delta', text: `\n\n${h.note}` });
  if (h.offer) line(h.offer);
  return h.note ? `${reply}\n\n${h.note}` : reply;
}

// The Change-this-app lane CAN write, so its "Done" is checked against the server's own result: a turn
// that left the app unchanged (lib/app-edit.mjs finishAppEdit → changed:false) yet claims a change gets this.
export const EDIT_UNCHANGED_NOTE = '⚠ 应用没有任何改动 · The app was not changed in this turn.';
export const editUnchangedNote = (reply, editLine) => (editLine && editLine.changed === false && claimsChange(reply) ? EDIT_UNCHANGED_NOTE : '');
