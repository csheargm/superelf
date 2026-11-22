# Offline-first · 离线优先 — design for sign-off

Date: 2026-11-11 · Status: DECIDED, building on branch offline-first — session 1 of 4 done (SW + bundle + srcdoc route: web/sw.js, web/sw-client.js, lib/offline.mjs; test/offline-sw*.test.mjs); session 2 done (write queue + warm set + state line + greyed kinds: web/offline-client.js PAOffline, broker hooks in web/index.html, config `offline.warm_files`; test/offline-queue.test.mjs); session 3 done (sync + rule A: web/offline-sync.js PASync, web/offline-merge.js + lib/offline-merge.mjs, the base on the mirror row, Syncing / Sync failed on the line, shellBusy reads inFlight; test/offline-sync.test.mjs, test/offline-merge.test.mjs); session 4 done (home-node fallback: web/offline-origin.js PAOrigin, config `local_origin` + CORS pairing in lib/local-origin.mjs, `Home node · 家中节点` on the line, API_BASE in web/index.html; test/offline-origin.test.mjs; docs/adr/0029-offline-first.md) — the real-device airplane-mode proof is the owner's hand test, steps in docs/TODO.md · Owner entry: docs/TODO.md "Offline-first app"

Case: the iPad is away with no network at all. Today a cold open of the home-screen app fails
(`cache-control: no-cache` on every HTML, ADR 0026 §4), and every note save goes through the
shell broker to `POST /api/save-data`, which has no fallback. Goal: open Journal and Bible, write
and read, come home, and have everything on the node with nothing lost and nothing surprising.

What is fixed by the code as it is（现状）:
- Apps run in a sandboxed iframe at an **opaque origin** with `connect-src 'none'`
  (web.mjs `/app/` CSP). An app page cannot fetch, and cannot use IndexedDB, localStorage or a
  service worker. Every byte an app reads or writes travels through the shell's broker
  (web/index.html `kind:'data' | 'save-data'`, namespaced to `data/<slug>/`).
- So everything offline lives in the **shell** (web/index.html, the real origin): the service
  worker, the IndexedDB queue, the state line. Apps need no change beyond what the broker answers.
- PANote/PAChat and the other PA_COMPONENTS are inlined into each app page at serve time
  (sendAppHtml); one cached app page already carries them. There are no separate component URLs.
- Journal writes two files: `entry-<id>.json` (the notebook: pages with strokes + pageHtml) and
  `journal.json` (the index, metadata only; writeIndexNow). Both go through PANote's read-before-
  write reader (`known` paths, `.bak` proof) and the server keeps one `.bak` per file (lib/appdata).
- Self-update: PAUpdate polls `/api/build` → `{build, version}` and reloads when the footer
  version differs (web/update.js). The node itself never caches HTML.

## 1. What to cache and the service-worker strategy · 缓存什么、SW 策略

Cached ("app bundle" · 应用包), one versioned cache named `pa-<build>` where `<build>` is the
`/api/build` build id the shell loaded with (footer, the ONE source — ADR 0026 §2):
- `/` (the shell), `/update.js`, `/app-frame.js` and the other shell scripts it loads.
- The two app pages: `/app/<uid>/notes/`, `/app/<uid>/bible/` (fully inlined, see above). `<uid>`
  is the signed-in user; the bundle is per user.
- Bible text: `/api/bible?book=&chapter=` answers — 66×2 translations, prefetched in the
  background after first online load (measured in session 1 on a scratch copy: 1,189 chapters,
  7,850,756 bytes of JSON as served, 3.8 MB gzipped, largest chapter 27,844 bytes; cap 20 MB in
  config `offline.bible_cap_bytes`, read at use time).
  `/api/bible-search` stays online-only.
- Fonts: none today are external (font-src data:); nothing to cache. Icons/manifest: yes.
Not cached: `/api/*` except bible chapters; conversations; uploads; other apps.

Strategy（策略）— **network-first for HTML, cache-only when the network fails**:
- Navigation and `/app/` HTML: `fetch` with the browser's normal `If-None-Match`; on a 200 store
  into `pa-<build>`; on any network error serve from the newest `pa-*` cache. Never cache-first:
  a SW that serves a stale shell while online is exactly the scar ADR 0026 §5 refused.
- Bible chapters: cache-first (immutable corpus), refreshed when `<build>` changes.
- Coexistence with self-update: PAUpdate stays the one updater. When it sees a new version it
  reloads; the reload is network-first, so the new shell arrives and posts
  `{kind:'pa-bundle', build}` to the SW, which fills `pa-<newbuild>` and deletes the old caches.
  The SW never calls `skipWaiting` on its own schedule and never decides a version: it only
  stores what the page just loaded. Offline, the footer version is the cached version — PAUpdate
  already returns `'error'` when `/api/build` fails and asks again next tick.
- Scope `/`. A hard rule in the SW: a request with `cache:'no-store'` (what PAUpdate uses) is
  never answered from cache.
Known risk (session-1 spike, see §8): iPadOS Safari may not route the **sandboxed** iframe's
navigation through the SW (opaque-origin clients). Fallback if so: the shell fetches the app page
(SW-served) and loads it with `srcdoc`, passing the slug by a data attribute instead of `#fr.src`
(update.js `frameApp`, app-frame.js `frameSlug` read the URL today — one seam).

## 2. On-device write queue · 本机写队列

In the shell's IndexedDB, database `pa-offline`, one store `writes` keyed by autoincrement:
`{seq, uid, slug, path, text, bytes, ts, kind:'save-data'}` plus a store `files` keyed by
`uid/slug/path` holding the **latest** text per path (the local mirror the broker reads from).

Broker behaviour (one hook each in `kind:'data'` and `kind:'save-data'`, logic in a new
`web/offline.inline.html`-style file for the shell, PAOffline):
- `save-data`: try `/api/save-data` as today. If the relay fails with a **network** failure
  (fetch threw, or no response — not a 4xx/5xx, which stays a real refusal), append to `writes`,
  upsert `files`, answer `{ok:true, offline:true}` so PANote's save pill goes green with the
  offline badge (§5) instead of the retry ladder. A quota failure answers `{ok:false,
  code:'offline-full'}` — never a vacuous ok (R14).
- `data` (read): network first; on a network failure answer from `files` if present, else
  `{ok:false, code:'offline'}`. PANote's reader then blocks that path (its existing rule), which
  is the right answer for a note never opened on this iPad.
- While online, `files` is also updated on every successful save and on every successful read,
  so recently opened notes and `journal.json` are readable offline (the "warm set"). An explicit
  "Keep on this iPad · 离线保留" row action is out of scope for v1.
- Ordering: the queue replays in `seq` order per path; a later write to the same path
  supersedes an earlier one, so replay sends only the last text per path (`files`), but keeps
  the `writes` log until the server confirms (audit + the conflict copy in §4).
- The index file `journal.json` is just another path in the queue, replayed **after** all
  `entry-*.json` of the same batch so the server never names a page it does not hold.

## 3. Sync on reconnect · 重连同步

Trigger: `online` event, `visibilitychange → visible`, and the PAUpdate tick (one call site, the
same cadence). Sequence: (a) `GET /api/build` reachable; (b) for each queued path, `GET` the
server's current file ETag/`updated` (the broker's existing read, one request); (c) apply the
conflict rule (§4); (d) `POST /api/save-data` in order; (e) on 200 delete the queue rows; on a
4xx/5xx stop, keep the rows, show the failure on the state line (R5). A sync in flight registers
with PABusy so PAUpdate does not reload under it. Concurrent app saves while syncing go to the
network as usual (online again); the queue is drained once.
Replay (review 2026-11-11, finding 1): before the POST the exact outgoing text is written to the
path's mirror row as `prepared`. A drain cut off after the node committed but before the cleanup
(a reload, a crash) leaves the queue row; the next drain reads the node, finds its own prepared
text there and treats the path as committed — no merge, no POST, only the cleanup. Without this
the second merge saw the first merge's copy page as a new remote page and minted a second copy
(copy ids are random). The same review closed the one reload path that bypassed the busy check:
once an update is deferred, ↺ and the bar call updateReload directly, which now refuses while a
drain is in flight and asks again until it ends.

## 4. Conflict rule · 冲突规则 (owner decision)

Conflict = the server's `entry-<id>.json` differs, byte for byte, from the base this iPad read
before going offline (the `files` row carries the base text; a newer `updated` alone is neither
necessary nor sufficient — see the rules after the options). Options:
- A. **Per-page last-writer-wins + loser kept as a copy page** — merge the notebook by page id:
  pages only on one side are kept; a page changed on both sides takes the later `updated`, and
  the loser is appended as a new page titled "Conflict copy · 冲突副本 (iPad, 11-11 14:02)".
  Nothing is lost, the note stays one note, the owner tidies by deleting a page.
  Built (web/offline-merge.js): a page gone on one side and untouched (the base's bytes) on the
  other is a deletion and goes; an edited page is kept.
- B. **Per-note last-writer-wins + loser as a copy note** — simpler (no page merge), but a whole
  note duplicates for a one-page edit, and the index gains a row the owner did not write.
- C. Ask on reconnect — a dialog listing conflicts. Rejected for v1: the owner is often not
  looking when the iPad reconnects, and a pending dialog blocks the queue.
Recommendation: **A**. The notebook is already per-page (ids, `updated` per page, written by
writeNote), so the merge is ~40 lines and the `.bak` on the server covers the merge itself.

Three rules added by the code review of 2026-11-11 (web/offline-merge.js, test/offline-merge.test.mjs):
1. **Equivalent means the same bytes.** An equal `updated` is only a fast path when the two
   objects are byte-equal; a page (or a whole file) with the same stamp and other bytes changed on
   both sides, the later stamp wins (a tie: the newer notebook's side) and the loser is kept as a
   conflict copy. A stamp is a hint; the bytes are the truth.
2. **A tombstone stands over an unmoved side.** Deleted here, the node still holds the base's
   bytes → the tombstone goes up; the node moved since the base → the edit wins (a deletion is
   cheap to redo, an edit is not). Symmetric for a node tombstone. With no base (a path never
   read on this device) the edit wins: whether the other side moved is unknown, and a kept note
   costs less than a lost one — the index may then drop the row and leave the entry file orphaned
   on the node (docs/TODO.md).
3. **A replay never merges twice** (§3, `prepared`).

## 5. UI · 界面

One state line in the shell footer, next to the version: `Offline · 离线 — saving on this iPad ·
保存在此 iPad`, with the queued count when >0 (`· 3 to sync · 待同步`). Online with a non-empty
queue: `Syncing · 同步中`; a failure: the server's sentence, tap to retry. Nothing else is added.
(Built, session 2: the line is `#offLine`, a toast-row span beside `#updBar` — the version line
lives inside the Settings dialog, unseen while writing; the toast row is visible over an open app
and outside the inert header. Online with a queue it shows `3 to sync · 待同步` until session 3's
drain runs, so `Syncing` is never shown while nothing syncs.)
Greyed in the apps (the broker answers `{ok:false, code:'offline', text:'Needs the home node ·
需要家中节点'}` and the components already render a failure text): note search, drawer tags
(note-text ask), summaries, transcription/OCR, every AI lane, web search, bible-search, uploads.
Reading, writing ink and text, page flips, bookmarks (index write), new notes: all work.

## 6. Home internet down · 家中断网

The iPad is on home Wi-Fi but the public name does not resolve. The shell's manifest `start_url`
stays the public name; the SW serves the cached shell, and PAOffline tries `/api/build` on the
public origin, then on `https://<mac-local-name>:<port>/` (one config key `local_origin`, read at
use time — never hard-coded). When the local origin answers with the same build, the broker's
`api()` base switches to it for the session (one variable, the same Bearer token; the node's
cert must be trusted on the iPad, which it is for the local name today). Different build on the
two names cannot happen (one node). Mixed-content: both origins are https.
(Built, session 4: PAOrigin asks the public name first on every drain, so a public name heard again
takes the session back; a local name answering a different build is never used (fail closed, R14);
the call is cross-origin, so the node answers CORS for exactly one pairing — `Origin` =
`public_base_url`, `Host` = `local_origin` — both read at use time (lib/local-origin.mjs). PAUpdate
keeps asking the public name: a build seen only on the home name must never reload a page that
would come back from the cache as the old shell. The name is remembered per device from the last
online read of /api/offline-config, so a boot with no public node still knows it.)

## 7. Tests · 测试计划

- `test/offline-queue.test.mjs`: fake IndexedDB (in-memory stub) + fake fetch; save while
  "offline" → queued + `{ok:true,offline:true}`; read of a warm path → served; cold path →
  `code:'offline'`; quota → `offline-full`; replay order (entries before index); server 500 keeps
  rows. Timers stubbed, no real setTimeout.
- `test/offline-merge.test.mjs`: rule A on fixtures — one-side page, both-side page (loser copy
  with the right title), same-page same-updated (no copy), tombstone vs edit. (Built, session 3:
  the base is the mirror row's text before the first queued write, so a page changed on one side
  only takes that side with no copy, and a page deleted on one side and untouched on the other
  goes; the index merges per entry id without copies; the copy page's heading is the first line
  of its pageHtml — a page carries no title field.)
- `test/offline-sync.test.mjs`: the drain — order, stop on 4xx/5xx with the rows kept, the quiet
  stop on a network failure, the merge on the way up, busy while in flight, superseded paths
  dropped; then the broker as shipped against a stand-in node that goes away and comes back.
- `test/offline-sw.test.mjs`: the SW script run in a tiny harness — no-store never cached; network
  error → cache; new build → old cache deleted; bible chapter cache-first.
- `test/shell-update.test.mjs` extension: footer version offline = cached version; sync in flight
  counts busy.
- Real flow (R6, done by hand, recorded in the PR): airplane mode on the iPad, open from the home
  screen, write a page in Journal, read Genesis 1 in Bible, come back online, see the page on the
  Mac; then the two-device conflict with rule A and the copy page.

## 8. Sessions and risks · 分期与风险

1. **SW + bundle** (spike first: sandboxed iframe routing on iPadOS; measure the Bible corpus):
   SW script, versioned cache, PAUpdate hand-off, cold open offline works, Bible readable.
2. **Queue**: PAOffline, broker hooks, warm set, state line, greyed features.
3. **Sync + merge**: reconnect sequence, rule A, conflict copy page, PABusy registration.
4. **Local name + polish**: `local_origin`, real-flow proof, docs/adr/0027.
Risks: iPadOS SW eviction after ~7 days unused (the bundle re-fills on the next online open —
accepted); IndexedDB purge under storage pressure (the queue is the only copy: the state line
shows the count so the owner knows to reconnect; cap the warm set, never the queue); a stale
`uid` after re-login (bundle keyed per user); server `.bak` ratio refusing the merged write when
a conflict copy doubles the file (lib/appdata BACKUP_KEEP_RATIO only refuses the backup, not the
write — verified by reading, re-check in session 3).

## Decisions for the owner · 需要决定 — DECIDED 2026-11-11 (owner took the recommendations): 1 A · 2 recent notes automatically · 3 both translations prefetched · 4 in scope for v1 · 5 accept the srcdoc route

1. Conflict rule: A (per-page LWW + copy page, recommended) or B (per-note).
2. Warm set: recent notes only (automatic, v1) or an explicit "Keep on this iPad" action.
3. Bible corpus offline: both translations prefetched (~6 MB) or on-demand per chapter read.
4. Home-internet-down fallback: in scope for v1 (session 4) or deferred.
5. If the sandboxed iframe bypasses the SW on iPadOS: accept the `srcdoc` route or stop at the shell.
