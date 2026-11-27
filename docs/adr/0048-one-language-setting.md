# ADR 0048 — One language setting · 界面语言

Status: accepted (owner-approved design, 2026-11-26)

## Context
Every label showed 中文 · English at once. The owner asked for ONE setting for all of superelf.

## Decision
- One choice, 'zh' | 'en'. Default: the device (navigator.language zh* → 中文, else English). Kept on the account
  (profile.lang, PUT /api/profile, junk refused with 400) so the iPhone and the iPad match, with a device copy
  (localStorage pa_lang). One 中 | EN switch at the foot of the ☰ drawer (web/lang-switch.js), with a first-use tip.
- One shared mechanism, web/lang.inline.html (PALang), in the shell AND on every app page (web.mjs places its
  marker first). It switches the house-style "中文 · English" strings in place, live, with a MutationObserver,
  so no call site changes; the shell's `.en` sibling pairs follow too. Apps get the choice by {pa:'prefs', lang}.
- Bilingual apps keep both: lib/ui-lang.mjs BILINGUAL_APPS (by slug, since installed copies keep old meta.json)
  or meta.json "bilingual": true. The server writes it into the page (PA_LANG_BOTH).
- AI turns: the chosen language replaces the follow-the-writer rule on the fast and agent lanes (replyLanguageRule);
  bilingual apps keep the old rule.
- config "ui_lang_default": "both" keeps the old look until a person chooses. The test harness sets it so suites
  written against bilingual labels stay valid; test/lang-e2e.test.mjs runs with the real default.

## Consequences
Rewriting text in place can touch app-authored text of the same shape; known limits are in docs/TODO.md.
