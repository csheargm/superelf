# ADR 0023 — Note search: a local, derived index outside data/

Date: 2026-11-09 · Status: accepted (phases 1–3 shipped; docs/plans/note-search.md)

## Context

The journal has grown past what a list can be scanned by eye, and the Bible app keeps notebooks
per verse in the same PANote component. The owner wants one search field that finds pages by typed
text, handwriting, photos and `#tags`, and asked for the cloud-versus-local decision to be made
first. Notebooks are app data the server never mutates (lib/appdata.mjs), and apps reach their data
only through the broker's auto-namespaced `data/<slug>/` channel.

## Decision

1. **Local only.** Everything that reads a notebook for search runs on the node. Phase 1 needs no
   model at all (typed text); phase 2 uses Apple Vision on the Mac. Cloud remains the explicit
   Ask AI button, never a background job.
2. **A derived index, outside `data/`.** `<workspace>/search/<slug>.json`, one per app, written
   atomically. It is regenerable from the notebooks: the first search lazily scans
   `data/<slug>/**/*.json` (never `.bak`), re-reads what changed by mtime + size, drops what was
   deleted, and reports a file that will not parse rather than skipping it. A corrupt or
   old-version index is rebuilt, not repaired. The save route only keeps it warm (2 s debounce per
   file). Being outside `data/` means no app can read or overwrite another app's index, or its own,
   through `save-data`.
3. **Generic notebook detection.** A notebook is an object whose `pages` are page objects (strokes
   / pageHtml / images / texts), found by walking a file to depth 3. The journal's root notebook and
   the Bible's `draws[scope]` are both found by shape; `scope` is the key the notebook sits under
   (`''` at the root). The indexer knows no app name.
4. **Shared integration through `doc`.** The drawer (PAChat buildDrawer) asks `PANote.search(q)`
   when it exists and shows any row whose `doc:{path, scope}` a hit names, with the snippet and a
   where-chip from `PANote.SEARCH_TXT`. An app adds one field to its rows; rows without `doc` behave
   as before. `PANote.search` uses `PAStore.ask`, the one broker round-trip every app page carries.
5. **One HTML→text rule.** `htmlToText` in lib/note-index.mjs; web.mjs's `firstLineTitle` imports it.
6. **Seams for phase 2.** A record's text is keyed by source (`src.typed`; `ink` and `photo` to
   come), the where-chip labels for ink/photo already exist, and `where` is a free string.

## Phase 2 — handwriting and photos (2026-11-09)

**Engine.** `tools/panote-ocr/panote-ocr.swift`, Apple Vision (`VNRecognizeTextRequest` .accurate,
`VNClassifyImageRequest` for labels ≥ 0.3), compiled on the node by `lib/note-ocr.mjs ensureBuilt`
(`swiftc -O` into the gitignored `tools/panote-ocr/build/`, again when the .swift is newer). One
JSON line per run, a hard 30 s timeout, `execFile` with no shell. Nothing leaves the Mac.

**Two passes over the ink, union of the lines.** Measured on three real journal pages (757–763
strokes, 1600 px render; 2400 px no better; language correction on or off no difference): pass A
`zh-Hans,en-US` reads the Chinese and garbles English words inside Chinese lines; pass B `en-US`
reads those words and drops the Chinese. Neither alone is enough, so a page's `src.ink` is the union
of both passes' lines (identical strings once), ~0.75–1.2 s per pass, ~2 s per page. Boxes are kept
per line with the pass that produced them (`boxes.ink`, for phase 3's highlighting). A photo gets one
pass plus its labels; labels are searchable words (`src.photo` + `labels`), never tags.

**Hashes, not timestamps, decide what is owed.** A record carries `need:{ink,photo}` (sha1-16 of the
strokes JSON / of the sorted picture paths) and `done:{ink,photo}` (the hash each result was computed
for). A typed-text edit reindexes the file but `carryOcr` keeps every ink/photo result whose hash
still matches, so unchanged ink is never re-read; erased ink leaves no hash and no text. A failure of
the CONTENT (`ocr_failed` from the tool, `ocr_bad_output`, `upload_path_refused`, `page_gone`,
`ocr_stale_index`) is remembered the same way (`ocrError.<source> = {hash, error, code}`), audited
once as `note-ocr-failed`, and not retried until the content changes. A failure of the ENVIRONMENT
(`ocr_unavailable`, `ocr_build_failed`, `ocr_timeout`, `ocr_spawn_failed`: `OCR_ENV_CODES`) is the
node's, not the page's: it lands on no record, ends the burst (the pages stay `pending`), is held per
process as `ocr:'failed'` with the reason, and the next kick is allowed after `OCR_ENV_RETRY_MS`
(10 min) — a page is never poisoned by a missing toolchain or a busy machine (R13 round 1 #1/#14).
`INDEX_VERSION` 3: every phase 1 index rebuilt itself.

**The queue** (`lib/note-ocr-queue.mjs`): one worker per process, one page at a time, newest
`updated` first, awaiting `setImmediate` between pages; started by a search that finds work (an old
node backfills on its first search, no migration) and by the save hook once a file is indexed. The
index on disk is the progress record: writes are debounced 2 s and always at the end of a burst, and
every write re-loads the file first and lands the unsaved results on that copy, because the save hook
writes the same file between two pages. The notebook file itself is parsed once per burst (cached by
mtime + size; a save in between is seen) and re-read through the same judged reader as the indexer
(`readDataFile`: no link, size cap). Pictures are read from `<ws>/uploads/<path>` only (`UPLOADS_DIR`,
lib/appdata.mjs, shared with the upload route), judged like every workspace path (inside by text, no
link on the way), else `upload_path_refused`; at most `OCR_MAX_IMAGES_PER_PAGE` (8) per page, the rest
noted as `ocrSkipped`. Backstop: a record still owed after `OCR_MAX_PICKS_PER_BURST` (3) turns of one
burst is marked `ocr_stale_index` at its hash and the burst goes on, never spinning until restart;
`findNotebooks` keeps one notebook per scope (first wins) so a record key is unique in its file.

**Reply and drawer.** `/api/note-search` adds `pending` (pages of this app still owed), `ocr`
(`ready` | `building` | `failed` | `unavailable`) and, with `failed`, `reason` (the node's words, e.g.
the compiler's first stderr line); `PANote.search` passes them through. `ready` is a built binary or a
`note_ocr_cmd` that runs — swiftc's presence proves nothing (every Mac has the xcode-select shim), so
the first kick without a binary reports `building`, then `ready` or `failed`. Under the box, ONLY
while pages are owed (`pending > 0`): `Handwriting transcription failed on this node — <reason>`,
else `Handwriting search needs the Mac node` when `unavailable`, else `Transcribing N pages`; the
truncation line wins over all; a node with no ink pages says nothing. A reply with `pending > 0` is
asked once more after 4 s with the same text (one refresh, not a poll), so a page transcribed
meanwhile appears without a keystroke. Rank: tag > typed > ink > photo (`SCORE`), `where` is the
best source, the snippet comes from that source. Config `note_ocr_cmd` stands in for the built tool
(the test harness points every server at `test/fixtures/fake-panote-ocr.mjs`, so no test runs Vision
in the background; the one real-Vision test is gated and skips elsewhere with its reason). The child
gets a minimal environment (`PATH`, `HOME`, `TMPDIR`, `LANG` plus `OCR_*`), never the server's.

## Phase 3 — a hit opens where it matched (2026-11-09)

The node converts, the page draws. Each hit carries the page rectangles (`boxes`, in page widths,
origin top-left — the unit strokes and pictures already use) of the OCR lines that hold a query
token, chosen by the SAME matcher that ranked the record (lib/note-match.mjs `boxesFor`), and the
reply carries the matched `terms`. The conversion needs the page's geometry, so a record now holds
`geo` (lib/note-boxes.mjs: the ink bitmap's height ratio, restated from the Swift tool and pinned to
its source by a test; the picture rects in the one sorted order the queue reads them) and a photo
line names its picture (`img`). Index version 4 migrates in place: a v3 index keeps its records and
forgets its file stamps, so the first scan re-reads every notebook once with the OCR carried — a
rebuild from empty would have transcribed every page again. The reveal is a shared PANote component
(`web/note-reveal.inline.html`, carried by note-ui's marker): `pad.reveal({page, boxes, terms})`
flips through the pad's own `flipTo`, lays rectangles inside `.pan-pageInner` (px of its width) and
marks typed runs with a CSS Custom Highlight — never by writing into the text layer, whose HTML is
the saved page. The drawer hands the hit to `onOpen` as a second argument at click time; a host
calls `pad.reveal` once after its reload. Limits are in the plan's phase 3 section.

## Known limits

Vision runs on macOS only: a Linux node indexes typed text and reports `ocr:'unavailable'`, and
its ink pages stay `pending` until a Mac node reads the same workspace. A Mac without the Command
Line Tools reports `building` once, then `failed` with the compiler's line; the pages stay pending
and are transcribed once the toolchain is installed (retried at most every 10 min, or at once when
the .swift changes). Environmental failures are retried, content failures are not (until the page
changes). OCR accuracy on messy or dense handwriting is imperfect (the one-edit fuzziness covers a
wrong letter, not a missed word); the transcript is an index, the page is never rewritten. The first
backfill of ~50 ink pages takes ≈ 2 min at ~2 s/page, in the background; each page costs the loop
one Vision wait plus one notebook parse per file per burst (bounded by the 16 MB data cap). A page's
picture that is not under `uploads/` is refused, not read; a page with more than 8 pictures has the
rest skipped and counted. The Bible's older plain-text annotations are still not indexed.

Phase 1 limits that still hold: an ink-only page has no text until the queue reaches it. The Bible's older
plain-text annotations (`notes[k]`, strings, not notebooks) are not indexed. A multi-character
Chinese query is matched by its bigrams, so `祷告恩典` does not find a page that has `祷告` and `恩典`
apart — separate them with a space. Fuzziness is one edit on tokens of four or more characters, not
transpositions. The query is cut at 200 characters (the one cost backstop). The index holds the
typed text of every page in plain JSON under the workspace: as private as the notebooks, same
folder rules (no write or read through a link on the way: `data/` or `data/<slug>` that is a link is
refused with a code, a link entry below it is skipped and reported once), never in git. A journal
entry still in the pre-notebook `{text, draw}` shape is indexed as the root's notebook (scope `''`,
`text` appended to page 0 as the app's migrateEntry does); the drawer treats a row `doc` without a
`scope` property as claiming any scope in its file. An index that loads but throws in the matcher is
reset and rebuilt once on the request path (audited as `note-index-failed`, code `index_reset`). The first search parses
every notebook of the app synchronously on the request path (~0.7 s per 60 MB, measured on the
owner's node 2026-11-09); a data file over `APP_DATA_MAX_BYTES` (16 MB) is skipped and reported
once. The seam if a data folder grows 10x: run the first scan at startup or in a worker. Hits are
one per notebook (its best page), at most 50; when the cap cut real matches the drawer says so under
the box. A page still in the pre-pageHtml `texts[]` shape is read box by box, top to bottom, as
PANote migrates it.
