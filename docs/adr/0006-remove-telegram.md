# ADR 0006 — Remove the Telegram bot

Status: accepted · 2026-10-12 (owner decision)

## Context

- The Telegram bot (`bot.mjs`) was a second front end beside the web app. It had:
  - chat replies into the sender's workspace;
  - the commands `/q`, `/deep`, `/bg`, `/project`, `/new`, `/status`, `/stop` and `/schedules`;
  - config `schedules`: a prompt run at a time of day;
  - inline Approve/Deny buttons for proposed actions (`lib/approve-telegram.mjs`).
- It ran under its own supervisor (`run.sh bot`, or `run.ps1 bot` from the Windows
  `superelf-bot` task), started only when a token was set. Its chat state lived in `state.json`.
- web.mjs used the bot's client (`lib/telegram.mjs`) as well. It pushed every job briefing and
  every reminder to a member's Telegram chat when that member had a `telegram_id`. Email
  (AgentMail, sent to a profile's `briefingEmail`) ran beside it.
- A read-only check of the live node on 2026-10-12 found:
  - A token was set, one user had a `telegram_id`, and one schedule was configured.
  - The bot process was NOT running, so chat, commands, approval buttons and that schedule
    already did nothing.
  - The one live effect was web.mjs pushing briefings and reminders to Telegram.
  - An AgentMail key was set and one profile had a `briefingEmail`, so email delivery already
    worked.

## Decision

1. Remove the Telegram feature entirely. Deleted: `bot.mjs`, `lib/telegram.mjs`,
   `lib/approve-telegram.mjs`, and the modules only the bot used: `lib/stream.mjs`,
   `lib/format.mjs`, `lib/sessions.mjs` (`state.json`) and `lib/chunk.mjs`. Also removed, because
   the bot was their only user:
   - the Telegram half of `lib/notify.mjs`;
   - `killActive` / `trackActive` in `lib/runner.mjs`;
   - `dueSchedules` in `lib/schedule.mjs`;
   - `?via=telegram` on the decide route, and the `via` audit field.
2. Job briefings and reminders are delivered **in the app and by email only**. `pushBriefing`
   calls `notifyBriefingEmail` alone. No Web Push and no new UI.
3. Pending approvals stay where they already work: the longevity app's Pending Approvals
   (`/api/actions`, broker kinds `actions` and `action-decide`).
4. What only the bot offered is gone: chat replies, `/project` (running the agent in a project
   directory that is not a workspace, such as `bible`), `/deep`, `/bg` and config `schedules`.
5. Config keys dropped: `telegram_bot_token`, `allowed_user_ids`, `owner_chat_id`,
   `users[].telegram_id`, `schedules` and `deep_args`. ADR 0004 set the precedent:
   - An old `config.json` that still has them loads, and nothing reads them.
   - Node settings no longer list the bot token, and refuse to write it.
   - The user record no longer carries `telegram_id`. It drops out of `config.json` the next
     time the users are saved (an admin edit, a registration). The top-level keys stay until the
     owner deletes them.
6. `projects` / `default_project` keep their validation unchanged here. Nothing else reads them
   now except the legacy single-owner setup in `lib/users.mjs`.
7. Ops: the start, run and install scripts no longer launch, supervise or register the bot.
   `migrate.sh` no longer blanks a token. It now copies `config.json` byte for byte.
8. **Legacy cleanup, until every node is clean.** A `run.sh bot` / `run.ps1 bot` loop started before the
   update survives `git pull`, and it restarts the deleted `bot.mjs` every 2 seconds. So:
   - `stop.sh` and `stop.ps1` still kill such a loop and any stray `bot.mjs` node;
   - `stop.ps1` stops, then unregisters, the `superelf-bot` task if it exists.

   Both carry `TODO(legacy-bot)`: delete it once the one-time cleanup below is confirmed on every
   node. A release count is not enough, because neither Linux `deploy.sh` nor the Windows update
   (`git pull`, then `install.ps1`) runs a stop script. `test/removed-telegram.test.mjs` pins it
   until then.

Two security holes were found in the bot and fixed on `fix/bot-lane-confinement` and
`fix/bot-command-scope`. Those branches were dropped with it, because this ADR deletes the code
they fixed:

- A member who linked Telegram got the owner's `--dangerously-skip-permissions` lane.
- The bot's command state was global. A member's `/project` moved the owner's next turn, and a
  member's `/stop` killed the owner's task.

## Consequences and known gaps

- **Approvals appear only in the longevity app.** There is no shell-wide approvals list (see
  "Notification centre in the shell" in PLAN.md). With the buttons gone, a pending approval is
  seen only when someone opens that app.
- **Email is the only phone delivery.** A member without a `briefingEmail`, or a node without an
  AgentMail key, gets briefings and reminders only inside the app. There is no push notification.
- **`/project` is gone.** superelf can no longer run the agent in a non-workspace project such as
  the owner's code repo. Retiring `projects` / `default_project` from config validation is a
  follow-up.
- **Old config keys are ignored on load,** not deleted. They stay in `config.json` until the owner
  removes them; only `users[].telegram_id` drops out by itself, on the next save. `state.json`
  stays on disk until deleted. `.gitignore` keeps ignoring it until no node has one.
- Old audit rows that say `briefing-notify-failed` with channel `telegram` still count in the Jobs
  view: a job shows "delivery failed" until its next briefing. `lib/jobstatus.mjs` keeps reading
  that event name for this reason.
- On Windows, the documented update (git pull, then the installer) does not run `stop.ps1`. A
  leftover `superelf-bot` task stays registered until `stop.ps1` runs once. Until then it fails at
  once, because `run.ps1` accepts only `web`.
- ADR 0004's consequence "approvals show as Telegram buttons on the message that proposed them" no
  longer holds.

## One-time cleanup on a node that ran the bot

After deploying, on each node:

1. Run `./stop.sh && ./start.sh` once (Windows: `.\stop.ps1` then `.\start.ps1`). This ends a
   leftover bot loop. On Windows it also unregisters the `superelf-bot` task.
2. Optional: delete `state.json` in the repo root. It held only the bot's chat sessions,
   `scheduleRuns` and `currentProject`. Do not confuse it with `sessions.json`, which holds the
   web logins.
3. Optional: delete `telegram_bot_token`, `allowed_user_ids`, `owner_chat_id`, `schedules` and
   `deep_args` from `config.json`. Nothing reads them. Then revoke the bot token with @BotFather
   (`/revoke` or `/deletebot`).
