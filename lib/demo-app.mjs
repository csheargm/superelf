// Demo app maker · 演示版建应用 — a public visitor's "make me an app that …" with NO shell and NO agent.
//
// The demo has no Claude/agent lane (lib/demo-routes.mjs), so the chat model cannot write files. Two
// steps instead: (1) the chat turn carries APP_INTENT_RULE, so the model answers an app request with
// ONE marker line (APP_MARKER + a small JSON object) instead of pasting code; (2) the server then asks
// the model for one self-contained index.html under the SAME app contract the owner's agent gets
// (appContract, read from superelf.md — never copied, R3), checks it (app-postcheck), and writes it
// into THIS visitor's own apps/ folder only. A marker line is the most robust shape for gpt-oss:20b:
// one line, the start of the reply, parsed leniently; two fenced blocks for the app itself.
import fs from 'node:fs';
import path from 'node:path';
import { slugOk } from './webutil.mjs';
import { writeFileAtomic } from './atomicwrite.mjs';
import { appHtmlProblems } from './app-postcheck.mjs';
import { APP_CSP, cspMetaTag } from './offline.mjs';
import { ensureAskAi } from './demo-askai.mjs';

export const APP_MARKER = '[[superelf-app]]';
const BUILD_ATTEMPTS = 2;   // the first answer, and ONE retry with the reason it was refused
const MADE_BY = 'demo';
const TITLE_MAX = 60, DESC_MAX = 200, ICON_MAX = 8, REQUEST_MAX = 2000;

export const DEMO_APP_MESSAGES = Object.freeze({
  bad_output: 'The model did not return a working app, twice — please try again, or describe it more simply · 模型两次都没有给出可用的应用，请重试，或描述得简单一些',
  too_many: 'You have reached the app limit for a demo visitor — ask to change one of your apps instead · 已达到演示访客的应用数量上限，可以改为修改已有的应用',
});
// Sent with every main-chat demo turn, after the operator's prompt. `own` = the visitor's app slugs.
export const appIntentRule = (own) =>
  'You CAN build small apps for this visitor: the server builds them. If the visitor asks you to create, '
  + 'make or build an app, tool or mini-app — or to change one of their apps — reply with ONLY this one '
  + `line and nothing else: ${APP_MARKER} {"edit":"<slug of the app to change, or empty for a new app>",`
  + '"title":"<a short name for the app>","request":"<everything the app should do, in the visitor\'s words>"}. Never paste app code into the '
  + `chat. The visitor's apps: ${own.length ? own.join(', ') : '(none yet)'}. Otherwise answer normally.`;

// The marker line → {edit, title, request}, or null when the reply is an ordinary answer.
export function parseIntent(text) {
  const s = String(text || '').trim();
  if (!s.startsWith(APP_MARKER)) return null;
  const rest = s.slice(APP_MARKER.length).trim();
  let o = null;
  try { const m = rest.match(/\{[\s\S]*\}/); o = m ? JSON.parse(m[0]) : null; } catch { o = null; /* lenient: the whole line is the request */ }
  const request = String((o && o.request) || rest || '').trim().slice(0, REQUEST_MAX);
  const edit = o && typeof o.edit === 'string' && slugOk(o.edit.trim()) ? o.edit.trim() : '';
  return { edit, title: clip(o && o.title, TITLE_MAX), request };
}

// 留住回去的路 · The page must never take away the way back to its own chat (lib/app-postcheck.mjs pageWipeProblems refuses it).
export const KEEP_WAY_BACK_RULE = 'Render into your own container element (for example <main id="app">): never assign document.body.innerHTML / textContent, never call document.write, and never remove the <!--PA_CHAT_UI--> marker, the script that mounts PAChat, or the element with id pa-askai — they are the user\'s way back to this app\'s chat and its Undo.';

export const buildSystemPrompt = (contract) =>
  'You write ONE superelf mini-app: a single self-contained index.html (inline <script> and <style>, no '
  + 'external URLs, no fetch, no CDN, no localStorage). Reply with EXACTLY two fenced blocks and nothing '
  + 'else: first ```json {"slug":"short-kebab-name","title":"Title","desc":"one line","icon":"one emoji"}```'
  + ' then ```html <the whole index.html>```. The server adds the Ask AI button (PAChat) to every page, so do '
  + 'not build a chat of your own. ' + KEEP_WAY_BACK_RULE + ' Follow this app contract:\n\n' + contract;

const fence = (text, lang) => {
  const m = String(text).match(new RegExp('```' + lang + '[^\\n]*\\n([\\s\\S]*?)\\n?```', 'i'));
  return m ? m[1].trim() : '';
};
const clip = (v, n) => (typeof v === 'string' ? v : '').replace(/\s+/g, ' ').trim().slice(0, n);
export function slugFrom(s) {
  const v = String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 32).replace(/-$/, '');
  return slugOk(v) ? v : 'my-app';
}

// The model's build reply → {ok, meta, html} or {ok:false, why} (why goes back into the retry).
export function parseApp(text, maxBytes) {
  const html = fence(text, 'html');
  if (!/<html[\s>]|<body[\s>]|<script[\s>]/i.test(html)) return { ok: false, why: 'no ```html block with a whole page' };
  if (Buffer.byteLength(html) > maxBytes) return { ok: false, why: `the page is over ${Math.round(maxBytes / 1024)} KB` };
  const problems = appHtmlProblems(html);
  if (problems.length) return { ok: false, why: problems.join('; ') };
  let meta = {};
  try { meta = JSON.parse(fence(text, 'json') || '{}'); if (!meta || typeof meta !== 'object') meta = {}; } catch { meta = {}; /* optional: the title falls back below */ }
  const title = clip(meta.title, TITLE_MAX) || 'My app';
  return { ok: true, html, meta: { slug: slugFrom(typeof meta.slug === 'string' && meta.slug ? meta.slug : title), title, desc: clip(meta.desc, DESC_MAX), icon: clip(meta.icon, ICON_MAX) } };
}

// The visitor's app slugs (directories with an index.html).
export function ownApps(dir) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return names.filter((d) => d.isDirectory() && slugOk(d.name) && fs.existsSync(path.join(dir, d.name, 'index.html'))).map((d) => d.name);
}
// Only an app this maker wrote may be rewritten: a mistaken or steered marker line must never
// replace a seeded app (Notes, Tasks…) — an edit naming one becomes a new app instead.
function demoMade(dir, slug) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, slug, 'meta.json'), 'utf8')).madeBy === MADE_BY; }
  catch { return false; /* no or unreadable meta: not ours, so never overwritten */ }
}
function freeSlug(own, want) {
  if (!own.includes(want)) return want;
  for (let i = 2; i < 100; i++) { const s = `${want.slice(0, 36)}-${i}`; if (!own.includes(s)) return s; }
  throw new Error('no free app name · 没有可用的应用名');
}

// A model-written page carries the app policy as its FIRST element (after a doctype), so it holds on
// the shell's srcdoc route too, whatever the page's own markup looks like: the HTML parser puts a
// <meta> there into <head> before any of the page's scripts. Regex anchoring cannot promise that.
export const withOwnPolicy = (html) => '<!doctype html>' + cspMetaTag(APP_CSP) + html.replace(/^\s*<!doctype[^>]*>/i, '');

// Writes apps/<slug>/{index.html, meta.json} under `dir` (the visitor's own apps folder). The slug is
// validated again here: this is the one place a model-chosen name meets the filesystem.
export function writeApp(dir, slug, meta, html) {
  if (!slugOk(slug)) throw new Error(`bad app name · 应用名无效: ${slug}`);
  const appDir = path.resolve(dir, slug);
  if (path.dirname(appDir) !== path.resolve(dir)) throw new Error('bad app path · 应用路径无效');
  fs.mkdirSync(appDir, { recursive: true });
  if (fs.lstatSync(appDir).isSymbolicLink()) throw new Error('bad app path · 应用路径无效');
  // meta first: the app exists (ownApps, the app list) only once its index.html is in place.
  writeFileAtomic(path.join(appDir, 'meta.json'), JSON.stringify({ title: meta.title, desc: meta.desc, icon: meta.icon, madeBy: MADE_BY }, null, 2));
  writeFileAtomic(path.join(appDir, 'index.html'), withOwnPolicy(ensureAskAi(html, meta.title)));
}

// The model that writes apps: config demo.app_model, read at use time; else the chat lane's own.
export const appModelOf = (cfg, lane) => (cfg.demo && typeof cfg.demo.app_model === 'string' && cfg.demo.app_model.trim()) || lane.model;

// One request → one app. `ask(messages)` is one counted model call (it throws on a cap or upstream
// failure); returns {slug, title, edited} or throws with a bilingual reason. Never a silent fail.
export async function makeDemoApp({ dir, intent, contract, ask, maxBytes, maxApps }) {
  const own = ownApps(dir);
  const edited = !!intent.edit && own.includes(intent.edit) && demoMade(dir, intent.edit);
  if (!edited && own.length >= maxApps) throw new Error(DEMO_APP_MESSAGES.too_many);
  const current = edited ? fs.readFileSync(path.join(dir, intent.edit, 'index.html'), 'utf8').slice(0, maxBytes) : '';
  const messages = [{ role: 'system', content: buildSystemPrompt(contract) },
    { role: 'user', content: (current ? `Change this app:\n\n${current}\n\nThe change: ` : 'Build this app: ') + intent.request }];
  for (let i = 0; i < BUILD_ATTEMPTS; i++) {
    const text = await ask(messages);
    const r = parseApp(text, maxBytes);
    if (r.ok) {
      const slug = edited ? intent.edit : freeSlug(own, r.meta.slug);
      writeApp(dir, slug, r.meta, r.html);
      return { slug, title: r.meta.title, edited };
    }
    messages.push({ role: 'assistant', content: String(text).slice(0, 4000) },
      { role: 'user', content: `That was refused: ${r.why}. Answer again with exactly the two fenced blocks.` });
  }
  throw new Error(DEMO_APP_MESSAGES.bad_output);
}
