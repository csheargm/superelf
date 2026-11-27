import fs from 'node:fs';
import path from 'node:path';
import { validatePreapprovedTypes } from './actions.mjs';
import { baseUrlOk } from './webutil.mjs'; // the ONE base-URL gate (R3)
import { TIME_RE } from './schedule.mjs';   // the ONE HH:MM shape (R3)
import { FAST_ARGS_DEFAULT, oneShotArgsSetting, oneShotModelSetting, settingsClashWarnings } from './one-shot.mjs';
import { CLAUDE_TOKEN_FILENAME } from './claude-token.mjs';
import { modelReviewSetting } from './model-review-config.mjs';
import { offlineSettings } from './offline.mjs';
import { localOriginSetting } from './local-origin.mjs';
import { PHONE_FIRST_RULE } from './app-phone-check.mjs';   // the ONE phone-first rule (R3)

// Multi-LLM assessment ("Verify · 校验") summarizer system prompt — the SINGLE source (R3).
// See docs/design/multi-llm-assessment.md §4. Overridable via config.system_prompts.assess.
const ASSESS_SUMMARY_PROMPT =
  'You are comparing answers from multiple AI models to the same question. You receive the ' +
  'question, each model\'s answer labeled by model name, and a list of models that failed to ' +
  'respond. Produce, concisely: (1) **Consensus 共识** — points at least two models independently ' +
  'agree on; (2) **Discrepancies 分歧** — where answers conflict, quoting which model says what; ' +
  '(3) **Single-source 单一来源** — claims made by only one model, flagged as unverified; ' +
  '(4) **Confidence note 置信说明** — one line, and it MUST begin by stating participation, e.g. ' +
  '"3 of 4 models responded; GPT timed out." Never treat a missing model as agreeing. If fewer ' +
  'than two models responded, say the cross-check is inconclusive instead of inventing consensus. ' +
  'Do not pick a winner. Follow the language/style directive appended below, if any. For health ' +
  'topics, add one line noting this is a cross-check of AI answers, not medical advice · 非医疗建议.';

// ── Fast-lane honesty guard — the SINGLE source (R3), with ONE parameterized clause ────────
// Fast-lane (Ollama) models have NO tools: they cannot edit files or act. This system message
// keeps them honest so they never falsely promise to "edit your code".
//
// SURFACE-AWARE CLOSING ADVICE. The one shipped copy used to end with "you cannot do that in
// fast mode, switch the model selector to 'Claude'" — vocabulary from ONE surface. A model
// chooser exists only in the mini-app chat component (web/chat-ui.inline.html's `.pac-model`
// pill, populated by the shell's prefs push); the shell's own main chat has no chooser at all,
// so that sentence sent the user hunting for a control that is not on their screen. Only the
// closing advice differs — the honest half ("I have no tools and cannot edit files or act") is
// byte-identical on both surfaces, so the prompt is NOT forked, only this clause is.
// web.mjs picks the surface from `app` (set = a mini-app chat, absent = the shell's main chat).
const FAST_LANE_GUARD_HEAD =
  'You are a fast text assistant. You have NO tools: you cannot edit files, run code, browse, ' +
  'or take any action — you can only discuss and answer in text. If the user asks you to change ' +
  'the app, modify code, or perform an action, tell them plainly that you cannot do it because ' +
  'you have no tools, ';
export const FAST_LANE_ADVICE = {
  // NOT "switch the model selector to Claude": an app's Claude is confined and writes nothing either (lib/agent-origin.mjs), so
  // that sent people to a lane that also cannot change the app. The real way rides in noChangeRule (lib/app-chat-honesty.mjs).
  app: 'and that no model in this app\'s chat can change the app — the real way is given below. ',
  // The shell's main chat: NO chooser exists here. Never invent a control — name who can act.
  shell: 'and that only the Claude agent, which does have tools, can make that change. ',
};
const FAST_LANE_GUARD_TAIL =
  'Otherwise answer directly and concisely. Prefer short bullet lists and headings over tables ' +
  '(they read better on a phone); if you do use a markdown table, keep each row on a single line.';
// surface: 'app' | 'shell'. Anything else falls back to 'shell' — the conservative side, because
// it is the wording that never points at a control that might not exist.
export const fastLaneGuard = (surface) =>
  FAST_LANE_GUARD_HEAD + (FAST_LANE_ADVICE[surface] || FAST_LANE_ADVICE.shell) + FAST_LANE_GUARD_TAIL;
// Advanced settings shows ONE text as "the default" in the override box, so one surface has to
// stand for both: 'app' is the surface a user actually meets a fast lane on (fast lanes are
// picked from the mini-app chooser; the shell's main chat runs the agent).
export const GUARD_DEFAULT_SURFACE = 'app';

// ── What the agent can actually DO here · 本节点的真实能力 ────────────────────────────────
// Server-owned and NOT overridable, unlike the guard prompt above. Two reasons it lives here
// rather than in a workspace CLAUDE.md:
//   1. A workspace is copied from the template ONCE, at provisioning, and never updated again —
//      the provisioning gate is `!existsSync(workspace)`. Every capability documented there is
//      therefore stale in every existing workspace the moment it changes. This is read from the
//      running server on every turn, so it cannot drift.
//   2. A capability list a profile override could delete is not a capability list anyone can
//      rely on. Personality is the user's to change; what the machine can do is not.
//
// SCAR: a family member's weather app answered "I need permission to run the websearch tool".
// The workspace file told every user to shell out to `node ../tools/websearch.mjs`, which a
// member's confined lane can neither approve nor reach, and nothing told the model that asking
// for permission is a dead end because no approver exists.
const AGENT_CONFINED_NOTE =
  'You are running in a confined lane: you cannot run Bash, and you cannot read or write anything '
  + 'outside this workspace. Nobody is watching for a permission prompt, so never ask for one and '
  + 'never say you need permission — it reaches no one and the person just sees a broken app. '
  + 'If something is genuinely out of reach, say in one sentence what you could not do, then give '
  + 'the best answer you can from what you do have.';

// ── Which language to answer in · 用哪种语言回答 ─────────────────────────────────────────
// MEASURED, not guessed: the same English question asked as a member came back in Chinese 2 runs
// out of 3, and as the owner 0 out of 2. Nothing in either prompt chain was Chinese. The
// difference was how much steering each workspace's CLAUDE.md carried — the owner's is ~8.7k
// characters with a strong voice, a new member's is the ~3k template with no language rule at
// all — and with weak steering the model drifts toward the language of the product's own
// bilingual chrome. A household where one person writes English and another writes Chinese
// cannot depend on that.
//
// It lives here, once, and is sent on EVERY lane outside the overridable prompt chain: a family
// member should not have to know what a system prompt is to be answered in their own language.
export const REPLY_LANGUAGE_RULE =
  'Answer in the language the person wrote to you in: English in, English out; 中文 进，中文 出. '
  + 'Do not switch languages mid-reply, and do not translate your own sentences. A proper noun or '
  + 'a technical term may stay in the language it is normally written in — that is not a language '
  + 'switch. If a message genuinely mixes both, follow whichever the person used for their actual '
  + 'question.';

// ── The app contract, READ from superelf.md — never copied ──────────────────────────────
// superelf.md is the single source, and clause (a) already says every app mounts PAChat at
// <!--PA_CHAT_UI-->; test/app-contract.test.mjs enforces it against every app on disk. Two
// hand-written copies of that used to live here. That meant a future edit to the contract would
// have had to be made in two places — and the copy nobody remembered to edit becomes a lie the
// agent is told with full confidence. Same failure as the stale workspace CLAUDE.md, one layer in.
//
// A confined agent CANNOT read superelf.md: it sits at the repo root, outside every workspace. So
// the text has to travel in the system prompt. It travels by being READ from the file, not by
// being restated — change superelf.md and the next boot says the new thing, with no other edit.
let _contract = null;

// Slice a "## Heading" section out by index rather than by regex: `$` under the /m flag matches
// end-of-LINE, so the obvious `^## X[\s\S]*?(?=\n## |$)/m` captures one line and silently
// succeeds. A contract that silently truncates is exactly the failure this whole change exists to
// prevent, so it is sliced explicitly and then checked.
function section(md, heading) {
  const a = md.indexOf(`## ${heading}`);
  if (a < 0) return null;
  const b = md.indexOf('\n## ', a + 1);
  return md.slice(a, b < 0 ? md.length : b).trim();
}

// TODO(R4 seam): appContract + section/subsection move to lib/app-contract.mjs
// A "### Heading" subsection: up to the next ### or ## heading.
function subsection(md, heading) {
  const a = md.indexOf(`### ${heading}`);
  if (a < 0) return null;
  const ends = [md.indexOf('\n### ', a + 1), md.indexOf('\n## ', a + 1)].filter((i) => i >= 0);
  return md.slice(a, ends.length ? Math.min(...ends) : md.length).trim();
}

// Throws rather than returning a blank. A silently empty contract is the worst outcome available:
// every app the household generates from then on quietly loses its Ask-AI surface, and nothing
// anywhere reports it (R5).
// superelf.md build rule 4 holds this mark; the agent receives PHONE_FIRST_RULE in its place.
export const PHONE_RULE_MARK = '{{PHONE_FIRST_RULE}}';
export function appContract(root) {
  if (_contract && _contract.root === root) return _contract.text;
  const md = fs.readFileSync(path.join(root, 'superelf.md'), 'utf8');
  const clauses = section(md, 'The four clauses');
  if (!clauses) throw new Error('superelf.md: "## The four clauses" not found — the app contract cannot reach the agent');
  for (const c of ['**(a)', '**(b)', '**(c)', '**(d)']) {
    if (!clauses.includes(c)) throw new Error(`superelf.md: clause ${c} missing from "The four clauses"`);
  }
  // The WHOLE Broker API section, not just the kinds line: it also carries the failure contract
  // (`{ok:false, code, error, text}` — show `text`) and the render-md field name, both of which
  // an app gets wrong without it. Those are the two that have actually bitten.
  const broker = section(md, 'Broker API — the ONLY way out of the sandbox');
  if (!broker || !broker.includes('Kinds:')) throw new Error('superelf.md: the Broker API section or its "Kinds:" list not found');
  // The build rules (data file = PAStore, `not-found` = first run, no <form>, the self-check) and
  // the PAStore API itself: without them 3 of 4 generated apps never saved (e2e 2026-11-13).
  const rules = section(md, 'App build rules — sent with every agent turn');
  if (!rules || !rules.includes('<form>')) throw new Error('superelf.md: "## App build rules" section not found — the build rules cannot reach the agent');
  if (!rules.includes(PHONE_RULE_MARK)) throw new Error(`superelf.md: build rule ${PHONE_RULE_MARK} missing — the phone-first rule cannot reach the agent`);
  const store = subsection(md, 'PAStore — reading and saving the app\'s own data file');
  if (!store || !store.includes('PAStore.file(')) throw new Error('superelf.md: "### PAStore" not found — the data-file API cannot reach the agent');
  const text = `${clauses}\n\n${rules.replace(PHONE_RULE_MARK, PHONE_FIRST_RULE)}\n\n${store}\n\n${broker}`;
  _contract = { root, text };
  return text;
}

// `contract` is appContract(ROOT), passed in rather than re-read per turn. The two rules defined
// HERE are deliberately NOT in superelf.md: that file says what an APP is, and neither which
// language to answer in nor what this lane may touch is a property of an app. Moving them there
// would be the same duplication pointing the other way.
// langRule: the turn's reply-language line (lib/ui-lang.mjs replyLanguageRule — the member's 中文/English setting).
export const agentCapabilities = (role, contract, langRule = REPLY_LANGUAGE_RULE) =>
  [langRule || REPLY_LANGUAGE_RULE, contract || null, role === 'owner' ? null : AGENT_CONFINED_NOTE]
    .filter(Boolean).join('\n\n');

// The most any OVERRIDABLE prompt piece may carry: the guard override and the app directive, from
// a profile, config.json or the app itself. Applied once, in web.mjs resolveSystemPrompts, so every
// lane gets the same bound — and so nothing a member or an app writes can grow the agent lane's
// prompt far enough to push agentCapabilities past the runner's cap (lib/runner.mjs).
// TODO(R4): this file is over budget — split the prompt texts above (ASSESS_SUMMARY_PROMPT through
// this cap) into lib/prompts.mjs, leaving config loading here.
export const OVERRIDABLE_PROMPT_MAX = 2000;

// The ONE file loadConfig reads — web.mjs watches exactly this path (lib/config-watch.mjs).
export const configPath = (root) => path.join(root, 'config.json');
// readOnly: the same validated config with NOTHING written or created on disk — users resolved in
// memory only (no workspace provisioned, no profile seeded, no generated token or normalized role
// written back to config.json) and no session store. For the config.json watcher (docs/adr/0011),
// whose reload keeps the accounts in memory: a half-finished hand edit of users[] (an owner role
// mistyped mid-save) must never be persisted by a reload nobody asked for.
// Boot and POST /api/admin/reload-config load in full, as before.
export async function loadConfig(root, { readOnly = false } = {}) {
  const p = configPath(root);
  if (!fs.existsSync(p)) {
    throw new Error('config.json not found. Copy config.example.json to config.json, then restart.');
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`config.json is not valid JSON: ${e.message}`);
  }
  const validated = validateConfig(cfg, root);
  const { resolveUsers, writeUsers } = await import('./users.mjs');
  const u = resolveUsers(validated, root, { provision: !readOnly });
  validated.users = u.users; validated.userByToken = u.byToken; validated.userById = u.byId;
  if (u.changed && !readOnly) writeUsers(root, u.users);
  if (!readOnly) {
    const { Sessions } = await import('./auth.mjs');
    validated.sessions = new Sessions(path.join(root, 'sessions.json'));
  }
  validated.auditFile = path.join(root, 'audit.log');
  // Default ON: a self-registered account waits for the owner. A config that sets it keeps its value.
  validated.require_approval = validated.require_approval === undefined ? true : !!validated.require_approval;
  return validated;
}

export function validateConfig(cfg, root) {
  // The Telegram bot's keys (telegram_bot_token, allowed_user_ids, owner_chat_id, schedules,
  // deep_args, users[].telegram_id) were REMOVED 2026-10-12 (docs/adr/0006). An old config.json
  // that still holds them loads fine: nothing reads them (the docs/adr/0004 precedent).
  cfg.claude_cmd = cfg.claude_cmd || 'claude';
  cfg.claude_args = cfg.claude_args || ['--dangerously-skip-permissions'];
  // The long-lived Claude token file (lib/claude-token.mjs, docs/adr/0024): read at every spawn,
  // so a renewed token needs no restart. A relative path is under the node root.
  cfg.claude_token_file = path.resolve(root, typeof cfg.claude_token_file === 'string' && cfg.claude_token_file.trim() ? cfg.claude_token_file.trim() : CLAUDE_TOKEN_FILENAME);
  // ── The member lane: what a NON-OWNER's agent may touch ──────────────────────────────────
  // The confinement: no bypass on argv (the flag, or `--permission-mode bypassPermissions`), and a
  // mode pinned ahead of the operator's args (lib/agent-origin.mjs laneArgs). Measured 2026-09-11:
  //   skip-permissions + --add-dir <own workspace>  → read a file OUTSIDE it. NO boundary.
  //   --permission-mode acceptEdits (no skip)       → outside read DENIED, outside `cat` through
  //                                                   Bash DENIED, inside write SUCCEEDED.
  // `--add-dir` is deliberately NOT used: it only ADDS directories to the allowed set, so
  // pointing it at the cwd is a no-op that would imply a guarantee it does not provide. The
  // backlog's option (a) was written around it and is unsound for exactly that reason.
  // acceptEdits rather than `default`: `default` also denied writes INSIDE the workspace, which
  // would leave a family member unable to build their own app at all.
  // RE-MEASURED 2026-10-11: acceptEdits honours the machine's Bash allow rules, so every confined
  // lane also gets `--disallowedTools Bash` (lib/agent-origin.mjs laneArgs, with the table).
  // TODO(R4): this file is over budget — the lane defaults (claude/member/fast args,
  // chat_models and the model-check / model_review keys) are the seam to split into their own module,
  // beside lib/one-shot.mjs. The "must be an ollama lane" checks (health_llm, research.llm,
  // vision_default) go with them, as one.
  // --strict-mcp-config with no --mcp-config: a confined turn loads NO MCP server — without it a
  // member's lane could use the host account's Gmail/Calendar/Drive connectors (F4-1, 2026-11-22).
  cfg.member_args = cfg.member_args || ['--permission-mode', 'acceptEdits', '--strict-mcp-config'];
  // Haiku with thinking off (lib/one-shot.mjs: the background asks — /api/ask, the job resolver).
  cfg.fast_args = cfg.fast_args || [...FAST_ARGS_DEFAULT];
  cfg.one_shot_args = oneShotArgsSetting(cfg);
  for (const w of settingsClashWarnings(cfg)) console.warn(w);   // after every lane's args are set
  // Models offered in the chat composer's chooser. provider 'claude' runs the CLI
  // (agent + tools); provider 'ollama' calls the Ollama cloud (fast, no tools — some do
  // vision). Add/swap here — never hardcode model names in the UI or routing.
  // First entry is the DEFAULT. DeepSeek is the fast default (quick + honest per the A/B
  // benchmark); glm-5.3-flash is the fast vision model (see vision_default). Deep = slower
  // reasoning models for depth; Agent = Claude / GPT-Codex (tools, edit the app).
  // 2026-10-12: Ollama retired deepseek-v4-flash:0731 and qwen3.5:397b (HTTP 410, 2026-09-25).
  // The `deepseek` id is KEPT (profiles store it in appModels) and points at its successor;
  // qwen had none in the catalog, so its slot is DeepSeek Pro. Measured with the app's own
  // request: v4.1-flash 0.7-1.0 s to first text, v4-pro 1.2 s. The scheduled model-check job
  // (lib/model-health.mjs) now catches the next retirement instead of a user.
  cfg.chat_models = cfg.chat_models || [
    { id: 'deepseek', label: 'DeepSeek · 中文', group: 'Fast', provider: 'ollama', model: 'deepseek-v4.1-flash:cloud' },
    { id: 'mistral',  label: 'Mistral',        group: 'Fast', provider: 'ollama', model: 'mistral-large-3:675b:cloud' },
    { id: 'glmflash', label: 'GLM Flash',      group: 'Fast', provider: 'ollama', model: 'glm-5.3-flash:cloud' },
    { id: 'glm',      label: 'GLM',            group: 'Deep', provider: 'ollama', model: 'glm-5.3:cloud' },
    { id: 'kimi',     label: 'Kimi',           group: 'Deep', provider: 'ollama', model: 'kimi-k3:cloud' },
    { id: 'deepseekpro', label: 'DeepSeek Pro', group: 'Deep', provider: 'ollama', model: 'deepseek-v4-pro:0813-cloud' },
    { id: 'claude',   label: 'Claude',         group: 'Agent', provider: 'claude', model: null },
    { id: 'gpt',      label: 'GPT (Codex)',    group: 'Agent', provider: 'codex',  model: null },
  ];
  cfg.ollama_url = cfg.ollama_url || 'http://localhost:11434';
  // The model-check job (web.mjs JOBS): daily HH:MM, and the cloud catalog it lists new models
  // from ('' = do not read it). Both read at each tick, so a config reload applies them.
  cfg.model_check_time = cfg.model_check_time || '06:00';
  if (!TIME_RE.test(cfg.model_check_time)) throw new Error(`model_check_time: not HH:MM: "${cfg.model_check_time}"`);
  cfg.ollama_catalog_url = cfg.ollama_catalog_url ?? 'https://ollama.com/api/tags';
  if (cfg.ollama_catalog_url && !baseUrlOk(cfg.ollama_catalog_url)) throw new Error(`ollama_catalog_url: not an http(s) URL (no query/fragment/credentials): "${cfg.ollama_catalog_url}"`);
  cfg.model_review = modelReviewSetting(cfg);   // the weekly model review (docs/adr/0017); defaults + checks live there
  // The Ollama lane that sees an uploaded image when the chosen fast lane cannot (web.mjs
  // PA_CHAT_LANE), and that reads a meal photo (web.mjs mealVision). It must be an OLLAMA lane,
  // refused at load below, once chat_models is final:
  //   · Codex: `--sandbox read-only` stops writes, not reads, so it could hand a confined turn's
  //     caller config.json (R13 review, 2026-10-12; web.mjs "CONFINED TURNS NEVER REACH CODEX").
  //   · Claude: not needed here. Choosing Claude sends an image to the agent lane, and so does a
  //     vision lane that is no longer served. Meal photos speak the Ollama API only.
  //   · Research: it never looks at an attachment, so it would answer about a picture it never saw.
  // An id not in chat_models stays loadable: a node with no vision lane (a fast lane keeps the
  // turn; a meal photo is stored unanalysed). test/meals-ui.test.mjs boots exactly that.
  cfg.vision_default = cfg.vision_default || 'glmflash';   // glm-5.3-flash: ~1.5s vs Claude ~14s at equal accuracy on screenshots
  // Single source of the DEFAULT fast-lane system prompts (R3). `global` is the honesty
  // guard sent on every fast-lane (Ollama) turn; `apps` holds per-app directives keyed by app
  // slug. A user can OVERRIDE any of these from Advanced settings — overrides live in their
  // profile (server-stored, syncs across devices) and take precedence in web.mjs chat(). The
  // per-app HTML files still hardcode the same directive as a last-resort fallback (used only
  // when neither config nor profile has one).
  //
  // `global` / `ollama_system` now hold ONLY what the OPERATOR configured, and stay null when
  // nothing was configured. Baking the built-in text in here would freeze ONE surface's closing
  // advice for both surfaces; leaving the slot empty lets web.mjs resolveSystemPrompts() call
  // fastLaneGuard(surface) per turn. The PRECEDENCE is unchanged either way:
  //   profile systemPrompts.global  →  this configured value  →  fastLaneGuard(surface)
  const configured = (v) => (typeof v === 'string' && v.trim() ? v : null);
  const guardOverride = configured(cfg.system_prompts && cfg.system_prompts.global) || configured(cfg.ollama_system);
  cfg.system_prompts = cfg.system_prompts || {};
  cfg.system_prompts.global = guardOverride;
  cfg.system_prompts.apps = cfg.system_prompts.apps || {
    bible: '请用中文回答，关键术语保留英文（如 grace 恩典、faith 信心、covenant 圣约），简明扼要。Always reply in Chinese, keeping key scriptural/technical terms in English; be concise.',
  };
  cfg.ollama_system = cfg.system_prompts.global; // legacy alias — same three-state (null = "not configured")
  cfg.task_timeout_minutes = Number(cfg.task_timeout_minutes) || 30;
  // Multi-LLM assessment ("Verify · 校验") — docs/design/multi-llm-assessment.md.
  // Panel default: the top Deep model + every agent lane (claude + codex) from chat_models.
  const assessAgents = cfg.chat_models.filter((m) => m.provider === 'claude' || m.provider === 'codex').map((m) => m.id);
  const assessTopDeep = cfg.chat_models.find((m) => m.group === 'Deep');
  cfg.assess_models = cfg.assess_models || [...(assessTopDeep ? [assessTopDeep.id] : []), ...assessAgents];
  const chatIds = new Set(cfg.chat_models.map((m) => m.id));
  for (const id of cfg.assess_models) {
    if (!chatIds.has(id)) throw new Error(`assess_models: unknown model id "${id}" — not in chat_models (${[...chatIds].join(', ')})`);
  }
  // Summarizer = a FAST haiku-class tier. runClaude pins models via the claude CLI's
  // --model flag (the cfg.fast_args precedent above), so this is the --model VALUE the
  // CLI accepts ('haiku'), not a chat_models id.
  cfg.assess_summarizer = cfg.assess_summarizer || 'haiku';
  cfg.assess_timeout_minutes = Number(cfg.assess_timeout_minutes) || cfg.task_timeout_minutes; // per panel model
  cfg.system_prompts.assess = cfg.system_prompts.assess || ASSESS_SUMMARY_PROMPT;
  // Public base URL（对外基址）for links handed to OTHER devices — today the
  // health-setup QR (web.mjs /api/health/setup). Empty (default) = derive
  // from the request's Host header; when SET it WINS, because a profile
  // opened via localhost otherwise encodes an ingest URL the phone cannot
  // reach (the QR-ingest scar) — set it to e.g. the Tailscale hostname,
  // "http://mybook.tailnet-name.ts.net:8787". Invalid → refuse to load
  // (the health_llm precedent); trailing slashes normalized away here so
  // every consumer can append paths blindly.
  if (cfg.public_base_url) {
    if (!baseUrlOk(cfg.public_base_url)) throw new Error(`public_base_url: not a valid http(s) base URL (no query/fragment/credentials): "${cfg.public_base_url}"`);
    cfg.public_base_url = String(cfg.public_base_url).trim().replace(/\/+$/, '');
  } else cfg.public_base_url = '';
  // The home node's own name for the offline fallback (lib/local-origin.mjs): read at use time by the CORS gate and /api/offline-config.
  cfg.local_origin = localOriginSetting(cfg.local_origin);
  // daily_brief_time / calendar_ics / gmail_user / gmail_app_password belonged to the daily
  // brief, REMOVED 2026-10-11 (docs/adr/0004). An existing config.json that still holds them
  // loads fine: nothing reads them, and the admin view lists only CONFIG_FIELDS.
  // Health analysis thresholds (docs/design/ios-health-ingestion.md §3) — the flags the
  // weekly 健康简报 fires on. Config-overridable per install;
  // defaults are deliberately conservative lifestyle floors, not medical targets.
  cfg.health_thresholds = {
    steps_min_daily: 5000,      // 7-day avg steps/day below this → flag
    sleep_min_minutes: 360,     // 7-day avg sleep (6 h/night) below this → flag
    weight_delta_kg_7d: 1.5,    // |change| across the last 7 days above this → flag
    ...(cfg.health_thresholds || {}),
  };
  // Health digest LLM lane (docs/design/ios-health-ingestion.md §3): health_llm
  // names the chat_models id (provider 'ollama' — the digest speaks the ollama
  // API) that phrases the weekly 健康简报. Default: the FIRST ollama entry.
  // NOTE the default ollama entries are *-cloud models (Ollama cloud), so only
  // computed AGGREGATES ever reach the lane (never raw samples) and the digest
  // footer names it; point health_llm at a local ollama model for fully
  // on-device analysis.
  if (cfg.health_llm !== undefined) {
    const lane = cfg.chat_models.find((m) => m.id === cfg.health_llm);
    if (!lane) throw new Error(`health_llm: unknown model id "${cfg.health_llm}" — not in chat_models (${cfg.chat_models.map((m) => m.id).join(', ')})`);
    if (lane.provider !== 'ollama') throw new Error(`health_llm: lane "${cfg.health_llm}" is provider "${lane.provider}" — must be an ollama lane`);
  } else {
    cfg.health_llm = (cfg.chat_models.find((m) => m.provider === 'ollama') || {}).id;
  }
  // Web-grounded research lane ("Research · 联网研究") — lib/research.mjs: Tavily finds →
  // Firecrawl reads → a fast lane reasons over ONLY the fetched excerpts. The lane is
  // OFFERED only when a Tavily key is configured — the chooser is config-driven, so a
  // missing key simply hides it (no UI code involved). Key VALUES are never logged or
  // echoed anywhere; this is an existence check only.
  cfg.researchEnabled = !!(cfg.tavily_key && !/PASTE/.test(cfg.tavily_key));
  if (cfg.researchEnabled && !cfg.chat_models.some((m) => m.provider === 'research' || m.id === 'research')) {
    cfg.chat_models.push({ id: 'research', label: 'Research · 联网研究', group: 'Research', provider: 'research', model: null });
  }
  cfg.research = {
    max_results: 5,           // Tavily results requested (basic depth)
    read_top: 3,              // top result URLs handed to Firecrawl
    excerpt_bytes: 6000,      // per-source markdown cap fed to the model (~6KB)
    search_timeout_ms: 15000,
    scrape_timeout_ms: 20000, // per URL; scrapes run in parallel
    tavily_url: 'https://api.tavily.com/search',
    firecrawl_url: 'https://api.firecrawl.dev/v2/scrape',
    ...(cfg.research || {}),
  };
  // research.llm names the chat_models id (provider 'ollama') that reasons over the
  // excerpts — same contract and default as health_llm above.
  if (cfg.research.llm !== undefined) {
    const lane = cfg.chat_models.find((m) => m.id === cfg.research.llm);
    if (!lane) throw new Error(`research.llm: unknown model id "${cfg.research.llm}" — not in chat_models (${cfg.chat_models.map((m) => m.id).join(', ')})`);
    if (lane.provider !== 'ollama') throw new Error(`research.llm: lane "${cfg.research.llm}" is provider "${lane.provider}" — must be an ollama lane`);
  } else {
    cfg.research.llm = (cfg.chat_models.find((m) => m.provider === 'ollama') || {}).id;
  }
  // The automatic research after a summary (lib/summary-followup.mjs, ADR 0027): one deadline per to-do
  // item, research and suggestion alike; the lib's default when unset.
  cfg.summary_followup_item_timeout_ms = Number(cfg.summary_followup_item_timeout_ms) || 90000;
  // The offline bundle (docs/plans/offline-first.md): the app pages prefetched and the Bible byte cap.
  cfg.offline = offlineSettings(cfg.offline);
  // Here, not beside chat_models: only now is the list complete ("research" with a Tavily key).
  cfg.one_shot_model = oneShotModelSetting(cfg);   // read per request (web.mjs chat)
  // vision_default: an Ollama lane or none (see its default above). Checked here for the same reason.
  const visionLane = cfg.chat_models.find((m) => m.id === cfg.vision_default);
  if (visionLane && visionLane.provider !== 'ollama') throw new Error(`vision_default: lane "${cfg.vision_default}" is provider "${visionLane.provider}" — must be an ollama lane`);
  // Email channel（邮件通道）— AgentMail (PLAN.md Phase B, lib/agentmail.mjs).
  // Enabled by key EXISTENCE only (the researchEnabled precedent above): key
  // values are never logged or echoed. `agentmail` shapes the node's ONE inbox
  // (created on first use, persisted in <root>/agentmail.json): client_id tags
  // it for adopt-on-restore; username/domain are optional — omitted, AgentMail
  // generates a unique address (no name-collision failure on first run).
  cfg.agentmailEnabled = !!(cfg.agentmail_key && !/PASTE/.test(cfg.agentmail_key));
  cfg.agentmail = { client_id: 'superelf-node', display_name: 'superelf 管家', ...(cfg.agentmail || {}) };
  // Standing pre-approval classes（预批准）— action types that execute without
  // asking. Validated HERE so a config naming an unknown or outward-facing type
  // refuses to load (enforced in code, not convention — lib/actions.mjs).
  cfg.preapproved_action_types = validatePreapprovedTypes(cfg.preapproved_action_types);
  if (!cfg.projects || !Object.keys(cfg.projects).length) throw new Error('config.projects must define at least one project.');
  for (const [name, proj] of Object.entries(cfg.projects)) {
    if (!proj.dir) throw new Error(`project "${name}" has no dir`);
    proj.rel = proj.dir;
    proj.dir = path.isAbsolute(proj.dir) ? proj.dir : path.join(root, proj.dir);
    if (!fs.existsSync(proj.dir)) {
      // Not fatal: a project may exist on another machine (e.g. a Mac path
      // while running on the MateBook). Warn so the user notices.
      console.warn(`[config] warning: project "${name}" dir does not exist here: ${proj.dir}`);
    }
  }
  if (!cfg.projects[cfg.default_project]) {
    throw new Error(`default_project "${cfg.default_project}" is not in projects (${Object.keys(cfg.projects).join(', ')}).`);
  }
  return cfg;
}
