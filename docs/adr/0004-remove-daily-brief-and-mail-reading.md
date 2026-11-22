# ADR 0004 — Remove the daily brief (每日一报) and all mail reading

Status: accepted · 2026-10-11 (owner decision)

## Context

- The daily brief ran every morning at `daily_brief_time` (default 07:30). It sent one message:
  today's calendar, ranked unread mail, a Bible verse line, a daily health alert line, the
  pending-approvals count, and a section for each job whose `deliver` was `fold-daily`. An LLM
  pass (`briefSynthesizer`) wrote a lead paragraph from those facts.
- `fold-daily` was the default `deliver` for every job, including every job made from chat. Those
  jobs saved their briefing and did not push it. The brief carried them the next morning instead.
- Mail reading was a hand-rolled IMAP client, a rule-based ranking, a body and MIME pipeline, and
  per-profile VIP, muted and keyword lists. The brief was its only reader.
- The family did not want the brief. Turning it off already had its own fix (`job-prefs.json`),
  but the owner decided to remove it.

## Decision

1. Remove the daily brief: the `daily-brief` built-in, `lib/daily-brief.mjs`, `lib/brief-facts.mjs`,
   `briefSynthesizer`, `daily_brief_time`, and the bot's `/brief` command.
2. Every job sends its own message. `DELIVER` is now `['own-message', 'feed-only']`, and new jobs
   default to `own-message`. Results still go to the Briefings feed.
   **Legacy alias:** job files on disk that say `fold-daily` keep working. `validateJob` normalises
   `fold-daily` to `own-message` whenever a job is read or validated. Nothing is written back.
   A file is rewritten only when its owner saves the job again. The fold machinery
   (`lib/jobs/fold.mjs`, the gate in `pushBriefing`, Run now's `markFolded`) is removed.
3. Remove the daily health alert line (`healthDailyException`). The weekly 健康简报 stays, along
   with everything it uses, and is now the only built-in job.
4. Remove all mail reading: `lib/imap.mjs`, `lib/mail-rank.mjs`, `lib/mail-body.mjs`,
   `lib/mime.mjs`, the profile mail lists, `gmail_user` and `gmail_app_password`. AgentMail stays.
   It only sends, and it is the email channel for job briefings and reminders.
5. The calendar feed settings (`calendar_ics` and per-profile `calendarIcs`) fed only the brief,
   so they are removed too. `lib/ics.mjs` stays, because `lib/tools/pollen.mjs` uses its
   `isPrivateAddress` SSRF guard.
6. User data on disk is never touched:
   - Config keys that nothing reads any more are ignored.
   - Stored profile fields pass through unchanged and are never acted on.
   - Old `daily-brief` briefings stay in the feed until they expire.
   - `job-prefs.json` and `job-runs.json` entries for `daily-brief` are inert.

## Consequences

- More messages: each job that used to fold now pushes on every scheduled run.
- There is no daily reminder of pending approvals. They still show in the app (`/api/actions`)
  and as Telegram buttons on the message that proposed them.
  > **Superseded 2026-10-12 (ADR 0006):** the Telegram bot and its buttons were removed.
  > Approvals now show only in the app (the longevity app's Pending Approvals).
- This closes the gap ADR 0002 listed as "the daily-brief synthesizer still runs unrestricted
  over mail bodies". That lane no longer exists.
- `feed-only` is still not honoured by `pushBriefing`. This was true before this change. It now
  behaves exactly like `own-message`. Whether to honour it or drop it is a separate decision.
- The unbuilt backup plan (`docs/plans/workspace-data-backup.md`) used the brief as its alert
  surface. That part must be re-specified before the plan is built.
- `lib/ics.mjs` keeps a parser and fetcher with no production caller. Splitting out
  `isPrivateAddress` and deleting the rest is a separate refactor (R8).
