# Demo models, Ask AI and web search · 演示模型、问 AI 与联网搜索

## Which model does what · 模型分工

- **Chat · 聊天:** `chat_models[0].model` in `ops/demo/config.demo.json` — **deepseek-v4-pro:0813**.
- **App building · 建应用:** `demo.app_model` (read at use time; empty = the chat model) — **gpt-oss:120b**.
- `demo.chat_timeout_s` is **300**: a whole app page took 2–3 min on the strong models (measured below);
  the old 120 s would cut most builds off.
- The live node reads `/data/superelf/config.json` (seeded once from config.demo.json), so a model
  change there is applied by hand on the VM, never by the weekly watch.

## Bench 2026-11-21 · 评测（PARTIAL · 部分结果）

`tools/demo-model-bench.mjs --apps water,habit` inside the demo container: the real app maker
(prompt, contract, postcheck, retry, Ask AI injection) on 2 requests (water counter with today's
date; habit tracker with Ask AI), and 5 chat prompts (web-search question, 中文, planning, writing,
a follow-up turn = 6 turns). App points = built + compiles + controls + saves + feature + Ask AI (6 per app).
"chat first text s" is the median, search included on the search turn.

**PARTIAL:** 12 of 18 models got only HTTP 429 "too many concurrent requests" — three bench
processes ran at once and the Ollama account caps concurrency. Their zeros mean NOT MEASURED, not bad.
Several builds hit the bench's own 180 s call cap ("no full answer within 180s").

| model | app points | built | retries | app median s | chat ok | chat first text s | searched when needed |
|---|---|---|---|---|---|---|---|
| gpt-oss:120b | 12/12 | 2 | 0 | 141.7 | 6/6 | 6.4 | yes |
| kimi-k2.7-code | 12/12 | 2 | 0 | 179.6 | 6/6 | 6.7 | no |
| glm-5.3 | 0/12 | 0 | 0 | — | 6/6 | 0.8 | yes |
| glm-5.3-flash | 6/12 | 1 | 0 | 154.9 | 6/6 | 3.7 | yes |
| deepseek-v4-pro:0813 | 6/12 | 1 | 0 | 33.8 | 6/6 | 6.7 | yes |
| deepseek-v4.1-flash | 6/12 | 1 | 0 | 54.9 | 6/6 | 5.7 | yes |
| kimi-k3 | 0/12 | 0 | 0 | — | 0/6 | 0 | no |
| kimi-k3.1-pro | 0/12 | 0 | 0 | — | 0/6 | 0 | no |
| minimax-m3.1-flash | 0/12 | 0 | 0 | — | 0/6 | 0 | no |
| mistral-large-4 | 0/12 | 0 | 0 | — | 0/6 | 0 | no |
| gemma4:31b | 0/12 | 0 | 0 | — | 0/6 | 0 | no |
| mimo-v2.6-pro | 6/12 | 1 | 0 | 128.4 | 6/6 | 6.9 | yes |
| mimo-v2.6-flash | 0/12 | 0 | 0 | — | 0/6 | 0 | no |
| nemotron-3-super | 0/12 | 0 | 0 | — | 0/6 | 0 | no |
| inkling-2-small | 0/12 | 0 | 0 | — | 0/6 | 0 | no |
| clef:27b | 0/12 | 0 | 0 | — | 0/6 | 0 | no |
| minimax-m3 | 0/12 | 0 | 0 | — | 0/6 | 0 | no |
| gpt-oss:20b | 0/12 | 0 | 0 | — | 0/6 | 0 | no |

**Why · 为什么:** app building = **gpt-oss:120b**: the only model with 12/12 AND the fastest full
pass (142 s vs kimi-k2.7-code 180 s); deepseek-v4-pro was fast (34 s) but timed out on the habit
app. Chat = **deepseek-v4-pro:0813**: answers read best (clean [1] citations, a real follow-up,
correct 中文 example), searched when it had to, 6.7 s to first text on the search turn (the
others ~1–3 s). gpt-oss:120b chat leaked raw citation tokens (【1†L1-L5】); kimi-k2.7-code did
NOT search for the current-events question and answered from 2025 memory.

## Ask AI in every demo app

`lib/demo-askai.mjs` makes it the server's job, not the model's: a page that mounts PAChat keeps
its mount (the marker is added if missing); any other page gets `<!--PA_CHAT_UI-->` plus a small
"Ask AI · 问 AI" button opening `PAChat.fullscreen` with the app's visible text as context. The
shared component is inlined at serve time (web.mjs sendAppHtml). Turns go through the demo chat
route with the app slug — the same per-visitor AI caps.

## Web search · 联网搜索

The chat prompt carries `SEARCH_RULE`; a reply that is `[[superelf-search]] <query>` makes the server
call `https://ollama.com/api/web_search` (`{query, max_results}` → `{results:[{title,url,content}]}`,
bearer `OLLAMA_API_KEY` from the container env), then ask again with the results; the server appends
**Sources · 来源**. Caps: `web_search_per_day` 10 per visitor, `web_search_per_ip_per_day` 50; over the
cap the reason is shown and the answer comes unsearched. Owner nodes keep their Tavily route.

## Weekly model watch · 每周模型观察 (report only)

`tools/ollama-model-watch.mjs` diffs ollama.com/api/tags against `/data/model-watch/known.json`
(seeded from `ops/demo/ollama-models.json`), benches at most 8 new names, writes
`/data/model-watch/model-watch-<date>.md`, and never switches a model. Unit:
`ops/demo/superelf-demo-model-watch.{service,timer}` (Mondays 04:30). It needs root `docker exec`
(no user-level unit can reach Docker on this VM), so it is a root system unit: installed and enabled on
the demo VM 2026-11-22 (first run Mon 2026-11-23 04:30 VM time; the VM runs on UTC); install steps are in the service file's header. Run benches one at a time: the account's concurrency cap returns 429.
