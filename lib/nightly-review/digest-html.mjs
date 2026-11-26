// 早晨邮件 HTML · The HTML part of the nightly review email (docs/adr/0046): draws lib/nightly-review/digest.mjs
// digestView, nothing else. Gmail-safe like ADR 0020: tables and inline styles only; no <style>, image, script
// or external fetch. The only link is the owner's own node (public_base_url). Every dynamic string is escaped.
const C = { ink: '#111827', muted: '#6b7280', rule: '#e5e7eb', needs: '#b45309', needsBg: '#fffbeb', ok: '#166534', okBg: '#f0fdf4', link: '#1d4ed8' };
const FONT = "-apple-system,'Segoe UI',Roboto,Helvetica,Arial,'PingFang SC','Microsoft YaHei',sans-serif";
const WRAP = 'word-break:break-word;overflow-wrap:anywhere';
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeUrl = (u) => (/^https?:\/\/[^\s"'<>]+$/.test(u) ? u : '');

const heading = (t, color = C.ink) => `<div style="font-size:16px;font-weight:bold;color:${color};margin:22px 0 6px">${esc(t)}</div>`;
const item = (inner) => `<div style="font-size:15px;line-height:1.45;color:${C.ink};margin:0 0 10px;${WRAP}">${inner}</div>`;

function needsHtml(v, H) {
  if (!v.needs.length) return '';
  const rows = v.needs.map((x, i) => {
    const url = safeUrl(x.link || '');
    return item(`<b>${i + 1}. ${esc(x.text)}</b><br><span style="color:${C.needs}">Action: ${esc(x.action)}</span>`
      + (url ? `<br><a href="${esc(url)}" style="color:${C.link}">Open superelf</a>` : ''));
  }).join('');
  const more = v.needsMore ? item(`<span style="color:${C.muted}">${v.needsMore} more in the technical details.</span>`) : '';
  return `<div style="background:${C.needsBg};border-left:4px solid ${C.needs};padding:4px 12px 2px;margin:16px 0">${heading(H.needs, C.needs)}${rows}${more}</div>`;
}

function foundHtml(v, H) {
  const unchecked = v.unchecked ? item(`<span style="color:${C.muted}">${v.unchecked} not checked (verify limit).</span>`) : '';
  if (!v.total) return unchecked ? heading(H.found) + unchecked : '';
  const rows = v.found.map((x) => item(`${esc(x.impact)}<br><span style="font-size:13px;color:${C.muted}">${esc(x.status)}</span>`)).join('');
  const low = v.lowCount ? item(`<span style="color:${C.muted}">And ${v.lowCount} minor (low risk): see the technical details.</span>`) : '';
  return heading(`${H.found} (${v.total})`) + rows + low + unchecked;
}

// H: the section headings (digest.mjs H, passed in so each string lives once, R3, with no import cycle).
export function renderHtml(v, H) {
  const tone = v.needs.length ? C.needs : C.ok;
  return `<div style="font-family:${FONT};max-width:640px;margin:0 auto;padding:4px 2px;color:${C.ink}">`
    + `<div style="font-size:18px;font-weight:bold;line-height:1.4;color:${tone};${WRAP}">${esc(v.verdict)}</div>`
    + needsHtml(v, H) + foundHtml(v, H)
    + (v.failures.length ? heading(H.failed) + v.failures.map((x) => item(esc(x))).join('') : '')
    + `<div style="border-top:1px solid ${C.rule};margin:28px 0 8px;padding-top:8px;font-size:13px;color:${C.muted}">${esc(H.details)} · ${esc(v.date || '')}</div>`
    + `<pre style="white-space:pre-wrap;${WRAP};font-family:${FONT};font-size:12px;line-height:1.4;color:${C.muted};margin:0">${esc(v.details)}</pre></div>`;
}

