# Journal search（日记搜索）— design; phases 1–3 shipped

Owner, 2026-11-09: "I have more journal pages and I'd like to search handwritten notes, typed text
and pictures, maybe with tags. Design it first. Open decision: cloud models or local processing?"

## What the owner gets

One search field（一个搜索框）in the notebook list. Typing finds pages by anything on them:
typed text（文本）, handwriting（手写）, text inside a photo（图片文字）, what a photo shows
（图片内容）, and tags（标签）. Results are page thumbnails with the matched words in a snippet
and a small mark saying where the match came from (text / ink / photo). Tap opens the page.

Tags: a tag is any `#word` on the page, typed or handwritten. No tag editor, no second control.
Photo labels (slide, whiteboard, receipt, person, food, …) are searchable words, not shown as tags.

## How it works

Unit of indexing is the page. Each page gets a text bundle:

| Source | How the words are obtained | Where it runs |
|---|---|---|
| Typed text | strip `pageHtml` to plain text | node, on save |
| Handwriting | render the strokes to a bitmap, OCR（手写识别）it | node, background queue |
| Photo text | OCR the stored picture | node, background queue |
| Photo content | image classification（图像分类）→ labels | node, background queue |
| Tags | `#words` found in the above | node, on index |

Triggers. The notebook already carries a cheap fingerprint per page (strokes, images, html). On
save the node compares it with the indexed version and re-indexes only changed pages, debounced.
Nothing runs on the iPad.

Storage. `data/notes/index/<entry>.json` beside the notebook, one record per page: version, text
per source, OCR word boxes (for later highlighting), tags, labels. At startup node loads the index
files into memory; ~100 notebooks of text is a few MB, so search is in-memory, no database.

Matching. Tokens for English, character bigrams（二元组）for Chinese, prefix match, and one-edit
fuzziness（模糊匹配）because OCR mis-reads letters. Rank: tag hit, typed text, handwriting, photo;
newer page wins ties. A query like `#ores` matches only tags.

Known limits to state up front: messy cursive and dense Chinese handwriting will be transcribed
imperfectly; fuzzy matching covers single-letter errors, not words the OCR misses entirely. The
transcript is only an index; the page itself is never altered.

## The privacy decision（隐私）

| | A. Local on the Mac node | B. Cloud model (Claude) | C. Local LLM (Ollama vision) |
|---|---|---|---|
| Engine | Apple Vision（系统自带）: text recognition incl. handwriting, zh-Hans + en; image classification. A ~60-line Swift CLI, compiled once (swiftc 6.3 is installed). | Claude vision reads the page bitmap, returns transcript, tags, summary | qwen-vl class model through Ollama (installed) |
| Data leaves the Mac | No | Yes, every page bitmap, in the background | No |
| Printed / slide text | Excellent | Excellent | Good |
| Neat handwriting | Good | Best | Fair |
| Messy handwriting, context | Fair; no understanding of meaning | Best; can also summarise and suggest tags | Fair, slow |
| Cost, speed | Free, ~0.3–1 s per page | ~$0.01–0.03 per page, 2–5 s, needs network | Free, 5–20 s per page, heavy |
| Maintenance | Apple ships it with macOS | API key, quota, model changes | Model downloads, GPU memory |

Checked on this Mac, 2026-11-09 (scratch Swift CLI, 20 lines, compiled in one step): Vision lists
zh-Hans, zh-Hant and en-US among 30 languages; a test image with a handwriting-style font and a
Chinese line came back in 0.9 s including process start, `#ores` and `#灵修` intact, one letter
wrong in one word ("bandlord" for "landlord") — the one-edit fuzzy match covers exactly that.

Recommendation: A, local by default. Search needs words, not understanding, and Vision gives the
words without any journal content leaving the Mac. Cloud stays what it is today: the page's
"Ask AI" button sends one page when the owner presses it, never in the background. If local OCR
turns out too weak on the owner's handwriting, the measured fallback is a per-notebook switch
"allow cloud transcription", off by default, decided after phase 2's accuracy check. The index
files are as private as the notebooks: same folder, same backup rules, never in git.

## Phases, each shipped on its own

1. Typed text + tags. The search field, the index on save, results list. No OCR. One session.
2. Handwriting + photos. The Vision CLI, the background queue, word boxes stored. Accuracy
   check on 10 real pages of the owner's handwriting, read locally, reported as numbers only.
   Two sessions.
3. Hits highlighted on the page from the stored word boxes, and a hit opens on its matched page
   (`hit.page` through `onOpen`'s second argument; listDrawer/listAugment forward it). One session.

## Decisions (2026-11-09)

1. Local. The index is built on the Mac node; nothing leaves it. Cloud stays the explicit Ask AI
   button.
2. Tags are `#words` in the text. No tag editor.
3. Both apps from the start, through the shared components: the drawer (PAChat) asks
   `PANote.search`, and an app only tells the drawer which file and scope a row is
   (`doc:{path, scope}`). The indexer recognises a notebook by its shape wherever it sits in a
   file, so a third PANote host needs no new code.

Storage moved from the plan above: the index lives at `<workspace>/search/<slug>.json`, outside
`data/`, so the app broker's namespaced data channel cannot reach it (ADR 0023).

## Phase 1 — shipped 2026-11-09

Typed text and `#tags`, both apps. `GET /api/note-search?app=&q=` (broker kind `note-search`),
`lib/note-index.mjs` (records) and `lib/note-search.mjs` (store, lazy scan, matcher, 2 s save
debounce). Existing notebooks are indexed on the first search with no migration. Matching as
designed: tokens, Chinese bigrams, prefix, one edit on 4+ character tokens, `#word` tags only, AND
across tokens; tag hits rank above typed, newer first; ~80-character snippet; the drawer shows the
snippet and a Tag/Text chip. Not yet: handwriting, photos, highlighting (phases 2 and 3). The
Bible's older plain-text annotations (`notes[k]`, not a notebook) are not indexed.

## Phase 2 — shipped 2026-11-09

Handwriting and photos, both apps, local only. `tools/panote-ocr/panote-ocr.swift` (Apple Vision,
compiled on the node by `lib/note-ocr.mjs`), two passes over the ink (`zh-Hans,en-US` and `en-US`)
with the union indexed — measured on three real pages, neither pass alone reads a mixed line; photo
text + labels in one pass. `lib/note-ocr-queue.mjs`: one background worker, newest page first,
content hashes (`need`/`done`) decide what is owed, progress lives in the index, failures remembered
per hash and audited once (`note-ocr-failed`); an environmental failure (toolchain, timeout) ends the
burst and is retried, never pinned to a page; pictures read from `uploads/` only, 8 per page. The reply carries
`pending`, `ocr` and `reason`; the drawer says "Transcribing N pages", "failed on this node — reason" or "needs the Mac node", only while pages are owed, and re-asks once after 4 s. Rank tag >
typed > ink > photo; boxes stored per line for phase 3. Not yet: highlighting on the page, opening a
hit on its page (phase 3). Accuracy on 10 real pages was measured locally and reported as numbers in
the shipping report, not stored here.

## Phase 3 — shipped 2026-11-09

A hit opens on its matched page with the matched words marked, both apps, no app-specific overlay
code. **Reply.** Each hit carries `boxes:[[x,y,w,h]…]`, the page rectangles of the OCR lines that
hold a query token (lib/note-match.mjs `boxesFor` reuses the one matcher: prefix, one edit, bigrams,
`#tag`), converted on the node to page coordinates — x, y, w, h in page WIDTHS, origin top-left,
the unit strokes and pictures already use; the reply also carries `terms`, the query tokens as
matched. Geometry lives on the record (`geo`, lib/note-boxes.mjs): the ink bitmap's height ratio
(`max(0.3, min(maxY+0.05, 6))`, the tool's own formula, pinned to the Swift source by a test) and the
page's picture rects in sorted-path order; a photo line names its picture (`img`, written by the
queue). Index version 4: a v3 index loads with its records kept and its file stamps made stale, so the
first search re-reads every notebook once with the OCR carried — no page is transcribed again.
**Drawer.** A hit row's click passes `{page, boxes, terms}` as `onOpen`'s second argument (read at
click time from the current query); `listDrawer` and the chat ☰ list forward it. **PANote.** A new
shared component, `web/note-reveal.inline.html` (`PANoteReveal`, carried by note-ui's marker like
the Pencil recorder), owns the reveal: `pad.reveal(at)` flips to the page through the pad's own
`flipTo`, lays translucent rectangles over the boxes (px of the page's width, inside `.pan-pageInner`
so they ride a flip) and marks typed runs through the CSS Custom Highlight API — never by writing
into the text layer, whose HTML is the saved page. Everything clears at the next touch of the pad or
after 4 s. **Hosts.** Journal `openEntry(id, at)` and Bible `openDrawFull(…, at)` call `pad.reveal(at)`
after their reload, one line each, feature-detected.

Honest limits. Typed-text marking needs the Custom Highlight API (Safari 17.2+ / iPadOS 17.2+);
older WebKit opens the page without marks. A typed match is marked by plain substring of each
term: a fuzzy (one-edit) typed match and a multi-character Chinese query matched by bigrams apart
are not marked (the page still opens). Photo boxes need both the picture index on the line and the
page geometry, so photos transcribed before this phase show no rectangles until the page's pictures
change (the ink on those pages IS marked, since the ratio is recomputed from the strokes on the
one-time re-read). Rectangles are placed from the stroke extent at index time; if the page's strokes
changed since, the index is re-read on save and the boxes with it. Nothing is drawn while the pad
is hidden (width 0), and a flip already in motion is not interrupted: the pad stays where it is. The
Bible's older plain-text annotations are still not indexed.
