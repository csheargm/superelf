# ADR 0032 — Home and A-/A+ move into the app's own bar, which slides away (PAAppBar)

Date: 2026-11-13 · Status: accepted (branch feat/app-own-bar)

## Context

Owner 2026-11-13: when an app is open it has its own row of buttons, and the shell adds a second one
(← Home, title, A-/A+) behind a peek handle. Asked: move Home and A-/A+ into the app's own row, and make
that row slide away like the shell's bar, "especially for apps like Bible and Journal" — full screen is
better for reading and writing.

The app is a cross-origin sandboxed iframe: the shell cannot draw into it, so the APP must draw the
buttons and ASK the shell to act.

## Decision

1. ONE shared component, PAAppBar (web/app-bar.inline.html), registered last in web.mjs PA_COMPONENTS.
   The marker sits on the Bible and Journal PAGES, not in note-ui: the Bible's Note pane is also PANote
   and must not grow a second Home.
2. Opt-in per app: meta.json `"ownBar": true` → /api/apps `ownBar` → the shell's OWNBAR_APPS → the
   existing `{pa:'prefs'}` message carries `ownBar:true` (plus the A-/A+ titles, one source, R3). Without
   it the component draws nothing; other apps keep today's shell bar unchanged.
3. App → shell: `{pa:'shell', type:'ready'|'home'|'font', d}`. The shell accepts one only from the page in
   `#fr` RIGHT NOW (never one still leaving, ADR 0018), with origin `'null'` (sandboxed), while an app is
   open, for an own app flagged ownBar; `d` must be -1, 0 (reset) or 1; at most 20 font steps a second.
   `home` calls `goHome()` and `font` calls `fsStep`/`fsReset` — the same functions the shell's buttons
   call, so the effect is identical by construction.
4. Fallback: the shell hides its bar and handle (`#frame.ownbar`) only after the app says `ready`. An app
   whose script breaks before that keeps the shell's bar, so Home is never lost.
5. Hiding: Bible — hide after 24px of scrolling down the reading pane, show after 24px up and always at
   the top; the row gives its height back to the text (margin-top), so reading is full height. Journal —
   a touch on the page hides it; the listener is passive and capture-phase, never preventDefault, never
   pointer capture, so it cannot take a Pencil stroke or undo the iOS handwriting fix. Both: a 64x16
   handle at top-centre (the shell peek's geometry) brings the bar back for 2.5s; it ignores a Pencil
   (pointerType pen) so a resting pen cannot pull the bar over the page.
6. NO idle return. On iPad a bar that slides back on its own covers text mid-read and can catch a resting
   palm; the owner asked for full screen, so the bar comes back only when asked (scroll up, the handle,
   the top of the page).
7. Never hides while the app's keepOpen() says a sheet is open (search, the drawer, a dialog, a PANote
   popover), nor while a field in the bar (the book select) is in use.
8. Phone (<=600px): the Journal row has no room, so A-/A+ move into the existing page-settings (⋯) menu
   — no new button. The Bible row already wraps on phones and keeps them.
9. First-use tip `app-own-bar` beside Home (ADR 0030).

## Consequences

- The shell's own Home in the drawer still works; the app's Home is the everyday one.
- shared-apps/ copies follow at the owner's next promote (their meta.json has no ownBar yet).
- Family/shelf copies of these apps (uid not the owner's) keep the shell bar: OWNBAR_APPS lists own apps.
- In the Journal the area under the hidden bar stays the pad's top inset (the page itself does not move
  up), so ink coordinates never shift; true edge-to-edge paper would need a note-ui change.
