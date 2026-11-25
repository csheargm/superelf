// Post-build check（应用生成后检查）— a cheap scan of the apps a chat turn wrote.
//
// WHY (e2e 2026-11-13, 1 of 4 new apps fully worked): two mistakes broke the other three, and the
// agent said "done" over both. superelf.md "App build rules" now tells the agent; this is the
// backstop that does not depend on it listening. It never edits an app: it only names the problem
// in the reply, so the user (or the next turn) can ask for the fix.
import fs from 'node:fs';
import path from 'node:path';
import { phoneProblems, phoneTextProblems } from './app-phone-check.mjs';

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

// 问 AI 不能丢 · A page script that throws away the whole page also throws away the Ask AI mount and the
// app's chat — the way back (self-test 2026-11-25: a rewritten Calendar Planner re-rendered document.body
// and the guest could not reopen the chat to undo). Render into your own element instead.
// Known limits: a heuristic over inline script text — an alias (const b = document.body; b.innerHTML = …)
// or a page built at run time from a string is not seen; the shell's ⋯ menu is the backstop either way.
export const PAGE_WIPE_TEXT = 'a script replaces the whole page (document.body / document.write), which removes the Ask AI button and the way back to this app\'s chat · 脚本整页替换（document.body / document.write），会删掉「问 AI」按钮和回到应用对话的入口';
const WIPE_RE = /\bdocument\s*\.\s*(?:body|documentElement)\s*\.\s*(?:(?:innerHTML|outerHTML|textContent|innerText)\s*\+?=(?!=)|replaceChildren\s*\(|replaceWith\s*\(|remove\s*\()|\bdocument\s*\.\s*(?:write|writeln|open)\s*\(|\bgetElementById\s*\(\s*['"]pa-askai['"]\s*\)\s*\.\s*remove\s*\(/;
const RUNS_RE = /^(?![\s\S]*\btype\s*=)|\btype\s*=\s*(?:''|""|['"]?(?:module|(?:text|application)\/(?:java|ecma)script)\b)/i;   // type="" runs as JavaScript too (GPT review r2)
const STRING_RE = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\$]|\\.|\$(?!\{))*`/g;   // a template with ${…} is kept: its code part runs
const ASKAI_ID_RE = /^['"`]pa-askai['"`]$/;   // kept: getElementById('pa-askai').remove() is caught
export function pageWipeProblems(html) {
  // Only scripts that run (no type, or a JS / module type), and with plain string literals blanked: a page
  // that SHOWS "document.write()" as text or in a <script type="text/plain"> example is not refused (GPT review r1).
  const scripts = [...String(html).replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script\b(?![^>]*\bsrc\s*=)([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
    .filter((m) => RUNS_RE.test(m[1]))
    .map((m) => m[2].replace(STRING_RE, (q) => (ASKAI_ID_RE.test(q) ? q : '""')).replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, '$1'));
  return scripts.some((t) => WIPE_RE.test(t)) ? [PAGE_WIPE_TEXT] : [];
}

// The rule texts one page trips ([] when none) — the scan above plus the phone check, and the gate
// the demo app maker (retry) and the app-edit lane (refuse, roll back) apply. `text: false` leaves out
// the text-size / hover faults, which older apps carry (lib/app-phone-check.mjs phoneTextProblems).
export function appHtmlProblems(html, { text = true } = {}) {
  const markup = markupOnly(html);
  return [...APP_CHECKS.filter((c) => c.re.test(markup)).map((c) => c.text), ...pageWipeProblems(html), ...phoneProblems(html), ...(text ? phoneTextProblems(html) : [])];
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
    for (const text of appHtmlProblems(html, { text: !before.has(slug) })) lines.push(`⚠ apps/${slug}: ${text}`);
  }
  return lines.join('\n');
}
