# Annotation anchoring — ink on verse text, and mixed ink + typed text across iPads

Status: §7 Bible row SHIPPED (option d, verse marks) 2026-11-10 — see §7. Option (b) anchored ink IN PROGRESS on branch
`bible-anchored-ink`: phase 1 (2026-11-11) = `web/ink-anchor.inline.html` (`PAInkAnchor`) over `#verses`, drawing with
`PANote.ink` (the pad's stroke renderer + Pencil guard, hoisted and exported — the §7 PANote row), Pencil-only capture,
anchor records `{verse,lang,charStart,charEnd,quote,dx,dy,w,strokes}` and re-anchoring on resize / orientation / rail /
fontScale / render (`test/ink-anchor.test.mjs`). Phase 2 (2026-11-11) = the ink is SAVED: `ANN.ink` in the chapter file
beside the marks (`{vN:[group…], unanchored:[…]}`, `PAInkAnchor.pack`), loaded in `load()` after `loadAnn`, written
through `saveAnn` (an unreadable chapter takes no ink); the eraser is a scrub-out stroke (back and forth over one
spot: every group it crosses goes, the scrub is not kept, a scrub over nothing is ink); a group whose quote or verse
line is gone sits in the labelled orphan bucket under the last verse (`Ink whose text changed · 经文已改动的笔迹`),
never dropped. Phase 3 (2026-11-11) = both Bible copies carry identical hunks (`test/ink-anchor-host.test.mjs` pins
the twin and the served page), a device readout line in the Bible's ⚙ sheet (`PAInkAnchor.READOUT`, a `readout:true`
PASettings extra — the Journal's DEV_READOUT idea), ADR 0028. No ✎ toggle: the Bible has no ✎ fab and the stylus/finger
split IS the toggle (Pencil inks, finger scrolls) — one is added only if the owner asks after the device check. Known
limit kept (docs/TODO.md): a shape across two lines follows ONE end. Pen tools (2026-11-11, branch `bible-pen-tools`,
owner: "no settings to highlight, erase, change pen size or colour") = `web/ink-pen.inline.html` (`PAInkPen`): one round
button after the first Pencil touch opens pen / highlighter / eraser, three sizes and the pad's swatches, all from
`PANote.palette`; highlighter behind ink; the choice is the server-side app pref `inkPen` (ADR 0028 addendum,
`test/ink-pen-host.test.mjs`). The rest is PLAN / research. 2026-11-09.
Scope: Bible mini app (`workspace/apps/bible/index.html`), Journal (`workspace/apps/notes/index.html`),
shared PANote engine (`web/note-ui.inline.html`). No code was changed for this document.

## 1. The problem, stated precisely · 问题

Two layers, two units (两种单位):

- **Ink** (手写笔迹) is stored as `[x,y,p]` with x AND y divided by the page WIDTH
  (`note-ui.inline.html:1922` `denorm`, `:2893` `nx=(clientX-r.left)/(W*k)`). A stroke is a
  fraction of the page width; it has no idea what word it was drawn over.
- **Typed text** (`pageHtml`) and **verse text** (`.ven/.vzh`) are HTML. HTML reflows (重排):
  line breaks move with container width, font size and language. A word is wherever the
  browser puts it this time.

Ink drawn "under line 3" stays at y = 0.21 × W; line 3 moves. That is the whole bug. Concrete
cases where the text moves and the ink does not:

| Case 条件 | What changes | Affects |
|---|---|---|
| iPad 11" vs 12.9"/13" | CSS viewport: 11" = 834×1194 (older) or 834×1210 (M4/M5); 12.9" = 1024×1366; 13" M4/M5 = 1032×1376; all dpr 2 ([madegooddesigns](https://madegooddesigns.com/?p=130812), [screen-size-checker](https://screen-size-checker.pages.dev/devices/ipad-viewport-sizes), [kioskgroup](https://support.kioskgroup.com/article/660-determining-screen-dimensions-for-content)). Third-party tables — verify on the real devices (§6). | Any layer laid out at the live width |
| Portrait ↔ landscape 横竖屏 | width 834↔1194 (11"), 1024↔1366 (12.9"): a 43% / 33% width change, every paragraph re-wraps | same |
| Split rail 分栏 | `PASplit` gate `(min-width:820px) and (min-height:600px)` (`split-ui.inline.html:122`); rail takes 24–60% of the viewport (`:123`), so the text column is 40–76% of it and the user can drag it live | Bible text column AND the pad slot |
| Font scale A-/A+ 字号 | shell broadcasts `fontScale`; Bible gets `--fs` on `html{font-size:calc(17px*var(--fs))}` (`bible/index.html:12`), verses are in `em` (`:41-42`) so every line re-wraps; PANote hosts are excluded from `zoom` (`web.mjs:663-668`, pinned in `test/app-prefs-inject.test.mjs:58`) | Bible text; NOT the PANote page |
| BSB text correction 经文更新 | verse text comes from the on-disk corpus `bible-data/bsb/<BOOK>/<ch>.json` (`lib/bible.mjs:1-15`); a refetch can change wording, punctuation, even verse count (BSB is still being revised) | character offsets, line count |
| CSS change in a later session | padding, line-height, font family | everything laid out live |

## 2. How it is handled today · 现状 (measured in code)

### PANote (Journal and Bible notes) — fixed page, scaled as ONE unit · 固定页面整体缩放

- `const PAGE_W=816, PAGE_H=1056` (US Letter at 96 dpi), `note-ui.inline.html:595`; the SCAR
  comment at `:577-594` is this exact bug (11" iPad vs laptop, ink landed on top of typed text).
- `W=PAGE_W` always (`:1701`). Scale `k=max(MIN_PAGE_W/PAGE_W, stage.width/PAGE_W)` (`:1712`),
  applied with CSS `zoom` to the page element (`:1752`), not `transform`, so hit-testing and
  scrolling stay in one space; `pageK()` (`:2837`) reads the achieved ratio back from the rect.
- The text layer is `position:absolute;inset:0` inside that 816-wide page (`:321-323`,
  font 18px, line-height 1.6), so **pageHtml IS laid out at 816 CSS px and zoomed with the
  ink**. Ruled templates set font/line-height from `ruleGap()=W/RULE_DIV` (`applyTextMetrics`,
  `:1860-1880`) — also a function of W=816, not of the device.
- Resize path: `ResizeObserver` on the stage (`:4165-4175`) + `window.resize` (`:4191`) +
  re-measure on `show()` (pinned by `test/note-resize.test.mjs`); orientation and rail drags
  go through the observer, so the memory-level fact "CSS layout change fires no resize event"
  is already honoured. One origin, one unit for both layers is pinned by
  `test/note-layer-origin.test.mjs`; the fixed page by `test/note-page-scale.test.mjs:64-126`.
- Backing store follows the on-screen size, capped by area (`MAX_CANVAS_PX`, `:1757-1760`).
- Consequence: a Journal page looks the same on 11", 13", portrait, landscape and paper.
  What still differs per device is only how much of the page is visible and `k`.

### Bible pad — same engine, not a special single-canvas mode

`NOTE_OPTS={pages:true, tool:'text', template:'plain', …}` (`bible/index.html:1065-1069`), one
pad instance, mounted either full-screen or inside the rail's note slot (`:1180-1205`). The
note is keyed per scope (`v16`, `v16.17`, `general`, `free-<ts>`; `:547-557`) and stored in the
chapter file `notes/<book>-<chapter>.json` (`:451`). The verse text itself (`#verses`, `.verse`
blocks built in `renderVerses`, `:664-680`) is a live-width HTML list with **no ink layer at
all**: the ink lives in the pad, beside the text. So today nothing drifts on the Bible —
because nothing is on the verse.

## 3. Options for annotating ON the verse text · 在经文上批注的方案

Reflow cases compared: R1 width/orientation/rail, R2 font-scale, R3 BSB wording change,
R4 verse count change (rare), R5 device 11" ↔ 13".

### (a) Fixed-layout chapter page · 固定版式章节页 (PDF model)

Render the chapter into a PANote page at a fixed CSS width (816 or a chapter-specific width),
typed verse text as the page's text layer, ink on top, zoom the whole page as one unit — exactly
what the Journal does now, and what GoodNotes/Notability do over a PDF. Reuse: `PANote.mount`
with a read-only text layer and the chapter HTML as `pageHtml`.
- R1/R2/R5: no drift at all; the page just gets bigger or smaller. Font scale must become a
  page-level choice saved WITH the note (it changes layout), not the live `--fs`.
- R3: wording change re-wraps the chapter page → ink drifts from the changed line downward.
  Mitigation: freeze the rendered text in the note (store `pageHtml` at first annotation) and
  show a "text updated · 经文已更新" badge offering re-layout; or re-layout per verse (see c).
- Breaks: the verse list stops being a live DOM list (tap-to-select, search jump, `.ndot`,
  long-press explain at `:1383-1430` all need re-wiring to page coordinates); the whole-chapter
  canvas is tall (Psalm 119 ≈ 8+ sheets) → `SEAMLESS_MAX_SHEETS`/`MAX_CANVAS_PX` limits apply;
  the rail's note slot becomes redundant. Existing notes: untouched (separate files).
- Cost: 4–6 sessions. Risk: high (re-platforms the reader).

### (b) Anchored ink · 锚定笔迹 (web-annotator model)

Keep the live verse list. Each stroke GROUP is stored relative to an anchor: `{verse:n, lang:'en',
charStart, charEnd, quote, dx, dy, w}` — offsets within the verse's text node plus the quoted
text, like W3C Web Annotation `TextPositionSelector` + `TextQuoteSelector` + a `RangeSelector`
fallback ([Hypothesis, Fuzzy Anchoring](https://web.hypothes.is/blog/fuzzy-anchoring/),
[W3C Robust Anchoring](https://www.w3.org/2014/04/annotation/slides/RobustAnchoring.pdf)). On
every layout change (ResizeObserver on `#verses`, font-scale message, chapter render) re-measure
the anchor's `Range.getBoundingClientRect()` and re-position the group.
- R1/R2/R5: an underline or circle on a WORD follows the word. A margin scribble follows its
  anchor verse. But a shape that spans two lines (an arrow from v3 to v7, a bracket down the
  margin) is anchored at one end; the other end lands wherever the new wrap puts it. Ink does
  not re-wrap; only its origin moves. This is the honest limit of the model.
- R3: offsets fail, quote search re-anchors (Hypothesis's own strategy); still "orphan" when the
  phrase is gone → show orphaned ink in a margin bucket, never drop it.
- R4: verse number is the primary key, so a renumbering is an orphan case too.
- Breaks: nothing existing (new store, e.g. `ANN.marks[verseKey]`), but the Bible needs its own
  ink layer over `#verses` (a second place that renders strokes — R3 duplication risk unless
  `drawStroke` is exported from PANote; `:1960` already notes geometry is reusable).
- Cost: 3–4 sessions (export stroke renderer, anchor store, overlay canvas with re-anchor,
  palm/Pencil guards copied from the rail — the hard-won `touchstart preventDefault` set).
  Risk: medium; the re-anchor math is where it goes wrong, and it needs real-device checks.

### (c) Per-verse mini canvases · 逐节小画布

Each `.verse` block owns a canvas sized to the block; strokes normalised by the BLOCK width and
anchored to the verse number; the block grows to contain ink below the text.
- R1/R5: ink scales with the block width — a circle around a word stays near it only if the word
  does not change lines, i.e. this is (b) with a single anchor per verse and scaling instead of
  translating. Shapes stretch horizontally when the aspect changes (x and y both ÷ block width,
  but the block gets taller, not wider, when text wraps more).
- R2: text wraps inside the block, ink does not → same drift as today within the verse.
- R3: survives wording changes better than (a) (drift confined to one verse), worse than (b)
  (no word anchor). R4: verse-keyed, so renumbering orphans.
- Breaks: 150 canvases for Psalm 119 is fine (small), but each is its own backing store and each
  needs the Pencil guard set. Cost 2–3 sessions, risk medium-low. Visually the weakest: ink is
  clipped to its verse, no cross-verse marks.

### (d) Typed-only verse marks + ink stays in the pad · 经文只做高亮/下划线，笔迹留在笔记本

Highlight, underline, colour tag and a short note attached to a verse span (`v16`, or a character
range inside a verse). Rendered as `<mark>`/CSS on the live text, so it IS text and reflows with
it. Free ink stays in the PANote pad (already a fixed page, already drift-free).
- R1/R2/R5: perfect by construction. R3: range inside a verse re-anchors by quote; whole-verse
  marks never break. R4: verse-keyed.
- Breaks nothing; extends the existing per-scope store (`ANN.*[scopeKey]`). The verse selection
  UI already exists (`selectVerse`, `.verse.selected`, fab). The `.ndot` becomes the mark.
- Cost: 1–2 sessions. Risk: low. What it does NOT give: a hand-drawn arrow between verses.

### Comparison · 对比

| | (a) fixed page | (b) anchored ink | (c) per-verse canvas | (d) typed marks |
|---|---|---|---|---|
| Drift on width/orientation (R1,R5) | none | word-level ok, multi-line shapes skew | within-verse drift | none |
| Font scale (R2) | none (scale frozen per note) | re-anchor, same skew | drift | none |
| BSB wording (R3) | whole page re-wraps unless frozen | quote re-anchor, orphans possible | one verse | re-anchor by quote |
| Verse count (R4) | re-wrap | orphan | orphan | orphan (rare) |
| Cross-verse marks | yes | partly | no | no |
| Existing notes | untouched | untouched | untouched | untouched |
| Sessions | 4–6 | 3–4 | 2–3 | 1–2 |
| Risk | high | medium | medium-low | low |

### Recommendation for the Bible · 圣经推荐

**(d) first, then (b) as a second step if the owner still wants free ink on the text.**
Reasons: (d) answers "annotate on the verse itself" for the common cases (highlight, underline,
margin note) with zero drift on any screen and zero risk to the reader; it needs no new ink
renderer; the font-scale and split-rail behaviours the Bible already has keep working. (a) is
the only option that makes arbitrary ink truly stable, but it costs the live verse list and the
rail, and the Journal pad already offers that fixed page one tap away. (b) is the right shape
for word-level ink and is additive to (d) (same anchor record, plus a stroke group), so (d) is
not wasted work. The owner's own worry — "if the formatting of the verses changes" — is
answered by (d) honestly: the mark is text, so it changes with the text.

## 4. Journal: mixed ink + typed text · 日记：手写与打字混排

What the fixed page already gives: `pageHtml` is laid out at W=816 inside the zoomed page
(§2), so typed text wraps identically on both iPads and in both orientations, and the ink sits
on the same 816-unit page. This is the design that fixed the 2026-09 scar; both invariants are
pinned by tests. Checked, not assumed: the text layer has no live-width dependency in CSS
(`:321-323`), and its font metrics derive from W (`:1860-1880`), not from the device.

What can still break it (each is a candidate for the owner's observed inconsistency and must be
confirmed on device, §6):
1. **Font scale leaking in — CONFIRMED in code, not yet on device.** PANote hosts get `--fs`,
   not `zoom` (`web.mjs:668`), and the Journal sets `html{font-size:calc(17px*var(--fs,1))}`
   (`notes/index.html:8`). `.pan-textlayer` itself uses px/em (`note-ui:321-350`), but
   `sanitizeHtml` ACCEPTS `rem` and `%` on `font-size` (`SAFE_FSIZE`, `note-ui:667`, used at
   `:676`). Any pasted or imported paragraph carrying `font-size:1.2rem` is therefore sized
   from the DEVICE's A-/A+ setting (and from the host's 17px root), while the ink beside it is
   sized from the 816 page. Two users of the same note at different font scales, or one iPad
   with A+ set and one without, see the text wrap differently under the same ink. This is the
   one leak that reproduces the owner's description without any device difference at all.
2. **Pasted/legacy HTML with absolute widths** (`<table width>`, images with px sizes) that
   exceeds 816 → horizontal overflow laid out differently per engine. Low probability.
3. **Fonts.** The text layer uses the system font stack; iPadOS versions differ in glyph
   metrics only marginally, but a page typed on a Mac and read on iPad can differ by a line
   near the page edge. Fix: name one font and ship it, or accept ±1 line.
4. **The stationery inset** (`STN.inset`, `:1880`) changes the text column per design — fine
   as long as it is in page units; verify it is not measured from the screen.
5. **Keyboard / visualViewport.** On iPad the keyboard shrinks the stage; the ResizeObserver
   re-runs `setupCanvases` → k changes mid-typing. Ink and text still agree (same page), but the
   view jumps. Not a drift bug; a UX one.
6. **Seamless vs single page** choose different k (width-fit vs both-axes fit, `:1733-1746`):
   the same note shows at a different size per mode, which can LOOK like inconsistency.

Proposed fix: no layout re-architecture. (i) **SHIPPED** (branch journal-font-leak): `rem` and
`%` dropped from `SAFE_FSIZE`; `rem`→`em` at 1:1 in `cleanStyle` (`bindFontSize`), which keeps
pasted size ratios and binds them to the page's 18px; `%` is dropped and inherits. Invariant
test `test/note-font-leak.test.mjs`: no `rem`, no `vw/vh`, no `var(--fs)` inside `.pan-textlayer`
rules, no `rem`/`%` font-size surviving the sanitizer (1.2rem → 1.2em, with a mutation control).
Existing notes with `rem` already stored are re-sanitised on next load (`pageTextHtml`), so the
fix reaches old pages too. (ii) **SHIPPED**: one line in the existing page settings sheet (the ⋯
sheet, under the Transcript row): `Device 设备: <w>×<h> px · scale k=<k> · text <px>px · page 816`
(`DEV_READOUT`), refreshed when the sheet opens, so the owner can screenshot both iPads instead
of describing them. Device check on both iPads still pending (docs/TODO.md). (iii) If the
device check shows a real difference, the cause is one of 2–4 and is a one-session fix each.

## 5. Experiment plan · 实验计划 (real devices)

Same note, same chapter, on the 11" and 12.9"/13" iPad, portrait and landscape, rail open and
closed, font scale 1.0 and max. Record from Web Inspector or the debug readout:
`window.innerWidth/innerHeight`, `devicePixelRatio`, `visualViewport.scale`,
`pageInner.getBoundingClientRect()` (width must equal 816·k), `textLayer.offsetWidth` (must be
816), `getComputedStyle(textLayer).fontSize` (18px plain / ruleGap·0.6 ruled on BOTH devices),
line count of a known paragraph (equal on both), and for the Bible `#verses .ven` wrap count
of a known verse (expected to DIFFER — that is the Bible's reflow, not a bug).
Pass criterion: every page-unit number equal across devices; only `k` and the viewport differ.

Test to pin in-repo (`test/note-page-scale.test.mjs` already pins W=816 and the zoom; add):
`.pan-textlayer` has no `rem|vw|vh|--fs`; `sanitizeHtml('<p style="font-size:1.2rem">')`
yields px or em; the Bible's `renderVerses` output contains no stroke data (until (b) lands).

## 6. Unknowns · 未知 (honest list)

- The iPad CSS px figures above are from third-party tables, not Apple docs; measure them.
- Whether the owner's Journal inconsistency is 4.1 (rem in pasted HTML), 4.3 (font metrics)
  or 4.6 (mode-dependent k). Only the device readout decides; no code change before that.
- Hypothesis's CURRENT re-anchoring code was not reviewed (the 2013 post and W3C slides were);
  the strategy order (position → quote fuzzy → XPath) is what is cited.
- Pencil behaviour on an overlay canvas above `#verses` (option b) vs the Scribble issue
  already recorded for PANote — must be tried on device before committing to (b).
- BSB revision cadence: the corpus is a snapshot; how often it is refreshed decides how much R3
  matters.

## 7. Recommendation per app · 各应用建议

| App | Recommendation | Why |
|---|---|---|
| Bible 圣经 | **SHIPPED 2026-11-10**: (d) typed verse marks (`web/verse-marks.inline.html`, `PAVerseMarks`); (b) anchored word-level ink later if asked | drift-free on every screen, 1–2 sessions, keeps live list + rail; ink stays in the fixed-page pad |
| Journal 日记 | Keep the fixed 816-page model; close the `rem`/`%` leak in `SAFE_FSIZE` (§4.1, one session, with the invariant test); then run §5 on both iPads for §4.2–4.6 | the architecture already solves the stated problem; the one leak found in code is a unit leak, not a design gap |
| PANote engine | **DONE 2026-11-11**: `drawStroke`/`drawFlat`/`segTo`/`segWidth` + `guardInk` hoisted to module scope and exported as `PANote.ink` | (b) or (c) must not re-implement stroke rendering |

### Bible verse marks as shipped · 已交付 (option d) — honest limits

What it is: `Mark · 标记` on the verse fab opens a sheet (three colours, `Underline · 下划线`,
`Remove · 移除` once a mark exists). A mark is whole-verse, or a character range when the native
text selection lies inside one verse line (`.ven` or `.vzh`). Stored in the chapter file as
`ANN.marks[verseKey] = [{kind:'hl'|'ul', color?, lang?, quote?, start?, end?}]` — character offsets
and the quoted text, never a pixel. Rendered as `<mark>` spans on the live text, so R1/R2/R5 hold by
construction. On render a range is anchored by offsets, then by quote search (R3), and an unfindable
quote shows as a whole-verse mark with a `text changed · 经文已更新` badge rather than being dropped.
The `.ndot`, the ☰ list (any row with marks gets the `Mark 标记` chip, a mark-only verse also its
quote as preview; the `notes-list` reply carries `marks` and `hasText` per row) and delete-from-list
all count marks. ONE rule for the list: the chip says the row has marks; delete removes the note
(text, ink, title, bookmark) and keeps the marks unless the row is mark-only (`!hasDraws &&
!hasText`), in which case the marks are what is deleted and the verse text is repainted. Pinned by
`test/verse-marks.test.mjs` on both shipped copies through the app's own save path.

Limits, by design or not yet done:
- No cross-verse marks: a range is clipped to one verse line (English OR Chinese), and a selection
  spanning lines falls back to a whole-verse mark. Several verses selected get one whole-verse
  mark each.
- No ink on the verse text; free ink stays in the PANote pad (option (b) is the follow-up).
- On touch, dragging a text range competes with the long-press explain (500 ms) and with iOS's own
  word selection; whole-verse marks are the touch path, ranges are the trackpad/mouse path until
  that is tried on device.
- A renumbered verse (R4) is keyed by its number and is not re-anchored.
- The component was chosen over a sibling `marks.js` because the app sandbox CSP is
  `script-src 'unsafe-inline'` only (web.mjs): a sibling script file cannot load, so serve-time
  inlining through `PA_COMPONENTS` is the only way to share it.
