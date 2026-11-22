# 0036 — App bar: a swipe up hides at once

Date: 2026-11-13. Status: accepted. Amends 0035 §1 (swipe up did nothing).

## Context
Owner's final answer, same day, after 0035: in both the Bible and the Journal a swipe up (content moves
forward) should take the bar away at once, not wait for the idle clock.

## Decision (PAAppBar, web/app-bar.inline.html)
1. A one-finger touch drag of PULL_PX more up than across hides the bar at once. Works over a pad that
   cannot scroll (Journal Draw). A Pencil (`pointerType 'pen'`, `touchType 'stylus'`) never hides or shows it.
2. On the host's scroller (Bible #verses) a forward scroll of PULL_PX hides it, but only when the user drove
   the scroll (a finger down, or a wheel / key within USER_SCROLL_MS = 1 s): a programmatic jump to a verse on
   open must not hide the bar before it is seen. Wheel down hides on desktop.
3. keepOpen still wins over the swipe: a menu, sheet, pane or focused field opened from the bar keeps it.
4. Pull down, the handle, the idle hide (IDLE_MS), the stripe fix and phone labels are unchanged from 0035.
   The pointer-down tracking is tightened: a pointer is never expired by time, only by pointerup,
   lostpointercapture, blur or visibilitychange; a finger counts until touchend (iOS sends pointercancel
   when native scrolling takes the touch while the finger is still down).

## Consequences
- Reading forward in the Bible now gives the full screen immediately, as before 0035.
- Tests: test/app-bar.test.mjs (swipe-up, scroller, wheel), test/bar-gestures-e2e.test.mjs (real CDP swipes).
