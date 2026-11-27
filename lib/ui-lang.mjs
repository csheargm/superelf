// The ONE language setting（界面语言）: 中文 or English for all of superelf (owner 2026-11-26: "one setting
// instead of showing both at once"). The page side is web/lang.js (PALang); this is the server side:
//   - profile.lang: 'zh' | 'en', or absent = follow the device (the browser's navigator.language);
//   - which apps are deliberately bilingual and keep showing both (the Bible app and its study pages);
//   - the reply-language line an AI turn carries (the setting wins; a bilingual app keeps the old rule).
import fs from 'node:fs';
import path from 'node:path';
import { REPLY_LANGUAGE_RULE } from './config.mjs';

export const UI_LANGS = Object.freeze(['zh', 'en']);
export const langOf = (v) => (UI_LANGS.includes(v) ? v : '');

// Bilingual by slug as well as by meta.json { "bilingual": true }: an installed built-in keeps its OLD
// meta.json (the updater replaces only index.html), so a meta-only flag would never reach those copies.
export const BILINGUAL_APPS = Object.freeze(['bible', 'sunday-study']);
export function appIsBilingual(appsDir, slug) {
  if (typeof slug !== 'string' || !slug || slug.includes('/') || slug.includes('..')) return false;
  if (BILINGUAL_APPS.includes(slug)) return true;
  try { const m = JSON.parse(fs.readFileSync(path.join(appsDir, slug, 'meta.json'), 'utf8')); return !!(m && m.bilingual === true); }
  catch { return false; }   // no meta.json, or unreadable: an ordinary app (R5 case c: a display hint, not data)
}

// What an AI turn is told about language. The chosen language wins over "answer in the language you were
// written to in": a member who set English gets English even when a pasted verse is 中文.
export const REPLY_IN = Object.freeze({
  zh: '这个人把 superelf 设为中文：请用中文回答，即使对方用英文提问；专有名词和技术术语可保留原文。只有对方明确要求时才换语言。',
  en: 'This person set superelf to English: reply in English, even when they write in 中文. A proper noun or a technical term may stay as normally written. Switch only when they explicitly ask.',
});
export const replyLanguageRule = (lang) => REPLY_IN[langOf(lang)] || REPLY_LANGUAGE_RULE;

// One turn's language: the page's own word (body.lang, 'both' = a bilingual app), else the account's saved
// choice; a bilingual app always keeps the old follow-the-writer rule ('' → REPLY_LANGUAGE_RULE).
export function turnLang({ sent, saved, bilingual }) {
  if (bilingual || sent === 'both') return '';
  return langOf(sent) || langOf(saved);
}

// A node may keep the old both-at-once look until each person chooses (config.json "ui_lang_default": "both").
// Off by default: the device's language decides. The test harness sets it, so suites written against the
// bilingual labels keep reading them; test/lang-e2e.test.mjs runs without it. Read per request (no restart).
export const LANG_DEFAULT_MARK = "/*PA_LANG_DEFAULT*/''";
export const withLangDefault = (html, cfg) => html.split(LANG_DEFAULT_MARK).join(cfg && cfg.ui_lang_default === 'both' ? "'both'" : "''");
