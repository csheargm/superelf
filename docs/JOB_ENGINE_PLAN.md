# Autonomous Job Engine — plan

Status: **the output half is built and running; the job-as-data half is not.**
Revised 2026-09-09 after review. Supersedes the 2026-08-30 draft, which
understated what exists (the Jobs management view it listed as pending has since
shipped) and assumed jobs would stay code.

## The one rule that shapes everything

**Creating or changing a job must never require a server restart.** A job is a
row of data plus a prompt, not a branch of `web.mjs`. That single constraint
decides the file layout, the reload path, and where chat-to-job writes.

> **Superseded in part, 2026-10-11 (ADR 0004).** The daily brief (每日一报) and all mail
> reading were removed. Read this plan with that in mind:
> - `deliver: fold-daily` is gone. Jobs default to `own-message` (§6); a legacy
>   `fold-daily` job file is normalised to `own-message` when it is read, never rewritten.
> - `lib/imap.mjs` and `lib/mail-rank.mjs`, used below as tool and skill examples, no longer
>   exist, and nothing reads mail. The "act on Gmail" direction in §6b is closed.
> - `health-brief` (健康简报) is the only built-in job.
> - `docs/DAILY_BRIEF_PLAN.md`, referred to below, was never committed.
>
> **Superseded in part, 2026-10-12 (ADR 0006).** The Telegram bot was removed. Delivery is in
> the app plus email only (`lib/notify.mjs` `notifyBriefingEmail`); every "Telegram" below is
> history. `dueAt` and `dueSchedules` became the one `dueJobs` in `lib/schedule.mjs`.

---

## 1. What exists today

| piece | where | state |
|---|---|---|
| job contract `{name,title,schedule,run()}` | `web.mjs` `JOBS` (hardcoded) | works, **not editable** |
| once-per-local-day firing + same-day catch-up | `lib/schedule.mjs` `dueJobs` | done |
| run → briefing → actions | `lib/autonomy.mjs` `runJob` | done |
| silence vs failure vs report | `run()` returns `null` / throws / `{body}` | done |
| delivery (email; Telegram until 2026-10-12) | `lib/notify.mjs` — never throws | done |
| Jobs · 任务 view: schedule, last run, outcome, next due, Run now | `lib/jobstatus.mjs` + Settings | done |
| approval queue (propose → approve → execute, idempotent) | `lib/actions.mjs`, `autonomy.mjs` | done |
| live web data (search + scrape + citations) | `lib/research.mjs` `runResearch` | done, **unused by jobs** |

Two jobs exist: `daily-brief` (每日一报) and `health-brief` (健康简报). Adding a
third means editing source and restarting — the thing this plan removes.

## 2. A job is a file

`workspace/<user>/jobs/<id>.json` — per-user, gitignored, same as conversations.

```json
{
  "id": "pollen-alert",
  "title": "花粉预警 · Pollen Alert",
  "prompt": "Alert me if the pollen count is high today.",
  "schedule": { "time": "06:30" },
  "plan":   { "kind": "research", "query": "pollen count today <postcode from profile>", "extract": ["level","top allergen"] },
  "condition": "level >= high",
  "deliver": "fold-daily",
  "policy": "read-only",
  "enabled": true,
  "created": 1757000000000,
  "author": "chat"
}
```

- **`prompt`** is the source of truth and stays editable — see §7.
- **`plan`** is what the model resolved the prompt into (§4–5). Regenerated when the
  prompt changes; a user never has to write it.
- **`condition`** is what makes a job silent on a quiet day. It maps onto the
  existing three-way return: no match → `null`, match → `{body}`, error → throw.

## 3. Hot reload — no restart, ever

`jobsTick({ users, jobs: JOBS, … })` in `web.mjs` **already takes the job set as a
parameter**. So the change is small:

- Replace the `JOBS` constant with `loadJobs(user)` — read `jobs/*.json` fresh on
  each tick, exactly as `runDailyBrief` already re-reads `config.json` and the
  version footer re-reads `package.json` per request.
- Built-in jobs (`daily-brief`, `health-brief`) stay code and merge into the same
  map, so nothing regresses while the data path lands.
- A malformed job file is **skipped and reported**, never fatal — one bad row
  must not stop the tick for every other job (R5).

Cost: one tick reads a few small JSON files a minute. Measured serving budget for
comparison: an app page costs 6.7 ms.

## 4. Chat → job: the model does the work

The user says *"alert me if the pollen count is high today"*. The engine resolves
it **without interrogating the user**, in this order:

1. **An existing tool.** Pollen is live web data → `lib/research.mjs`, which
   already searches, scrapes and returns citations. No new code.
2. **Existing code.** Health thresholds, meals, calendar, mail — already modules.
3. **New code, generated.** Only when 1 and 2 genuinely cannot serve it. The agent
   writes a small module into the job's own folder (§7).
4. **Ask — last resort.** Only for what cannot be inferred and would make the job
   wrong: a login, a location the profile does not have, a real ambiguity. Then
   offer **concrete alternatives to pick from**, not an open question.

> Worked example. "Pollen high today" needs no questions: the postcode comes from the
> profile, "high" maps to a standard scale, "today" sets a daily schedule, and
> `runResearch` supplies the reading with a citation. Resolution is silent.

**Review happens once, at authoring — not on every run.** A tool is an ordinary
module, and the difference between one I hand-write in a session and one the agent
writes at 06:00 is *when a human sees it*, not what it is. So a NEW tool is shown
as a diff and armed once; after that it is just a module and its jobs run
unattended like any other. Steps 1–2 need no review at all — they call tools that
already exist.

---

## 4b. Three layers: tool, skill, job

The plan above collapsed "skill" into the job's prompt. Both Hermes and OpenClaw
keep them apart, and so should we — because the three have different lifetimes and
different editors.

| layer | is | changes when | example |
|---|---|---|---|
| **Tool** | a capability. Deterministic code, no model in the loop | the outside world changes | `lib/imap.mjs` — reach a mailbox, return headers |
| **Skill** | know-how. Which tool, what counts as important, how to say it | your judgement changes | what makes mail "important"; how the brief is phrased |
| **Job** | when it runs and where output goes | your routine changes | 07:30 daily, folded into 每日一报 |

**The test:** if two people would want it to behave differently, it is a skill. If
it is the same for everyone, it is a tool. Reaching a mailbox is the same for
everyone; what counts as important is not.

**So: "read Gmail" is a TOOL.** "Triage my inbox and tell me what needs a reply"
is a skill that uses it. (Ours reads headers only — bodies are a deliberate open
decision, see `docs/DAILY_BRIEF_PLAN.md`.)

**Both already exist here, unnamed:**

- Tools — `lib/imap.mjs`, `ics.mjs`, `health.mjs`, `meals.mjs`, `research.mjs`.
- Skills — `MEAL_PROMPT`, `SUGGEST_PROMPT`, `ASSESS_SUMMARY_PROMPT`,
  `buildResearchPrompt`, and `cfg.system_prompts` with its per-app entries and
  three-level precedence (profile override → configured → built-in default). That
  precedence chain is already a skill registry; it just lives in config and in
  string literals inside `.mjs` files.

**The house style is to codify a skill into a tool when you can.**
`lib/mail-rank.mjs` is exactly that: "which mail matters" started as judgement and
became `MAIL_RULES` — deterministic, local, testable, no tokens. Prefer that.
Keep a skill as a prompt only where the judgement is genuinely irreducible.

**What this changes:** skills become files, not string literals — editable without
a deploy (requirement: update the prompt easily), versionable, and attachable to
both a job and a chat. A "triage mail" skill written once serves the daily brief
and the "what needs my reply?" question in chat.

## 5. Tools: the catalogue is the point

*(Skills get the same treatment — manifest, version, catalogue — one layer up.)*

The reusable-tool library is the durable asset here — jobs come and go, tools
accumulate. And most of it already exists without being called that:

| already a tool | what it does |
|---|---|
| `lib/research.mjs` | web search + scrape + citations |
| `lib/ics.mjs` | fetch/parse a calendar feed (with the SSRF + size guards) |
| `lib/imap.mjs` | read mail headers |
| `lib/mail-rank.mjs` | score message importance, fully local |
| `lib/health.mjs`, `lib/meals.mjs` | per-user metrics and meal records |
| `lib/adherence.mjs` | did the suggestion actually get followed |

Measured, not assumed: **no `lib/` module imports `web.mjs`** — every one is
already standalone, most already take injected deps (`fetchImpl`, …), and each
opens with a comment stating its purpose. They are tools missing a manifest, not
code needing a rewrite.

**A tool is a module plus a manifest:**

```json
{ "name": "pollen", "purpose": "Today's pollen level for a postcode",
  "inputs": { "postcode": "string" },
  "outputs": { "level": "low|moderate|high|very-high", "top": "string", "source": "url" },
  "effects": "read-only",          // read-only | writes | spends-money
  "needs":   ["research"],          // other tools / config keys it depends on
  "author":  "chat", "version": 1 }
```

Jobs then reference a tool rather than embedding code: `"plan": {"tool":"pollen",
"args":{"postcode":"…"}}`. Write the pollen tool once for the alert job, and the
weekly summary, the app, and any future job get it free — the reuse you are
describing, at single-instance scale.

**Sharing is already built.** `lib/sharedapps.mjs` does promote / fork / rollback
/ `versionsOf` against a `shared-apps/` directory, with an admin API. Pointing the
same mechanism at `tools/` gives a catalogue others can pull from without
inventing anything — the hub property, reusing code that already exists (R3).

### Where a tool comes from — including other people's

Three sources, in preference order:

1. **Already here.** The `lib/` modules above. Pollen needs nothing new:
   `research` with different arguments.
2. **Authored locally**, by chat, reviewed once (§4).
3. **Ported from an external registry** — e.g. OpenClaw's ClawHub, which is a real
   public skill registry ("npm for AI agents", thousands of entries).

**Ported, not installed — and that distinction is the whole point.** Two reasons
this instance should not pull third-party code straight in:

- *Shape.* ClawHub skills are `SKILL.md` — markdown instructions an agent reads at
  runtime. Our tools are deterministic ES modules that run on a timer with no model
  in the loop (`mail-rank.mjs` is literally "DETERMINISTIC, FULLY LOCAL"). A skill
  file does not drop into `lib/`; it would need an agent interpreting it every run,
  which is slower, costlier and non-reproducible — the opposite of what the daily
  brief is.
- *Trust.* Anyone with a week-old account can publish there. This instance holds
  family health data, mail credentials and the filesystem, and jobs run
  **unattended**. An open registry is a supply chain, and this repo is
  deliberately zero-dependency — no lockfile, no `node_modules`, a hand-rolled IMAP
  and ICS client — precisely to avoid having one.

**Worked example — the loop in practice (2026-09-09).** Need: pollen. Searched the
registry (`https://clawhub.ai/api/search?q=pollen`) → `thesethrose/weather-pollen`,
5,816 downloads. Read it. Two things came back:

- **The reusable part — the idea.** It uses **Open-Meteo** for weather and
  **Pollen.com** for pollen, both free and **neither needs an API key**. That is
  the wheel: no provider evaluation, no signup, no key to store. Worth having.
- **The part that proves the rule.** The listing's own review notes the skill
  "overstates arbitrary-location support … pollen is **hardcoded to ZIP 75409**".
  Installed as-is, our alert would have reported someone else's town in Texas,
  confidently, every morning — the failure mode that is worst here, because a
  wrong pollen reading looks exactly like a right one.

**Honest limit on this loop.** For a capability we already have working, a registry
lookup mostly just confirms a choice already made — it is not a routine step, and
should not be presented as one. Its value is narrow and real: unfamiliar
capabilities, obscure endpoints, auth quirks, and *whether a keyless API exists at
all*.

The pollen case is the useful shape of that. `workspace/apps/allergy` already
existed — but it does **not** call Pollen.com. It sends a PROMPT asking a model to
search the web (`broker('ask', …)`), names pollen.com as a suggested source, then
regex-matches JSON out of free text. That is a **skill**, and it costs a model call
per refresh, is non-deterministic, and has a parse-failure branch. What the lookup
actually bought was the knowledge that **the data is available keyless** — which
means this capability can move skill → tool: no model, no parse branch, testable,
free, and safe to run unattended. A job that regex-parses model output would fail
silently on a bad day, which is the one failure mode §10 says to guard first.

That skill → tool conversion is the house style (`lib/mail-rank.mjs`), and it is
the real return here — not the endpoint itself.

### The registry landscape (2026-09)

Hermes ships a Skills Hub that **aggregates ~90,700 skills across 11 registries**,
so it is the better meta-search than any single hub:

ClawHub 69,150 · skills.sh 19,967 · LobeHub 505 · browse.sh 440 · NVIDIA 299 ·
Hermes official-optional 117 · built-in 82 · gstack 53 · OpenAI 44 · HuggingFace
25 · Anthropic 17.

Note the inversion: the curated registries are tiny and the open ones are enormous.
That is the same trust/quality trade the pollen skill demonstrated — 69,150 entries
is only possible because publishing is nearly free, and a hardcoded ZIP is what
gets through. Search widely; trust narrowly; port either way.

Note the registry does screen for *malice* (the listing carries a note finding no
prompt injection or exfiltration) — and the hardcoded location still shipped.
Vetting for badness is not vetting for correctness. Take the endpoints, write our
own tool, test it against a known postcode.

So treat a published skill as a **reference implementation**: read how it solves
the problem, then implement it here as a vetted local tool with a manifest and a
test. That takes the wheel without taking the supply chain. If a specific tool is
ever worth adopting wholesale, it gets read line by line first and pinned to a
commit — never a floating install.

## 6. Presentation: fewer messages, not more

`deliver` decides where output lands:

| value | behaviour |
|---|---|
| ~~`fold-daily`~~ | REMOVED 2026-10-11 with 每日一报. Read as `own-message` for old job files |
| `own-message` **(default)** | its own email push (Telegram until 2026-10-12, ADR 0006) |
| `feed-only` | Briefings feed only, no push |
| `app:<slug>` | appended to an app's data, for "make me an app that collects X" |

The one-message-a-day rule already exists: `daily-brief` folded in the old
separate health job for exactly this reason. Folding is the default so a user with
ten jobs does not get ten notifications.

## 6b. Where output lands, and doing rather than telling

Two changes to this plan, from review.

### The briefings feed belongs in the SHELL, not inside an app

Today the only place to read a job's output is the 简报 section of the **longevity app**.
There is no subscription behind that — `listBriefings` returns every briefing the user has,
unfiltered, and the longevity app is simply the only app that ever asked. It is an accident:
briefings arrived as a health feature, and the reading surface never moved when they became
general.

That is wrong in three ways: to read a pollen alert you open an app about longevity; there is
no per-job control; and `briefings` is a shared broker kind, so an app installed to track
sleep can read the mail brief — a hole in the per-app data isolation everything else honours.

**Proposal: a notification centre in the shell**, beside Chats and Notes in the drawer. It is
the DEFAULT destination — every job result lands there — and Telegram/email/an app become
additional subscribers rather than the only way to see anything. This folds into
`docs/HOME_SCREEN_PLAN.md`, where the drawer is already becoming the unified list.

### Jobs should ACT, not only notify

The engine currently ends at "produce a briefing". The more valuable half is doing something
about it — the Gmail case: fetch mail, work out what needs attention, and *draft the replies*.

Researched how this is done elsewhere (2026): the settled pattern is **draft-and-wait**, with
the choice made PER RULE rather than globally. Inbox Zero — the one credible self-hostable
option — lets each rule say whether it runs automatically or produces a draft you approve, and
nothing is sent without explicit confirmation. That is the industry norm, not a cautious
outlier.

**We already have this.** `lib/actions.mjs` + `autonomy.mjs` implement propose → approve →
execute, idempotently, with a read-only policy and a limbo sweep. It has simply never been
wired to a tool that can DO anything. So acting is not a new subsystem; it is:

1. a tool with `effects: 'writes'` (draft a reply, add a calendar entry, file a message),
2. the job's `policy` deciding auto vs approve — per job, as Inbox Zero does per rule,
3. the existing approval queue carrying it, which already survives double-taps and crashes.

Order still matters: read-only tools first (they are useful alone), then one writing tool
end-to-end, then the rest. The Gmail case wants mail BODIES, which is still the open privacy
decision in `docs/DAILY_BRIEF_PLAN.md` — acting on mail cannot start before that is settled.

## 7. Management: edit the prompt, not the plumbing

The Jobs · 任务 view already lists schedule, last run, outcome, next due and Run
now. It gains, for data-defined jobs only:

- **Edit prompt** — a textarea. Saving re-resolves `plan` (§4) and shows what
  changed before it takes effect.
- **Enable / disable**, **change schedule**, **delete**.
- **Last output** inline, so "is this doing anything useful?" is answerable.
- Built-in jobs stay read-only in the UI — their `run()` is code.

## 8. Module boundary — its own code and its own data

The engine is a **service**, not part of the web server:

```
lib/jobs/              engine — store, resolver, runner, reload
  store.mjs            read/write/validate workspace/<user>/jobs/*.json
  resolve.mjs          prompt -> plan: pick a tool, or author one (§4-5)
  run.mjs              plan -> result, by calling the named tool
  registry.mjs         the tool catalogue: manifests, versions, effects
  index.mjs            the service surface (below)
tools/                 SHARED tools — the seed catalogue wraps lib/research, ics, …
workspace/<user>/tools/  user-authored tools, manifest + module, forkable to tools/
workspace/<user>/jobs/   job files
```


`web.mjs` keeps only the wiring: the tick calls the service, the API exposes it.
Nothing in `lib/jobs/` imports `web.mjs`, so the engine is testable headlessly and
its files can change without touching the server.

**Exposed once, reusable everywhere** (requirement: chat-to-job any time):

- **HTTP** — `GET/POST/PATCH/DELETE /api/jobs`, `POST /api/jobs/:id/run`.
- **Broker kind** `job-create` / `job-list` / `job-update`, so any sandboxed app
  can offer "turn this into a job" without its own copy of the logic.
- **Main chat** — "every morning check X" reaches the same service, the way
  "create an app that…" already reaches the app writer.

## 8b. What to borrow from Hermes Agent (Nous Research)

Hermes ships a working scheduled-job engine; several of its choices are answers to
problems this plan would otherwise have to discover in production. Reviewed
2026-09-09 against its cron docs. Adopt these:

| Hermes does | why it matters here |
|---|---|
| **`no_agent` script mode + a pre-check that returns `wakeAgent:false`** | The strongest idea. Most of our jobs need no model at all; a cheap deterministic gate decides whether to wake one. Pollen: fetch, compare to threshold, wake nothing on a low day. |
| **Empty stdout suppresses delivery** ("the watchdog pattern") | Independent confirmation of our null-is-silence rule. Same conclusion, reached separately. |
| **Cron tools are DISABLED inside a cron run** | A guard we do not have. Our chat-to-job service will be reachable from apps and from chat, so a job that can create jobs is a runaway loop. Adopt verbatim. |
| **Pre-dispatch validation** — key resolves, tools ready, delivery target has credentials — blocks the run and **alerts once** | Stops burning an LLM pass on a job that was always going to fail at delivery. The alert-once dedup matters as much as the check. |
| **`last_status: delivery_failed`, tracked separately from run failure** | A real gap for us: `notify.mjs` never throws, so a failed Telegram send today is *invisible*. Correct that delivery cannot fail the job — but it must still be recorded. |
| **Schedules: `in 2h`, `every 30m`, `weekdays at 9am`, raw cron, ISO one-shots** | Our `dueAt` does daily/weekly at HH:MM only. Intervals and one-shots are missing, and natural language is what makes chat-to-job feel like chat. |
| **Create paused with `--paused-reason "Awaiting review"`** | Cleaner than the bespoke "proposed, not armed" gate in §4 — a new tool's job is created *paused with a reason*, reusing the ordinary lifecycle instead of a parallel one. Also avoids the create-then-pause race. |
| **Per-job model pinning** — "a global model change never stops a scheduled job" | We already half-do this with `cfg.health_llm`; generalise it. |
| **`continuity`: a job's previous output injected into its next run** | How "don't tell me the same thing twice" works in general, rather than relying on once-per-day firing. |
| **Jobs in one plain JSON file, no restart; a lock file guards the tick** | Confirms §2-3. Note our `tickRunning` guard is in-process only — it would not stop a second process. |

**Where we deliberately differ.** Hermes skills are markdown loaded into an agent
session each run; our tools are deterministic modules (§5) — so what Hermes calls
`no_agent` mode is our *default*, not an option. And Hermes fans output out per
job; we fold daily jobs into one message (§6), because the complaint that started
this was too many low-value messages, not too few.

## 9. Build order

1. **`lib/jobs/store.mjs`** + hot reload in the tick. Built-ins keep working.
   *Ships value alone:* jobs become editable files, no restart.
2. **`registry.mjs`** — manifests for the tools that already exist
   (`research`, `ics`, `imap`, `mail-rank`, `health`, `meals`). No new behaviour,
   just a catalogue the resolver can read.
3. **`resolve.mjs`** against the catalogue. Enough for pollen, news, prices —
   every one of those is `research` with different arguments.
4. **Management UI** — edit prompt, enable, delete, last output.
5. **`deliver: fold-daily`** into 每日一报.
6. **Pre-check gates** (`wakeAgent:false`) so a quiet day costs no tokens, and
   `delivery_failed` recorded distinctly from run failure.
7. **Tool authoring by chat** — the job is created **paused, with a reason**, and
   armed after the diff is reviewed.
8. **Broker kinds + `tools/` sharing** via the existing `sharedapps` mechanism —
   with cron-management tools DISABLED inside a job run (no self-replication).

## 10. Risks

- **A wrong plan silently produces nothing.** A job returning `null` forever looks
  identical to a quiet day. The Jobs view must show last *output* and last
  *matched*, not just last run, or a broken pollen alert is indistinguishable from
  a low-pollen month. This is the one I would guard first.
- **A tool with a bad contract spreads.** Reuse cuts both ways: a tool that
  mis-parses a field is now wrong in every job that calls it. Manifests declare
  outputs so a change is visible, and a tool ships with its own test like every
  existing `lib/` module does.
- **`effects` must be honest.** `read-only` is what lets a job run unattended. A
  tool that quietly spends money or sends mail while declaring `read-only` defeats
  the gate — so effects are declared in the manifest and re-checked at authoring,
  and anything unrecognised is treated as side-effecting.
- **Prompt drift.** Re-resolving on edit can change a plan under the user; show
  the diff before saving.
- **A job that can create jobs.** Chat-to-job is exposed to apps and to chat, so a
  job run must not reach the job-creation service — Hermes disables it inside cron
  runs for exactly this reason. Adopt that before the broker kinds ship.
- **Silent delivery failure.** `notify.mjs` never throws by design, so today a
  failed send leaves no trace. Record `delivery_failed`.
- **Fan-out.** Ten jobs x one push each is spam; `fold-daily` is the default.

## Still true from the earlier draft

**Connectors.** Headless `claude -p` cannot use claude.ai's Gmail/Calendar/Drive
connectors (they need interactive OAuth). Use an open-source Google Workspace MCP
with a service-account key; for site monitoring, a headless browser MCP with a
persistent profile. Automating a *work* site may violate employer policy — check
first.

**Perplexity lane.** A subscription already paid for; wire `provider:'perplexity'`
into `cfg.chat_models` and surface its citations. `tool:'perplexity'` then becomes
just another job plan kind. (`lib/research.mjs` covers the same ground today via
Tavily + Firecrawl, so this is an upgrade, not a blocker.)

**Use cases that are all just "a job".** Morning brief · pollen/air quality ·
wellbeing synthesis over health+calendar · surface uplifting photos by mood ·
camera motion analysis · work-site monitoring. Jobs can trigger jobs.
