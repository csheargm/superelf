/* ══ PA_REPLY_CLEAN ══ */
// 回答清理 · What a chat bubble may show of a model's reply. ONE source: PAChat inlines this file
// (web.mjs PA_COMPONENTS, marker PA_REPLY_CLEAN_JS) for the live stream, a history reload, Copy and
// Read aloud; lib/reply-clean.mjs evaluates the same file for what the server stores (R3).
//   · tool-call markup a model printed as text (<invoke …>, <parameter …>, <function_calls>) — a lane
//     with no tools that still "calls" them (measured 2026-11-24, CLI 2.1.327) — never reaches a user;
//   · the plan marker [[apply]] (lib/app-edit-confirm.mjs PLAN_MARKER) is the server's, never shown;
//   · the Apply turn's confirm id: 「改 · Apply (id)」 is shown as 「改 · Apply」.
// Known limit: a regex scrub, not a parser — it removes the shapes measured, and an unclosed tag to the end.
var REPLY_EMPTY_TEXT = '⚠ 模型没有给出可读的回答，请再问一次 · The model gave no readable answer — please ask again';
var REPLY_MARKUP_RE = /<(function_calls|invoke|antml:invoke|parameter|antml:parameter)\b[^>]*>[\s\S]*?(<\/\1>|$)|<\/?(function_calls|invoke|parameter|antml:[a-z_]+)\b[^>]*>/gi;
var REPLY_MARKER_RE = /\[\[apply\]\]/gi;
var APPLY_ID_RE = /^(\s*改 · Apply) \([A-Za-z0-9_-]{12,32}\)/;
function cleanReply(text) {
  var s = String(text == null ? '' : text);
  var was = s.trim().length > 0;
  for (var i = 0; i < 3 && REPLY_MARKUP_RE.test(s); i++) { REPLY_MARKUP_RE.lastIndex = 0; s = s.replace(REPLY_MARKUP_RE, ''); }
  REPLY_MARKUP_RE.lastIndex = 0;
  s = s.replace(REPLY_MARKER_RE, '').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  return { text: s, emptied: was && !s.trim() };
}
function shownUserText(text) { return String(text == null ? '' : text).replace(APPLY_ID_RE, '$1'); }
