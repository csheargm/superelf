# ADR 0048 — One language setting · 界面语言

Status: accepted (owner-approved design, 2026-11-26)

## Context
Every label showed 中文 · English at once. The owner asked for ONE setting for all of superelf.

## Decision
- One choice, 'zh' | 'en'. Default: the device (navigator.language zh* → 中文, else English). Kept on the account
  (profile.lang, PUT /api/profile, junk refused with 400) so the iPhone and the iPad match, with a device copy
  (localStorage pa_lang). One control (web/lang-switch.js): a row in the home header's ⋯ menu, right after Text size,
  that names the OTHER language ("中文" in English, "English" in 中文); a tap switches live and the menu stays
  open, re-labelled. Its first-use tip points at ⋯. (v5.38.0 put a 中 | EN switch at the foot of the ☰ drawer;
  the owner could not find it on the iPhone, so v5.38.2 moved it to ⋯ and removed the drawer one: one control.)
  The app bar has no shared ⋯ menu (#fmore is the open app's own), so the row lives on the home ⋯ only.
- One shared mechanism, web/lang.js (PALang), in the shell AND on every app page (web.mjs places its
  marker first). It switches the house-style "中文 · English" strings in place, live, with a MutationObserver,
  so no call site changes; the shell's `.en` sibling pairs follow too. Apps get the choice by {pa:'prefs', lang}.
- Bilingual apps keep both: lib/ui-lang.mjs BILINGUAL_APPS (by slug, since installed copies keep old meta.json)
  or meta.json "bilingual": true. The server writes it into the page (PA_LANG_BOTH).
- AI turns: the chosen language replaces the follow-the-writer rule on every lane — fast, agent, Codex (the line
  leads the prompt: Codex has no system channel), the app ask and the research job (replyLanguageRule);
  bilingual apps keep the old rule.
- No node-wide both-at-once default (v5.38.1 removed the test-only "ui_lang_default"): the test harness runs what
  real nodes run, and browser suites assert the chosen language (the device's, or one they set).

## Consequences
Rewriting text in place can touch app-authored text of the same shape; known limits are in docs/TODO.md.
