# ADR 0021 — Handwriting paints above typed text and pictures; text mode keeps its taps

Status: accepted · 2026-11-08 · reverses the 2026-09-30 stacking rule in test/note-layer-origin.test.mjs

## Context

- The owner, 2026-11-08: "in journal app, panote, allow handwriting always write on top of texts
  and pictures for hand written annotations". Handwriting on a page is an annotation: a circle
  around a typed word, a tick over a photo, an underline. Under the glyphs it is half hidden.
- PANote's page is three stacked layers inside `.pan-pageInner`: the paper canvas `.pan-bg`, the
  ink canvas `.pan-ink` (strokes AND pictures: `drawImages` paints onto the same canvas, under the
  strokes), and the rich-text layer `.pan-textlayer` (HTML, `z-index:1`). The text layer was above
  the canvas, so a stroke across a typed line showed only in the gaps between letters.
- 2026-09-30 scar: a "Draw below text" toggle raised `.pan-ink` to `z-index:2` and typing died.
  For a stacked element the paint order and the hit order are one axis. The text layer becomes
  interactive in the T tool (`.pan-txted` → `pointer-events:auto`), and a canvas above it took
  every tap first: no caret, no selection, no typing. The test that pinned the revert said what the
  next attempt had to do: raise the canvas only while a drawing tool is active, or separate the
  two axes.

## Decision

1. **The ink canvas is `z-index:2`, always.** Strokes and pictures paint above the typed text.
   The order does not change with the tool, so switching tools never reorders the page.
2. **In the T tool the canvas is transparent to input.** `.pan-editing .pan-ink{pointer-events:none}`.
   `.pan-editing` is the class `enterTextMode` already sets on the pad root for the edge gutters,
   and `exitTextMode` clears. One flag, not a second one that could drift.
3. **Pictures come along.** They live on the ink canvas, so they now also paint above the text.
   A photo placed over a typed paragraph hides it. Accepted: a picture over text is the rare case;
   handwriting over text and pictures is the common one, and the alternative (a second canvas for
   pictures, between the text and the ink) changes `redrawPage`, the committed-stroke cache and
   every image site in a file already 14× its budget. Revisit if the owner hits it.
4. **Print mirrors the screen.** `printPage` draws the typed text first, then pictures,
   highlighter, pen, the same back-to-front order as the page. A stroke across a typed word shows
   on the sheet as it shows on the screen (test/print-note.test.mjs pins it).
5. **Known limit, by design.** During a page-flip the outgoing page is an opaque snapshot (paper +
   ink) and the typed text is a DOM clone above it (`.pan-fliptext`, `z-index:3`), so for the length
   of the animation the text shows over the ink. The canvas cannot hold HTML text.

## Consequences

- test/note-layer-origin.test.mjs pins both halves: the canvas stacks above the text, and the
  T-tool rule takes it out of the hit order. Dropping either one brings the scar back.
- Highlighter strokes (alpha 0.30) now tint the text they cross instead of sitting behind it.
  That is what a highlighter does on paper.
- No shell or broker change. web/note-ui.inline.html is re-inlined on mtime, no node restart.
