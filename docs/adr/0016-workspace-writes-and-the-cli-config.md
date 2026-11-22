# ADR 0016 — What a write into a workspace can plant for the CLI (工作区写入与 CLI 配置)

Status: accepted · 2026-10-13. Split out of ADR 0002 (Consequences, Known gaps) because ADR 0002 is
past its size budget (R4), as ADR 0012 was. The confined lanes themselves are ADR 0002's. The
workspace-write holes below were found by the R13 reviews of 2026-10-13 and are fixed.

## Known gaps

- Project settings and `.mcp.json`, measured 2026-10-13 (2.1.161, throwaway repo with the live
  layout, a member's lane as `laneArgs` builds it):
  - The member lane could not write `.claude/settings.json`, `.claude/settings.local.json` or
    `.mcp.json` in its own workspace. The CLI refused each, even under `acceptEdits`. It did
    write `notes.md` and `CLAUDE.md` there.
  - A planted one IS loaded by the next run there: its SessionStart hook ran, and its
    `.mcp.json` server command ran, with no approval. A planted `Edit(<outside>/**)` allow did
    not widen the lane.
  - So nothing a confined lane can reach may write a workspace's `.claude/` or `.mcp.json`.
    The CLI refuses its own agent there. Other writers into a workspace did not (R13
    reviews, 2026-10-13); "reproduced" means a test or probe showed it on the real code
    before the fix. Each is FIXED, and pinned by `test/workspace-write-paths.test.mjs` (the
    app-data routes), `test/app-fork-paths.test.mjs` (the app-shelf and fork routes) or
    `test/app-folder-writes.test.mjs` (writes into an app folder, and links above one):
    - Dot-paths. `/api/save-data` and `/api/restore-data` share one path check, which took
      any `.json` path in the caller's own workspace, so a signed-in member calling the route
      could write `.claude/settings.json`, `.claude/settings.local.json` or `.mcp.json`; the
      next run there loads them (measured above). Reproduced over HTTP as a member.
    - Encoded `..`. The check read the raw text but `safeJoin` decodes, so ANY app's
      `save-data`, through the broker, left `data/<slug>/` for anywhere in the signed-in
      user's workspace: in the owner's session `.claude/settings.json`, `.mcp.json` or
      `profile.json` (the unrestricted lane's system prompt), another app's data, an untagged
      conversation (bypass A again); in a member's, the same in that member's workspace.
      Reproduced through the real broker. So ADR 0002 decision 4's "That is exactly what the app can
      already write without any agent" was false until this fix.
    - No slug. With no app slug in the frame (`about:blank` once the user leaves an app) the
      broker sent a BARE path, which landed at the workspace root. Reproduced with an empty
      slug; not reachable in Chromium; WebKit, the iPad client, unverified.
    - A fork's source. `/api/apps/<slug>/update` joined `meta.forkedFrom.slug` unchecked, as
      did the shelf's update check (`listApps`) and the changelog. That file is the member's
      own, so `{uid: <any user>, slug: '../data/evil'}` named a folder outside that user's
      `apps/`; if it held a `meta.json` with `shared` set (an app in that user's session can
      write one into its own data), its top-level files were copied into the member's app.
      Reproduced against the owner.
    - Through a symlink planted with a shell (no member or app can plant one):
      - a link in the workspace carried a plain app-data path anywhere, a NEW file outside
        the workspace included (`safeJoin` judges a missing file by its text);
      - `restore-data` read `<path>.bak` through a link (a cross-user read);
      - `writeFileAtomic`, and the jobs store's own copy of it, wrote through a link planted
        at their predictable tmp name, so the bytes landed wherever the link pointed;
      - a peer fork copied a shared app's links as links, into the forker's `apps/`;
      - a source app folder that IS a link was copied as that link — by `copyNoLinks` (a
        share, a shelf fork), which then walked through it deleting links in the real folder,
        and by a peer fork — so the `meta.json` written next landed in the sharer's real
        folder (a peer fork un-shared it and marked it a fork), and the new shelf entry or
        fork was a link into it; and an update of a fork read such a folder through the link,
        copying the top-level files of whatever it pointed at into the member's app;
      - a copy SOURCE reached through a link above the app folder was read through it: with a
        member's `apps/` pointing at another member's, the admin share of `{from: <the first>,
        slug}` put the second member's unshared app on the shelf for everyone;
      - writes INTO an app folder followed a link: the update, the bump and the share toggle one
        at `apps/<slug>` itself (and, found later, a link at `apps/` above it took the update, the
        bump, the share toggle, the delete and a peer or shelf fork into the owner's `apps/`), and
        the update, the bump and the peer fork one at a file in it — a link at the member's
        `apps/f/profile.json` had the update write the source app's bytes over the owner's
        `profile.json`.

      Each reproduced with planted links.

    The fixes: `lib/appdata.mjs` `appDataFile` is the one path rule for both app-data routes. It
    accepts only a `data/<slug>/…` path (which slug is the broker's, from the frame URL), judges
    the DECODED segments (no `..`, none starting with a dot, and no backslash — once the server
    held the namespace, a member's `data\notes\x.json` passed it on macOS and Linux, where `\` is
    an ordinary character, and landed at the root) and refuses a path through any symlink on disk;
    a restore refuses a backup that is a link. The broker refuses app data when the frame has no
    slug. `web.mjs` `forkSource` judges the fork's source for all three readers: a string slug,
    and an active account. `writeFileAtomic` removes whatever sits at its tmp name, then opens it
    exclusively, and the jobs store writes through it. A peer fork copies through `copyNoLinks`,
    which, like `promote`, refuses a linked source folder before touching anything
    (`refuseLinkedSource`). A write INTO an app folder, a delete of one and an app folder read as
    a copy source (the peer fork, the update, the admin share) are refused when any part of the
    path is a link (`web.mjs` `ownAppDir`, `lib/appdata.mjs` `noLinkOnTheWay`), and every write
    into an app folder, the shelf's included, goes through `writeFileAtomic`, whose rename
    replaces a link at the file instead of following it. Every other route that writes a
    request-named path into a workspace was checked: uploads take a sanitized basename under
    `uploads/`, conversation ids match a fixed pattern, app forks write under `apps/<slug>/` (not
    the cwd), the rest write fixed or computed names. Reads: the broker's `data` read encodes each
    segment, so an encoded `..` arrives as `%252E%252E` and names a literal folder (checked
    through the real broker); `attach-url` still reads any workspace path (ADR 0002's read item).
    `--strict-mcp-config` stopped the MCP load (measured) and is ADR 0009's proposal for confined
    runs.
- Operator flags other than the bypass still ride into confined lanes, for example: on a
  member's own chat `--allowedTools` / `--allowed-tools` (an app lane strips them; `Edit(//**)`
  under `acceptEdits` would let a member write anywhere), and on every confined lane
  `--add-dir`, `--mcp-config`, `--permission-prompt-tool`, `--plugin-dir` / `--plugin-url` (a
  plugin can carry hooks and MCP servers), `--agents` / `--agent`,
  `--append-system-prompt-file`, `--setting-sources`, `--chrome` / `--ide` / `--channels` (MCP
  tools, which the denies do not reach), `--init` (Setup hooks), `--debug-file` (a write to a
  path it names), `--system-prompt` / `--system-prompt-file`, and a `--settings` carrying allow
  rules or hooks (2.1.161's option table lists more). `config.json` is the owner's and admins
  cannot edit those keys. An allow-list like `digestArgs` (ADR 0008) would close it. Measured
  2026-10-13: the hidden `--managed-settings` with `defaultMode: bypassPermissions` was ignored
  (mode `default`, a write outside the cwd denied), with or without the pin.
