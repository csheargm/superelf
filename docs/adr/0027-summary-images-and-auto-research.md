# ADR 0027 — Summaries send page images, and research their open to-dos

Date: 2026-11-11 · Status: accepted (branch summary-accuracy-research; docs/plans/note-features.md I)

## Context

A period summary (plan E, ADR 0023/0025) is built from the index transcript of each page. The
transcript of handwriting is Apple Vision's reading of a rendered ink bitmap, and it misreads
real pages: a short acronym came back as two different wrong ones, and the summary quoted the nonsense as the owner's
own words. The marked lines (plan F) are the ones the owner cares most about, and they are
handwriting more often than not. The owner's decision (2026-11-11): the model must SEE the page
where it matters, and the system is agentic — a summary's open to-dos get researched by themselves,
briefly, with no further tap.

Two constraints shaped the answer. The Bible host must need nothing: its notes are chapter files
with notebooks under `draws[scope]`, and it has no pad-side render path a summary could call. And
privacy: a summary body is the owner's journal; the research lane (lib/research.mjs) sends its
question to Tavily and result URLs to Firecrawl, so what reaches it must be the smallest thing that
can be researched.

## Decision

1. **Pages with important ink go as images, rendered on the node.** `note-text` records now carry
   `inkImportant` (index `imp.ink` non-empty). The sheet picks those pages, newest row first, at most
   `PAGE_IMAGES_MAX = 6` (lib/note-page-image.mjs; the client copy is pinned equal by test), and
   says the count and the cap on the confirm line (`· 3 page images · 3 页图片 (max 6 · 最多 6)`).
   `GET /api/note-page-image?app&path&scope&page` (broker kind `note-page-image`) renders the page's
   strokes to a greyscale PNG under `uploads/pages/<app>_<inkHash>_p<n>.png` and answers the
   workspace-relative path. The renderer is a JavaScript twin of tools/panote-ocr `renderInk`
   (same width, page height, stroke width, skipped highlighter) rather than a `--dump` mode of the
   Swift tool: a Windows node renders too, and a test holds real PNG bytes without `swiftc`.
   Typed text is not drawn — the transcript carries it verbatim; only the handwriting is in doubt.
2. **The images ride the chat's own attachment path.** `PAChat.send(text, {attachments, model})`
   takes a host's files for ONE turn (the composer's chips stay); the host's `run` hook hands
   `images` and `model` through. The node then does what it does for an uploaded photo: Claude is
   told the file names and opens them with Read (attachmentPrompt), Codex gets `-i`, an Ollama lane
   is rerouted to `vision_default`. The prompt gains one sentence: where the transcript and an image
   disagree, trust the image.
3. **The lane is the first vision-capable agent lane.** `/api/models` publishes `provider` and
   `vision` (claude, codex; an Ollama lane only as `vision_default`). `SUMMARY_LANE_PREF =
   ['claude','codex']` (web/summary-images.inline.html) picks the first served one; else the current
   lane answers, and a lane without vision gets text only — said on the line. `reqChat` takes a
   per-turn `model`, so a summary never changes the chooser.
4. **The follow-up is one node call after the auto-save.** The summary prompt now names the heading
   `Open to-dos · 待办` (`TODO_HEADING`, one constant on each side, pinned equal by test). After the
   turn's own answer is saved, the client posts the answer text ONCE to `POST /api/summary-followup`
   (kind `summary-followup`). lib/summary-followup.mjs extracts the list under that heading (either
   language, however the model dressed it), classifies each item — personal verbs at the start win
   (`Call the dentist about whether…` is a call), then a research cue, else personal, so a tie stays
   off the search engine — researches the researchable ones through lib/research.mjs (at most
   `RESEARCH_MAX_ITEMS = 5`, one deadline per item from `summary_followup_item_timeout_ms`) and asks
   the fast lane one line for each personal one. The block is brief by construction: one `###`
   heading per item, at most 3 bullets of ≤ 120 characters, sources as bare domains on the last
   bullet. The client appends it to the saved note under `Follow-up · 跟进` through the same
   `saveNote` (by its own run's note id — addendum 2026-11-12) and shows one status line under the answer.
5. **Privacy: only the to-do lines leave.** `buildFollowup` hands `research(item)` the item string
   and nothing else; the summary body, the notes and the chat history never reach Tavily or
   Firecrawl. The route logs counts, never text. Research needs BOTH keys (Tavily to find, Firecrawl
   to read); without them every researchable item says `Research unavailable on this node` in the
   block, and the fast-lane suggestions still run.
6. **Failures are in the block, never silent (R5/R14).** A failed or timed-out item is named on its
   own bullet and the answer is `partial: true`; the status line says `(partial)`; a block with no
   to-dos saves nothing and says so; an empty lane answer is a failure, not a clean result. A page
   image that cannot be rendered stops the send with the reason — a summary that quietly lost its
   pictures would be the inaccuracy this exists to remove.

## Consequences

- One more file under `uploads/` per rendered page, named by the ink's content hash: an unchanged
  page is rendered once and reused; a changed page gets a new file. Nothing cleans them up yet
  (TODO in docs/TODO.md): they are small greyscale PNGs.
- A summary turn on the agent lane is slower (the agent reads up to six images) and leaves the Mac,
  as every lane did; the confirm line still names the lane and the count before anything is sent.
- The follow-up adds one node call and up to 5 research runs per summary. It is the node's cost,
  not the rail's: the status line is the only thing the user waits on, and the note updates when
  it lands.
- The client's `TODO_HEADING` and `PAGE_IMAGES_MAX` are copies of the node's constants across the
  inline/lib boundary (apps are sandboxed with no shared module); tests pin them equal, as `SCOPE` is.

## Review round 1 (bounds and guards)

- Page images ride only week / month / selected scopes: a whole-year scope (`YEAR_KEYS` in the
  client, the year / lastYear presets) plans none — a year is built from its month summaries and
  twelve months of pages would blow the turn's payload.
- The follow-up's second save is `{quiet:true}`: both hosts write the note and skip the open (the
  owner may have moved on). Amended 2026-11-11 (summary-polish): that limit WAS the owner's "no research"
  report — the Journal now reloads the note when it is the one on the pad; the Bible's draw view does not yet
  (docs/TODO.md).
- A personal cue anywhere in a to-do (a named person after a preposition, a relative, a contact
  verb) keeps it off the search engine before any research cue is read; the safe side when the
  readings tie, so a brand after a preposition also stays home.
- Items run `FOLLOWUP_CONCURRENCY` (2) at a time, each under the per-item deadline: a lane that
  never answers costs one deadline and one line (`No result · 未得结果 — timed out…`), never a hang.

## Amendment 2026-11-11 — the page image reaches the model (summary-polish)

The images were attached and named, but the agent lane's system prompt carried the FAST-lane guard
("You have NO tools…"), so the Claude CLI answered "I can't open the attached image because I have no tools"
without calling Read. Measured with the real CLI (sonnet, the confined app lane, a synthetic PNG): with the
guard, no Read; without it, Read and a correct description. The agent lane now takes only the profile's own
global words (web.mjs resolveSystemPrompts `{agent:true}`); the fast lanes keep the guard. A named attachment
that is not on disk is said on a status line and in the prompt (R14). Saved summary notes are no longer sources
of a new summary.

## Addendum 2026-11-12 — research that fits the note, written by the agent lane (research-quality)

Owner: the research was "not very good, not very useful". Measured on a synthetic copy of the case (`Fasting
research` from a small-business owners' meeting): the old pipeline searched the bare line and returned mouse
stem-cell studies, written by the fast lane, cut mid-word. Decisions:

- **Context, not just the line.** The writer sees the to-do and the summary's themes (≤ 400 chars) and returns ONE
  search question. Privacy changes in one place: that context reaches the writer LLM — by default the Claude lane
  that wrote the summary — and still never the search engine, which gets only the question, after the personal-cue
  guard (a question with a person falls back to the bare line).
- **The writer is the agent lane.** `cfg.research.writer` (`claude` default) writes the question, the synthesis and
  the suggestions; Claude runs with NO tools because its prompt carries scraped pages. Claude → Codex → fast lane on
  a failure or an empty answer; a fallback is said on the status line, never silent.
- **Brief and whole.** ≤ 3 one-sentence bullets, no meta sentence, cut only at a sentence or word end; ≤ 2 source
  links. Cost: two writer calls per research item (question + synthesis), ~15 s on Claude vs ~3 s on the fast lane,
  inside the same per-item deadline. Blind judge (Codex, order randomised): old 1/5, new 4/5.

## Addendum 2026-11-12 — every run is its own note (summary-keep-runs)

Replaces the upsert-by-scope decision (one note per period, a re-run replacing page 0). Owner: runs of the same
period overwrote each other. Decisions: every finished answer creates a NEW note titled with its run time
(`runTitleOf`); the follow-up updates only ITS run's note, by the id the first save answered (`saveNote({id})`);
a deleted note answers `{gone:true}` and nothing is created (R5); the year preset reads the newest month run;
new summary notebooks use the blank `template:'plain'`. Cost: notes accumulate per period — the owner deletes
the runs he does not want from the drawer's ⋯. Existing summary notes are not rewritten.
