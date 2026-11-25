# ADR 0003 — Journal stationery (信纸): components, data, AI channel, trust boundary

Status: accepted · 2026-10-11

## Context

- The Journal (workspace/apps/notes) gets decorative writing paper: 10 bundled designs, "My
  templates" the user keeps, designs drawn by an AI from words or a picture, and an uploaded
  picture used as the paper itself.
- `web/note-ui.inline.html` (PANote) is far over the 300-line budget (R4). It also serves the
  Bible and every other PANote host, which should not pay for this feature.
- A design is SVG. Some of it comes from an AI, or from a file someone else wrote. It is turned
  into an image inside the Journal page, which holds the user's private notes.

## Decision

1. **Five components, one opt-in marker.** Only the Journal carries `<!--PA_STATIONERY_UI-->`
   (web.mjs inlines it). `stationery-ui` carries the rest at its own markers:
   - `stationery-sanitize` — the sanitizer (the trust boundary, point 4). It runs first.
     Its render-cost budget is `stationery-cost`, split out of it for R4 (2026-10-13). The
     sanitizer carries the `stationery-cost` marker above its own script, so the budget runs
     before the sanitizer. The budget's readers of lengths, transforms and shapes are
     `stationery-geometry`, split out of it the same way (R13 round 3), and run before it.
   - `stationery-ui` — `PAStationery`: registry, store, renderer.
   - `stationery-designs` — the bundled designs, as data.
   - `stationery-studio` — `PAStationeryStudio`: AI prompts, keep-as-version, pictures. No UI.
   - `stationery-picker` — `PAStationeryPicker`: the page-settings group and the studio buttons.

   note-ui gets a few commented hooks at its `TODO(R4)` seam and nothing else: paint the paper,
   mount the picker, pad typed text into the design's safe area, prime print. A host opts in with
   `opts.stationery`. Without it, or without the component, PANote behaves exactly as before.
2. **The notebook stores a reference, never a design.** The field is `stationery: {id, source,
   fade?}` with `source` one of `bundled | mine | picture`. PANote's `sanitize()` is its one
   schema gate. If the field is absent the note round-trips unchanged and keeps its old save
   fingerprint. If the design is missing or still decoding, the page shows plain paper.
3. **"My templates" live in the host's own data namespace.** The store writes
   `templates/index.json` and `templates/<id>.json` through the host's checked DATA read/write
   (for the Journal, `data/notes/templates/…`). No broker kind deletes a file, so **deleting
   means leaving the index**. The file stays on disk, unlisted and never loaded. Keeping a design
   never overwrites: each keep writes a new version (`<base>-v1`, `-v2`, …).
4. **The sanitizer is the trust boundary.** Every SVG passes `PAStationery.sanitize` before
   anything draws it: bundled designs at load, My templates at load, and AI answers on arrival.
   - It is an allow-list over a parsed tree. An element outside the list, or anything that could
     run code or reach outside the document, is rejected, never repaired. A harmless attribute
     outside the list is dropped (see Amendment, 2026-10-12).
   - Its output is re-serialised from the checked tree, so the page only ever renders the bytes
     that were checked.
   - A **render-cost budget** comes on top, because a 2 KB SVG that passes the allow-list
     could hold the main thread for 49 s on every open. The budget counts every `<use>`, and
     every `url(#id)` to a mask, a clip-path or a filter. A `url(#id)` to a gradient or a pattern
     costs nothing where it is written: each shape that paints with it pays (Amendment 3). A mask,
     filter or many-shape clip is priced as an off-screen pass. An
     element with `opacity` below 1 that Chromium cannot fold into one paint is priced as a
     see-through layer (Amendment 2, 2026-10-12). How each shape is painted is priced too: its
     dashes, a gradient or a pattern on its fill or stroke (also when a parent lends it), a shape
     drawn inside a pattern tile, and the shape's outline: its segments, and many long edges on the
     same rows (Amendment 3, 2026-10-13). Masks, clip-paths and patterns may not nest effects.
     Filters have limits on steps, octaves and region. A gradient may hold at most 16 stops.
   - The worst design that gets through rasterises in about 2.5 s at 1640 device px in Chromium
     (measured 2026-10-12, Amendment 2). That design is about 4,600 plain stroked shapes off the
     pixel grid, and it is still the worst once outlines are priced. The largest design of each
     paint and outline family (dashes, gradients, patterns, pattern tiles, outlines) that gets
     through takes 1.40 s or less (measured 2026-10-13, Amendment 3 and its R13 round 1).
   - `sanitize()` never throws. Every caller shows its reason.
5. **The AI channel is the existing `chat` broker kind** (`PAChat.complete`). It is not a new
   endpoint. It inherits ADR 0002: an app's turn runs confined, and the AI can only answer. Each
   design starts a conversation labelled `Stationery · 信纸` in the Journal's chat list. That is
   visible on purpose, and it is how a tweak continues the same thread. A run that never answers
   ends after 5 minutes with a named failure.
   Each design request is sent `oneShot` (Claude, thinking off, no app contract, cancellable): ADR 0008.
6. **A picture used as paper stays sharp.** It is page-shaped, up to 2550x3300, and stays PNG
   when it has alpha. It goes up through the host's upload with `maxEdge 0` instead of PAPhoto's
   1600 px JPEG, and is read back through attach-url as a `data:image` URL only.

## Consequences

- An unlisted template file stays on disk. Reclaiming the space needs a broker delete kind, which
  is out of scope here.
- The cost budget is static. It bounds the worst case but cannot see area, so it prices every
  pass as full-page. A legitimate but heavy AI design may be rejected, with a reason that names
  the rule. The prompt states the limits so the AI can stay inside them.
- The cost figures were measured in desktop Chromium. They have not been measured in iPad
  WebKit, where they may be slower.
- AI design turns show up in the Journal's chat list. Removing them is the chat list's own delete.

## Amendment — attributes outside the list (2026-10-12)

### Context

Measured with the real CLI, through the Journal's Design with AI. One Sonnet design in 14 was
rejected with "attribute transform-origin is not allowed". The model had written
`transform="scale(0.7)" transform-origin="96.5 89.5"` on three stars. The person saw
"Rejected · 已拒绝" and paid another ~2 minutes for Try again. The prompt already said "Attributes
allowed, and no others". The other 13 designs used no attribute outside the list.

### Decision

1. **Four presentation attributes join the list, each only in a plain form.**
   - `transform-origin`: 1 to 3 words, each `left|center|right|top|bottom` or a number (sign and
     exponent allowed) with optional `px` or `%`.
   - `transform-box`: one of `content-box|border-box|fill-box|stroke-box|view-box`.
   - `vector-effect`: 1 to 4 of `none|non-scaling-stroke|non-scaling-size|non-rotation|fixed-position`.
   - `paint-order`: 1 to 3 of `normal|fill|stroke|markers`.

   Keywords match in any case, as in CSS. Words are separated by ASCII space, tab, LF or CR.
   A plain form is keywords and numbers only. It cannot hold a URL, a script or a reference to
   another element. None of the four adds an element or a draw pass, so the render-cost budget is
   unchanged. A value outside its plain form is dropped (point 2).

   These four are KEPT, not dropped, because dropping them changes the drawing. Dropping the origin
   would move each star. In Chromium, run A's three stars drawn with `transform-origin` differed by
   0 pixels from the same stars written as `translate·scale·translate`. With the origin dropped, 613 pixels
   differed and the stars moved by about 68 CSS px.

   No other attribute was added. Only `transform-origin` was measured in a real answer. The other
   three are its usual companions, and dropping them also changes the drawing. Every other
   attribute outside the list is dropped (point 2).

   The same plain-form rule now also covers three attributes that were already on the list:
   `filter`, `mask` and `clip-path` are kept only as `none` or one `url(#id)`. The cost budget
   sees an effect only through `url(#id)`. A CSS function in its place is an off-screen pass the
   budget cannot price: `filter="blur(30px) …"` ×80, 1 KB, drew for 51 s in Chromium. A value in
   any other form is dropped. All 36 real and bundled designs use only `url(#id)` there.

2. **A harmless attribute outside the list is DROPPED, not rejected.** Every attribute gets one of
   three verdicts, checked in this order:
   1. **Rejected (the whole SVG).** This applies to ANY attribute, on the list or not:
      - a name that starts with `on`, in any case (an event handler);
      - a name with a namespace prefix (`xlink:href`, `xml:base`, `xmlns:*`);
      - `style`, `src` or `srcset`, in any case;
      - `href` anywhere except `<use href="#id">`, and `href` in any other case (`HREF`, `Href`);
      - `xmlns`, unless it is the SVG namespace on the root;
      - a value that contains any of: `url()` pointing at anything except `#id`; `javascript:`,
        `vbscript:` or `data:`; `://`; a special scheme a URL parser completes without slashes
        (`http:`, `https:`, `ftp:`, `file:`, `ws:`, `wss:`); a value that starts with `//`; a
        backslash; a control character (C0 except tab, LF and CR; DEL; C1). The scheme checks run
        on the value with its tabs, LFs and CRs removed, because a URL parser drops them:
        `java&#9;script:` is `javascript:`. A scheme counts only where a URL parser would read one,
        at the start or after a character that cannot be part of a scheme. So `Metadata: v1` is
        text, but `File: weekly page` still rejects as `file:`.
      - an `id` that an earlier element already has. The browser draws the FIRST element with that
        id, so a later twin could hide the real cost from the budget.

      - more than 64 attributes on one element. Real designs use at most 10. The cap bounds the
        parser's duplicate-attribute check, which is quadratic per element.

      Unchanged: an element outside the list, text, a DOCTYPE, an entity, CDATA or a processing
      instruction is still rejected, and so is a design over the cost budget.
   2. **Dropped.** An attribute that passes every rule in (1) and is not on the list. Also any
      attribute in point 1 (the four, and `filter`, `mask`, `clip-path`) whose value is not in its
      plain form.
   3. **Kept.** Everything on the list.

   The danger rules run first, on every attribute. An attribute is dropped only after it has
   passed them. So a dangerous attribute rejects the design whether it comes before harmless ones,
   after them, or deeper in the tree.

   The danger rules are this exact list, not a promise to catch every hostile input. An input that
   is hostile but not on the list is dropped. A dropped attribute is never rendered, so the safety
   of the output does not depend on the list (point 3).

3. **Why dropping is safe.** The output is re-serialised from the checked tree (point 4). A dropped
   attribute is removed from that tree before the cost budget measures it and before the output is
   written. It is not in the bytes the page renders. Dropping widens which INPUTS are accepted. It
   does not widen what can be RENDERED, which is still built only from the list.

4. **Why the dangerous set is still rejected, not dropped.** An answer that tries to run code or
   reach outside the document is evidence that its source is hostile: a poisoned picture, an
   injected prompt, or a tampered template file. Removing the attack and keeping the rest would
   still trust that source.

5. **Why "never repaired" no longer covers attributes.** That rule exists so the page never guesses
   at what an author meant. Here, the preview draws exactly what was kept, and Keep saves exactly
   the previewed SVG. The person sees the result of the drop before keeping it. A rejection costs
   ~2 minutes and a Try again.

6. **`sanitize()` also returns `dropped`**, the names of the attributes it left out. The picker
   shows nothing for it (minimal UI). Tests use it, and every bundled design must drop nothing.

### Measured

- **Replay.** Every saved real reply from 2026-10-12 was replayed: 14 distinct Sonnet SVGs.
  - Old sanitizer: 1 rejected.
  - New sanitizer: 0 rejected, nothing dropped.
  - The 13 that passed before give byte-identical output.
  - Run A keeps all 342 elements and its 3 origins.
- **Render cost** (Chromium, the Journal's raster path, 1640 px). The design (rejected since
  Amendment 2: it has opacity over fill and stroke) was 48 full-page
  shapes × 95 `<use>`, about 4,800 drawn and just inside the cost budget.
  - Without the four attributes: 12.8–13.1 s.
  - With all four on every shape: 12.3–12.9 s.
  - So the four add no measurable cost.
- **Real end-to-end** (2026-10-12; `test/helpers-web.mjs` throwaway server, real `claude`,
  Journal model `claude`, oneShot). Six briefs, each sent with the old prompt and with the new
  prompt (which lists the four attributes): 12 designs, 86–164 s each.
  - Every reply was replayed through both sanitizers: 0 rejected by either, nothing dropped, and
    the output was byte-identical.
  - No reply used any of the four attributes: in these 6, listing them did not lead Sonnet to use them.
  - Across all 26 real designs: the old sanitizer rejected 1 (about 4%), the new one 0.

### Review (R13, 2026-10-12)

A fresh reviewer, given only the rules and the diff, found these. All are fixed here and pinned by
tests in `test/stationery-sanitize-attrs.test.mjs` and `test/stationery-sanitize.test.mjs`.

- **The first draft's external-URL regex took quadratic time** (`[a-z][a-z0-9+.-]*://`). A valid
  280 KB minified path took 10.7 s on the main thread, and 290 KB of letters took 46 s. The checks
  are now linear: `includes('://')` and fixed-prefix regexes. Both inputs now take under 3 ms.
- **Prototype lookups.** `SHAPED[name]` found `constructor`, so `constructor="…"` was kept in the
  output. `ENT[e]` (already on main) decoded `&constructor;` to `function Object() {…}`. Both
  objects now have no prototype. A test pins that every attribute in the output is on the list.
- **Duplicate ids** (already on main) let a design pass the cost budget that it should fail. They
  are now rejected. None of the 36 real and bundled designs has one.
- **Tripwire gaps** (already on main or new in the draft): `java<TAB>script:`, `https:` without
  slashes, C1 and DEL control characters, and `srcset`. They now reject.
- `words()` split on a no-break space. It now splits on ASCII whitespace only.

After these fixes, the 36 real and bundled designs were replayed again: 0 rejected, all
byte-identical to main's output, and the slowest check took 3 ms.

Round 2 (a new fresh reviewer, given the fixed diff) said NOT BLOCKING: every round-1 fix held
and no real design was newly rejected. It found these, all fixed here:

- **High, already on main:** CSS functions in `filter` and `mask` bypassed the cost budget
  (51 s, 9.2 s). Point 1 now keeps them only as `none` or one `url(#id)`.
- **Medium, already on main:** 40,660 attributes on one element took 2.8 s, because the
  duplicate-attribute check is quadratic. Point 2 now caps an element at 64 attributes.
- **Low:** valid CSS forms of `transform-origin` (`CENTER`, `50PX`, `1e2`, `+5`) were dropped. They
  are now kept.
- **Low:** `Metadata: v1` rejected as `data:`. Schemes now count only at a boundary.
- **Nit:** a form-feed separator in `words()` could never be reached (the control-character rule
  rejects form feed first), so it was removed.

After round 2, the 36 designs replayed again: 0 rejected, byte-identical, and the slowest check took
4 ms. In Chromium, run A's stars still differ by 0 pixels from the explicit form.

### Consequences

- The danger list errs toward rejecting. Prose in an attribute outside the list that reads like a
  special scheme (`File: …`, `http: …`) rejects the design, although that attribute would only
  have been dropped. No real design has done this. A false rejection costs one Try again.
- A dropped attribute can change how a design looks. For example, dropping `display="none"`
  shows a shape the model meant to hide. The preview shows this before Keep. Try again is the
  remedy, as it was before.
- `transform-origin` has not been measured in iPad WebKit. If WebKit ignores it, the shape is
  drawn as if the attribute were dropped. There is no safety impact.
- **Found while measuring, fixed in Amendment 2.** The cost budget prices `opacity` together with
  `stroke` on a full-page shape as one element. In Chromium, 48 such shapes × 95 `<use>` (within
  budget, none of the four attributes) took 12.5 s at 1640 px. Each attribute alone took about
  1.3 s. The budget's "worst design ≈ 1.4 s" therefore does not hold for that combination. It is
  a separate change.
- **Same prototype-lookup class, outside the sanitizer:** `AUDIENCES[t.audience]` and
  `REG[ref.source]` in `stationery-ui`, and `STATIONERY_SRC[r.source]` in `note-ui`. A template
  or notebook whose audience or source is `constructor` passed these checks. Fixed in the
  follow-up below.

## Follow-up — prototype (原型) lookups outside the sanitizer (2026-10-12)

### Context

A lookup in a plain `{…}` literal finds the members of `Object.prototype`. So a value such as
`constructor`, `toString`, `valueOf` or `__proto__` passes a membership check like `AUDIENCES[x]`.
Every table in the stationery code was listed, in all five `web/stationery-*.inline.html` files and
in PANote's stationery gate. Besides `SHAPED` and `ENT` (fixed in Review, above), five tables are
read with `[ ]`:

- Three are looked up by untrusted text, from a template file or a notebook.
- `EFFECT` and `RESOURCE` are looked up by an element name that `ELEMENTS` has already admitted.
  No input reaches them with a prototype name. They are made prototype-free for consistency.

| Table | Looked up by | Before the fix |
|---|---|---|
| `AUDIENCES` (`stationery-ui`) | a My-templates file's `audience` | `audience: "constructor"` was accepted and loaded |
| `REG` (`stationery-ui`) | a notebook reference's `source` | `source: "constructor"` threw a TypeError in `has`, `paint`, `inset` and `prime` |
| `STATIONERY_SRC` (`note-ui`) | the notebook's `stationery.source` | `source: "constructor"` was kept, then reached `REG` |
| `EFFECT`, `RESOURCE` (`stationery-sanitize`) | an admitted element name | no input reaches them with a prototype name |

The notebook can be written by the Journal's confined AI turn (ADR 0002), so the `note-ui` gate
could be reached from model output.

### Decision

1. Every one of these tables has no prototype: `Object.assign(Object.create(null),{…})`, as `SHAPED`
   and `ENT` already were. No lookup site changed.
2. The two schema gates also require a string. A lookup turns its key into a string, so
   `audience: ["any"]` and `source: ["bundled"]` passed and were stored as arrays. Now
   `validTemplate` (`stationery-ui`) rejects a non-string `audience`, and `validStationery`
   (`note-ui`) drops a non-string `source`. `resolve()` only looks a reference up, so it is
   unchanged: the notebook schema belongs to PANote (Decision, point 2).
3. `note-ui` changed two lines and did not grow (R4).

### Tests

- `test/stationery-proto-keys.test.mjs`:
  - gate 1 (`AUDIENCES`) through the store's `loadMine`, including an `audience` that is an array;
  - gate 2 (`REG`) at `has`, `paint`, `inset` and `prime`;
  - the invariant, over every stationery source (PANote's stationery gate was scanned here too, until
    ADR 0015 moved it to note-ui's own scan). No UPPER_CASE table
    assigned a plain `{…}` or `Object.assign({},…)`, at any place in a declaration, is indexed with
    `[ ]` or tested with `in`. A lowercase name is not scanned, because the code names its tables in
    UPPER_CASE. A synthetic source pins each shape the scan finds.
- `test/stationery-panote.test.mjs`:
  - PANote's `sanitize()` drops each such `source`, and a `source` that is an array;
  - the whole path (R6): a notebook read from disk, then PANote's `sanitize()`, then `drawPaper`
    with the real PAStationery, opens on plain paper.
- The gate tests use every own name of `Object.prototype` (`PROTO_KEYS` in
  `test/helpers-stationery.mjs`). `test/stationery-sanitize-attrs.test.mjs` uses two subsets:
  - attribute names that start with a letter (an attribute name must);
  - entity names of at most 12 characters. `decodeEnt` reads no more than 12, so a longer name is
    rejected as a bare `&` whatever `ENT` holds, and would prove nothing. The test checks that the
    reason names the entity.
- Mutation tests:
  - each gate: the old plain literal is put back, and the same value gets through, or `REG` throws;
  - each string check: removed, and the array gets through;
  - the whole path: with both old literals, painting the page throws a TypeError; with only the
    old `STATIONERY_SRC`, the page still paints, because `REG` is the second guard;
  - the invariant: every prototype-free table is turned back into `{…}`, and then into
    `Object.assign({},{…})`. Both times the invariant names every table. It named seven at first.
    Amendment 2 (below) added `SHAPES` and `GROUPS`, keyed by an element name like `EFFECT`, which
    were made prototype-free when Amendment 2 was merged. ADR 0015 then moved `STATIONERY_SRC` to
    note-ui's own scan. So this scan now names eight.
  - `EFFECT` and `RESOURCE` have no behaviour-level mutation, because no input reaches them. Only
    the invariant pins them.
- Against the code before this fix, 8 of the tests fail. 6 fail on the bug itself. The other 2 are
  mutation tests whose target text does not exist there yet.

### Review (R13, 2026-10-12)

A fresh reviewer, given only the rules and the diff, said NOT BLOCKING. It found these, all fixed
here:

- **Test passed for the wrong reason:** 8 of the 12 prototype names are longer than `decodeEnt`
  reads, so the entity test passed for them with or without the fix. The test now uses only names
  of at most 12 characters and checks the reason.
- **The invariant missed some shapes:** `Object.assign({},…)`, a table not first in its declaration,
  and `x in TABLE`. The scan now finds all three, and the claim names the lowercase limit.
- **Wrong citation:** the code cited the Amendment, not this Follow-up.
- **Arrays passed both schema gates:** Decision, point 2.
- **No whole-path test:** added (Tests, above).
- **Wording:** "five tables looked up by untrusted text" contradicted "no input reaches them" for
  `EFFECT` and `RESOURCE`. Reworded (Context, above).
- **Incomplete list of unfixed sites:** see Consequences.

### Consequences

- **Found while listing, NOT fixed here, because none is stationery code.** The rest of `note-ui`
  was not checked for this class, beyond the sites below. Each has the same fix and is a separate
  change. **Fixed in ADR 0015 (2026-10-13)**, which checked all of `note-ui` and found more.
  - `VALID_TPL[o.template]`, PANote's notebook gate: it keeps `template: "constructor"` from a
    notebook. `RULED_TPL` and `MARGIN_TPL` then treat that page as ruled and draw a margin.
  - `undoStacks[page().id]` and `redoStacks[page().id]`: a page's id is not checked on load. On a
    page whose id is `constructor`, `curUndo()` returns the `Object` function, so `pushUndo` throws
    a TypeError on every stroke on that page.
  - `imgCache[im.path]`: a path of `constructor` returns the `Object` function as the cached image,
    and a path of `__proto__` replaces the cache's prototype.
  - Lower impact: `HTML_DROP[node.tagName]` and `HTML_TAGS[node.tagName]`, where a tag such as
    `<svg><constructor>` is dropped instead of unwrapped; and `LOAD_NOT_FOUND[code]`, where a broker
    code of `constructor` reads as absent.

## Amendment 2 — see-through layers in the cost budget (2026-10-12)

### Context

Amendment 1 found that the cost budget priced a full-page shape with `opacity` and `stroke` as one
element. Reproduced in Chromium (Playwright 1.58) on the Journal's raster path, `PAStationery.thumb`
at 1640 device px, median of 3. Every design is 48 full-page rects × 95 `<use>` (about 4,800 drawn),
inside the old budget, and every one was accepted:

| Attributes on each rect | Time |
|---|---|
| `fill` only | 1.23 s |
| + `opacity` | 1.35 s |
| + `fill-opacity` | 1.36 s |
| + `stroke` | 1.30 s |
| + `transform` | 2.15 s |
| + `opacity` + `transform` | 1.35 s |
| + `stroke` + `transform` | 2.53 s |
| + `opacity` + `stroke` | 12.46 s |
| + all three | 12.84 s |

The same class, also accepted by the old budget:

- The stroke set on the parent, not on the shape: lent by a `<g>` 11.8 s, by the `<use>` 11.7 s.
- `line`, `circle`, `path`, `polyline` with `opacity` and `stroke`: 10.8–12.9 s.
- `opacity` on a `<use>` over two fill-only shapes, 1,200 times: 3.3 s (plain: about 0.65 s).

Not slow, because Chromium folds the opacity into the one paint:

- `fill="none"` + `stroke` + `opacity`: 72 ms.
- `fill-opacity` + `stroke-opacity` + `stroke`: 1.38 s.
- `opacity` with `stroke="none"` or `stroke-width="0"`: 1.32–1.35 s.
- `opacity` on a group over ONE fill-only shape, 1,660 times: 485 ms.

### Decision

1. **A see-through layer (半透明图层) is priced at `LAYER_COST` = 10 elements.** Chromium folds
   `opacity` below 1 into the paint only on a shape with ONE paint (fill only, or `fill="none"` and
   a stroke). Every other element with `opacity` below 1 is drawn into an off-screen layer (离屏图层),
   then blended onto the page. So these are see-through layers:
   - a `<g>`, `<svg>` or `<use>` with `opacity` below 1, whatever it holds;
   - a shape (`path rect circle ellipse line polyline polygon`) with `opacity` below 1 whose fill
     AND stroke both paint;
   - a shape with `opacity` below 1 and a `vector-effect` attribute.

   A shape with `opacity` below 1 and one paint is NOT a layer, also with a transform, `x="0.3"`,
   `transform-origin`, `paint-order`, a dash or a round join (measured folded: 0.18–1.48 s for
   48 × 95). The 10 is added on top of the element's own 1, and is counted again on every `<use>`
   or `url(#id)` path that draws the element.
2. **Paint is inherited, as in SVG.** The budget carries fill and stroke down every path:
   - from a parent to its children;
   - from a `<use>` to the copy it draws;
   - a `url(#id)` target (mask, pattern, gradient) inherits from its own ancestors, not from the
     element that references it.

   Only the value `none` stops a paint: any case, with only CSS whitespace (space, tab, LF, CR)
   around it. Any other value counts as a paint, including `inherit`, `transparent`, and a value the
   browser would ignore. A no-break space is not CSS whitespace: Chromium reads `&#160;none` as an
   invalid value and paints the default black fill (11.6 s), so the budget counts it as a paint.
   `opacity` counts as below 1 unless its value is a plain number of 1 or more, so `50%` counts as
   below 1. The rule counts some layers that Chromium does not make: `stroke-width="0"`, and a
   group over one fill-only shape (1,660 of them took 485 ms). It missed no layer in any case
   measured, including those the R13 review built to miss one.
3. **Why 10 and not a full pass (100).** Measured at 1640 px: one full-page layer costs about 2.4 ms,
   one full-page element 0.25–0.5 ms, one mask pass 15–30 ms. So a layer costs about 10 elements.
   Real AI designs use layers often, up to 82 in one design. At 100 per layer, 6 of the 26 real AI
   designs would be rejected. At 10, the most costly real AI design costs 2,431 of 5,000.
4. **The studio prompt is unchanged.** No real design comes near the budget because of layers, and
   a prompt change would change what the AI draws.

### Measured (after)

- Now rejected: every design above that took 3.3 s or more, including the stroke lent by a `<g>`
  or a `<use>`, and every design in the R13 review below.
- Still accepted: `fill="none"` 73 ms, `fill` only 1.30 s, `fill-opacity` + `stroke-opacity` 1.4 s.
- The largest accepted design of each of 9 layer families takes 0.81–1.12 s. Examples: 383 rects
  with opacity over fill and stroke (0.98 s); 10 × 40 nested `<g opacity>` round one rect (1.06 s);
  384 `<use opacity>` over a rotated rect (0.98 s); 141 groups with opacity over two rects that
  have opacity over fill and stroke (1.12 s).
- 36 designs replayed (26 real AI, 10 bundled), in Node and in Chromium: 0 rejected, output
  byte-identical to before, slowest raster under 0.4 s (bundled cream-letter). The most costly is the
  bundled rose-corners: 4,204 of 5,000 (4,174 before).
- Tests in `test/stationery-sanitize.test.mjs`: the rejected designs, the accepted ones above, and
  mutations that remove the layer price, the inherited stroke, the default and inherited fill, a
  group's own layer, `vector-effect`, percent opacity, or the CSS-whitespace rule around `none`.
  Each mutation lets its rejected design through.
- Checking stays linear: the slowest real design takes 4 ms to check; the slowest hostile input
  (a 4,990-hop chain alternating fill and stroke) takes 16 ms, 10 ms before.

### Consequences

- **The worst design that gets through takes about 2.5 s, not the 1.4 s stated before.** The cause
  is not a layer. It is about 4,600 plain full-page shapes with a stroke whose edges are off the
  pixel grid (`x="0.3"`, or a scale or rotate transform): 2.1–2.5 s. Chromium anti-aliases (抗锯齿)
  those edges, which roughly doubles the cost of each shape. `x="0.3"` with no transform costs the
  same as `transform="translate(0.3 0.3)"`. Lowering `MAX_COST` to about 2,800 would bring this
  back to about 1.4 s, but would reject the bundled rose-corners (4,204). That is a separate decision.
- **Found while measuring, NOT fixed here. Fixed in Amendment 3 (2026-10-13).** Four costs the
  budget does not price. Each design
  below is accepted by the budget before AND after this amendment. Together they are one
  separate change:
  - `stroke-dasharray`. One full-page rect with `stroke-dasharray="0.01"` took 455 ms. Ten such
    rects (1 KB) took 4.5 s, and the cost grows linearly, so a design inside the budget could hold
    the page for minutes. At `0.001` Chromium does not dash, and the rect took 2 ms. Long paths are
    not this problem: 10,000 segments drawn 10 times took 10 ms.
  - A gradient fill. It costs about 6 ms per full-page shape, but the budget prices a gradient
    reference as its few elements. 1,248 full-page rects with `fill="url(#lg)"` are accepted and
    took 7.7 s.
  - A pattern or gradient fill lent by a parent. `<g fill="url(#p)">` is priced once, but Chromium
    fills every shape inside with it. With a pattern, 96 `<use>` of 48 rects are accepted, and 10
    of them took 10.3 s (about 99 s for all 96). With a gradient, 98 are accepted, and 10 took 3.0 s
    (about 29 s for all 98).
    Found by the R13 review (pattern) and by its follow-up probe (gradient).
  - See-through fills inside a pattern tile. A full-page pattern holding 400 full-page rects with
    `fill-opacity="0.5"`, used by 9 full-page rects, is accepted and took 5.5 s; with opaque rects,
    1.1 s. It is not a layer: `opacity` and `fill-opacity` cost the same, and the cost follows the
    area painted. Found by R13 round 2.
- Measured in desktop Chromium only. iPad WebKit may make layers in different cases.

### Review (R13, 2026-10-12)

Round 1: a fresh reviewer, given only the rules and the diff, said BLOCKING. Each finding below is
fixed here, and round 2 added the tests that pin them, except the pattern fill lent by a parent
(listed above as not fixed; fixed in Amendment 3).

- **Blocking: single-paint layers were missed.** The first draft priced a layer only when the
  content painted more than once. Chromium folds the opacity only when nothing sits between it and
  the one paint. 40 nested `<g opacity>` round one fill-only rect, × 115 `<use>` (2.8 KB), was
  accepted and took 12.2 s. Also missed: a `<g opacity>` round one rect with its own opacity
  (2.9 s), a nested `<svg opacity>` (3.0 s), `<use opacity>` over a rotated rect (4.2 s), and a
  stroke with `opacity` and `vector-effect` (3.6 s). Fixed by Decision 1: every `<g>`, `<svg>`
  and `<use>` with opacity below 1 is a layer, and so is a shape with `vector-effect`.
- **Should-fix, tests:** no test pinned the default black fill (a shape with no `fill` attribute),
  and none pinned `opacity="50%"`. Both now have a rejected design and a mutation.
- **Nits, fixed:** the CSS whitespace class was written out twice. It is now one constant, `WS`,
  used for the attribute words and for `none` (R3). `LAYER_COST` is exported next to `PASS_COST`.
- The reviewer found no regression: nesting, depth, passes and loop detection are unchanged, and
  checking stays linear.

Round 2: a new fresh reviewer, given the fixed diff, said NOT BLOCKING. It ran 115,000 random
designs through the old and the new sanitizer. Nothing rejected before was accepted, and the
output of every design both accepted was byte-identical. It found these, and both are handled here:

- **Should-fix, tests:** three parts of the rule could be deleted with every test still passing.
  Each now has a rejected design in `test/stationery-sanitize.test.mjs`:
  - the paint a `url(#id)` target takes from its own ancestors: a mask whose content takes its
    stroke from the mask's parent, 29 references, 3.7 s; a mutation test also covers it;
  - `<svg>` as a group: 4 nested `<svg opacity>` × 498 `<use>`, 4.6 s; a mutation test also
    covers it;
  - every shape, not only `<rect>`: path, circle, ellipse, line, polyline and polygon each with
    opacity over fill and stroke, 48 × 95 (path 11.1 s, ellipse 10.8 s, polygon 11.3 s).
- **Should-fix, gap older than this change:** see-through fills inside a pattern tile (5.5 s). It is
  added above as the fourth cost not priced.

## Amendment 3 — how a shape is painted, in the cost budget (2026-10-13)

### Context

Amendment 2 found four costs that the budget did not price (Amendment 2, Consequences). Each design
below was accepted by the budget. All figures were measured in Chromium (Playwright 1.58) on the
Journal's raster path, `PAStationery.thumb` at 1640 device px. A figure with "~" was timed on a
tenth or less of the `<use>` elements and scaled up.

- **Dashes (`stroke-dasharray`, 虚线).** One full-page rect with `stroke-dasharray="0.01"` took
  0.5 s. Ten such rects (1 KB) took 5.0 s.
  - The cost grows with the number of dashes. When a dash is narrower than a device pixel, the cost
    also grows with the number of device rows that the stroke spans, that is, with the stroke width.
  - The worst case measured is a near-level line (slope 0.001), stroke width 1, dashes 0.01 long:
    11.9 µs a dash, 5.9 µs for each of its 2 rows. A level line costs half of that. Vertical dashes
    and curved dashes cost 0.2–0.7 µs. A dash 1 device px long or longer costs about 0.25 µs.
  - A near-level line 10 wide with dashes 0.01 long took 2.1 s (about 50 µs a dash).
  - `stroke-dasharray` is inherited. The length of a path is not bounded by the page: one arc
    command can draw a whole ellipse.
  - Past about a million dashes in one path, Skia does not dash at all (`0.001` on a full-page rect:
    2 ms). The budget does not rely on this, because WebKit may not do the same.
- **Gradient fills (渐变).** A gradient over the whole page costs 6.6 ms with 2 stops, about 9 ms with
  5 stops or more, and up to 11.4 ms (1,000 stops with `stop-opacity`). The cost follows the area
  painted: a 100x100 rect costs 0.1 ms. A stroke costs the same per area (a 2,000-wide stroke over
  the page: 6.7 ms). 1,248 full-page gradient rects were accepted and took 8.1 s.
  - **Corrected in R13 round 1:** with evenly spaced stops, each stop adds about 0.02 µs to each
    draw. With uneven offsets, each stop adds about 0.47 ms to each full-page draw. 4,000 stops at
    random offsets on 22 full-page rects were accepted and took 42 s; the 2-stop control took
    145 ms. The real designs hold 211 gradients, with at most 4 stops each.
- **Pattern fills (图案).** A pattern over the whole page costs about 22 ms, whatever its tile
  (8x8, 80x80, 2x2 or the whole page: 22.4–23.6 ms). A very small tile costs less. The budget paid
  one pass where `url(#id)` was written, so a `<g fill="url(#p)">` paid once for every shape it
  fills. 48 rects x 96 `<use>` inside such a `<g>` were accepted and took ~102 s. The same with a
  gradient: 48 x 98 accepted, ~31 s. A pattern stroke lent the same way: ~102 s.
- **Shapes inside a pattern tile.** The tile is drawn again for every shape that paints with the
  pattern. A full-page shape inside the tile costs 0.5 ms when opaque and 1.9 ms when see-through.
  `fill-opacity`, `opacity`, a colour with alpha and `stroke-opacity` all cost the same. A full-page
  tile of 400 see-through rects, used by 9 rects, was accepted and took 6.0 s.
  - This is not true of the other off-screen surfaces (离屏表面). Inside a mask, a group layer or a
    filtered group, see-through content costs the same as opaque content (0.29–0.64 ms for each
    full-page rect). On the page itself, see-through costs no more than opaque either.
- **Outlines (轮廓), found in R13 round 1.** Every shape was priced as 1, whatever its outline.
  - Many segments, drawn many times: one path of 25,000 tiny subpaths, drawn by 2,490 `<use>`
    (283 KB), was accepted and took 22.9 s; with one subpath it took 19 ms. A stroked segment costs
    about 1–4 µs each time it is drawn (2.5 µs for a tiny curve, 4 µs 20 wide; a wider stroke costs
    more, which the rows below cover), a filled one about 0.1–0.2 µs.
  - Many long edges on the same rows: Chromium's fill cost grows with the square of the edges that
    share a row. One filled zigzag of 4,000 page-tall edges took 12.8 s, 2,000 edges 2.0 s, 1,000
    edges 0.45 s (worst at about 2 to 5 edges per device pixel). As 0.38 ns for each
    (edges on a row)^2 x rows, the worst measured is 4,000 edges. One polygon of 8,000 page-tall
    points took 10 s. A stroked page-tall zigzag of 1,000 edges took 0.42 s.
  - The same edges as separate elements are cheap: 1,000 thin page-tall rects took 7 ms.

### Decision

1. **A new term, `paint`, is added to the cost.** A design gets through when
   `elements + passes × PASS_COST + layers × LAYER_COST + paint ≤ MAX_COST` (5,000). Each new price
   is set from the worst cost measured, at about 0.3 ms a unit, so that the largest design of each
   family that gets through takes about 1.5 s or less. Each shape, each time it is drawn, adds:
   - **a gradient** on its fill or stroke: `GRAD_COST` = 55 × the share of the page that the shape's
     box can cover. A full-page gradient pays 55 units (16.5 ms; the worst measured with 16 stops is
     16.2 ms, radial with uneven stops and `stop-opacity`; 40 before R13 round 1). The box of a
     stroke reaches 2 stroke widths out, because a miter join can reach that far;
   - **a pattern** on its fill or stroke: one pass (`PASS_COST`, 100) plus the cost of drawing the
     most costly pattern tile in the document. This replaces the pass that was paid where `url(#id)`
     was written. A `url(#id)` to a gradient or a pattern now costs nothing where it is written;
   - **inside a pattern tile:** `TILE_COST` = 6, on top of the shape's own 1 (7 units = 2.1 ms; the
     measured cost is 1.9 ms);
   - **dashes:** the number of dashes × max(2, the device rows that the stroke spans) ÷ `DASH_ROWS`
     (45). One dash-row is priced at 6.7 µs (the worst measured is 5.9 µs). The number of dashes is
     the shape's length × n ÷ (2 × S), for n dash lengths that add up to S. With `vector-effect`, the
     rows come from the stroke width in page px, and the dashes from the stretched path;
   - **its outline** (R13 round 1), beyond what the shape's own 1 covers (a stroked rounded rect over
     the whole page): 0.002 units for each segment it fills and 0.02 for each segment it strokes
     (`FILL_SEG`, `STROKE_SEG`: 0.6 and 6 µs), and one unit per 650,000 (`GEOM_PAIRS`; 0.46 ns each)
     of x × r. Here x is the most edges that can cross one scanline (a line once, a quadratic or an
     arc twice, a cubic 3 times), and r is the rows that all edges can span: their length in device
     px, at most a page each, plus one row for each straight edge that Skia may cut a curve into (64
     a curve, 256 an arc). The sum of (edges on a row)^2 over all rows is never more than x × r. For
     a stroke, exactly: x is 2 × the path's crossings + 2 for each segment (its two sides, and a
     join or cap per segment); the length is 2 × the path's length + 4 stroke widths for each segment
     (a miter join can reach 2 widths out); the edges are 2 × the path's edges + 16 for each segment.
     The free share, `FREE_PAIRS`, is 20 crossings on every row of the page: 20² × 2,122 ≈ 849,000
     pairs, about 0.39 ms, which a shape's own 1 unit covers. A 1-wide stroked rounded rect over the
     whole page uses about 315,000 of it.
2. **Coarse paint kinds, not server ids.** The fill and the stroke each have one of four kinds:
   none, solid, gradient or pattern. The budget never carries a server's id. A shape that paints
   with a pattern pays for the most costly tile in the document, whichever pattern it uses.
3. **Inheritance (继承).** Fill, stroke, `stroke-width` and `stroke-dasharray` are inherited in
   SVG. For each element, the budget keeps the largest value that each can have along ANY path that
   draws the element (任一路径上的最大值), never one path's value:
   - a value comes down the tree, and from a `<use>` to the copy it draws;
   - a `url(#id)` target, such as a pattern or a mask, takes these values from its own ancestors;
   - **an own fill or stroke that is not `none` or `inherit` also counts what it inherits** (R13
     round 1). Chromium ignores a value it cannot read (`x`, an empty value, `context-fill`) and
     paints the inherited one, so a plain colour under a lent pattern is priced as the pattern: an
     over-count, never an under-count. The paint bits of Amendment 2 already count any value other
     than `none` as a paint, so they needed no change.

   The memo stays per (element, paint bits), so it holds at most 4 entries per element. The largest
   values are found in one pass over the elements in reference order (a topological order, 拓扑顺序).
   So checking stays linear.
4. **The size of a shape** comes from its own geometry: a rect, circle, ellipse or line, the points of
   a polyline or polygon, or the path data. A curve is never longer than its control polygon. An arc
   is never longer than its whole ellipse, 2πR, where R is the larger radius after SVG scales radii
   that are too small. An arc also stays within 2R of its start. Chromium's own `getTotalLength()`
   and `getBBox()` were compared with these bounds for all 6,603 shapes in the 36 designs below, and
   for hand-made paths with every command: no bound was ever below Chromium's value.
5. **Stretch (拉伸).** A transform can make a shape and its stroke bigger. For each element, the
   budget keeps the most that its coordinates can be stretched along any path. Each transform step
   counts its largest singular value (最大奇异值), and never less than 1. A `viewBox` that scales up
   counts too: the root's onto the page, and that of a nested `<svg>` or a pattern. A `<use>` that sets
   `width` or `height` counts as an unbounded stretch. A shrink is never counted, so the bound holds
   whichever steps Chromium honours. A box grows with the square of the stretch, and a stroke's rows
   grow with the stretch. With `vector-effect`, the dashes are cut on the stretched path, so the
   number of dashes grows with the stretch too.
   - **A pattern's tile takes the stretch of the shapes that paint with it** (R13 round 2). SVG draws
     a tile in the space of the shape that paints with the pattern, and that shape can be stretched
     below the element that writes `url(#p)`: a `<g fill="url(#p)">` over a scaled child, a nested
     `<svg>` that scales up, or a scaled `<use>`. So, after the first pass, every pattern takes the
     largest stretch of any shape that paints with a pattern kind (fill or stroke), and a second pass
     carries it to all that the patterns reach. This is sound: a shape inside a tile cannot paint with
     a pattern (Decision 7), so the second pass cannot raise that largest stretch; and a stretch only
     grows along a path, so each value the second pass reaches is the larger of its first-pass input
     and what the stretched patterns pass down. It is coarse, like the tile price (Decision 2): every
     pattern takes the same largest stretch. Both passes read each element's own values once.
   - The same question for the other `url(#id)` targets was measured, and needs no change. A
     gradient is priced at the shape that paints with it, by that shape's own box and stretch: lent
     by a `<g>` or a `<use>` it costs the same as the shape's own fill (6,726 and 6,725 for 120 small
     rects scaled up 10 times; 0.79 s both, with `objectBoundingBox` or `userSpaceOnUse` units). A
     mask or a clip-path is not inherited: SVG draws it in the space of the element that names it,
     so that element's stretch is the right one (a dashed-line mask on a `<g>` over a scaled child:
     cost 1,879, 107 ms; on the scaled element itself: cost 13,127, 0.88 s).
6. **A value that the budget cannot read is the worst case, never a guess.** Examples are a length with
   a unit other than px (`0.0025mm`), a percent, a transform that the budget cannot parse, and path
   data with an error. Unreadable geometry counts as a full page with an endless length.
7. **A pattern painted inside a pattern tile is a pattern inside a pattern**, so the nested rule
   rejects it. This holds also when the tile's shapes inherit the pattern from the tile's own
   ancestors.
8. **A gradient may hold at most 16 stops** (`LIMITS.gradientStops`, R13 round 1), the way a filter
   may hold at most 8 steps: a gradient with more is rejected. With 16 uneven stops a full-page draw
   costs up to 16.2 ms, which `GRAD_COST` covers. The studio prompt now lists this limit next to the
   filter limits, because it is a rule the AI must know to stay inside the budget.
9. **No other new rule is in the studio prompt.** The 26 real AI designs pay at most 314 units for
   paint and outlines, and cost at most 2,330 of 5,000 in all. Their most complex path has 57
   segments. The AI needs no other rule to stay inside the budget, and a new line in the prompt
   would change what the AI draws.
10. The cost code moved to `web/stationery-cost.inline.html` first, in a separate commit with no
   change in behaviour (R4, R8). The sanitizer carries it above its own script. In R13 round 3 its
   readers moved to `web/stationery-geometry.inline.html` the same way (no change in behaviour);
   the budget carries them above its own script.

### Measured (after)

- Now rejected: every design in Context that took 1.5 s or more, and each rejected design in the tests below.
- The largest accepted design of each new family, found by a binary search on its size, and timed
  on the real raster path at 1640 px (median of 3):
  - Dashes: near-level lines with dashes 0.01 long, 2 lines: 0.95 s. A 4-wide near-level line,
    dashes 1/68 long: 0.74 s. A 10-wide full-page rect, dashes 0.2 long: 0.12 s. Dashes 0.5 long on
    28 full-page rects: 24 ms. Ordinary dashes `4 6`, width 2: 145 full-page rects, 19 ms.
  - Gradients (after R13 round 1): 89 full-page rects with a 2-stop gradient, 0.58 s. 88 full-page
    rects with 16 uneven stops: radial with `stop-opacity` 1.40 s, linear 1.29 s. 88 rects with a
    2,000-wide gradient stroke: 0.58 s. 44 rects with a gradient fill and stroke: 0.58 s. 89 small
    rects scaled up 10 times: 0.58 s.
  - Patterns: 45 full-page rects, 0.99 s. A 2,000-wide pattern stroke lent by a `<g>`, 45 rects:
    1.00 s.
  - Pattern tiles: a full-page tile of 58 see-through rects, used by 9 rects: 1.06 s. A tile of 20
    see-through rects, used by 20 rects: 1.11 s. A tile of 18 gradient rects, used by 3 rects:
    0.42 s.
  - Outlines (R13 round 1): a filled page-tall zigzag, 1,237 edges: 0.41 s (0.28 s at a denser
    step). A polygon of 1,237 page-tall points: 0.41 s. A stroked page-tall zigzag, 436 edges:
    86 ms. 8 tiny subpaths drawn by 2,490 `<use>`: 14 ms. 1,000 tiny subpaths drawn 26 times: 9 ms.
- For 62 designs of the new kinds, accepted or not, the raster time per priced unit is at most
  0.284 ms. The highest are 16 uneven radial stops with `stop-opacity` (0.284 ms) and a near-level
  line 1 wide with dashes 0.01 long (0.260 ms). The outlines peak at 0.241 ms (a 4,000-edge zigzag).
- 36 designs replayed (26 real AI, 10 bundled), in Node and in Chromium: 0 rejected, output
  byte-identical to main, slowest raster 0.37 s. The most costly is the bundled rose-corners: 3,937
  of 5,000 (4,204 on main). It costs less, because a gradient's stops are no longer counted at every
  reference. The largest paint term, outlines included, is 314 (a real design with a pattern).
- Random designs (corrected in R13 round 1): 40,000 from a generator of shapes, groups, `<use>`,
  2-stop gradients, patterns, dashes, opacity, masks and filters, through main and this change.
  None that main rejects is accepted. 3,236 are accepted by both, and their output is
  byte-identical; 4,105 that main accepts are now rejected. The generator makes no invalid paint,
  no gradient with more than 2 stops and no path with more than 5 segments, so it does not reach the
  R13 findings. The tests below do. The first version of this list claimed this for 20,000 designs
  of a heavier generator, of which only 378 were accepted by both; the claim did not cover stops.
- Checking stays linear. The slowest real design takes 6 ms to check. The slowest hostile input
  takes 18 ms: a 4,990-hop `<use>` chain in which each hop lends a gradient, a pattern, a dash, a
  width or a transform, and 4,500 small dashed paths whose geometry is each read. Others: 1,600
  doubling levels with 7 paints lent at the top, 12 ms; a 290 KB path, 13 ms; 30,000 `url(#lg)` in
  one fill, 16 ms; a 280 KB dashed polyline, 16 ms; 25,000 subpaths drawn by 2,490 `<use>`, 14 ms;
  `fill="x"` on 4,900 rects under a lent pattern, 15 ms; 260 gradients of 16 stops, 12 ms.
  After R13 round 2, on a busier machine (load average 7–9, where the round 1 code itself took
  18–23 ms on the same chains, side by side in one process): the slowest input took 20.9 ms (the
  4,500 small dashed paths, which the second pass does not touch). The inputs built for the second
  pass took 9.7–19.3 ms: a 4,990-hop chain lending a pattern and a scale, 19.3 ms; 600 patterns
  each lent to a scaled rect, 9.7 ms; 1,600 doubling levels under a lent pattern, scaled, 12.4 ms;
  a tile that reaches a 2,490-hop chain, painted 5 times larger, 13.1 ms.
- Tests in `test/stationery-sanitize-paint.test.mjs` (moved out of the cost tests, R4): 16 rejected
  designs for the first version, and 36 that remain from R13 round 1 (round 2 replaced one), each
  with a mutation of the shipped source that lets it through. R13 round 3 found that 26 rules could
  still be deleted or weakened with no test failing, and adds `test/stationery-sanitize-bounds.test.mjs`
  for them (Review, round 3). R13 round 2 adds 6 rejected designs of a pattern
  lent to a stretched child (a scaled rect, path or `<use>`, a nested `<svg>`, a fill and a stroke),
  each with its own-fill control, and a mask drawn at the scale of what it masks. Accepted
  controls: ordinary dashes on a border and 30 ruled lines, a gradient page with 60 gradient petals,
  an opaque pattern tile, a 57-segment stroked vine drawn 20 times, and a solid colour under a lent
  pattern. Each costs under 800.
- A mutation run (24 of the deep reviewer's 26, with their texts brought up to the code and two of
  them merged into one rule; 8 for the rules of R13 round 1; 5 for round 2) writes each mutation
  into a copy of the tree and runs the cost tests: 0 of 37 survive. In R13 round 3 the run grew to
  104 (Review, round 3).
- A combination sweep (R13 round 2): designs that repeat a unit mixing dashes, gradients with 16
  stops, a see-through pattern tile, layers, masks, filters, page-tall outlines and plain shapes,
  each at the largest count the budget accepts. The mixes of the new kinds rasterise in 0.23–1.29 s
  (slowest: a gradient, a pattern and a filter, 12 times). The slowest of all, 2.12 s, is 8 plain
  stroked shapes off the pixel grid and one layer, 247 times: the Amendment 2 worst case, not a new one.

### Consequences

- **The prices over-count, on purpose.** Dashes 1 device px or longer are priced like sub-pixel
  dashes, which cost about 50 times more (11.9 µs against 0.25 µs a dash). Curved and vertical dashes are priced like level ones. A
  pattern pays for the most costly tile in the document, not for its own. A shape that is drawn both
  under a gradient parent and under a solid parent is priced as a gradient on every path. A shrink
  is not counted. A `<use>` with `width` or `height` makes the area unknown.
- **The outline bound over-counts too.** It assumes that every edge that can cross a scanline does
  so on every row the edges span. Many tiny subpaths in one place cost over 1,000 times less than
  their price; a page-tall stroked zigzag about 20 times less. A single page-tall stroked path of
  about 1,460 quadratic segments, or a filled path of about 1,240 page-tall edges, reaches the whole
  budget. The real designs' most complex path has 57 segments.
- **The worst design overall still takes about 2.5 s** (Amendment 2, Consequences). Neither this
  amendment nor its R13 round 1 changes that.
- **Checking now reads every drawn shape's geometry**, for the outline price. A 290 KB path checks
  in 13 ms (1 ms before).
- **Four new prototype-free tables:** `SERVER` in `stationery-cost`, keyed by an element name, and
  `ARGS`, `CROSS` and `LINES` in `stationery-geometry` (since the R13 round 3 split, commit
  001bd3c), keyed by one path-command letter. The invariant in `test/stationery-proto-keys.test.mjs`
  now names twelve tables.
- **Two tests changed their design, not their purpose.** The size-cap mutation now uses a 310 KB
  dropped attribute, because a 70,000-segment path is now also refused by the outline price. The
  linear-time check of a 300 KB minified path uses `fill="none"`, so that the check, not the
  drawing, is what it times.
- **Measured in desktop Chromium only.** iPad WebKit draws dashes, gradients and pattern tiles with
  CoreGraphics, and may cost more or less. The budget does not rely on Skia's dash limit.

### Review (R13, round 1, 2026-10-13)

Two fresh reviewers saw the rules and the diff. The rules review (`claude -p` with
`~/.claude/review-prompt.md`) was CLEAN with one WARN: the edge that skips a gradient or pattern in
`combine` did not say why. Its comment now says that the server is not drawn where `url(#id)`
names it, and that each shape that paints with it pays through `drawPrice`. The deep review said
BLOCKING, with four findings. Each is fixed here.

- **Blocking: an unreadable own paint was priced as solid.** Chromium paints the inherited paint
  instead (`fill="x"`, `fill=""`, `context-fill`, `stroke="x"`). Measured under a lent pattern:
  48 x 4 `<use>` 4.27 s (53 ms with an opaque fill); 48 x 96 ~102 s. Under a lent gradient, 48 x 98:
  ~31 s. A pattern nested in a tile through `fill="x"`: 8.1 s. Fixed by Decision 3: an own value
  other than `none` or `inherit` also counts what it inherits. Seven rejected designs (pattern and
  gradient, each with `x`, an empty value and `context-fill`, and a stroke) and the nested one, each
  with the mutation that drops the rule.
- **Blocking, a regression: a gradient's stops were no longer paid at each reference.** With uneven
  offsets the cost grows with the stops (Context). 4,000 stops on 22 full-page rects were accepted
  and took 42 s (the reviewer's figure; 3,000 stops on 20 rects, measured here: ~29 s); main
  rejected them. Fixed by Decision 8: at most 16 stops; `GRAD_COST` rose from 40
  to 55 for 16 uneven stops. The largest accepted design with 16 uneven stops: 88 full-page rects,
  1.40 s (the reviewer measured 121 rects at 1.52 s before the price rose). The Context's stop figure
  and the random-design claim are corrected.
- **Should-fix: 22 rules survived mutation**: no test failed when one was deleted. Each now has a
  rejected design and a mutation: the non-scaling-stroke dash count, an unreadable stroke width,
  unknown geometry (a full page and an endless length, and a length that is not a number), an
  unreadable transform argument (`scale(10-10)`, which Chromium reads as `scale(10,-10)`), text after
  a transform, the root, nested `<svg>` and pattern `viewBox` stretch, a pattern `viewBox` in object
  units, `patternTransform`, `<use>` width and height, the stretch passed to a `url(#id)` target,
  path data with text after it or an unknown command, the most costly tile as a maximum, the matrix
  and skew stretch, polygon, circle and line geometry, and a curve's control polygon. One more,
  found by the new mutation run, also has one: the rows of a non-scaling stroke. Some of these
  designs are cheap in Chromium; their names say so ("rule:"), because the bound must hold whichever
  way Chromium reads the value.
- **Should-fix, older than this change: a shape's outline was not priced.** Fixed by Decision 1
  (outline) and Context (outlines). The reviewer's design, 25,000 tiny subpaths drawn by 2,490
  `<use>` (22.9 s), is rejected. Measuring how the cost scales also found a worse case: one filled
  path of 4,000 page-tall edges took 12.8 s, and one element of 8,000 page-tall points 10 s. Both
  are rejected. The 36 designs still pass, byte-identical.
- **Nits, fixed:** the list separator (CSS whitespace or a comma) is one constant, `SEP`, with its
  derived `LIST` and `REST`; the `viewBox` reader is one helper, `viewBoxOf`, used by the sanitizer's
  `viewBox` rule and by the stretch (R3).

### Review (R13, round 2, 2026-10-13)

The rules review (`claude -p` with `~/.claude/review-prompt.md`) was CLEAN. The deep review said
BLOCKING, with one finding, fixed here.

- **Blocking: a pattern's tile was priced at the stretch of the element that writes `url(#p)`, not
  of the shape that paints with it.** With `<g fill="url(#p)">` lending the pattern to a child that
  is scaled up, the tile is drawn at the child's scale but was priced at the `<g>`'s. Everything in
  the tile whose price grows with the stretch was under-counted: a gradient's area, dash rows and
  outline rows. Measured: a dashed-line tile painted by one rect under `scale(10)` cost 477 when
  inherited and 3,692 as the rect's own fill (167 ms both). A tile of 348 small rects with a 16-stop
  gradient, lent to one rect under `scale(100)`, was accepted at a cost of 4,999 and took 5.5 s;
  main rejected it (12,651). Fixed by Decision 5: every pattern takes the largest stretch of any
  shape that paints with a pattern, in a second pass. Now the inherited and the own forms cost the
  same (3,693 and 3,692; 43,275 and 43,274, rejected). Six rejected designs, each with its own-fill
  control, and mutations that drop the second pass, its seed, the seed's spread, the stroke painters
  and the non-rect painters. The class was checked for the other `url(#id)` targets (Decision 5):
  gradients, masks and clip-paths are priced at the right scale already.
- The deep reviewer stopped partway. The author ran these checks instead:
  - the 36 designs in Chromium: 0 rejected, output byte-identical to main, slowest raster 0.38 s;
    in Node, no design's cost changed in this round (the most costly is still 3,937);
  - the mutation runner, with the new rules: 0 of 37 survive;
  - check time, with four inputs aimed at the second pass: 9.7–19.3 ms each;
  - a combination sweep: the slowest accepted mix of the new kinds takes 1.29 s, and the slowest of
    all, 2.12 s, is the Amendment 2 worst case of plain stroked shapes off the pixel grid.

### Review (R13, round 3, 2026-10-13)

The rules review (`claude -p` with `~/.claude/review-prompt.md`) was CLEAN. Its one note: the cost
file was at 299 lines with no TODO naming its split seam. The readers are now their own component
(Decision 10), so the cost file is at 204 lines.

The deep soundness reviewer stopped before it measured anything: a safety check kept it from
building stress SVGs. The coordinator re-ran the author's probes instead, and all of them held: the
36 designs are accepted in Node and in Chromium, byte-identical to main (most costly 3,937, slowest
0.38 s); check times 19.7 ms or less; the largest accepted layer designs 0.95–1.36 s on a busy
machine; 16-stop gradients 1.30–1.42 s; outlines 0.42 s or less; mixed designs 1.95 s at most; and
the two inputs that main rejects and this branch accepts draw in 8–11 ms.

A fresh tests-and-ADR reviewer said BLOCKING. It ran 67 more mutations, and 36 of them survived (its
run, `r13f/extra.out` in the session scratchpad, ends "mutations 67 surviving 36"). Each
finding is fixed here, in `test/stationery-sanitize-bounds.test.mjs` and the paint tests, with code
changed only where a finding needed it.

- **Blocking (B1): the rule that a mask or clip-path may not use a pattern rested on one clause**
  (`url(#pattern)` sets the effect flag). Deleting it failed no test. Two rejected designs pin it, a
  pattern inside a mask and inside a clipPath, each with that mutation, and a test checks the reason.
- **Blocking (B2): the claim "a test for every bound" was false.** The title of commit 7b91849 and
  the first list of tests above said so, but 26 rules could be deleted or weakened with no test
  failing. 13 were never reached by any test input: the outline's stretch, the second pass's own
  stretch and first-pass input (the round 2 fix itself), the second argument of `scale`, NaN as the
  worst stretch, the token bound for unreadable path data, the ellipse's length, a rounded rect's
  segments and edges, the `t` and `v` legs of a path, the scale-up of too-small arc radii,
  `url(#pattern)` setting the effect flag (B1), and a clipPath's pass per shape. The rest only
  lowered existing costs: `FILL_SEG`, one row per edge, the stroke's joins and caps, the boxes of
  circles and ellipses, the `q`, `s` and `h` legs, the arc's box, `CROSS`, `LINES` and their
  counters, and `z` counting a segment. Each now has a rejected design and the mutation that lets
  it through. Where Chromium draws that design cheaply, its name starts with "rule:".
- **Should-fix (S1): no price had a boundary.** `GRAD_COST` 55 → 40 (the round 1 blocking fix),
  `TILE_COST` 6 → 3, `LAYER_COST` 10 → 5 and `FREE_PAIRS` × 4 each failed no test. Eight boundary
  tests now hold n accepted and n + 1 rejected: 89 gradient rects (0.58 s); 88 rects with 16
  uneven stops (1.40 s); 45 pattern rects (0.99 s); a 58-rect see-through tile used 9 times
  (1.06 s); 383 layers (0.98 s, Amendment 2); 2 near-level dashed lines (0.95 s); a 1,237-edge
  filled zigzag (0.41 s); and 469 stroked 40-point stars, each just past its free share (0.16 s).
  Each time is the first measurement of that design, made on a quieter machine.
- **Should-fix (S2, R14): the controls never checked their cost**, and the round 2 test named
  "costs what the same pattern costs" only checked that both forms are rejected. `sanitize()` now
  returns `cost`, the budget's total, with every result that reached the budget. The controls assert
  that each costs under 800, and the round 2 test asserts that the inherited and own forms differ by
  at most 1 (the lending `<g>`).
- **Should-fix (S3):** the round 2 mutations of the seed, its spread, the stroke painters and the
  non-rect painters lived only in a scratch script. Each is now a design and its mutation in the
  test file.
- **Should-fix (S4): ADR numbers.** Fixed above: 1.40 s, not 1.41 s; 24 + 8 + 5 mutations, not 26 +
  8 + 5; 36 round 1 designs remain; a gradient or pattern `url(#id)` costs nothing where it is
  written (decision 4); "every design in Context that took 1.5 s or more"; and the exact stroke
  outline.
- **Should-fix (S5): older rules moved verbatim had no killing mutation.** Now pinned: a filter's
  passes by octaves and by region, its region's x and y offset and finiteness, a clipPath's pass per
  shape, and the reason for a loop.
- **Nits:** one figure for each measured design (the 4,000-edge zigzag 12.8 s, the 25,000 subpaths
  22.9 s, the 10-wide near-level line 2.1 s, re-measured; "~" means timed on a tenth or less; about
  4,600 plain shapes); the dash over-count is about 50 times, not 20; the `FREE_PAIRS` comment
  states its derivation. R3: `inherits` uses CSS whitespace (`WS`), `viewBoxOf` uses the list
  separator (`SEP`), and the full-page fixture `FP` is one export of `test/helpers-stationery.mjs`.
  These two reader changes alter no verdict of the 36 designs. The `viewBox` change moves root
  verdicts in both directions (corrected in round 4): a `viewBox` with a leading or trailing comma
  is now accepted (main refused it), and one separated by no-break spaces is now refused (main read
  it). Chromium reads none of these spellings: it ignores the `viewBox` and draws at scale 1, so the
  budget, which prices the `viewBox` as written, never prices less than Chromium draws. An `inherit`
  written with a no-break space is now unreadable, and so the worst case.
- **The commit type (noted in round 4):** commit e81cdf0 is typed `test(stationery)`, but it also
  changed runtime code: the cost readout in `sanitize()`'s result, `inherits` and `viewBoxOf`.
  History is not rewritten; this note and the round 4 commit message record it.
- **The mutation run** now joins the author's 37 and the reviewer's 67, without duplicates: 104
  mutations. After round 4, 1 survives, and it is equivalent: stopping, instead of giving up, at an
  arc flag that cannot be read leaves the command unfinished, and the unfinished-command rule
  reports the same unreadable data. (Round 3 called a second survivor, the first pass's loop check,
  equivalent; round 4 found it is equivalent in verdict only, and a test now kills it.)

### Review (R13, round 4, 2026-10-13)

Both reviews said NOT BLOCKING; the rules review (`claude -p` with `~/.claude/review-prompt.md`) was
CLEAN. The reviewer also checked that the two refactors change no behaviour: it replayed the 36
designs through main, 59ccca1, 01a73bf, 001bd3c and the round 3 head, and the digests (verdict,
output hash, size, passes, layers, paint and depth for each design) of main and 59ccca1 are
identical, and so are those of 01a73bf, 001bd3c and the round 3 head. Its fuzz figures were not left
on disk; the author's are in the commits: 50,000 random designs for 59ccca1 and 80,000 for 001bd3c,
each with the same verdict, reason, output and cost terms on both sides. Each finding is fixed here.

- **The `viewBox` change moves root verdicts both ways.** The ADR (round 3, above) now states both,
  and two tests name Chromium's reading: a leading or trailing comma is accepted, and a no-break
  space is refused; Chromium ignores both and draws at scale 1.
- **One "equivalent" survivor was equivalent in verdict only.** Without the first pass's loop check,
  a pattern whose tile paints with itself is refused by the nested rule instead of as a loop. That
  design is now in the test that checks a loop's reason, and the mutation dies. 104 mutations, 1
  survivor (the arc flag), which is equivalent.
- **Two figures for the same design.** Each design now has one figure, the same in decision 4, in
  Measured (after), in the round 3 text and in the test names: 88 rects with 16 stops 1.40 s, 89
  gradient rects 0.58 s, 45 pattern rects 0.99 s, the 58-rect tile 1.06 s, 2 dashed lines 0.95 s,
  the 1,237-edge zigzag 0.41 s, and 383 layers 0.98 s (Amendment 2).
- **`ARGS`, `CROSS` and `LINES` are in `stationery-geometry`**, not `stationery-cost` (Consequences).
- **36 of the reviewer's 67 mutations survived in round 3**, not 38 (its `extra.out`).
- **R3: the paint fixtures were copied between the two new test files.** `LG`, `PT`, `HALF`,
  `SMALL`, `dashed`, the seeded uneven stops (`unevenStops`) and the 16-stop gradient (`R16`) are now
  one export each of `test/helpers-stationery.mjs`. The seeded stops start from the same seed on each
  call; the 3,000-stop design was re-timed with them (~29 s, as before).
- **Fail closed had no test.** A new test runs each component as its own script, as a browser does,
  with `stationery-geometry` and then `stationery-cost` left out: each time a script throws and
  `PAStationery` is not defined. The full set, run the same way, is the control.
- **Small items:** commit e81cdf0 changed runtime code under a `test` type (noted above and in this
  commit); `list` is no longer exported from `stationery-geometry`, because nothing used it; the
  sanitizer's comment says the page constants live in `stationery-geometry`; the boundary test's
  failure message no longer reads a cost that a rejection before the budget does not have.

## Amendment 5 — an AI draft over the budget is simplified, not thrown away (2026-10-13)

Numbered 5: Amendment 4 (the compact prompt) was written at the same time, on
`feat/stationery-compact-svg`.

### Context

The owner, on the live Journal: the studio waited more than 2 minutes for a real Sonnet design, then
showed "Rejected · 已拒绝 — too costly to draw …" and threw the design away. The design is kept,
byte for byte, as `test/fixtures/stationery-rejected-filters.svg` (20 KB, model output, no personal
text). Measured with the shipped sanitizer:

- It costs 12,541 of `MAX_COST` 5,000.
- It uses two filters: a `softShadow` on 12 shapes and a `glow` on 8. Without them it costs 392.

The budget is right: filters are slow on the iPad. Throwing the whole design away is wrong. The
person waited 2 minutes, and the cause is two effects that the design can lose.

### Decision

1. **`sanitize()`, the cost model and `MAX_COST` do not change.** Every rule, price and reason is the
   same. A My-templates file and a bundled design still go through `sanitize()` alone.
2. **`costWhy()` marks a refusal for the budget with `over: true`**, and `sanitize()` passes it on.
   Only the `MAX_COST` test sets it. A loop, the nested rule, the reference depth, and every rule
   that runs before the budget do not. So a design marked `over` passed every safety rule.
3. **A new `simplify(svg)`, in `stationery-sanitize`, re-exported by `PAStationery`.** The studio
   calls it in place of `sanitize()`, on the typed, tweak and picture paths alike.
   - It runs `sanitize()` first. When the result is neither `over` nor `limit` (R13 round 1,
     below), it returns that result unchanged: an accepted design (with no note), and every
     refusal with its own reason.
   - When the result is `over`, it takes out the effects the budget prices, one kind at a time,
     in this order. The steps live in `SIMPLIFY`, in `stationery-simplify` (split out of
     `stationery-cost` in R13 round 2, below), next to the prices they undo (R3: one
     implementation):

     | Step | What it does |
     |---|---|
     | 1. Filters (阴影和发光效果) | Removes every `filter` attribute and every `<filter>` element. |
     | 2. Masks and clipping (遮罩和裁剪) | Removes every `mask` and `clip-path` attribute, and every `<mask>` and `<clipPath>` element. |
     | 3. See-through layers (半透明图层) | On a group or a shape with `opacity` below 1, moves that fraction onto its own `fill-opacity` and `stroke-opacity` (multiplied by any it has), and removes `opacity`. |
     | 4. Dashes (虚线) | Removes every `stroke-dasharray`. The lines become solid. |
     | 5. Pattern fills (图案填充) | Paints each fill or stroke that uses a pattern with one plain colour at the share of the tile its shapes cover (R13 round 1, below), and removes every `<pattern>`. |
     | 6. Gradients (渐变) | Paints each fill or stroke that uses a gradient with one stop's colour at the gradient's mean stop-opacity (R13 round 1, below), and removes every gradient. |

     Why this order: the passes first, because a filter or a mask costs 100 or more for each use
     and is the iPad's slowest effect. Then layers: 10 each, and once moved onto the paint they
     look almost the same. Then dashes: a solid line looks close to a dashed one. Last, the paint
     itself, which shows the most: patterns, then gradients (at most `GRAD_COST`, 55, a shape).
   - The steps add up. After each step, the WHOLE `sanitize()` checks the result again. The first
     result that passes is the answer.
   - A step that changes nothing is skipped. A step whose result the check refuses for a reason
     other than the budget, or that does not lower the cost, is undone. So the note names only what
     was taken out, and nothing the check refuses is ever kept.
4. **The note.** An accepted result carries `note`, for example
   "Simplified to draw fast, without shadows and glows · 已简化：去掉了阴影和发光效果". The studio
   returns it, and the picker shows it under the draft, not as an error.
5. **Nothing fits.** The studio shows a plain message, with no "Rejected" in front:
   "Too complex for the iPad to draw · 太复杂，iPad 画不动 — try again or ask for a simpler design ·
   请重试或要求简单些". Every other refusal keeps "Rejected · 已拒绝 — " and its reason.
6. **Why a step can never turn an unsafe design into an accepted one.** Two guards, each enough on
   its own:
   - Only a design marked `over` is simplified, and `over` is set only after every safety rule
     passed.
   - Every result goes through the whole `sanitize()` again, and only `ok: true` is accepted.

   The steps themselves remove things, or write a number or a colour that the design already
   holds. They never judge a result.
7. **The prompt is unchanged.** Another branch (`feat/stationery-compact-svg`) is changing the
   studio's prompts. This change does not touch them.

### Measured

- **The real design.** `sanitize()`: refused, `over`, cost 12,541. `simplify()`: accepted at cost 392,
  after step 1 only. Every `opacity`, the dashed frame, the dot pattern and all 9 gradients are kept.
  The result passes `sanitize()` again unchanged.
- **Time.** `simplify()` takes 11 ms in Node and 6 ms in Chromium, where the DOMParser cross-check
  runs too. In desktop Chromium (Playwright, `PAStationery.thumb` at 1640 device px, median of 3)
  the original drew in 38 ms and the simplified one in 35 ms. These filters cover small shapes, and
  the budget prices each filter step as a full-page pass. That price is not changed here (decision
  1). iPad WebKit was not measured.
- **Tests:** `test/stationery-simplify.test.mjs` (16 tests). They cover:
  - the real design, through `simplify()`, the studio, and the picker (drawn, with the note; Keep
    saves the simplified SVG);
  - one design for each later step, each over the budget because of that kind alone. Each also holds
    an in-budget use of every later kind, which must be kept;
  - what a step puts in its place (the folded fractions, a percent, a pattern's and a gradient's
    plain colour);
  - steps that add up, and steps that are undone (a filter that a `<use>` names; a one-paint
    `opacity`, which is no layer);
  - R14: a script, an event handler, an external `href`, an external `url()` and a
    `<foreignObject>`, each added to a design that is over the budget. Each is refused with
    `sanitize()`'s own result, while the same design without it IS simplified (the control). The
    nested rule and a loop keep their own reasons;
  - an in-budget design and every bundled design: `simplify()` equals `sanitize()`, with no note;
  - nothing fits: the plain message; a step that throws: `sanitize()`'s refusal, no throw (R5);
  - the budget's constants, pinned in the source.

  The existing cost suites pass unchanged. The two existing studio mutation tests now remove the
  `simplify()` call, because the studio's `sanitize()` call is now inside it.
- **Mutation sweep** (each mutant applied to the shipped file, both studio suites run): 23 mutants,
  22 killed by a test that is not a mutation test. The survivor removes the skip of a step that
  changed nothing. It is equivalent: the unchanged result costs the same, so the step is undone
  anyway.

### Consequences

- **A draft over the budget is shown, smaller in effects, instead of being lost.** The person sees
  it before Keep, and can Tweak it or Try again.
- **What a step changes is visible.**
  - A folded layer differs only where shapes overlap. A shape inside that has its own
    `fill-opacity` keeps its own value, without the group's fraction.
  - Without its mask or clip, content is drawn in full. A clip to the page looks the same, but a
    masked texture covers its whole shape.
  - A pattern becomes one colour at its tile's painted share, and a gradient one stop's colour at
    its mean opacity (R13 round 1, below). A gradient across the page becomes flat.
- **The first fit, not the smallest change.** The steps add up in a fixed order. A design over the
  budget because of dashes, that also has group `opacity`, loses the layers first if that saves
  something, then the dashes.
- **Not simplified, because no step can lower it:** a design that is large through `<use>` copies,
  or through outlines with many edges. These get the plain message. A design refused by the nested
  rule, a loop, the depth, the byte cap or the element cap keeps its own reason.
- **Follow-up, not done here:** price a filter by the area it covers, as a gradient is (the original
  drew in 38 ms on desktop Chromium), after timing filters on an iPad.

### R13 round 1 (2026-10-13): the size limits, and what a step puts in place

The review confirmed five findings. A real run of this branch found a sixth gap: "a glowing neon
love note with soft shadows" (real Sonnet, 127 s) was refused "Rejected · 已拒绝 — filter region
too large". That limit ran before the budget, so `simplify()` never saw the design. The answer is
kept byte for byte as `test/fixtures/stationery-rejected-region.svg` (28 KB, model output, no
personal text; two path separators changed in R13 round 2, below).

1. **The size limits are simplified too.** A filter's region and steps, a turbulence's
   `numOctaves`, and a gradient's stops are sizes, not dangers.
   - `sanitize()` marks such a refusal `limit: true`. It sets the flag only when every other rule
     passed. The walk now reads the whole tree past a size limit, so a danger anywhere (inside the
     oversized filter too) is refused for itself. The loop, nested and depth rules are also read
     first.
   - The `numOctaves` rule moved from `valueOk` into `limitsWhy` (stationery-cost), next to the
     other limits. Its text and its bound are the same.
   - `simplify()` runs the limits' own steps (`LIMIT_STEPS`) first, all at once:
     - an oversized filter goes, with every `filter="url(#it)"`;
     - a gradient keeps 16 of its stops, evenly picked, including the first and last.

     The whole check then runs again. The budget's steps follow when the design is still over the
     budget.
   - A limit that no step can take out (a `<use>` names the filter) keeps its own reason.
   - The note names a kind once: when the budget's filter step takes every filter, the oversized
     ones are not named twice.
   - Verdicts do not change. Every design `sanitize()` refused before is still refused. Only the
     reason can differ, when a design breaks two rules: the danger is now named.
2. **A pattern made plain keeps its look.** It becomes the colour that covers most of its tile, at
   the share of the tile that its shapes paint:
   - area, plus stroke length x width, for each shape;
   - times their opacities, and at most the tile;
   - the tile in its content's units: a `viewBox`, or user space, or the painted shape's box.

   That share is multiplied into the shape's own (or inherited) `fill-opacity` or
   `stroke-opacity`. A faint dot texture over the page stayed a solid `#333` page before. Now it
   is `#333` at 0.4%.
3. **A gradient made plain keeps its stop-opacity.**
   - The opacity is the gradient's mean stop-opacity over 0 to 1. Stop-opacity runs straight
     between stops, and pads past the ends.
   - The colour comes from the stop that covers the most. Each stop's weight is its opacity times
     the half-gaps to its neighbours.

   A vignette whose first stop is clear `#fff` covered the page in opaque white before. Now it is
   `#000` at 15%.
4. **A refusal is always bilingual.** `simplify()` flags `over` only on the plain "Too complex"
   message. When a step throws, or a limit cannot be taken out, sanitize()'s own reason comes back
   without the flag, so the studio puts "Rejected · 已拒绝 — " before it. Before, the R5 catch
   returned the refusal with `over`, and the studio showed the English-only cost reason.
5. **An empty opacity is no opacity.** `opacity=""` or `" "` has no digit, so it is unreadable.
   Chromium draws the element as if the attribute were absent, so it is taken off. Before, it was
   folded in as 0 and the element disappeared.
6. **Tests that a refused step leaves every attribute as it was.** A refused pattern step is
   followed by the gradient step, which sees the original paint. A refused gradient step is the
   last step, so nothing can show a leak; the test moves it ahead of the patterns in a mutated
   order. A shape with fill and stroke is folded like a group (the m3 mutant).

**Measured.**
- **The neon draft.** `sanitize()` refuses it: `limit`, cost 169,487.
  - The two oversized glows go first. The design is still over the budget, so every filter goes.
  - Accepted at cost 1,044, with the note "without shadows and glows · 去掉了阴影和发光效果".
  - Every `opacity` and all 14 gradients are kept. `simplify()` takes 13 ms in Node.
- **Chromium** (Playwright, `PAStationery.thumb` at 408 px). The figure is the mean absolute RGB
  difference from the original picture, out of 255:

  | Design | Before this round | Now |
  |---|---|---|
  | Neon draft | refused | 1.7 |
  | Faint dot page | 197.3 | 1.7 |
  | Vignette over a red circle | 64.9 | 29.9 |

  The vignette's remaining difference comes from its 91 `#fff` to `#ccd` page gradients, each now
  flat `#fff`.
- **Seen in the neon render.** Removing a filter can show a line the filter hid. Chromium skips a
  filtered element whose box has no height, such as a level line. The neon border lines appear in
  the simplified draft. They are the design's own lines, and the person sees them before Keep.
  (R13 round 2 changes this: such a line stays hidden. See below.)
- **Tests:** `test/stationery-simplify-fit.test.mjs` (15 tests); updates in
  `stationery-simplify.test.mjs`.
- **Mutation sweep**, with every stationery suite run for each mutant:
  - this round's guards: 51 mutants, 51 killed by a test that is not a mutation test;
  - the first round's 21 that still apply, re-run: 20 killed. The survivor is the known
    equivalent: skipping a step that changed nothing.
  - The first round's sweep also counted the per-file `not ok` lines, so a file whose only failure
    was a mutation test counted as a kill. The sweep now reads test-level lines only.

**Follow-ups, not done here:**
- a gradient's mean colour, not one stop's;
- the folded layer of a group whose child sets its own `fill-opacity` (that child keeps its own
  value);
- `stationery-cost` is at 298 of its 300 lines. The simplify section is the seam for its own
  component, which needs a new `web.mjs` component entry and a live-node restart. (Done in R13
  round 2.)

### R13 round 2 (2026-10-14): the lent paint, shapes of no size, what a tile draws, the parse rule

The review confirmed eight findings and refuted none. A real run of this branch (fake and real
Sonnet, throwaway servers) drew all four drafts, and reported three gaps. Every finding is fixed,
and gap 1 is decided below. Each "measured" figure comes from headless Chromium (Playwright).

0. **Split first (R4, R8).** `stationery-cost` was at 298 of its pinned 300 lines, and every fix
   lands in its simplify section. That section moved, unchanged byte for byte, to a new component
   `web/stationery-simplify.inline.html` (`PAStationerySimplify`), in its own commit.
   - `stationery-sanitize` carries `<!--PA_STATIONERY_SIMPLIFY-->` after the budget's marker.
   - `web.mjs` lists it last in `PA_COMPONENTS`. So **the live node needs a restart after the
     merge.** Until then the page has no `PAStationerySimplify`. `simplify()` reads it inside its
     try, so every design is still checked, and an over-budget draft keeps `sanitize()`'s own
     refusal, as before amendment 5. A test pins this.
1. **The browser's own parse runs before `limit` and `over`** (finding 5).
   - `check()` returned both flags before `domAgrees()`. A filter holding `result="a&#xFFFF;"` was
     refused "the browser parses it differently". The same filter made oversized, or the same
     design over the budget, was marked `limit` or `over`, and `simplify()` took the filter out and
     accepted the design. Measured on 16f6749: both cases were accepted.
   - Now `check()` emits and cross-checks right after the cost rules, so a parse mismatch is
     refused for itself. Accepted designs are unchanged.
   - In Node there is no DOMParser, so the tests pass `XmlDomParser`. It plays the browser's XML
     parser over `sanitize()`'s own output. In Chromium, on this branch, the in-limits, oversized
     and over-budget designs are all refused, and their twin without U+FFFF is simplified. Those
     are the same verdicts the test parser gives.
2. **The limit path is pinned** (finding 2). Two mutants survived every test: no savings bar
   after the limit's steps, and no price on a limit refusal.
   - The neon draft's limit refusal now pins its price, 169,487.
   - The limit-then-dashes case holds a one-paint circle at opacity 0.5. Folding it saves nothing
     after the limit's steps, so the step is undone and is not named in the note.
3. **A lent paint keeps its share where a shape overrides it** (finding 1).
   - The share was written only on the element that names `url(#id)`. Below a `<g>` that lends the
     paint, a shape with its own `fill-opacity` overrides the group's, so a 1% dot texture became
     a 90% dark grey page.
   - Now the share also goes on every `fill-opacity` or `stroke-opacity` set below the lender, along
     the paint: kids that set no paint of their own, in drawn elements only. An unreadable value
     (`""`, `inherit`) is not an override, and Chromium reads the group's there.
   - A `<use>` target is shared, so nothing is written in it. When the target overrides the opacity,
     the `<use>` paints `none` if that is nearer: when the share is below a half. Otherwise it keeps
     the colour at the target's own opacity (the error is the smaller of the two).
4. **A shape of no width or height draws nothing with a bounding-box server** (finding 3).
   - Chromium does not draw a gradient or pattern in `objectBoundingBox` units on a level line or an
     `H`-only path. Real Sonnet designs often draw ruled lines this way (`lineGrad`, `ruleGrad`,
     `staffGrad`, all bounding-box), so the original shows no line.
   - The gradient step painted them solid gold. Now such a shape gets `none` for that paint: when it
     names the server, when a group lends it, and through a `<use>` whose shapes all have no size.
   - A user-space gradient is drawn on a level line, and it keeps its colour.
5. **A tile counts only what it draws** (finding 4).
   - The tile walk follows the drawing: shapes, in groups, and through each `<use>` (its target is
     painted from the `<use>`). It skips `<defs>`, `<clipPath>`, `<mask>`, a held `<pattern>` and
     every server.
   - The walk visits at most `TILE_WALK` (5,000) elements, since a doubling `<use>` chain can expand
     into millions. Each tile is read once per size, and each `<use>` target once per paint.
   - A colour's own alpha counts. `transparent`, `#rgba`, `#rrggbbaa`, the fourth value of `rgba()`
     or `hsla()`, and the value after `/` all count. A colour at alpha 0 paints nothing. A stop's
     alpha multiplies its `stop-opacity` in the mean and in the weights. The alpha is divided out
     where the colour is written, because Chromium draws the colour with its own alpha.
6. **A tile line's default width (1) is tested** (finding 6). A hatch line with no `stroke-width`
   was untested: the mutant that read it as none passed every test.
7. **R3 in the tests, and a stale comment** (findings 7 and 8).
   - `helpers-stationery` now exports `countMatches`, `replaceOnce` (a mutant that must match
     exactly once), `draftFlow` (the studio user flow) and `heartsOf`. The fit suite uses `FP`.
   - The studio's comment now names the size limits.

**Gap 1, decided: what a filter or a mask hid stays hidden.**
- Chromium does not draw a filtered or masked shape whose box has no width or height. The regions
  are in its box, and `filterUnits` and `maskUnits` are not on the allow-list.
- The neon draft's 14 glowing frame lines were never drawn. With the filter gone they appeared,
  as new hard lines.
- Now the budget's filter step, the limit's filter step and the mask step paint such a shape
  `none` (fill and stroke). It keeps its id, so a `<use>` of it still finds it, and draws nothing
  there either, as in Chromium.
- Why hide rather than show:
  - simplify() promises the look of the design as drawn, with less effort. It does not promise the
    look the model may have meant.
  - Round 2's gradient finding called new lines a defect, and this is the same case.
  - The note does not mention lines.
  - The person can ask for frame lines with Tweak.
- A filtered group or `<use>` with no size is still shown (its box is not computed).

**Measured** (Chromium, 816 x 1056 on white; each design over the budget). "Diff" is the mean
absolute RGB difference per pixel from the raw design. "Mean" is the largest difference in the
page's mean colour, per channel. Both are out of 255.

| Design | 16f6749 diff / mean | Now diff / mean |
|---|---|---|
| Texture lent by a group, child `fill-opacity` 0.9 | 176.3 / 181.9 | 4.1 / 0.2 |
| The same through a `<use>` | 176.3 / 181.9 | 2.2 / 2.0 |
| Gold rules: a level line and an `H` path | 0.8 / 2.1 (gold lines appear) | 0 / 0 |
| Staff lines lent by a group | 1.4 / 3.7 | 0 / 0 |
| A rule line through `<use>` | 0.8 / 2.2 | 0 / 0 |
| Tile: `<defs>` + `<use>` red dots | 96.1 / 130.6 (grey-black) | 63.9 / 3.9 |
| Tile: transparent background | 73.7 / 99.8 (dots vanish) | 68.9 / 0.6 |
| Gradient `transparent` to `#c33` | 101.1 / 119.0 (fade vanishes) | 50.5 / 42.0 |
| Gradient `rgba(204,51,51,0)` to `#c33` | 84.1 / 110.5 | 39.5 / 8.5 |
| Hatch, no `stroke-width` | 19.6 / 4.5 | 19.6 / 4.5 (unchanged: a test gap) |
| The neon draft | 1.7 / 1.0 | 0.6 / 0.9 |
| A masked level line | 0.8 / 1.2 (a line appears) | 0 / 0 |

- A texture's per-pixel diff stays high by nature: a flat colour cannot be a dot pattern. Its mean
  colour is the measure that matters, and it now holds.
- In Chromium, a fade from `transparent` passes through black. It interpolates transparent black,
  not premultiplied, so the raw fade averages 195,145,145, against 229,153,153 for half `#c33`.
  The plain colour cannot show that. This is the open "mean colour, not one stop's" follow-up.
- The neon draft is accepted at cost 904 (1,044 in round 1), without its glows, and its frame
  lines stay hidden. `simplify()` takes about 20 ms in Node.

**Tests:**
- `test/stationery-simplify-paint.test.mjs`, a new file with 10 tests: the lent paint, shapes of
  no size, the tile walk, alpha, the hatch width, what stays hidden, and bounded walks.
- It includes a user flow (R6): the gold-rule draft through the picker and the studio, drawn with
  its note. Keep saves exactly what `simplify()` returned.
- `stationery-simplify-fit` gains the parse rule (R14, with a control twin), the limit price, and
  the limit path's savings bar.
- The delivery and fail-closed tests pin the new component.

**Mutation sweep.** Each mutant runs on a fresh copy, with every stationery suite. A kill counts
only when a test that is not a MUTATION test fails.
- Round 2's guards: 31 mutants, 31 killed, on the final commit.
- Four of them first survived the sweep: the drawn-only filters of the lent walk and of the
  `<use>` tally, the tally's own-paint stop, and the shapes-only check when hiding. Each now has a
  case: a `<defs>` under the lender, a `<defs>` in a target, a target shape that paints its own,
  and a filtered group.
- Three are performance guards: the walk cap, the tile memo and the tally memo. They are killed
  by time, each on a design of its own, so one mutant never multiplies another's work. The first
  sweep hung on a combined mutant before this was done. The bound is 750 ms, against about
  10 to 100 ms bounded and about 2.3 s unbounded.

**Real run** (a throwaway server from the worktree, through the real `web.mjs` page builder, so
the new component entry is exercised; headless Chromium at iPad size, touch input).
- The fake model replayed the real Sonnet neon reply:
  - drawn, with the note "without shadows and glows";
  - the preview equals a fresh paint of `simplify(raw)`, difference 0;
  - Keep saved exactly that SVG, and zoom opened and closed;
  - the difference from the raw picture is 0.62, where round 1 measured 1.74;
  - the row profile's correlation is 0.98, where round 1 measured 0.65 (the frame lines);
  - the cost is 904.
- A ruled, dot-textured draft was modelled on the real `ruleGrad`, `staffGrad` and dot-pattern
  replies. It is lent to a full-page child with `fill-opacity` 0.9, and over the budget.
  - It was drawn with "without pattern fills, gradients".
  - The page's mean colour is identical, 253,248,240, against a dark grey page on 16f6749.
  - No gold rule appears.
- Every saved real model reply (33 different ones) was put through the branch: the same verdicts
  as round 1. 28 pass as they are, 4 are accepted after simplifying, and 1 stays refused for a
  duplicate id. In Chromium, each of the 4 is as close to its original as on 16f6749, or closer:
  - 0.07 and 0.07;
  - 1.70 and 0.62;
  - 1.03 and 1.03;
  - 0.66 and 0.44.
- Still true (the real run's gap 2): no real model reply has reached the pattern or gradient
  step. They rest on the tests, on the measured renders above, and on the modelled draft.

**The neon fixture and the privacy tripwire.** Run once in full, the suite failed one test outside
stationery: `test/identity-leak.test.mjs` read three of the fixture's corner-arc coordinates (3, 3
and 4 digits, space-separated) as a phone number. Round 1 added the fixture after its own full run, so
`git ls-files` never showed it to that test. So `main` failed this test from the round 1 merge until
477992c made the same two-comma change on `main` alone; merging `main` back here kept the one fixture.
- Two separators in the fixture are now commas (`130,1026` and `686,1026`).
- The path is the same: the cost, the reason, the note and the simplified SVG are identical apart
  from those two characters, checked in Node.
- The tripwire itself is unchanged. Making the privacy test lenient for SVG path data would weaken
  it for every file.

**Still approximate, not done here:**
- a gradient's or a tile's mean colour (one colour is chosen);
- a shared `<use>` target (the nearer of two looks; R13 round 3 counts it in shapes, below);
- a filtered or masked group with no size;
- an unreadable paint (`fill="x"`) read as a colour;
- a bounding-box pattern lent by a group, measured on the page's box;
- overlaps and transforms inside a tile;
- the folded layer of a group whose child sets its own `fill-opacity` (from round 1).

### R13 round 3 (2026-10-14): where the share goes, what a `<use>` also draws, a tile read once

The review confirmed three findings and refuted none. All three are fixed. Each "measured" figure
comes from headless Chromium (Playwright), 816 x 1056 on white, each design over the budget. "Diff"
and "mean" are as in round 2.

1. **The share goes only where it reaches nothing but the lent paint** (finding 1, should-fix; the
   same on d4d257d).
   - Round 2 wrote the share as `fill-opacity` (or `stroke-opacity`) on the lending `<g>` or `<use>`.
     That property is inherited. So a shape below that paints a colour of its own, and sets no
     opacity of its own, took the share too. A pink circle in a 1% dot-textured group vanished, and
     so did a blue group there, and a target circle of its own colour drawn through the `<use>`.
   - A lender inside a lender read the outer share back in `eff()`, and multiplied it in again.
   - Now `lend()` first counts what the lender reaches (`X.below`, kept per element and what it
     inherits):
     - the shapes painting the lent server;
     - those of no width or height (bounding-box servers);
     - those setting their own opacity;
     - **other**: shapes painting a colour of their own that the lender's opacity reaches. An opacity
       set on the way stops it.
   - With no other shape, the share goes on the lender, as before (one write). With one, the lender
     keeps its own opacity. The share then goes on each part below that reaches only the lent paint
     (a group, or a shape).
   - A lender below another is a colour of its own to the outer one, so the outer share never
     reaches it, and `eff()` reads the original opacity.
2. **Nothing a `<use>` also draws is written below the lender** (finding 3, minor; new in round 2).
   - Round 2 wrote `none` on a level rule line, and a share on a card, inside a lending group. A
     `<use>` elsewhere drew the same line grey and the same card blue, and both vanished.
   - Now an element below the lender that a `<use>` draws is written only when every such `<use>`
     is lent this paint by the same lender, and sits in no other `<use>` target. A petal drawn only
     by `<use>`s in its own group takes the share. Any other such element is never written, nor
     anything in it. Nothing in a `<use>` target is written either, as before.
   - What the share cannot reach there is **stuck**: a lent shape that sets its own opacity, or
     every lent shape while the share is kept off a colour of its own. It draws the plain colour at
     its own opacity.
   - The lender, or a `<use>`, paints `none` instead when that is nearer:
     - when all it lends to draws nothing (only shapes of no size, or only colours of their own);
     - or when s x (the lent shapes that have a size) < (1 - s) x (the stuck ones).
   - This count replaces round 2's "one sets its own opacity and s < 0.5" for a `<use>`. It gives
     the same answers on every round 2 case, and now serves the lender too.
3. **A tile is walked once** (finding 2, should-fix; new in round 2).
   - Round 2 kept a tile's result per tile area. A bounding-box tile with no `viewBox` has another
     area on each shape of another size. So its walk (up to `TILE_WALK`, 5,000 elements) ran once
     per shape. 4,000 rects, each its own size, painting a `<use>` chain took 4.4 s in Node.
   - Now the walk is kept per tile (`X.tiles`): for each colour, its pieces' areas in order, with
     running sums. Each shape scales them to its own tile with a binary search. A piece up to the
     tile counts its area, and a larger one counts the whole tile, as before. The per-area memo is
     gone.

**Measured** (pixel: one point inside the shape named; raw is the design as drawn).

| Design | d4d257d | 3e852d2 (round 2) | Now |
|---|---|---|---|
| Pink circle in a dotted group | 253,245,238; mean 7.95 | the same | 233,30,99 (= raw); 0.18 |
| Blue group in a dotted group | 250,246,239; 9.83 | the same | 42,111,151 (= raw); 0.18 |
| A half-tile lender in a dotted group (mean) | 2.11 | 2.11 | 0.16 |
| `<use>` of a pink circle, lent the dots | 255,247,240; 7.76 | the same | 233,30,99 (= raw); 0.15 |
| `<use>` of a page rect and a pink circle | 253,245,238; 7.95 | the same | 233,30,99 (= raw); 2.10 |
| Shared rule: the grey `<use>` | 152,152,152, and a gold line | 255,255,255 (gone) | 152,152,152, no gold line |
| Shared card: the blue `<use>` / the dotted card | blue / 71,71,70 (dark) | 252,248,241 (gone) / ok | blue / 255,250,242 (= raw); mean 0.01 |
| Petals and a yellow centre (half tile): centre | 250,224,119 | the same | 255,204,0 (= raw) |
| 4,900 shapes, one heavy bounding-box tile | 56-66 ms (refused) | 5,276-5,860 ms | 74-100 ms |

- The shared rule's raw pixel is 140,140,144: the page behind it is a gradient, drawn as one colour
  (the open "mean colour" item).
- The `<use>` of a page rect and a pink circle: the 1% rect is now none (nearer than #333 at 100%).
- In Node the heavy case takes about 70 ms (5.2 s on 3e852d2). The reviewer's 4,000-rect case,
  with a 7-level chain, takes 60 ms (4,418 ms on 3e852d2).
- Unchanged: every round 2 scenario in Chromium (the same 12 figures), and every saved real reply
  (58 unique SVGs: 52 as they are, 5 simplified, 1 refused) gives byte-identical output to 3e852d2.

**Tests:**
- `test/stationery-simplify-share.test.mjs`, a new file with 7 tests:
  - colours of their own below a lender, nested lenders, and `<use>` targets;
  - what a `<use>` also draws: the rule, two cards, a sealed square and the petals;
  - a user flow (R6): the own-colour draft through the studio, where Keep saves exactly what
    `simplify()` returned;
  - a bounding-box tile scaled per shape (0.048, 0.3 and 0.1333 of one piece);
  - the worst case: 4,900 shapes of different sizes (MAX_NODES is 5,000) painting one tile that
    draws `TILE_WALK` elements. It must take under 200 ms, the least of 3 runs. It takes about 70.
- `stationery-simplify-paint` keeps its 10 tests. Its mutants follow the rewritten code. Its tile-memo
  design (2,500 circles in a user-space tile, one size) gave way to the new worst case.
  `useChain` is now one export of `helpers-stationery` (R3).

**Mutation sweep.** Each mutant runs on a fresh copy, with every stationery suite. A kill counts
only when a test that is not a MUTATION test fails.
- Every mutant of the three simplify suites: 54, all killed, on the final code.
- 16 are new in this round: the share kept off a colour of its own (counted, stopped by an opacity,
  searched below a colour of its own, carried down, written where it is not carried, never on a
  `<defs>`); what is stuck at a `<use>` and at the lender, and when; what a `<use>` also draws
  (never written, unless every `<use>` is lent too, and in no other target); the tile's clamp and
  search; and the tile walk's memo, killed by time (5.2 s, against 200 ms).
- Round 2's mutants follow the rewritten code. The flat-shape check is now two mutants, one for the
  lender and one for what it lends to.

**Still approximate, not done here** (added to round 2's list):
- what the share cannot reach (stuck) draws the plain colour at its own opacity, or none: the
  nearer is counted in shapes, not in area;
- a shape of no size that a `<use>` also draws keeps the colour where it is lent (Chromium drew
  nothing there), unless its lender paints none;
- below a lender with a colour of its own, the share is one opacity on each part it reaches, a few
  bytes more than one on the lender.

### R13 round 4 (2026-10-14): one work budget per call (工作量上限), a `<use>` drawn inside and outside the lender

The review confirmed two findings and refuted none. Both are fixed. "Measured" figures come from
headless Chromium (Playwright) on this Mac, unless they say Node.

1. **One work budget for the whole `simplify()` call** (finding 1, blocking; new in round 2).
   - `TILE_WALK` (5,000) bounded the walk of ONE tile, not the call. 1,600 small patterns that each
     draw one shared `<use>` chain, with 60 junk attributes on each link (208 KB), froze the page for
     6.0 s in the review (7,979 ms here, on 1bdce28). The design was refused, but only after that.
   - Measuring found more walks of the same kind. Each is a crafted design in the new suite:
     - a tile's size and its list of colours, read again for each shape that paints it;
     - a gradient's children, read again for each circle a tile draws (4,971 ms on 1bdce28);
     - a long value, read on each visit. CSS whitespace after a value is legal, so a 250 KB
       `stroke-width` on a group reaches every circle of a tile;
     - a long colour, written on every shape that paints the tile. 150 KB on 2,500 shapes made a
       375 MB output (785 ms on 1bdce28);
     - the climbs up the tree and the tallies through each `<use>`, over long values.
   - Now `simplify()` makes ONE meter per call (`meter()` in `stationery-simplify`) and passes it to
     every step. Every walk that can read an element again and again spends from it:
     - the tile walk: a unit per element, one per kid it lists, and the paint it inherits;
     - a tile's own values and its colour pieces, for each shape that paints it;
     - the tallies of what a lender lends to (`go`), and the climbs (`inh`, `eff`, `alone`);
     - a gradient's children, once a call (kept in `X.grads`);
     - each colour written.
   - A visit also costs a unit per `SCAN` (128) characters of the element's values. So a long value
     costs what reading it costs.
   - Not metered, like `sanitize()`'s own walks: what reads each element a bounded number of times.
     That is `all()`, and a lender's own walks (each element is below at most one lender per paint).
   - When the meter runs out it throws `SPENT`. `simplify()` then returns the plain refusal
     (`TOO_COMPLEX`, flagged `over`, shown with no "Rejected"). It fails CLOSED: never a partly
     simplified design (a step kept earlier is not drawn either), never a hang. Any other throw still
     returns `sanitize()`'s own reason after "Rejected" (R5, unchanged).
   - The budget is per call: each `simplify()` makes a fresh meter.
   - **Sizing: `WORK` = 50,000 units.**
     - The 58 saved real replies spend 0 units: none reaches the pattern or gradient step. Forced
       through every step (200 invisible gradient rects added), they spend at most 650.
     - The heaviest accepted test design (4,900 shapes, one 5,000-element tile) spends 24,120. 1,592
       shapes sharing one gradient of 3,000 children spend 3,028.
     - Spending all 50,000 on the costliest walk (a tile walk over elements with 60 attributes)
       takes 25-28 ms. At `SCAN` 128, a long value's units cost about what an element's do.
2. **A `<use>` target drawn inside the lender and outside it** (finding 2, minor). A new behaviour
   test: the target is never written, and the outside blue card stays solid. The relaxed mutant
   (`every`: "some `<use>` alone, or none") now fails it.

**Measured** (simplify() ms, 3 runs; "step" is the metered step alone, on the parsed tree).

| Design | 1bdce28 | Now | Step |
|---|---|---|---|
| The R13 case: 1,600 tiles, one shared chain, 60 junk attributes | 7,979, refused | 62-66, refused | 25-28, spent |
| Tiles on the fill and the stroke, a 13-link chain | 1,817, refused | 36-41, refused | 6-7, spent |
| A chain painting a gradient of 4,000 other children | 4,971, refused | 17-18, refused | 6-7, spent |
| A 150 KB colour written on 2,500 shapes | 785, refused | 18-20, refused | 3, spent |
| One tile of 2,400 colours on 2,500 shapes | 100, simplified | 35-38, refused | 3-5, spent |
| A 250 KB stroke width inherited in a tile | 108, simplified | 3, refused | 1, spent |
| 1,000 lenders under 44 groups with 4.5 KB opacities | 78, simplified | 10-11, refused | 2, spent |
| 4,900 shapes, one heavy tile (the test's worst accepted case) | 67, simplified | 60-70, simplified | 8-9 |
| 1,592 shapes sharing one gradient of 3,000 children | 55, simplified | 21-22, simplified | 1.5-1.7 |

- Every crafted design is refused plain in at most 66 ms. Of that, the first `sanitize()` of the
  204 KB R13 design is 35 ms.
- The 58 saved real replies give byte-identical output to 1bdce28, as they are and forced through
  every step, and to 3e852d2 (`r13r4/scan.mjs`). In Node, simplify() takes at most 5.8 ms (19.4 ms
  forced).
- **Trade-off.** The budget counts units, not time: spending all of it took 0.3 ms to 28 ms, by walk
  (under 0.01 µs to 0.55 µs a unit). So some crafted
  designs now spend it on cheap reads and are refused, though 1bdce28 simplified them in 13-108 ms:
  40 tiles each 729 circles deep; 500 tiles of one group of 3,400 children; 20 KB values (a tile
  width, an opacity); 2,000 `<use>`s 12 groups deep; 2,400 colours on 2,500 shapes. Each was built
  to sit just over `WORK`, so that removing one charge lets it through. No saved real reply comes
  near (650 of 50,000).

**Tests:**
- New `test/stationery-simplify-budget.test.mjs`, 6 tests:
  - 14 crafted designs, each refused plain (`over`, `sanitize()`'s own price) in under 200 ms in
    Node, the least of 2 runs;
  - fails closed: a design whose filters step is kept is refused. Control (R14): with the budget
    lifted, the same design is simplified "without shadows and glows, pattern fills";
  - per call: after every refusal, both real fixtures and the shared-gradient design give the same
    result as a fresh page;
  - a gradient shared by 1,592 shapes is simplified (read once a call);
  - user flow (R6): the studio shows the R13 design's plain refusal and draws nothing;
  - MUTATION: 15 mutants, one for each charge, the throw, the per-call meter and the plain catch.
- `stationery-simplify-share`: the `MIXED` test and its `every` mutant. `tileMemo` is now killed
  by the verdict (the heavy design is refused), not by time.
- `stationery-simplify-paint`: `walkCap` and `tallyMemo` are now killed by the verdict: without
  either, the call spends its budget. A behaviour check is added: 40 nested lenders over one shared
  group are simplified, because the tally memo keeps them in the budget.
- `stationery-simplify-fit`: two mutants follow the code. `GRAD_FIRST` now uses `replaceOnce`, so
  it can no longer match nothing in silence.
- `helpers-stationery`: `TOO_COMPLEX` moved here (R3: two suites pin it). `useChain` takes extra
  attributes.

**Mutation sweep.** Same method as round 3: a fresh copy per mutant, every stationery suite, and a
kill counts only when a test that is not a MUTATION test fails.
- 77 of 78 mutants are killed, from all five simplify suites.
- The 78th removes the gradient's own charge. It is equivalent: a gradient is read once a call, at
  most MAX_NODES units, so its charge cannot spend the budget alone. It only makes a lost memo fail
  closed, and the memo's own mutant is killed.

**Still open, not done here:**
- `sanitize()`'s re-checks are not metered by `WORK`. `simplify()` runs one for each step that
  changes something, up to 8, and each is bounded by `sanitize()` itself (28-35 ms at 300 KB). A
  295 KB design that reaches the last steps takes 137-187 ms in Chromium. That is unchanged from
  1bdce28 (Node: 176 ms now, 179 ms then).
- Units are not time: a unit's cost varies about 90x between walks (see the trade-off above).

### R13 round 5 (2026-10-14): a value charged as it is, and one deadline per call (时间上限)

The review confirmed two findings and refuted none. Both are fixed. "Measured" figures come from
headless Chromium (Playwright) on this Mac, on a throwaway 127.0.0.1 page, unless they say Node.

1. **A visit charges an element's values as they are when it is read** (finding 1, blocking; new
   in round 4).
   - Round 4's `visit()` kept the size an element had the first time it was read. `lend()` then
     writes the lent colour onto the lender with `set()`. When that lender is a `<use>` target
     (`<g id="n" fill="url(#p)">`), the next lender's tallies read it again for each `<use>` of it.
     Each read ran `INHERIT` and `NONE` over the written colour, but was charged the old size,
     about 1 unit.
   - A colour with 150,000 leading spaces (legal CSS whitespace) made each read cost about 0.5 ms.
     The review's 183 KB design (2,000 `<use>`s of the target, 4,000 reads) took 2.1 s in Node and in
     Chromium. The budget ran out only after that.
   - Now a visit charges 1 unit plus the element's values at that moment, a unit per `SCAN`
     characters. Nothing is kept, so no write can make the charge stale. This also covers the other
     climbs that read a written value (`inh`, `eff`).
   - The review's design now takes 29-31 ms and is refused plain (29-32 ms with the colour on a
     gradient stop). Each read of the written colour now costs about 1,170 units, so the budget
     runs out within a few dozen reads.
   - Round 4 said spending the whole budget takes at most 28 ms. That did not hold (this finding),
     and the deadline below now bounds the whole call instead.
2. **One deadline for the whole call, as a backstop** (`SIMPLIFY_MS` = 150 ms; finding 2, minor,
   and the gap that let finding 1 happen).
   - Units are not time. A unit costs 0.01 to 0.6 µs depending on the walk, a charge can be missed
     (finding 1), and `sanitize()`'s re-checks are not metered at all. Up to 8 `sanitize()` runs on
     a 295 KB design took 162-186 ms in the review.
   - The meter now also reads a clock: `performance.now()` where there is one, else `Date.now()`.
     It reads it:
     - at the start of `simplify()`, before the first check;
     - every `TICK` (16) charges, inside each step's walks;
     - at the end of the first check, and before and after each re-check.
   - Past the deadline the meter throws `SPENT`, as for the work budget, and `simplify()` returns the
     plain refusal (`TOO_COMPLEX`, flagged `over`). It fails closed: never a partly simplified
     design. A re-check that passed but ended past the deadline is not used either.
   - A re-check that would end past the deadline is not started. It is expected to cost what the
     first check took, from the start of the call to the end of that check. So the call ends near
     `SIMPLIFY_MS`, not `SIMPLIFY_MS` plus one more check.
   - A broken clock (NaN) counts as past the deadline.
   - A design that passes as it is never meets the deadline: `simplify()` returns `sanitize()`'s
     result before the first deadline check.
   - The tests can pass their own clock (`o.clock`). It is told only where it is read: `start`,
     `walk`, `before` or `after`. The studio passes none.
   - **Trade-off: fail closed, by design.** The deadline is wall-clock time, so it depends on the
     device. A slower device, such as an older iPad, refuses a borderline design sooner. The
     review's 295 KB re-checks design, which this Mac simplifies in 120 ms, may be refused there.
     The person then gets the plain
     refusal ("try again or ask for a simpler design"), never a partly simplified design and never
     a frozen page. The saved real replies take at most 7.1 ms here (21.4 ms forced through every
     step), so the deadline is 7 or more times what they need.

**Measured** (`simplify()` ms; "now" is 3 runs. "No deadline" is the worktree with
`SIMPLIFY_MS=Infinity`, the control. "Kept size" is the worktree with round 4's `visit()`
restored, to show the deadline backing up a missed charge.)

| Design | 4cc9438 | Now | No deadline | Kept size |
|---|---|---|---|---|
| The review's design: a 150 KB colour on a `<use>` target, 2,000 `<use>`s | 2,122, refused | 29-31, refused | 30, refused | 153, refused |
| The same, with the colour on a gradient stop | 2,093, refused | 29-32, refused | 31, refused | 153, refused |
| A 4 KB colour, 1,200 `<use>`s (the kept-size test design) | 46, simplified | 20-26, refused | 24, refused | 41, simplified |
| E1: 295 KB, 8 `sanitize()` runs | 178, refused | 138-147, refused | 178, refused | 137, refused |
| E2: E1 plus 41k units of tile walk | 188, refused | 144-150, refused | 203, refused | 148, refused |
| E3: the budget spent in the pattern step | 145, refused | 150, refused | 158, refused | 146, refused |
| E4: the budget spent in the gradient step | 171, refused | 147-150, refused | 174, refused | 147, refused |
| The review's re-checks design, 295 KB | 120, simplified | 119-124, simplified | 124, simplified | 122, simplified |
| B1 HEAVY: 4,900 rects, one heavy tile | 69, simplified | 57-59, simplified | 67, simplified | 69, simplified |

- 46 designs in all: the 42 of the round 5 check (`simplify-budget/designs.mjs`) and four new
  ones (the first three rows above and the re-checks design). The slowest `simplify()` now takes 150.1 ms. On 4cc9438 the slowest
  took 2,122 ms.
- No design gives a different result now than with no deadline, on this Mac. Here the deadline
  only cut the time.
- With round 4's kept size restored, the review's design is refused at 153 ms instead of 2.1 s:
  the deadline backs up a missed charge.
- The 58 saved real replies give byte-identical output to 4cc9438, as they are and forced through
  every step (200 invisible gradient rects), in Chromium and in Node, with the real clock. In Node
  they are also identical with no deadline and with `Date.now()`. Verdicts as they are: 52 as-is,
  5 simplified, 1 refused.

**Tests:**
- New `test/stationery-simplify-deadline.test.mjs`, 8 tests. All but one use fake clocks (no real
  waits). The one that reads the real clock accepts the simplified answer or, on a loaded runner
  past the deadline, the plain refusal, so it is not timed (R13 review of round 5):
  - past the deadline at each check point (the end of the first check, before and after each
    re-check, in a step's walk, and on the limits' path), the answer is the plain refusal, and the
    clock is read no further;
  - a re-check that would end past the deadline is not started;
  - a slower clock refuses a borderline design that a faster one simplifies. A broken clock fails
    closed, and a design that passes as it is never meets the deadline;
  - the deadline is per call, and without `performance.now()` the clock is `Date.now()`;
  - user flow (R6): with a slow `performance.now()`, the studio shows an AI draft refused plain,
    and a small real draft exactly as before;
  - with the real clock, the two real fixtures, as they are and forced through every step, give
    the same answer as with no deadline (or the plain refusal on a loaded runner), and with
    `Date.now()`; `simplify(svg, null)` does not throw (R5);
  - MUTATION: 9 mutants, one for each check, the prediction, the NaN rule, the per-call meter, the
    start and the `Date.now()` fallback.
- `stationery-simplify-budget`:
  - three new crafted designs: the review's, its gradient variant, and a 4 KB one that the kept
    size lets through;
  - each crafted design is refused by the work units alone (`NO_DEADLINE`) in under 200 ms, and
    gives the same result with the real clock;
  - a new `staleSize` mutant (round 4's `visit()`);
  - the KEPT control, the per-call test, the shared-gradient test and the mutants run with
    `NO_DEADLINE`, so a verdict there comes from the units alone.
- `stationery-simplify-share` (HEAVY, `tileMemo`) and `stationery-simplify-paint` (`walkCap`,
  `tallyMemo`) read those verdicts with `NO_DEADLINE`. HEAVY takes about half the deadline here, and
  a loaded test runner could pass it.
- `helpers-stationery`: `NO_DEADLINE`, and `loadStationery({ globals })`, which shadows
  `performance` or `Date` as a page without them would.
- The `recheck` and `limitRecheck` mutants follow `recheck(next)`.

**Mutation sweep.** Same method as round 3: a fresh copy per mutant, every stationery suite, and a
kill counts only when a test that is not a MUTATION test fails. 87 of 87 mutants are killed, from
all six simplify suites.
- Two mutants were killed only by MUTATION tests until the crafted-design test also ran with no
  deadline: removing a colour's charge, and removing a tile's colour-piece charge. The deadline
  alone refused both crafted designs at 150 ms. Each charge is still needed: without it the units
  alone do not refuse those designs, and only the backstop stops them (with no deadline, the colour
  one took 556 ms in Node).

**Still open, not done here:**
- The deadline cannot stop a check while it runs. Within a step the clock is read every 16
  charges. One `sanitize()` re-check (up to about 35 ms at 300 KB here) runs to its end, and the
  prediction keeps that inside the deadline in the usual case.
- Units are still not time (round 4's trade-off). The deadline now bounds what that can cost.

## Follow-up (2026-11-25): a photo in a note as stationery · 用笔记里的图片做信纸

**What.** A photo's ⋯ menu gains 做成信纸 · Make stationery. It opens Page settings with the photo loaded in the
picture panel (作为背景 · Use as background, or AI 重绘 · Recreate with AI). A picture used as background is also
KEPT: `templates/pictures.json` (`{v:1, items:[{id, name}]}`, id = the upload path) lists it in every note's
stationery list, with the same two-tap ✕ as My templates.

**Why its own file.** `templates/index.json` holds design ids, each loaded from its own templates/<id>.json; a
picture id there would be reported as a missing template. A separate file is never read by an older build.

**Rules kept.** Same as the index: never written over a list that could not be read; a refused write is shown in
the panel (未保存到列表 · Not added to the list) while the page keeps its background. Deleting unlists only: the
upload stays, so a note that uses it still draws it. The id rule (`PIC_ID`) equals PANote's notebook stationery id
rule; test/stationery-saved-pictures.test.mjs pins that the two copies agree.

**Origin.** Written live on the owner's node by its agent (deployed base 94114845), then brought into the repo
with review fixes so the next deploy does not overwrite it.
