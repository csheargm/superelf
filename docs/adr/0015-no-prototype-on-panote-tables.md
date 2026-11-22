# ADR 0015 — No prototype (原型) on PANote's tables keyed by a notebook's or the store's text

Status: accepted · 2026-10-13. This finishes the list in ADR 0003, "Follow-up — prototype (原型)
lookups outside the sanitizer", Consequences: the sites in `web/note-ui.inline.html` that it found and
did not fix.

## Context

- A lookup in a plain `{…}` literal finds the members of `Object.prototype`. So a key of `constructor`,
  `toString`, `valueOf`, `__proto__` or one of the other 8 names passes a membership check (成员检查), and a
  map keyed by one returns a function or `Object.prototype` instead of nothing.
- `note-ui` serves the Journal, the Bible and every other PANote host. The Journal's notebook can be
  written by the app's confined AI turn (ADR 0002). So a page's id, an image's path, a template name and
  the HTML of a page's text can all come from model output.
- Every `X[key]` lookup and every `in X` test on a plain object in `note-ui` was listed. The scan in
  Tests found the names, and each site was then read. The scan names 17: the 16 below, and
  `STATIONERY_SRC`, which ADR 0003 fixed.

| Table or map | Keyed by | Who sets the key | Before the fix (measured) |
|---|---|---|---|
| `undoStacks`, `redoStacks` | a page's id | the notebook | A page id of `constructor` (or any of the 12): every stroke on that page threw a TypeError in `pushUndo`. Nothing could be drawn there. |
| census `pages`, used by the shrink guard (缩水保护) | a page's id | the notebook | A page id of `__proto__`: the page's record became the map's prototype, and `for…in` walked its fields. Every write was refused with "a page disappeared", so the note could never be saved. When a page named after any of the other 11 vanished, the write was NOT refused. |
| `imgCache` | an image's path | the notebook | A path named after a prototype member: the photo stayed a grey placeholder for good. Inserting a photo whose uploaded path was `__proto__` (`primeImage`) replaced the cache's prototype, so the photos at the paths `img` and `ready` then stayed grey. |
| `VALID_TPL` | `template` | the notebook; the host's `opts.template` | `template: "constructor"` was kept, then drawn as ruled paper with a margin. |
| `LOAD_NOT_FOUND` | the store's reply code, lower-cased | the shell's broker, or an app's own store | `constructor` and `__proto__` read as "nothing there". The pad opened a blank note and unlocked writes over the real one. The other 10 names are not all lower case, so they cannot match. |
| `HTML_DROP`, `HTML_TAGS` | an element's `tagName` | a page's HTML; a paste | `<p>a<svg><constructor>b</constructor></svg>c</p>` became `<p>ac</p>`: the text was dropped, not unwrapped. With only `HTML_TAGS` plain, `createElement` threw InvalidCharacterError. |
| `VALID_TOOL` | `opts.tool` | the host (app code) | `tool: "constructor"` became the opening tool. |
| `ICON`, `ICON_FILL`, `INKS`, `RULED_TPL`, `MARGIN_TPL`, `STYLE_OK`, `byKind` | a code constant, a tool id, a template already gated, the table's own keys, a selection item's kind | no input reaches them | — |

- Only `constructor` can be a `tagName` here. This was measured in Chrome 155 (headless, 2026-10-13):
  - inside `<svg>` or `<math>` the tag keeps its lower case, `constructor`; in HTML it is `CONSTRUCTOR`;
  - the parser lower-cases `<toString>` to `tostring` and `<valueOf>` to `valueof`;
  - `<__proto__>` opens no tag at all.
- Two lookups are not on tables, and are unchanged:
  - `escapeHtml`'s inline `{…}[c]`, where `c` is one of `&`, `<`, `>`;
  - `'data' in m`, a fixed name tested on a broker reply.

## Decision

1. Every table and map in the list has no prototype.
   - A table is `Object.assign(Object.create(null),{…})`, as in ADR 0003. `INKS` and `VALID_TOOL` wrap
     their `Object.fromEntries(…)` the same way.
   - A map filled by key is `Object.create(null)`.
   No lookup site changed, except the two string checks in point 3.
2. The undo maps are reset in one place, `clearHistory()`. The declaration and the three resets in
   `pull()` call it. A reset written as `{}` again is named by the invariant (Tests).
3. A gate whose key comes from outside also requires a string. A lookup turns `["grid"]` into `"grid"`.
   - `freshNotebook` now checks `opts.template`.
   - `OPEN_TOOL` now checks `opts.tool`.
   - `validTemplate` already checked the notebook's `template`.
4. Page ids are NOT checked in `sanitize()`. A list of forbidden ids would be this bug class again, and
   rewriting ids would change existing notes on load. With prototype-free maps, every id is an
   ordinary key.
5. `note-ui` did not grow (R4): 4166 lines before and after. Every change is in place, on its own line.

## Tests

- `test/note-proto-keys.test.mjs` runs the user flows (R6). Its harness runs this code VERBATIM from
  `note-ui`: the DOM-free core (`sanitize`, `LOAD`, `makeSaveGuard`, `census`), `pull()`, the guard as
  `Note()` builds it, the stroke pipeline, the undo block, `delPage` and the image cache. Stubbed: canvas
  drawing, the text region and its HTML parser, the save pill and curtain, and timers. The timers are
  inert, so every write is an explicit `flushSave()`. The fake store reads back what it last took.
  - For each of the 12 names as a page id: the notebook loads, takes a stroke, undoes it, redoes it and
    saves it.
  - Pages `constructor` and `__proto__`: a stroke, a page turn, undo, a deleted page, then a reload.
  - A page id of `__proto__` saves. A page named after any of the 12 that vanishes on its own is still
    refused.
  - A read that fails with any of the 12 as its code keeps the pad locked, and nothing is written. The
    control: `not-found` still opens a new note.
  - A stored template named after any of the 12, or `["grid"]`, opens as the legacy `ruled` and is saved
    so. The same from the host gives a new note `plain`.
  - A photo whose path is any of the 12 is drawn, and so is an ordinary one beside it.
  - A photo inserted with the path `__proto__` is drawn, and the photos at `img` and `ready` still are.
- `test/note-proto-gates.test.mjs`:
  - `opts.tool`, including `["text"]`;
  - `cleanInto` on a tree shaped as Chrome parses the `<svg><constructor>` case. The fake
    `createElement` applies the DOM's name check, so a bad tag name throws as in a browser (R14);
  - the invariant over ALL of `note-ui`, comments stripped: no plain-object table is indexed with `[ ]`
    or tested with `in`.
- `test/helpers-proto.mjs` holds the shared pieces (R3):
  - `PROTO_KEYS`, moved here from `helpers-stationery.mjs`;
  - `plainIndexed`, the scan. What it counts as a table and as a lookup, and its limits (what it
    misses and its false alarms), are listed in the helper's comment. The shape test in
    `stationery-proto-keys` pins every case the comment lists, so the comment cannot drift from the
    scan. It is a regex, not a parser: the lists are the KNOWN cases, not a proof that there are no
    others. What it must do is hold the invariant on the shipped files, and the mutation tests show
    it names every table there;
  - `oldTable` and `plainAgain`, for the mutations.
- `test/stationery-proto-keys.test.mjs` uses the same scan. Its entry for `note-ui`'s stationery gate is
  gone, because the `note-ui` invariant covers it. The broader scan finds nothing new in the
  stationery files.
- Mutation tests:
  - each gate and map: the old plain table is put back, and the same input fails as it did before;
  - each string check: removed, and the array gets through;
  - the invariant: every prototype-free table made plain again, as `{…}` and as `Object.assign({},…)`.
    Both times it names all 17. A reset in `pull()` written as `undoStacks={}` is named too.
- The regex extractors in 8 suites were updated for the new declaration shapes. Where they could, they
  were made shape-agnostic.
- Against the code before this fix, 21 of the 22 new tests fail:
  - 11 fail on the bug itself;
  - 10 are mutation tests whose target text does not exist there yet;
  - the one that passes checks that the scan names the plain tables, which were already plain.

## Consequences

- Every table and map in `note-ui` that is looked up by text has no prototype. The invariant keeps it so.
- The Notes and Bible apps' live path is fixed by this change. Each of their six copies
  (`workspace/apps/`, `shared-apps/`, `workspace.example/apps/`) carries `<!--PA_NOTE_UI-->` and uses
  `PANote.LOAD`.
- Each copy also kept a FALLBACK `PA_LOAD` with its own plain `NOT_FOUND_CODES`. It is deleted from
  four of the six, and the shelf's two follow at the next promote: Amendment, below.
- Decided, not deferred: no `has(T,k)` helper for `typeof k==='string'&&TABLE[k]`. It appears at four
  gates in `note-ui`: three ternaries (`freshNotebook`, `validTemplate`, `OPEN_TOOL`) and one negated
  term (`validStationery`). A helper returning a boolean would fit all four. It is not added because
  it would put one more line in a file far over its budget, to replace an expression that is short,
  sits next to its own table, and is pinned by its own mutation test at every gate.
- Still allowed: a page id that is not a string is kept (`p.id||genId()`), so two pages whose ids are
  objects share one key. This is not a prototype lookup, and it is out of scope here.

## Review (R13, 2026-10-13)

A fresh reviewer, given only the rules and the diff, said NOT BLOCKING. It found no missed site, and it
measured 19 of the then 20 new tests failing against the code before the fix. Its findings:

- **The scan missed more than it said** (`id in now.pages`, `T?.[k]`, `T [k]`, `({…})`,
  `Object.assign({a:1},x)`), and its stated limit "a spread" was wrong. The scan now finds all of
  these, and the shape test pins each one. The real limits are stated: Tests, above.
- **The app copies were described wrongly**, and `workspace/apps/` was left out. Corrected:
  Consequences, above.
- **"No lookup site changed" contradicted point 3.** Reworded.
- **One mutation was written out twice.** It is now one constant, and so is the image cache's.
- **The `primeImage('__proto__')` effect was claimed as measured, with no test.** Now tested: the
  photo-insert case in Tests.
- **The string check repeats at four gates.** Decided against a helper (Consequences).

## Amendment — the apps' fallback copy of the LOAD rule is deleted (2026-10-13)

### Context

- The Notes and Bible apps had `PA_LOAD=(PANote is on the page)?PANote.LOAD:{…a copy…}`. The copy
  carried its own `NOT_FOUND_CODES`, a plain literal, so it still read the codes `constructor` and
  `__proto__` as "nothing there".
- The copy could never run. Every copy of both apps carries `<!--PA_NOTE_UI-->` before its only script.
  Each app also reads `PANote` unguarded at load (`PANote.PHOTO_TXT`) and mounts a pad
  (`PANote.panel` or `PANote.fullscreen`), so a page without PANote throws before it can open a note.
- The copy's own comment said to delete it "the day that template adopts the engine". The Bible template
  had adopted it.
- `test/app-load.test.mjs` said the copy was identical to the engine's `LOAD`. Its reply table had
  neither code, so it stayed green while they differed.

### Decision

- The fallback is deleted from the template and the live copy of each app (`workspace.example/apps/`,
  `workspace/apps/`, Notes and Bible). Each has `const PA_LOAD=PANote.LOAD;`. This removed 100 lines,
  and the not-found codes now have one home, `LOAD_NOT_FOUND` in `note-ui` (R1, R3).
- `shared-apps/` is not edited. It is the owner's release shelf: only promote, rollback and unshare
  write it, and each copy carries a hashed file manifest (`lib/sharedapps.mjs`). Its two copies keep the
  dead fallback until the owner next promotes Notes or Bible from the live copy. It cannot run there
  either, for the same reason.
- A page without PANote now fails at load with a ReferenceError (`PANote` is not defined), as it
  already did a few lines later.
- The live copies in `workspace/apps/` change on the node at its next deploy of main. That is
  behaviour-neutral: the deleted code could not run there.
- `test/data-core-timer.test.mjs` ran the data core with `LOAD: undefined`, so it ran on the fallback.
  It now runs on the engine's `LOAD`.

### Tests

- `test/app-load.test.mjs`, in place of the parity test:
  - every app's `PA_LOAD` IS the engine's `LOAD`; with no `PANote` binding at all, as on a page without
    note-ui, the app's data core throws a ReferenceError naming PANote; and no app carries
    `NOT_FOUND_CODES`. With the fallback put back, the throw check fails;
  - user flow (R6), through each app's own reader: a read that fails with any of the 12 names as its
    code is `failed`, and the write after it is refused. The control: `not-found` is `absent`, and the
    write goes through;
  - mutation: with the engine's old `LOAD_NOT_FOUND` (`engineModule` in `helpers-app` now takes a
    mutation), the codes `constructor` and `__proto__` unlock that write, in each app.
- Measured in Chrome 155 (headless), on both live apps built the way `sendAppHtml` builds them:
  - no script error;
  - `PA_LOAD===PANote.LOAD`;
  - the codes `constructor` and `__proto__` are `failed`, and `not-found` is `absent`.

## Review (R13, round 2, 2026-10-13)

A fresh reviewer read the round-1 fixes and this amendment. It said BLOCKING on one rule, and confirmed
the rest: the fallback could not run, leaving `shared-apps/` alone is right, and the new tests run
shipped code. All its findings are fixed:

- **Blocking (R4):** `test/app-load.test.mjs` and `test/helpers-app.mjs`, both over budget, grew with no
  TODO. Each now names its split seam.
- **Stale comments:** `test/split-view.test.mjs` still described the deleted fallback, and said the
  Bible template has no PANote. Both rewritten.
- **TypeError was the harness, not the page.** `coreModule` with no `panote` argument now runs the
  data core with no `PANote` binding, and the test asserts the ReferenceError a page would throw.
- **The scan's limits were incomplete.** It now also finds a logical default (`x||{}`, `x??{}`,
  `c&&{…}`), a compound assignment (`||=`, `??=`), a space before `(`, nested parentheses,
  `Reflect.get/has` and `in (T)`. What it still misses and its false alarms are listed in the helper
  and pinned by the shape test. It still finds nothing in `note-ui` or the stationery files.
- **The `has(T,k)` rationale was wrong, and `validTemplate`'s string check had no mutation test.** The
  rationale is restated (Consequences), and the mutation test is added.
- **"Six copies… deleted" was loose wording**, and so was the data core's "byte-identical in every
  copy". Both now say four copies, and that the shelf's two follow at the next promote.
- **The live copies change at the next deploy.** Stated in the amendment's Decision.
- **The "mutate, then check it changed something" rule was copied at each extraction.** It is now
  `mutated()` in `helpers-app`, used by `engineModule`, `guardModule`, `runApp` and both proto suites.
  The 23 inline copies in other helpers and suites are listed in a `TODO(R3)` there, for a
  refactor-only session (R8).

## Review (R13, round 3, 2026-10-13)

A fresh reviewer read round 2's commit and said NOT BLOCKING. It confirmed the ReferenceError check
fails with the fallback restored, and that the four data cores are still byte-identical. Its findings,
all fixed:

- **The scan missed defaults its comment implied it found:** `(x||{})`, `(x)||{}`, `f()||{}`,
  `a[0]||{}`, `a||b||{}`, `a?.b||{}`, and `( ({…}))`. It now finds all of them. A default whose left
  side holds `,`, `=`, `<`, `>`, `{` or `}` is listed as a miss and pinned. `&&=`, a reused name and a
  label are pinned too.
- **"One copy of that rule" was false:** 23 inline copies remain elsewhere (rounds 4 and 6 corrected
  the count from 18). The comment says where `mutated()` is used and lists the rest in a `TODO(R3)`.
- **`test/split-view.test.mjs`** said no app has a guarded read. Apps do (`window.PAChat&&…`); none has
  a guarded PANote read. It also said the Bible mounts `PANote.fullscreen`; it mounts `PANote.panel` or
  `PANote.fullscreen`, one per `mountHost()`. Both corrected, here too.
- **`test/app-load.test.mjs`'s R4 TODO** left out §6 and §7 and sat inside the imports. It now names
  every section and follows the imports.
- **The data core's header** said "each app's template and live copy". The test holds all four copies
  identical, across Notes and Bible. Corrected in the four copies.

## Review (R13, round 4, 2026-10-13)

A fresh reviewer read round 3's commit and said NOT BLOCKING. It confirmed the scan names the same
tables as before on every shipped file, in both mutation shapes. Its findings, all fixed:

- **A default with its operator on the next line** (`x\n||{}`) was no longer found. Found again, and
  pinned.
- **Three false alarms were unlisted**, and one contradicted a listed miss: a value computed from a
  default (`make(x||{})`, `Object.keys(o||{})`, `(o||{}).p`). Listed and pinned; the miss now says
  `make()`.
- **Three of the six left-side characters were not pinned as misses.** `<`, `{` and `}` are now.
- **`in(T)` and `Reflect.get (T,k)` were missed.** Found now, and pinned.
- **The `TODO(R3)` list missed `note-whole-file` (3) and `app-bar-peek` (1).** Listed; the count is 22.
- **`test/split-view.test.mjs`:** "no app has a guarded PANote read" now says "no app this test scans",
  as the shelf's copies still have one until the next promote. A stale sentence about wiring "only
  the chat slot" is deleted.
- The scan's comment and this ADR now say it is a regex, not a parser, and that its lists are the
  known cases.

## Review (R13, round 5, 2026-10-13)

A fresh reviewer read round 4's commit and said NOT BLOCKING, with no code defect. It cross-checked
the scan against a real parser (TypeScript's) on `note-ui` and the five stationery files: both name
nothing as shipped, and the same 17, 2 and 6 tables when they are made plain again. It counted the
inline mutation checks itself (22 by their message; round 6 found a 23rd by shape). Two stale
comments, both fixed: `helpers-proto`'s list of the suites that use it now includes `app-load`, and
the shape test's comment names round 4's cases.

## Review (R13, round 6, 2026-10-13)

A fresh reviewer read round 5's commit and said NOT BLOCKING. Its one finding: `app-bar-peek` checks a
mutation a second time under other words (line 221), so the `TODO(R3)` count is 23, not 22. A search
by the check's shape on shipped source (`notEqual` on the mutated and the original source), not by its
message, finds no other. Corrected in `helpers-app` and above.

Round 7 (a fresh reviewer, NOT BLOCKING) verified the 23 sites line by line and found no other shape
of the check. Its two nits, both fixed: the round-6 paragraph above now says "on shipped source",
because `config-live-reload` makes the same comparison on a test config file; and two paragraphs
above were rewrapped.

Round 8 (a fresh reviewer, NOT BLOCKING) confirmed the 23 sites again, that the rewraps changed no
words, and that no prose line exceeds 105 characters. Its one nit: the round-7 paragraph said "this
paragraph" for the round-6 one. Fixed.
