# Workspace data backup — periodic, per-user, off this machine · 工作区数据备份

Status: **PLAN, nothing implemented. 2026-10-01.** Every claim about existing behaviour below is
marked VERIFIED (read in the source, cited `file:line`) or DESIGN (proposed, not yet true).
Measurements were taken read-only against the live owner workspace on the Mac node, 2026-10-01.

## What was asked

> "for workspace data, I'm thinking to periodically back up to google drive or any other drive…
> the configuration UI of the google drive should be in the UI (per user)"

Four requirements fall out of that: the data leaves this machine, on a schedule, each person
configures their own, and the configuration lives in the existing settings UI.

**The recommendation is that none of those four requires Google's API, an OAuth token, or any
credential at all** — because Google ships a Drive desktop client for macOS and Windows, so "back
up to Google Drive" is satisfied by *writing to a folder*. The argument is in §1; it is made
honestly rather than by defaulting to the thing that was named.

---

## 0. What is actually on disk (VERIFIED, measured 2026-10-01)

| path | size | note |
|---|---|---|
| `workspace/` (owner) total | **150 MB** | not 64 MB — see below |
| `workspace/uploads/` | **81 MB** | 158 files, 90 png / 64 jpg |
| `workspace/data/` | 64 MB | of which **`*.bak` = 32 MB, live files = 31 MB** |
| `workspace/data/notes/` | 59 MB | PANote journals, one atomic file per note |
| `workspace/data/bible/` | 4.8 MB | one file per chapter |
| `workspace/notes/` | 1.9 MB | **LEGACY** — no route reads it (see §4) |
| `workspace/conversations/` | 1.3 MB | 144 files |
| `workspace/briefings/` | 152 KB | |
| `workspace/apps/` | 672 KB | CODE — in git separately, excluded here |
| three member workspaces | 1.7 MB / 656 KB / 172 KB | |

Churn, which is what decides full-vs-incremental:

```
changed in last 24h (excl. *.bak, excl. apps/)   5.0 MB
changed in last 7d  (excl. *.bak, uploads, apps) 12 MB across 38 files
```

The "~64 MB" in the brief is the `data/` directory, and **half of it is `.bak` twins.** Measured:
`data/notes/entry-33782omf.json` is 6,856,493 B and its `.bak` is 6,856,440 B — 53 bytes apart.

So the real payload after the exclusions in §4 is roughly **~100 MB on the first run and ~5 MB/day
afterwards.**

---

## 1. Destination options, and the recommendation

### (a) A folder the OS already syncs — **RECOMMENDED for v1**

iCloud Drive, Dropbox, OneDrive, **Google Drive via the Google Drive desktop app**, or a plain
external disk. superelf writes files; something else moves them.

- **Setup cost:** paste one absolute path. No account, no token, no consent screen, no redirect
  URI, no refresh. Nothing to rotate and nothing to leak.
- **Code cost:** `fs.statSync` + `fs.copyFileSync` + `fs.mkdirSync`. **No subprocess at all** —
  which matters more here than it sounds: `lib/wincmd.mjs:1-27` exists entirely because spawning
  an external CLI on Windows shreds argv under `shell:true`, and `lib/wincmd.mjs:17-22` records
  that a *member-writable* system prompt became a `cmd.exe` injection on the Windows node through
  exactly that path. A feature that spawns nothing cannot repeat it.
- **What breaks:**
  - The folder must exist *on this machine*. An unmounted external disk or a signed-out OneDrive
    means the path is absent. Handling that correctly is the whole of §5.
  - **"Optimise storage" / "Files On-Demand".** iCloud Drive and OneDrive both evict file bodies
    and leave placeholders. A *restore* then needs network, and a file may be 0 bytes locally.
  - **The sync client is a second, invisible queue.** Paused, quota-full, or signed out: our copy
    succeeds, every indicator is green, and nothing left the house. This is the single most
    dangerous failure mode of option (a) and §5 addresses it directly.
  - An external disk has none of the sync-client failure modes, but also **no version history** —
    which changes the snapshot decision in §4.
- **What it buys for free:** Drive, Dropbox and OneDrive all keep ≥30 days of per-file version
  history. That is a feature we would otherwise have to build, badly.

### (b) rclone — **RECOMMENDED as the documented upgrade, not v1**

`rclone copy <src> gdrive:superelf/<user>`.

- **Setup cost:** install the rclone binary (not an npm package — "Zero dependencies — plain
  Node 22+, no `npm install`", `README.md:7`, stays true; rclone is an external CLI like `claude`
  itself, `lib/config.mjs:177`), then `rclone config` once, interactively. **That flow does the
  Google OAuth, and rclone keeps the token in its own config file.** superelf stores only the
  remote NAME.
- **This is the only option that reaches Google Drive natively without us ever holding a token.**
- **What breaks:**
  - rclone must be on PATH on both nodes. On Windows it is a native `.exe`, so
    `spawnSpec()` resolves it as `how:'exe'`, `shell:false` (`lib/wincmd.mjs:96-97`) — the safe
    branch. **The `unresolved` fallback at `lib/wincmd.mjs:105` (`shell:true`) must be refused
    outright for this caller**, and the remote string is user-supplied so it must pass
    `cmdSafe()` (`lib/wincmd.mjs:37`) first.
  - **Isolation leak (DESIGN concern):** rclone's config belongs to the *OS account* running the
    server, not to a superelf user. One rclone config holds every family member's remotes, so a
    member who can type a remote name can type someone else's. Mitigation: the per-user field
    stores a remote *and a path prefix*, and the server prepends `/<user.id>/` unconditionally so
    a member cannot address another member's subtree. State this in the UI.

### (c) Google Drive API with OAuth — **NOT RECOMMENDED, do not build**

- **Setup cost, honestly enumerated:** the owner creates a Google Cloud project, enables the Drive
  API, creates an OAuth client, and pastes id + secret into Node settings. Then **each user**
  completes a browser consent flow that must redirect back to this node — which serves plain HTTP
  on the LAN (`README.md:243`), so the redirect URI has to be the Tailscale `https://<node>.<tailnet>.ts.net`
  hostname, registered exactly, and re-registered if the node is renamed (which `README.md:248-250`
  actively advises doing for privacy).
- **Build cost:** a redirect route, `state`/PKCE handling, per-user refresh-token storage,
  refresh-on-expiry, revocation handling, resumable upload (a 6.8 MB notebook is not a single
  `POST`), Drive's file-ID-not-path model (so "update the same file" needs an ID cache that must
  survive a restore), and quota/rate handling. All of it security-sensitive, all of it new.
- **The trap (DESIGN — verify before anyone argues for this):** a Google OAuth client left in
  "Testing" publishing status issues refresh tokens that expire in ~7 days. A backup that silently
  stops weekly is the exact failure R5 says is worse than no backup. Getting out of Testing means
  app verification.
- **Two config slots for this already exist and are dead.** `google_client_id` and
  `google_client_secret` are in the whitelist at `lib/adminconfig.mjs:40-41` (VERIFIED), and
  **nothing in the repo reads them** — `grep` over `lib/`, `web.mjs`, `web/`, `docs/`, `test/`
  returns only the declaration and one test sentinel. They look like a head start and are not one:
  there is no OAuth route, no token store, and no refresh logic anywhere in this codebase.
- `docs/JOB_ENGINE_PLAN.md:431-434` already reached the same conclusion from the other direction:
  headless `claude -p` cannot use Google connectors because they need interactive OAuth.

### The recommendation, stated plainly

**Ship (a). Document (b). Do not build (c).**

The requirement is not "use Google's API"; it is "the data is off this machine, on a schedule, per
user, configured in the UI". Option (a) meets all four with **zero credentials and zero new attack
surface**, and the user's chosen provider does the uploading with a client that handles resumption,
conflict and quota better than anything we would write. Option (c) is the only one that makes us
hold a long-lived credential to a family member's entire Google Drive in a file on a laptop in a
house — for a feature whose *purpose* is durability, that is a net decrease in security for no gain
in durability.

If the answer is "I want it in Drive and I don't want the Drive desktop app": that is option (b),
and the token still never touches us.

---

## 2. Credentials

**v1 (option a) stores no credential of any kind.** The only persisted value is a destination path
and a schedule. There is nothing to log, nothing to echo, nothing to rotate, nothing to keep out of
git. That is the strongest argument in §1 and it is worth stating as a feature rather than an
absence.

**Option (b) stores a remote NAME**, e.g. `gdrive:` — not a secret. rclone's token lives in
rclone's own config under the OS account; superelf never reads it, never copies it, never logs it.

**If (c) were ever built — where the token would go, and why not `config.json`:**

- Not `config.json`, for two reasons. (i) It is **node-level**, not user-level — there is no
  per-user namespace in it except `users[]`, and `lib/users.mjs:171-176` rewrites `users[]`
  wholesale from in-memory records on every normalization, so a field parked there would be
  dropped. (ii) It is reachable by the **owner** through `PUT /api/admin/config`
  (`web.mjs:2001-2008`, owner-gated at `web.mjs:1987`) — a member's personal Drive token must not
  be in a surface the owner edits.
- Instead: `<workspace>/backup-secret.json`, mode `0600`, written through `writeJsonFile`
  (`lib/atomicwrite.mjs:63`). **Not `profile.json`** — `GET /api/profile` returns a broad slice of
  it to the client (`web.mjs:1835-1864`) and `web.mjs:1920-1921` records that profile.json is read
  whole on every request. A separate file keeps the token out of both.
- **It is out of git by construction, verified, not by convention:** `.gitignore:14-15` ignores
  `workspace/` and `workspace-*/`, and the re-inclusion at `.gitignore:32-39` is a narrow allowlist
  for `workspace/apps/*/index.html` and `meta.json` only. `test/apps-tracked.test.mjs` asks
  **git itself** (`git check-ignore`) whether `workspace/profile.json` is ignored, and carries a
  control assertion that an app `index.html` is *not* ignored — so the test cannot pass vacuously.
  A new file beside `profile.json` inherits that.
- **Never logged or echoed.** Follow the two established patterns exactly: existence-only checks
  (`cfg.researchEnabled`, `lib/config.mjs:296`, whose comment says "Key VALUES are never logged or
  echoed anywhere; this is an existence check only"), and the structural no-leak rule in
  `lib/adminconfig.mjs:5-8` / `:81-87` — the GET view attaches a `value` property **only** to
  `kind:'value'` rows, so a secret row never carries the property at all, set or not, and
  `test/adminconfig.test.mjs` proves the whole serialized view contains no secret even when SET.
  Audit the **key name only** (`web.mjs:2004`).

---

## 3. Per-user configuration UI

### Surface

One new collapsed section in the profile dialog, `<details id="backupWrap">`, placed between
`healthWrap` (`web/settings-dialog.html:31-37`) and `jobsWrap` (`:45-51`). It follows those two
exactly: lazy-loaded on `toggle` (`web/settings.js:62-63` for health, `:152` for jobs), rendered by
a function in `web/settings.js`.

### What the user sees

```
Backup · 备份                                                    [ > ]
-----------------------------------------------------------------
  Where · 备份到    [ /Users/me/Library/Mobile Documents/com~apple~… ]
                    A folder your Mac/PC already syncs — iCloud Drive,
                    Dropbox, OneDrive, Google Drive, or an external disk.
                    Whoever runs that folder can read this data:
                      your conversations, journal and health records.
                      An employer-owned folder means your employer can.
  When · 时间        [ 02:30 ]   [ ] On · 开启
  Include uploads    [x] photos & attachments (81 MB) — needed for notes
                       with pictures to restore correctly
  -------------------------------------------------------------
  Last · 上次  2026-10-01 02:30 · ok · 成功 · 5.2 MB, 38 files
  Next · 下次  tomorrow 明天 02:30
  Destination  reachable · 可访问 (412 GB free)
  -------------------------------------------------------------
  [ Back up now · 立即备份 ]   [ Check the backup · 校验备份 ]
```

The status block mirrors the Jobs row's three-questions discipline (`web/settings.js:118-131`,
`lib/jobstatus.mjs:51-95`): *did it run*, *did it copy anything*, *is the destination reachable* are
three different questions and are shown as three lines. "Check the backup" is §6's verify path.

### The round-trip, through the existing mechanism (R3)

```
settings.js  --PUT /api/profile {backup:{dest,time,enabled,uploads}}-->  web.mjs:1826
                                                                          | whitelist branch
                                                           loadProfileForUpdate(wsDir(user))
                                                                          |
                                                           saveProfile(wsDir(user), prof)
settings.js  <--GET /api/profile {backup:{…}, backupStatus:{…}}--------- web.mjs:1835
```

Validated in the same whitelist chain as `calendarIcs` and `briefingEmail`
(`web.mjs:1948-1975`), under the same stated rule: **blank clears, junk is refused loudly with a
bilingual message, never a silent drop** (R5/R14). Returned normalized like `appPrefs`
(`web.mjs:1849-1850`).

### Why `/api/profile` and NOT the broker `pref` kind

This is the one place the obvious reading of the brief is wrong. **The `pref` broker kind writes
`localStorage`** — `web/index.html:1621-1635`, VERIFIED: `localStorage.setItem('pa_fingerdraw', …)`
etc., and its own comment calls it a "Device-level UI preference". It is per-device by design, and
the same block records why a per-app setting was *moved off* it: "a journal read on a laptop and on
an iPad is one journal, and two devices disagreeing about its order is two different journals"
(`web/index.html:1631-1634`).

A backup destination is per-account, not per-device. The existing per-account per-user store is
`profile.json` via `/api/profile`, which is what `briefingEmail`, `calendarIcs`, `postcode`,
`appOrder`, `appModels`, `appPrefs` and `systemPrompts` all use. That is the pattern to follow.

(`app-settings` / `set-app-settings`, `web/index.html:1827-1833`, *do* reach the server — but they
are scoped to a sandboxed mini-app's own slice and derive the slug from the frame. Backup is a shell
setting, not an app setting.)

### Isolation — nothing new to enforce (VERIFIED)

`userFor(req, url)` resolves the caller from a session token or API key with a constant-time match
(`web.mjs:463-470`); every request past `web.mjs:1241-1242` has exactly one `user`. `/api/profile`
touches only `wsDir(user)` (`web.mjs:351` — `const wsDir = (u) => u.workspace`; used at
`:1827` and `:1982`). **There is no route anywhere that takes a target user id except
`/api/admin/*`, which is owner-gated at `web.mjs:1987`.** A member therefore cannot address another
member's profile — not because a check rejects them, but because no addressable surface exists.

Two consequences for this feature, both load-bearing:

1. **Do not add a `?user=` or `{userId}` parameter to any backup route.** It would be the first one
   in the codebase and it would be the whole isolation story.
2. **The destination validator must refuse a path inside any other user's workspace** (§7). Without
   that, a member types the owner's workspace path as their destination and the server — which runs
   as one OS account for everyone — writes ~100 MB into it. The isolation that holds at the HTTP
   layer does not hold at the filesystem layer, and a user-supplied absolute path is the first
   place that difference becomes exploitable.

---

## 4. What is backed up, and what is not

### A denylist, not an allowlist

VERIFIED reason: `workspace/notes/` holds 1.9 MB in 3 files (`43-3.json` at 1,860,492 B), and **no
route reads it** — `GET /api/notes` reads `path.join(wsDir(user), 'data', 'bible', 'notes')`
(`web.mjs:1429`). Likewise two `entry-*.json` files sit at the workspace root from an older layout;
live journal entries are `data/notes/entry-*.json`. An allowlist of known directories silently
drops that handwriting. A denylist keeps it.

| | path/pattern | why |
|---|---|---|
| **exclude** | `*.bak` | 32 MB of the owner's 64 MB `data/`, near-byte-identical twins of the live file. It is the **local** undo buffer (`lib/appdata.mjs:39-50`: one generation, ≥60 s old, refused when the demoted version is <half the backup's size). A remote copy buys nothing a snapshot history or the provider's own version history does not, at 2x the bytes. |
| **exclude** | `*.tmp` | `writeFileAtomic` writes `<file>.<pid>.<seq>.tmp` in the same directory (`lib/atomicwrite.mjs:43`); a crash can leave one. |
| **exclude** | `apps/` | CODE, in git separately (`.gitignore:32-39`). |
| **exclude** | `.DS_Store`, `node_modules/` | noise (`.gitignore:41-42`). |
| **exclude** | anything reached through a **symlink** | `lib/webutil.mjs:16-20` already documents the threat: "the skip-permissions agent could plant a link inside the workspace pointing at `~/.ssh`". The owner's agent *does* run with the skip-permissions flag (`lib/config.mjs:178`). A walker that follows links uploads `~/.ssh` to Google Drive. Use `lstat`, skip symlinks, count them, report the count. |
| **exclude** | `config.json` | holds **every** user's password hashes and tokens (`lib/users.mjs:174`). A member's backup must never contain it. Whole-node portability is `migrate.sh`'s job (`migrate.sh:47-59`), owner-run, not this feature's. |
| **exclude** | `identity-denylist.txt` | the owner's own list of names; local by design. |
| **INCLUDE** | **`uploads/`** | **the finding that contradicts the obvious design — see below** |
| include | everything else: `data/`, `conversations/`, `briefings/`, `memory/`, `notes/`, `jobs/`, `journal.json`, `health.json`, `profile.json`, `job-prefs.json`, `job-runs.json`, `pending-actions.json`, `CLAUDE.md`, root-level `entry-*.json` | |

### `uploads/` cannot be excluded (VERIFIED)

81 MB is exactly the folder you want to skip, and skipping it produces a backup that **restores a
notebook with a missing photo and reports success.** Proof, read on disk:

```
workspace/data/notes/entry-1b1ppz7o.json  references  uploads/1790619047316_scan.jpg
                                          contains    0 occurrences of "data:image"
workspace/uploads/1790619047316_scan.jpg  exists, 67,389 B
```

Images are referenced **by path**, not inlined. 113 of 158 upload files are referenced from
`conversations/` and `data/`; 44 conversation files reference uploads. The broker's `attach-url`
kind (`web/index.html:1842-1851`) reads the bytes back out of `uploads/` on every reload, which is
why nothing is inlined.

So the checkbox in §3 defaults **on**, and its label says what turning it off costs. It is offered
at all only because an external disk may be small.

### Full vs incremental (DESIGN)

Measured: ~100 MB first run, ~5 MB/day after. So:

- **A manifest-driven mirror.** Walk the tree, compare `(relpath, size, mtimeMs)` against the
  previous run's manifest, copy only what differs, delete from the destination what no longer
  exists in the source (and log the deletion count — a run that proposes to delete more than 20% of
  the destination **refuses and reports**, which is the `BACKUP_KEEP_RATIO` instinct from
  `lib/appdata.mjs:50` applied one level up).
- **No hashing in v1.** mtime+size is what a ~100 MB tree on a laptop can afford nightly; hashing
  is in the verify path (§6) where it runs on demand, not on the hot path.
- **No hardlink snapshot rotation.** Cloud sync clients do not preserve hardlinks, so the classic
  rsync `--link-dest` scheme degrades to N full copies on Drive/Dropbox/OneDrive. **Do not build
  it.** For a *cloud* destination, per-file version history comes from the provider. For an
  **external disk**, which has none, keep `N=7` dated manifests plus a `.prev/` copy of any file
  the current run is about to overwrite — bounded by the 5 MB daily delta.
- **Skip files modified in the last 5 seconds.** They are mid-autosave (PANote autosaves every
  700 ms, `lib/appdata.mjs:41`); the next run catches them. Cheap, and it avoids reading a file in
  the middle of the window §7 is worried about.
- **Per-file consistency is already guaranteed; cross-file is not, and does not need to be.** Every
  write is tmp+fsync+rename (`lib/atomicwrite.mjs:41-61`), so any file the walker opens is wholly
  the old version or wholly the new one. There is no cross-file transaction anywhere in superelf —
  `README.md:277-278` states the limitation outright — and the storage shape is deliberately "ONE
  ATOMIC WHOLE-NOTEBOOK WRITE PER NOTE" (`lib/appdata.mjs:170-181`). File-level copy is therefore
  the correct granularity, and a backup that tried to be more atomic than the thing it is copying
  would be inventing a guarantee the live system does not have.

---

## 5. Scheduling and failure

### It should NOT be a job. Three verified reasons.

1. **`effects:'read-only'` is the job engine's unattended-run gate.** `lib/jobs/tools.mjs:3`:
   "`effects: 'read-only'` is what lets a job run unattended", and every manifest declares it
   (e.g. `:38`). A backup writes ~100 MB outside the workspace. Declaring it `read-only` is the
   exact dishonesty `docs/JOB_ENGINE_PLAN.md:417-420` names as a risk ("A tool that quietly spends
   money or sends mail while declaring `read-only` defeats the gate"). Declaring it side-effecting
   routes it into the approval loop — asking a human to approve a nightly backup.
2. **The output contract has no "succeeded, nothing to say".** `lib/jobs/run.mjs:7-10`:
   `null` = intentional silence, `{body}` = a briefing, `throw` = failure. `null` is explicitly
   indistinguishable from a broken job (`docs/JOB_ENGINE_PLAN.md:409-412`), and
   `lib/jobs/run.mjs:28-33` **throws** if a tool returns an empty body. A `{body}` would be saved,
   folded into 每日一报 and pushed to Telegram and email (`lib/jobs/fold.mjs:1-10`,
   `lib/notify.mjs:116-161`) — a nightly "backup ok" message is precisely the spam
   `lib/jobs/fold.mjs:2-3` exists to remove.
   > **2026-10-12 (ADR 0006):** the Telegram bot was removed. A briefing is now shown in the app
   > and emailed; the point stands — a nightly "backup ok" email is the same spam.
3. **The schedule grammar cannot express it anyway.** `lib/jobs/store.mjs:45-51` accepts only
   `{time:'HH:MM'}` plus an optional weekday `0-6`, and `lib/schedule.mjs:20-30` fires **once per
   local day** with same-day catch-up. "Every 6 hours" is not expressible. `plan.kind` is
   restricted to `'tool'` (`lib/jobs/store.mjs:17`, `:54`). Daily is a fine answer for v1, but it
   should be a stated choice rather than an accident of the grammar.

### Instead: a third stage on the existing minute tick (DESIGN)

`web.mjs:2207-2232` already runs `jobsTick` then `remindersTick` inside one `tickRunning`
reentrancy guard, with the explicit note that both write `job-runs.json` and that parallel writers
with stale snapshots were "the duplicate-briefing/duplicate-reminder lost-update scar". Add
`backupTick({users, audit})` as a third stage **in the same serialized tick**, after reminders.

- Reuses: the one scheduler, the one reentrancy guard, `withUserLock(u.id, …)` (`web.mjs:198-212`),
  the once-per-local-day + same-day-catch-up semantics of `lib/schedule.mjs:20-30`, and
  `nextDueAt` (`lib/jobstatus.mjs:107-123`) for the UI's "next" line.
- State in **`<workspace>/backup-state.json`**, not `job-runs.json`. Same reasoning as
  `lib/jobs/prefs.mjs:9-10` ("deliberately NOT inside the `jobs/` directory, where every `.json` is
  scanned as a job file"): `job-runs.json`'s shape is `{name:'YYYY-MM-DD'}` plus a reserved
  `_failures` key (`lib/jobruns.mjs:5-8`) and cannot carry a manifest or a destination status.
  Read it **STRICTLY** — a missing file is a first run, a corrupt one throws and is audited, never
  silently treated as `{}`. That rule is stated twice in this codebase for exactly this class of
  bug (`lib/jobruns.mjs:22-25`, `lib/jobs/prefs.mjs:26-28`) and getting it wrong here would mean a
  corrupt state file re-copies ~100 MB every minute.
- The whole tick must stay cheap when nothing is due: check the HH:MM gate **before** reading any
  per-user file, exactly as `lib/jobruns.mjs:77` does.

### Frequency

Daily, default **02:30 local**, per user, editable HH:MM. Rationale: the machine is always-on
(`README.md:257-269`); 02:30 is after the day's writing (so §7's concurrency window is near-empty)
and before the 07:30 brief (`lib/config.mjs:267`), so a failure is reportable in *that morning's*
brief rather than a day late.

### When the destination is unreachable — three states, never one

Collapsing these is how a backup lies.

| state | detection | action |
|---|---|---|
| `missing` | the destination directory does not exist, **or exists but has no marker file** | **refuse. Do not create it.** |
| `unwritable` | exists + marker present, but a probe write fails (quota, read-only volume, permissions) | refuse, record the errno |
| `stale` | wrote fine locally; the sync client has not uploaded | report honestly as unknown (below) |

**The marker file is the load-bearing part.** `.superelf-backup-<user.id>` is written once at setup
and checked on every run. Without it, an external disk unplugged at 02:30 means
`fs.mkdirSync('/Volumes/Backup/superelf', {recursive:true})` happily creates a directory **on the
boot disk** and writes ~100 MB there, reporting success — and the next time the disk is plugged in,
the real destination is empty and nobody knows. "Never create the destination" is the rule; the
marker is how it is enforced after a reboot, and it also catches "the user renamed the folder".

**`stale` must be reported as unknown, not as ok.** We cannot see the sync client's queue. What we
*can* do, and should: show the destination's free space, and make the staleness check in §5's signal
ladder read **the manifest back from the destination** rather than trusting our own success flag.
"I believe I wrote it" is what silently stops.

### How a FAILED backup becomes visible (R5) — the signal, in order

1. **The Settings → Backup status block** (§3), derived from `backup-state.json` plus the audit
   tail, the same way `jobsView` derives its rows (`lib/jobstatus.mjs:128-155`) — and for the same
   stated reason: `lastOutcome` comes from the audit log, "never inferred from a run mark — the view
   must never show ok when the audit says failed" (`lib/jobstatus.mjs:4-5`).
2. > **OPEN, 2026-10-11:** the daily brief was removed (ADR 0004), and with it `runDailyBrief`, the
   > `healthLine`/`folded` callbacks and `lib/jobs/fold.mjs` cited here and in item 4. This alert
   > surface must be re-specified before the plan is built — for example a failure-only briefing
   > pushed through `pushBriefing`, still silent on success. The text below is the original design.

   **A line in the daily brief. This is the one that matters** — the brief is the surface the family
   actually reads every morning. `runDailyBrief` already takes injected section callbacks:
   `healthLine` and `folded` (`web.mjs:228-230`). Add `backupLine` the same way.
   **Asymmetric on purpose:** success says **nothing** (the no-spam rule, `lib/jobs/fold.mjs:2-3`);
   a failure, or a last-good-backup older than 3 days, says one line, always. A success message
   every morning trains people to skip the section the failure will appear in.
3. **`audit('backup-failed', {who, dest:<normalized path only>, code})`** for the owner's Activity
   log (`GET /api/admin/audit`, `web.mjs:1986`). Never the error's full text if it could embed a
   path outside the destination; never any credential (§2).
4. **Escalate after 3 consecutive failures** — mirroring `MAX_CONSECUTIVE_JOB_FAILURES = 3`
   (`lib/jobruns.mjs:19`) — to the push channels, via `pushBriefing` (`web.mjs:155-169`) with
   `deliver` **not** `fold-daily`, so `web.mjs:159-163` sends it immediately instead of holding it
   for tomorrow's brief.

Note the one thing *not* copied from the job engine: `lib/jobruns.mjs:14-19` marks the day done
after 3 consecutive failures so a broken job cannot hammer an LLM lane. A backup has no lane to
hammer and must **keep retrying** — give up for the day only after 3 attempts, but never mark the
day successful.

---

## 6. Restore

A backup nobody has restored is a hypothesis. Three levels, in increasing blast radius.

### Level 1 — one file, and it already exists

For a single damaged note, nothing new is needed: `GET /api/data/<path>.json.bak` then
`POST /api/restore-data` (`README.md:214-224`, `lib/appdata.mjs:123-131`, `web.mjs:2159`). The
backup's `.bak` is excluded (§4) precisely because *this* path already covers that case locally.

To pull one file from the **backup**, the route writes it through `saveAppData`
(`lib/appdata.mjs:101-117`) rather than `fs.copyFileSync` — so it gets the atomic write, and
`maybeBackup` takes a `.bak` of the *current* version first (`:106`). A restore must not be the
operation that destroys the thing you were about to compare against.

### Level 2 — verify, without touching live data (the important one)

`node backup-verify.mjs <dest>` — read-only on both sides, no live workspace required:

1. every `*.json` in the destination parses;
2. **every `uploads/…` path referenced from `conversations/`, `data/` and `journal.json` exists in
   the destination** — this is the §4 failure made into an assertion, and it is the single check
   most likely to catch a real break;
3. the manifest's `(relpath, size)` matches the bytes actually present, and a `--hash` flag
   re-hashes;
4. files-over-1 MB and symlink-skip counts are printed, so a destination that is 0-byte iCloud
   placeholders is visibly 0 bytes rather than silently fine.

Reported as PASS / FAIL / **UNKNOWN**, following `ops/checks.ps1:21-22`: "UNKNOWN is never a pass: a
check that turns 'I could not tell' into a green tick is worse than no check." Wired to the
"Check the backup · 校验备份" button in §3.

### Level 3 — full restore, into a NEW directory, never the live one

`node backup-restore.mjs <dest> <newdir>` writes `workspace-restored-<date>/`. Then the owner points
a config user at it — **which already works, unchanged:** `users[].workspace` accepts a relative or
absolute path (`lib/users.mjs:141-142`) and `writeUsers` persists it (`lib/users.mjs:174`). So a
restored workspace boots side by side with the live one and can be read before anything is
committed. This is `migrate.sh:68-78` run backwards, and it inherits its discipline: "READ-ONLY on
this node… if it cannot write the target it stops before copying a single byte" (`migrate.sh:9-10`),
and refusing a non-empty target without `--force` (`:42-44`).

### The drill

Verify runs nightly after the copy (cheap: it is a stat walk plus a JSON parse). **Level 3 runs
quarterly, by hand, with a date written into this file.** Say so here, because otherwise it does not
happen, and the first real restore is the test.

---

## 7. Windows and macOS

### Paths

- **No `os.homedir()` exists anywhere in this codebase** (VERIFIED: grep over `lib/`, `web.mjs`,
  `*.mjs` — zero hits; every path derives from `ROOT` at `web.mjs:54` or from a workspace). So
  **do not guess** `~/Google Drive` or `%USERPROFILE%\OneDrive`. The user pastes an absolute path.
  The §3 placeholder shows the shape for the platform the browser reports; it does not prefill.
- **`safeJoin` cannot be reused** — it exists to keep paths *inside* a base and rejects absolute
  paths outright (`lib/webutil.mjs:11`). A destination is deliberately outside. A new validator is
  needed; it must refuse:
  - a relative path, or `..` surviving `path.normalize`;
  - a path inside `ROOT` (a backup in the repo could be committed, and would recurse into itself);
  - a path inside **any** user's workspace — enumerate `cfg.users` and compare resolved real paths
    (§3's second consequence);
  - a path that *is* an existing file;
  - on Windows, any segment in `RESERVED_DEVICE_NAMES` (`lib/webutil.mjs:31` — "Windows resolves
    these names to DEVICES, not files, at any path and with any extension");
  - a UNC path (`\\server\share`) in v1 — it is reachable but its failure modes are a separate
    conversation.
- **A migrated workspace carries a dead path.** `migrate.sh:68-78` copies workspaces between
  macOS and Windows, so `profile.json`'s destination will not exist on the new machine. It must
  fail as `missing` and say so (§5) — never be created.
- **Long paths.** `README.md:98-99` already makes the 260-char ceiling a live constraint and tells
  people to install at `C:\superelf`. A real destination like
  `C:\Users\<name>\OneDrive - Company\superelf\workspace-<id>\data\notes\entry-xxxxxxxx.json` is
  ~95 chars — fine — but the dated-manifest scheme adds a component. Say in the UI: keep the
  destination short on Windows.

### Processes

v1 needs **no subprocess**: `fs.lstatSync`, `fs.copyFileSync`, `fs.mkdirSync`, `fs.readdirSync`.
This is the strongest practical reason to prefer option (a), given what `lib/wincmd.mjs:1-27`
records about spawning on Windows. Option (b)'s rclone call must use `spawnSpec()`
(`lib/wincmd.mjs:82-106`), gate the user-supplied remote with `cmdSafe()` (`:37`), and **refuse the
`how:'unresolved'` branch** (`:105`) rather than falling back to `shell:true`.

### The Windows rename interaction — test this before shipping

**`lib/atomicwrite.mjs:18-19` names "a backup agent" in the source as one of the processes whose
open handle makes `fs.renameSync` fail on Windows.** The repo has already been bitten by this: the
retry at `:27-29` is 5 attempts with 20/40/60/80 ms waits (~200 ms total), and
`test/windows-fileops.test.mjs:3-7` records the two failures it caused — "a routine save answering
500, and a deleted member's workspace silently staying put".

So a backup walker reading a 6.8 MB notebook *while the user is writing in it* is, on its face, the
hazard this codebase already documented.

**Honest assessment:** libuv opens files with `FILE_SHARE_READ | FILE_SHARE_WRITE |
FILE_SHARE_DELETE`, so an ordinary Node reader most likely does **not** block a rename — the
blocking cases are scanners that open exclusively. Not measured. Given that the cost of being wrong
is the data-loss class this repo has been bitten by twice, this is a **gate, not a footnote**:

> Before enabling the backup on the Windows node, drive a PANote autosave loop against a 6 MB
> notebook while the backup walks the same tree, and assert zero `500 write_failed`.

Two mitigations that cost nothing either way: schedule at 02:30 (§5), and skip files modified in the
last 5 seconds (§4).

### Tests

- `test/helpers-platform.mjs:22-26` supplies `HAS_POSIX_PERMS` / `needPerms` — the
  "destination unwritable" test cannot be forced on Windows (chmod is a no-op) and must **skip**
  there, never pass. `node --test` counts skips separately, which is the whole point
  (`helpers-platform.mjs:8-10`).
- Drive win32 behaviour **from the Mac** by stubbing `process.platform` and `fs`, exactly as
  `test/windows-fileops.test.mjs:28-40` does — the Mac is the only development machine, which is
  the same constraint `lib/wincmd.mjs:73-75` was written under.
- An **R14 control** in every test file: assert the backup branch is actually taken in the
  fixture, or a guard like `if (!cfg.backup) return` makes every assertion pass vacuously.

---

## 8. Risks, and what NOT to build

### Privacy — plainly

This is a family's conversations, journal, **health records**, and handwriting. Today it is on one
laptop in a house, and file access to that machine *is* the authority (`README.md:126`). Any
destination other than an external disk means **a third party holds a copy**: it can be compelled
to produce it, exposed in a breach, retained after deletion, and processed under terms nobody in the
household read. The owner should choose that with eyes open, which is why the warning in §3 is in
the UI and not only in this file.

**One specific hazard:** on a work laptop the only cloud-synced folder may belong to an **employer's**
tenant (e.g. OneDrive). Then the path of least resistance points at the employer — where personal
health records and journal become subject to that employer's DLP, retention and eDiscovery. The
destination field must not make that the easy default.

### Encryption at rest before upload — should it be in v1?

**Not as a blocking requirement — but the format decision must be made in v1.** Reasoning:

- It is technically cheap and keeps "zero dependencies" (`README.md:7`): Node 22 core has
  `crypto.createCipheriv` with `aes-256-gcm` and `crypto.scrypt` — the same primitive already used
  for password hashing (`README.md:229`).
- **But a passphrase on an unattended node is a backup that stops.** The key must be re-entered
  after every restart, and `README.md:267-269` describes exactly the scenario: "an always-on box
  reboots for Windows Update while nobody is signed in". A backup that halts until someone walks
  over and types a passphrase is the §5 failure, caused by the feature meant to protect it.
- **And a forgotten passphrase is an unrecoverable family archive** — a very real way to lose
  everything the feature exists to save.

So: **v1 ships unencrypted, with the destination choice carrying the privacy warning, and
recommends an external disk or a provider-side encrypted folder for anyone who wants
encryption now.** The manifest carries a `format: 1` field from day one and the verify/restore tools
branch on it, so v2 can add `format: 2` (AES-256-GCM per file, key in the **macOS Keychain /
Windows DPAPI** — which solves availability where a passphrase does not) without orphaning every
existing backup. Retrofitting the format later is the expensive mistake; retrofitting the cipher is
not.

### The biggest risks

1. **Excluding `uploads/` → a backup that restores silently incomplete.** Verified: notes and
   conversations reference uploads **by path**, with no inlined bytes, so a restored notebook loses
   its photos while every indicator reads success. §4 includes uploads; §6's verify asserts
   referential integrity so a future "let's save 81 MB" change fails a test instead of a family.
2. **"Wrote to the folder" mistaken for "left the machine."** A paused, quota-full or signed-out
   sync client — or an unmounted volume whose mountpoint we helpfully created — makes everything
   green while nothing is off the machine. Mitigated by: never creating the destination, the marker
   file, reading the manifest **back** from the destination, and a brief line that fires on
   staleness and not only on error. It is mitigated, not solved; say so in the UI.
3. **Privacy blast radius.** ~100 MB of journal, health records and conversations leaving the house,
   unencrypted in v1, possibly into an employer-owned cloud folder.
4. *(Watch item)* **The Windows rename collision** — `lib/atomicwrite.mjs:18-19` names a backup
   agent as a cause. Gated by the test in §7 before the Windows node is enabled.

### Explicitly NOT part of this

- **The Google Drive OAuth client** (§1c). Dead config slots already exist
  (`lib/adminconfig.mjs:40-41`) and are not a head start.
- **Hardlink snapshot rotation.** Cloud sync clients do not preserve hardlinks; it degrades to N
  full copies.
- **A restore button that writes into the live workspace.** Level 3 writes a new directory (§6).
- **Delta-within-file / dedup.** The daily delta is 5 MB. And `lib/appdata.mjs:160-177` records that
  a storage-shape optimisation was built and then **reverted** because adversarial verification
  found three ways it lost work in ordinary flows. Do not re-earn that.
- **Backing up `config.json`** in a per-user backup (§4). That is `migrate.sh`'s job.
- **Pruning orphaned uploads** — 45 of 158 are unreferenced. It is a deletion path; this feature
  does not delete user data.
- **Backing up `apps/`.** Code, in git separately.

---

## Files

| file | change |
|---|---|
| `lib/backup.mjs` | **new** — validator, walker, manifest diff, copy, state read/write. No imports from `web.mjs`; all IO injected, so it unit-tests with no server (the `lib/jobs/store.mjs` discipline). |
| `lib/backup-status.mjs` | **new** — pure derivation of the status block from state + audit tail (the `lib/jobstatus.mjs` pattern) |
| `web.mjs` | `backupTick` as a third stage in the existing tick (`:2207-2232`); `backup` in the `/api/profile` GET (`:1835`) and PUT whitelist (`:1948`); `POST /api/backup/run`, `POST /api/backup/verify`; `backupLine` into `runDailyBrief` (`:229`) |
| `web/settings-dialog.html` | `<details id="backupWrap">` between `:37` and `:45` |
| `web/settings.js` | `renderBackup()` + lazy `toggle` handler (the `healthWrap` pattern, `:62-63`) |
| `backup-verify.mjs`, `backup-restore.mjs` | **new**, repo root beside `migrate.sh` |
| `test/backup-paths.test.mjs` | **new** — destination validator, incl. win32-stubbed cases |
| `test/backup-walk.test.mjs` | **new** — denylist, symlink skip, **uploads referential integrity**, manifest diff |
| `test/backup-status.test.mjs` | **new** — three states never collapse; failed never reads ok |
| `test/backup-ui.test.mjs` | **new** — the section exists, is lazy, and round-trips through `/api/profile`; **no `?user=` parameter exists on any backup route** |

## Implementation order (suite green at every step)

1. `lib/backup.mjs` validator + walker + manifest, with tests. Nothing calls it.
2. `lib/backup-status.mjs` + tests. Still unconsumed.
3. `/api/profile` read/write of the `backup` object + the UI section. Configurable, **never runs.**
4. `POST /api/backup/run` (manual only) + `backup-verify.mjs`. Now it can be exercised by hand, on
   a throwaway destination, before anything is automatic.
5. The tick stage, **default off**, and `backupLine` in the brief.
6. The Windows gate test (§7), then enable on the Windows node.
7. `backup-restore.mjs` and the first Level-3 drill. Record the date in this file.

## Open decisions

1. **Destination.** When the only cloud folder on the node is an employer's,
   pick something else. An external disk avoids every §8 privacy
   concern and loses provider version history. Which?
2. **Snapshots on an external disk** — 7 dated manifests + `.prev/`, or mirror only?
3. **Encryption** — accept v1 unencrypted with `format: 1` in the manifest (recommended), or block
   v1 on the Keychain/DPAPI key work?
