// 访客改自己的应用 · A demo guest changes THEIR OWN copy of an app from the app's chat (ADR 0042, Phase 2 B).
//
// SCAR (owner, try.superelf.app, 2026-11-25): a guest asked Calendar Planner's chat for a Day / Week /
// Month / Year switcher, said "yes", and got "Done — … now has …" with nothing changed, then "go back to
// the main chat". The demo's app chat had no write path at all.
//
// The same lane a member uses (lib/app-edit-lane.mjs): no agent, no tools, the server alone writes
// apps/<slug>/index.html in the guest's own workspace. Plan first → 改 · Apply (or a typed yes) → write →
// the server's diff summary → 撤销 · Undo (typed "undo"). The snapshot, checks, rollback and undo are the
// owner's (lib/app-edit.mjs). Caps: the chat's consumeAiCall (charged by the caller), plus one app build
// (consumeAppBuild) per Apply, the disk cap before a write, and app_max_kb on the page.
//
// The app's own chat IS the edit surface here, so appEditOf gets the edit request without the app-origin
// marks: the guest's page can post a turn too, but it can only change that same page of the same guest,
// and an Apply still needs a server-minted id from a plan shown in this chat (docs/TODO.md: known limit).
import path from 'node:path';
import { appEditOf, appEditable, confirmEdit, refuseIfEditBusy, beginAppEdit, finishAppEdit, undoAppEdit } from './app-edit.mjs';
import { runScopedEdit } from './app-edit-lane.mjs';
import { offerApply } from './app-edit-offer.mjs';
import { cleanReply, scrubPaths, REPLY_EMPTY_TEXT } from './reply-clean.mjs';
import { editUnchangedNote, planClaimNote } from './app-chat-honesty.mjs';
import { PLAN_MARKER } from './app-edit-confirm.mjs';
import { consumeAppBuild, consumeAiCall, demoLimit, QUOTA_MESSAGES } from './demo-quota.mjs';
import { BUILD_MESSAGES } from './demo-build-job.mjs';
import { appModelOf, withOwnPolicy } from './demo-app.mjs';
import { ensureAskAi } from './demo-askai.mjs';
import { SEARCH_RULE } from './demo-search.mjs';
import { searchTurn } from './demo-search-turn.mjs';
import fs from 'node:fs';

// The app's title for its Ask AI mount; the folder name when meta.json has none (R5 c: a missing title is not an error).
function titleOf(dir) { try { const t = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')).title; return typeof t === 'string' && t ? t : path.basename(dir); } catch { return path.basename(dir); } }

export const UNDO_HINT = '想恢复原样，说「撤销」· Say "undo" to go back.';

// The guest's edit request for this app chat turn, or null when the app is not theirs to change
// (not a plain folder in their own apps). Throws {status, code, message} to refuse (a bad Apply id, busy).
// `building`: a main-chat app build runs for this guest (lib/demo-build-job.mjs); it may rewrite this app, so no edit beside it (GPT review r1).
export function guestEditOf({ user, app, message, convoId, building = false }) {
  const appsDir = path.join(user.workspace, 'apps');
  if (!app || !appEditable(appsDir, app)) return null;
  if (building) throw Object.assign(new Error(BUILD_MESSAGES.busy), { status: 409, code: 'edit_busy' });
  const edit = appEditOf({ user, body: { edit: app, message, convoId }, headers: {}, appsDir, members: true });
  if (edit.superelf) return null;   // never for a guest (appEditOf refuses non-owners first); kept as a fail-closed guard
  refuseIfEditBusy(edit, user.workspace);
  return confirmEdit(edit);
}

// The answer-or-plan call keeps the main chat's web search (a question about current facts in an app's chat):
// the model may answer with the search marker, the server searches and the model answers from the results.
// The sources footer is part of the returned text, so the search's own delta line is not sent twice; a plan's
// Apply marker stays the LAST line (after the footer), and an answer that is only another marker is an error (GPT review).
async function planAsk(x, callLane, kb, messages) {
  const { res } = x, withSearch = [{ role: 'system', content: SEARCH_RULE }, ...messages];
  const ac = new AbortController(), stop = () => ac.abort(); res.on('close', stop);
  let plan = false;
  const answer = async (m) => {
    let t = String(await x.callModel(res, callLane, m, null, kb));
    const lines = t.replace(/\s+$/, '').split('\n');
    if (lines[lines.length - 1].trim() === PLAN_MARKER) { plan = true; t = lines.slice(0, -1).join('\n'); }
    if (!t.replace(MARKER_LINES, '').split(PLAN_MARKER).join('').trim()) throw new Error(NO_ANSWER);   // the footer alone is never a plan (GPT review r2)
    return t;
  };
  try {
    const first = await x.callModel(res, callLane, withSearch, null, kb);
    const s = await searchTurn({ d: x.d, user: x.user, text: first, history: withSearch, ip: x.ip, signal: ac.signal,
      line: (o) => { if (o.type !== 'delta') x.line(o); }, answer });
    return plan ? `${s.text}\n${PLAN_MARKER}` : s.text;
  } finally { res.off('close', stop); }
}
const MARKER_LINES = /^\s*\[\[superelf-[a-z]+\]\][^\n]*$/gm;
const NO_ANSWER = 'the model gave no answer after the web search · 搜索后模型没有给出回答';

// One guest edit turn. x: { d, user, edit, message, convo, lane, line, callModel, res, ip }.
// Streams the reply and the {type:'app-edit'} / {type:'app-change-confirm'} lines; returns { text, failed }:
// the stored text, and whether the rewrite failed (the caller saves it as a failed turn, never as a success).
export async function guestEditTurn(x) {
  const { d, user, edit, message, convo, lane, line, res } = x;
  const wsDir = user.workspace;
  if (edit.undo) { const u = undoAppEdit(edit, { wsDir }); line(u.line); d.audit('app-edit-undo', { who: user.id, app: edit.slug, undone: !!u.line.undone }); line({ type: 'delta', text: u.text }); return { text: u.text, failed: false }; }
  if (edit.confirmed) {   // a whole-page rewrite: counted as an app build, under the disk cap
    const qb = consumeAppBuild({ cfg: d.cfg, store: d.store, userId: user.id, ip: x.ip });
    if (!qb.ok) throw new Error(qb.error);
    const full = x.disk(user); if (!full.ok) throw new Error(full.error);
  }
  const maxBytes = demoLimit(d.cfg, 'app_max_kb') * 1024;
  const callLane = edit.confirmed ? { ...lane, model: appModelOf(d.cfg, lane) } : lane;
  const kb = edit.confirmed ? demoLimit(d.cfg, 'app_max_kb') * 2 : demoLimit(d.cfg, 'reply_max_kb');
  let calls = 0;   // the chat charged one AI call; each further attempt is charged too, as a build's are (GPT review r1)
  const ask = (messages) => {
    if (calls++ > 0) { const q = consumeAiCall({ cfg: d.cfg, store: d.store, userId: user.id, ip: x.ip }); if (!q.ok) throw new Error(q.error); }
    return edit.confirmed ? x.callModel(res, callLane, messages, null, kb) : planAsk(x, callLane, kb, messages);
  };
  // Run right before the write (GPT review r1): the final page, policy and Ask AI included, under app_max_kb, and the disk cap as it is NOW.
  const shape = (html) => {
    const out = withOwnPolicy(ensureAskAi(html, titleOf(edit.dir)));   // as every demo-made page: its policy first, Ask AI kept (lib/demo-app.mjs writeApp)
    if (Buffer.byteLength(out) > maxBytes) throw new Error(QUOTA_MESSAGES.too_big);
    const full = x.disk(user); if (!full.ok) throw new Error(full.error);
    return out;
  };
  let ctx = beginAppEdit(edit, { wsDir });
  try {
    let r = await runScopedEdit({ edit, wsDir, message, prior: convo.messages.slice(0, -1), contract: d.appContract, ask, maxBytes, shape });
    if (r.ok !== false) r = offerApply({ who: user.id, edit, message, r, line, convoId: convo.id, wsDir });
    const c = cleanReply(r.text);
    let text = c.emptied ? REPLY_EMPTY_TEXT : scrubPaths(c.text, wsDir);
    const edited = finishAppEdit(edit, ctx, { wsDir }); ctx = null;
    const rolledBack = !!(edited && edited.line.changed && !edited.line.applied);
    if (edit.confirmed && rolledBack) text = '';   // the note says what happened, never a "now has" for a rolled-back change
    if (text) line({ type: 'delta', text });
    const notes = [edited ? editUnchangedNote(text, edited.line, edit.confirmed) : '', edited && edited.line.changed ? edited.note : '',   // the app's own chat saves into its data each turn: that data note is noise here
     
      edit.confirmed ? '' : planClaimNote(text), edited && edited.line.applied ? UNDO_HINT : ''];
    if (edited) { d.audit('app-edit', { who: user.id, app: edit.slug, changed: edited.line.changed, applied: edited.line.applied, version: edited.line.version || null }); line(edited.line); if (edited.line.applied && d.usage) d.usage.track(user.id, { kind: 'edit', app: edit.slug, ip: x.ip }); }
    const note = scrubPaths(notes.filter(Boolean).join('\n\n'), wsDir);
    if (note) { line({ type: 'delta', text: `${text ? '\n\n' : ''}${note}` }); text = text ? `${text}\n\n${note}` : note; }
    return { text, failed: r.ok === false || (edit.confirmed && rolledBack) };   // a rolled-back rewrite is a failure too (GPT review)
  } finally {
    if (ctx) { const ed = finishAppEdit(edit, ctx, { wsDir }); if (ed) line(ed.line); }   // a crashed turn never leaves a half-written app
  }
}
