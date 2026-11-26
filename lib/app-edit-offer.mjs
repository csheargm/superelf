// 改 · Apply 按钮 · The plan → Apply step of an edit turn, shared by the owner's node (web.mjs) and the
// demo's guest app chat (lib/demo-app-edit.mjs) — ONE place (R3), moved out of web.mjs unchanged.
import { mintConfirm, planOffer, applyMessage, toolTalkReplacement, retirePending, saysNo, APPLY_LABEL, PLAN_MAX, PLAN_TOO_LONG } from './app-edit-confirm.mjs';
import { cleanReply, scrubPaths } from './reply-clean.mjs';

// An unconfirmed edit turn that planned a change: strip the marker, mint the single-use id, offer the button.
// Returns r with the text the user sees; `offered` is true when an Apply button was sent.
export function offerApply({ who, edit, message, r, line, convoId, wsDir }) {
  if (edit.confirmed || edit.superelf || edit.undo) return r;
  const o0 = planOffer(r.text);
  if (!o0.offered) {   // backstop: tool/session talk never reaches the user; the pending plan and its button do
    const key = { who, slug: edit.slug, convo: convoId };
    const t = toolTalkReplacement(r.text, key, !saysNo(message));   // never re-offered never to "no, leave it" (GPT review r3)
    if (t && t.id) line({ type: 'app-change-confirm', slug: edit.slug, label: APPLY_LABEL, message: applyMessage(t.id) });
    else retirePending(key);   // answered with anything else ("no, leave it"): a later yes applies nothing (GPT review r2)
    return t ? { ...r, text: t.text, offered: !!(t && t.id) } : r;
  }
  const o = { ...o0, text: scrubPaths(cleanReply(o0.text).text, wsDir) };   // the plan Apply runs is the plan the user saw (GPT review r1)
  // nothing readable left: no plan, no Apply (GPT review r2), and the earlier plan is retired, so a later yes applies nothing stale (nightly review 2026-11-26)
  if (!o.text.trim()) { retirePending({ who, slug: edit.slug, convo: convoId }); return { ...r, text: o.text }; }
  if (o.text.length > PLAN_MAX) retirePending({ who, slug: edit.slug, convo: convoId });   // the shown revision replaces the old plan (GPT review r3)
  if (o.text.length > PLAN_MAX) return { ...r, text: `${o.text}\n\n${PLAN_TOO_LONG}` };   // never an Apply that would run a cut-down plan
  const id = mintConfirm({ who, slug: edit.slug, plan: o.text, request: message, convo: convoId });
  line({ type: 'app-change-confirm', slug: edit.slug, label: APPLY_LABEL, message: applyMessage(id) });
  return { ...r, text: o.text, offered: true };
}
