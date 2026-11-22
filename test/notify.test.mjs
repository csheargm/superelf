// Briefing → email delivery (lib/notify.mjs) — the one push channel since the Telegram bot was
// removed (2026-10-12, docs/adr/0006).
//
// The AgentMail HTTP call is stubbed at the FETCH seam the real client already exposes
// (helpers.mjs stubAgentMail → lib/agentmail.mjs `new AgentMail(key, { fetchImpl })`), returning
// the API's real JSON shapes — so the client's guards run for real (harness-fidelity rule).
// Workspaces are throwaway mkdtemp dirs — never a live instance. NEVER a real email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBriefingEmail, notifyBriefingEmail } from '../lib/notify.mjs';
import { runJob, getBriefing, listBriefings } from '../lib/autonomy.mjs';
import { annotateBriefing } from '../lib/actions.mjs';
import { jobsTick, readJobRuns } from '../lib/jobruns.mjs';
import { mkAudit, mkUser as mkSharedUser, stubAgentMail, AM_SENT } from './helpers.mjs';

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const mkUser = (extra = {}) => mkSharedUser('notify-', extra);

// ── formatting: plain text, no emojis, title as the subject ──────────────────
test('format: emojis stripped from subject and body (plain-text markers only)', () => {
  const { subject, text } = formatBriefingEmail({ id: 'x', title: '⏰ 健康提醒 · Daily', body: 'Note 📉 steps low 🙏 walk more' });
  assert.ok(!EMOJI_RE.test(subject + text), `emoji survived: ${subject} / ${text}`);
  assert.equal(subject, '健康提醒 · Daily');
  assert.match(text, /steps low\s+walk more/);
});

test('format: a briefing with no body still sends its title as the text', () => {
  assert.deepEqual(formatBriefingEmail({ id: 'x', title: 'Reminder · 提醒', body: '' }), { subject: 'Reminder · 提醒', text: 'Reminder · 提醒' });
});

test('format: a briefing with html gets an html part (emoji-stripped) AND the plain-text fallback; others get no html key', () => {
  const both = formatBriefingEmail({ id: 'x', title: '模型评测 · Model review', body: '**No change** 🙏\n| a | b |', html: '<p>No change 🙏</p>' });
  assert.deepEqual(Object.keys(both).sort(), ['html', 'subject', 'text']);
  assert.equal(both.html, '<p>No change </p>');
  assert.equal(both.text, 'No change \n| a | b |', 'the text part is the body, plain, as for every briefing');
  for (const html of [undefined, '', '   ', 42]) {
    assert.deepEqual(Object.keys(formatBriefingEmail({ id: 'x', title: 'T', body: 'b', html })).sort(), ['subject', 'text'], `html ${JSON.stringify(html)}: text only`);
  }
});

// ── delivery ─────────────────────────────────────────────────────────────────
const AM_OK = { status: 200, body: AM_SENT };
const AM_500 = { status: 500, body: { message: 'internal error' } };

test('email format: subject = briefing title; body = plain text, uncapped, no proposals block', () => {
  const { subject, text } = formatBriefingEmail({
    id: 'health-brief-1', title: '健康简报 · Weekly Health Brief',
    body: '# 健康简报 · Weekly Health Brief\n\n## Trends · 趋势\n- **Steps 步数**: ok 🙏\n' + 'line\n'.repeat(3000),
  });
  assert.equal(subject, '健康简报 · Weekly Health Brief');
  assert.ok(!EMOJI_RE.test(subject) && !EMOJI_RE.test(text), 'no emojis in either part');
  assert.ok(!/[#*]/.test(text), 'markdown decoration stripped');
  assert.ok(!text.includes('Weekly Health Brief'), 'title lives in the subject, not repeated as the body opener');
  assert.match(text, /(line\n){2999}line$/, 'email is NOT capped — every line arrives');
  assert.ok(!text.includes('已截断'), 'nothing truncated — email carries the full text');
  assert.ok(!text.includes('待批准行动'), 'no proposals block: email cannot approve (documented v1 choice)');
});

test('email send: one plain-text send to the member\'s briefingEmail', async () => {
  const { mail, calls } = stubAgentMail([AM_OK]);
  const { events, audit } = mkAudit();
  const out = await notifyBriefingEmail({ mail, email: 'mom@example.com', user: mkUser(), audit,
    briefing: { id: 'health-brief-9', title: '健康简报 · Weekly Health Brief', body: 'Trends fine 趋势正常 ✅' } });
  assert.deepEqual(out, { sent: true });
  assert.equal(calls.length, 1, 'one briefing = one email');
  assert.match(calls[0].url, /\/messages\/send$/);
  assert.equal(calls[0].data.to, 'mom@example.com');
  assert.equal(calls[0].data.subject, '健康简报 · Weekly Health Brief');
  assert.ok(!EMOJI_RE.test(calls[0].data.text), 'no emojis reach the email');
  assert.equal(calls[0].data.html, undefined, 'plain text only');
  assert.equal(events.length, 0, 'nothing to audit on success');
});

test('email send: member without a briefingEmail is silently skipped — no HTTP call', async () => {
  const { mail, calls } = stubAgentMail([AM_OK]);
  const { events, audit } = mkAudit();
  const out = await notifyBriefingEmail({ mail, email: undefined, user: mkUser(), audit, briefing: { id: 'b1', title: 'T', body: 'x' } });
  assert.deepEqual(out, { sent: false, reason: 'no-email' });
  assert.equal(calls.length, 0);
  assert.equal(events.length, 0, 'skip is by design, not an auditable failure');
});

test('email send: a hand-edited junk address is re-checked at the boundary → skip, no HTTP', async () => {
  const { mail, calls } = stubAgentMail([AM_OK]);
  const out = await notifyBriefingEmail({ mail, email: 'not-an-email', user: mkUser(), audit: () => {}, briefing: { id: 'b1', title: 'T', body: 'x' } });
  assert.deepEqual(out, { sent: false, reason: 'no-email' });
  assert.equal(calls.length, 0);
});

test('email send: no agentmail configured (mail null) reports disabled', async () => {
  const out = await notifyBriefingEmail({ mail: null, email: 'mom@example.com', user: mkUser(), audit: () => {}, briefing: { id: 'b1', title: 'T', body: 'x' } });
  assert.deepEqual(out, { sent: false, reason: 'disabled' });
});

test('email send: an API failure resolves (never throws) and is audit-logged — the job is unaffected', async () => {
  const { mail } = stubAgentMail([AM_500]);
  const { events, audit } = mkAudit();
  const out = await notifyBriefingEmail({ mail, email: 'mom@example.com', user: mkUser(), audit,
    briefing: { id: 'health-brief-7', title: 'T', body: 'x' } });
  assert.deepEqual(out, { sent: false, reason: 'send-failed' });
  assert.equal(events.length, 1);
  assert.equal(events[0].ev, 'briefing-email-failed');
  assert.equal(events[0].briefing, 'health-brief-7');
  assert.match(events[0].error, /HTTP 500/);
});

test('manual-run path: briefing saved → email fires with title-subject + plain body (web.mjs wiring)', async () => {
  const u = mkUser();
  const { mail, calls } = stubAgentMail([AM_OK]);
  const { audit } = mkAudit();
  const job = { name: 'health-brief', title: '健康简报 · Weekly Health Brief', type: 'digest' };
  const out = await runJob(u, job, { run: async () => ({ body: '- Sleep 睡眠 ok 😴' }), now: 1000 });
  await notifyBriefingEmail({ mail, email: 'mom@example.com', user: u, briefing: out.briefing, audit }); // web.mjs pushBriefing wiring
  assert.ok(getBriefing(u, 'health-brief-1000'), 'briefing saved before delivery');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.subject, '健康简报 · Weekly Health Brief');
  assert.match(calls[0].data.text, /Sleep 睡眠 ok/);
  assert.ok(!EMOJI_RE.test(calls[0].data.text));
});

// The model review's path (docs/adr/0020): run() returns { body, html } → runJob stores both → the
// email carries both. A job returning no html stores none, and an annotation that grows the body
// drops a stored html, since it would no longer say what the body says.
test('a job\'s html reaches the email beside the text; a job without html sends text only; an annotation drops stale html', async () => {
  const u = mkUser();
  const { mail, calls } = stubAgentMail([AM_OK]);
  const job = { name: 'model-review', title: '模型评测 · Model review', type: 'digest' };
  const out = await runJob(u, job, { run: async () => ({ body: '**No change** · 无变化', html: '<table><tr><td>No change</td></tr></table>' }), now: 2000 });
  assert.equal(getBriefing(u, 'model-review-2000').html, '<table><tr><td>No change</td></tr></table>', 'stored with the briefing');
  await notifyBriefingEmail({ mail, email: 'mom@example.com', user: u, briefing: out.briefing, audit: () => {} });
  assert.equal(calls[0].data.html, '<table><tr><td>No change</td></tr></table>');
  assert.equal(calls[0].data.text, 'No change · 无变化');

  const plain = await runJob(u, { name: 'health-brief', title: 'H', type: 'digest' }, { run: async () => ({ body: 'x' }), now: 3000 });
  assert.ok(!('html' in getBriefing(u, 'health-brief-3000')), 'no html key on a job that sends none');
  assert.ok(!('html' in plain.briefing));

  const noted = annotateBriefing(u, out.briefing, { executed: [{ title: 'Done thing', result: {} }], failed: [] });
  assert.ok(!('html' in noted) && !('html' in getBriefing(u, 'model-review-2000')), 'the body grew, so the html part is dropped');
  assert.match(formatBriefingEmail(noted).text, /Done thing/);
});

// A delivery event must name the JOB, not just the briefing — nothing joins on a briefing id,
// which is why a job whose push had been failing still read "✓ ok" in the Jobs view.
// And SUCCESS must be recorded too, or one bad send marks the job undelivered forever.
test('a delivery FAILURE names the job — nothing joins on a briefing id alone', async () => {
  // Without this the Jobs view could not attribute a failed push, so a job whose delivery had
  // been broken for a week still read "✓ ok". Success stays unaudited (see above): recovery is
  // read from the newer briefing having no failure against it.
  const briefing = { id: 'b-1', job: 'pollen-alert', title: '花粉预警', body: 'high' };
  const seen = [];
  const audit = (ev, d) => seen.push({ ev, ...d });
  await notifyBriefingEmail({ mail: { sendEmail: async () => { throw new Error('timeout'); } },
    email: 'mom@example.com', user: { id: 'u' }, briefing, audit });
  const bad = seen.find((e) => e.ev === 'briefing-email-failed');
  assert.ok(bad, 'a failed send is recorded');
  assert.equal(bad.job, 'pollen-alert', 'and names the job');
  assert.equal(bad.channel, 'email', 'and which channel failed');
  assert.match(bad.error, /timeout/);
  assert.ok(!seen.some((e) => e.ev === 'briefing-delivered'), 'success remains unaudited');
});

test('scheduler tick: a FAILED send neither fails the job nor loses the briefing', async () => {
  const u = mkUser();
  const { mail } = stubAgentMail([AM_500]);
  const { events, audit } = mkAudit();
  const jobs = { 'health-brief': { name: 'health-brief', title: '健康简报 · Weekly Health Brief', type: 'digest',
    schedule: { time: '08:00' }, run: async () => ({ body: 'weekly trends 趋势' }) } };
  const now = new Date(2026, 8, 1, 9, 0); // past 08:00 → due
  // Mirrors web.mjs runJobFor: save via runJob, then deliver; delivery never rejects.
  await jobsTick({ users: [u], jobs, now, audit,
    runJobFor: async (usr, job) => {
      const out = await runJob(usr, job, { run: job.run });
      if (out && out.briefing) await notifyBriefingEmail({ mail, email: 'mom@example.com', user: usr, briefing: out.briefing, audit });
      return out;
    } });
  assert.equal(listBriefings(u).length, 1, 'briefing still lands');
  assert.equal(readJobRuns(u)['health-brief'], '2026-09-01', 'job marked done for today — will NOT re-fire');
  const evs = events.map((e) => e.ev);
  assert.ok(evs.includes('briefing-email-failed'), `send failure audited (got ${evs})`);
  assert.ok(evs.includes('job-run'), 'job counted as a successful run');
  assert.ok(!evs.includes('job-failed'), 'delivery failure must never mark the job failed');
});
