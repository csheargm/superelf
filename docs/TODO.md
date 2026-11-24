# TODO · 待办

Problems found while doing an asked-for task, not needed for that task. One line each; the task
that found it in brackets. Pick from here; do not open a side session per item.

## Change this app · 改这个应用 (ADR 0040, Phase 1 shipped 2026-11-24)
- Phase 2: members and demo guests, the no-tools server-written lane (plan "Phase 2"); until then the server refuses them.
- Phase 3: member Publish as PR with their own token (plan "Phase 3"); needs the owner's OK for per-user token storage.
- Nightly review run + "审核一下 · Review now" (plan "Review"): a second model reviews the day's edits; not built.
- Inline check "loads headless" is only a script compile (lib/app-edit.mjs): runtime errors are not caught; a real headless load needs a browser on the node.
- The one-edit-per-app lock is in-process memory: fine for one node process; it resets on restart.
- The panel stops non-shell messages with a capture listener (web/app-edit-panel.html); apps' own broker listeners (broker, chat-ui, photo-ui, app-prefs) still accept a sibling frame's forged reply — a source===parent check there breaks ~40 unit harnesses that post without a source; fix harnesses + guard in one change.
- A turn during which the app's data changed is said, not blocked (the open app saves while the agent works); corrupt data is caught only when the app itself changed.
- The owner panel runs the full agent on app files that may come from a member's shelf app (a fork): prompt-injection risk the composer already has; Phase 2's no-tools lane could be offered for forked apps.
- Own-bar long-press needs navigator.userActivation (Safari 16.4+); older engines refuse the press (fail closed).
- PASnap: inner iframes are blank; :hover / live scroll inside sticky layers drawn at rest; real iPad Safari not yet checked (Playwright WebKit draws it).
- Undo walks back through edits; there is no Redo button (the replaced copy is kept as <stamp>-undo in .app-versions).
- Pre-existing, seen while testing: test/member-plain-lane-e2e "owner ticks Agent tools" fails on origin/main too (checkbox click does not change state); WebKit app-own-bar-e2e "Journal pen stroke" fails on origin/main too.

## Verse ink: handwriting frame leftovers (GPT review 2026-11-22, web/ink-frame.inline.html)

- Circle round words (followEnclosures, 2026-11-22): on another width a closed big stroke is re-anchored
  to the characters whose middle lies inside it, and line-frame writing chained to it within NEAR moves
  with it. Known limits: only CLOSED single strokes (an open bracket or underline is not re-anchored);
  the written width must be on record (a ww/fw in the chapter that re-measures the stored run width) —
  a chapter with no line-frame writing and no ww keeps the old placement; unrelated writing touching
  the circle within NEAR is taken along with it.
- Writing more onto a line whose handwriting is already shrunk to fit (a phone) and running past its
  right edge re-shrinks the whole block on lift, so the new stroke lands a little left of where it was
  drawn. Fix: solve the stroke's frame offset against the post-commit scale.
- Old records: erasing the last whole-line stroke next to old letter-pieces sends those pieces back to
  their word anchors (they no longer classify as writing).
- Two short underlines drawn within 1.5 s and under 16 px apart count as writing (no shape test).
- Old letter-pieces that reached into the Chinese line (3 of 316 strokes in Romans 7) sit on that
  line's frame, not the English line's, so on another width they part from the sentence.

## First-use tips · 首次提示
- The 8 tips are pinned at source level and the component runs for real in test/tips.test.mjs; no
  host-level fake-DOM run of each tip on the Journal/Bible pages yet, and none seen in a browser
  (ADR 0030 requires one before the rule counts as met). (first-use-tips)
- tipsSeen in the Settings JSON box: a Save made with the dialog open drops a tip dismissed meanwhile
  (the box is the whole prefs object, same as every other key). (first-use-tips)

## Pane chrome · 面板控制
- Escape (rail close()) hides docked panes but leaves a floating window up; close() could hand it to
  the chrome too. (feat/bible-panes session 1)
- Float / drag / resize not yet seen in a browser or on iPad hardware; covered by test/pane-chrome.test.mjs
  in a fake DOM only. (feat/bible-panes session 1)
- Bible top bar: Note / Ask AI toggles + their tips sit in the over-budget host (TODO(R4 seam) there);
  move them into a Bible top-bar block when the host is split. (feat/bible-panes session 2)
- Bible top bar on a phone: the two labelled buttons wrap to two lines under 600px; not yet seen in a
  real browser at 375px, so the nav may still crowd beside ⚙. (feat/bible-panes session 2)
- Pressed state follows PASplit onToggle/onClose; a floating pane closed by the chrome is assumed to go
  through toggle() (it does today); no browser check yet. (feat/bible-panes session 2)

## Journal stationery · 信纸
- A `sanitize()` re-check cannot be stopped while it runs; the deadline is checked between checks
  (about 35 ms at 300 KB on a Mac). Bounded, not interruptible. (simplify, R13 round 5)
- Work units are not time (a unit costs 0.01-0.6 µs by walk); the 150 ms deadline is the real
  bound. Re-tune `WORK` only if real designs start hitting the deadline. (simplify, round 5)
- `refused`, `fixture` and the `perCall` mutant are copied in stationery-simplify-deadline and
  -budget tests (R3); move them to test/helpers-stationery.mjs. (simplify, R13 round 5 review)
- Compact SVG prompts: 1.8x faster, blind-rated worse (2.9 vs 3.9). Kept on branch
  `feat/stationery-compact-svg`, not shipped. Delete the branch or retry with a better prompt.
  (design speed)
- Old Design-with-AI conversations still hold a long Claude session; a normal chat message typed
  into one could hit the 1M-context error. New design turns run fresh. (1M-context fix)

## Notes · 笔记
- Note search does not index the Bible's older plain-text annotations (`notes[k]` strings, not
  notebooks); decide whether to migrate them into notebooks or add a string source. (note search p1)
- Note search highlight: typed-text marks need the CSS Custom Highlight API (iPadOS 17.2+); a
  fuzzy typed match and a Chinese query matched by bigrams apart are not marked; photos transcribed
  before phase 3 carry no picture index, so they show no rectangles until the page's pictures
  change. Reveal is not drawn while the pad is hidden (width 0). (note search p3)
- Note search: `PANote.reveal` is the third component glued into note-ui (plog, reveal); the glue
  block is the R4 seam named there. (note search p3)
- Drawer tag chips refresh with the list, not when the save hook reindexes a note: a tag typed a
  moment ago appears after the next open / ↺ / wake. A `note-indexed` push, or a re-ask after the
  2 s hook, would close it. The Transcript panel lists every page of the note rather than scrolling
  to the current one. (note features A+B)
- Summaries: the Bible's saved summary is not bound to its thread (the chat scope is the verse) and
  its rows show no ✨; month-map progress shows on the sheet, not in the rail; the confirm line names
  the lane at confirm time and cannot see a chooser change made in the rail afterwards; the drawer's
  summarize hook is the third glue line in buildDrawer (tags, pins, summary) — the R4 seam named
  there (buildDrawer → web/drawer-ui.inline.html). (note features E)
- Bookmarks: the ★ filter is not remembered across a reload (the sort is, via app-settings); the
  Bible's general-note row (`__gen`) cannot be bookmarked; superelf.md names the `notes-list` kind
  but not its row shape, so `pin` is documented only in the plan. (note features D)

- Journal font leak (annotation-anchoring.md §4 i+ii shipped): device check still pending on BOTH
  iPads — open the same note, open the page settings sheet on each, screenshot the "Device 设备"
  line and the ink/text alignment; a remaining difference is §4 items 2-4. (journal-font-leak)
- openAi pref (now `appPrefs[slug].openAi`, set in ⚙ Settings, 2026-11-12): the shell re-pushes it to
  the open app after a save, but a change saved on ANOTHER device reaches an already-open app only on
  its next iframe load (no server push). The Bible host never auto-opened a note's chat, so its row
  changes nothing there yet (kept: one rule for both PANote apps). printInk/noFlip: a pad change still
  reaches another OPEN app only on its next load. (ai-notes-on-open)

## Backup · 备份
- No alert when a nightly backup fails; check the Drive folder for a fresh date. (backup)
- rclone's shared Google client ID retires during 2026; set up our own client ID before uploads
  fail. (backup)
- Branch `feat/node-backup` (the first, overbuilt design, ADR 0013) is superseded by `backup.sh`;
  delete it. (backup)

## Model review · 模型评测
- The jobs tick is serial (web.mjs `tickRunning`): while a model review runs (minutes), reminders
  and other jobs wait. A Mac asleep at 03:00 catches up on wake and can delay that morning's
  reminders. Run long jobs off the tick. (model review)
- A job file that pins a lane id no longer in `chat_models` is not refused at load (`loadJobs`
  passes no lanes); its research call then sends `model: undefined`. (model review)
- An operator `claude_args` with `--mcp-config` gives the review's grader those MCP servers back:
  `--strict-mcp-config` keeps them. Build the grader's argv from an allow-list. (model review)
- Run now gives up in the UI after 5 minutes (web/settings.js); a review can run longer. The row
  then says "gave up" while the run goes on. (model review)
- An Ollama lane with no `model` loads, is not tested, yet counts as a group member: it ranks
  -Infinity, gets replaced, and reviewBrief's changeLines then throws on its missing stats AFTER
  config.json was written. Skip or refuse such lanes before deciding. (model review)
- test/model-review-flow.test.mjs depends on speed (newcomers 5 ms, lanes 40 ms, default
  max_slowdown 1.5): a 60+ ms stall can block nova as "too slow". Set max_slowdown 100 there. (model review)
- pairsOf runs the current lanes first and newcomers last, so an early Ollama blip or 429 burst
  fails only lanes. Interleave the pairs by test, or retry a failed lane call once. (model review)
- Only round 1 checks "no model answered": Ollama down for all of round 2 still records a "No
  change" review and marks the arrivals seen for every_days. Fail the run then (R14). (model review)
- A failed scheduled review is retried up to 3 times the same day, each a full review inside the
  serial tick. Skip the same-day retry for this job, or keep round-1 results. (model review)
- pickRound2 takes the 6 FASTEST clean newcomers on Fast-only quick tests, not the best: a slow,
  strong reasoning model never reaches round 2, so Deep may never be offered one. (model review)
- Any Ollama lane can be replaced, also a LOCAL (non-cloud) model chosen to keep chats on the Mac;
  a cloud newcomer then moves that traffic off the machine. Treat lanes whose
  catalogName(model) is null as never removable. (model review)
- lib/meals.mjs and lib/model-review.mjs each keep their own few-line in-flight guard; one shared
  helper would do for both (separate refactor, R8). (model review)
- visionText (lib/model-review-report.mjs:26) shows "—" for any Vision 0, so a seeing model that
  failed the picture task hides its 0.0. Keep "cannot see" apart from "saw and failed". (review email, R13)
- The "one to beat" role is set by model name across both groups (report:118,124): a model with a
  Fast and a Deep lane is marked in both charts, and the speed chart names no group. (review email, R13)
- When every group is blocked, the summary (report:57) still says "none clearly better than yours",
  though no newcomer was compared. Say "no group could change" then. (review email, R13)

## Jobs from a sentence · 一句话建任务
- The resolver can only pick `research` or `pollen` (lib/jobs/tools.mjs:21), so "remind me every
  Friday at 5pm to call grandma" fails. It should compose what exists (a reminder = a scheduled
  email from the agent inbox, or lib/reminders.mjs) instead of needing a new job type. (2026-10-17
  test; owner: the agent should combine its tools)
- The resolver runs through the full claude CLI (web.mjs:1885): on a failure the model told the
  user to use "/schedule", a Claude Code command. Run it with no skills/tools. (2026-10-17 test)
- The research job has no reply-language rule (lib/research.mjs:150): the scheduled run answered in
  Chinese, Run now in English. (2026-10-17 test)
- A job's briefing is headed "Research · 研究", not the job's own title (lib/jobs/tools.mjs:44).
  (2026-10-17 test)
- "alert me if pollen is high" ignores "high": the pollen tool has no threshold input the model can
  set (lib/tools/pollen.mjs:113, tools.mjs:25). (2026-10-17 test)
- Chat offers to make a job only for sentences with "every"/"daily", so "alert me if the pollen
  count is high today" is never offered. (2026-10-17 test)

## Leaving an app · 离开应用
- Reopening the same app during the hold (ADR 0018) can read before the held page's chained save
  lands; the new page's next save can then write over the last stroke. Make openApp wait for a hold
  of the same slug. (leave flush)
- `relayChats` is keyed by broker id alone: a chat-cancel from the next app can stop a held page's
  chat that used the same id. Key it by page too. (leave flush)
- The broker names a page by its iframe's `src` attribute; an app that navigates its own iframe to
  another app's URL keeps the first app's slug and data channel. (leave flush)
- Notes (`workspace/apps/notes`, the template and the shelf copy) says "Nothing can await during
  teardown"; on a leave it now can. The owner's copy is live data; fix all three together. (leave flush)
- No suite test runs Notes' real pagehide save through PALeave and the hold (ADR 0018 known gaps):
  run Notes + PANote in the sandbox harness with dispatchEvent and the real broker. (leave flush, R13)
- A held page can still open shell UI (print, confirm, mic, notification prompt) after the user
  left; serve a held page only the save kinds if an app ever does that on pagehide. (leave flush, R13)

## Backup of extra folders · 额外备份
- A listed extra folder that turns into a link, or a path step that is a file or unreadable
  (lstat ENOTDIR/EACCES), fails the whole night instead of skipping that folder
  (lib/backup-extra.sh ~50). (backup_extra review)
- The unencrypted per-folder tar copies stay in TMPDIR after a SIGKILL (backup.sh ~74). (review)
- The node's own excludes (./web.log, ./bible-data, ...) are not anchored: bsdtar matches them at
  any depth, so same-named paths in extra folders are dropped too. (review)
- A stale ./backup-extra left inside the node folder (an old "kept" restore) is packed beside the
  staged one and merges into the box on the next restore. (review)
- No test runs backup_extra with a remote (rclone) backup_dir, the live Drive setup. (review)
- A pause/resume program that hangs is cut off after 120 s; superelf's own folder is still one tar,
  so a file deleted mid-read there still fails the night (as before). (review)

## Agent lanes · 智能体通道
- test/agent-confinement.test.mjs "EVERY agent lane is resolved through agentArgs" fails on main
  since the model-review merge: web.mjs `modelReviewJobs` `ask` passes its `args` to `runAgent`
  raw. Route it through `agentArgs`, or list it in the census as a reviewed exception. While it is
  red it guards nothing: a new raw spawn site would pass unseen. Fix it before the next change that
  adds one. (app lane writes nothing, R13)
- An operator's `--settings` with `permissions.allow` (claude_args, fast_args, member_args) still
  reaches an app lane; `laneArgs` strips flags, not settings. Measure a blanket `Edit`/`Write` deny
  on the app lane on the real CLI, then add it. (app lane writes nothing, R13)
- Four member workspaces hold old private copies of Tasks (not in git) that ask the agent to
  write, which no lane allows now. Replace them with the current Tasks, or delete them.
  (app lane writes nothing)

## Note links · 笔记链接
- The open-url gate reads the app's NAME (`open_url_apps`, default notes and bible): an app written
  under one of those names opens links too, e.g. a family member's agent building "a notes app".
  Tie it to the app's origin instead (forked from the shelf Journal or Bible, with its hash). (R13)
- A family member on the shelf Journal or Bible is refused until they fork it, and the refusal
  "This app cannot open links" gives no next step. Say "fork it to open links", or let shelf
  copies of the listed apps through. (R13)
- The held-frame and wrong-uid refusals are pinned by a source match only; test/helpers-shell-broker.mjs
  lacks frameUid, LINK_APPS and UID, so open-url cannot run there. Add a shelf-`notes` case and a
  held-frame case. (R13)
- `open_url_apps` set to a non-array silently means the default; turning links off needs `[]`.
  Untested. If /api/apps fails at boot, Journal links say "cannot open links": the wrong reason. (R13)
- The URL prefill narrows the selection only inside one text node: across nodes (a rich paste, a
  bold part) the field fills but the brackets get linked too, and Cancel restores the narrowed
  selection, not the one dragged. LINK_LOOKS takes "node.js" or "file.txt" for an address (it only
  fills the field). (R13)
- A rich paste keeps links, and the comment that says otherwise is wrong; editing and removing a
  link bypass the execCommand undo stack. (R13, first round)
- Check on the real iPad: a finger tap on a link opens it, the Pencil never does.

## Apps built by the agent · 智能体建的应用
- PA.req (web/broker.inline.html) is on every page, and test/broker-helper.test.mjs guards the
  COMMITTED apps. An app the agent writes into a workspace is not scanned until it is committed:
  add the same two checks (own broker call, event read as reply) where the app lane's build ends,
  so a bad app is reported before the owner opens it. (web.mjs is over budget: it needs the
  app-page builder seam, lib/apppage.mjs, first.)
- Move the 21 apps in the census to PA.req and shrink the census to nothing; each copy is the defect.
- Build time (owner, 2026-10-28: "we also need to reduce the building time of the apps").
  MEASURED on the Matrix Conf build (Sonnet lane, Claude Code transcript 064cbfce, 232 s wall):
    research, 3 tool calls (websearch + 2 fetchpage)      22 s   10%
    planning (one thinking block, 3,299 tokens)            57 s   25%
    writing index.html (ONE Write, 9,954 output tokens)   126 s   54%
    checks + final answer                                  18 s    8%
  The file is 25.8 KB, of which 17.0 KB (66%) is the 72-talk schedule the model RETYPED from the
  page it had just fetched: ~85 s of the 126 s is data going through the model's mouth twice.
  The contract is NOT the cost: the 29k-token prompt is cache-read, first token at 2.6 s.
  Output tokens are the cost (21.5k out, ~80 tok/s). The site has a machine export
  (cfp.2026.matrix.org/.../schedule/export/schedule.json, 226 KB in 1.4 s; .ics too).
   CUTS, biggest first (1 and 2 SHIPPED 2026-11-02 into superelf.md "Building web apps",
   test/contract-build-cost.test.mjs; not yet re-measured on a real build):
  1. Data by tool, never by tokens: tell the agent (superelf.md "Building web apps") to look for
     a JSON/ICS/CSV export or write a parser, save the data to the app's data file with a tool,
     and have the page load it with PAStore/PA.req. Saves ~85 s of 232 (37%) on this build and
     scales with data size; the code alone is ~40 s to write.
  2. Updates edit, never rewrite: the second turn ("Update", 140 s) found nothing to change yet
     re-Wrote two whole files (40 s + 33 s) and spent 42 s loading a skill + resuming. Contract:
     change an app with Edit; a whole-file Write is for a new file only.
  3. Planning (57 s) and research (22 s) are the model's judgement and the site's speed; leave.
- Matrix Conf put its component markers in <head>, so PAChat ran before the every-page helpers; moved
  to the body by hand. Say in the contract where the markers go, and let the sweep check new apps.

- PANote select tool: selMove marks a moveDrag as `moved` on the first pointermove, with no jitter
  threshold. A finger tap that wobbles a pixel becomes a move (pushUndo + a 1 px shift) and the
  tap-selects-the-top-picture branch in selUp is skipped. Add a SEL_TAP_PX dead zone before `moved`.

- scan-detect: a dark slide whose text runs onto the wall (or the photo clips the slide) has no
  four-sided outer edge, so pass 2 returns null (inset fallback). Seen while writing the bezel-guard
  test, 2026-11-09. A three-sided quad completed from the photo border would frame it.

## Bible verse marks · 经文高亮
- Touch range selection: on iPad a long press on a word starts iOS's selection AND the explain
  long-press; decide which wins on device (a modifier, or explain only on the verse number).
  (verse marks)
- A verse renumbered by a BSB revision keeps its marks under the old number; detect by quote
  across neighbouring verses. (verse marks)
- A mark-only verse opened from the ☰ row opens an empty pad; a tap on the row could instead
  scroll to the verse and select it. (verse marks)
- A whole-verse mark has no quote, so its ☰ preview is empty; the listing could read the verse from
  the corpus (lib/bible.mjs) at a cost per listing. (verse marks)

## Important notes in summaries · 重点与链接 (note-important)
- Refs ([n] → note) live for the session: a summary thread reopened after a reload shows plain [n]
  in the rail (the saved note keeps its links). Persisting them with the conversation (a `refs`
  member beside `label`/`scope`) would close it.
- A circle is judged by its bounding box: a line whose centre falls inside the box of a loop drawn
  around the line above counts as circled. A point-in-polygon test on the stroke would be exact.
- A highlighter stroke over a word or two does not mark its OCR line (the unit is the line, the rule
  ≥ 50 % of the box). Word boxes from the tool would allow a per-word rule.
- The Bible's onLink is pinned in source, not run: the row open needs the chapter loader and the
  rail, which the app harness does not stand up.
- A deleted note keeps its links in summaries; the host shows its own "not found" outcome.

## Summary fixes · 总结修正 (summary-fixes, owner review 2026-11-11)
- A Selected summary's title carries its date span, not the `(3 notes)` count (the preset button has
  the count); titleOf(period) knows no count.
- The back pill hides only on its own tap or when a link opens the summary note itself; a drawer open
  after a link tap leaves it showing until tapped. A host call to PASummaryRefs.hideBack() on an
  ordinary open would close that.
- (summary-keep-runs) A link label cuts a run title at 40 chars, so the run time is usually cut off in labels
  (the drawer row and the note title keep it).
- (summary-keep-runs) A by-id update still writes the Journal entry through loadNote/writeNote while the pad may
  hold that note; the pad's reload flushes only a DIRTY notebook (as before for the follow-up's quiet save).
- A year's month ref reads `[2] 2026-10` (the group's title is the month id); the saved month note's
  human title would read better, but the ref is built before the rows' titles are consulted.
- (summary-polish) The Bible host's quiet follow-up save does not reload a summary note open in its draw
  view (the Journal's does); the block is on disk and shows on the next open.
- (summary-polish) chat-ui's attachment line says `saved to workspace/<path>` although the CLI's cwd IS the
  workspace; the lane's own list (attachmentPrompt) names the right path. Drop the prefix in its own change.
- (summary-polish) The Verify panel's Claude calls (startAssess → resolveSystemPrompts without {agent}) still
  carry the fast-lane guard; check whether the panel needs it before changing.
- (summary-polish) A link label without its day keeps its title words when a month summary's text is read
  into a year turn (stripRefs matches the `· YYYY-MM-DD` tail only).
- A summary thread's label is written when the thread is made ("This week · 本周 …") and never
  re-worded; a week later the list still says "This week" for that week (the date range is exact).

## Claude sign-in（Claude 登录）
- The watchdog's briefing rides the daily model-check job, so a sign-in that expires right after
  the 06:00 run is briefed the next morning; the chat reply says it at once. A probe on each
  failed chat turn, or a shorter job interval, would close the gap. (claude-auth-resilience)
- The real CLI's api_retry lines (`error_status:401`) are not parsed; the result line is enough
  today. (claude-auth-resilience)
- The fallback sends the Claude lane's history block to Codex even when the conversation already
  has a Codex session (a replay); the chooser's own Codex lane sends only the message.
  (claude-auth-resilience)

## Self-update and versioning · 自动更新与版本 (auto-update, ADR 0026)
- The shell's own main chat (the rail outside any iframe) is not asked before a self-reload; only
  the open app is (PABusy). A streaming main-chat turn could be cut by an update; the reply is
  saved server-side, so nothing is lost but the live view.
- The poll does not back off when /api/build fails (node down, offline): it asks again on the next
  visible/15-min tick, which is cheap but not silent in the console.
- N counts first-parent merges to main. A fast-forward or a squash merge is not a merge commit
  and does not move N; the merge script always merges `--no-ff`, so today this does not arise.
- `/api/build` and the footer compare whole strings: an edit to web/note-ui.inline.html alone
  (the `note <blob>` half) also triggers a reload. Intended today — PANote is the code most often
  fixed — but it means an uncommitted edit on the node reloads every client.


## Offline-first app (owner, 2026-11-11) · 离线优先
Case: away with no network at all; the iPad is alone. Today nothing loads (and the self-update's
no-cache HTML makes a cold reload fail). Scope to design BEFORE building (after the Bible anchored
ink session): service worker caching the shell + Journal + Bible app pages and the Bible text;
notes written to on-device storage (IndexedDB) and synced to the node when reachable; a visible
"Offline · 离线, saving on this iPad" state; conflict rule for a note edited on two devices while
apart (last-writer-wins per page + keep the loser as a copy, to be decided); search / summaries /
transcription wait for the node. Also: shell fallback to the Mac's local name for the
home-internet-down case. 3–4 sessions. Plan: docs/plans/offline-first.md (decided 2026-11-11).
Session 1 (SW + bundle + srcdoc route) is on branch offline-first. Leftovers from it:
- The iPadOS probe (does the worker serve the sandboxed iframe's navigation?) has run only in the
  harness, both routes; the real device decides which route it takes. Record it in the PR.
- The srcdoc route gives the app page its CSP by a meta tag (lib/offline.mjs withCspMeta); the
  `sandbox` comes from the iframe attribute. Not yet checked on a device that the Bible deep link
  (`location.hash` #b..c..) is unused on that route — the shell never sets a hash today.
- A worker-side bundle failure (offline with the same build) and a prefetch stop (cap, failure)
  sit in PASW.status() only; the state line that shows them is session 2's.
- The Bible corpus is refetched on every build (cache per build, ~7.9 MB): one background pass
  after each update. Copying unchanged chapters across builds would need a corpus version — later.
- The shell boots offline from localStorage (pa_uid, pa_apps); conversations, family apps and the
  profile still fail quietly offline (their loaders own their errors as before).
Session 2 (write queue + warm set + state line, web/offline-client.js PAOffline) leftovers:
- (Done, session 3: web/offline-sync.js drains in seq order, entries before the index, rule A via
  web/offline-merge.js, rows dropped on 200, a 4xx/5xx on the line with tap-to-retry, superseded
  paths dropped, PAUpdate's shellBusy reads PASync.inFlight(); `Syncing · 同步中` while it runs.)
- PANote shows no offline badge on its save pill: a queued save answers {ok:true,offline:true} and
  the pill goes green as for a normal save; the state line carries the word. A badge is a PANote
  change (web/note-ui.inline.html, over budget) — decide in session 4's polish.
- The browser's `online` event flips the line to online before any node answered; the drain's
  /api/build check (session 3) sets it back to offline when the node is still away.
Session 3 (sync + rule A, web/offline-sync.js PASync, web/offline-merge.js) leftovers:
- An app open while the drain merges a note it has in memory still holds the pre-merge notebook;
  its next save overwrites the merge (the node's .bak keeps it). The drain could post
  {pa:'reload-note'} to the open page, or PANote could re-read on focus — session 4 decides.
- A note deleted offline while the node kept its index row: the index merge keeps the row when
  the other side changed it; the entry file is a tombstone, so the Journal opens it blank. Minor.
- The shell registers the drain as busy through PAUpdate's shellBusy (the shell has no PABusy; that
  is the app-side answerer). The ↺/bar tap after a deferred update refuses under a drain since the
  review of 2026-11-11 (updateReload); the plain ↺ before any update is deferred still reloads.
- A note deleted from the list without ever being opened on this device has no base: the entry
  tombstone then loses to the node's file (unknown whether it moved), while the index merge drops
  the row when the node left it alone — an orphan entry-<id>.json on the node, invisible to the
  Journal. Fix candidates: the Journal reads the entry once before tombstoning (gives the base), or
  the drain treats a tombstone whose index row went as deliberate. Review 2026-11-11, finding 2.
- A save queued UNDER the POST and a cut-off cleanup together: the re-queued mirror row has no
  `prepared`, so the next drain merges v2 against the node's merged v1 as before (one conflict copy
  of v1's loser may repeat). Two faults at once; the .bak on the node keeps every version.
- The copy page's heading is a `<p><b>` line inside the loser's pageHtml (a page has no title
  field); PANote's sanitizer keeps both tags. Not checked on a device yet (session 4's hand proof).
- lib/appdata BACKUP_KEEP_RATIO re-checked by reading: maybeBackup only decides whether to demote
  the previous file to .bak; the merged write itself is never refused by it.
- A worker/bundle failure and a prefetch stop (PASW.status().error) are still not on the line.
- Index merge: a pin toggle (Journal onPin, workspace/apps/notes/index.html) does not bump the
  entry's `updated`, so a remote pin loses to any local metadata change on that row (and vice
  versa) in mergeIndex. Fix: onPin stamps e.updated=Date.now() (both workspace and
  workspace.example copies), or mergeIndex's onBoth ORs the `pin` flag onto the winner.
- The in-memory IndexedDB in test/offline-queue.test.mjs covers the request/transaction surface
  offDb drives; a real iPad (private mode: open() throws; storage pressure: QuotaExceededError on
  put) is the hand proof in session 4.
Session 4 (home-node fallback, web/offline-origin.js PAOrigin, lib/local-origin.mjs, ADR 0029):
- OWNER HAND TEST — the real-device proof (R6), not done by any session; record the result here:
  1. Node settings → set `Home-network origin · 家中网络地址` to the Mac's local https name with
     the port (the one the iPad already trusts); `Public base URL` must be the public name. No
     restart. Open the shell on the iPad from the home screen once, online (this remembers both).
  2. Airplane mode on. Open from the home screen: the shell and Journal open (cold, cached).
     Write one page in Journal; the pill goes green and the line says `Offline · 离线 — saving on
     this iPad · 1 to sync`. Open Bible, read Genesis 1 (prefetched). Search / summaries / AI say
     `Needs the home node · 需要家中节点`.
  3. Airplane mode off: within a minute (or on a tap of the line) the line shows `Syncing`, then
     clears; the page is on the Mac (data/notes/entry-<id>.json updated).
  4. Home internet down (unplug the router's WAN, keep Wi-Fi): write a page; `Offline` again; tap
     the line → `Home node · 家中节点` for a few seconds, the page lands on the Mac. A further
     save goes straight to the Mac. Plug the WAN back: nothing changes until the next queued save.
  5. Two-device conflict: edit the same page on the Mac and on the iPad while apart; on reconnect
     the note has both — the loser as `Conflict copy · 冲突副本 (…)` page.
  6. Private-mode Safari and a full iPad are the two failure cases: a save answers `This iPad is
     full · 本机存储已满 — not saved` / works without a queue; note what the pill shows.
- The base stays on the home name for the session once switched: the drain asks /api/build only
  when something is queued, so the public name is not re-checked with an empty queue (by design,
  plan §6 "for the session"); the next queued save after the home name goes away brings it back.
- Only `api()` follows the switch: the main chat's EventSource/upload paths and PAUpdate stay on the
  public name — chat is a node kind anyway (greyed), uploads too.
- CORS `vary: origin` is overridden by send()'s `vary: accept-encoding` on gzipped answers; both
  are no-store JSON, so no cache can mix them — cosmetic.
- The admin settings row is a plain value field; a local name the iPad's trust store does not hold
  fails silently in the fetch (reachable → 'local-away'); PAOrigin.status().last says so in the
  console, the line does not.

## CI portability · 跨平台 CI (branch ci-portability, from run 42978822886)
Fixed on the Mac with the same injection CI uses (NOTE_OCR_PLATFORM=linux, spawnSpec platform:'win32',
CI=true); only the next Actions run can confirm these on the runner itself:
- windows: `runTool` with a `cmd` that is a DIRECTORY must give `ocr_spawn_failed` (test/note-ocr.test.mjs
  "the child's env…"): spawnSpec now hands an extensionless absolute path back unresolved and
  note-ocr runs it without a shell; the spawn error's code on Windows (EACCES/ENOENT/UNKNOWN) is
  reported as it comes, but the branch `typeof err.code === 'string' && err.syscall` is assumed.
- windows: the fake compiler in "ensureBuilt: a binary proves availability…" is now a .mjs run
  through node; `fs.utimesSync` on the source and the per-process build cache are the same code,
  but the mtime resolution of the runner's NTFS temp dir was not measured.
- windows: model-review-route "a grading failure through the real route" now expects spawn ENOENT
  on an absolute claude_cmd that is not there (how:'absent'); Node's message on Windows is assumed
  to begin "spawn <path> ENOENT" — the test only pins /Could not start/.
- CI_TIMING_FACTOR 5 (1,000 ms) was chosen from the measured 240–780 ms; if the runner is slower
  still, raise the factor in test/helpers-platform.mjs, do not delete the pin.
- uploads/pages/ (ADR 0027): a summary's rendered page PNGs are named by ink hash and reused, but
  a page edited many times leaves its old renders behind; nothing cleans them up yet.
- Summary follow-up (ADR 0027): the second, quiet saveNote writes the block to the note file without
  reopening it; a summary note still OPEN in the pad shows the block only on its next open, and an
  unsaved edit of that open note flushed later would overwrite the block (pre-existing reload-flush
  order). A pad-side "pull page 0 if clean" would close both.

## Anchored ink on the Bible text · 经文上的手写 (branch bible-anchored-ink, phases 1–3 done 2026-11-11; pen sheet on bible-pen-tools)
- KNOWN LIMIT (plan §3 b, ADR 0028): ink does not re-wrap. A shape whose characters sit on two rows (an arrow from
  v3 to v7, a bracket down the margin, an underline that wraps) is anchored at ONE end and keeps its shape; the other
  end lands wherever the new wrap puts it — it SKEWS on rotation, rail drag and A-/A+. Confirm on the real iPad that
  this reads acceptably; the fix if not is per-row stroke splitting (one anchor per row), its own session.
- No ✎ toggle shipped: the Bible has no ✎ fab; the Pencil inks, a finger scrolls/selects. Add one only if the owner
  asks after the device check (PASettings extra or the fab bar; `enabled()` is already the gate).
- The device readout (`Device readout · 设备读数` in the ⚙ sheet) is to be screenshotted on both iPads (11" and 13",
  portrait and landscape, rail open/closed, A- and A+) — plan §5 for the Bible; pending like the Journal's.
- Erase is scrub-out only: Safari exposes no Pencil double-tap event to a page, so there is no double-tap
  eraser. The scrub thresholds (`SCRUB`, `ERASE_HIT`) are component constants with an `attach({scrub,
  eraseHit})` override, not yet a config tunable; confirm the thresholds on the real iPad (a dense shading
  scribble that crosses old ink would erase it).
- The ☰ list and `/api/notes` do not count `ANN.ink`: an ink-only verse has a dot in the chapter but no
  row in the list, and deleting a row leaves its ink. The dot is pinned; the row is not.
- `PAInkAnchor.attach` is one closure well over R4's 50 lines (state shared by capture, anchor, erase and
  reflow); split seam: the pen-capture handlers into a `capture(ctl)` helper, the bucket into its own block.
- Pen sheet (PAInkPen, 2026-11-11) leftovers: (1) the sheet closes only by tapping its button again (no outside-tap
  or Escape close); (2) the eraser removes on lift, not live while dragging; (3) the three size points and the
  highlighter fractions are component constants (`SIZES`), derived from the pad's scale, not config; (4) the button
  sits over the list's bottom-right corner and can cover the end of a line when the text is scrolled under it;
  (5) the drawer's prefs chain (web/chat-ui.inline.html `prefs.set`) sends `set-app-settings` WITHOUT `systemPrompt`,
  which the shell reads as "clear the override" — a drawer sort/group tap wipes this app's prompt override. PAInkPen
  re-sends the override; the drawer should too (its own fix session). The two chains are separate, so a drawer
  write and a pen write within one round trip can still lose the other's key; one shared app-prefs chain is the fix.
  (6) Untested on device: the button position against the fab and the split rail on both iPads.
- A stroke whose characters sit on two rows takes the Range's union rect; a shape spanning two lines
  follows ONE end (plan §3 b honest limit) — confirm on the real iPad that this reads acceptably.
- Untested on device: Pencil on an overlay above `#verses` vs Scribble (plan §6).

- (research-quality) The follow-up's writer runs two Claude CLI calls per research item (question, synthesis) under the
  shared MAX_CONCURRENT gate; with 5 research items a busy node may queue them behind chat turns. Measure on the
  node; if slow, let the question step ride the fast lane (`cfg.research.question_writer`) — not built.
- (research-quality) Bullets ask for ~25 words but are capped at 200 characters; the model sometimes writes 30.
  Tighten the guide only if the owner says the lines are long.
- (research-quality) The judge proof ran once on one synthetic case; a small fixture set (EN / 中文, practical vs
  spiritual to-dos) would make the quality claim broader.
- (open-tool) A stored notebook with no `id` gets a fresh one from sanitize() on every load, so a same-note
  refresh of such a legacy note counts as a new open and re-picks the tool by content. Fix by keying on the
  host's scope if it is ever reported.
- (open-tool) test/note-open-tool.test.mjs runs the rule and applyOpenTool lifted from the engine; no fake-DOM
  harness boots the whole Note() closure yet. A real-browser check (helpers-note-link.mjs, Playwright) of
  "open summary → click → no stroke" would close that gap.

## Chat turn order · 对话轮次顺序
- Status: plan items 1-4 shipped. 1-2: lib/convo-lock.mjs, web/index.html convoIdWait. 3-4: superelf.md
  "App build rules" (PAStore, `not-found` = first run, no `<form>`, mandatory self-check) sent by
  appContract with the PAStore API; lib/app-postcheck.mjs flags a `<form>` tag in apps a turn
  wrote (the `not_found` scan was removed: note-page-image answers that code). Re-run 4-app e2e (sonnet, throwaway node with workspace/CLAUDE.md): 4/4. Still open: item 5
  (repair existing generated apps on the live node), item 6 (stream-json into a running turn). (chat-turn-order)
- The contract now sits 35 chars under APPEND_SYSTEM_PROMPT_MAX in the worst case
  (test/agent-prompt-argv.test.mjs BUDGET). The next superelf.md growth in a sent section must trim or
  move text first, or raise the cap with a Windows argv re-measure. (chat-turn-order)
- The post-build scan is a regex over the markup with comments and script/style bodies removed (known
  limit: a form built at run time is missed). It warns only, never edits. (chat-turn-order)
- The self-check is prose the agent follows; nothing loads the app in a browser after a turn. A headless
  load + one save round-trip on the node would be the stronger backstop. (chat-turn-order)
- startAssess saves the conversation detached, after the turn's lock is released; a Verify result
  landing while the next turn runs can still be overwritten by that turn's save. (chat-turn-order)
- The lock is in-memory: a restart mid-turn forgets the queue (turns are lost with the process anyway).
  (chat-turn-order)
- The client hold shows no label while it waits for the first send's convo line (normally < 1 s); the
  server's queued status appears once the held send goes out. (chat-turn-order)

## E2E setup (real browser) · 端到端测试设置

The `*-e2e.test.mjs` files drive real Chromium via Playwright (not a dependency of this repo).
Without it they now FAIL (R14), not pass as `# pass 0 / # fail 0`. To run them:

1. Point at an installed Playwright: `PA_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs`.
2. Its browser build must be cached. If you see `Executable doesn't exist ... chromium_headless_shell-NNNN`,
   the cache holds a different build: run `npx playwright install chromium` from that Playwright's
   project (~150 MB), or set `PLAYWRIGHT_BROWSERS_PATH` to a cache holding build NNNN.
3. To skip on purpose (CI does): `PA_E2E_SKIP=1`. Skips stay capped by CI's `MAX_SKIPPED`.

- [ ] 2026-11-18: with a real browser, 6 e2e tests fail on main (hidden until now by the silent skip):
  note-link-e2e.test.mjs (5: Link apply/finger tap/phone strip/edit-remove/pasted URL — timeouts
  waiting for the popup "page" event and assertions) and note-photo-multi-e2e.test.mjs (1). Fix in their own session.

- **App sandbox: self-navigation (2026-11-21).** `sandbox allow-scripts` + `connect-src 'none'`
  blocks fetch/XHR/WebSocket, but an app iframe can still navigate itself (`location = 'https://…?d=…'`),
  which is a network request carrying data. Consider `navigate-to`-style limits (not widely supported),
  a shell-side `load` watcher that kills a frame leaving its origin, or `frame-src` on the shell. Found by
  gpt-review of the landing page; the page now claims only "blocked from fetch, XHR and WebSockets".

## Public demo · 公开演示 (final gpt-review of feat/public-demo, 2026-11-21)
- Two tabs opened before either has the cookie each create a visitor; a later reload can switch a
  tab to the other workspace. Serialize first boot across tabs (lock + recheck localStorage). (feat/public-demo)
- `save_max_mb` checks the gzipped wire size; a save can unpack up to the normal 16 MiB body limit.
  Bounded by `user_disk_mb` and the disk image, but enforce it on decoded bytes. (feat/public-demo)
- `GET /api/notes` parses every chapter file synchronously with no row or byte cap; bounded only by
  `user_disk_mb`. Paginate and cap. (feat/public-demo)
- No retention: abandoned visitor workspaces stay forever, so `total_disk_gb` eventually refuses new
  visitors. Define an inactivity expiry that removes the workspace, registry entry and sessions together. (feat/public-demo)
- A streaming turn (or a rename that loaded first) can re-save a chat deleted meanwhile. Put delete
  under the same per-visitor lock and re-read after the lock. (feat/public-demo)
- Nightly tar walks a live tree: an archive can hold a registry entry without its workspace or the
  reverse (start re-seeds a missing workspace). Snapshot or quiesce before archiving. (feat/public-demo)
- `streamOllama` drops a final JSON record with no trailing newline (reply reported as cut off). (feat/public-demo)
- docs/demo-node.md step 6 runs `ops/demo/rebuild-demo.sh` from the repo root while step 3 leaves the
  shell in `ops/demo`. (feat/public-demo)

## Demo app maker · 演示版建应用
- A demo visitor cannot delete an app (DELETE /api/apps/ is not on the demo allow-list); at
  apps_per_user they can only edit. Allow deleting demo-made apps once that route is reviewed. (feat/demo-create-app)
- The model's icon is kept in meta.json but the shelf shows no icon (faces need a face.json). (feat/demo-create-app)
- Edit is from the main chat only ("change my app X"); an app's own chat does not carry the marker rule. (feat/demo-create-app)
- /app/<uid>/<slug>/ is readable by anyone holding the URL (the existing public-namespace design);
  a demo-made page holds only what the visitor asked for, but it is not private. (feat/demo-create-app, gpt-review)
- API tokens (users[].token / web_token) are still full-access Bearer keys for every route; scope
  them to the ingest routes (/api/health/ingest, /api/meals/ingest) once each caller is listed. (fix/auth-hardening)
- Login lockout counters are in memory: a restart clears them, and 5 wrong tries lock the real
  owner out too (doubling wait, 1 h cap). Persist + allow an owner-side unlock if that bites. (fix/auth-hardening)
- ops/checks.ps1 Test-Firewall still WARNs about a missing inbound rule when bind_host is the
  default 127.0.0.1, where no rule is needed. Make it read bind_host. (fix/auth-hardening)
- WSL localhostForwarding with the 127.0.0.1 default bind is believed to work (docs/vm-node.md
  step 7) but was not verified on a Windows box in this change. (fix/auth-hardening)
- A process on the same machine can send its own X-Forwarded-For on loopback and so pick its
  login-guard bucket (and churn the 10k-key map). Only matters on a VM shared with untrusted local
  users; fix = read the client from tailscale serve's Tailscale-User-Login header. (fix/auth-hardening, gpt-review)
- setup.mjs (CLI) and a browser setup running at the same moment can both succeed; the CLI writes
  its earlier snapshot. Needs a lock file shared by both. (fix/auth-hardening, gpt-review)
- MIN_PASSWORD counts UTF-16 code units, so 4 emoji pass "8 characters". (fix/auth-hardening, gpt-review)
- Demo Ask AI: a `PAChat.mount(` inside a JS string literal or a non-executable script still counts
  as the page's own mount, so the server adds no fallback button. Parse scripts properly if a model
  does it. (feat/demo-models-ai-search, gpt-review)
- Demo apps saved before marker de-duplication (2026-11-21) are not rewritten: a page that repeats a
  PA_* marker still expands on serve. Bound sendAppHtml's expansion for every page. (feat/demo-models-ai-search, gpt-review)
- The demo model bench scores apps by static facts (compiles, controls, saves, feature regex); no
  headless browser runs in the demo image, so a runtime error after load is not seen. (feat/demo-models-ai-search)
- The Ollama account caps concurrent requests (bench 2026-11-21: HTTP 429 with 3 runs in flight).
  config.demo.json now sets parallel_chats 3 (busy visitors get the bilingual "busy" reply instead
  of a 429); measure the real cap and tune it, or queue. (feat/demo-models-ai-search, gpt-review)
- A searched answer that is itself a marker line streams the raw marker before the saved text drops
  it (model-steered, cosmetic). Hold markers in the follow-up stream too. (feat/demo-models-ai-search, gpt-review)

## Demo sign-in · 演示登录
- Owner: put the scripturetolife.org Supabase anon key (public) in demo.auth.supabase_anon_key on the
  live node; it lives only in bible_app's CI secrets, so the repo config ships it empty. (feat/demo-signin)
- Owner: add https://try.superelf.app to Supabase Auth Redirect URLs. (feat/demo-signin)
- Token bindings are in memory: after a node restart a signed-in tab gets "sign in again" on its
  first AI turn until it reloads (the boot re-sends the token). (feat/demo-signin)
- /app/<uid>/<slug>/ serves a visitor's app HTML to anyone with the URL (pre-existing design: the
  id is a public namespace, data only via the authed broker). For signed-in members the id is a hash
  of the sub and not enumerable; gating app pages per member would need an authed iframe load. (feat/demo-signin, gpt-review r1)
- Shell logout in a stale tab revokes whichever Supabase account is in shared storage (another tab
  may have switched accounts): over-sign-out, fails safe; rejected as not a bypass. (feat/demo-signin, gpt-review r5)
- The sign-in boot/control script is checked for syntax and by server-side flows only; no fake-DOM
  run of the PKCE exchange and refresh yet. (feat/demo-signin)

## Starter apps: GPT-review leftovers (2026-11-21, fix/demo-account-ui)
- productivity-hub: debounced saves have no PALeave flush (leaving at once can drop the last edit);
  clearing a note's body schedules no save; Export JSON needs `allow-downloads` in the app sandbox/CSP.
- allergy: no stale-response guard (a late startup read or older check can overwrite a newer city).
- bible-values: a reflection still in flight is written into whichever value sheet is open now.
- Demo sign-out: after the 4 s deadline the shell reloads even if /api/logout never reached the node,
  so the anonymous cookie can survive on a hung node. Option: on timeout, show "Sign-out not confirmed"
  and retry instead of reloading (GPT review round 3).
- productivity-hub: an idle tab's midnight stats reset can save a stale snapshot over another tab's edits.

## Demo background app builds (lib/demo-build-job.mjs) — GPT review leftovers, 2026-11-21
- A restart after the app is written but before the job record says 'done' reports the build as failed (the app is there).
- If the first job-record write fails, the build cap already charged is not refunded (same as any other mid-turn failure today).
- The chat's Open link uses the request Host header (syntax-checked only); the public node sits behind Cloudflare on one name.
- (round 3) Restart recovery during a held turn: record says failed before its deferred note exists; the shell may refresh too early.
- (round 3) If the terminal record write fails after the success note, a later read adds a contradictory "interrupted" note.
- (round 3) The shell's completion refresh can reopen the chat during a new streaming turn (reply visible again on reopen).
- (round 3) The relative Open-link fallback (odd Host, e.g. IPv6 literal) renders as plain text.

## Private VM node (ops/private) — from GPT review 2026-11-21
- The DOCKER-USER ingress rule is re-added by rebuild-private.sh but not persisted across a reboot
  (until the next rebuild it is absent; 100.x is not routable to the VM's public NIC, so low risk).
- backup.sh archives a live tree (same as the demo): quiesce or snapshot before tar.
- The nightly root backup job reads the checkout's compose file; move a root-owned copy to /etc if
  the checkout ever becomes writable by anyone but the sudo-capable owner.

## Demo sign-in prompt leftovers (GPT review r3, 2026-11-22, capped)
- lib/demo-boot.mjs: a failed sign-in callback leaves an error-only popover open; the pa-demo-signin
  listener's `if(!pop)` guard then does not show the email form until the popover is dismissed.
- lib/demo-boot.mjs: the listener exists only for a page loaded signed out. A signed-in tab whose
  binding is lost or token fails verification shows the server's "sign in again" sentence but no form
  (the minute sync then clears the session and the header Sign in returns).
- test/demo-account-ui-e2e.test.mjs: the peek-bar step cannot tell the transitionend handler apart
  (the shell header behind an app is as tall as the bar); an invariant pin only.

## Flaky test · 不稳定测试
- test/demo-account-ui-e2e.test.mjs "the demo drawer keeps Family Apps…" fails ~1 in 4 runs on main
  too (seen 2026-11-22): the parse-time `#dFamilyDemo` count reads 0, likely the boot reload racing
  the `domcontentloaded` check. Not caused by the drawer home link; fix the race separately.

## Privacy scan (tools/privacy-scan.mjs) — GPT review r3 leftovers, 2026-11-22 (capped)
- Annotated tags are not inspected (tagger, tag message); `rev-list` peels them. Push tags only after a manual look.
- A new ref excludes commits on the destination's remote-tracking refs; stale refs could hide commits. Fetch before pushing.
- bible-data/ is exempt wholesale; exempt only known Scripture blobs instead.
- Sign-in: a 401 without a JSON error shows relayHttpFail's "signed out" text, so the client's own
  "Wrong username or password" fallback is unreachable (the server always sends the reason). (GPT review 2026-11-22)
- Waiting list (lib/demo-waitlist-ui.mjs): the form lives in the demo shell, so a first-time visitor
  from a network over `new_users_per_ip_per_day` (or when `total_disk_gb` is reached) gets the quota page instead of the form, though
  `POST /api/waitlist` needs no session. Fix: a tiny standalone `/join` page. (GPT review 2026-11-22)
- Ink cross-line words (PAInkFrame.clusterOf/shiftClusters): notes written before the bid/rel/ww tag have
  none, so a word split over two lines in them still comes apart in portrait; they are never moved, so the
  original writing stays exactly as written. A word written slowly (more than BURST_MS between strokes)
  across two lines is not tagged either. (2026-11-22)

## Overnight test findings still open (2026-11-23 triage; fixed ones omitted)
- F1-3/F1-6/F5-12/F4-7/F2-05/F3-09: bilingual sweep, 中文 first everywhere; one word for password vs PIN; no raw "role: owner".
- F1-8: demo guest tip offers app-making but AI asks to sign in; typed question not shown; sign-in/waitlist popovers lack title and close.
- F1-9: demo tiles English-only; "live from tasks.md" file-name jargon.
- F5-4: login lockout keyed per IP, so one member's wrong passwords lock the whole family (one home IP) out.
- F2-03: Bible reader has no next/previous chapter (no end-of-chapter button, swipe or ArrowRight).
- F2-06: Bible top bar auto-hides even with a mouse; on phone a selected verse hides Ask AI.
- F2-07: Bible first-use bar tip covers verse 1 / phone toolbar until closed.
- F2-09: changing book logs an unread chapter 1 in reading history.
- F2-11: /app/owner/bible/ opened directly shows bare "not found", not a sign-in prompt.
- F2-12: highlighting a verse adds a "· Note" row in Notes & Chats with no note.
- F2-13: real AI answer quality on try.superelf.app not yet judged (visitor cap blocked testing).
- F3-01: first tap on a Journal header button is lost while the notes drawer is docked.
- F3-02: Print unreachable on iPad portrait (820) with the drawer docked.
- F3-03: AI summary contradicts itself on follow-ups.
- F3-04: summary ref links [1] work only with Cmd-click; no way on iPad/phone.
- F3-05: Ask AI model chip ("DeepSeek · 中文") disagrees with the reply footer ("Claude").
- F3-06: first-use tips cover note text and drawer group headers.
- F3-07: Escape closes neither the row ⋯ sheet nor Page settings.
- F3-08: Page settings shows a developer readout and runs off the right edge.
- F3-10: plural grammar ("1 pages", "1 to-dos"); summarize shows "已选 (0)" while sending 1 page.
- F3-11: drawer row preview joins lines with no space ("#familyRemember").
- F3-12: deleted note text stays in entry-<id>.json.bak on disk.
- F3-13: "Note 笔记" / "Saved · 已存" chips wrap; phone summary row time clipped.
- F3-14: a summary quoting a #tag picks up that tag in the drawer strip.
- F3-15: first shell load prefetches all 1189 Bible chapters; heavy on a phone.
- F4-2: test node "no AI" still runs host CLI lanes; a new member defaults to Claude; replies leak host jargon.
- F4-3: main chat has no stop/cancel while a turn runs.
- F4-4: member home requests notes/bible shelf apps -> 404; 401 /pa-sw-probe on every load.
- F4-6: drawer lists an app twice (Family Shelf and Family Apps); owner's own apps show "by Owner (you)".
- F4-8: phone header truncates "Mara's 管家"; replies show "workspace-mara".
- F5-7: offline Family Apps says "None shared yet." and the title loses the owner's name.
- F5-8: remove member fixed only in part; recheck the full flow.
- F5-9: internal id "owner" shown instead of the chosen username; promote list shows slugs.
- F5-10: activity log is a native alert() with jargon and UTC times.
- F5-14: owner's starter apps (incl. Diabetes) shown to members by default; confirm intended.
- F2-08/F3-INK (ink workflows): Pencil tip shown on phone/over chat; a stray mouse dot became ink.
- test/family-settings-e2e.test.mjs sets up accounts unlike real sign-up; rewrite. Settings not run on webkit/iPad Safari.

## From the integration GPT review (2026-11-23), not fixed in that round
- Notes delete: the live file is replaced before `.bak` is removed (lib/appdata.mjs); a crash between leaves old text, and restore could bring a tombstoned note back. Make the cleanup recoverable.
- Stop (F4-3): Research and GPT (Codex) turns and the job resolver get no cancel signal; the demo allowlist (lib/demo.mjs) rejects `/api/chat/stop`, so demo Stop shows an error. Bind Stop to the running turn's own convo and pass cancel through every provider, or hide Stop where it cannot work.
- Demo guest ask (F1-8): the question is not kept across the sign-in link (new tab / reload). Save it as a draft and restore it after sign-in; extend demo-guest-ask-e2e through the callback.
- Family Apps (F4-6): a shelf app hides every member app with the same slug, even from another author. Match by source account + slug; add a same-slug, different-author control.
- Direct links (F2-11): `/app/shared/...` (the shelf) opened in a tab still serves a bare page; add the shelf case to the redirect, with a browser test.
- Test honesty: bible-reader-e2e direct-link test injects a token (skips the real sign-in handoff); chat-stop asserts the stream ended, not that the process died; setup-modal Escape test uses a synthetic event.

- deploy-vm.sh untars each deploy over the VM source folder, so files deleted in a newer commit stay in the Docker build context and ship in the image (GPT review of fix/vm-revision, 2026-11-23). Fix: extract into a fresh folder per deploy and swap, keeping runtime config outside it.

- Publish (v5.5.x hardening, 2026-11-24) remaining gaps: (1) publish status lives in memory, so a restart mid-CI leaves the owner's sheet with no status (PR stays open on GitHub, the safe state); persist it under data/. (2) The PII heuristic is regex-only (known limits: no names unless in the owner's term files, no non-US/CN phone shapes). (3) The fork refusal trusts meta.forkedFrom, an editable app file; an owner who deletes that field by hand can publish a copy. Store fork provenance outside the app folder (GPT review 2026-11-24). (4) collect/refuseFork lstat then reopen by path: a swap to a FIFO in that window could block the event loop; open with O_NOFOLLOW|O_NONBLOCK and fstat the same fd (GPT review, rare race, capped). (5) Owner-only setup still manual: the fine-grained GitHub token and branch protection on the public repo.

- App prefs: the ⚙ dialog's Save (set-app-settings, the whole prefs object) does not go through the PAAppPrefs chain. It now waits for a patch already in flight (whenIdle, 2026-11-24), but a patch STARTED while the Save is on the wire can still read the old prefs and write them back after it. Fix: route the dialog's save through PAAppPrefs. Also: when an extra section's write fails after the prefs saved (the Bible's explain prompt), onSave is not called, so the Bible keeps the old verse order until the next open (GPT review of feat/bible-zh-first).

- 改这个应用 panel: "历史 · History" list with Undo-to-this-version (needs a restore-any-version route + undo of the skipped versions; ADR 0040 addendum 2026-11-24).
- app-history leftovers (GPT review 2026-11-24): (1) `appNotesJson` runs a sync `git` with no timeout on a release-notes cache miss, now also on the app-chat path (web.mjs appTurnFacts) — give lib/vernotes.mjs a timeout; (2) a same-size replacement of a binary or >300 KB file is not reported as changed (sizes only) — compare a hash within the read budget.
- app-history (GPT review round 3, deferred): (3) the runner's 20k cut can drop the end of the facts block (and its closing marker) when a max-length override fills the prompt — budget turnFacts against APPEND_SYSTEM_PROMPT_MAX in web.mjs; (4) listHistory/treeFiles walk and stat every file of all 20 saved versions synchronously — cap the file count or cache per version name.
