# ADR 0028 — Pencil ink on the Bible text is anchored to the word, not to the page

Date: 2026-11-11 · Status: accepted (branch bible-anchored-ink; docs/plans/annotation-anchoring.md §3 b)

## Context

The Bible verse list is live HTML: it re-wraps on every iPad size, orientation, split-rail drag and
A-/A+ step. PANote's ink is `[x,y,p]` as a fraction of a fixed 816-px page, which is why the Journal
is drift-free and why that model cannot be put over `#verses` without turning the reader into a PDF
(plan §3 a: it costs the live list, the rail, tap-to-select and search jump). Verse marks (option d,
ADR-less, 2026-11-10) answered highlight/underline as text; the owner still wants to write with the
Pencil directly on the verse — underline, circle a word, scribble in the margin — and have it follow
the word.

## Decision

1. **Anchor records, not page fractions.** A stroke group is stored as
   `{verse, lang, charStart, charEnd, quote, dx, dy, w, strokes}` — the W3C TextPositionSelector +
   TextQuoteSelector pair over the verse line's text nodes, plus the group's offset from the
   anchor's top-left and the anchor's width at write time. On every layout change (ResizeObserver on
   `#verses`, window resize/orientation, the shell's `fontScale` message, the host's render) the anchor
   is re-measured with a `Range` — offsets first, then the quote's new place — and the group is
   translated and scaled by `anchorWidthNow / w`. `web/ink-anchor.inline.html` (`PAInkAnchor`).
2. **One renderer, one guard.** The component draws with `PANote.ink` (`drawStroke`, `segTo`,
   `guardInk` hoisted out of the pad and exported); it never carries a second stroke renderer or a
   second copy of the Pencil/palm guard set. The guard is narrowed to the stylus: a finger still
   scrolls, selects and long-presses the list natively. Pen only; there is no toggle, because the
   input kind is the toggle.
3. **Stored beside the marks, through the same save.** `ANN.ink` in `notes/<book>-<chapter>.json`,
   keyed `vN` so the chapter dots count it, written through `saveAnn`; a chapter whose file could not
   be read, or whose read is in flight, takes no ink (the gate is checked at pen-down AND pen-up —
   the pen-down-first order wiped notes on disk once, reproduced on the real broker).
4. **Never drop ink.** A group whose verse line is gone or whose quote is no longer in the line goes
   to a labelled orphan bucket under the last verse (`Ink whose text changed · 经文已改动的笔迹`).
   The eraser is a scrub-out stroke; Safari exposes no Pencil double-tap to a page.
5. **The hosts are a twin.** `workspace/apps/bible/index.html` and the `workspace.example` template
   carry byte-identical ink hunks (one-line hooks with a `TODO(R4 seam)`), pinned by
   `test/ink-anchor-host.test.mjs`; the component reaches the page by serve-time inlining
   (`PA_COMPONENTS`, appended last) because the app sandbox CSP allows no `<script src>`.
6. **A device readout, not a description.** The ⚙ sheet shows one line —
   `Device 设备: w×h px · dpr · A <scale> · text <px> · ink 笔迹 n · orphan 孤立 n` — through a
   `readout:true` PASettings extra (a line the sheet shows, never a box it saves), the Journal's
   DEV_READOUT idea, so the owner screenshots both iPads instead of describing them.

## Consequences

- Word-level ink follows the word across 11"/13", orientation, the rail and A-/A+ by construction;
  verified in a fake DOM with a real wrap model, not yet on the device (plan §6: Scribble vs an
  overlay canvas above `#verses` is the open device question).
- **Known limit, by design:** ink does not re-wrap. A shape spanning two rows follows ONE end and
  skews when the other row moves. The honest fix is per-row splitting of a stroke (one anchor per
  row); it is listed in docs/TODO.md, not hidden.
- The ☰ list and `/api/notes` do not count `ANN.ink`: an ink-only verse has a dot but no row.
- `PAInkAnchor.attach` is one closure well over R4; its split seam (capture handlers, bucket layout)
  is named in the file.

## Addendum 2026-11-11 — pen tools (branch bible-pen-tools)

Owner, 21:00: the ink works but there is no way to highlight, erase, or change pen size or colour.

- **One control.** `web/ink-pen.inline.html` (`PAInkPen`) adds one round button at the verse list's bottom-right,
  above the fab and the safe area, shown only once a Pencil has touched the list (PAInkAnchor's `onPen`); a
  finger-only reader never sees it. It opens a sheet: pen / highlighter / eraser, thin / medium / thick, the swatches.
- **No copy of the palette (R3).** PANote exports `palette` (`COLORS`, `TOOLS`, `ICON`, `ico`, `swatchesHtml`,
  `SIZE_MIN/MAX/DEF`, `MARKER_MULT`, `HILITE_W`, `HILITE_ALPHA`); the pad's own ink and highlight popovers now build
  their swatches with the same `swatchesHtml`, unchanged in output. Sizes are points along the pad's 1–12 scale
  (0.1 / 0.25 / 0.5) and fractions of its highlighter width (0.6 / 0.8 / 1).
- **Records.** A stroke stores `c, w, t` and, for a highlighter, `a`; a stroke with no `t` (written before this)
  renders as a pen. Highlighter strokes draw in a first pass, pen ink over them — the pad's compose order.
- **Eraser.** A touch or drag with the eraser removes every group it passes within `ERASE_HIT`; saved through the
  same coalesced per-chapter chain. Scrub-out still erases in pen mode (not in highlighter mode, where a dense
  back-and-forth is how one highlights).
- **Prefs.** The choice `{t,size,c}` is the app pref `inkPen` on the server (`app-settings` / `set-app-settings`),
  read at attach and on every shell `prefs` push. A write re-reads the stored object, merges into it, and re-sends
  the app's prompt override, because `set-app-settings` replaces the whole prefs object and clears an override it
  is not given. A refused write is shown in the sheet. Rejected: localStorage (throws in the app iframe).
