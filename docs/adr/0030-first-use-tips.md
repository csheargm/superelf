# ADR 0030 — Every new feature ships a first-use tip (PATips)

Date: 2026-11-12 · Status: accepted (branch first-use-tips; plan docs/plans/note-features.md K)

## Context

Owner 2026-11-12, after the Journal and Bible features of 2026-11-11/12 (Summarize and the ⋯ sheet, tag
chips, every summary run kept, Pencil on verses, the pen sheet, the Settings row, the opening tool,
bookmarks): "for this kind of new features, it would be nice to have a guide to let user know how to use
the new feature the first time, otherwise I really don't know about these new capabilities, and this
could be another design rule."

The existing PANewDot (chat-ui) only puts a blue dot on a control; it says nothing about what the
control does. The owner's UI rules stay: minimal UI, no tours, no modal walls, English then 中文.

## Decision

1. ONE shared component, PATips (web/tips.inline.html), carried by chat-ui after PAAppPrefs, so every
   PAChat page (Journal, Bible) has it. `PATips.register({id, anchor, text, when?})` shows ONE small
   callout beside the anchor the first time it is on screen. One tap dismisses it for good.
2. At most one tip on screen and at most one per page open; the rest wait for the next open.
3. "Seen" is on the account: `appPrefs[slug].tipsSeen`, written only through PAAppPrefs.patch (merged,
   prompt override kept). If the prefs cannot be read, no tip shows (fail quiet; never nag on every open).
4. The Settings dialog has a text link "Show tips again · 重新显示提示" that removes `tipsSeen` from the
   Preferences box; Save brings the tips back.
5. **Design rule: every new user-facing feature registers a PATips tip in its own code, next to the
   control it explains (one or two sentences, English then 中文). A feature is not done until its tip
   has been seen once in a browser test.**

## Consequences

- One fix to placement, colour or persistence fixes every tip.
- A tip anchored to something taller than the screen (the Bible verse list) is anchored to its first line.
- Tips cost one tap each, once per account; a failed "seen" write shows the tip once more later.
- Tested by test/tips.test.mjs over the real component, the real PAAppPrefs and the real shell block.

## Amendment 2026-11-24 — every tip can be closed · 提示都能关掉

Owner report: some tips stayed stuck on screen with no way to close them. Enumerated every tip: the shell had
its own ad-hoc ones (home ⋯ `#hTip` with no ✕, a click on itself only, painted over an open app; the demo build
pill's tip; inline tip lines in the ⋯ menu, Activity log and Needs attention card, stored only in localStorage),
and the PATips ✕ was a 14px glyph, Escape did nothing, the Bible tip covered its own bar's controls on a phone,
an app tip could not be closed by Escape or a press while focus was in the shell, and blocked localStorage threw
at the top of the shell script. Decision (supersedes 2 and 3 above where they differ):

1. PATips is THE mechanism for the shell too (inlined at the shell's PA_TIPS_UI marker); every ad-hoc tip is now
   a `PATipsShell.tip(id, anchor, text)` call. Inline chat notes (the Change-this-app panel's first message) are
   messages, not tips, and stay.
2. Every tip closes by its ✕ (44px, 关闭提示 · Dismiss tip), a tap on it, Escape, or the first press outside it;
   the shell forwards Escape and outside presses into the app frame (`{pa:'tips-dismiss'}`).
3. Seen: the account first (shell: `profile.tipsSeen`, lib/tips-seen.mjs; app: `appPrefs[slug].tipsSeen`
   through the shell), plus localStorage and sessionStorage when they work. The tip is removed before any write;
   a refused write still keeps it closed this session. A refused read with device storage shows tips.
4. Placement measures every visible control and takes the nearest spot that covers none; an anchor in an
   `[inert]`/`[hidden]` layer gets no tip; an anchor in an open modal dialog gets its tip inside that dialog.
5. One tip at a time; app pages keep one per open, the long-lived shell may show the next after a dismissal.
Tested: test/tips-close.test.mjs (unit) and test/tips-close-e2e.test.mjs (chromium + webkit, iPhone + iPad).
