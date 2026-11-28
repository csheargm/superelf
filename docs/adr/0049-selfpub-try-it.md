# ADR 0049 — 试用 · Try it: the owner previews an unpublished core change

Status: accepted (2026-11-27)

## Context
A core change (ADR 0044) is written by the main chat's agent in the checkout `<selfpub_root>/repo`, on
branch `self/<date>-<id>`. Before Publish the owner had only the server's two iPhone shots of Home
(lib/selfpub/render.mjs). Two gaps:
1. The shots were wrong for a change that ADDS a shell part (a new `web/skin.js`): the page was assembled
   with the NODE's parts list (`SHELL_PARTS` in lib/shellhtml.mjs), so the new part never appeared.
2. The owner could not use the change: open a menu, Settings, a dialog — only look at Home.

Hard rule kept (lib/selfpub/lane.mjs): the node never RUNS agent-written server code.

## Decision
### 1. The parts list is data
`web/shell-parts.json`: an array of `{ marker, file, why? }`, read at use time by lib/shell-parts.mjs.
The live node reads its own file; the render check and the preview read the COPY's file, so a copy that
adds a part is drawn with it. A copy is agent-written, so the file is validated as plain data before use:
- only the keys `marker`, `file`, `why`; at most `MAX_SHELL_PARTS` entries, `MAX_PARTS_BYTES` bytes;
- `file` is ONE name under web/: `^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)*\.(js|css|html)$` (no slash, no `..`,
  no leading dot); `marker` is `/* PA_NAME */` or `<!--PA_NAME-->`; no duplicates;
- the part's real path must sit in web/ (a symlink out is refused);
- anything else throws, and the page says why (a 500 with the reason), never an empty or partial list.
A tree without the file (cut before it existed: origin/main until this merged, the render check's Before)
uses `lib/shell-parts-legacy.json`, the last in-code list, frozen. Not this node's list: that one names parts
(`PA_SELFPUB_TRY_JS`) such a tree has no marker for, so its shell would not assemble.

### 2. One page answer, two users
lib/selfpub/preview-page.mjs answers every request for a copy's page: `/` = the copy's shell assembled by
this node's trusted builder, `/web/*` = the copy's web/ files (never outside), `/api/*` = the fixed fake
owner (`FAKE_API`), any method. The render check (headless Chromium, in-memory routing) and the owner's
preview call the same function (R3). First-use tips are hidden in both: the fake owner has no 'seen' list,
so the shell's tips would cover what the change draws.

### 3. The preview's trust model
The copy's browser code really runs — in the OWNER's browser, next to the owner's session. So it is walled:
- **Key.** `POST /api/selfpub/<id>/try` (lib/selfpub/routes.mjs, owner only: 403 for a member, guest, demo
  or a PIN account's API key) issues a random 192-bit token, in memory, for `selfpub_try_minutes` (config,
  read at use time, default 30), at most `MAX_TRY_TOKENS` at once. Only while the change waits to publish
  (`ready` / `unverified`) and is the branch the checkout is on. The token opens only
  `/selfpub-try/<token>/…`, which answers only the copy's page and the fake API. A finished, discarded or
  publishing change drops the token (404). The session token is never in the URL or the answer.
- **Opaque origin.** The shell's overlay frame is `sandbox="allow-scripts"` with NO `allow-same-origin`, and
  the server repeats it as a CSP `sandbox allow-scripts` (a direct open is walled too). The page has an
  opaque origin: the owner's localStorage (where the session token lives), cookies, IndexedDB and caches
  are not its own; `parent` is cross-origin. No popups, no top navigation, no forms.
- **Network.** The page's CSP: `default-src 'none'`, `connect-src <host>/selfpub-try/<token>/page/api/` and
  nothing else (no `'self'`, no wildcard): the real `/api/*` — with or without credentials — other hosts
  and WebSockets are refused by the browser, whatever the code does. `frame-src 'none'`, `worker-src 'none'`.
  `<host>` is the request's Host header, checked against a strict host[:port] pattern. Every source carries
  its scheme (`http://` and `https://`): in an opaque-origin document WebKit matches a scheme-less source
  against nothing, so on iPhone/iPad Safari the inner page never loaded (found by the WebKit e2e run).
- **Navigation.** A sandboxed frame can still navigate ITSELF. So the overlay frame holds a script-free
  wrapper (`/selfpub-try/<token>/`) whose CSP `frame-src` allows only `<host>/selfpub-try/<token>/page/`;
  the inner page is a second `sandbox="allow-scripts"` frame. Navigating to another host or a real node
  page is refused by the wrapper's policy (the e2e test sees the browser's refusal and no request leave).
- **Frozen bytes.** The tap copies the copy's web/ (what git would publish: tracked + new, not ignored,
  regular files, at most `selfpub_try_snapshot_mb`, default 32) into `<selfpub_root>/try/snap-*`, hashing
  the checkout before AND after (`treeHash` = the change's `verifiedHash`, else 409). Every answer under the
  token comes from that copy, so a follow-up turn writing the same checkout, or a git-ignored file under
  web/, never reaches an open preview. The copy goes with its token; the first tap after a restart clears
  the folder.
- **Session-bound.** The token remembers the owner session that asked; each request checks that session is
  still signed in and still the owner. Sign-out, a removed session or a role change ends the preview.
- **Messages.** The shell's message listeners act only on the app frame `#fr` (checked by `e.source`); the
  preview frame is not one, so a postMessage from it is ignored. The offline probe's answer must come from
  the probe frame itself (web/sw-client.js), and the tips `prefs` re-read only from the parent
  (web/tips.inline.html).
- **Convenience, not the wall.** A trusted preamble (first in the page) gives the opaque page in-memory
  storage with `pa_session=preview`, removes service workers / CacheStorage / IndexedDB (they throw there)
  and points `/api/…` fetches at the fake. The page can undo all of it; the CSP and the sandbox still hold.

### 4. The UI
Publish sheet (web/selfpub.js) → 试用 · Try it (web/selfpub-try.js, a shell part), owner only, right under
the checks so it is on screen as the sheet opens. A first-use tip sits beside it once. Try it opens a
full-screen overlay: a banner 预览 — 示例数据，服务器改动不显示；不要在这里输入密码 · Preview — sample data;
server changes not shown. Never type a password here (one side per PALang), a 44 px ✕ (and Escape), and the frame filling the rest. While it is open the
page behind is inert (no shell tip over it, focus stays in). ✕ returns to the sheet.

## Consequences
- What the owner tries is what Publish would ship for the browser side; server changes (lib/, web.mjs) are
  not run — the banner says so.
- Sample data only: an app tile opens nothing (frame-src 'none'), Settings shows the fake owner (role
  shown as member: the fake profile has no role), saves go to the fake and change nothing.
- The token is in the frame's URL: the page's own code can read it, and it opens only this same preview.
- Tested by test/shell-parts.test.mjs, test/selfpub-try.test.mjs (routes, CSP, fake API, tokens),
  test/selfpub-render.test.mjs (a new part's band is in After; Before draws, from the legacy list too) and
  test/selfpub-try-e2e.test.mjs (the owner's flow, the wall probed from inside the page, a member sees
  nothing; 390/820/1280/1920), run in Chromium AND WebKit (`PA_E2E_ENGINE=webkit`).

## GPT review round 1 (2026-11-27) — adopted
- Every answer under the token carries the page CSP (an SVG or an HTML file of web/ is a document too), and
  a request the browser marks `Sec-Fetch-Dest: document` (a top-level open, outside the wrapper's
  navigation fence) is refused 403.
- A copy's entry points must be plain: web/ not a link, web/index.html and web/shell-parts.json plain files;
  the parts file is sized before it is read. Parts were already checked to resolve inside web/.
- The preview is pinned to the bytes the checks saw: the token is tied to the change record's time (round 2:
  every answer comes from a frozen copy, see §3). `selfpub_try_minutes` is capped at a day. IPv6 Host headers get a 400 (not in CSP's grammar).
- A parts-only change (web/shell-parts.json) now gets the render check.
- The UI opens nothing when the sheet closed while the link was being made.
- Rejected as out of scope here, kept as limits below: WebRTC / DNS-prefetch egress, Escape from inside the
  frame. (Sender checks and the broken Before shot were fixed in round 2.)

## R13 + GPT review round 2 (2026-11-27)
Adopted: the frozen copy and the session binding above (GPT high, R13); the WebKit run, which found the
scheme-less CSP sources broke the preview on iPhone/iPad; the legacy parts list and a Before that must draw
(a Before that does not is a failed check, R14); the skin part's band asserted in After; the probe/prefs
sender checks; a slow Try answer opens nothing unless its button is still in THIS change's sheet; the banner
warns against typing a password; PENDING in lib/selfpub/state.mjs (R3); the Try it tip beside its button (a
tall `.cmenu-pop` is a sheet, not a bar: web/tips.inline.html `BAR_MAX_FRAC`).
Rejected: `frame-ancestors` on the page. Its parent is the opaque wrapper, which matches no source (with
`'self'` the page never loaded); making the wrapper same-origin would weaken the outer wall. Framing the
page from another site needs the token URL, whose holder can already fetch every byte of it.

## Known limits
- Tokens live in memory: a node restart ends every open preview (it shows 预览已过期 · expired).
- CSP does not cover WebRTC or DNS prefetch. The preamble deletes the WebRTC constructors (best effort: a page
  could find them in another realm), and `<link rel=dns-prefetch>` can leak bits through DNS. What could
  leave: the sample data, the copy's own code (bound for a public repo), this preview's token — and whatever
  the owner TYPES into the page. The page is the agent's code and fills the screen, so it can draw a fake
  sign-in or "GitHub token" prompt; the banner says never to type a password there. Never the owner's
  session or real data, which the page cannot read.
- Escape inside the preview frame does not reach the overlay (the ✕ does). Behind a proxy that rewrites Host, the CSP host would not
  match and the preview would not load (Caddy keeps Host).
- The snapshot check cannot see an edit undone byte for byte between the two hashes (no turn runs while a
  change waits, so only a follow-up racing the tap could).
