// Briefing → email delivery (v1). The one push channel since the Telegram bot was removed
// (2026-10-12, docs/adr/0006); every briefing is also readable in the app.
//
// When a job's briefing is SAVED (lib/autonomy.mjs runJob → saveBriefing, fired
// from web.mjs by the scheduler tick or a manual run), it is emailed to that
// member's own briefingEmail (per-profile, PUT /api/profile) through the node's
// ONE AgentMail client (lib/agentmail.mjs, R3).
//
// Delivery contract (documented choices):
//   - PLAIN TEXT, no emojis. Markdown decoration and pictographs are stripped
//     here (family rule: plain-text markers only in message postings).
//   - A briefing that carries `html` (only the model review, docs/adr/0020) is
//     sent as BOTH parts: that HTML, emoji-stripped too, and the same plain text
//     as the fallback. Every other briefing is sent exactly as before: text only.
//   - ONE email per briefing, the full text, uncapped.
//   - Members WITHOUT a (valid) briefingEmail are skipped silently — by design,
//     not an error: email is an optional channel and the briefing is already
//     readable in the app (R5 comment at the skip site).
//   - A failed send NEVER fails the job and never loses the briefing (it is
//     already saved before delivery is attempted). The failure is audit-logged.
//     NO redelivery/retry queue in v1 (deferred).
import { emailOk } from './users.mjs';

// Pictographs (emoji), the emoji variation selector, and ZWJ joiners — the
// no-emoji rule for message postings, applied at the delivery boundary so the
// stored briefing (app-rendered) is untouched.
const stripEmojis = (s) => String(s)
  .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
  .replace(/[ \t]{2,}/g, ' ');

// Minimal markdown → plain text for a phone message: drop heading marks and
// bold/italic/code decoration, normalize bullets. NOT a renderer — the app
// renders the real markdown; this only de-clutters plain-text delivery.
const mdToPlain = (s) => String(s)
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1')
  .replace(/_{1,3}([^_\n]+)_{1,3}/g, '$1')
  .replace(/`{1,3}([^`\n]*)`{1,3}/g, '$1')
  .replace(/^\s*[-*]\s+/gm, '- ');

// Emoji-free plain-text title + body for a briefing email (subject / body).
function plainParts(briefing) {
  const title = stripEmojis(mdToPlain(String(briefing.title || briefing.job || '简报'))).trim();
  let body = stripEmojis(mdToPlain(String(briefing.body || ''))).trim();
  // The weekly body opens with its own title line — don't say it twice.
  const lines = body.split('\n');
  if (lines[0] && lines[0].trim() === title) body = lines.slice(1).join('\n').replace(/^\n+/, '');
  return { title, body };
}

// ── Email delivery（简报邮箱）— PLAN.md Phase B ────────────────────────────────
// Subject = briefing title; body = the emoji-free plain text (plainParts) with
// no length cap (email carries the full text) and NO proposals block: approvals
// are interactive (the app's Pending Approvals) and an email cannot approve — a
// block with nothing to press would be noise, not action (P1/P3). Deliberate v1
// scope, not an oversight.
export function formatBriefingEmail(briefing) {
  const { title, body } = plainParts(briefing);
  const html = typeof briefing.html === 'string' && briefing.html.trim() ? stripEmojis(briefing.html) : '';
  return { subject: title, text: body || title, ...(html ? { html } : {}) };
}

// Push one saved briefing to one member's briefing email (lib/agentmail.mjs).
// NEVER throws/rejects — callers hook this into the job pipeline, and a delivery
// failure must not fail the job, re-fire the scheduler tick, or lose the
// already-saved briefing — and returns { sent, reason? } so a skip is reported
// as a skip, never as a send (R14).
export async function notifyBriefingEmail({ mail, email, user, briefing, audit }) {
  if (!mail || !briefing) return { sent: false, reason: 'disabled' }; // no agentmail_key configured — email is an optional channel (R5: valid config, not an error)
  if (!emailOk(email)) return { sent: false, reason: 'no-email' }; // R5: this member has no (valid) briefingEmail — silent skip by design; the briefing stays readable in the app, and emailOk re-checks here so a hand-edited profile.json can't reach the send
  try {
    await mail.sendEmail({ to: email, ...formatBriefingEmail(briefing) });
    return { sent: true };
  } catch (e) {
    // Surfaced in the owner-visible audit log (R5) — the briefing is already
    // saved, so nothing is lost. v1 does not re-queue. `job` is carried so the
    // Jobs view can attribute the failure (nothing joins on a briefing id alone).
    if (audit) audit('briefing-email-failed', { who: user && user.id, job: briefing.job, briefing: briefing.id, channel: 'email', error: String(e && e.message || e) });
    return { sent: false, reason: 'send-failed' };
  }
}
