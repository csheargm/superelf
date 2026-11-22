# Note features（笔记功能）— transcript, tags, hits, bookmarks, AI period summaries

Owner, 2026-11-09 (abridged): "while it transcribes, can the transcription be saved/viewed? will
there be tags? a search shows which notes match but not where; a tag on the note would let me go
direct. I write reflections and todo lists and want a bookmark. An Ask AI that summarises my
reflections for a year / month / week, saved as a note of a special type with its own bookmark."

Design only; no code changed. Numbers measured on the owner's node 2026-11-09 (counts only):
journal 101 files, 87 indexed pages, 7.5k typed + 19k ink + 30k photo characters, 5 pages carry a
tag (7 distinct), index 665 KB; pages per month Aug 3, Sep 32, Oct 37, Nov 15; journal.json has 37
entries (16 renamed, 10 with a chat). Bible: no index built yet (no search run there).

Wording: this repo writes English then 中文 (`PANote.SEARCH_TXT`, web/note-ui.inline.html:4274;
`'Ask AI · 问一问'`). No Chinese-first rule exists in this repo (grep of superelf.md, docs, apps);
the Chinese-first rule belongs to the separate scripturetolife app. New strings follow the
English-then-中文 style here.

## The three stores, and what may live where（三个存储）

| Store | Owner | Written by | Survives an index rebuild | Holds |
|---|---|---|---|---|
| Note file `data/notes/entry-<id>.json`, Bible `data/bible/notes/<b>-<c>.json` | app | the app only (ADR 0023: the indexer never rewrites a note) | yes | pages, strokes, pageHtml, images; Bible also `notes`, `titles`, `chat` per scope |
| Journal entries index `data/notes/journal.json` (notes/index.html:289) | app | app, 600 ms debounce (:364) | yes | `id,title,created,updated,preview,derived,chat` |
| Search index `<ws>/search/<slug>.json` (lib/note-search.mjs:21,32) | node | indexer + OCR queue | NO — derived, rebuilt on version bump or corruption | per page `src{typed,ink,photo}`, `tags`, `labels`, `boxes`, OCR state (lib/note-index.mjs:178) |

Rule used below: anything the owner SETS (a bookmark, a rename) is app data in the journal index
or the Bible chapter file; anything DERIVED from the page (tags, transcript, hit positions) is
read from the search index and never copied into the note. The note file changes only when the
owner writes on the page.

## A. Transcript view（转写查看）

Today. The OCR text exists only as index text: `src.ink`, `src.photo`, `labels`, per-line
`boxes` (lib/note-index.mjs:146-150). The owner sees it only as an 80-character snippet
(lib/note-match.mjs:14) when a search hits. The drawer says "Transcribing N pages" while owed
(web/chat-ui.inline.html:533-534). Nothing shows a page's own transcript or its OCR state.

Options.
1. New broker kind `note-text {path, scope, pages?}` → `{ok, pages:[{page, src, labels, boxes,
   pending, error?}]}` served by a `GET /api/note-text` route beside `/api/note-search`
   (web.mjs:1688), reading the index through `ensureIndexed` (lib/note-search.mjs:156) — one
   record per page, no model, no file write. Recommended: E needs the same call for many docs.
2. Extend `note-search` with `path=` returning records instead of hits. Fewer kinds, but the
   route's contract ("hits, truncated, pending") would fork on a parameter; the kinds test
   (superelf.md:287) needs an entry either way.
3. Store the transcript in the note file. Rejected: the indexer never writes a note (ADR 0023),
   a transcript is stale the moment ink changes, and a rebuild could not restore it.

UI. One row "Transcript · 转写" in the page-settings sheet (`.pan-hmore`, web/note-ui.inline.html:
1424), where template and background already live, because a transcript is a property of the
PAGE. It opens a read-only, selectable text panel: ink lines, then photo text, then labels, with
the state line at the top (`Transcribing · 识别中`, `Failed on this node — reason`, `Needs the Mac
node`). Copy is the owner's act (select, copy, paste into the note; PANote's paste path exists,
:2302). No "insert as text" button in phase 1 — ask again after use. Both apps get it, since
PANote is shared and the kind is app-neutral (path + scope).

Privacy: no model. The text is Apple Vision's output already on the node.
Effort: 1 session (route + kind + panel + tests mirroring test/note-search-route.test.mjs).

SHIPPED (branch note-text-tags, option 1): `GET /api/note-text?app&path*&scope?&fields?` (web.mjs,
lib/note-text.mjs) and the kind `note-text` (web/index.html relay, superelf.md Kinds + contract);
PANoteText (web/note-text.inline.html, marker in note-ui, registered in web.mjs) owns the client
and the panel; the row `Transcript · 转写` sits first in the page-settings sheet; `pad.transcript()`
is on the pad API. Both hosts (live + template) pass one line, `doc:()=>…` — PANote did not know
which file its notebook is (noteKey() is an id, not a path), so this is the one host edit.
Honest limits: the panel lists EVERY page of the note that has ink, a picture or an owed OCR (the
current page is not scrolled to); a blank Journal page not yet saved says `Save the note first`;
typed text is not shown (it is on the page); no "insert as text" (by design, ask after use).
Tests: test/note-text.test.mjs, note-text-route.test.mjs, note-text-shell.test.mjs, note-text-panel.test.mjs.

## B. Tags（标签）

Tag rule tightened 2026-11-10 after the owner's live list showed `#1`, `#s` and `#e33723616` (a
handwritten stroke the OCR read as a hash plus digits): a tag starts with a letter, is 2+ characters
and carries at most 2 digits (lib/note-index.mjs `looksLikeTag`). So `#2026` is not a tag; `#q3`,
`#week42`, `#灵修` are. Index version 5 re-reads every notebook once (OCR carried) to apply it. The
search box has a × that clears the tag or query in one tap.

Today. A tag is any `#word` in typed, ink or photo text (lib/note-index.mjs:94-95, derived in
`finishRecord` :135). `#word` queries match tags only (lib/note-match.mjs:56) and rank first
(:18). The drawer shows a `Tag 标签` where-chip ONLY on a hit row (web/chat-ui.inline.html:560);
with an empty box no tag is visible anywhere. No tag editor, by decision (note-search.md:81).

Options for showing tags on the row.
1. The app stores tags in its index (journal.json `tags[]`, computed from pageHtml on save).
   Typed tags only — handwritten `#灵修` would never show. Two tag rules (R3). Rejected.
2. The drawer asks the node once per open/refresh: `note-tags` → `{docs:[{path,scope,tags}]}`
   (or `note-text` with a `fields=tags` flag), joined to rows by the existing `sameDoc`
   (web/chat-ui.inline.html:527). One tag rule, ink and photo tags included, both apps, no
   per-app code. Recommended.
3. Only show tags inside search results (status quo plus a tag list under the snippet). Cheap,
   but does not answer "go direct without another search".

UI. On each row, up to 3 tag chips after the `Note` chip (`.pac-lchip`, :559), `+n` beyond.
Tapping a chip sets the search box to `#word` and runs the existing search path (`onSearchInput`,
:759): tag-only matching already exists, no new filter code, and the box shows what is active
(clear it to go back). Under the search box, when it is empty, one line of the most-used tags
(top 8 by page count) as the same chips — the "go direct" entry. Rows and strip read the same
reply. Chinese tags are tags already (`#灵修`); the chip shows the word, not a translation.

Data: tags stay derived, in the search index only. A rebuild recomputes them.
Privacy: none; the reply is index data.
Effort: 1 session (kind + route + chips + strip; shares the route with A if `note-text` carries
a `fields` list, so build A and B in one session if the route is written first).

SHIPPED (same branch, option 2): PADrawerTags (web/drawer-tags.inline.html, marker at the end of
chat-ui, registered in web.mjs) asks `note-text {fields:['tags']}` once per drawer refresh — every
file, tags only — and joins rows by the drawer's `sameDoc`; up to 3 chips after the Note chip, `+n`
beyond; a strip of the top 8 tags (by page count) under the empty box; a tap sets `#word` and runs
the existing search; the strip leaves while the box has text. No app code: both drawers already pass
`doc`. Honest limits: the chips refresh with the LIST (open, ↺, wake), not when the save hook
reindexes — a tag typed a moment ago shows after the next refresh; a failed tags read shows no chips
and no sentence (the next search says the index failure under the box, same index); the strip
shows no page counts. Tests: test/drawer-tags.test.mjs.

## C. Where the keyword is（关键词位置）

Phase 3 (being built now): a hit opens on `hit.page` and highlights the stored ink/photo boxes
(docs/TODO.md:24-29, boxes from lib/note-index.mjs:150). What remains after it:

1. Typed text has no boxes. Highlight the matched runs in the rendered text layer with the CSS
   Custom Highlight API (Safari 17.2+, iPadOS 17+) — a `Highlight` of `Range`s over text nodes,
   NO `<mark>` in the DOM, because `commitPageHtml` (web/note-ui.inline.html:2307-2316) persists
   `textLayer.innerHTML` and a mark would be saved into the note. Fallback where unsupported:
   scroll to the first match only. 1 session.
2. One hit per notebook hides the other pages (lib/note-match.mjs:84). Carry `pages:[n…]` with
   the hit; the pad shows "match 1 of 3 · next" in the save-status strip while a search is
   active, stepping pages. Half a session, after 1.
3. Snippet per matched page and photo boxes mapped into the picture's frame (`images[].x,y,w` vs
   the OCR's image pixels). Half a session.
4. The Bible's older plain-text `notes[k]` are still not indexed (docs/TODO.md:17). Decide
   migration separately; not part of this.

Privacy: none. Effort: 2 sessions total, after phase 3 ships.

## D. Bookmarks（书签）and note types（类型）

Today. Nothing. The drawer has sort (created/updated, web/chat-ui.inline.html:605-614), tabs in
the chat drawer only (:490), a ⋯ sheet with Rename/Delete (:579-596), and multi-select (:598).
The journal row carries `title, preview, chip, updated, created, ai, doc` (notes/index.html:
548-553); the Bible row the same shape from `notes-list` (web.mjs:1640-1683, bible/index.html:950).

Is a bookmark a tag? Honest comparison:

| | Reserved tag `#bookmark` written on the page | Explicit flag in app data |
|---|---|---|
| New storage | none | one boolean per note |
| Ink-only page | must write on the page | one tap |
| Toggling off | erase the word (changes the note; `updated` moves) | one tap, note untouched |
| Survives index rebuild | yes (it is content) | yes (app data) |
| Discoverable | only if the owner knows the word | a ★ in the ⋯ sheet and on the row |
| Searchable | `#bookmark` | filter chip |

A bookmark is a reader's mark, toggled often, on pages the owner may never type on; it must not
alter the page. Recommendation: an explicit flag, not a tag. A note TYPE (`summary`, `reflection`,
`todo`) is the opposite: set once by whoever creates the note, descriptive of the content, and
wanted as a search word. Recommendation: types are plain tags in the note's first line
(`#summary`, `#反思`, `#todo`) — zero new mechanism, indexed by the existing rule, shown by B's
chips, filtered by B's strip. Two mechanisms, each for what it is. The one-mechanism alternative
(everything a tag) is fewer concepts but makes bookmarking an ink page a writing act and makes
"unbookmark" an edit; the owner's "bookmark so I go direct" is served better by the flag.

Data shape.
- Journal: `journal.json` entry gets `pin:true` (absent = not). Written by `writeIndexNow`
  (:364), the file the app already owns. Never in the note file.
- Bible: the chapter file gets `pins:{[scope]:true}` beside `titles:{[scope]}` (bible/index.html:
  980; web.mjs:1667 reads `titles`), and `notes-list` returns `pin` per row like `title`. The
  chapter file is app data the app rewrites on rename already; the indexer walks it for
  notebooks only (`findNotebooks`, lib/note-index.mjs:30) and ignores `pins`.
- Drawer row: `pin:true` → ★ before the title; ⋯ sheet gains `Bookmark · 收藏` / `Unbookmark ·
  取消收藏` via a new row hook `onPin(flag)` (same pattern as `onRename`, :582). A row without
  `onPin` shows no entry, as today for rename.
- Filter: a `★` chip at the head of B's strip under the search box; tapping it shows pinned rows
  only. It is the same strip, so B and D are one control, not two.

Why not the search index: derived and rebuilt on version bumps (lib/note-search.mjs:22) — a
bookmark stored there would vanish on the next schema change.
Privacy: none. Effort: 1 session (journal + Bible + drawer hook + strip filter; needs B's strip).

SHIPPED (branch note-bookmarks, the flag as recommended): Journal entries carry `pin:true` in
journal.json (written by writeIndexNow; absent = not); the Bible chapter file carries
`pins:{[scope]:true}` beside `titles` (pinChapterNote, read back by loadAnn so the next stroke keeps
it, dropped by deleteChapterNote), and `notes-list` (/api/notes) answers `pin` per row. The note file
is never written for a bookmark. Drawer: ★ before a pinned title; the ⋯ sheet offers `Bookmark ·
收藏` / `Unbookmark · 取消收藏` through the row's `onPin(flag)` (no onPin, no entry — the Rename rule);
listDrawer and the chat-side list forward it per id. Filter: PADrawerTags draws a ★ chip at the head
of its strip while any row is pinned (no tags needed), kept while the box has text; pressed, the
drawer's own filter asks `keep(row)` first, so it composes with the title/preview filter and the
node's hits; it clears itself when the last pin goes. Honest limits: the ★ state is per drawer
instance, not stored (a reload shows every row again); the chip shows no count; the Bible's
`__gen` general-note row has no onPin (it is not a chapter-file scope); types stay plain `#tags`
(nothing built). Tests: test/drawer-pins.test.mjs (drawer, sheet, filter, controls),
test/note-pins-hosts.test.mjs (Journal onPin for real, Bible source in both copies, the route),
test/app-load.test.mjs (pins survive an annotation save).

## E. Ask AI period summaries（按时期 AI 总结）

Today. The journal's Ask AI is a PASplit rail with PAChat (notes/index.html:644-678). Every turn
sends the SYSTEM line, a context prefix with only the note's TITLE (`DEFAULT_CTX_PREFIX`, :604)
and the owner's words — the page text is NOT sent (a photo is, by path, :701). One thread per
note (`chatScope`, :652). `PAChat.complete` is the one-shot chat path with no UI (web/chat-ui.
inline.html:1321; the stationery studio uses it, notes/index.html:281). Lanes: `cfg.chat_models`
(lib/config.mjs:230-235): the Fast group is Ollama `:cloud` models, the Deep group too, plus the
`claude` lane (one-shot default, lib/one-shot.mjs:32). Every lane sends text off the Mac; what
keeps the privacy rule is that the owner presses it (ADR 0023 decision 1).

Options for producing the summary.
1. Client-driven through the existing chat: the app fetches the pages' text from the index
   (`note-text` from A, many docs in one call, `BODY_LIMITS.chat` 1 MB, lib/webutil.mjs:133),
   builds one message grouped by day/week, and sends it into the Ask AI rail as a normal turn with
   a label. The owner sees it stream, can follow up, the model chooser and Verify work, and the
   conversation is saved like any other. Recommended.
2. A server route `note-summary {period}` that reads the index and calls a lane itself. Less
   code on the page, but a second model path beside `chat` (superelf.md clause (a): no second
   chat client), no streaming, and the confined app lane rules would have to be re-applied.
3. The owner multi-selects notes and the prompt is only "summarise these". Same plumbing as 1
   with no period presets — kept as the "Selected" preset inside 1.

Size and cost (from the measured index). A month is 10–26k characters of mixed text ≈ 5–13k
tokens; current pace ≈ 20k characters/month. A year at that pace ≈ 240k characters ≈ 100k+
tokens: too much for one turn on the Fast lanes and poor practice on any. So: a month or shorter
goes in one turn; a year is built from its month summaries (map-reduce) — and when month summary
notes already exist (saved below) the year reuses them, which is cheaper and already reviewed.
Cost on the `claude` lane ≈ $0.05–0.15 per month summary at 10–15k tokens in; Fast lanes are
flat-rate Ollama cloud. Photo text (30k of the 56k characters) is often slides, not reflections:
the preset sends typed + ink by default and offers "include photo text" as a tick.

Lane: Deep or `claude` by default for a summary (`defaultModel`, superelf.md:151); the chooser
stays, so the owner can pick a Fast lane.

UI. The drawer's multi-select bar (`.pac-lbulk`, web/chat-ui.inline.html:496-498) gains one
button `Summarize · 总结` beside Delete — selection mode is already the drawer's "act on many"
control. Pressing it opens a sheet: `Selected · 已选 (n)`, `This week · 本周`, `This month · 本月`,
`Last month · 上月`, `This year · 今年`, `Last year · 去年`; then one confirm line that states the
cost honestly: `Send 37 pages · 26k characters to <lane> · 发送 37 页 · 2.6 万字到 <lane>`. The owner
presses; nothing runs otherwise. The answer streams in the Ask AI rail under a new scope
`summary:<period>` so follow-ups continue it. Under the answer, the chat's existing row
affordance adds `Save as note · 存为笔记`.

Saving. "Save as note" creates a NEW journal entry through the app's own `newEntry`/save path
(notes/index.html:500-511): page 0 `pageHtml` = first line `AI summary · AI 总结 — 2026-10
#summary #ai` + `PANote.mdToHtml(answer)` (the paste converter, web/note-ui.inline.html:4333),
`created` = now, `title` = `Summary · 总结 2026-10`, and `chat` bound to the summary thread so
the row shows ✨ and reopens it. The marker IS the first-line tags: the indexer picks them up on
the save hook (lib/note-search.mjs:200), B's chips show `#summary`, the strip filters by it, and
`#summary 2026` finds the year's. No new entry field; a future `kind` field would duplicate the
tag (R3). Bookmarking a summary is D's ★, one tap. A summary of reflections AND todos is one
note; "open todos" are listed last in the prompt so the model separates them.

Bible: the same bulk button in the Bible's drawer summarises selected chapter notes (text from the
index by `doc`); saving goes to a free-form note in the current chapter (`openNewDrawNote`,
bible/index.html:772). Second session.

Privacy: the only model calls are the summary turn and its follow-ups, each pressed by the owner,
each preceded by the page/character count. The index read and the save are local.
Effort: 2 sessions (1: `note-text` many-docs + bulk button + presets + confirm + rail turn;
2: save-as-note, year-from-months, Bible).

SHIPPED (branch note-summaries, option 1, both halves): PADrawerSummary (web/drawer-summary.inline.html,
marker carried by chat-ui, registered after drawer-tags). The multi-select bar's `Summarize · 总结`
(only on a drawer whose host passes `summary` hooks) opens a sheet: Selected (n) / This week / This
month / Last month / This year / Last year by the rows' `created` (else `updated`), the photo tick
off by default, then ONE line from a local `note-text` ask (fields src) — `Send N pages · K characters
to <lane> · 发送 N 页 · K 字到 <lane> (off this Mac)`, plus `· n turns` and `· trimmed` when they apply;
`<lane>` is `PAChat.lane()`, the chooser's current pick (the Journal opens on `claude`). Nothing runs
until Send. The turn goes through the host's `run({scope,label,message})` — the Journal's Ask AI rail
(`openAsk(scope)`), the Bible's rail or full-screen chat — under `summary:<period>` with
`SUMMARY_PROMPT` (one constant: reflections by theme, open todos last, the notes' language) and the
pages grouped by day (`## YYYY-MM-DD`, `### title`). A month or shorter is one turn; a year asks the
host's `monthSummary(period, title)` for each month's saved `Summary · 总结 YYYY-MM` note and maps the
rest through `PAChat.complete` (same 'chat' kind and lane), then the year turn runs in the rail; the
sheet's line shows the month in progress. `TURN_MAX_CHARS` = 80 000 cuts a single turn and says so.
Under an answer in a summary scope the actions bar adds `Save as note · 存为笔记` → the host's
`saveNote({title,html,period,convoId})`: the Journal writes a NEW entry (page 0 = `AI summary · AI 总结
— <period> #summary #ai` + `PANote.mdToHtml(answer)`, `created` now, `chat` = the thread, so the row
shows ✨ and reopens it) through writeNote + writeIndexNow and opens it; the Bible writes a free-form
note in the current chapter (`ANN.draws['free-<now>']`, saveAnn) and opens it through
`openNewDrawNote(key)`. Tests: test/drawer-summary.test.mjs (the flow over the run component with a
fake note-text, fake completion and fake hooks; CONTROL: cancel / failed index / failed month map
send nothing), test/note-summary-hosts.test.mjs (the Journal hooks over the real app source and server).
Honest limits: the Bible's chat scope is the verse, so its saved summary is NOT bound to the thread
and its rows carry no ✨, and a Bible summary thread itself is bound to nothing — `setConvoId` returns
ok without writing for a `summary:` scope (the chapter file names verses, not periods), so a summary
thread is reached again only from the Chats list, where `openConvo` restores its scope from the stored
label (`PADrawerSummary.scopeOfLabel`, the inverse of `titleOf`); a renamed summary conversation loses
that and reopens as a plain chat; the Bible's rows take `created` from `/api/notes` (a draw notebook's
own `created`, else the `free-<epoch>` key), so a text-only verse note has `created` 0 and the presets
fall back to its `updated`; the Bible has no monthSummary (a year preset there maps every month);
month-map progress is on the sheet's line, not in the rail, and a map's one-shot conversation is not
listed; "This week" starts on Monday (local time); characters are counted as sent (a note's pages
joined by newlines), not per page; `PAChat.lane()` names the lane at confirm time — the chooser can
still be changed before pressing Send in the rail, which the line cannot foresee.

Owner review 2026-11-11 ("W46 — not sure what it is"; "not sure how I retrieve this summary and where
it is stored"), branch summary-fixes. TITLES（标题）: the period id still names the scope and the note
(`summary:2026-W46`), but everything the user sees is PASummaryTitle.titleOf(id) (web/summary-title.inline.html,
marker carried by drawer-summary, registered last): `This week · 本周 Nov 9–15, 2026`, `This month · 本月
Nov 2026`, `Last year · 去年 2025`, `Selected · 已选 Mar 3–Oct 15, 2026`, a week spanning a month or a year
written out (`Nov 30–Dec 6, 2026`, `Dec 28, 2026–Jan 3, 2027`); the word is relative to now (this / last /
plain `Week · 周`), and scopeOfLabel, the inverse, accepts every word AND the earlier `Summary · 总结 <id>`
label, so existing notes and threads keep working (monthRow and the Journal's monthSummary find a month's
note by its period, `e.summary`, not by today's wording). AUTO-SAVE（自动保存）: the answer of the turn the
sheet sent is saved as a note the moment it has streamed (chat-ui's send path passes `fresh`; decorate keeps
a pending set per scope) — no tap; the button reads `Saved · 已存`; `saveNote` now carries `scope` and the
hosts UPSERT: the Journal stores `e.summary = <period>` and a re-run replaces page 0's text of that entry
(ink and images on it kept, `updated` now, the title and `chat` refreshed); the Bible marks the draw
`summary: <period>` and replaces its page 0 in the current chapter. A failure is said on the button (`Not
saved · 未保存 — <why>`), the answer stays in the rail, the tap retries. A follow-up in the thread or a
replayed thread is saved only by the tap (which then updates the same note). Both hosts' opens after a save
keep the rail as it is. Tests: test/summary-title.test.mjs, test/drawer-summary.test.mjs (AUTO-SAVE, failure),
test/note-summary-hosts.test.mjs (upsert over the real app and server, ink kept, listed once). Left out: the
`(3 notes)` count in a Selected title — the title carries the date span, the preset button the count.


**Every run kept（每次总结都保留，owner 2026-11-12）— shipped, branch summary-keep-runs.** Owner: "the summary
function overwrites the previous summary within the same date range ... keep the result of different runs ...
and use blank background pages." This replaces the upsert above: each finished answer is a NEW note titled
`PASummaryTitle.runTitleOf(period, run time)` — `This week · 本周 Nov 9–15, 2026 · 11/12 14:52` (one formatter,
local time; the first line keeps `titleOf`). Its later saves (re-tap, the follow-up of I) pass the id its first
save answered and the host updates exactly that note; a note deleted meanwhile answers `{gone:true}`, said on
the bar, nothing created. The year preset reads the NEWEST run of a month. New summary notebooks are
`template:'plain'` in both hosts; existing notes are not rewritten. scopeOfLabel/displayTitle read the run
suffix as part of the title, so links carry no second date. Tests: test/summary-keep-runs.test.mjs (both
twins, mutation control: the upsert put back fails), drawer-summary, summary-followup-client, note-summary-hosts.

## F. Important notes in summaries（重点与链接）

Asked 2026-11-10: "if text were highlighted or circled, this indicates important notes and should
be in AI summaries. In AI summaries, links to the important notes should be given."

SHIPPED (branch note-important). Detection（重点识别）, lib/note-emphasis.mjs, pure: from a page's
strokes, (a) every highlighter stroke's box and (b) a CIRCLE — a pen/marker stroke that ends within
`CIRCLE_CLOSE_FRAC` (10 %) of its box diagonal of where it began, whose box is at least
`CIRCLE_MIN_SIDE` (3 % of the page width) in w and h, with `CIRCLE_MIN_POINTS` (8) samples and a
path length between `CIRCLE_LEN_MIN` (2.0) and `CIRCLE_LEN_MAX` (5.0) × the diagonal. 2.0, not the
2.5 first proposed: a closed loop touching all four sides of its box is ≥ 2 × diag (a diamond), a
true circle π/√2 ≈ 2.22 and a square 2.83 — 2.5 would have rejected real circles; 5 still admits a
loop traced twice (≈ 4.4) and refuses a scribble. An OCR ink line is important when ≥ 50 % of its
page box (lib/note-boxes.mjs pageBox) lies under highlighter boxes (`HIGHLIGHT_COVER`) or its centre
lies inside a circle's box. Typed: PANote's T-mode highlight is `<span style="background-color: …">`
(execCommand hiliteColor with styleWithCSS; the sanitizer keeps `background-color` / `background`
as colours; None writes `transparent`) — any element with such a non-transparent colour is a run.
Index: records gain `emph:{hl,circ}` (the regions, at build time) and `imp:{ink:[line indexes],
typed:[runs]}`; `imp.ink` is re-derived in finishRecord, so it is right when an OCR result lands and
when carryOcr carries one. INDEX_VERSION 6 with INDEX_VERSION_PREV 5: a v5 index loads with its stamps
made stale, every file is re-read ONCE and no page is transcribed again (test: a v5 index with an
autosave before the full scan keeps every record). `note-text` gains the field `important` → per page
the marked lines as text, typed runs first then ink lines top to bottom (lib/note-text.mjs
importantLines). Summaries: the local ask carries `important`; each note is numbered `### [n] title`
under its day and, when marked, an `Important · 重点:` block (one `- line` each) precedes its body;
SUMMARY_PROMPT asks for more weight on those points, kept, and a source number after each point
like `[2]`. A year numbers its months; `[n]` links to the SAVED month summary note (the row titled
`Summary · 总结 YYYY-MM`), a month mapped on the fly has no link, and a saved month's own `[n]` are
dropped from its text. Links（链接）: ADR 0025 — `?note=<id>&page=<p>` (relative; `<p>` the first
page with an important line, else 0), written by PASummaryRefs (web/summary-refs.inline.html, marker
carried by drawer-summary above its script, registered last) into the rail's bubbles (chat-ui's
enhance passes every bubble with its thread key) and into the saved note's html; PANote's
safeLinkHref keeps exactly that shape through `PASummaryRefs.parseLink`. ONE click interception:
`PASummaryRefs.install(hooks)` (from attach / decorate) listens once on the document and hands a note
link to the host's `onLink({id,page})` in its summary hooks; PANote's `openLink` asks
`PASummaryRefs.open(href)` first. Hosts, one line each, byte-identical in workspace and
workspace.example: Journal `onLink:({id,page})=>openEntry(id,{page})` (the reveal path flips to the
page), Bible `onLink` finds the ☰ row by id (`chatData.listAugment()`) and runs its `onClick(id,{page})`.
The confirm line is unchanged (pages · characters as sent; the Important block repeats lines already
counted). Tests: test/note-emphasis.test.mjs (synthetic strokes: highlighter box, a true circle, an
oval, a double trace, a triple trace failing the length rule, an open arc, a letter-sized loop, a tick,
a scribble; the typed markup pinned against the engine source; a record's emph/imp through applyOcr),
test/note-search.test.mjs (v5 → v6 with autosave first, OCR carried), test/note-text.test.mjs
(`important` order), test/note-text-route.test.mjs (the REAL route on a throwaway copy: a highlighter
stroke over the fake tool's first OCR line), test/summary-refs.test.mjs (scheme, numbering, block,
refs, linkify, enhance, the interception, the pins), test/drawer-summary.test.mjs (the turn's message
and refs, the year's month links, Save as note html), test/note-summary-hosts.test.mjs (the Journal's
onLink over the real app source), test/note-link.test.mjs (the sanitizer keeps a note link only
through PASummaryRefs). Owner review 2026-11-11 ("when I click a cross-reference link it goes to that note
but the summary window is gone and I cannot go back"; "not sure what exactly that reference is"), branch
summary-fixes. LINK TEXT（链接文字）: a ref carries the note's `day` and a link reads `[2] Roof · 2026-11-09`
(PASummaryRefs.label: the title cut at 40 characters, then the day; a year's month ref says the month once)
in the rail and in the saved note — the model still writes bare `[n]`; the `title` attribute is gone (the
sanitizer never kept it). A saved summary entering a new turn has `[n] <title> · <day>` stripped (REF_RE).
LINKS KEEP THE SUMMARY（链接不丢总结）: the Journal's onLink opens the note with `{keepRail:true}` —
openEntry neither collapses the rail nor opens the note's own chat (the openAi pref path, G, never runs
from a link); the Bible's note open already left the chat alone. The BACK PILL `← Back to summary · 返回总结`
is PASummaryRefs' own fixed element (`.psr-back`, one per page, shown on a link tap): decorate tells it the
saved note of each scope (`noteSaved(scope, id)` from saveNote's `id`, the Journal entry id or the Bible row
id), a tap in a bubble finds its scope through the element enhance painted, PANote's own tap path (no
element) falls back to the last saved summary, and the pill returns to that note on page 0 through the same
onLink — the rail untouched. Tests: test/summary-refs.test.mjs (label, the pill), test/note-summary-hosts.test.mjs
(link tap over the real Journal: the rail keeps the summary thread, a drawer open still follows the pref).
Honest limits: a circle is judged by its BOX, so a line whose centre falls in
the box of a circle drawn around the line above it counts too; a highlighter stroke that covers less
than half a long line (a word or two) does not mark the line — the OCR unit is the line; refs are
remembered for the session, so a summary thread reopened after a reload shows plain `[n]` (the saved
note keeps its links); the Bible's `onLink` is pinned in source, not run (its row open needs the
chapter loader the harness does not stand up).

## G. AI notes open on request（AI 对话按需显示）— shipped; moved to ⚙ Settings 2026-11-12

Opening a note that carries an AI conversation used to auto-populate the Ask AI rail with the whole
(long) thread. Now a pref decides, default OFF. Owner 2026-11-12: looking for the switch, the owner
opened the app's ⚙ Settings and did not find it (it was a device pref in the pad's settings sheet).
Rule: ONE place for a setting, on the account. So it is now `appPrefs[slug].openAi` (per app, in the
same object the Preferences (JSON) box shows), with ONE tick-box row at the top of the ⚙ dialog,
"Open AI notes with the note · 打开笔记时显示 AI 对话" + hint "Off: a note opens alone; ✨ opens its
AI · 关闭时笔记单独打开；✨ 打开 AI" (web/settings-rows.inline.html, carried by settings-ui, registered
last). Shown when the page has PANote (Journal, Bible), not by slug. Ticking rewrites the JSON box,
typing openAi in the box re-ticks, Save writes once through the shell's saveAppSettings (the prompt
override kept). The shell pushes `openAi:(appPrefs[slug]||{}).openAi===true` in `{pa:'prefs'}` and
again after a confirmed save; `PANote.prefs().openAi` stays the ONE getter. Removed (R1): the pad's
checkbox row, its `kind:'pref'` ping, the shell's `pa_openai` key (a device that had it follows the
account; no migration write). Journal: `syncAsk` opens the rail only when the pref is on, read per
open. Bible: `openDrawFull` expands the note slot only (pinned). Reopen by hand: Journal ✨, Bible ☰
chat row / Ask AI. Tests: test/settings-rows.test.mjs (row shown with PANote / not without, tick +
Save over the real shell save, JSON ↔ tick, invalid JSON), test/note-open-ai-pref.test.mjs (shell push
per app from appPrefs, no device key, re-push after save, pad row gone, Journal host over the real
source driven by the shell's push, Bible pinned, template = live hunks).

## H. Drawer header, groups and going back in time（标题栏 · 分组 · 按月回溯）— shipped

Owner decisions (2026-11-11), all in the SHARED drawer (web/chat-ui.inline.html buildDrawer + two
components), so the journal and the Bible get them with no host change:

1. **Header（标题栏）**: ＋, `Summarize · 总结` and ONE ⋯ only. Sort, Select and Refresh moved into the
   ⋯ sheet (the rows' pacSheet, anchored): the Sort entry names the OTHER order ("Sort by last edited ·
   按修改时间排序" while sorted by creation), Select reads `Done · 完成` while the mode is on, and the
   components add their own entries after (`Show hidden · 显示隐藏 (n)`, below). The header's
   Summarize is PADrawerSummary's second button (`head` = `.pac-dhead`): the SAME sheet as the
   multi-select bar's, with the `Selected` preset greyed until rows are ticked.
2. **Bookmark（书签）**: the row star is ONE token, `--pac-star` (#c47f00, a filled amber: ≥3:1 on
   the light and the dark card, test-checked), 17px. A `★ Bookmarked · 收藏` group is pinned at the
   top of the list while any row is pinned. The strip's ★ chip is gone (one way only, R3).
3. **Going back in time（按月回溯）**: web/drawer-groups.inline.html (PADrawerGroups). The plain list
   is `★ Bookmarked`, `Summaries · 总结` (rows with the `#summary` tag through the drawer's tag chips,
   `entry.summary` from the host, or a saved summary's own title via PASummaryTitle.scopeOfLabel),
   then one sticky group per MONTH of the time the list sorts by — `2026 · Nov 十一月` — newest
   first, the day headers kept inside; a tap collapses. The current month and the two fixed groups
   open by default, older months closed; a tap is remembered PER GROUP in this app's prefs
   (`noteGroups: {key: 1|0}`, only the groups tapped). The owner asked for localStorage; the app
   iframe is an opaque origin where localStorage throws (settings-ui.inline.html, verified
   2026-09-02), so the same server-side per-app prefs the sort order uses carry it (one `prefs`
   hook the drawer passes to both components, merged into the whole prefs object). A jump strip
   under the search box lists the years and months with notes (`2026 Jan · 2025 Dec Nov`); a tap
   opens that month and scrolls its header into view. A search result stays FLAT (the day list).
4. **Tag chips（标签）**: the strip shows tags found in TYPED text only — `note-text` answers
   `typedTags` beside `tags` (lib/note-text.mjs, derived from `src.typed` by the index's one tag rule;
   no index version bump). Row chips and the search keep every source, so a handwritten `#tag` is
   still found. A long-press (500 ms) on a strip chip hides that tag (`hiddenTags` in the app prefs);
   `Show hidden · 显示隐藏 (n)` in the ⋯ sheet restores all.

Tests: test/drawer-groups.test.mjs (header shape and the sheet, groups at a year boundary with a
pinned clock, collapse + prefs round trip, jump, summaries group, star token contrast, header
Summarize, CONTROL without the component), test/drawer-tags.test.mjs (typed-only strip, long-press
hide with stubbed timers, Show hidden, stored list, older-node reply, refused save), test/drawer-pins
(star + ⋯ sheet, no ★ chip), test/note-text.test.mjs (`typedTags`).
## I. Summary accuracy and automatic research（总结准确率与自动研究）— shipped, ADR 0027

Owner decisions (2026-11-11): the local OCR misreads handwriting (a short acronym came back as other letters), so a summary
quoted nonsense as the owner's words; and the system is agentic — a summary's open to-dos get
researched by themselves, briefly.

**Accuracy（准确率）.** A `note-text` record with `important` now says `inkImportant` (index
`imp.ink` non-empty). The sheet (PASummaryImages, web/summary-images.inline.html) picks those pages,
newest row first, at most `PAGE_IMAGES_MAX` = 6, and the confirm line adds `· N page images · N 页图片
(max 6 · 最多 6)`. On Send the node renders each page's ink to a greyscale PNG (`note-page-image` →
`GET /api/note-page-image`, lib/note-page-image.mjs — the JavaScript twin of tools/panote-ocr's
`renderInk`, so a Windows node renders too and the Bible host needs nothing) under `uploads/pages/`,
and the turn attaches the files the way the rail attaches an uploaded photo: `PAChat.send(text,
{attachments, model})`, the host's `run({scope,message,images,model})` passing both through. The prompt
gains one sentence: where the transcript and an image disagree, trust the image. The lane: the first
vision-capable agent lane the node serves (`SUMMARY_LANE_PREF` = claude, then codex; `/api/models`
now publishes `provider` and `vision`), else the current lane — a lane without vision gets text only,
said on the line. A page that cannot be rendered stops the send with the reason.

**Automatic research（自动研究）.** The summary prompt names the heading `Open to-dos · 待办`
(`TODO_HEADING`, pinned equal on both sides). After the turn's answer is auto-saved, PASummaryFollowup
(web/summary-followup.inline.html) posts the answer text ONCE (`summary-followup` → `POST
/api/summary-followup`, lib/summary-followup.mjs). The node extracts the items, classifies each
(personal verb at the start → personal; a research cue → researchable; else personal, so a tie stays
off the search engine), researches at most `RESEARCH_MAX_ITEMS` = 5 through lib/research.mjs (both
keys needed, else the item says `Research unavailable on this node`), asks the fast lane one line for
each personal item, each under `summary_followup_item_timeout_ms`, and answers a brief block: one
`###` heading per item, at most 3 bullets of ≤ 120 characters, sources as bare domains. The client
appends it to the saved note under `Follow-up · 跟进` through `saveNote` (by its run's id since 2026-11-12) and shows one
status line under the answer (`Researching to-dos · 正在研究待办` → `Follow-up added · 已添加跟进 — N
to-dos`, `(partial)`, `No open to-dos`, or the failure). Privacy: only the to-do lines leave the node.
Tests: test/note-page-image.test.mjs (renderer, the route over the real web.mjs: auth, path scoping,
PNG bytes, cache), test/summary-images.test.mjs (pick + cap, lane preference, confirm line, the
attachment wiring through chat-ui, the hosts' hooks), test/summary-followup.test.mjs (extractor EN /
中文, classifier, caps, partial failures, the route with a stub fast lane), test/summary-followup-client.test.mjs
(append + status in the fake DOM).

**Polish（2026-11-11, owner screenshot of a saved This-week note）— shipped, branch summary-polish.**
(1) The saved note's first line names the period by `titleOf` — `AI summary · AI 总结 — This week · 本周
Nov 9–15, 2026 #summary #ai`; `FIRST_LINE_RE` reads that and the older raw-period line; the upsert is still by
scope. `PASummaryTitle.displayTitle` shows an older note titled `Summary · 总结 2026-W46` as its human title in
links and drawer rows (display only, nothing rewritten). (2) A link's day is dropped when the note's title
already says that date (`11/10`, `2026-11-10`, `Nov 10`) or is a summary title. (3) **A saved summary note is
never a source of a new summary**: the host flag, a summary title, the first line or a `#summary` tag excludes
it; a year still reads its months through `monthSummary`. (4) The page image did not reach the model because
the AGENT lane carried the FAST-lane guard ("You have NO tools"), so the CLI never called Read — measured with
the real CLI; the agent lane now gets only the profile's own global words, and an attachment that is not on disk
is said (status + prompt), never assumed seen. (5) The follow-up block was written, but the Journal's quiet save
did not reload the note already on the pad, so the owner saw the page without it; the note on the pad now
reloads in place. Tests: test/summary-research-flow.test.mjs, test/chat-image-lane.test.mjs, drawer-summary,
summary-refs, summary-title, drawer-pins.

**Research quality（研究质量，2026-11-12, owner: "not very good, not very useful"）— shipped, branch research-quality.**
The block for the to-do `Fasting research` (a small-business owners' meeting) was about intestinal stem cells
in mice: the bare to-do went to the search engine, the fast lane wrote it, and a 120-character cap cut mid-word under
a meta bullet. Now (1) a question step (lib/followup-question.mjs) gives the writer the to-do plus the summary's
themes (`summaryContext`, ≤ 400 chars of headings and first lines) and sends ONE search question in the writer's
likely intent; a question that picked up a person falls back to the bare line, and the personal guard still runs
first. (2) The writer is `cfg.research.writer` (lib/research-writer.mjs, read at use time: `claude` default |
`codex` | a chat_models id): Claude with no tools, then Codex, then the fast lane, the lane that answered named on
the status line (`— via Codex · 经 Codex`) only when it fell back. (3) Per item ≤ 3 bullets, each one whole sentence
(cut at a sentence or word end, `cutWhole`), meta lines dropped, then `Sources · 来源:` as ≤ 2 `[title](url)` links
the note renders as `<a href>`. Proof (synthetic fixture, real Tavily + Firecrawl + Claude, blind Codex judge,
order randomised): old 1/5, new 4/5. Tests: test/followup-question.test.mjs, test/research-writer.test.mjs,
summary-followup (deps, fallback, route), summary-followup-client (links through the real mdToHtml), research.

## J. A note opens in the tool its page calls for（按内容选择打开工具）— shipped 2026-11-12

Owner 2026-11-12 (Mac, Journal): a saved AI summary (typed text, no ink) opened on Draw and the first
click drew on it. ONE pad serves every note, so the tool also carried over from the previous note.
Rule (engine `openToolFor` + `applyOpenTool`, web/note-ui.inline.html), applied when a note OPENS
(boot after the first pull; `reload` when the notebook id changes) and never on a refresh of the
same note or a page flip: the opening page has ink → the host's draw tool (`opts.tool`; a host on
'text', the Bible, gets the pen — ink means the Pencil is expected, even on a mixed page); typed
text and no ink → 'text', T lit, no caret forced (a host that asked for text still takes focus);
empty → `opts.tool` as before. A tool the user picks inside the note stays until another note opens.
Opt out: `opts.toolByContent:false`. Tests: test/note-open-tool.test.mjs (the engine's rule and
per-open state RUN as written, mutation control, boot/reload wiring, Journal and Bible hosts pinned).

## Phase order（顺序）

1. Finish search phase 3 (open at page, ink/photo boxes) — in progress, not this plan.
2. `note-text` route + kind (serves A, B, E). A transcript panel. B tag chips + strip.
3. D bookmark flag, ⋯ toggle, ★ filter on the strip.
4. E summaries (two sessions).
5. C remainder (typed highlight, multi-page stepping) — useful, not asked for; after E.

| Feature | Recommendation | Sessions | Depends on |
|---|---|---|---|
| A Transcript view | `note-text` kind, read-only panel in page settings; never stored in the note | 1 | — |
| B Tags | derived from the index via `note-text`; row chips + tag strip; tap = `#word` search | 1 (shares A's session if route first) | A's route |
| C Where the keyword | phase 3 (building) + Highlight API for typed + page stepping | 2 | phase 3 |
| D Bookmarks / types | flag `pin` in journal.json and Bible `pins{}`; ⋯ toggle; ★ chip filter; types = first-line tags | 1 | B's strip |
| E AI period summaries | bulk `Summarize` → presets → honest confirm → rail turn; save as new entry with `#summary` first line | 2 | A's route, B, D |
| H Header / groups / months | ⋯ sheet for Sort/Select/Refresh; ★ group + token; month groups + jump strip; typed-only strip, long-press hide | 1 | B, D, E's title rule |

## K. First-use tips（首次使用提示）— shipped 2026-11-12, branch first-use-tips (ADR 0030)

Owner 2026-11-12: new features need a first-time guide; make it a design rule. PATips
(web/tips.inline.html) shows one bilingual callout per screen open, once per account (`tipsSeen` via
PAAppPrefs). Tips registered for: Summarize + ⋯ sheet, tag chips, summary runs kept, Pencil on verses,
pen sheet, Settings "Open AI notes" row, opening tool (Text/Draw), bookmarks. ⚙ Settings → "Show tips
again · 重新显示提示". Not yet seen in a live browser (the live node is not restarted from a branch).
