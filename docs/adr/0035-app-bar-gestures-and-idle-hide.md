# 0035 — App bar gestures: pull down shows, swipe up does nothing, idle hide; no stripe; phone labels

Date: 2026-11-13. Status: accepted; §1 amended by 0036 (swipe up hides). Supersedes 0032 (scroll-down hides, Journal page touch hides) and 0034 §2
(handle-shown bar stays until the next move).

## Context
Owner, iPhone screenshots, same day: the bar kept vanishing on a forward swipe and staying when unwanted; in the
Journal a hidden bar left a dark stripe (the bar's old height stayed reserved above the page); the Bible's
bilingual top-bar labels wrapped to two lines on a phone.

## Decision (PAAppBar, web/app-bar.inline.html — one place for both apps)
1. Swipe up / scroll down: nothing. The bar keeps its state.
2. Pull down shows it: a one-finger touch drag of PULL_PX (24) more down than across — also at the very top
   where nothing scrolls — or a scroll up of PULL_PX on the host's scroller, or a wheel up (desktop).
3. Shown (on open, by a pull, by the handle) it hides itself after IDLE_MS (4 s). A pointerdown / click /
   key / focus / change inside the bar restarts the clock. It never hides while keepOpen holds: a field or
   keyboard focus inside the bar, an `aria-expanded="true"` control, `hold(true)`, or the host's keepOpen
   (Bible: search, drawer, Highlight sheet, dialog, pen sheet, Note / Ask AI pane in the rail or full
   screen; Journal: PANote popovers, drawer, dialog). It also waits while a pointer is down, because hiding
   moves the page (below); a pointerup lost outside the frame stops counting after 3 waits.
4. Listeners are passive and never preventDefault. A Pencil (`pointerType 'pen'`, iOS `touchType 'stylus'`)
   never starts a pull. Removed: `touchHides`, the scroll-down hide, the handle-only "stays" state.
5. No stripe: PANote's `barClearance()` returns the safe-area top (probe `env(safe-area-inset-top)`) while
   its `.pan-top` carries `data-paab-hidden="1"`, re-read through a MutationObserver, so the page and the
   floating tools move up. The Bible's in-flow `#nav` already gave its height back (pinned by test).
6. Bible phone (≤600px): the top-bar controls show one short line (`高亮 / 笔 / 笔记 / 问AI` via `data-short`);
   the full bilingual label stays as `aria-label` and `title`.

## Consequences
- The page shifts up by the bar's height when the bar idles away, and back when it is pulled. Accepted: the
  owner wants the full screen; the shift never happens mid-stroke (rule 3).
- A finger drawing downward with finger-draw on shows the bar (only the Pencil is excluded).
- The safe-area strip itself is the shell's `#frame.peek` padding (shell `--bg`), outside the app frame; the
  app cannot colour it. Not the app bar background.
- Tests: test/app-bar.test.mjs (state machine, fake clock), test/bar-gestures-e2e.test.mjs (390x844 touch
  phone, CDP touch swipes), updated test/app-own-bar-e2e.test.mjs and test/bar-handle-e2e.test.mjs.
