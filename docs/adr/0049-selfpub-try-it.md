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
A tree without the file (cut before it existed) uses this node's list.

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
  `<host>` is the request's Host header, checked against a strict host[:port] pattern.
- **Navigation.** A sandboxed frame can still navigate ITSELF. So the overlay frame holds a script-free
  wrapper (`/selfpub-try/<token>/`) whose CSP `frame-src` allows only `<host>/selfpub-try/<token>/page/`;
  the inner page is a second `sandbox="allow-scripts"` frame. Navigating to another host or a real node
  page is refused by the wrapper's policy (the e2e test sees the browser's refusal and no request leave).
- **Messages.** The shell's message listeners act only on the app frame `#fr` (checked by `e.source`); the
  preview frame is not one, so a postMessage from it is ignored.
- **Convenience, not the wall.** A trusted preamble (first in the page) gives the opaque page in-memory
  storage with `pa_session=preview`, removes service workers / CacheStorage / IndexedDB (they throw there)
  and points `/api/…` fetches at the fake. The page can undo all of it; the CSP and the sandbox still hold.

### 4. The UI
Publish sheet (web/selfpub.js) → 试用 · Try it (web/selfpub-try.js, a shell part), owner only, right under
the checks so it is on screen as the sheet opens. A first-use tip sits beside it once. Try it opens a
full-screen overlay: a banner 预览 — 示例数据，服务器改动不显示 · Preview — sample data; server changes not
shown (one side per PALang), a 44 px ✕ (and Escape), and the frame filling the rest. While it is open the
page behind is inert (no shell tip over it, focus stays in). ✕ returns to the sheet.

## Consequences
- What the owner tries is what Publish would ship for the browser side; server changes (lib/, web.mjs) are
  not run — the banner says so.
- Sample data only: an app tile opens nothing (frame-src 'none'), Settings shows the fake owner (role
  shown as member: the fake profile has no role), saves go to the fake and change nothing.
- The token is in the frame's URL: the page's own code can read it, and it opens only this same preview.
- Tested by test/shell-parts.test.mjs, test/selfpub-try.test.mjs (routes, CSP, fake API, tokens),
  test/selfpub-render.test.mjs (a new part is drawn in After) and test/selfpub-try-e2e.test.mjs (the owner's
  flow in Chromium, the wall probed from inside the page, a member sees nothing; 390/820/1280/1920).

## Known limits
- Chromium only in the e2e; WebKit's handling of a CSP `sandbox` plus path-scoped `connect-src` is not
  exercised here.
- `SW_PROBE` replies (web/sw-client.js `onMessage`) take any window message: a page could fake the offline
  probe's answer. Effect: the shell may think its worker answered; no data moves.
- Tokens live in memory: a node restart ends every open preview (it shows 预览已过期 · expired).
