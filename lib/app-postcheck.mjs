// Post-build check（应用生成后检查）— a cheap scan of the apps a chat turn wrote.
//
// WHY (e2e 2026-11-13, 1 of 4 new apps fully worked): two mistakes broke the other three, and the
// agent said "done" over both. superelf.md "App build rules" now tells the agent; this is the
// backstop that does not depend on it listening. It never edits an app: it only names the problem
// in the reply, so the user (or the next turn) can ask for the fix.
import fs from 'node:fs';
import path from 'node:path';
import { phoneProblems } from './app-phone-check.mjs';

// Each rule: what to find in a freshly written index.html, and the bilingual line that says why.
// No 'not_found' rule: note-page-image answers exactly that code, so a correct app tripped it.
export const APP_CHECKS = [
  { re: /<form[\s>\/]/i, text: '<form> element: the app sandbox blocks form submits, so its button does nothing · 使用了 <form>：沙盒禁止表单提交，按钮无效' },
];

// The markup only: comments and <script>/<style> bodies removed, so a '<form' in a comment or a JS
// string is not a form element. Known limit: a form an app builds at run time is not seen.
export function markupOnly(html) {
  return html.replace(/<!--[\s\S]*?(?:-->|$)/g, '').replace(/<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, '<$1>');
}

// The rule texts one page trips ([] when none) — the scan above plus the phone check, and the gate
// the demo app maker (retry) and the app-edit lane (refuse, roll back) apply.
export function appHtmlProblems(html) {
  const markup = markupOnly(html);
  return [...APP_CHECKS.filter((c) => c.re.test(markup)).map((c) => c.text), ...phoneProblems(html)];
}

// slug → index.html mtimeMs, for every app under `dir`. A missing apps dir is an empty snapshot:
// a user with no apps yet is the normal first case, not an error.
export function snapshotApps(dir) {
  const out = new Map();
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return out; throw e; }
  for (const slug of names) {
    try { out.set(slug, fs.statSync(path.join(dir, slug, 'index.html')).mtimeMs); }
    catch (e) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }   // a dir without a page is not an app
  }
  return out;
}

// The warning to append to the reply ('' when nothing written this turn trips a rule).
export function appBuildWarnings(dir, before) {
  const lines = [];
  for (const [slug, mtime] of snapshotApps(dir)) {
    if (before.has(slug) && before.get(slug) === mtime) continue;   // untouched this turn
    const html = fs.readFileSync(path.join(dir, slug, 'index.html'), 'utf8');
    for (const text of appHtmlProblems(html)) lines.push(`⚠ apps/${slug}: ${text}`);
  }
  return lines.join('\n');
}
