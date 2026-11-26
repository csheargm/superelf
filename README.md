# superelf — 管家

A personal / family **AI superapp** you host yourself. It runs on an always-on
laptop and you reach it from any phone through a **mobile web app**. Every message
becomes a Claude Code turn in a private workspace.

Zero dependencies — plain Node 22+, no frameworks, no `npm install`.

## What it does

- **One app, one brain:** a mobile web app driving Claude Code headless (`claude -p`).
  Briefings and reminders arrive in the app, and by email to anyone who sets a briefing
  email. (The Telegram bot was removed on 2026-10-12, ADR 0006.)
- **Multi-user with real isolation:** each family member has their own login and a
  fully separate workspace — own conversations, memory, uploads, and apps. Nobody
  sees anyone else's data.
- **Accounts & roles:** username + PIN login, server-side sessions, self-registration
  (auto-approve by default), an owner (admin) who manages family accounts and sees an
  audit log. Age-appropriate personas for kids and teens.
- **LLM-generated mini-apps:** ask the chat "make an app that shows my weekly steps"
  and it writes a sandboxed web app that appears on your home screen. Apps are pure
  presentation — no token, no network — and read data through a broker.
- **Nice to use:** streaming replies, markdown rendering, file upload, mic/voice input,
  a conversations panel, and scheduled jobs that send their own briefings.

## How it works

```
Phone ── Web app ⇄ web.mjs ──→ claude -p (headless), cwd = that user's private workspace
                               session resumed per conversation
```

## Install

**One script does the whole install.** You only have to get the files onto the machine first,
because the script lives inside the repo.

### Windows 11

1. Open the repo in a browser and choose **Code → Download ZIP**. Being signed in is what lets a
   private repo download; nothing needs to be installed for this.
2. Extract it to **`C:\superelf`** — keep the path short: long-path support is usually off, and a
   deep folder plus nested workspace data hits Windows' 260-character ceiling.
3. In that folder, run the one script:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

That is the whole install. The script checks the machine, **installs anything missing** — Node, the
Claude Code CLI, git — sets the laptop never to sleep, creates your owner account, registers
autostart, and starts the node.

### macOS / Linux

```bash
git clone https://github.com/csheargm/superelf.git && cd superelf && ./install.sh
```

**Linux（systemd 用户服务）:** the installer writes a systemd **user** service (`superelf-web`, at
`~/.config/systemd/user/superelf-web.service`), enables it, and turns on **linger**
(`loginctl enable-linger`, falling back to `sudo`). Linger is what makes a user service start at
**boot** with nobody logged in; without it the node starts at login and stops at logout, and the
installer says so loudly instead of claiming "runs at boot". With no systemd user session at all
(WSL without systemd, a container) it installs no service, says so, and tells you to run
`./run.sh web` under your own supervisor. Install Node 22+ first on Ubuntu — `apt install nodejs`
gives an older one. To run superelf as an **isolated node in a Linux VM on a Windows PC**, see
[docs/vm-node.md](docs/vm-node.md).

### Notes

- `-ExecutionPolicy Bypass` is required, not advice: Windows client defaults to `Restricted`, which
  refuses to run any `.ps1`. It applies to that one command and changes nothing globally.
- **Want `git pull` updates?** A ZIP has no `.git`. Either `winget install Git.Git` and
  `git clone https://github.com/csheargm/superelf.git C:\superelf` instead of unzipping — Git
  Credential Manager authorises the private clone in a browser, no token to paste — or just
  re-download the ZIP when you want a newer version. Same `install.ps1` either way.
- **A true single-command install** (no download step at all) needs the repo to be **public**, so
  that PowerShell can fetch the script directly. While it is private, GitHub will not serve the
  file without credentials, and a one-liner would fail with a confusing 404.

**It installs prerequisites for you** rather than sending you away to do it. Missing Node, a
missing Claude Code CLI, missing git, a laptop set to sleep — it fixes them, then re-runs every
check and trusts *that*, not the installer's own exit codes. Three things genuinely need you, and
it says which and why:

- **signing in to Claude Code** — interactive by nature. Installing the CLI gives you a binary
  with **no account**; until you run `claude` once and sign in, superelf starts perfectly and then
  fails every single request. The installer cannot do it for you, but it does **test** it: it asks
  the CLI to answer, and reports PASS, or FAIL with what to do.
- **a port someone else holds** — not ours to kill.
- **anything Group Policy forbids** — your IT department's to change.

To look without touching anything:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -CheckOnly
```

That reports PASS / WARN / FAIL / **UNKNOWN** and stops. UNKNOWN is never counted as a pass — a
check that turns "I could not tell" into a green tick is worse than no check, because you find out
after committing to the install. Other switches: `-NoInstallDeps` (check, never install for me)
and `-NoService` (skip autostart and the start).

Both installers are safe to re-run after a `git pull`. Neither touches `config.json`, your
workspaces, or the owner account. On Linux the re-run restarts the service, so the new code runs;
on macOS follow it with `./stop.sh && ./start.sh`.

**Install somewhere short on Windows — `C:\superelf`.** Long-path support is usually off, and a
deep folder plus nested workspace data hits the 260-character ceiling.

| | macOS / Linux | Windows |
|---|---|---|
| install | `./install.sh` | `powershell -ExecutionPolicy Bypass -File .\install.ps1` |
| check only | — | `.\install.ps1 -CheckOnly` |
| start | `./start.sh` | `.\start.ps1` |
| stop | `./stop.sh` | `.\stop.ps1` |
| update（更新） | Linux node: `./deploy.sh` (snapshot first) · macOS: `git pull && ./install.sh && ./stop.sh && ./start.sh` | `git pull`, then re-run the installer (above) |
| autostart | macOS: launchd agent `com.superelf.web` · Linux: systemd user service `superelf-web` + linger | Scheduled Task `superelf-web` |
| logs | macOS: `~/Library/Logs/superelf.log` · Linux: `journalctl --user -u superelf-web -f` | `web.log` in the repo folder |

All three keep the node alive by restarting it on **any** exit, not only on a crash. That is
deliberate: the in-app **Restart** button exits cleanly (code 0), so a crash-only supervisor —
including Task Scheduler's own "restart on failure" — would treat Restart as a deliberate stop and
leave the machine down. On Windows the Scheduled Task launches `run.ps1`, which owns the restart
loop, rather than launching `node` itself. On Linux the systemd unit says `Restart=always` for the
same reason.

**The Telegram bot is gone (2026-10-12, ADR 0006).** If a node ran it, run `./stop.sh &&
./start.sh` once after updating (Windows: `.\stop.ps1`, then `.\start.ps1`): that ends a leftover
bot loop and, on Windows, removes the `superelf-bot` task. Its keys in `config.json` are ignored;
delete them and `state.json` whenever you like.

**Creating the owner.** The installer does this by running `node setup.mjs`, which asks for a
username and password at the terminal — prompted, never typed as an argument. You can also run
`node setup.mjs` on its own; a node that already has an owner refuses, so it is safe to re-run.
If you skip it and set up in the browser instead, the form asks for a **one-time setup code**
(一次性初始化码): the server prints it to its log at start and writes it to `./setup-code`, and
deletes it once the owner exists. Without it, the first visitor to reach the node would become
its owner.

**Lost the password?** You have file access to the machine, which is the authority:
`node resetpin.mjs <username> <new-password>`, then restart.

## Moving an install to another machine（迁移）

Everything that belongs to a person lives in their workspace directory, and everything that
describes the node lives in `config.json`. Both are portable between macOS, Linux and Windows:

```
config.json          accounts, tokens, hashed passwords, settings
workspace/           the owner's data
workspace-<id>/      one per family member
shared-apps/         the apps that ship with the node (tracked in git)
```

Build the bundle on the machine you are leaving. It is read-only — nothing here is modified:

```bash
./migrate.sh /Volumes/USB/superelf-migration
```

Then on the new machine: clone, drop `config.json` and the workspace folders from the bundle
into that folder, and run the installer. (Run it with `-CheckOnly` first if you want to see what
it finds before it changes anything.)

`migrate.sh` refuses a target that already holds data (unless you pass `--force`), skips the
committed `workspace.example`, and leaves the node you copy FROM untouched.

Workspace paths in `config.json` are stored **relative** to the repo, so they resolve on either OS.
The copy preserves bytes exactly: nothing in a workspace is platform-specific, but mini-app data is
fingerprinted by content, so a copy that rewrote anything would make every app read as modified.

**Add family members:** ⚙️ Settings → **Family** → add a member (id, name, birth year)
→ hand them the PIN, or let them self-register from the login screen. Each gets their
own private workspace automatically.

## Backup · 备份

`./backup.sh` packs the whole node folder (data, `config.json`, git history; not logs or caches),
encrypts it with AES-256 on this Mac, and uploads one file per night straight to Google Drive with
[rclone](https://rclone.org) — or writes it to a local folder. Each file is named after the Mac,
and only that Mac's newest `backup_keep` files are kept. Never put the live node folder itself in
a synced folder: two-way sync can write an old copy back over live data.

```bash
brew install rclone
rclone config create gdrive drive scope=drive.file   # browser sign-in; rclone sees only files it made
./backup.sh --setup     # makes the passphrase, stores it in the Keychain, shows it ONCE — save it
                        # in your password manager: without it no backup can be opened
./backup.sh             # one backup now
./backup.sh --install   # every night at 03:30 (a missed night runs when the Mac wakes)
```

`config.json`: `"backup_dir": "gdrive:superelf-backups"` (or a local folder path) and
`"backup_keep"` (default 7) — read on every run. Log: `~/Library/Logs/superelf-backup.log`.
Nothing alerts you if a night fails: look in the Drive folder now and then. macOS only for now.

Folders outside the node folder can ride in the same nightly archive (default: none, read on
every run):

```json
"backup_extra": [{ "dir": "/absolute/folder", "exclude": ["vm", "cache", "*/.cache", "*.sock"],
                   "pause": ["/absolute/program", "pause"], "resume": ["/absolute/program", "resume"] }]
```

`exclude` lists paths inside `dir`; `*` matches any characters, `/` included. `pause` and
`resume` (optional, both or neither; each a command as a list, its program an absolute path) run
right before and right after that folder is packed, so a program that keeps a database or a
browser profile open there is still while it is copied. `resume` runs whatever happens (also
after a failed pause, a failure or a signal), so it must do nothing when nothing is paused; a
resume that fails is a warning in the log and ends the run with exit 1 (the backup is kept).
Without them the folder is copied as it is at that moment, like any live copy.

Each extra folder is packed first, by its own tar, so a problem there costs only that folder,
with a warning in the log, and the node is still backed up. Skipped that night: a folder that
does not exist, whose pause fails, whose resume program cannot run, or that cannot be read whole
(a file tar cannot open, or one deleted while tar reads it: bsdtar then stops or breaks off the
copy, so a partial copy is never kept). A malformed entry, a link, or a folder that
overlaps the node folder, the backup folder or another extra folder stops the backup before
anything is written. tar skips live sockets by itself, with a warning in the log (`"*.sock"` in
`exclude` keeps the log quiet). Each folder's copy is written to local temp space (private to
you) before it goes into the encrypted archive, and removed after.

```bash
./restore.sh gdrive:superelf-backups/superelf-<mac>-2026-10-13.tar.gz.gpg ~/superelf-restored
```

The target must be new or empty. It uses the Keychain passphrase, or asks for it (a new machine,
or a backup made under an older passphrase). Then, on the same Mac, stop superelf, swap the
restored folder in, start it; on a new machine, install the tools, run `./install.sh`, sign in to
`claude` and `codex`, `tailscale up`, `./start.sh`.

Extra folders go back to their own absolute paths when those are new or empty. A folder that
already has files is never written into: its copy goes beside it as `<folder>.restored-<time>`, and
restore says so; stop whatever uses the folder, swap the copy in, start it again.

## Config

`config.json` (git-ignored — never commit it):

- `users` — array of `{ id, name, role, token, workspace }`. The owner
  is derived automatically on first run; tokens are generated for you.
- `require_approval` — new self-registrations wait for owner approval (default `true`;
  set `false` to auto-approve). A config that already sets it keeps its value.
- `bind_host` — the address the server listens on, read at start (default `127.0.0.1`).
  Behind `tailscale serve` leave it: serve proxies to localhost. For direct LAN access from a
  phone set `"0.0.0.0"` (all interfaces) or the machine's LAN / Tailscale `100.x` address.
- `claude_args` / `fast_args` — model per lane (sonnet / haiku). The default `fast_args` also
  turns thinking off for the background asks (`/api/ask`, the job resolver). A `fast_args` you
  set replaces that default whole: to keep thinking off, it must include
  `"--settings", "{\"alwaysThinkingEnabled\":false}"` itself. See docs/adr/0008.
- `one_shot_args` — added to the Claude lane for one-shot component requests such as the
  Journal's Design with AI (default: thinking off; `[]` adds nothing). A `--settings` of your own
  wins and the default's is dropped: one in `claude_args` on one-shot turns, one in `member_args`
  on every confined turn (over `fast_args`' too). The claude CLI applies only the FIRST
  `--settings` it is given, so when both `claude_args` and `member_args` pass one, `member_args`'
  is ignored on confined chat and one-shot turns. See docs/adr/0008.
- `one_shot_model` — the `chat_models` id that answers those requests, whatever the app's model
  chooser says (default `claude`; `""` uses the request's model).
- `claude_token_file` — a long-lived Claude token file (default `claude-token` in the node root),
  read at every Claude spawn; see superelf.md "Node operation: Claude sign-in" and docs/adr/0024.
- `agentmail_key` — turns on the email channel: briefings and reminders go to each
  profile's briefing email
- `model_review` — the weekly model review（模型评测, docs/adr/0017）. It tests the Ollama cloud
  catalog's new models on our uses and keeps the best 3 in each of Fast and Deep. The first review
  on a node only reports. Every key is optional; the defaults are in lib/model-review-config.mjs:
  `{ "time": "03:00", "every_days": 7, "tests": "model-review/tests.json", "concurrency": 3,
  "call_timeout_s": 120, "max_calls": 200, "margin": 0.5, "max_slowdown": 1.5 }`.
  - `time` is when it looks daily whether a review is due: `every_days` have passed, or the
    daily model check saw a new catalog model.
  - `tests` is the test data file. Edit it to change what is tested.
  - `concurrency`, `call_timeout_s` and `max_calls` bound the Ollama calls.
  - A newcomer replaces a lane only when its rank is `margin` higher and it is at most
    `max_slowdown` times slower to first text.
  To undo the last change: Your profile > Jobs · 任务 > 撤销模型评测 · Undo model review > Run now.
- Removed keys are ignored if an old `config.json` still has them: `telegram_bot_token`,
  `allowed_user_ids`, `owner_chat_id`, `users[].telegram_id`, `schedules`, `deep_args`
  (ADR 0006), and the daily brief's and mail reader's keys (ADR 0004).

The web server reloads `config.json` about 3 seconds after a save, once the file has stopped
changing. A value it reads where it is used, such as `one_shot_args`, applies to the next use with
no restart. Values captured at startup (marked "restart" in Node settings) still need one, and
`users` is not reloaded. That reload never writes `config.json`. A save that does not parse is
ignored and audited; the last good config stays (docs/adr/0011).

## Web app

`./start.sh` serves the web app on port 8787. On a phone: open it, log in, and
**Add to Home Screen** for an app-like feel. Features: conversations panel (☰),
settings/profile (⚙️), app grid, streaming chat, upload (＋), mic (🎤), voice mode (🔊).

### App data & recovery（应用数据与恢复）

Mini-apps store their data (handwriting notebooks, annotations, chat pointers)
as JSON files under `<workspace>/data/<app>/…` through `POST /api/save-data`.
The server's guarantees, all enforced in `lib/appdata.mjs`:

- **Atomic** — every save is tmp + fsync + rename, so a crash, a `SIGTERM` from
  the ops lifecycle, or a full disk can never leave a half-written note. The
  previous version is replaced in one step or not at all.
- **Validated** — a payload that is not JSON text for an object or array is
  refused with `400 {"code":"bad_data"}`. Nothing is ever stored as `null`.
- **Honest** — a save that fails answers `500 {"code":"write_failed"}` (and is
  audited); a body past its cap answers `413 {"ok":false,"code":"too-large",
  "limit":N}` — the SAME shape on every route (`lib/webutil.mjs`
  `CODE_TOO_LARGE`), so a client reacts to size once instead of per route. A
  failed save is never reported as a successful one.
- **Never overwritten from a failed read** — a handler that must read a stored
  document before rewriting it uses `readJsonForUpdate`, which distinguishes
  "not there yet" (fine, first save) from "there but unreadable" (refused:
  `500 {"code":"file_unreadable"}`, damaged bytes left on disk for recovery).
  The lenient reader is for display only.
- **Recoverable** — the previous version of each file is kept as `<name>.bak`
  (one generation, refreshed at most once a minute, and never replaced by a
  file that collapsed to less than half its size).

To recover a note (both need the usual session/Bearer auth):

```bash
# 1. look at the backup first
curl -H "Authorization: Bearer $TOKEN" \
     http://localhost:8787/api/data/data/notes/entry-xxxx.json.bak

# 2. put it back (atomic; the .bak is kept, so this is repeatable)
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
     -d '{"path":"data/notes/entry-xxxx.json"}' \
     http://localhost:8787/api/restore-data
```

### Security model

- **Auth:** username + PIN → server-issued session (scrypt-hashed passwords,
  30-day sessions). A new PIN/password must be at least 8 characters (older shorter PINs still
  sign in until changed). Failed sign-ins lock the account and the client address after 5 tries,
  with a doubling wait (30 s up to 1 h; in memory, cleared by a restart). The session token is
  read from the `Authorization: Bearer` header only — never from a `?t=` URL parameter.
- **API tokens:** each user's `token` (the owner's is `web_token` on a legacy config) is an API
  key for non-browser use, e.g. the health and meal Shortcuts (`Authorization: Bearer`). It can
  start a browser session only while that account has no PIN yet (first sign-in); after that,
  sign in with the PIN. Once the account has a PIN, an API-key request cannot change the PIN or use `/api/admin`.
  Registration stays closed until the owner exists.
- **Isolation:** every request resolves to a user; all data paths are scoped to
  that user's workspace. Members cannot reach the owner-only admin/audit endpoints.
- **Apps are sandboxed:** served with `Content-Security-Policy: sandbox allow-scripts;
  … connect-src 'none'`, so a generated app runs in an opaque origin with **no network
  and no token** — it cannot exfiltrate data even if malicious. It gets data only
  through the shell's postMessage broker.
- **App AI requests run confined（应用 AI 请求受限运行）:** every agent request an app
  makes (broker `chat` / `ask`, model choice, Verify · 校验) runs in a **confined lane
  (受限通道)**, **even in the owner's session（即使是主人账号）**:
  - It never gets `--dangerously-skip-permissions`.
  - It has an explicit Bash deny.
  - It cannot read outside the workspace.
  - It never uses the GPT (Codex) lane, which can read any file.
  - It **writes no file at all（不写任何文件）**, not even in its app's `data/<slug>/`, unless the
    owner's config grants it (ADR 0016). The app saves through `save-data` (ADR 0019).
  - It cannot continue a conversation that another surface started (对话归属). In
    particular, it cannot continue the owner's composer chats.

  So an app can neither drive the owner's full-access agent directly nor plant instructions
  for it. Planting would mean writing `profile.json`, `CLAUDE.md`, `memory/` or
  `conversations/`, or posting into the owner's chat history. Only the owner's own chat (the
  shell composer, not an app) keeps the unrestricted lane.

  Why: you cannot tell who wrote an app from where it runs, and a family-shelf app may be
  member-authored. The shell relay marks these requests itself (`x-superelf-origin`) and
  derives the app's slug from the frame URL, so an app can change neither
  (`lib/agent-origin.mjs`, ADR 0002).

  Known gaps, tracked in ADR 0002:
  - An app's agent can still *read* the workspace.
  - The `attach-url` and `convo*` broker kinds are not scoped to the app.
- **Path safety:** `/api/data` resolves symlinks to stay inside the workspace; app
  directories serve only presentation assets, never data files.

Four independent security reviews (see commit history) hardened the sandbox, the
cross-user isolation, and the auth subsystem before release.

## HTTPS & remote access (Tailscale)

The server is plain HTTP, and listens on `127.0.0.1` only unless `bind_host` says otherwise.
For encryption, off-home access, and the in-app
mic (the browser speech API requires HTTPS), use **[Tailscale](https://tailscale.com)**:

1. Install Tailscale on the laptop and each family phone; sign them into one tailnet.
2. *(optional)* Rename the laptop node to something neutral (e.g. `home-server`) in the
   Tailscale admin console — the node name appears in public certificate-transparency
   logs.
3. On the laptop: `tailscale serve --bg 8787`.
4. Family opens `https://<node>.<tailnet>.ts.net` — encrypted, private to your devices,
   real cert, no router changes.

Do **not** port-forward this server on your router.

## Always-on machine（常开机器）

Anything that stays powered works: a spare laptop, a mini PC, a MateBook. Install it the normal
way above — the installer registers the autostart service for you — then:

- **Power:** set the machine never to sleep on AC. A sleeping node is an offline node.
  Windows: Settings → System → Power. macOS: System Settings → Battery → Options.
- **Reachability:** the server is plain HTTP on `127.0.0.1` (see `bind_host`). For access from phones, and
  for the in-app microphone (browsers require HTTPS for it), use Tailscale as described above.
- **Windows autostart** is a Scheduled Task named `superelf-web`, triggered at logon *and* at
  startup, with no execution time limit. The startup trigger matters: an always-on box reboots
  for Windows Update while nobody is signed in, and a logon-only task leaves it down until
  somebody walks over to it.

## Upgrading to the login hardening（登录加固升级说明）

What an existing node must do: **nothing**, if phones reach it through `tailscale serve`. Restart
it once to pick up the change. Your owner account is already set up, so no setup code is needed.

- If phones open it directly at `http://<LAN-address>:8787`, that stops working after the
  restart, because the server now listens on `127.0.0.1` only. Either use `tailscale serve`
  (above), or add `"bind_host": "0.0.0.0"` to `config.json` and restart.
- Self-registration now waits for your approval unless `config.json` sets `require_approval`.
- Existing PINs shorter than 8 characters keep working; a new or changed one must be 8+.
- The "sign in with access token" link works only for an account with no PIN yet.

## Known limitations

- **Shared Claude/ChatGPT login = shared rate limit,** and tasks run one at a time.
  Fine for a family; for heavier use, per-user API keys are the clean upgrade.
- **Email is the only phone delivery.** Briefings and reminders show in the app; they reach
  a phone only by email, and only for a profile with a briefing email on a node with an
  AgentMail key. There is no push notification.
- **Approvals live in one app.** Pending approvals are listed and decided only in the
  longevity app's Pending Approvals; there is no list in the shell.

## Web pages & search

The model's built-in web fetch is often blocked (redirects, bot-checks, region
limits). superelf ships `fetchurl.mjs` — the agent reads a URL by running
`node fetchurl.mjs <url>` (follows redirects, strips HTML to text, SSRF-guarded:
refuses private/internal addresses). For real search or cited answers, a Perplexity
API key is the planned add-on (a Perplexity Pro subscription includes a monthly API
allowance). Local/on-device models via Ollama Cloud and frontier fallbacks via
OpenRouter are also on the roadmap — Claude and ChatGPT stay primary.

## Tests

```bash
npm test          # the full unit + integration suite
node smoke.mjs    # end-to-end API checks against a running server (localhost only)
```

A few tests need a POSIX tool (`bash`) or POSIX file permissions to force a failure. On Windows
those are reported as **skipped**, never as passes — `node --test` counts them separately, so a
run that could not check something says so.

**CI（持续集成）** — `.github/workflows/ci.yml` runs `npm test` on **Linux and Windows** for every
push and pull request. **macOS** runs only when started by hand, because the Mac runs the suite
locally and macOS minutes cost about ten times Linux ones on a private repo:

```bash
gh workflow run ci.yml --ref <branch>     # Linux + Windows + macOS
gh run watch                              # follow it
```

A run in which fewer than `MIN_TESTS` tests passed (set in the workflow), or any test skipped
without a reason tag that `test/helpers-skip.mjs` expects on that OS, fails even if nothing failed
(`.github/ci-guard.mjs`): a path bug that tests nothing, or a probe that turns tests into skips, is
not a green run. Skip with `skipIf` / `skipBecause` from that file; no ceiling to raise. Deploy to the
Linux node only commits that are green here — `./deploy.sh` on the node, see
[docs/vm-node.md](docs/vm-node.md).
