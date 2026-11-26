// 早晨邮件 · The morning email's text (docs/adr/0046). Plain text, no emojis (lib/notify.mjs strips any
// left at delivery too). One section per reviewed project; projects with no new commits share one line.
const short = (sha) => String(sha || '').slice(0, 7);
const where = (f) => `${f.file}${f.line ? `:${f.line}` : ''}`;

export const FAILED_PREFIX = 'REVIEW FAILED: ';

export function emailSubject(projects, date) {
  const done = projects.filter((p) => p.status === 'reviewed');
  const failed = projects.filter((p) => p.status === 'failed').length;
  const n = done.reduce((a, p) => a + p.confirmed.length, 0);
  return `Nightly review ${date}: ${n} confirmed${failed ? `, ${failed} failed` : ''}`;
}

function section(p) {
  const out = [p.name, p.tip ? `Range: ${short(p.base)}..${short(p.tip)} (${p.commits.length} commit${p.commits.length === 1 ? '' : 's'})` : 'Range: not read (failed before it)'];
  if (p.note) out.push(`Note: ${p.note}`);
  if (p.cut && p.cut.length) out.push(`Cut at the size cap (only the first part reviewed): ${p.cut.join(', ')}`);
  if (p.status === 'failed') { out.push(`${FAILED_PREFIX}${p.why}`, 'Nothing marked reviewed; this range is tried again next night.'); return out; }
  out.push(`Confirmed (${p.confirmed.length}):`, ...(p.confirmed.length ? p.confirmed.map((f) => `- ${where(f)} [${f.severity}] ${f.claim}`) : ['- none']));
  if (p.rejected.length) out.push(`Rejected (${p.rejected.length}):`, ...p.rejected.map((f) => `- ${where(f)} ${f.claim} - ${f.reason || 'no reason given'}`));
  if (p.unverified.length) out.push(`Unverified (${p.unverified.length}):`, ...p.unverified.map((f) => `- ${where(f)} [${f.severity}] ${f.claim} - ${f.reason}`));
  out.push(`Fix: ${p.fix || 'none (findings only)'}`);
  if (p.prevFix) out.push(`Previous fix: ${p.prevFix}`);
  return out;
}

export function emailBody(projects, date) {
  const shown = projects.filter((p) => p.status !== 'skipped');
  const skipped = projects.filter((p) => p.status === 'skipped');
  const lines = [`Nightly review ${date}`, ''];
  for (const p of shown) lines.push(...section(p), '');
  if (skipped.length) lines.push(`No new commits: ${skipped.map((p) => p.name + (p.prevFix ? ` (previous fix: ${p.prevFix})` : '')).join(', ')}`);
  return lines.join('\n').trim();
}
