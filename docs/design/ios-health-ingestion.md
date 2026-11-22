# iOS Health Ingestion · 健康数据摄取 (design)

Status: **proposed — no code yet.** Phase B flagship integration (see `PLAN.md`
Part III). Companion docs: `docs/JOB_ENGINE_PLAN.md` (the job engine this rides on —
referenced, not restated) and `docs/design/multi-llm-assessment.md` (the accuracy
layer health suggestions may invoke).

> **Note, 2026-10-11 (ADR 0004):** the daily exception line and the morning brief it rode in were
> removed. The weekly 健康简报 is the only health delivery. Text below about a daily line is history.

Prior art (R11 — searched `docs/`, `lib/`, `web.mjs` for health/ingest/briefing):
**an ingestion path already exists** — `POST /api/health/ingest` + `GET /api/health`
in `web.mjs`, backed by `lib/health.mjs` (per-day flat metrics in
`workspace/<user>/health.json`, sanitized, capped at 120 days; tested in
`test/health.test.mjs`). This design **extends** that path; it does not add a second
endpoint or a second store (R1/R3).

## 1. Goal · 目标

Health data flows from the family's iPhones into superelf **with zero ongoing screen
time**, and comes back out as a few **actionable** diet / exercise / sleep suggestions
（饮食/运动/睡眠建议）in the existing briefing 简报 surface — suggestions that move the
user *away* from the screen. This serves the mission (health span 健康与长寿) and the
principles directly:

- **P2 less screen time:** the Shortcut runs on an automation; the user reads one
  weekly digest. No dashboards (anti-goal), no notification stream.
- **P3 autonomy + approval:** analysis is a read-only digest (auto); anything
  side-effecting is a proposed action in the existing approval queue, eligible for
  pre-approval 预批准 once Phase A lands.
- **P5 data isolation + privacy:** raw samples never leave the machine; per-user
  storage in the user's own gitignored workspace.

**Non-goals 非目标:** a fitness-app clone; charts; real-time sync; medical diagnosis
(suggestions are lifestyle-level, first-principles, and say so).

## 2. Ingestion path · 摄取路径

### 2.1 Endpoint — extend the existing one

`POST /api/health/ingest`, authenticated exactly like every other API route: the
user's Bearer token (`Authorization: Bearer <token>`; `userFor()` in `web.mjs`).
Each family member's iPhone uses that member's own token, so data lands in that
member's own workspace. Transport: LAN or Tailscale to the self-hosted server —
never a third-party relay (open question Q3 on which to require).

Two payload shapes, distinguished by a `schema` field:

- **v1 (today, unchanged):** flat `{ date?, steps: 8500, weight: 70.2, ... }` —
  one row per day, merged. Existing consumers (diabetes / longevity apps reading
  `GET /api/health`) keep working untouched.
- **v2 (new, sample-level):**

```json
{
  "schema": "health.v2",
  "source": "iphone-shortcut",
  "metrics": [
    { "metric": "steps",   "unit": "count", "samples": [ { "ts": "2026-09-01T08:00:00-0700", "value": 1200 } ] },
    { "metric": "sleep",   "unit": "min",   "samples": [ { "ts": "2026-08-31T23:10:00-0700", "end": "2026-09-01T06:40:00-0700", "value": 450, "stage": "asleep" } ] },
    { "metric": "glucose", "unit": "mg/dL", "samples": [ { "ts": "2026-09-01T07:30:00-0700", "value": 105 } ] }
  ]
}
```

(All values above are synthetic examples.) Metric names come from one exported
constant list (`METRICS` in `lib/health.mjs`, R3): `steps`, `sleep`, `heart_rate`,
`resting_hr`, `weight`, `workout`, `glucose`. Unknown metrics are rejected
per-metric, not whole-payload. Payload capped (~256 KB, ~2 000 samples) to keep the
endpoint abuse-safe like the current sanitizer.

### 2.2 Idempotency · 幂等

Re-running a Shortcut must not duplicate samples. Dedupe key =
`metric | ts | source` (one reading per metric per timestamp per source — HealthKit
semantics). Ingest is a set-union: existing keys are skipped, response reports
`{ ok, added, duplicates, rejected: [{metric, reason}] }`. A retried or overlapping
upload (e.g. Shortcut sends "last 48 h" daily) is therefore always safe.

### 2.3 Storage · 存储

Follows the existing precedent: server-owned, cross-app user data lives at the
workspace root (like today's `health.json`, `journal.json`), gitignored; sandboxed
apps read it only through the authenticated broker — `data/<slug>/` remains for
app-private data (P5).

- `workspace/<user>/health/YYYY-MM-DD.json` — **append-only per-day sample files**
  (v2 raw samples, keyed by dedupe key). One file per local day keeps writes small
  and audits easy.
- `workspace/<user>/health.json` — unchanged daily-aggregate rollup; on v2 ingest
  the server recomputes that day's aggregates (steps total, sleep minutes, resting
  HR, weight last, glucose mean/min/max) into it, so existing apps and
  `GET /api/health` see richer data with zero contract change.
- Retention: raw sample files pruned after 120 days (`MAX_DAYS`), aggregates kept
  (open question Q5).

### 2.4 The Shortcut recipe · 快捷指令 (one-time setup per metric)

Shortcut **"superelf 健康上传 — steps"** (repeat per metric, or one shortcut
looping a metric list):

1. **Find Health Samples** — Type: *Steps*; Start Date: *last 2 days* (overlap is
   safe — dedupe).
2. **Repeat with Each** → **Dictionary** `{ts: Start Date (ISO), value: Value}` →
   **Add to Variable** `samples`.
3. **Dictionary** — the v2 envelope: `schema`, `source`, `metrics` with `samples`.
4. **Get Contents of URL** — `https://<superelf-host>/api/health/ingest`, Method
   POST, Header `Authorization: Bearer <that member's token>`, Request Body: JSON.
5. **If** result has no `ok` → **Show Notification** "健康上传失败 health upload
   failed" (the ONLY user-visible surface, and only on failure).

**Automation:** Shortcuts app → Automation → *Time of Day 21:00, Daily* → Run
Shortcut → **Run Immediately** (no "Ask Before Running"), Notify: off. After this
one-time setup the pipeline costs **zero ongoing screen time**; a simpler
aggregate-only variant (Calculate Statistics → v1 flat payload) works against the
existing endpoint today with no server change (Phase 1 below).

## 3. Analysis · 分析

A job on the **existing engine** (`docs/JOB_ENGINE_PLAN.md`: job-as-data with
`tool: "health"` already reserved in the schema; runtime = `runJob` in
`lib/autonomy.mjs`, trigger = `lib/schedule.mjs` grown by Phase A). No new surface.

**Deterministic first (plain code, new `lib/health-analyze.mjs`):**

- **Trends 趋势:** 7-day and 30-day mean/median per metric, delta vs the prior
  window (e.g. "steps 7d avg 6 100, down 18% vs prior 7d" — synthetic example).
- **Threshold flags 阈值:** config-driven per-user thresholds (no magic numbers;
  e.g. `sleep_min_minutes`, `glucose_fasting_max`), each flag carries the exact
  numbers and dates that triggered it.
- **Correlations 相关性:** e.g. sleep duration vs next-morning fasting glucose,
  steps vs sleep — Pearson r, reported **only with n ≥ 10 paired days** and always
  with n; correlation is labeled correlation, never causation.
- **R14 — honest gaps:** every metric window reports `days_present / days_expected`.
  Missing data is output as missing ("no sleep data this week 本周无睡眠数据"),
  never interpolated, never guessed, and a window with no data is a *gap finding*,
  not a silently skipped section (empty ≠ pass).

**Then ONE LLM pass** phrases the computed findings as 3–5 actionable,
first-principles diet / exercise / sleep suggestions, bilingual (EN + 中文), each
tied to a computed finding — the model may not introduce numbers not present in the
deterministic input.

**Privacy 隐私 (hard rules):**

- The LLM lane is **explicit config**: `cfg.health_llm` names the `chat_models`
  id (provider `ollama`) that phrases the digest; default = the **first ollama
  entry**. Honest terms 说明: the default ollama entries are `*-cloud` models
  (Ollama cloud), so with a default config the computed aggregates DO leave the
  machine — and the briefing footer names the lane, e.g. "analyzed via DeepSeek
  (aggregates only) · 仅聚合数据". Point `health_llm` at a local ollama model
  for fully on-device analysis.
- Whatever the lane, it receives **only the computed aggregates JSON** — never
  raw samples, never the per-day files.
- **Nothing personal ever goes to third-party search APIs** (Perplexity lane etc.).
  If a suggestion needs web grounding, the query is generic ("evidence on walking
  after meals"), carrying no user data.
- Important suggestions may be cross-checked via the multi-LLM assessment layer
  (`docs/design/multi-llm-assessment.md`) under the same aggregates-only rule.

## 4. Delivery · 交付

Suggestions land as a **briefing** in the existing surface (`saveBriefing` →
`GET /api/briefings`) — the surface the user already checks; nothing new to open,
no push notifications.

- **Weekly 健康简报 (Sunday 20:00):** the full digest — trends, flags, gaps,
  3–5 suggestions. This is the one thing the user reads: **~1 screen, once a week.**
- **Daily:** no separate health briefing. Only a fired threshold flag adds one line
  to the existing morning brief ("glucose 7d avg above your threshold — details in
  Sunday's 健康简报"). No flags → zero daily health text.
- **Proposed actions (optional, P3):** a suggestion may queue a concrete action via
  `proposeAction` — e.g. "add a 20-min post-dinner walk to tasks.md 添加饭后散步任务"
  — visible in the existing approval queue (`/api/actions`), executed only on
  Approve; recurring ones become pre-approved 预批准 routines once Phase A's policy
  ships. Action types are side-effecting → never auto-run (fail-safe default in
  `lib/autonomy.mjs`).

Net screen time: setup once; then one weekly read plus rare approve taps.

## 5. Failure semantics · 失败语义

| Failure | Endpoint behavior | Briefing behavior (R14) |
|---|---|---|
| Bad/missing token | `401 {"error":"bad token"}` (existing) | — |
| Malformed JSON / no valid metrics | `400 {"error":"..."}`, nothing stored | — |
| Partly valid payload | `200`, valid metrics stored; `rejected:[{metric,reason}]` lists the rest | rejected metrics show as gaps, with the reason if it persists |
| Duplicate re-run | `200`, `duplicates` counted, no double-store | — |
| Oversized payload | `413`, nothing stored | gap |
| Shortcut didn't run / phone off LAN | no request; Shortcut notifies on failure only | "no data received since <date> — the Shortcut may not have run 快捷指令可能未运行" — stated, never guessed around |
| Analysis job errors | job engine logs + retry per `JOB_ENGINE_PLAN.md` | a failed run produces **no** briefing — never an empty "all good" one (empty ≠ pass) |

## 6. Phased implementation · 分阶段 (each small, verifiable)

| Phase | What | Files touched |
|---|---|---|
| 1 | **Shortcut v1 (aggregates)** against the *existing* endpoint — zero server code. Write the two recipes above into `README.md` setup notes. | `README.md` only |
| 2 | **v2 sample ingest:** schema detect, `METRICS` constant, dedupe, per-day files, aggregate rollup, caps. | `lib/health.mjs` (+ split out `lib/health-store.mjs` if >300 lines, R4), `test/health.test.mjs`; `web.mjs` route unchanged |
| 3 | **Deterministic analysis:** trends / flags / correlations / gap accounting over synthetic fixtures. | new `lib/health-analyze.mjs`, new `test/health-analyze.test.mjs` |
| 4 | **Job + briefing:** `health-weekly` job (per-user `jobs/*.json` once Phase A's store lands; interim: the `JOBS` map in `web.mjs`), LLM phrasing pass on the local lane, briefing template, morning-brief flag line. | `web.mjs` (job def), `lib/health-analyze.mjs` (prompt builder), integration test via `runJob` with a stubbed `deps.run` |
| 5 | **Proposed actions + pre-approval:** walk/sleep reminders through `proposeAction`; pre-approval rides Phase A. | `web.mjs` job def, `test/autonomy.test.mjs` additions |

**Verification plan (R6, and the never-test-live rule):** all testing on a
**throwaway instance** — fresh checkout, fresh `config.json`, synthetic users;
**never the live family instance or real health data.** A small generator script
(scratch, not committed) emits 30 days of plausible synthetic v1+v2 payloads;
e2e = curl the payloads (including duplicates, malformed, partial) → assert store
contents → trigger the job → assert the briefing text reports the planted trends
AND the planted gaps verbatim-honestly. A control run with an empty store must
yield a "no data" briefing, not a healthy-looking one (R14).

## 7. Open questions · 待定 (max 5)

1. **First metrics:** propose steps + sleep + weight first (lowest friction, daily
   value); glucose only for members with a CGM; heart rate / workouts second wave?
2. **Per-family-member setup:** each iPhone needs that member's own token — is a
   QR code on the member's profile page the minimal safe distribution, and who sets
   up non-technical members' Shortcuts?
3. **Network path:** require Tailscale (works away from home, encrypted) vs
   LAN-only (simpler, but the 21:00 automation silently fails when away)?
4. **Delivery cadence:** is weekly + exception-line-in-morning-brief right, or
   should the health digest merge entirely into the daily morning brief (one digest
   to rule them all, P2)?
5. **Retention:** after the 120-day raw-sample window, keep monthly aggregate
   rollups forever, or drop entirely?


---

## Decisions（已定）— 2026-08-31

The open questions above are resolved:

1. **First metrics:** Steps + Sleep + Weight. Glucose (CGM) and heart rate/workouts are later additions, not v1.
2. **Member setup:** a QR code on the profile page hands each phone its Bearer token + endpoint.
3. **Network:** Tailscale required — uploads work from anywhere; each phone runs the Tailscale app.
4. **Cadence:** weekly digest 健康简报 + a daily exception line only when a threshold fires.
5. **Retention:** monthly rollups kept indefinitely after the 120-day raw window (long series serve the longevity mission; rollups are tiny).
