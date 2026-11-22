# ADR 0007 — A scheduled job checks the Ollama models; the chooser hides the ones that are gone

Status: accepted · 2026-10-12 · decision 4 amended 2026-10-17 by ADR 0017 (the weekly model review)

## Context

- Ollama retired two default lanes on 2026-09-25: `deepseek-v4-flash:0731` (the Fast default most
  apps open on) and `qwen3.5:397b`. `/api/chat` answers them `410 {"error":"… was retired at …"}`.
- The live `config.json` has no `chat_models` key, so the defaults in `lib/config.mjs` applied. For
  over two weeks every turn on those lanes failed with a bare `Ollama HTTP 410`, because
  `streamOllama` dropped the body. Nothing on the node noticed. A later audit found it.
- Measured on Ollama 0.34.3: `/api/show` still answers 200 for a retired model, and `/api/tags`
  lists only locally pulled models. Only a real `/api/chat` call shows that a model is gone.
  `https://ollama.com/api/tags` lists the cloud catalog, and the retired names are absent from it.
- The node already has a scheduler (`lib/jobruns.mjs`, the `JOBS` built-ins in `web.mjs`). It
  gives a job a Jobs row, Run now, a per-user off switch, retries and audit.

## Decision

1. **A built-in job, `model-check`（模型检查）.** The models are the node's, so it runs for ONE
   person: the first active owner. A node with two owners gets one set of probes and one briefing.
   It runs daily at `config.model_check_time` (default `06:00`). A config reload applies a new time.
   The job probes every Ollama lane with the app's own request shape, limited to one token.
   Only 410, or a 404 whose body is Ollama's own `model '…' not found`, means "gone". A bare 404
   (a wrong `ollama_url`), a 5xx, a timeout or Ollama being down says nothing about the model. If no lane can be checked, the run fails and is retried; it never counts as a quiet pass.
   A lane or the catalog that cannot be checked is briefed when it starts failing, not every day;
   Run now always reports it.
2. **The record is `model-health.json` at the node root**, keyed by model string, so pointing a
   lane at a new model clears it. Any Ollama caller that meets a gone answer records it at once.
   Detection therefore does not wait for the next run. The job still briefs a model first seen
   by a chat turn (`reported: false`), and keeps a record that a turn writes while its probes run.
3. **The list updates itself.** `/api/models` leaves out gone lanes. A turn that still names a gone
   lane, or an id that `chat_models` no longer has, falls back to the default and says so in a
   status line. The default is the first entry still served. Before, a dropped id went to the
   Claude agent lane without a word. Both use one predicate, `laneServed`, in `PA_CHAT_LANE`.
   A stored `appModels` entry whose id has left `chat_models` no longer blocks the profile: the
   shell sends the whole map on every pick, so refusing one stale entry stopped every app from
   remembering anything. Only an id being newly stored must be in `chat_models`.
   An image on a text-only lane whose vision lane is gone goes to the Claude agent lane, which
   opens the file itself, with a status line. The text-only lane would answer about a picture it
   never saw.
4. **Config stays the owner's.** The job never edits `config.json`. When it reads the catalog
   (`config.ollama_catalog_url`, `''` = off), it lists models that are new and not configured.
   The first read lists every unconfigured model once; after that, only arrivals. A rebuilt record
   starts over, so it lists them once more. The owner then decides what to add.
   **Amended 2026-10-17 (ADR 0017):** this job still reads and records the catalog, but no longer
   lists new models. The weekly `model-review` job tests them and edits `chat_models`. Its first
   review on a node only reports, it keeps the guards ADR 0017 lists, and it has a one-step Undo.
5. **New defaults:** `deepseek` keeps its id, because profiles store it in `appModels`, and now
   points at `deepseek-v4.1-flash:cloud`. Qwen had no successor in the catalog. Its Deep slot is
   now `deepseekpro` (`deepseek-v4-pro:0813-cloud`).

## Consequences

- A future retirement shows up as one briefing to the owner. It is not a failure on every turn.
- A status line is transient. In PAChat it shows until the first token, which takes under a second
  on these lanes. The lasting signal is the owner's briefing. The shell reads `/api/models` at boot
  and again each time an app is opened, and the app gets its models only after that read is back (at
  most `MODELS_WAIT_MS`, 3 s), so the next app opened after a lane goes no longer offers it. This
  holds in a shell left open for days (the iOS home-screen app). A failed read keeps the last good
  list. The same read redraws the main chat's own chooser where a fresh load would put it: a lane
  picked there that is still served is kept, and a gone one gives way to the boot default (Claude
  when offered), so its label names the lane the turn sends. Two cases still show a gone lane's
  label: an app that was already open, until it is reopened; and a shell used only for the main
  chat, which opens no app and so rereads nothing until it reloads. Each app open costs one
  `GET /api/models`, one small file read.
- One gone answer hides a lane for the whole node until a run sees it answer, which is up to a day, or
  at once with Run now. With the job switched off, only Run now brings a lane back.
- `health_llm`, `research.llm`, the Verify panel and meal-photo vision (`mealVision`) do not fall
  back. On a gone lane they fail with the server's reason, and the job reports the lane.
- A `config.json` that relies on the default `chat_models` and names `qwen` in `health_llm`,
  `assess_models` or `research.llm` now refuses to load: those keys are checked strictly against
  `chat_models` ids, by design. A config with its own `chat_models` is unaffected. Check each node
  before deploying. The live node has no `qwen` in its config or profiles (checked 2026-10-12).
- An image on a text-only lane whose vision lane is gone runs on the agent lane: for the owner's own
  chat that is the unrestricted agent, and it can wait in the agent queue behind a running task.
  Apps and members get the confined agent lane they could already pick.
- Briefing is at most once. `reported` is written before the job engine stores the briefing, so a
  disk failure in between loses that one briefing; the lane stays hidden and Run now lists it.
- Each run sends one probe per Ollama lane plus one catalog GET. That is about 1.6 s for the
  6 default lanes (measured).
- The test harness (`test/helpers-web.mjs`) points every server at a refusing port and no catalog,
  so a test server whose scheduler runs this job can never reach the real Ollama or ollama.com.
