// 早晨邮件 · The nightly review's morning email (docs/adr/0046, amended 2026-11-26): the answer first, for an
// owner who does not code. digestView builds it ONCE; digestText (the briefing and the email's text part) and
// lib/nightly-review/digest-html.mjs (the HTML part, ADR 0020 style) only draw it. Order: subject = the answer,
// one-line verdict, 需要你 · Needs you, 发现的问题 · What was found, 没能审查 · Could not review, then the
// technical details below a divider. No file names, lines or commit ranges above the divider. No emojis.
import { technicalDetails } from './email.mjs';
import { renderHtml } from './digest-html.mjs';

export const TOP_MAX = 5;   // needs-you items shown; the rest are counted. Every medium+ finding is always shown; only low ones are counted
export const H = { needs: '需要你 · Needs you', found: '发现的问题 · What was found', failed: '没能审查 · Could not review',
  details: '技术细节 · Technical details' };
export const DIVIDER = `---------- ${H.details} ----------`;
const SEV = { high: 0, medium: 1, low: 2 };
const STATUS = { ready: 'fix ready, waiting for your Publish tap', 'checks-failed': 'a fix was tried but failed its checks',
  'not-started': 'not fixed yet', report: 'reported only (no automatic fix for this project)' };
const s = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// Why a project could not be reviewed, in plain words. stuck: it will fail again until someone changes a setting.
export function failureWords(why) {
  const w = String(why || '');
  const branch = /Remote branch (\S+) not found/i.exec(w);
  if (branch) return { text: `the branch "${branch[1]}" does not exist in that repository`, stuck: 'correct the branch name for it in the nightly review settings' };
  if (/EACCES|permission denied/i.test(w)) return { text: 'the server could not write its work folder', stuck: "fix the nightly review's work folder on the server" };
  if (/clone|fetch|could not read|repository not found/i.test(w)) return { text: 'the server could not download the code', stuck: false };
  if (/deadline|timed out|timeout/i.test(w)) return { text: 'it ran out of time', stuck: false };
  if (/codex/i.test(w)) return { text: 'the reviewer gave no usable answer', stuck: false };
  return { text: 'an unexpected error (see the technical details)', stuck: false };
}

// Every confirmed finding, flat in project order (the order the plain-words pass numbered them).
function findingsOf(projects, plain) {
  const items = plain && plain.items;
  let i = 0;
  return projects.filter((p) => p.status === 'reviewed').flatMap((p) => p.confirmed.map((f) => {
    const w = items ? items[i] : null; i++;
    return { project: p.name, impact: w ? w.impact : f.claim, severity: (w && w.severity) || f.severity, rank: w ? w.rank : i,
      status: STATUS[p.fixState || (p.fix ? 'not-started' : 'report')] || STATUS['not-started'] };
  }));
}
const byImportance = (a, b) => (SEV[a.severity] - SEV[b.severity]) || (a.rank - b.rank);

function needsOf(projects, found, link) {
  const out = [];
  for (const p of projects.filter((x) => x.status === 'failed')) {
    const f = failureWords(p.why);
    if (f.stuck) out.push({ text: `${p.name} is not being reviewed: ${f.text}. It will keep failing until this is fixed.`,
      action: `Ask superelf to ${f.stuck}.` });
  }
  for (const x of found.filter((y) => y.severity === 'high' && !/fix ready/.test(y.status)))
    out.push({ text: `${x.project}: ${x.impact}`, action: 'Ask superelf (or whoever maintains it) to fix this today.' });
  for (const p of projects.filter((x) => x.status === 'reviewed' && x.confirmed.length)) {
    const n = s(p.confirmed.length, 'problem'), chat = p.fixTitle ? `the chat "${p.fixTitle}"` : 'the fix chat';
    if (p.fixState === 'ready') out.push({ text: `Fixes for ${n} in ${p.name} are ready.`, action: `Open ${chat} in superelf and tap 发布 · Publish.`, link });
    else if (p.fixState === 'checks-failed') out.push({ text: `The automatic fix for ${p.name} failed its checks.`, action: `Open ${chat} and ask it to try again, or discard it.`, link });
    else if (p.fixState === 'not-started') out.push({ text: `${n} in ${p.name} were not fixed: ${/in progress/i.test(p.fix) ? 'another superelf change was still open' : 'the automatic fix could not start'}.`,
      action: `These will not come back by themselves. Publish or discard the open superelf change, then ask superelf to "fix last night's review findings".`, link });
  }
  for (const p of projects.filter((x) => x.prevFixWaiting))
    out.push({ text: `An earlier fix for ${p.name} is still waiting.`, action: 'Open its chat in superelf and tap 发布 · Publish.', link });
  return out;
}

// R14: unverified is not clean. A project whose candidates ALL went unverified is never called
// problem-free nor "all clear"; one with confirmed findings already reports them (plus the unchecked line).
const incompleteOf = (projects) => projects.filter((p) => p.status === 'reviewed' && !p.confirmed.length && (p.unverified || []).length);

function verdictOf(projects, found, needs) {
  const failed = projects.filter((p) => p.status === 'failed').map((p) => p.name);
  const incomplete = incompleteOf(projects);
  const reviewed = projects.filter((p) => p.status === 'reviewed' && !incomplete.includes(p));
  const parts = [];
  if (found.length) {
    const high = found.filter((x) => x.severity === 'high').length;
    parts.push(`found ${s(found.length, 'problem')} in ${[...new Set(found.map((x) => x.project))].join(' and ')} (${high ? `${high} serious` : 'none serious'})`);
  } else if (reviewed.length) parts.push(`no problems in the new code of ${reviewed.map((p) => p.name).join(' and ')}`);
  const live = projects.filter((p) => p.prevFixLive).map((p) => p.name);
  if (live.length) parts.push(`the earlier fix for ${live.join(' and ')} is live`);
  if (failed.length) parts.push(`${failed.join(' and ')} could not be reviewed`);
  for (const p of incomplete) parts.push(`review incomplete for ${p.name}: ${s(p.unverified.length, 'finding')} could not be verified`);
  if (!parts.length) return 'All clear: no new code changes to review last night.';
  const head = needs.length ? `${s(needs.length, 'thing')} need${needs.length === 1 ? 's' : ''} you` : 'Nothing needs you';
  return `${head}: ${parts.join('; ')}.`;
}

function subjectOf(projects, found, needs) {
  const failed = projects.filter((p) => p.status === 'failed').map((p) => p.name);
  if (failed.length && failed.length === projects.length) return `Nightly review FAILED for ${failed.join(', ')}`;
  const parts = [needs.length && `${needs.length} need${needs.length === 1 ? 's' : ''} you`, found.length && `${found.length} found`,
    projects.some((p) => p.prevFixLive) && 'fix live', ...failed.map((n) => `${n} failed`),
    ...incompleteOf(projects).map((p) => `${p.name} review incomplete`)].filter(Boolean);
  return `Nightly review: ${parts.length ? parts.join(', ') : 'all clear'}`;
}

export function digestView(projects, { date, plain = null, baseUrl = '' } = {}) {
  const all = findingsOf(projects, plain).sort(byImportance);
  const notLow = all.filter((x) => x.severity !== 'low');
  const needs = needsOf(projects, all, baseUrl ? `${baseUrl}/` : '');
  return { date, subject: subjectOf(projects, all, needs), verdict: verdictOf(projects, all, needs),
    needs: needs.slice(0, TOP_MAX), needsMore: Math.max(0, needs.length - TOP_MAX),
    found: notLow, lowCount: all.length - notLow.length, total: all.length,
    unchecked: projects.filter((p) => p.status === 'reviewed')
      .reduce((n, p) => n + (p.unverified || []).filter((x) => /max_verify/.test(x.reason || '')).length, 0),
    failures: projects.filter((p) => p.status === 'failed').map((p) => { const w = failureWords(p.why);
      return `${p.name}: ${w.text}. It tries again tonight${w.stuck ? ', but fails until that is fixed' : ''}.`; }),
    details: technicalDetails(projects, { plainError: plain && plain.error }) };
}

export function digestText(v) {
  const out = [v.verdict, ''];
  if (v.needs.length) {
    out.push(H.needs, ...v.needs.flatMap((x, i) => [`${i + 1}. ${x.text}`, `   Action: ${x.action}${x.link ? ` ${x.link}` : ''}`]));
    if (v.needsMore) out.push(`(${v.needsMore} more in the technical details)`);
    out.push('');
  }
  if (v.total) {
    out.push(`${H.found} (${v.total})`, ...v.found.map((x) => `- ${x.impact} → ${x.status}.`));
    if (v.lowCount) out.push(`- And ${v.lowCount} minor (low risk): see the technical details.`);
  }
  if (v.unchecked) out.push(`- ${v.unchecked} not checked (verify limit).`);
  if (v.total || v.unchecked) out.push('');
  if (v.failures.length) out.push(H.failed, ...v.failures.map((x) => `- ${x}`), '');
  out.push(DIVIDER, `Nightly review ${v.date}`, '', v.details);
  return out.join('\n').trim();
}

export function renderEmail(projects, opts) {
  const v = digestView(projects, opts);
  return { subject: v.subject, body: digestText(v), html: renderHtml(v, H) };
}
