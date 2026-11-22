# ADR 0029 — Offline-first: the shell owns the queue, the bundle and the home-node fallback

Date: 2026-11-11 · Status: accepted (branch offline-first; plan docs/plans/offline-first.md)

## Context

The iPad is away with no network, or at home with the internet down. A cold open of the home-screen
app failed (every HTML answer is `no-cache`, ADR 0026 — the right rule for a page that updates
itself, the wrong one for a page with no network), and every note save went through the shell
broker to `POST /api/save-data` with no fallback. Apps run sandboxed at an opaque origin with
`connect-src 'none'`: they cannot fetch, cannot store, cannot register a worker. Whatever works
offline has to live in the shell.

## Decision

1. **A service worker in the shell, network-first for HTML.** `web/sw.js` stores the shell, the app
   pages (`offline.apps`) and the Bible corpus (`offline.bible_cap_bytes`) in one cache named by
   the build the page loaded with (`pa-<build>`, handed over by the page after every load). The
   cache answers only when the network failed; a `cache:'no-store'` request is never cached or
   answered from cache, so PAUpdate's question stays honest. Where iPadOS does not route the
   sandboxed iframe through the worker, the shell fetches the page itself and loads it by `srcdoc`.
2. **A write queue and a warm set in the shell's IndexedDB** (`web/offline-client.js`). A save that
   fails as the NETWORK (not a 4xx/5xx) is queued and answered `{ok:true, offline:true}`; a read of
   a path this device holds is answered from the mirror. A full or broken store answers a failure,
   never a vacuous ok. Kinds that need the node answer one honest sentence.
3. **Sync on reconnect with rule A** (`web/offline-sync.js`, `web/offline-merge.js`): per-page
   last-writer-wins against the base this device read before going away; the loser is appended as
   a `Conflict copy · 冲突副本` page; entries before the index; a 4xx/5xx stops the drain and puts
   the node's sentence on the line; PAUpdate never reloads under a drain — nor does the ↺/bar tap
   once an update was deferred. Three rules from the review of 2026-11-11 (plan §4): equivalent
   means byte-equal, never an equal stamp alone; a tombstone stands over a side that still holds
   the base's bytes and loses to one that moved; the exact outgoing text is recorded as `prepared`
   before the POST, so a drain replayed after a cut-off cleanup finds its own text on the node and
   only cleans up instead of merging (and minting a conflict copy) again.
4. **A home-node fallback** (`web/offline-origin.js`, `lib/local-origin.mjs`): on every drain the
   shell asks `/api/build` on the public name first, and only when that fails on config
   `local_origin`. The local name is used only when it answers the SAME build this page loaded
   with; then the broker's `api()` base switches there for the session with the same Bearer. The
   node answers CORS for exactly one pairing — `Origin` = `public_base_url`, `Host` =
   `local_origin`, both read at use time. PAUpdate does not follow the switch.
5. **One state line**, nothing else added to the UI.

## Consequences

- The iPad opens, reads and writes with no network; nothing is lost on reconnect, and a two-device
  edit keeps both versions in one note. The owner tidies by deleting a page.
- The queue is the only copy of an offline save until it drains: the count on the line is the
  warning. The warm set is capped (`offline.warm_files`); the queue never.
- A build seen only on the home name must never reload the page: the reload would fetch the public
  name, come back from the cache as the OLD shell, and loop. PAUpdate therefore keeps asking the
  public name, and the base switches only on an equal build.
- CORS opens the local name to the public name's pages only; a request from any other origin, or
  one that did not arrive on the local name, gets no CORS headers at all.
- The real-device proof (airplane mode, home internet down, the two-device conflict) is the owner's
  hand test: the steps are in docs/TODO.md under "Offline-first app".
