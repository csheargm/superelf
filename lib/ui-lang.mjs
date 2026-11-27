// The ONE language setting（界面语言）: 中文 or English for all of superelf (owner 2026-11-26: "one setting
// instead of showing both at once"). The page side is web/lang.js (PALang); this is the server side:
//   - profile.lang: 'zh' | 'en', or absent = follow the device (the browser's navigator.language);
//   - which apps are deliberately bilingual and keep showing both (the Bible app and its study pages);
//   - the reply-language line an AI turn carries (the setting wins; a bilingual app keeps the old rule).
import fs from 'node:fs';
import path from 'node:path';
import { REPLY_LANGUAGE_RULE } from './config.mjs';
import { slugOk } from './webutil.mjs';

export const UI_LANGS = Object.freeze(['zh', 'en']);
export const langOf = (v) => (UI_LANGS.includes(v) ? v : '');

// Bilingual by slug as well as by meta.json { "bilingual": true }: an installed built-in keeps its OLD
// meta.json (the updater replaces only index.html), so a meta-only flag would never reach those copies.
export const BILINGUAL_APPS = Object.freeze(['bible', 'sunday-study']);
const META_MAX_BYTES = 64 * 1024;   // a meta.json is a few hundred bytes; anything bigger is not read
export function appIsBilingual(appsDir, slug) {
  if (typeof slug !== 'string' || !slugOk(slug)) return false;
  if (BILINGUAL_APPS.includes(slug)) return true;
  try {
    const f = path.join(appsDir, slug, 'meta.json'), st = fs.lstatSync(f);   // lstat: a symlink is not followed
    if (!st.isFile() || st.size > META_MAX_BYTES) return false;
    const m = JSON.parse(fs.readFileSync(f, 'utf8')); return !!(m && m.bilingual === true); }
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
