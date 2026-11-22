# 0034 — Bigger bar handle, handle-shown bar stays, Home tip first, Bible Pen in the top bar

Date: 2026-11-13. Status: accepted. Amends 0032 (§5 handle size and timer) and 0030 (tip order).

## Context
Owner, same day as 0032: the top handle is hard to hit; a handle-shown bar leaves after 2.5 s, so reaching
Home is a race (and in the Journal a fast click during the slide-in misses); the "Home moved" tip waits behind
older unseen tips (one tip per open), so a returning user hunts for Home; and the Bible's pen sheet should open
from the top bar, not from a floating button that appears only after the first Pencil touch.

## Decision
1. Handle 64x16 → 120x28 tap area, grabber 34x4 → 60x6, still top-centre. ONE source: `web/bar-handle.css`
   (custom properties), inlined into the shell (`lib/shellhtml.mjs` SHELL_PARTS) and into PAAppBar pages
   (web.mjs PA_COMPONENTS) at the `/* PA_BAR_HANDLE_CSS */` marker (R3). Measured on every shipped app at 375px
   and 1024px: the growth covers no app control the old handle did not (test/bar-handle-e2e.test.mjs). Pre-existing:
   longevity and productivity-hub put a tab row at the very top, and their centre tab was already under the old
   64x16 — recorded in the test, not fixed here.
2. PAAppBar: a handle-shown bar has no timer. It leaves on the next move — scroll down, a touch on the page
   (Bible too, only in this state), or a bar button that navigates (not A-/A+, not one that opened a menu or sheet).
3. The shell's own `#barpeek` (other apps) KEEPS its 2.5 s timer. The shell cannot see a touch inside a
   cross-origin app frame, and a tap on a PANote pad moves no focus (the iOS handwriting fix prevents default),
   so the timer is the only thing that puts an overlaying bar back off the app's own header. Without it the
   shell bar would sit on top of the app's buttons until the user tapped a text field.
4. `PATips.register({…, priority:true})` queues a tip ahead of non-priority ones and replaces one already on
   screen (unseen, so it shows on a later open). Default unchanged. The app bar's Home tip uses it.
5. `PAInkPen.attach({floating:false, tipAnchor, onToggle})` + `openSheet(control)`: no round button; the host
   opens the same sheet below its own control; a press outside closes it. The Bible adds "Pen · 笔" after
   Highlight; `aria-expanded` and `keepOpen` keep its bar out while the sheet is open. The floating mode stays the
   component default.
