# ADR 0031 — Panes float, maximise and close through shared pane chrome (PAPaneChrome)

Date: 2026-11-13 · Status: accepted (branch feat/bible-panes; plan bible-panes items 3, 4, 7)

## Context

Owner 2026-11-13: the Bible's Note and Ask AI panes are "really hard to move around"; wanted the
Claude-desktop feel where a view "can be closed and max'ed or floating". The panes are PASplit slots
(web/split-ui.inline.html), which already had Maximise (⤢) and the ⤓/⤒ dock control, but no Float and
no per-pane Close. split-ui is over the R4 budget (525 lines), so a new responsibility cannot go in it.

## Decision

1. ONE shared component, PAPaneChrome (web/pane-chrome.inline.html), carried by split-ui after its own
   script, so every PASplit page (Bible, Journal) gets it with no per-app code. It adds Float (⧉, which
   becomes Dock ⇲ while floating) and Close (✕) to every slot header. Maximise / Restore stays PASplit's
   own ⤢: one maximise, not two (R3).
2. PASplit calls it through a handful of one-line hooks (attach, onToggle, onMax, restore, destroy) and
   treats a floating slot as being in no zone, so an emptied rail stops pushing the page.
3. The float window is dragged by the pane header, resized from its corner, and always clamped inside
   the viewport (also after a resize or rotation).
4. Layout is an ACCOUNT app pref, `paneLayout = {<key>: {mode: docked|floating|max, rect}}`, written only
   through PAAppPrefs (the page's one prefs writer). A remembered mode applies when its pane OPENS;
   Close keeps it, so a pane reopens the way it was left. Nothing maximises unless the user left it so.
5. Narrow screens: PASplit's own gate (onGate, never a second media query) sets `html.pch-narrow`, which
   hides Float and ⤢. A narrow screen has no rail anyway; panes open full screen there as before.

## Consequences

- Any app that mounts PASplit (the Journal included) has Float / Close today; adopting a remembered
  layout needs nothing more from it.
- A refused layout read or write is shown on the pane header, bilingual (R5); the panes still work docked.
- Closing the WHOLE rail (Escape) does not hide a floating window yet (docs/TODO.md).
