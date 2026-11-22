# superelf（管家）— Project Plan

**This is the ONE planning document.** Vision, every feature and its state, the roadmap, the
backlog, future ideas, and the session log. The former `docs/*_PLAN.md` files were folded in
here (2026-09-09) and deleted — git history holds them.

Still separate, and linked from Part II because they are deep-dives rather than plans:
`docs/JOB_ENGINE_PLAN.md` (the active build, 440 lines) and `docs/design/*` (how a shipped
thing works). Inlining those would make this register unreadable, which would defeat having
one place to look. Say the word if you want them here too.

**Keep Part II updated when a feature lands.** A register that lags is worse than none.

> Living document. Update it whenever a decision lands, a phase ships, or the roadmap
> changes. Sessions append to the Session Log (Part VI).
>
> **Rules:** every session follows the global engineering rules (R1–R14) in
> `~/.claude/CLAUDE.md` — loaded automatically; they are not duplicated here (R3).
> Existing plan docs: `docs/JOB_ENGINE_PLAN.md` (job engine detail — Phase A builds on
> it, does not fork it). No other PLAN/ROADMAP file existed before this one.

---

## Part I — Vision & first principles

### Mission: health span（健康与长寿）

The whole project is about **health and longevity** — extending the family's health
span: physical, mental, and spiritual well-being. Every app serves it: the Bible app
is spiritual health; the health / diabetes / longevity apps are physical; the journal
is mental; deep research and multi-LLM assessment exist to make health answers
*accurate*. The agent shift, minimalism, and less-screen-time principles below all
serve this mission — screen time is itself a health cost, and every roadmap phase in
Part III is judged by whether it buys back time and attention for living well.

superelf（管家）is a **self-hosted personal / family AI agent**. Its value is:

1. **Ownership + privacy（数据自主 + 隐私）** — the family's data lives on our own
   hardware, under our own roof. No cloud account owns it.
2. **Integration（整合）** — one agent that sees across the apps (journal, tasks,
   health, mail, calendar) instead of ten silos.
3. **Above all: it ACTS on the user's behalf.** The agent's job is to do things,
   not to be another screen the user has to look at.

### Guiding principles

- **P1 — Minimalism（极简）.** Few controls, few words, to the point, effective.
  One context-aware control beats parallel buttons.
- **P2 — LESS SCREEN TIME is the success metric（减少屏幕时间）.** Fewer disruptions,
  fewer messages *from* superelf, and more time freed for healthy actions: exercise,
  walking, nature, helping people — NOT sitting in front of a screen. Every feature
  is judged by whether it reduces net screen time.
- **P3 — Autonomous action, with approval（自主行动 + 审批）.** The agent acts on the
  user's behalf. Side-effecting actions are approval-gated; routine, well-understood
  work gets **pre-approval（预批准）** so it runs without interrupting anyone.
- **P4 — Shared generic UI components.** One implementation, used everywhere:
  PAChat is *the* chat, PANote is *the* writing surface, the drawer is *the* drawer.
  No app-local copies.
- **P5 — App modularity + per-app data isolation.** Apps are sandboxed and
  self-contained; the broker auto-namespaces each app's data to `data/<slug>/`.

---

## Part II — Feature register（功能总表）

**This is the one place to look.** Every feature superelf has or plans, with its state.
`DONE` ships and is tested · `PARTIAL` works but is incomplete (what is missing is named)
· `PLANNED` agreed, not built · `IDEA` not decided.

Deep-dives live in `docs/` and are linked where they exist; everything else is here.
Keep this updated when a feature lands — a register that lags is worse than none.

### Shell & interface

| feature | state | notes |
|---|---|---|
| Chat with model picker + Verify toggle | DONE | v2.30.0 |
| Reply timing kept with the reply ("took 3.2s") | DONE | v2.31.0, stored server-side, survives reload |
| App shelf, MRU order, blue dot for new apps | DONE | v2.18.0 |
| App shelf scrolls | DONE | v2.29.1 — was clipped, apps past the fold unreachable |
| Home goes home (drawer + app bar) | DONE | v2.29.2, one `goHome()` |
| Global font size A-/A+, long-press to reset | DONE | per-device by design; profile-wide was considered and **rejected** |
| Sign-in fits a phone | DONE | v2.29.1 — was pinned top-left, 13px, unscrollable |
| Response compression + ETag | DONE | v2.32.0 — first visit ~3× smaller, return visit 300 bytes |
| Notes/Chats drawer, search, time grouping | DONE | in PAChat |
| Drawer never replaces a note with a blank chat | DONE | v2.28.1, invariant pinned (reported 3×) |
| Scheduled notifications + alarm sounds | DONE | `notify-at`, survives leaving the app |
| **Home screen = the chat interface** | PLANNED | needs one decision — see Part V |
| **Notification centre in the shell** | PLANNED | briefings currently readable only inside the longevity app |
| **App faces (live info on the shelf)** | PLANNED | P0 in Part V |

### Notes & handwriting

| feature | state | notes |
|---|---|---|
| PANote: ink, pages, palm rejection, templates | DONE | shared component |
| Note page scrolls when taller than the viewport | DONE | |
| Handwritten notes name themselves by creation time | DONE | v2.29.0, one format in PANote |
| Text + ink in one note | DONE | |
| iPhone text mode reflow (item B) | PLANNED | page-scaled today, unreadable on a phone |

### Jobs & automation — see `docs/JOB_ENGINE_PLAN.md`

| feature | state | notes |
|---|---|---|
| Scheduler, once-per-day + same-day catch-up | DONE | `lib/schedule.mjs` |
| Briefings store, approval queue (propose→approve→execute) | DONE | idempotent, limbo sweep |
| Jobs are FILES, hot-reloaded, no restart | DONE | v2.34.0 |
| Tool catalogue with manifests | DONE | v2.35.0 — pollen + research runnable |
| Create/edit/delete jobs in Settings | DONE | v2.35.0, new jobs created PAUSED |
| `deliver: fold-daily` → rides in 每日一报 | REMOVED 2026-10-11 | jobs send their own message; legacy `fold-daily` files load as `own-message` (ADR 0004) |
| Resolver: a sentence → a job | DONE | v2.37.0, deterministic schedule parsing |
| Run now shows its result | DONE | v2.37.1 |
| "it ran" vs "it said something" vs "it arrived" | DONE | v2.38.0 |
| Chat → job (card with Create) | DONE | v2.39.0 |
| **Chat → skill/tool** (author a NEW tool by chat) | PLANNED | the missing third layer — apps ✅ and jobs ✅ are already chat-created |
| Pre-check gates (`wakeAgent:false`) | PLANNED | from Hermes; most jobs need no model |
| Richer schedules (intervals, one-shots, Mon–Fri) | PLANNED | `dueJobs` is daily/weekly HH:MM only |
| Jobs that ACT, not just report | PLANNED | machinery exists, no writing tool yet |
| Job-creation disabled inside a job run | PLANNED | runaway-loop guard, before broker kinds ship |

### Tools（工具）

| tool | state | notes |
|---|---|---|
| `research` — live web + citations | DONE | Tavily + Firecrawl |
| `pollen` — Pollen.com, keyless | DONE | v2.33.0, first deterministic tool |
| `calendar` · `health` · `meals` | PARTIAL | catalogued with manifests, **no runner yet** (`mail` REMOVED 2026-10-11, ADR 0004) |
| `weather` — Open-Meteo, keyless | PLANNED | pairs with pollen |

### Briefings & delivery

| feature | state | notes |
|---|---|---|
| 每日一报 daily brief | REMOVED 2026-10-11 | owner decision, ADR 0004; with its daily health line, calendar feed setting and bot `/brief` |
| Brief *reads* the day (synthesis) | REMOVED 2026-10-11 | went with the daily brief |
| 健康简报 weekly health brief | DONE | Sunday 20:00 |
| Email delivery, never fails the job | DONE | AgentMail to a profile's briefing email; the only push channel |
| Telegram delivery | REMOVED 2026-10-12 | went with the Telegram bot, ADR 0006 |
| Mail bodies → model (phase 2) | REMOVED 2026-10-11 | all mail reading removed (IMAP, ranking, bodies), ADR 0004 |
| Google Drive (phase 3) | IDEA | |

### Apps

| feature | state | notes |
|---|---|---|
| App creation by chat | DONE | agent writes to `workspace/apps/<slug>/` |
| Sandboxed apps + broker (~34 kinds) | DONE | `allow-scripts`, no `allow-same-origin` |
| Per-app data isolation (`data/<slug>/`) | DONE | |
| Shared components: PAChat, PANote, PANewDot | DONE | inlined at markers |
| Family shelf: share / fork / rollback | DONE | `lib/sharedapps.mjs` |
| Per-app system prompt with reset | PARTIAL | exists in Settings › Advanced, **lists only apps with a declared default** |
| (ask) AI in every app | PARTIAL | **8 of 19 apps have none** |
| `superelf.md` as an enforced app contract | PLANNED | P0 in Part V |
| Health & longevity from the Apple Watch | PARTIAL | ingests steps/sleep/weight only; **nothing ever ingested** |
| Bible: tap a verse → explain it | PLANNED | Part V |

### Platform

| feature | state | notes |
|---|---|---|
| Multi-user, roles, PIN auth, `resetpin` | DONE | |
| HTTPS over Tailscale | DONE | |
| Multi-LLM assessment (Verify) | DONE | `docs/design/multi-llm-assessment.md` |
| Node settings in Settings UI | DONE | whitelisted config surface |
| Telegram bot (chat, `/project`, `/deep`, `/bg`, schedules, Approve/Deny buttons) | REMOVED 2026-10-12 | owner decision, ADR 0006; approvals are decided in the longevity app; retiring `projects` / `default_project` is a follow-up |
| Zero dependencies | DONE | deliberate — no lockfile, hand-rolled ICS |
| Test suite | DONE | 1022 tests |


## Part III — v2.0 milestone: current state, and a FEATURE FREEZE

What has shipped (v1.0 → v2.0, from git history):

- **Platform:** sandboxed LLM-generated mini-app platform + postMessage broker;
  per-app data isolation under `data/<slug>/`, enforced by the broker; app sharing
  (owner-curated Family shelf + peer sharing); two channels (web app + Telegram bot)
  driving Claude Code headless per-user. (The Telegram bot was removed 2026-10-12, ADR 0006;
  the web app is the one channel.)
- **PAChat (shared chat):** full-screen chat used by every app; slide-in drawer,
  docked/push layout on wide screens; loading indicator + stale-load race guard;
  markdown/tables, images, file upload, voice input.
- **PANote (shared handwriting engine, 手写):** Notability-class toolset; full-page
  text mode; paper templates (Plain/Ruled/Grid); text highlighter; docked, movable,
  collapsible toolbars; whole-page finger flip in both draw and text modes; durable
  save (stroke flush awaited on switch).
- **Journal（日记）:** unified onto PANote — drawer + one PANote surface per entry,
  legacy text migrated; Timeline/Weekly views.
- **Bible app（圣经）:** real public-domain scripture (WEB + 和合本 CUV), verse search
  in both languages, clickable verse refs, multi-page notes.
- **Model routing:** Fast / Deep / Agent lanes across providers; vision routing;
  GPT-via-Codex lane; per-lane defaults tuned.
- **Editable AI system prompts:** config + per-profile override + Advanced UI.
- **Accounts:** per-user profiles / family accounts, roles, audit log,
  age-appropriate personas.
- **Autonomy scaffold:** `lib/autonomy.mjs` (read-only briefings vs. approval-gated
  pending actions, enforced by propose/execute separation) and `lib/schedule.mjs`
  (once-daily schedules). Scaffolded, not yet the engine.

### 🚫 FEATURE FREEZE at v2.0

The app/UI feature set is **frozen**. Any new UI feature needs explicit written
justification against the anti-goals (Part IV) before work starts. Development now
shifts entirely to making the **AGENT** useful — Part III.

---

## Part IV — Roadmap: the agent shift

The operating cycle every capability must complete:
**DATA（数据）→ INTELLIGENCE（智能）→ ACTION（行动，autonomous with (pre)approval）.**
A feature that gathers data but never acts, or acts without honest analysis, is
incomplete. Each phase serves the health-span mission; the end state is an assistant
that needs little hand-holding — the user reads one briefing, answers approvals, and
occasionally edits this file to set direction.

### Phase A — Action/Task Engine（行动引擎）— the core

> **task = intent + trigger (schedule / event) + action + approval policy**
> (ask-each-time ／ pre-approved routine 预批准)

- ✅ Scheduler v1 shipped (v2.3.0): 60s tick, daily/weekly triggers, once-per-day
  marks written after success, bounded retries, manual runs share the marks.
- ✅ Delivery channels shipped (v2.4.0): briefings in-app（简报 section）+ Telegram. Since
  2026-10-12 (ADR 0006): in-app + email; Telegram was removed with the bot.
- ✅ **The approval loop（审批闭环）shipped:** the weekly 健康简报 attaches
  deterministic *proposed actions* (flags → proposals, R14; lib/health-analyze.mjs
  healthProposals); decided in the longevity app's 待批准 section (broker kinds
  actions/action-decide). The Telegram Approve/Deny buttons were removed with the
  bot (2026-10-12, ADR 0006); there is no shell-wide approvals list yet. Typed executor registry +
  `cfg.preapproved_action_types`（预批准, outward types refused at config load）
  in lib/actions.mjs; approved create-reminder registers a persistent per-user
  reminder on the job-engine core (lib/reminders.mjs). Honesty: 7-day proposal
  expiry, 14-day denial cooldown, executor failures reported in the briefing.
- Detailed engine design: **`docs/JOB_ENGINE_PLAN.md`** — extend there.

**Standing sample tasks:** (1) periodic LLM A/B testing that *proposes* routing
changes — ✅ shipped 2026-10-17 as the weekly `model-review` job（模型评测, ADR 0017）: blind
Claude-graded tests on our uses, it keeps the best 3 Fast and 3 Deep lanes, the first review only
reports, one-step Undo; (2) the daily briefing（每日简报）; (3) routine automation under 预批准.

### Phase B — Integrations that feed the agent（整合）

- ✅ **iOS Health — SHIPPED** (v2.3.0–v2.4.0): Shortcuts → ingest → deterministic
  analysis → weekly 健康简报 with reasoned diet/exercise/sleep suggestions, in-app +
  email (Telegram until 2026-10-12, ADR 0006). Remaining: suggestions become *proposed actions* once Phase A's approval
  loop lands (e.g. "add a 20-min walk reminder" → approve → scheduled).
- **REMOVED 2026-10-11 (ADR 0004): the daily brief and all mail reading.** The item below
  is kept as history; nothing reads mail now, and jobs send their own messages.
- **Mail + calendar digest（邮件/日历简报）— zero-OAuth path:**
  calendar via the Google Calendar **private ICS feed URL** (read-only, no OAuth —
  the user pastes the URL into config once); mail via a Gmail **auto-forward filter**
  to superelf's **AgentMail inbox** (the user creates the filter once). A daily job
  digests both into the morning briefing and delivers via email (AgentMail) +
  Telegram. Actions (reply drafts, reschedules) come later, approval-gated.
- **Email channel（邮件通道）:** AgentMail (free tier: 3 inboxes / 3k emails-month)
  as the third delivery channel (send-only since 2026-10-11 — nothing reads its inbox), and
  the only push channel since the Telegram bot was removed (2026-10-12, ADR 0006).
- **Web-grounded research:** Claude agent lane searches + cites (already paid);
  free-tier lanes Tavily (search) + Firecrawl (page→markdown) + Exa (semantic) as
  keys are provided. Perplexity API deferred (paid credit only; Sonar deprecated
  2026-09-27); the Pro subscription's sanctioned automation is **Perplexity Tasks**
  (user-configured, email delivery).

### Phase C — Multi-LLM assessment（多模型交叉验证）— ✅ SHIPPED (v2.2.0)

Per-app Verify · 校验 toggle; R14 honest-failure core. Remaining niceties tracked in
the backlog only.

### Phase D — Federation of superelf nodes（联邦）— FUTURE, not scheduled

### Phase E — Self-evolution（自我进化）— the assistant improves itself

Goal: the user stops specifying features and stops being the debugging partner.
Mechanism — the **nightly self-dev loop**, an instance of the engine's own
task cycle applied to superelf's codebase:

1. **DATA — self-telemetry:** superelf maintains its own backlog from signals it
   already produces: audit-log errors, failed/skipped jobs, log patterns (e.g. the
   EADDRINUSE restart churn), R13-review leftovers in this file, and user friction
   notes (a one-line "this annoyed me" captured from chat).
2. **INTELLIGENCE — the proven pipeline:** a scheduled job spawns Claude Code
   headless on this repo (superelf already drives Claude Code per-user for chat)
   with a standing charter = this PLAN + the global rules. It picks ONE backlog
   item per night and runs the pipeline proven in the v2.3.0 cycle:
   **build agent → fresh-context R13 review (multi-angle) → fix agent →
   teeth-verified regression tests.** No green suite + clean review, no commit.
3. **ACTION — gated release:** commit locally, tag, write version-notes (the
   version-number changelog is the accountability surface), restart, self-check
   (HTTP 200 + suite green) with **auto-rollback** (git revert + restart) on
   failure. The morning briefing reports what was built and why, with the diff
   summary. **Never pushes to GitHub autonomously** — the user pushes at
   milestones after reading the notes.

**Guardrails（护栏）— non-negotiable:** one item per night, hard token/time budget;
no schema/data migrations without a *proposed action* approved first; no
outward-facing actions (email/messages/spending) ever pre-approved for the
self-dev job; a kill switch (disable the job) honored before anything else; every
change reversible via git. The human's remaining role: read the morning 简报,
answer approvals, edit this file to steer.

**Success metric:** user instruction/debugging time per shipped improvement → near
zero; direction-setting only.

---

## Part V — Anti-goals (things we explicitly will NOT build)

- **More screen time.** Any feature whose main effect is more looking at superelf.
- **Notification noise.** No stream of pings; the daily briefing absorbs them.
- **Feature sprawl.** No cloning polished commercial apps (todo, notes, fitness…)
  feature-for-feature when the clone adds no integration value — our edge is the
  agent acting across the data, not app polish.
- **Heavy dashboards.** Charts nobody acts on are screen time in disguise.
- **Cloud dependence for private data.** Third-party APIs may be *called*; family
  data does not *live* there.

---

## Part VI — Backlog（小事，defer 到合适的 session）

Legend: 🔥 P0 (blocking) · 🟠 P1 (important) · 🟢 P2 (when ready)

- [x] 🔥 **CAMERA AS INPUT — the health direction changed, 2026-09-11. BUILT (v2.72.2–v2.74.1).**
      Shipped: the meal card, the Diabetes Tracker and the Longevity health box all photograph
      through PAPhoto — camera-first, downscaled, pre-flighted against the server's own cap.
      · Diabetes (v2.73.0): photograph a meter / CGM screen / lab printout → the model reads it
        → each value is REVIEWED before it is recorded. Readings are stored STRUCTURED, and the
        record carries where it came from: src, the source photo's path, the model's own
        confidence, and tsGuessed for a time the photo did not contain. A value the model calls
        uncertain arrives UNTICKED; a clear one arrives ticked, because speed matters to the
        person holding the meter. A photo-derived number is never drawn like a typed one.
      · Diabetes (v2.72.4): its readings were never stored AT ALL — localStorage throws at the
        sandbox's opaque origin, so "Save reading" was a dead button and
        workspace/data/diabetes/ was empty. Now on the broker store, with the notebook apps'
        failed-read-blocks-write rule and two-tap delete (confirm() is ignored in the sandbox,
        so deletion was impossible and would have become one-tap the moment writes worked).
      · Longevity (v2.74.0): photograph an Apple Health screen → read → conversation. NOT
        stored: there is no app→health write path, and health.json feeds the weekly 健康简报 and
        the jobs, so an unconfirmed misread would be reported back as fact by three surfaces.
        The box that told the user to "set up the Shortcut" is gone — the one piece of that UX
        this touched, and it was removed, not repaired.
      STILL OPEN: a confirmed write path for photographed HEALTH metrics (a route + broker kind
      + the per-value confirmation the glucose path has), if the weekly brief is to have data
      again now that the Shortcut is dead.
      Original decision text, kept because the reasoning still stands. Decided by the owner:
      the Apple Shortcuts health-ingest route is DROPPED as a product direction. It was never
      resolved — Safari on the phone reached the server and Shortcuts never did, after days of
      isolating it — and more importantly it asks a family member to build a Shortcut, which is
      not a thing a family member will do. ("If this is so hard to do for me and you, how would we
      expect other regular users to do this?")
      Replacement: **photograph the data.** An Apple Health screen, a glucose meter, a meal, a
      label — take a picture, the model reads it, and the conversation continues from there. The
      same mechanism serves health, diet and diabetes, and it needs nothing installed.
      This makes PAPhoto (below) a prerequisite rather than a tidy-up: photo-as-input stops being
      a chat convenience and becomes the primary input path for several apps.
      The storage layer keeps its fix regardless — see the health silent-drop entry; a view that
      is quietly missing the tail of a backfill is worse than no view.

- [ ] 🟠 Home screen = the chat interface. Opening superelf lands on a chat with recent
      chats/notes beside it, instead of a 16-card grid. THE OBSTACLE: the drawer being asked
      for lives in PAChat and is inlined into apps only — `web/index.html` has no component
      markers, and the shell's own drawer has no search, no time grouping, no previews. So
      this is really one decision: inline PAChat into the shell (one drawer everywhere) or
      grow a second copy — and a second copy is how the blank-chat bug got reported three
      times. NEEDS YOUR CALL: the drawer's Notes tab works inside an app because that app
      owns its notes; at shell level there is no cross-app note index. Ship Chats+Apps only,
      or build the index first?

- [ ] 🟠 iPhone: PANote text mode is unreadable — the whole page is scaled into a phone
      screen. Below ~640px, text mode should stop being a page and reflow full-width at a
      readable size; drawing keeps the page and gains pinch-zoom. NEEDS YOUR CALL: a note
      with BOTH text and ink on a phone — proposal is ink shown read-only above the reflowed
      text, editable only on a wider screen.

- [x] 🔥 每日一报 phase 2 — mail BODIES to the model. **DONE 2026-09-11 (v2.60.0–v2.67.0, v2.69.0).**
      Decision taken: YES, and a cloud lane is acceptable. Built as: zero-dependency MIME
      (`lib/mime.mjs`), bodies fetched only for messages the DETERMINISTIC ranking already called
      important (`lib/mail-body.mjs`), still `EXAMINE` + `BODY.PEEK` so nothing is marked read,
      and the model boundary in both directions in `lib/brief-facts.mjs`.
      The injection defence is the point of it, not a footnote: every body line is prefixed as a
      quotation, so no line of mail can present itself as an instruction — no phrase blocklist.
      Verified by mutation: dropping the quote prefix fails 7 tests, dropping the closing
      delimiter fails 11. A forged section line that rode in ABOVE the facts was found by reading
      real output, not by reasoning, and is now filtered. `subject` was reaching the model raw
      while bodies beside it were quoted — closed in v2.69.0.
      Original decision text, kept because the reasoning still stands:
      `lib/imap.mjs` fetches headers only (From/Subject/Date), deliberately: headers can be
      ranked without message content ever leaving the mailbox. Reading threads means bodies
      go to a model — for a self-hosted family agent whose pitch is that private data stays
      home, that is a real escalation, not a config flag. It buys the thread narrative, the
      amounts, and closed loops — the difference between "36 routine" and "the contractor is
      waiting on you". Options: yes · no · only for senders you nominate.
      (Phase 3, Google Drive, is a separate new integration — only if wanted.)

- [x] 🟠 **PAPhoto — one photo path, not four. DONE 2026-09-11 (v2.71.3–v2.74.1).**
      Both conditions met. MAX_BYTES is never hand-copied (shell prefs → PAChat.limits →
      unknown means no pre-flight, the server decides), and every caller is migrated:
      PAChat (v2.71.3), the meal card (v2.72.2), the Diabetes Tracker (v2.73.0), the note pad's
      picker and the notes/Bible upload hooks (v2.73.1). The pad also STANDS DOWN from its own
      file.size pre-flight when PAPhoto is present — once the hook downscales, checking the
      original size refuses an 8MB shot that lands at 300KB, which is the false refusal the cap
      existed to prevent, inverted. A test now sweeps web/*.inline.html and every
      workspace.example app by directory listing and fails on any private FileReader / canvas
      resize / capture= that comes back, so a fifth copy cannot appear quietly.
      NOT migrated: web/index.html's own relay-level reader (the shell receives base64 from
      apps; it is a different job, and the file was another session's this cycle).
      Original measurement, kept because it is the reason the rule exists:

        shell            FileReader x2, posts /api/upload directly, no cap, no resize
        PAChat           FileReader, broker 'upload', no cap, no resize
        PANote           broker 'upload', UPLOAD_MAX_BYTES, no resize
        meal UI (new)    canvas downscale to 1280px, 6MB cap, broker 'meal-photo'

      Only PANote knows the real cap, and it HAND-COPIES `20*1024*1024` with a comment saying
      browser code cannot import lib/webutil.mjs. Only the meal UI resizes — which is why a
      phone photo works there and would blow the cap everywhere else. This is the same
      divergence that produced the drawer bug, "took 180.0s" and Journal's missing titles.

      Shape: a third inlined component beside PAChat/PANote (serve-time marker — the CSP
      forbids <script src>, so that is THE mechanism for sharing browser code here):
        PAPhoto.pick({accept, camera, maxEdge}) · toBase64(file,{maxEdge})
              · upload(file) → {ok,path} · MAX_BYTES
      Then resizing is free everywhere instead of existing in one place.

      TWO CONDITIONS, or it is not worth doing:
        1. MAX_BYTES is PINNED to the server's BODY_LIMITS.upload by a test, never hand-copied
           (test/fail-legibility.test.mjs already pins other shared numbers this way).
        2. MIGRATE all four callers. Adding PAPhoto and leaving them makes it FIVE.
      Refactor with no behaviour change → its own session (R8).

- [x] 🔥🔥 **AGENT CONFINEMENT — DONE 2026-09-11 (v2.59.0), and option (a) was WRONG.**
      Was: every account got the same agent lane, `--dangerously-skip-permissions`, cwd as a
      mere starting directory, one level below config.json / web.mjs / lib/. Any member could
      read the config or edit the server as the owner's Unix user.
      **Option (a) — `--add-dir` limited to the caller's workspace — does not confine anything.**
      Measured against the real CLI in a throwaway sandbox before writing any code:
        · skip-permissions + `--add-dir <own workspace>` → read a file OUTSIDE it. NO boundary.
        · `--permission-mode default`    → outside read DENIED, but inside WRITE denied too.
        · `--permission-mode acceptEdits` → outside read DENIED, `cat` via Bash DENIED,
                                            inside write SUCCEEDED.
      `--add-dir` only ADDS directories to the allowed set (its own `--help` says so), so aiming
      it at the cwd is a no-op that would have shipped a guarantee we did not have. The boundary
      is the ABSENCE of `--dangerously-skip-permissions`, and nothing else. `default` was too
      strict — it would leave a member unable to build their own app.
      Shipped: `cfg.member_args = ['--permission-mode','acceptEdits']`, one `agentArgs(user, base)`
      resolver applied at ALL FIVE lanes (chat, two resolver lanes, telegram, and the daily-brief
      synthesiser — that last one is where mail BODIES will land). The owner keeps the
      unrestricted lane. The bypass is stripped unconditionally rather than trusted from
      config.json, and an absent/role-less user is treated as a member.
      METHOD NOTE worth keeping: the first escape attempt "failed" only because the MODEL declined
      on its own judgement. That is not a control — an attacker writes the prompt. Re-run with
      innocuous wording against a neutrally-named file, it walked straight out. Never mistake a
      refusal for a boundary.
      Guard: `test/agent-confinement.test.mjs` — 6 mutations, each restoring a piece of the hole,
      each caught. STILL OPEN: no end-to-end test of a real member session through the web UI.

- [ ] 🟠 System-wide model configuration, incl. free OpenRouter lanes. Instead of per-chat
      pills, models are configured once and every chat box inherits them — the shell's, every
      app's PAChat, and job pinning (v2.40.0) all read the same list. `cfg.chat_models`
      already IS that list and `/api/models` already serves it; what is missing is an
      OpenRouter provider alongside claude/ollama/codex, and an owner-only editor for the
      list. Pairs with the confinement item above: which lanes exist is owner-configured;
      which lane a chat uses is per-user.

- [ ] 🔥 superelf.md — ONE system-wide prompt that defines what an app IS.
      MOSTLY EXISTS, unenforced and misnamed. `workspace.example/CLAUDE.md` (11KB, tracked,
      so it does reach GitHub) already carries "Reusable components — check these BEFORE
      writing any UI", the broker API, the sandbox limits and the iOS rules. What is missing
      is that it is not a CONTRACT: nothing checks a new app against it.

      Rename/lift it to `superelf.md` as the system-wide app-building prompt, and make it
      state the framework every app must follow:
        a. an (ask) AI feature — reuse PAChat at its marker, never a hand-rolled chat.
        b. an app-specific system prompt the user can edit AND reset to default.
        c. reuse existing components and services first: PAChat, PANote, PANewDot, the broker
           kinds, lib/ tools. Writing a second copy of something is the defect, not the work.
        d. app faces (below) — declared, not assumed.

      MEASURED GAPS (2026-09-09), which is why this needs to be a contract rather than advice:
        · 8 of 19 apps have NO ask/AI feature at all: allergy, calendar, daily-digest,
          diabetes, family, melody-scribe, productivity-hub, weekend-trips.
        · The per-app prompt editor with reset-to-default ALREADY EXISTS (Settings ›
          Advanced, SYS_DEFAULTS + per-app reset) — but only lists apps that shipped a
          declared default, so most apps cannot be customised at all.
      Deliverable is a test that every app satisfies the contract, the way
      test/drawer-selection.test.mjs enumerates apps — otherwise this decays into a document
      nobody reads, which is what it is today.

- [ ] 🔥 App faces（应用面孔）— the home shelf shows LIVE information, not just a name.
      Like watch complications: the allergy card shows today's pollen level, weather shows
      the forecast, productivity shows the date/next block, calendar shows the next event.
      The home page becomes a real-time dashboard instead of a launcher.
      Shape: each app declares a `face` — a tiny value + label it can produce cheaply — and
      the shelf renders it. Decide per app, by the app, when it is built.
      Open questions: where does a face's data come from (the app is sandboxed and its
      iframe is not running while the shelf is displayed)? Most likely the same JOB/TOOL
      layer — a face is a tool reading with a cadence, cached server-side — which would make
      it near-free and reuse everything in docs/JOB_ENGINE_PLAN.md. Never let a face block
      the shelf render, and never let a stale face look live (show its age).
      Part of the superelf.md contract above: an app DECLARES its face, and the assistant can
      propose one when the app is built (and make it configurable where that makes sense) —
      rather than every app inventing its own idea of what a face is.

- [ ] 🟠 Health & longevity from the Apple Watch — the most useful next app.
      TODAY: lib/health.mjs ingests only `steps, sleep, weight`, and workspace/health/ does
      not exist — NOTHING has ever been ingested, so the iPhone Shortcut was never set up.
      Wanted: activity/exercise (active energy, exercise minutes, stand hours), heart (resting
      HR, HRV), plus sleep and steps → a holistic DAILY view and a WEEKLY view with advice.
      Three parts, in order: (1) set up the Shortcut so data actually flows — nothing else is
      testable until then; (2) widen METRICS and the rollups; (3) the app's daily/weekly view.
      The weekly 健康简报 and lib/adherence.mjs already exist and would feed it.

- [ ] 🟢 Pollen job gains weather — Open-Meteo is free and keyless (found via ClawHub), and
      pairs with Pollen.com because Open-Meteo's own pollen fields are Europe-only (measured:
      all six null in North America). Add a `weather` tool, then let one job report both.

- [x] 🟠 Bible: tap a verse → instant explanation. **DONE 2026-09-10/11.** Shipped differently
      from the sketch below and better for it: not a hovering popover but a DOCKED rail beside the
      text (PASplit), so the verse stays readable while the answer arrives. Ask AI auto-sends one
      structured explain prompt for a FRESH thread only; a LONG PRESS on a verse re-asks
      deliberately. The exchange is a normal chat in the drawer, as the sketch wanted.
      Original sketch:
- [ ] ~~🟠 Bible: tap a verse → instant explanation. Tapping a verse pops an AI chat box~~
      hovering over the page, pre-filled with an "explain this verse" prompt, sends it,
      and shows the answer in place — so an explanation is *there* the moment the reader
      wants it, with no navigating away. The exchange is ALSO saved as a normal chat in
      the drawer, so it is findable later like any other conversation.
      PLAN IT IN A SUBAGENT FIRST (larger functional change → written plan before code).
      Open questions for that plan: does the popover reuse PAChat (it already renders,
      persists and lists conversations — see docs/HOME_SCREEN_PLAN.md on not forking the
      chat surface), or is it a new lightweight surface? How does it interact with the
      existing verse-selection / annotation gestures, and with the note pad? One
      conversation per verse, or one rolling "Bible questions" chat? Which lane answers?

- [ ] 🟠 Reposition docked-toolbar popovers — when the tool bar is docked in the
      title bar, its popovers (color grid, pen slider) should open fully on-screen.
- [ ] 🟠 Journal photo insertion parity — inserting a photo into a journal entry
      should work like it does in chat.
- [ ] 🟢 Auto-title a journal entry from its first line (optional nicety).
- [ ] 🟢 Dynamic text size control — A- / A+ buttons in shell toolbar; adjusts
      `document.documentElement.style.fontSize` (root em); persists via localStorage.
- [ ] 🟠 Split oversized shared files (R4, own refactor session, no behavior
      change — R8): `web/note-ui.inline.html` (~1,250 lines),
      `web/index.html` (~990), `web.mjs` (~1,300 — split it FIRST; the app-data
      store already moved out to `lib/appdata.mjs` and /api/upload's inline body
      reader is gone, so the route table is now the bulk of it),
      `web/chat-ui.inline.html` (~650).
- [x] 🔥 **Per-page notebook storage（分页存储）— TRIED, MEASURED, REVERTED**
      (round 4 shipped it; round 5, 2026-09-02, removed it. Verification:
      `test/note-whole-file.test.mjs`. The design doc and `per-page-storage.test.mjs`
      are deleted — a design doc for a layout nothing implements is a trap.)
      Round 4 split a note into `entry-<id>/index.json` + `entry-<id>/page-<pid>.json`
      (and the Bible's `draws[k]` into a `{ref:2,…}` manifest over
      `notes/<b>-<c>/<scope>/`), which did make a save cost O(one page).
      Adversarial verification then MEASURED three losses in ORDINARY flows:
      **F1** `flush()` resolved `{ok:true}` while a write it covered was still in
      flight (run()'s continuation was queued on that promise first, started write #2
      and cleared `dirty` before flush() resumed), so a note switch proceeded believing
      the outgoing note was safe; **F2** the outgoing note's failure was then re-armed
      against the INCOMING notebook and the retry wrote NOTHING while answering
      `{ok:true,saved:0,total:0}` — a confirmed save of nothing, stroke gone from disk
      AND memory with the pad showing "saved"; **F3** `deleteById` asked a session-local
      LAYOUT map that only `loadNote()` ever filled, so deleting a note never opened this
      session wrote a NEW-layout tombstone for a LEGACY note and stranded its handwriting.
      A note is now ONE atomic file again — the shape every note on disk already had, no
      note converted or mutated by any of it. Atomic by construction (`lib/appdata.mjs`
      tmp+rename + rolling `.bak`), one path per note so a write/retry/tombstone cannot
      disagree, and the 8MB cap gives ~135 dense pages with a LOUD failure and the shrink
      guard behind it. The three guard bugs are fixed independently of the layout:
      `flush()` awaits the write CHAIN, failure state is keyed to the note (`noteKey`),
      and a reply that says it wrote nothing is never a confirmed save.
      Revisit only with a real concurrency design, and only if measured sizes demand it.
      STILL DELETED (round 4, and it stays deleted): the draft mechanism, in the engine
      and all four apps — a SECOND STORE of the user's work that could be emptied or
      destroy another scope's (measured: 40 strokes lost through one draft path, 84
      through another). Point thinning (RDP / distance threshold) remains OUT of scope.
- [x] 🟠 Conversation eviction — **DONE 2026-09-11 (v2.71.2).** Evicted turns are ARCHIVED to
      `conversations/.archive/<ts>-<id>.json`, the same shape `DELETE /api/convos` already
      tombstones into, and the person is told on the reply stream. Archive, not refuse-at-cap —
      the meals answer does not transfer: a meal month rolls over on its own, a chat thread never
      does, so refusing would freeze it permanently at turn 200.
      ORDER IS THE FIX: the archive is written BEFORE the live array is trimmed, so a failing
      write throws with every message still in hand. There is no state where turns are off the
      live file but not yet on disk.
      Still open, small: `.archive` is never pruned and nothing reads it back — a person gets a
      filename, not a way to see the segment. Worth a decision, not urgent.
      Original entry:
- [ ] ~~🟠 Conversation eviction silently deletes user-typed turns (`web.mjs`~~
      `convo.messages.slice(-200)` in `chat()`): the truncated array is what
      `saveConvo` writes, so the oldest turns are erased from disk, not merely
      from the model's context window (that is separately bounded by `slice(-20)`,
      which is legitimate). No tombstone, no notice — unlike `DELETE /api/convos`,
      which does tombstone to `.trash`. `lib/meals.mjs` abolished exactly this
      pattern ("the old slice(-cap) silently destroyed the oldest records while
      answering 200"); `web.mjs` never got that treatment. Largest live conversation
      is 59 messages, so this is latent. Fix = archive the evicted turns beside the
      conversation (or refuse at the cap), with its own tests.
- [x] 🟠 Silent drops on health ingest/retention — **DONE 2026-09-11 (v2.71.4).** One invariant,
      stated once and obeyed by both payload versions: `ok === true` ⇔ `dropped === 0` ⇔
      everything you sent is on disk. Counts are in SAMPLES, every rejection carries one, and HTTP
      answers honestly — 207 partial, 400 nothing-stored, 200 clean, reusing the meals result→status
      mapping (R3).
      A SECOND instance of the same class turned up that the entry had not spotted: retention keeps
      the newest MAX_DAYS days PRESENT IN THE STORE, not the last 120 calendar days — so ingesting
      a day older than all of them wrote it, rolled it up, and pruned it again inside the same
      call, still answering `added:1, ok:true`. An upload evicted by its own call is now reported.
      Deliberate incompatibility: an unknown metric or invalid samples used to answer ok:true and
      now answers ok:false + 207. No shipped client reads this route.
      Still open: `lib/health.mjs` is 322 lines, over the R4 budget (R8 — its own session); and v1
      `sanitize()` still drops malformed keys uncounted (payload validation, not stored-data
      eviction, so deliberately left).
      Original entry:
- [ ] ~~🟠 Silent drops on the ingest/retention paths (same class as the two above,~~
      audited 2026-09-02, none fixed yet): `lib/health.mjs` MAX_SAMPLES (2000)
      discards every sample past the cap while `web.mjs` still answers 200 ok:true
      — the iOS Shortcut cannot see it, so a backfill or a multi-day catch-up
      loses the tail silently; and `pruneSampleFiles`/`pruneDays` (health) plus
      `MEALS_RETAIN_MONTHS` (meals, deletes the photos too) destroy stored personal
      content with no export path and, for health, no audit entry. Decide per path:
      refuse at the cap (the `lib/meals.mjs` precedent), or report honestly in the
      response body and audit what was removed.
- [ ] 🟢 Push discipline: batch commits locally; push at milestones or on request.
- [ ] 🟠 Family admin UI has no Approve button for pending registrations — the server
      route (POST /api/admin/users/:id/approve) exists but is unreachable from any UI.
      Wire an Approve control into the Family panel, or retire require_approval with it.
- [x] 🟢 Health review leftovers (from the R13 pass): falsy-zero prior7.mean===0
      deltaPct message; readBody drain-vs-destroy tradeoff; QR ingest URL derives
      from the request Host (localhost-opened profile encodes an unreachable URL —
      prefer the Tailscale hostname from config); healthDailyException runs the
      full analysis pipeline for a threshold check; HTTP-level integration tests
      for the new health routes (R6). — DONE 2026-09-02, plus the stop/start
      launchd-ownership scripts and web.mjs graceful shutdown + listen retry
      (see session log).
- [ ] 🟢 Shared-component API surface with zero current callers (PANote.mount/redraw/
      resize/destroy; drawer confirm/prompt; chat mount send; fullscreen newChat) —
      kept as the components' public contract at v2.0; prune in a refactor session (R8)
      if still unused.

---

## Part VII — Future ideas（远期设想，未决定）

Not committed to. Recorded so they are not re-invented from scratch, and so the reasons
against are not lost either.

### A service for other people

There may be a real use case in offering superelf to people who are technically comfortable
but do not want to build it — hosted, or as a guided self-host, with **voluntary donations**
to cover the cost rather than a subscription.

The draw would be the things that are genuinely hard to get elsewhere: the **Bible study**
app, the **family** app, the **health** app, **app creation by chat**, and the **automation /
autonomy** layer. That last one is probably the actual selling point — everything else exists
in some form; "describe an automation and it exists, and it can act with your approval" does
not.

What would have to be settled first, and none of it is small:
- **Data.** The whole design assumes the data stays on the owner's machine. Hosting inverts
  that. A guided self-host keeps the promise; a hosted service does not, and would need to say
  so plainly rather than quietly.
- **Auth and isolation.** Today a node is one family with a shared config; multi-tenant is a
  different threat model, not a bigger one.
- **Cost.** Every job and brief spends model tokens. Donations are unpredictable; the spend
  is not. Cheap deterministic tools and the pre-check gates matter far more in that world.
- **Support.** An app-creating assistant means every user's install diverges. That is the
  point of the product and the hard part of supporting it.

### Per-account `memory.md` / `soul.md` / `skill.md`

Hermes splits an agent's persistent state into separate files rather than one profile blob.
Worth copying the SHAPE, per account:

- **memory.md** — what the assistant has learned about you. Some exists already (the profile's
  name/about/prefs, and per-app system prompts) but it is a form, not a growing document.
- **soul.md** — how it should behave: tone, standing preferences, what never to do. Today this
  is `cfg.system_prompts` plus the profile's reply-style field.
- **skill.md** — what it knows how to do. This is the tools/skills split already recorded in
  `docs/JOB_ENGINE_PLAN.md` §4b–5; per-account skill files would be the natural home for the
  ones a user writes themselves.

The reason to take this seriously is not tidiness: files are editable, versionable and
reviewable, and a user can see exactly what the assistant believes about them. A hidden
profile blob cannot be audited by the person it describes.

## Part VIII — Session log

- **2026-09-02 (1)** Cleanup batch（清理批次）— Health review leftovers + two
  ops scars, all red-then-green where meaningful: (1) falsy-zero deltaPct: a
  ZERO prior week with real coverage now renders "prior 7d avg 0 → X · from
  zero · 从0开始" (shared FROM_ZERO_TEXT with adherence, R3), never "no prior
  data" (R14); (2) cfg.public_base_url（对外基址）— empty default keeps the
  Host-header derivation, SET wins for the health-setup QR (the localhost-QR
  scar); ONE gate baseUrlOk in webutil, boot-validated in config.mjs,
  UI-writable via the Node-settings whitelist, in config.example.json;
  (3) healthDailyException slim path: 7d threshold windows only
  (DAILY_CHECK_DAYS=14), equivalence-tested against the full pipeline;
  (4) HTTP-level integration tests (R6): test/helpers-web.mjs boots the REAL
  web.mjs (copied, lib/ + web/ symlinked) on ephemeral ports with throwaway
  roots — auth rejects, v1/v2 ingest + dedupe, delivered 413, /api/health
  contract, setup with/without public_base_url; (5) ops scar: launchd
  (com.superelf.web, KeepAlive) OWNS web.mjs — stop.sh uses launchctl bootout
  + full-path pkill patterns, start.sh uses bootstrap/kickstart (run.sh is
  bot-only and refuses web while the service is loaded), ownership model
  commented in all three, content-guarded in test/ops-scripts.test.mjs;
  (6) web.mjs lifecycle: SIGTERM → server.close + 5s forced-exit backstop;
  EADDRINUSE → 10×500ms listen retries (no KeepAlive crash loop) — two-instance
  port-duel regression in test/web-lifecycle.test.mjs; (7) readBody moved to
  lib/webutil.mjs: drain-vs-destroy tradeoff SETTLED in a comment + a 60s
  overall body-read deadline that destroys a hostile slow-drip, stub-socket
  regressions with mock timers. 493 tests green (468 baseline + 24 new + 1
  helper file). Uncommitted — pending R13 review.

- **2026-09-01 (7)** Meal photo logging（拍照记录饮食）— capability #3:
  POST /api/meals/ingest (Bearer per-user; /api/upload body mechanics + caps
  9MB/6MB) stores the photo in uploads/, makes ONE vision extraction at INGEST
  on cfg.vision_default (consent-by-action 主动分享即同意 — the deliberate
  share-sheet share of each photo to the "Analyze meal · 分析饮食" Shortcut IS
  the consent for the photo's one cloud call; nothing auto-collected), and
  appends {ts, slot 早/午/晚/加餐, items[], flags carb_heavy/fried/
  sugary_drink/vegetables_present, photo path} to workspace/<user>/meals/
  YYYY-MM.json (atomic, 400/month cap). Strict-JSON schema guard with ONE
  retry; lane error or twice-bad reply → {analyzed:false, reason} record (R14).
  Weekly 健康简报 gains a Meals · 饮食 section (lib/meals.mjs mealsBriefLines,
  wired like adherence): PURE aggregation, ≤3 lines, named thresholds
  (dinner-late >20:00 / carb >1/2 / veg <1/2 / sugary any / fried >1/3), honest
  coverage ("8 of 9 photos analyzed"), <2 photos → 照片不足 line, 0 → section
  omitted; non-food counts toward coverage, never denominators. Setup reuses
  the Health QR/token (path swap — no new UI); recipe:
  docs/design/meal-photo-shortcut.md. Vision stubbed at the deps seam in all
  tests (valid + malformed + thrown, mutation-teeth-checked); ONE live smoke
  (synthesized 64x64 solid PNG → glm-5.3-flash:cloud, strict JSON,
  is_food:false — honest). 450 tests green (429 baseline + 21 new).
  Uncommitted — pending R13 review.
- **2026-09-01 (8)** R13 review fixes for capability #3 (21 findings, 13
  groups) — every fix shipped red-then-green: (1) record id + photo filename
  gain a crypto random suffix — same-ms double-POSTs never clobber; (2) the
  400/month cap now REFUSES (429, bilingual, audited) BEFORE the photo write
  and vision call — silent oldest-eviction removed (appendMeal throws as loud
  backstop); (3) disk lifecycle: pruneMealMonths deletes month files older
  than MEALS_RETAIN_MONTHS (3) WITH their photos at ingest (health.mjs
  precedent), audited counts; (4) vision rides web.mjs's MAX_CONCURRENT
  enqueue + per-user in-flight guard (second concurrent ingest → 429 busy);
  (5) strict base64 (interior '=' truncation scar) + JPEG/PNG/HEIC magic
  bytes before any storage or cloud call; (6) lane-error `reason` sanitized +
  capped (sanitizeLine, the last boundary); (7) schema guard REJECTS junk
  items (non-string/oversized/empty-after-sanitize/>8) and is_food:false
  forces the empty shape — non-food injection stores nothing; (8) read-back
  shape guard: malformed disk records count as unanalyzed, never in
  denominators; (9) pattern gate counts ANALYZED FOOD records; dinner-late
  needs MIN_DINNERS (2) and states its n; (10) dinner runs to midnight
  (23:30 IS a late dinner), optional client takenAt drives slot/date
  (bounded plausibility), brief week = calendar days ending yesterday;
  (11) R3: MEAL_PROMPT derives from MEAL_FLAGS, vision-default fallback
  literals removed (lib/config.mjs is the one source), readBody's
  'body too large' contract shared via readIngestBody + BODY_TOO_LARGE.
  lib/meals-brief.mjs split out (R4). 468 tests green (450 + 18 net new).
  Uncommitted — pending re-review.
- **2026-09-01 (5)** Adherence loop（跟进闭环）— capability #2: the weekly
  健康简报 now VERIFIES follow-through. lib/adherence.mjs (pure, deterministic
  R14 producer): each executed create-reminder intervention (joined to its live
  reminder by action id) is judged 7d-before-start vs 7d-ending-yesterday via
  the existing windowStats; verdicts = keeping-it（保持）/ no-change →
  adjust-reminder-time or retire-reminder proposal through the EXISTING
  approval loop (payload.flag 'adherence_<id>' rides the standing
  denied/executed/pending suppression) / insufficient-data honesty（数据不足）/
  denied-or-removed metric self-improving → one positive line, no proposal.
  Caps: 3 lines, 1 proposal per brief; zero new messages. New executors in
  lib/actions.mjs (both non-outward, in NO pre-approved default):
  adjust-reminder-time → reminders.mjs updateReminderTime (validated, new),
  retire-reminder → removeReminder. An active flag is no longer re-proposed as
  create-reminder. reminders.mjs TIME_RE deduped into the schedule.mjs import
  (R3; the config.mjs copy fell in session (6)). 407 tests green (387 baseline
  + 20 new, red-then-green). Uncommitted.
- **2026-09-01 (6)** R13 review fixes on the adherence loop（跟进闭环审查修复）,
  23 confirmed findings in ~12 groups, every fix red-then-green: (1) R14/zero —
  a mean-0 baseline with real coverage is DATA: "0 → 3500 · from zero ·
  从0开始" keeping-it verdict; insufficient-data keys on present-days ONLY.
  (2) Horizon — healthBriefBody fetches rows to the oldest evaluated
  intervention's before-window (adherenceHorizonDays), and interventions age
  OUT of evaluation past ADHERENCE_EVAL_MAX_DAYS=42 (silence, never
  'insufficient data forever'; flag ownership never ages out). (3) Calendar
  days via localDateStr diff (DST/later-in-day safe). (4) Young gate — NO
  verdict before ADHERENCE_WINDOW_DAYS active days (a day-2 reminder can't
  claim a pre-existing trend). (5) THE JOIN — reminders carry the producer
  `flag` (execCreateReminder stamps it; legacy entries match the create
  action's text+time+day and upgrade in place); a LIVE reminder always
  classifies 'active' (a later denial can't shadow it); retirement is
  RECORDED — approved retire actions carry retiredFlag, the manual DELETE
  route writes recordReminderRetirement — anchoring verdictGone to the real
  removal date and holding the ORIGINAL flag in RETIRED_COOLDOWN_DAYS
  (denial-equivalent: no next-brief re-proposal of what was just removed).
  (6) Re-baseline — updateReminderTime stamps adjustedAt (windows re-anchor),
  records the left slot in triedTimes (never re-proposed; all slots spent →
  terminal retire proposal, no 18:00↔07:30 oscillation), and keeps same-day
  fire semantics honest (earlier slot → no hours-late catch-up via
  preRegimeOccurrence; later slot → clearJobRunToday so it fires today).
  (7) A suppressed follow-up silences its LINE too — no weekly nag while a
  denial/pending/just-executed ask stands. (8) Copy/R3 — ONE meanChange/
  covChange formatter for line + why; proposal titles from ACTION_TYPES
  labels; ADJUST_ALT_TIMES comment corrected + WALK_REMINDER_TIME shared with
  the producer; REMINDER_NAME_MAX shared (the bare 40); suffix reworded to
  'pending · 待定' (true across the store-time duplicate filter); config.mjs
  TIME_RE dedupe completed. 429 tests green (407 + 22 new). Uncommitted.
- **2026-09-01 (4)** R13 review fixes on the daily brief（每日一报审查修复）,
  all teeth-verified red-then-green: (1) ONE sanitizeLine (lib/webutil.mjs) at
  the compose boundary kills the =0A header-injection PoC — controls/bidi
  stripped, newlines flattened, ≤15-line cap now proven for HOSTILE input;
  (2) legacy 07:30 LLM brief schedule fully retired — schedules entry removed
  from config.example.json AND the live config.json, bot.mjs special case gone
  (stale scheduleRuns keys proven harmless); (3) SSRF gate: icsUrlOk is
  https/webcal-only, fetchIcs re-enforces https + per-fetch public-DNS
  resolution (loopback/RFC1918/link-local/metadata refused) + redirect:'manual'
  with an honest bilingual line; config-level calendar_ics passes the same
  gate; (4) size caps: ICS streamed under 2MB + 500-event cap, IMAP 256KB
  literal + 2MB session ceilings — honest unreachable path, never OOM;
  (5) RRULE UNTIL compared as an instant (Asia/Shanghai off-by-one regression);
  (6) only literal-carrying FETCH responses are messages (unsolicited FLAGS
  lines ignored); (7) mail sender = sanitized "Name <address>" — the address is
  the anchor; (8) honest count wording "N unread since yesterday · 昨日起未读";
  (9) corrupt-config errors are GENERIC — the JSON.parse message quoting
  app-password bytes never reaches errors/audit; (10) DAY_MS single-sourced in
  lib/schedule.mjs, Bible table extracted to lib/bible-daily.mjs, truncate
  consolidated into sanitizeLine, calendar+mail fetched in PARALLEL
  (allSettled). 335 tests green (313 baseline + 22 new). Uncommitted.
- **2026-09-01 (3)** Unified morning brief（每日一报）— Phase B capability #1,
  deterministic compose, NO LLM: lib/daily-brief.mjs (≤15 plain lines: date /
  calendar 日历 / mail 邮件 / verse 经文 / health 健康 / approvals 待批准),
  lib/ics.mjs (hand-rolled ICS: DTSTART UTC+floating+all-day, RRULE daily+weekly,
  unsupported bits documented), lib/imap.mjs (hand-rolled read-only IMAP-over-TLS:
  LOGIN → EXAMINE → SEARCH UNSEEN → header-only PEEK fetch, tested on a scripted
  local stub server). One-message rule: health-daily retired, its exception line
  folded in; the morning-brief stub deleted (R1). Feed creds (calendar_ics /
  gmail_*) read FRESH from config.json each run — paste lights up without a
  restart; per-user profile calendarIcs field (validated, briefingEmail pattern).
  R14: unconfigured feed omitted, unreachable feed = one honest bilingual line.
  313 tests green (283 baseline + 30 new). Uncommitted — pending R13 review.
- **2026-09-01 (2)** v2.5.0: approval loop（审批闭环）shipped after a 53-agent R13 review found and fixed a denied-action-executes race and an any-app-can-approve bypass — action state is now single-writer with decisions confirmed only in shell chrome. Reminders got first-fire/removal/dedupe semantics. iPhone: release-notes sheet rebuilt as a native dialog; chat no longer opens mid-scroll. Google path settled: Gmail=IMAP app password, Calendar=ICS (OAuth later for Drive/writes), Photos=device-side Shortcuts (Google API closed to third parties).

- **2026-09-01 (2)** Phase B email channel（邮件通道）v1 = delivery: lib/agentmail.mjs
  (AgentMail thin client, fetch seam, one inbox per node — adopt-or-create by
  client_id, id persisted in root agentmail.json, gitignored); briefings now also
  deliver to a per-profile 简报邮箱 · briefingEmail (PUT /api/profile validated
  via ONE emailOk gate, blank clears; same plain-text body as Telegram via shared
  plainParts, failures audit and never fail the job); owner profile shows the
  node's inbox address read-only with copy (honest bilingual error when
  unavailable); two v2.7.0 new-UI keys (briefing-email, agent-address). Ingestion
  (Gmail auto-forward → digest) is v2. 283 tests green (258 baseline + 25 new).
- **2026-09-01** Phase A approval loop（审批闭环）shipped: proposals from the
  weekly health brief's deterministic flags; decide via Telegram inline buttons
  (auth: sender→own workspace) or the longevity 待批准 section; typed executor
  registry (create-reminder → persistent reminders on the job engine, noop);
  pre-approval classes with outward types refused at config load; expiry /
  denial-cooldown / failure honesty. 211 tests green (169 baseline + 42 new).
- **2026-08-31 (2)** v2.2.0: Phase C shipped — multi-LLM Verify · 校验 (per-app toggle, R14 honest-failure core); journal photo insertion + auto-title; iOS Health ingestion design locked (Phase B next). 

Append one short entry per session — the lightweight history that makes future
sessions (human or AI) faster.

- **2026-08-31 — v2.0 milestone.** Closed out the v2.0 UI push: Journal unified
  onto the shared PANote surface (text migrated, one drawer everywhere); PANote
  gained docked toolbars, highlighter, and whole-page text-mode flip; PAChat drawer
  now docks/pushes on wide screens with a stale-load race guard. Declared the
  **feature freeze** and wrote this PLAN.md: development pivots from apps/UI to the
  agent itself — Phase A (action/task engine) is next.
