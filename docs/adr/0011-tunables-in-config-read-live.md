# ADR 0011 — Tunables live in config and are read when used (可调参数：放配置，用时读取)

Status: accepted · 2026-10-12

## Context

- The owner's principle: a tunable parameter must be configurable, and read at the moment it is
  used, so that changing one never needs a server restart. Server code is minimal mechanism; the
  rest is loaded dynamically.
- A restart is not free. It kills every turn in flight, and on a node the family uses, someone is
  usually waiting on one.
- The oneShot thinking switch (ADR 0008) shipped first as a constant in web.mjs. Changing it
  needed a code edit and a restart.
- Precedent already in the repo:
  - per-lane CLI args (`claude_args`, `member_args`, `fast_args`) are config.json
    keys with their defaults in lib/config.mjs `validateConfig`;
  - web.mjs `reloadConfig()` reloads config.json into the live `cfg` object in place. Only
    `POST /api/admin/reload-config` called it, so an edit did nothing until someone pressed it;
  - lib/adminconfig.mjs marks the fields web.mjs captures at startup `boot: true`.

## Decision

1. **A tunable is a config.json key.** Its default is set in lib/config.mjs `validateConfig`
   (or a module it calls, such as lib/one-shot.mjs), beside its neighbours. An invalid value falls
   back to the default with a `console.warn` that names the key, unless the key already refuses to
   load (as `public_base_url` does).
2. **Code reads it from the live `cfg` where it is used.** It is never copied into a module
   constant at boot. `cfg.one_shot_args` and `cfg.one_shot_model` are read inside `chat()` on
   every turn.
3. **config.json is watched.** lib/config-watch.mjs `watchConfig` polls the file's stat (1 s) and
   web.mjs reloads it into the live `cfg` (`reloadConfig`). It watches the same path loadConfig
   reads (`configPath(ROOT)`).
   - Stat polling, not `fs.watch`, because an editor that saves by renaming a temp file over the
     original replaces the inode, and stat polling looks the name up each time.
   - `persistent: false`, so the watcher never keeps a process or a test runner alive.
   - A reload waits until the file has been stable for a full poll: each change re-arms a timer of
     two polling intervals (`CONFIG_WATCH_DEBOUNCE_POLLS`, derived from the interval, never a
     second constant). A save that straddles a poll (truncated at one, complete at the next) is
     then ONE reload of the finished file and no false failure. The first version waited 300 ms
     against a 1000 ms poll, so it merged nothing: such a save cost two reloads and a false
     `config-reload-failed`.
   - Reloads never overlap. try/finally keeps the watcher alive whatever a reload or `onError`
     does; an `onError` that throws is logged to stderr with both errors.
   - Unwatched in the shutdown path.
4. **The watcher's reload writes nothing.** It loads with `loadConfig(root, { readOnly: true })`:
   users are resolved in memory only, so no token, role or user list is written back to
   config.json, no workspace is provisioned, no profile is seeded and no session store is opened.
   A users[] edit caught mid-save (an owner role mistyped, so users[0] would be promoted) is never
   persisted by a reload nobody asked for. Boot and `POST /api/admin/reload-config` still load in
   full, as before.
5. **A bad edit keeps the last good config.** `reloadConfig` replaces `cfg` only after the new
   config has loaded and validated in full. On a failure (half-written or invalid JSON, a value
   the validator refuses) the server keeps running on the last good config, audits
   `config-reload-failed` and logs the reason. The audit drops any quoted text from the reason,
   because a `JSON.parse` message quotes the file around the fault, and that can be a secret.
6. **Accounts are not reloaded by the watcher.** `users[]` and the maps built from it stay as
   they are in memory. The server writes them itself (`upsertUser`, `removeUser`: memory first,
   then the file after an `await`), and a reload landing between the two would put back the old
   list, which the next account write would then save. Accounts stay "edit by hand, then restart"
   (lib/adminconfig.mjs), or `POST /api/admin/reload-config`. So a member removed from the file by
   hand can still sign in until then; the admin page removes someone at once.

## Exceptions: these still need a restart

- `boot: true` fields in lib/adminconfig.mjs, and every other value web.mjs captures at startup:
  `web_port` (PORT), the AgentMail client, `max_concurrent`, the app contract.
- Code changes.
- The watcher's own interval.
- A key deleted from config.json that has no default: `Object.assign` never removes a key, so the
  old value stays until a restart. Every key with a default goes back to it.

## Migration

- `one_shot_args` and `one_shot_model` are the keys this change adds; `fast_args` gains a default
  (ADR 0008). An explicit `fast_args` in config.json replaces that default whole.
- Existing hard-coded tunables (for example the studio's `AI_WAIT_MS`, `RESOLVE_MS`,
  `WEBSEARCH_Q_MAX`, the listen retries, the digest tool's 90 s timeout) move one at a time, in
  their own sessions, when they are next touched (R8). Each move is a config key with its default,
  read live, with a test that edits it on a running server.

## Consequences

- The server's own writes to config.json (account changes, Node settings) are also reloaded.
  That is harmless: they write what memory already holds, or what should be live anyway.
- An edit applies within about 3 s (seen within a poll, then two quiet polls), to the NEXT use.
  A turn already running keeps what it started with.
- Tests: `test/config-watch.test.mjs` (the watcher on a temp file, at the shipped
  debounce/interval ratio: a burst, a straddling save, a throwing `onError`),
  `test/config-live-reload.test.mjs` (a real web.mjs: an edit reaches the next turn with the same
  pid; invalid JSON keeps the last good value and is audited; ADR 0007's `model_check_time` moves
  the model-check job's schedule, a bad time keeps the last good one, and only the owner gets the
  job after a read-only reload; accounts stay in memory; a mid-edit users[] leaves config.json
  byte-identical, while the admin reload still writes it),
  `test/one-shot-lanes.test.mjs` (a live `one_shot_model` and `fast_args` edit),
  `test/config-one-shot-args.test.mjs` (default, custom, invalid, clash) and
  `test/config-readonly.test.mjs` (the read-only load writes nothing; a full load does).
