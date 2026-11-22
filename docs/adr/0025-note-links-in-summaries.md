# ADR 0025 — Note links in summaries: a relative `?note=<id>&page=<p>` href

Date: 2026-11-10 · Status: accepted (branch note-important; docs/plans/note-features.md F)

## Context

Period summaries (ADR 0023, plan E) now weight what the owner marked on a page — highlighter ink,
a circled passage, a T-mode text highlight — and the owner asked that a summary link back to the
notes those points came from. A summary lives in two places: the Ask AI rail (rendered markdown)
and, after `Save as note`, a PANote page (sanitized HTML). Both need the same link, and a tap on it
must open that note on that page inside the app, never leave it.

PANote's link rule (`safeLinkHref`, web/note-ui.inline.html) is deliberately a way OUT of a note:
only `http:`, `https:` and `mailto:` pass; relative addresses are refused and the shell re-checks
the scheme before opening a tab (`open-url`). A note link is the opposite kind of thing: it names a
note of THIS app. Apps are sandboxed iframes with no shared module, and the Journal's note id and
the Bible's row id (`file:<book>:<chapter>:<verseKey>`) are what the drawer already hands its
`onOpen` — so the host already knows how to open an id.

## Decision

1. **One scheme, one parser.** A note link is exactly `?note=<encodeURIComponent(id)>&page=<p>`.
   `PASummaryRefs.parseLink` (web/summary-refs.inline.html) is the ONE regexp that recognises it;
   `linkHref` the ONE writer. Relative on purpose: it is not a URL anyone resolves, it is a token
   the app interprets, and it cannot name anything outside the app.
2. **Kept by the sanitizer through that parser, nowhere else.** `safeLinkHref` keeps a string
   `parseLink` accepts, as written; every other relative address stays refused. Without
   PASummaryRefs on the page (the DOM-free core in tests) the link is refused like `?q=1`.
3. **One click interception.** `PASummaryRefs.install(hooks)` takes the host's `onLink({id,page})`
   (passed in its summary hooks) and listens once, capture phase, on the document: a tap on a note
   link outside PANote's text layer is prevented and handed to the host. PANote's own tap path
   (`openLink`) asks `PASummaryRefs.open(href)` first, so a link inside a note takes the same hook.
   The hosts open the note the way the drawer does: the Journal `openEntry(id,{page})` (the reveal
   path flips to the page), the Bible the ☰ row's own `onClick(id,{page})`.
4. **Refs live for the session, per summary scope.** The turn that numbers the notes
   (`[1]`, `[2]`, …) remembers `{n → id, page}` under its scope; the rail's bubbles are rewritten
   through chat-ui's enhance hook, and `Save as note` writes the `<a>` into the saved html, which
   is durable. A thread reopened after a reload has no refs, so its `[n]` stay plain text
   (docs/TODO.md).

## Consequences

- A summary note on disk carries `<a href="?note=…&page=…" target="_blank" rel="noopener noreferrer">[2]</a>`
  (the sanitizer's fixed attributes); the sandbox has no `allow-popups`, so even an uncaught click
  opens nothing — the interception is what opens the note.
- The shell's `open-url` gate is untouched: a note link never reaches it (`open` returns before
  `postMessage`), and if it did, `OPEN_URL_OK` would refuse the scheme.
- An id is now visible in a note's html. It is the same id the drawer shows in its DOM already;
  nothing new is exposed.
- Deleting a note leaves links to it in summaries; the host's open path then shows its own
  "not found" outcome, as a stale drawer row would.
