# Multi-LLM Assessment · 多模型校验 (design)

Status: **proposed — no code yet.** Companion to `docs/JOB_ENGINE_PLAN.md` (which names
Health as the flagship vertical; this feature is its trust layer). Searched `docs/`,
`web/`, `lib/` for prior art: no existing assess/verify/cross-check design or code.

## 1. Goal · 目标

For important questions — especially health-related — one model's answer is not
trustworthy enough. When the user opts in, the same question is fanned out to a small
panel of stronger models, and Claude produces a comparison: **consensus 共识** vs
**discrepancies 分歧**, with single-source claims flagged. The user sees at a glance
what all models agree on and what is contested.

Minimalism rules the UX: **one toggle on the composer + one view switch on the answer.**
No dashboards, no extra screens.

**Non-goals 非目标**
- No auto-adjudication or voting — the summary reports agreement, it does not pick a winner.
- No per-panel-model chat threads; panel answers are inputs to the summary, not conversations.
- No new providers; the panel is drawn from the existing `cfg.chat_models`.
- No change to the fast lane — the normal reply streams exactly as today.
- Main-shell chat (`web/index.html`'s own log) and the Telegram bot are later phases;
  v1 targets PAChat, which every app inherits. (The Telegram bot was removed 2026-10-12,
  ADR 0006, so only the shell-chat phase remains.)

## 2. UX · 交互

**Composer toggle 开关** — a second small pill next to the existing model chooser
(`.pac-model` in `web/chat-ui.inline.html`), same style class family:

```
[ DeepSeek ▾ ]  [ ☐ Verify · 校验 ]
```

- Off by default. When ON the pill highlights (accent color): `☑ Verify · 校验`.
- **Remembered per app** (recommendation; see Open Q1). PAChat already persists a
  per-app `{key:convoId}` map through the broker `data`/`save-data` channel (auto-
  namespaced to `data/<slug>/`); the flag becomes one more key in that same JSON.
  Apps without `opts.persist` degrade to session-only. Rationale: the Health app user
  wants it habitually on; per-conversation would reset on every new chat.

**Send behavior** — unchanged for the fast lane. The picked model streams the answer
exactly as today. Additionally the server fans the same message out to the panel.

**On the answered message** — a chip row under the AI bubble (rendered by PAChat,
reusing the `.pac-acts` bar position):

- While pending: `⏳ Verifying · 校验中 (1/3)` — counts models that have *settled*
  (responded, errored, or timed out), updating as results land.
- When ready: two chips, a view switch: `[ Fast · 快速 ] [ Deep ×3 · 多模型 ]`.
  Tapping swaps the bubble content between the fast answer and the summary (both are
  already-rendered markdown; the swap is client-side only).
- On failure: `⚠ Verify failed · 校验失败 — tap to retry` (never a blank deep view; R5/R14).
- The user is **never blocked**: they can keep chatting, switch threads, or close the
  app; the result attaches to the turn and is there when they reopen (see §6).

## 3. Protocol · 协议

**Request** — the broker `kind:'chat'` message and `/api/chat` body gain one optional
flag: `assess: true`. PAChat sends it when the toggle is on; the shell relay in
`web/index.html` already forwards the body fields it knows — it adds `assess` to the
pass-through list (one-line change).

**Response stream** — the existing ndjson lines (`convo`, `status`, `delta`, `done`,
`ping`, `error`) are unchanged. One new line type, emitted right before `done`:

```json
{ "type": "assess", "state": "started", "models": ["glm", "claude", "gpt"] }
```

The stream then ends as today — it does **not** stay open for the panel (agent models
take minutes; holding the stream would keep PAChat's `sending` lock and block the
composer). The shell relay forwards unknown line types verbatim (`send({ev:jj})`),
and old PAChat builds ignore unknown `ev.type` — **backward compatible with zero
coordination**: old client + new server, or new client + old server, both degrade to
exactly today's behavior.

**Result delivery — poll the convo, no new endpoint.** The orchestrator persists
progress onto the conversation turn (§6). PAChat, having seen `assess:started`, polls
the existing broker `kind:'convo'` → `GET /api/convos/:id` (~every 10 s, backing off
to 30 s, giving up after `assess_timeout`). Polling the convo also means a reopened
app needs no special path: rendering history shows whatever state is persisted.

## 4. Server orchestration in `chat()` · 服务端编排

All new logic lives in a new `lib/assess.mjs` (R4: `web.mjs` is already at 804 lines;
`chat()` gains only a ~5-line hook after the fast-lane result is saved):

```
if (assess) { line({type:'assess', state:'started', models}); runAssessment({user, convo, message, appSystem}); } // detached, not awaited
```

`runAssessment` (fire-and-forget, promise not awaited by the request):

1. **Panel** = `cfg.assess_models` (§7) minus the model that just answered the fast
   lane (dedupe — its answer is already in hand and is included in the comparison as
   the "fast" entry only if configured; default: panel runs independently).
2. **Parallel dispatch** with per-model timeout (`cfg.assess_timeout_minutes`),
   `Promise.allSettled` semantics. Reuses the existing lanes exactly as `chat()` does:
   `streamOllama` (no onDelta) for provider `ollama`, `runClaude` for `claude`,
   `runCodex` for `codex` — each **without** resume ids (one-shot, stateless; the
   panel gets the same recent history slice the fast lane got, plus the same resolved
   system prompts from `resolveSystemPrompts`, so an app's language directive holds).
   Agent calls go through the existing `enqueue()` so they respect `MAX_CONCURRENT`.
3. **Per-model verdict** recorded as it settles: `{id, label, ok, ms, error?}` and the
   answer text (capped, §6). `ok:false` when the call errored, timed out, **or
   returned empty/whitespace text** — empty output is failure, not agreement (R14).
   Each settle updates the persisted convo so the client's "(n/3)" counter is live.
4. **Summarize** once all settle: one `runClaude` call (`cfg.assess_summarizer`) whose
   prompt contains the question, each responding model's answer labeled by model, and
   the explicit absentee list. The summarizer never sees a timed-out model's partial
   output.
5. Persist `state:'done'` with the summary, or `state:'error'` with a reason.

**Summarizer system prompt** (sketch; single source in `cfg.system_prompts.assess`, R3):

> You are comparing answers from multiple AI models to the same question. You receive
> the question, each model's answer labeled by model name, and a list of models that
> failed to respond. Produce, concisely: (1) **Consensus 共识** — points at least two
> models independently agree on; (2) **Discrepancies 分歧** — where answers conflict,
> quoting which model says what; (3) **Single-source 单一来源** — claims made by only
> one model, flagged as unverified; (4) **Confidence note 置信说明** — one line, and it
> MUST begin by stating participation, e.g. "3 of 4 models responded; gpt timed out."
> Never treat a missing model as agreeing. If fewer than two models responded, say the
> cross-check is inconclusive instead of inventing consensus. Do not pick a winner.
> Follow the app's language directive appended below (e.g. reply in Chinese with
> English keywords). For health topics, add one line noting this is a cross-check of
> AI answers, not medical advice · 非医疗建议.

## 5. Failure semantics · 失败语义 (R14)

- A model that **times out / errors / returns empty** is `ok:false` with a reason, is
  **excluded from the summarizer's inputs**, and is **named as absent** in the summary's
  mandatory participation line ("3 of 4 responded; gpt timed out"). Never silently
  dropped, never counted toward consensus.
- `< 2` responders → the summary must state the cross-check is inconclusive. A panel
  where everything failed → `state:'error'` ("no panel model responded"), not a
  vacuous "all models agree".
- **Summarizer failure or empty summarizer output** → `state:'error'` with the reason;
  the deep view renders an explicit error + retry chip, never a blank pane (R5).
- The orchestrator's own crash is caught and persisted as `state:'error'` (R5: no
  silent swallow — the convo always reaches a terminal state or times out visibly).
- Client-side: if polling hits `assess_timeout` with no terminal state, PAChat shows
  `⚠ Verify timed out · 校验超时` — the absence of a result is itself surfaced.

## 6. Persistence · 持久化

The assessment attaches to the **assistant turn** it verifies — a new optional field
on the `role:'md'` message inside the existing `conversations/<id>.json`:

```json
{ "role": "md", "text": "<fast answer>", "assess": {
    "state": "pending | done | error",
    "started": 1735600000000, "updated": 1735600200000,
    "models": [ {"id":"glm","label":"GLM","ok":true,"ms":48000},
                {"id":"claude","label":"Claude","ok":true,"ms":181000},
                {"id":"gpt","label":"GPT (Codex)","ok":false,"error":"timeout","ms":600000} ],
    "answers": { "glm": "<capped text>", "claude": "<capped text>" },
    "summary": "<markdown>", "error": null } }
```

- Old readers ignore the extra field; the Ollama history mapper reads only `m.text`,
  so panel data never leaks into later prompts. The 200-message trim carries it along.
- `answers` are capped (~4 KB each) so a convo file stays small while the summary
  remains auditable (see Open Q3).
- On reopen, PAChat's history replay sees `assess` on the turn and renders the chip
  row in the right state — both views survive restart with no extra fetch.

## 7. Config · 配置 (`lib/config.mjs`, single source, R3)

```js
cfg.assess_models   = cfg.assess_models   || ['glm', 'claude', 'gpt'];  // ids from cfg.chat_models: top Deep + both agents
cfg.assess_summarizer = cfg.assess_summarizer || 'claude';
cfg.assess_timeout_minutes = Number(cfg.assess_timeout_minutes) || cfg.task_timeout_minutes; // per panel model
cfg.system_prompts.assess = cfg.system_prompts.assess || ASSESS_SUMMARY_PROMPT; // §4 sketch
```

Ids are validated against `cfg.chat_models` at load (unknown id → loud config error,
not a silent skip). User-level overrides follow the existing Advanced-settings pattern
(`profile.systemPrompts` precedent): a later phase adds `profile.assessModels`, resolved
profile → config, exactly like `resolveSystemPrompts` does today.

## 8. Cost & latency · 成本与时延

- Fast lane: unchanged (seconds).
- Panel: GLM ≈ tens of seconds; Claude/Codex agent runs are **minutes** (they are CLI
  agents, and they share `enqueue()`'s 3 slots with interactive chats). Expect the
  summary in ~2–10 min; the design is fire-and-forget with late arrival, so this is
  acceptable — the user already has the fast answer.
- Each verified send ≈ 3 extra model calls + 1 summarizer call (subscription-metered
  for the agents). This is why the toggle is off by default and per-app: it is meant
  for the questions that matter, not every message.
- Server load: one detached orchestration per verified send; bounded by `enqueue()`.
  No new long-lived connections (polling reuses a cheap existing GET).

## 9. Phases & verification · 分阶段与验证

| Phase | Scope | Files | Test (R6/R14) |
|---|---|---|---|
| 1 | Orchestrator: fan-out, timeouts, verdicts, summarizer call, persistence | `lib/assess.mjs` (new), `lib/config.mjs` | `test/assess.test.mjs` with **injected fake runners** that replicate real behavior — resolve `{ok:false}` on timeout like `runClaude`, *throw* like `streamOllama` (harness fidelity): consensus path; timeout → named absent; empty answer → `ok:false`; all-fail → `error` not vacuous pass; summarizer-fail → `error` |
| 2 | Wire-in: `assess:true` in `/api/chat`, `assess:started` line, detached launch | `web.mjs` (~5 lines), shell relay in `web/index.html` (1 line) | integration: POST with `assess:true` → stream ends promptly, convo reaches terminal assess state; without the flag → byte-identical behavior to today (honest control, R14) |
| 3 | PAChat UI: toggle pill, chip row, view switch, polling, history replay | `web/chat-ui.inline.html` only — **zero app code**; Bible/Journal/Health inherit via serve-time inlining | e2e user flow (Playwright-style, as prior features): toggle on → send → fast answer streams → chip counts up → switch views → reload app → both views persist; kill a fake panel model → summary names it absent |
| 4 | Advanced-settings override for panel/summarizer; optional shell-chat surface (Telegram dropped with the bot, ADR 0006) | `web/index.html`, `lib/users.mjs` | profile override precedence test |

Each phase lands independently; phase 1–2 are testable with no UI at all.

## 10. Open questions · 待定

1. **Toggle memory scope** — per app (recommended), per conversation, or global profile?
2. **Dedupe policy** — when the user's current model is already a panel member (e.g. they
   chose GLM), skip it in the panel (recommended) or run it again independently?
3. **Store panel answers** — capped full texts (recommended, auditable) or only the
   summary + per-model status (smaller convo files)?
4. **Summarizer tier** — Claude CLI default model, or pin a fast tier (haiku-class) for a
   quicker summary at some reasoning cost?
5. **Live counter fidelity** — is the polled "(n/3)" progress worth phase-3 scope, or is
   a plain "Verifying · 校验中" until terminal state acceptable for v1?
