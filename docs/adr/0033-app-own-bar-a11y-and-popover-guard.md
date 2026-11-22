# ADR 0033 — App own bar: inert when hidden, PANote's popover check

Status: accepted (2026-11-13). Follows ADR 0032.

## Context
Review of the app's own bar (PAAppBar) found two defects:
1. A hidden bar was only moved off-screen (transform / negative margin). Home, A-/A+ and the
   Bible's `#nav` controls stayed focusable, so keyboard, switch-control and VoiceOver users could
   reach and press an invisible Home.
2. Journal's `keepOpen` copied PANote's popover selector by hand and missed `.pan-hlpop.on`
   (the highlight picker), so a tap inside that picker hid the bar under an open popover.

## Decision
- `setHidden()` sets `bar.inert = hidden`. Inert removes the controls from focus and the
  accessibility tree while hidden and restores them when shown.
- PANote's pad API exports `popsOpen()`, built on its single `POPS_OPEN` constant. Journal's
  `keepOpen` calls `pad.popsOpen()` and keeps only its own host checks (drawer, dialog). No
  copy of the popover selector lives outside PANote (R3).
- Browser-free tests (`test/app-bar.test.mjs`) cover the component, so it is tested even
  when Playwright is missing.

## Consequences
A new PANote popover added to `POPS_OPEN` keeps the bar open in Journal automatically.
