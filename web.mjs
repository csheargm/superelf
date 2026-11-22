#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { demoOn, limitAudit, makeDiskMeter, makeQuotaStore, DEMO_QUOTA_FILE } from './lib/demo-quota.mjs';
import { makeDemoUsers } from './lib/demo.mjs';
import { injectDemoBoot } from './lib/demo-boot.mjs';
import { makeSigninGate, authConfig } from './lib/demo-auth.mjs';
import { makeDemoRoutes } from './lib/demo-routes.mjs';
import { loadConfig, configPath, fastLaneGuard, GUARD_DEFAULT_SURFACE, agentCapabilities, appContract, REPLY_LANGUAGE_RULE, OVERRIDABLE_PROMPT_MAX } from './lib/config.mjs';
import { runClaude, killChild } from './lib/runner.mjs';
import { watchConfig } from './lib/config-watch.mjs';
import { oneShotBaseArgs, oneShotModel, yieldSettings } from './lib/one-shot.mjs';
import { safeJoin, slugOk, tokenOk, dataContentType, readBody, writeFileAtomic, renameWithRetry, decodeBase64Strict, bodyErrorResponse, BODY_LIMITS } from './lib/webutil.mjs';
import { createConvoLocks, withConvoTurn, QUEUED_TURN_TEXT } from './lib/convo-lock.mjs';
import { readJsonState, readJsonForUpdate, FILE_OK, FILE_ABSENT, FILE_UNREADABLE, FILE_UNREADABLE_CODE } from './lib/readjson.mjs';
// Every readBody call below states its cap explicitly from BODY_LIMITS (R3,
// lib/webutil.mjs) — readBody has no default any more. DATA-LOSS SCAR,
// 2026-09-02: app data (handwriting notebooks!) inherited the 64KB default,
// five real notes hit it, one lost a page of Apple Pencil strokes.
import { saveAppData, restoreAppData, appDataFile, noLinkOnTheWay, APP_DATA_DIR, UPLOADS_DIR } from './lib/appdata.mjs';
import { loadProfile, loadProfileForUpdate, saveProfile, ageFromYear, sanitizeHealthThresholds, effectiveHealthThresholds, emailOk } from './lib/users.mjs';
import { promote, rollback, unshare, listShared, fork, copyNoLinks, LINKED_SOURCE, FORK_REFUSED } from './lib/sharedapps.mjs';
import { getChapter, searchBible, BIBLE_DATA_DIR } from './lib/bible.mjs';
import { listBriefings, getBriefing, saveBriefing, pruneBriefings, pendingActions, runJob } from './lib/autonomy.mjs';
import { settleProposals, annotateBriefing, expireStaleActions, sweepStrandedApprovals, isFlagSuppressed, recordReminderRetirement } from './lib/actions.mjs';
import { decideAction, withUserLock } from './lib/decide.mjs';
import { remindersTick, loadReminders, removeReminder } from './lib/reminders.mjs';
import { ingestHealth, recentHealth, monthlyRollups, MAX_BODY_BYTES } from './lib/health.mjs';
import { archiveOverflow, CONVO_MAX_MESSAGES } from './lib/convo-archive.mjs';
import { ingestMealPhoto, recentMeals, MEAL_MAX_BODY_BYTES } from './lib/meals.mjs';
import { healthBriefBody } from './lib/health-analyze.mjs';
import { localDateStr } from './lib/schedule.mjs';
import { jobsTick, readJobRuns, recordJobRun } from './lib/jobruns.mjs';
import { jobsView, readAuditTail, humanSchedule } from './lib/jobstatus.mjs';
import { adminConfigView, applyConfigWrite } from './lib/adminconfig.mjs';
import { runCodex } from './lib/codex.mjs';
import { laneRunner } from './lib/model-review-agent.mjs';
import { appOriginated, agentConfined, convoTag, convoReachable, laneArgs } from './lib/agent-origin.mjs';
import { runAssessment, pickPanel } from './lib/assess.mjs';
import { runResearch } from './lib/research.mjs';
import { MODEL_HEALTH_FILENAME, ollamaHttpError, modelHealthFor, runModelCheck } from './lib/model-health.mjs';
import { CLAUDE_AUTH_FILENAME, claudeAuthFor, checkClaudeAuth, mergeBriefs, isAuthFailure, CLAUDE_SIGNIN_EXPIRED, MODEL_CHECK_ERROR_PREFIX } from './lib/claude-auth.mjs';
import { claudeToken } from './lib/claude-token.mjs';
import { runCodexLane, codexFallback } from './lib/lane-codex.mjs';
import { modelReviewJobs } from './lib/model-review.mjs';
// (listFamilyApps defined below near listApps)
import { hashPassword, verifyPassword, makeAudit, readAudit } from './lib/auth.mjs';
import { notifyBriefingEmail } from './lib/notify.mjs';
import { readShell } from './lib/shellhtml.mjs';
import { makeBuildId, BUILD_MARKER } from './lib/buildid.mjs';
import { SW_PATH, OFFLINE_CONFIG_PATH, bibleIndex, withCspMeta, APP_CSP } from './lib/offline.mjs';
import { corsHeaders } from './lib/local-origin.mjs';
import { loadJobs as loadJobFiles, saveJob, deleteJob, validateJob } from './lib/jobs/store.mjs';
import { readJobPrefs, setJobEnabled, applyJobPrefs, heldOff, builtinsFor } from './lib/jobs/prefs.mjs';
import { RESERVED_IDS, idOkSlug, needsSetup as ownerNeedsSetup, validateOwner, applyOwnerSetup, nodeOwnerId, passwordError } from './lib/owner.mjs';
// Login hardening (lib/login-guard.mjs, lib/setup-code.mjs, lib/bind.mjs). TODO(R4 seam): the public auth
// routes (/api/setup, /api/login, /api/register, /api/logout) belong in one lib/auth-routes.mjs.
import { createLoginGuard, clientKey, lockedMessage } from './lib/login-guard.mjs';
import { ensureSetupCode, setupCodeOk, consumeSetupCode } from './lib/setup-code.mjs';
import { bindHostFor } from './lib/bind.mjs';
import { webSearch } from './tools/websearch.mjs';
import { makeRunner, attachRunner } from './lib/jobs/run.mjs';
import { resolvePrompt } from './lib/jobs/resolve.mjs';
import { looksLikeJob } from './lib/jobs/intent.mjs';
import { manifests as toolManifests, runnableTools } from './lib/jobs/tools.mjs';
import { AgentMail } from './lib/agentmail.mjs';
import { execSync, execFileSync } from 'node:child_process';
import { appNotesJson, embedInTemplateLiteral, classifySubjects } from './lib/vernotes.mjs';
import { autoSince } from './lib/version-auto.mjs';
import { htmlToText } from './lib/note-index.mjs';
import { searchIndexed, ensureIndexed, scheduleReindex, NOTE_INDEX_FAILED, INDEX_FAILED } from './lib/note-search.mjs';
import { noteTextRecords, parseFields } from './lib/note-text.mjs';
import { noteOcrState, startOcrWorker, NOTE_OCR_FAILED } from './lib/note-ocr-queue.mjs';
import { OCR_FAILED } from './lib/note-ocr.mjs';
import { pageImageFile, IMG_BAD_PATH, IMG_NOT_FOUND } from './lib/note-page-image.mjs';
import { buildFollowup, followupDeps } from './lib/summary-followup.mjs';
import { writerClaudeBase, writerLaneMs } from './lib/research-writer.mjs';
import { snapshotApps, appBuildWarnings } from './lib/app-postcheck.mjs';
import { isBlankAnswer, laneFailureText, shouldFallBackToAgent, fallbackStatusText, chatTurnLogLine } from './lib/chat-outcome.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

// A free-form Bible note is keyed free-<epoch>; its title shows that time so several notes on
// one chapter are distinguishable (they all listed as the same placeholder before). Treating
// LEGACY_NEW_NOTE as unset on READ retitles existing notes with no data migration, while an
// explicit rename still wins.
export const LEGACY_NEW_NOTE = 'New Note';
export const NEW_NOTE_LABEL = 'New Note 新笔记';   // default name for an unnamed free-form note
// Apple-Notes titling: a note names itself by its first line. Used for FREE-FORM notes only —
// a verse annotation keeps its reference ("John 3:3"), which is its identity in the list.
export const firstLineTitle = (data, k, max = 40) => {
  const plain = String((data.notes || {})[k] || '').trim();
  const html = (((((data.draws || {})[k] || {}).pages || [])[0] || {}).pageHtml) || '';
  const fromHtml = htmlToText(html);                           // the ONE HTML→text rule (lib/note-index.mjs, R3)
  const src = plain || fromHtml;
  const line = src.split('\n').map((x) => x.trim()).find(Boolean) || '';
  return line.slice(0, max);
};

export const freeStamp = (k, now = new Date()) => {
  const m = /^free-(\d{10,})$/.exec(String(k || ''));
  if (!m) return '';
  const d = new Date(Number(m[1]));
  if (!Number.isFinite(d.getTime())) return '';                  // unparseable epoch: no stamp, never a bogus date
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? ` · ${hhmm}` : ` · ${d.getMonth() + 1}/${d.getDate()} ${hhmm}`;
};
// Read per request (like index.html itself) so a version bump shows without a restart.
// …plus the build id (lib/buildid.mjs), because the version alone did not change across the fixes it shipped.
// …and '+N' merges since the newest tag (lib/version-auto.mjs, the SAME N the Release Notes sheet shows).
const plusN = () => { const n = autoSince(ROOT, buildId.head()).n; return n ? '+' + n : ''; };
const appVersion = () => { try { const b = buildId(); return 'v' + JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version + plusN() + (b ? ' · ' + b : ''); } catch { return ''; } };
const appHash = (dir) => { try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, 'index.html'))).digest('hex').slice(0, 12); } catch { return null; } };
// ── Committing the shelf · 把 shelf 提交进 git ─────────────────────────────────────────────
// shared-apps/ is tracked as of v3.5.0, so a promote/rollback/unshare leaves the repo dirty until
// someone remembers to commit. That drift is what the tracking was meant to remove, so the shelf
// commits itself.
//
// TWO RULES, both learned the hard way on this machine.
//
// 1. PATHSPEC ONLY. `git commit -- <path>` commits the content of those paths and IGNORES THE
//    INDEX, so whatever else is staged or in flight stays untouched. Someone is usually editing
//    in this working tree — sweeping their half-finished work into a release commit would be far
//    worse than not committing at all.
// 2. NEVER FAIL THE OPERATION. The files ARE the promote; the commit is bookkeeping. No git, no
//    repo, a hook that rejects, a detached HEAD — all of it is audited and swallowed. An app that
//    is on the shelf but not yet committed is a correct, recoverable state; a promote that threw
//    after writing the files is not.
//
// It does NOT push. Pushing is outward-facing and belongs to a person, not to a settings click.
const GIT_TIMEOUT_MS = 10000;
function commitShelf(slug, message) {
  const rel = `shared-apps/${slug}`;
  const git = (args) => execFileSync('git', args,
    { cwd: ROOT, timeout: GIT_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git(['add', '-A', '--', rel]);          // -A so an unshare stages the deletion too
    git(['commit', '-m', message, '--', rel]);
    audit('shelf-commit', { slug });
    return { ok: true };
  } catch (e) {
    const out = `${(e && e.stdout) || ''}${(e && e.stderr) || ''}`.trim();
    // Identical bytes: the shelf already matched the repo. That is success, not a failure.
    if (/nothing to commit|no changes added|nothing added/i.test(out)) return { ok: true, noop: true };
    audit('shelf-commit-failed', { slug, error: out.slice(0, 200) || String((e && e.message) || e) });
    return { ok: false };
  }
}

// stdio stderr:'ignore' is load-bearing, not tidiness. execSync pipes stdout but INHERITS stderr
// by default, so in a checkout with no .git (anyone who installed from a downloaded ZIP) git
// printed "fatal: not a git repository" onto the parent's stderr. The catch below handled the
// failure fine — but on Windows the supervisor runs node under PowerShell, which promotes ANY
// native stderr to a NativeCommandError, and with ErrorActionPreference=Stop that killed run.ps1
// and the node with it. The server bound its port, logged it, and vanished seconds later.
const GIT_QUIET = { stdio: ['ignore', 'pipe', 'ignore'] };
const gitHead = () => { try { return execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8', ...GIT_QUIET }).trim(); } catch { return null; } };
const buildId = makeBuildId(ROOT, gitHead);
const GIT_REF_RE = /^[0-9a-f]{7,40}$/;
const bumpPatch = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || ''); return m ? `${m[1]}.${m[2]}.${+m[3] + 1}` : '1.0.0'; };
// Release notes: curated version-notes.json merged with git history, cached in
// lib/vernotes (key = package.json version + notes-file mtime), so edits and
// new tags show without a restart while git runs only on cache misses.
const cfg = await loadConfig(ROOT);
// The Claude token file is named from the LIVE cfg at every spawn (lib/claude-token.mjs, docs/adr/0011).
claudeToken.setFile(() => cfg.claude_token_file);
const PORT = cfg.web_port || 8787;
const BIND_HOST = bindHostFor(cfg, demoOn(cfg));   // read at start, like PORT (lib/bind.mjs)
const loginGuard = createLoginGuard();
let setupBusy = false;   // POST /api/setup in progress: a second one is refused (no two owners)
const SHARED = path.join(ROOT, 'shared-apps');

// Briefing email channel（邮件通道，Phase B）: the node's ONE AgentMail client — the only push
// channel since the Telegram bot was removed (docs/adr/0006). null when no key is configured;
// delivery is then skipped inside notifyBriefingEmail (email is optional; the app always has it).
const MAIL = cfg.agentmailEnabled ? new AgentMail(cfg.agentmail_key, { root: ROOT, settings: cfg.agentmail }) : null;
// Email a just-saved briefing to its member's briefingEmail (per-profile — PUT /api/profile).
// The notifier never rejects (it catches + audits internally — a delivery failure must not fail
// the job, re-fire the tick, or lose the already-saved briefing); the .catch guards an
// unexpected notify bug so it can never surface as an unhandled rejection, and still audits
// it (R5).
const pushBriefing = async (u, briefing) => {
  const prof = loadProfile(wsDir(u));
  await notifyBriefingEmail({ mail: MAIL, email: prof && prof.briefingEmail, user: u, briefing, audit })
    .catch((e) => audit('briefing-email-failed', { who: u.id, briefing: briefing.id, error: String(e && e.message || e) }));
};

// Approval loop（审批闭环）for a job's outcome: pre-approved proposals execute
// NOW and are reported in the briefing body（预批准执行）; the rest stay pending
// in the in-app queue (GET /api/actions — the longevity app's Pending Approvals).
// Executors are local (lib/actions.mjs registry).
async function settleAndAnnotate(u, out) {
  if (!out || !out.briefing) return out;
  const settled = await settleProposals(u, out.proposed || [], { preapproved: cfg.preapproved_action_types, audit });
  return { ...out, briefing: annotateBriefing(u, out.briefing, settled) };
}

// An approved reminder fires as a ONE-LINE briefing — visible in the app's
// 简报 section AND emailed through the same pushBriefing (one path, R3).
// Each delivery names the off switch, and reminder-class briefings keep a
// ROLLING window (a daily reminder must not accrete a permanent file per fire).
const REMINDER_BRIEFINGS_KEEP = 14;
const deliverReminder = async (u, rem, now) => {
  const briefing = saveBriefing(u, { id: `${rem.id}-r${now.getTime()}`, job: 'reminder',
    title: 'Reminder · 提醒', body: `${rem.text}\n\nRemove in the app · 可在应用中移除`, created: now.getTime() });
  pruneBriefings(u, 'reminder', REMINDER_BRIEFINGS_KEEP);
  await pushBriefing(u, briefing);
};

// One serialized job run（同一队列）. The producer path sweeps FIRST — expiry
// and executor-limbo — so a TTL-dead pending proposal can never suppress its
// flag forever, then the LLM pass runs OUTSIDE the lock, and only the store
// phase (save briefing, propose, settle pre-approved) joins the per-user queue
// that also serializes decisions (lib/decide.mjs — the single writer).
// Flag suppression is RE-CHECKED inside the lock at store time: two
// overlapping brief runs (manual + tick) both passed the pre-LLM check, and
// only this store-time gate stops them stacking duplicate proposals.
async function runJobSerialized(u, job, opts) {
  await withUserLock(u.id, () => { const t = Date.now(); expireStaleActions(u, t); sweepStrandedApprovals(u, t, audit); });
  const result = await job.run(u, opts);
  return withUserLock(u.id, async () => {
    const filtered = result && Array.isArray(result.actions)
      ? { ...result, actions: result.actions.filter((a) => !(a.payload && a.payload.flag && isFlagSuppressed(u, a.payload.flag))) }
      : result;
    return settleAndAnnotate(u, await runJob(u, job, { run: async () => filtered }));
  });
}

// Autonomous jobs. `run` produces { body, actions:[{type,title,summary,payload}] }.
// The read-only digest `body` is auto; side-effecting `actions` queue for approval.
// Each entry's bilingual `title` doubles as its label in the Jobs view
// (GET /api/jobs → lib/jobstatus.mjs) — ONE string, no parallel labels map (R3).
// The daily brief（每日一报）was REMOVED 2026-10-11 (docs/adr/0004): data jobs now send
// their own message; the weekly 健康简报, the daily 模型检查 and the 模型评测 below are the built-ins.
const JOBS = {
  // Health jobs (docs/design/ios-health-ingestion.md §3-4). Deterministic analysis
  // first; only the weekly digest makes ONE LLM pass — on the local/fast lane,
  // fed computed aggregates only (never raw samples). run(user, {manual}) may
  // return null = intentionally no briefing (runJob stores nothing then).
  'health-brief': {
    name: 'health-brief', title: '健康简报 · Weekly Health Brief', type: 'digest',
    schedule: { day: 0, time: '20:00' },        // Sunday 20:00 (design §4)
    // isSuppressed: a flag denied within the cooldown, or one still awaiting a
    // decision, is not re-proposed (lib/actions.mjs isFlagSuppressed).
    run: (user, opts = {}) => healthBriefBody(user, { llm: healthLLM, llmLabel: healthLaneLabel(), thresholds: healthThresholds(user), manual: !!opts.manual,
      isSuppressed: (flag) => isFlagSuppressed(user, flag) }),
  },
  // Model check（模型检查）— lib/model-health.mjs. Probes every Ollama lane once a day and briefs
  // only on a change: a lane gone (hidden from the chooser from then on), a lane back, new cloud
  // models. ownerOnly: the models are the node's, so ONE owner runs it (lib/owner.mjs nodeOwnerId).
  'model-check': {
    name: 'model-check', title: '模型检查 · Model check', type: 'digest', ownerOnly: true,
    get schedule() { return { time: cfg.model_check_time }; },   // config, read at every tick
    // Plus ONE cheap Claude probe (lib/claude-auth.mjs checkClaudeAuth): an expired sign-in is
    // briefed once per episode, through this job's briefing — no new channel. The probe runs FIRST:
    // runModelCheck throws when Ollama is down, and the sign-in report must not wait on Ollama.
    // The probe marks its episode reported BEFORE runModelCheck runs, so an Ollama outage must not
    // lose the sign-in briefing: with a sign-in brief in hand the outage is audited and shown in
    // that same briefing (R5); with none, the throw is the job's failure as before (R14).
    // TODO(R4 seam): the built-in JOBS table belongs in lib/jobs/builtins.mjs (see the note at laneRole).
    run: async (user, opts = {}) => {
      const a = await checkClaudeAuth({ file: claudeAuth.file, chatModels: cfg.chat_models, claudeCmd: cfg.claude_cmd, cwd: wsDir(user), audit,
        run: (o) => enqueue(() => runClaude(o)) });
      const check = () => runModelCheck({ file: modelHealth.file, chatModels: cfg.chat_models, url: cfg.ollama_url, auth: ollamaAuth(),
        catalogUrl: cfg.ollama_catalog_url, manual: !!opts.manual });
      try { return mergeBriefs(a, await check()); }
      catch (e) {
        if (!a) throw e;
        audit('model-check-error', { error: String(e.message || e) });
        return mergeBriefs(a, { body: `${MODEL_CHECK_ERROR_PREFIX}${e.message}` });
      }
    },
  },
  // Model review（模型评测）and its Undo — lib/model-review.mjs, docs/adr/0017. Weekly, owner only:
  // tests the catalog's new models on our uses and keeps the best in chat_models. The grader is
  // Claude in the agent queue, with no tool. Everything is read lazily: modelHealth, enqueue and
  // wsDir are defined further down.
  // runLane: the Claude and Codex lanes measured as the chat runs them (ADR 0017 decision 10).
  // The review is owner-only and never an app's turn, so its grader and its Claude lane resolve as
  // the owner's composer lane (agentArgs with REVIEW_ORIGIN) — not raw cfg.*_args (test/agent-confinement).
  ...modelReviewJobs({ cfg, root: ROOT, healthFile: () => modelHealth.file, userDirs: () => cfg.users.map(wsDir),
    ask: ({ args, prompt, user, timeoutMs }) => enqueue(() => runAgent(prompt, agentArgs(user, args, REVIEW_ORIGIN), wsDir(user), timeoutMs)),
    runLane: (a) => laneRunner({ cfg, wsDir, enqueue, runClaude, runCodex, claudeArgs: (user) => agentArgs(user, cfg.claude_args, REVIEW_ORIGIN) })(a) }),
};

// ── The job set for ONE user, resolved FRESH on every use ──────────────────────────────
// Built-ins (code, always on) merged with that user's job FILES. Reading a few small JSON
// files a minute is nothing beside a 6.7ms page serve, and it is what makes "create a job"
// take effect immediately instead of at the next restart.
//
// A built-in always wins a name collision: a file must not be able to shadow 健康简报.
// Bad files are surfaced in the owner-visible audit log and SKIPPED — one unparseable job
// never stops the others (R5).
// What a job may legally name in THIS install: the models actually configured, and the tool
// catalogue (so a model pinned on a deterministic tool is refused rather than ignored).
const jobCheckOpts = () => ({ lanes: (cfg.chat_models || []).map((m) => m.id), tools: toolManifests() });
const RUN_BODY_MAX = 4000;   // a Run-now reply shows the result; the feed holds the whole thing
const RESOLVE_MS = 60000;   // one structured answer; a task timeout would be wrong here
// The lanes a job's tools may reach. `research` takes the pinned model when a job names one,
// falling back to the configured research lane — so a global change never alters a pinned job.
const jobRunner = makeRunner(undefined, {
  research: (question, model) => {
    const laneId = model || (cfg.research && cfg.research.llm);
    const lane = (cfg.chat_models || []).find((mm) => mm.id === laneId) || {};
    return runResearch(question, {
      research: cfg.research, keys: { tavily: cfg.tavily_key, firecrawl: cfg.firecrawl_key },
      lanes: { streamOllama }, ollamaUrl: cfg.ollama_url, model: lane.model,
    });
  },
});
function jobsForUser(user) {
  const { jobs: fileJobs } = loadJobFiles(wsDir(user), {
    onBad: (id, error) => audit('job-invalid', { who: user.id, job: id, error }),
  });
  // A built-in cannot be edited or deleted, but it CAN be switched off, and that switch is a
  // per-user override rather than a write into the shared JOBS literal — see lib/jobs/prefs.mjs.
  // An unreadable prefs file holds every built-in off: running a briefing someone turned off is
  // the failure worth avoiding, and the row carries the reason rather than a silent "paused" (R5).
  const builtins = builtinsFor(JOBS, user.id === nodeOwnerId(cfg.users));
  let out;
  try { out = applyJobPrefs(builtins, readJobPrefs(wsDir(user))); }
  catch (e) {
    const why = String((e && e.message) || e);
    audit('job-prefs-error', { who: user.id, error: why });
    out = heldOff(builtins, why);
  }
  for (const [name, j] of Object.entries(fileJobs)) {
    if (out[name]) { audit('job-shadowed', { who: user.id, job: name }); continue; }
    out[name] = attachRunner(j, jobRunner);
  }
  return out;
}

// The ONE LLM pass of the health digest. The lane is EXPLICIT config —
// cfg.health_llm names a chat_models id with provider 'ollama' (validated,
// default = the first ollama entry; see lib/config.mjs). NOTE: the default
// ollama entries are *-cloud models, so with a default config the computed
// AGGREGATES (never raw samples — lib/health-analyze.mjs builds the prompt)
// do leave the machine; the briefing footer names the lane so that's visible.
function healthLane() {
  const lane = (cfg.chat_models || []).find((m) => m.id === cfg.health_llm);
  if (!lane) throw new Error('health-brief: health_llm lane not configured (set cfg.health_llm to an ollama chat_models id)');
  return lane;
}
function healthLaneLabel() { const l = healthLane(); return l.label || l.model; }
async function healthLLM(prompt) {
  const lane = healthLane();
  return streamOllama({ url: cfg.ollama_url, model: lane.model, messages: [{ role: 'user', content: prompt }], onDelta: () => {} });
}

// The ONE vision call of a meal-photo ingest（拍照记录饮食, lib/meals.mjs). Lane
// = cfg.vision_default — the SAME lane chat routes images to (glm-5.3-flash
// cloud by default), so the photo leaves the machine for this single call under
// consent-by-action (see the /api/meals/ingest route comment). A non-Ollama
// lane throws; extractMeal records that honestly as analyzed:false (R14).
// No `|| fallback` here or at the chat-image sibling (pickChatLane): the
// `cfg.vision_default =` line in lib/config.mjs is the ONE place the vision
// default lives (R3 — the dead fallbacks had already drifted, 'glmflash' here
// vs 'claude' there).
async function mealVision(prompt, imageB64) {
  const lane = (cfg.chat_models || []).find((m) => m.id === cfg.vision_default);
  if (!lane || lane.provider !== 'ollama') throw new Error('meals: cfg.vision_default is not an Ollama vision lane');
  return streamOllama({ url: cfg.ollama_url, model: lane.model,
    messages: [{ role: 'user', content: prompt, images: [imageB64] }], onDelta: () => {} });
}

// Config defaults overlaid with the user's own profile overrides (written via
// PUT /api/profile healthThresholds — validated in lib/users.mjs).
function healthThresholds(user) { return effectiveHealthThresholds(loadProfile(user.workspace), cfg.health_thresholds); }
const BIBLE_DATA = path.join(ROOT, BIBLE_DATA_DIR);   // the BSB + 和合本 corpus on disk (lib/bible.mjs)
// Cap on the per-app model map (PUT /api/profile appModels). Generous — one entry per app the
// member owns — and exceeding it is REFUSED rather than truncated, so no app silently loses its
// remembered lane.
const APP_MODELS_MAX = 200;
// Per-app preference blobs (PUT /api/profile appPrefs): a JSON object per app, whatever that app
// decides its settings are. Capped by SERIALISED SIZE rather than by key count — an app's
// settings are its own shape, but profile.json is read whole on every request, so the bytes are
// what has to be bounded. Over the cap is refused, never truncated.
const APP_PREFS_MAX_BYTES = 8000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex')); // for constant-time login

// Everything is scoped to a user's own workspace — full data isolation.
const wsDir = (u) => u.workspace;
// The display name a member saved in Settings, or '' (the record's own name is a placeholder).
const ownName = (u) => { const n = String((loadProfile(wsDir(u)) || {}).name || '').trim(); return n && n !== u.name ? n : ''; };
const appsDir = (u) => path.join(u.workspace, 'apps');
// An app folder as a WRITE target, never through a link at apps/<slug> or above it (R13, 2026-10-13):
// a link there carried an update's files, a bump, a share toggle or a delete into another folder.
// null = a link on the way; the route answers LINKED_APP. Copy SOURCES go through the same rule.
function ownAppDir(u, slug) {
  const d = path.join(appsDir(u), slug);
  return noLinkOnTheWay(u.workspace, d) ? d : null;
}
const LINKED_APP = '{"error":"app folder is a link"}';
// TODO(R4): web.mjs is far over budget — the app-shelf code (listApps, forkSource and the /api/apps/*
// routes: fork, update, changelog, bump, share, delete) is a seam for lib/app-routes.mjs.
// The app a fork names as its source, judged ONCE for every reader (R3). meta.forkedFrom sits in the
// forker's own meta.json, which their agent can edit, so the slug must be a slug before it names a
// folder: unchecked, `../data/evil` climbed into the owner's workspace (R13, reproduced). null = not
// a (valid) fork; src null = its account is gone or not active (as a peer fork requires).
function forkSource(meta) {
  const ff = meta && meta.forkedFrom;
  if (!ff || typeof ff !== 'object' || !ff.uid || typeof ff.slug !== 'string' || !slugOk(ff.slug)) return null;
  const u = cfg.userById.get(ff.uid);
  const src = u && u.status === 'active' ? u : null;
  return { ff, src, srcDir: src ? path.join(appsDir(src), ff.slug) : null };
}
const convosDir = (u) => path.join(u.workspace, 'conversations');

function convoFile(u, id) { return /^[0-9a-z]{6,32}$/.test(id) ? path.join(convosDir(u), id + '.json') : null; }
// A conversation is an object with a messages ARRAY — anything else is damaged.
const isConvo = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.messages);
// Three-state read (lib/webutil.mjs): 'absent' (no such chat), 'ok', or
// 'unreadable' (there, but damaged / EACCES / half-written). chat() below needs
// that distinction — treating "unreadable" as "absent" silently forked a NEW
// conversation and orphaned the user's history under an id nothing pointed at.
function loadConvoState(u, id) {
  const f = convoFile(u, id);
  if (!f) return { state: FILE_ABSENT };
  const r = readJsonState(f);
  if (r.state === FILE_OK && !isConvo(r.value)) return { state: FILE_UNREADABLE, error: `${id}.json is not a conversation` };
  return r;
}
// Lenient wrapper for READ-ONLY callers (GET/PATCH answer 404 either way, and
// neither writes over the file it failed to read).
function loadConvo(u, id) { const r = loadConvoState(u, id); return r.state === FILE_OK ? r.value : null; }
// Atomic (R3, lib/webutil.mjs): a conversation is user-typed content, and the
// bare writeFileSync this replaces truncated it before writing — a crash or a
// SIGTERM from the ops lifecycle mid-write left an unparsable file, which
// loadConvo then reads as "no conversation".
// The target path is derived through convoFile (R3, the same id validation the
// read uses), never by concatenating whatever `id` the stored document happens
// to carry: a convo whose `id` field disagrees with its filename would
// otherwise have this write land on — and replace — a DIFFERENT conversation.
function saveConvo(u, c) {
  const f = convoFile(u, c && c.id);
  if (!f) throw new Error(`saveConvo: refusing to write a conversation with an invalid id (${String(c && c.id).slice(0, 40)})`);
  writeFileAtomic(f, JSON.stringify(c));
}
function listConvos(u) {
  const dir = convosDir(u);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
    try { const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); return { id: c.id, title: c.title || 'New chat', updated: c.updated || 0, app: c.app || null }; }
    catch { return null; }
  }).filter(Boolean).filter((c) => !c.app).sort((a, b) => b.updated - a.updated); // app chats stay out of the main drawer
}
// Turn an app chat's first message into a clean title (strip the app's system scaffolding).
function appTitle(m) {
  return String(m || '')
    .replace(/^Context:[\s\S]*?Question:\s*/i, '')
    .replace(/^You are a[\s\S]*?(?:\w+ asks:|asks:)\s*/i, '')
    .replace(/\n*\[Attached file:[^\]]*\]/g, '')
    .trim().slice(0, 48) || 'App chat';
}
function newId() { return crypto.randomBytes(8).toString('hex'); }

function thisYear() { return new Date().getFullYear(); }

// Add or update a user in the live maps and persist to config.json.
async function upsertUser(rec) {
  const i = cfg.users.findIndex((u) => u.id === rec.id);
  if (i >= 0) cfg.users[i] = { ...cfg.users[i], ...rec };
  else cfg.users.push(rec);
  cfg.userByToken = new Map(cfg.users.map((u) => [u.token, u]));
  cfg.userById = new Map(cfg.users.map((u) => [u.id, u]));
  const { writeUsers } = await import('./lib/users.mjs');
  writeUsers(ROOT, cfg.users);
}

async function removeUser(id) {
  cfg.users = cfg.users.filter((u) => u.id !== id);
  cfg.userByToken = new Map(cfg.users.map((u) => [u.token, u]));
  cfg.userById = new Map(cfg.users.map((u) => [u.id, u]));
  const { writeUsers } = await import('./lib/users.mjs');
  writeUsers(ROOT, cfg.users);
  // Their workspace directory is left on disk intentionally — deletion of
  // personal data is a manual, deliberate step, never a side effect of a click.
}

function provisionWorkspace(rec) {
  const example = path.join(ROOT, 'workspace.example');
  if (!fs.existsSync(rec.workspace)) {
    if (fs.existsSync(example)) fs.cpSync(example, rec.workspace, { recursive: true });
    else fs.mkdirSync(path.join(rec.workspace, 'memory'), { recursive: true });
  }
  // Seed ONLY when profile.json is genuinely ABSENT (lib/users.mjs seedProfile
  // precedent, R3): loadProfile() answers null for "damaged" too, and seeding
  // over a damaged profile would replace recoverable data with a blank default.
  let existingProfile;
  try { existingProfile = loadProfileForUpdate(rec.workspace, null); } catch { return; } // damaged: leave it for repair; every write path answers 500 file_unreadable until then
  if (!existingProfile) saveProfile(rec.workspace, { name: rec.name, role: rec.role, birthYear: rec.birthYear || null, about: '', prefs: '' });
}

function publicUser(u) { const p = loadProfile(u.workspace) || {}; return { id: u.id, name: p.name || u.name, role: u.role, status: u.status || 'active', hasPin: !!u.passHash, birthYear: p.birthYear ?? u.birthYear ?? null, age: ageFromYear(p.birthYear ?? u.birthYear, thisYear()) }; }

if (!cfg.web_token) {
  cfg.web_token = crypto.randomBytes(24).toString('base64url');
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  raw.web_token = cfg.web_token;
  writeFileAtomic(path.join(ROOT, 'config.json'), JSON.stringify(raw, null, 2)); // atomic (R3): truncate-then-write here would destroy every account on a crash
  console.log('[web] generated web_token (see config.json)');
}

// Bounded concurrency: independent chats and users run in parallel (up to N),
// instead of one global serial queue that made every chat wait behind the last.
const MAX_CONCURRENT = cfg.max_concurrent || 3;
let active = 0; const waiters = [];
const enqueue = (fn) => new Promise((resolve, reject) => {
  const run = () => { active++; Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; const w = waiters.shift(); if (w) w(); }); };
  if (active < MAX_CONCURRENT) run(); else waiters.push(run);
});

// Resolve which user a request belongs to (constant-time token match). Apps
// NEVER receive a token (see /app below).
// The token comes from the Authorization header ONLY: a `?t=` URL token leaked into logs, history
// and Referer, and no client sends one any more.
// Requests authenticated by an API key, not a session: they may not change credentials or use
// /api/admin once the account has a PIN (a leaked Shortcut key must not become the owner's login).
const apiKeyReqs = new WeakSet();
const apiKeyBlocked = (req, user) => apiKeyReqs.has(req) && !!user.passHash;
const API_KEY_REFUSED = JSON.stringify({ error: 'Sign in with your password for this · 此操作需用密码登录' });
const bearerOf = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
function userFor(req) {
  const given = bearerOf(req);
  if (!given) return null;
  const uid = cfg.sessions.resolve(given, Date.now());
  if (demoOn(cfg)) {   // demo: anonymous visitors only, never an account or API token (lib/demo.mjs)
    const v = uid ? demoUsers.get(uid) : null;
    if (v && v.signedIn && authConfig(cfg).required && !demoGate.alive(given, v.id)) return null;   // a member's session ends with their Supabase sign-in (lib/demo-auth.mjs)
    if (v && !fs.existsSync(v.workspace)) provisionWorkspace(v);   // a restore kept the session but not the folder: seed it before any write
    return v;
  }
  if (uid) { const u = cfg.userById.get(uid); if (u && u.status === 'active') return u; }
  for (const u of cfg.users) if (u.status === 'active' && tokenOk(given, u.token)) { apiKeyReqs.add(req); return u; } // API-key / owner bootstrap
  return null;
}
const audit = limitAudit(makeAudit(cfg.auditFile), () => demoOn(cfg)); // the ONE shared audit-entry shape (lib/auth.mjs, R3); capped per kind on a demo node
// Which Ollama models answered gone — 410, or Ollama's model-not-found 404 (lib/model-health.mjs). Node-wide runtime state, beside
// audit.log — a model is retired for everyone on the node, not per person.
const modelHealth = modelHealthFor(path.join(ROOT, MODEL_HEALTH_FILENAME), audit, (ev, fields) => auditSize(ev, 'model-health', fields));
// Whether the node's Claude CLI can still sign in (lib/claude-auth.mjs, docs/adr/0024). Node-wide, like modelHealth.
const claudeAuth = claudeAuthFor(path.join(ROOT, CLAUDE_AUTH_FILENAME), audit);
// Throttled audit for repeating telemetry (app-data size warnings): the same
// file + the same condition is recorded at most once per cooldown, because the
// event that triggers it is a 700ms autosave. Keyed in memory; the map holds
// one small entry per (user, file, condition) actually seen.
const SIZE_AUDIT_COOLDOWN_MS = 10 * 60_000;
const sizeAuditAt = new Map();
function auditSize(kind, key, fields) {
  if (demoOn(cfg)) return;   // a public visitor's saves never write telemetry lines (lib/demo.mjs)
  const k = `${kind}:${key}`, now = Date.now();
  if (now - (sizeAuditAt.get(k) || 0) < SIZE_AUDIT_COOLDOWN_MS) return;
  sizeAuditAt.set(k, now);
  audit(kind, fields);
}
function findLogin(handle) { const h = String(handle || '').toLowerCase(); return cfg.users.find((u) => (u.username || u.id) === h) || null; }

// Responses were served RAW. The shell is 182KB and an app page with PANote inlined is 347KB, so
// every visit re-sent a third of a megabyte over Tailscale — the dominant cost of opening the app on
// a phone (the server itself answers in ~4ms). Measured: 65% smaller for ~5ms of CPU at level 6.
//
// Only text; only above a size where the header overhead is worth it; only when the client asked.
// The NDJSON chat stream and the jobs heartbeat write to `res` directly and never reach here, so
// nothing that must arrive incrementally can be buffered by this.
const GZIP_LEVEL = 6;                 // 65% saved for ~5ms; level 9 buys 0.05% more for 60% more CPU
const GZIP_MIN_BYTES = 1024;          // below this the gzip header costs more than it saves
const COMPRESSIBLE = /^text\/|application\/(json|javascript|manifest\+json)|\+json$|image\/svg/;

function send(res, code, type, body, extra = {}) {
  // JSON from this server is ALWAYS the household's own live data, and it carried no freshness
  // information at all — no cache-control, no expires, no last-modified. A browser is entitled to
  // cache that heuristically, and one did: a laptop kept answering /api/app-convos from its own
  // disk cache, so yesterday's conversations never appeared and pressing Refresh changed nothing,
  // while the same account on a phone (cold cache) showed them correctly.
  // It is also a privacy fix — personal notes and chats should not sit in a shared laptop's cache.
  // Placed BEFORE ...extra so a route that deliberately sets its own cache-control still wins.
  // HTML is code and must revalidate on every load (ADR 0026): every text/html answer goes through
  // sendHtml(), which sets no-cache with the ETag — the ONE place for it (R3), not repeated here.
  const head = { 'content-type': type,
    ...(type === 'application/json' ? { 'cache-control': 'no-store' } : {}),
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff', ...extra };
  const already = Object.keys(head).some((k) => k.toLowerCase() === 'content-encoding');
  const buf = body == null ? null : (Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
  if (!already && buf && buf.length >= GZIP_MIN_BYTES && COMPRESSIBLE.test(type || '') && /\bgzip\b/.test(res._paAccept || '')) {
    // Vary regardless of the branch taken, or a cache could hand a gzipped body to a client
    // that never asked for one.
    res.writeHead(code, { ...head, 'content-encoding': 'gzip', vary: 'accept-encoding' });
    return res.end(zlib.gzipSync(buf, { level: GZIP_LEVEL }));
  }
  res.writeHead(code, buf && COMPRESSIBLE.test(type || '') ? { ...head, vary: 'accept-encoding' } : head);
  res.end(buf);
}

// A page whose bytes are derived from files on disk: hand it an ETag so a return visit revalidates
// instead of re-downloading. `cache-control: no-cache` already asks the browser to revalidate every
// time — it just had nothing to revalidate AGAINST, so every load re-sent the whole page.
const etagOf = (html) => '"' + crypto.createHash('sha1').update(html).digest('base64url').slice(0, 27) + '"';
// `cached` is an already-built {etag, gz} for this exact html. Passing it skips the SHA-1 and the
// gzip; omitting it behaves exactly as before, so every other caller is unchanged.
function sendHtml(res, html, extra = {}, cached = null) {
  const etag = (cached && cached.etag) || etagOf(html);
  const head = { 'cache-control': 'no-cache', etag, ...extra };
  if (res._paNoneMatch && res._paNoneMatch.split(',').some((t) => t.trim() === etag)) {
    res.writeHead(304, { etag, 'cache-control': 'no-cache' });
    return res.end();
  }
  if (cached && cached.gz && /\bgzip\b/.test(res._paAccept || '')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff', 'content-encoding': 'gzip', vary: 'accept-encoding', ...head });
    return res.end(cached.gz);
  }
  return send(res, 200, 'text/html; charset=utf-8', html, head);
}

function sendFile(res, file, { type, extra = {} } = {}) {
  fs.readFile(file, (err, data) => {
    if (err) {
      const code = err.code === 'ENOENT' || err.code === 'EISDIR' ? 404 : 500;
      return send(res, code, 'text/plain', code === 404 ? 'not found' : 'error');
    }
    send(res, 200, type || dataContentType(path.extname(file)), data, extra);
  });
}

// TODO(R4): the app-page builder (PA_COMPONENTS, PA_PREFS_SNIPPET, appStamp, sendAppHtml) is a seam:
// move it to lib/apppage.mjs, so a test builds a page as served instead of reading web.mjs as text.
// Serve an app's HTML, inlining the shared components at their markers: PAChat at
// <!--PA_CHAT_UI-->, PANote at <!--PA_NOTE_UI--> and PASplit at <!--PA_SPLIT_UI-->.
// Read fresh each time (no-cache
// anyway) so edits to either canonical file propagate to every app immediately. The
// sandbox CSP forbids <script src> (no 'self'), so serve-time inlining of these single
// canonical files is the ONLY way to single-source a shared component (see docs/adr).
const PA_CHAT_MARKER = '<!--PA_CHAT_UI-->';
const PA_NOTE_MARKER = '<!--PA_NOTE_UI-->';
const PA_SPLIT_MARKER = '<!--PA_SPLIT_UI-->';
const PA_SETTINGS_MARKER = '<!--PA_SETTINGS_UI-->';
const PA_PHOTO_MARKER = '<!--PA_PHOTO_UI-->';
const PA_PRINT_MARKER = '<!--PA_PRINT_UI-->';
const PA_SCAN_MARKER  = '<!--PA_SCAN_UI-->';
// PAStationery (decorative journal paper) is carried by the JOURNAL page only, not by note-ui, so
// the Bible and every other PANote host do not pay for its designs. Its designs file is carried
// by stationery-ui itself (the same carrier rule as PAPrint inside note-ui).
const PA_STATIONERY_MARKER = '<!--PA_STATIONERY_UI-->';
const PA_STATIONERY_DESIGNS_MARKER = '<!--PA_STATIONERY_DESIGNS-->';
const PA_TWO_TAP_MARKER = '<!--PA_TWO_TAP_UI-->';
const PA_STORE_MARKER = '<!--PA_STORE_UI-->';
const PA_LEAVE_MARKER = '<!--PA_LEAVE_UI-->';
const PA_BROKER_MARKER = '<!--PA_BROKER_UI-->';
const PA_BUSY_MARKER = '<!--PA_BUSY_UI-->';
// APPEND-ONLY, and order matters: the loop below re-tests the ALREADY-INLINED html on each pass,
// so a component listed BEFORE another can have that other's marker inlined into it. Adding new
// entries last keeps an existing component's content out of the substitution path.
const PA_COMPONENTS = [
  { marker: PA_CHAT_MARKER, file: 'chat-ui.inline.html' },
  { marker: PA_NOTE_MARKER, file: 'note-ui.inline.html' },
  { marker: PA_SPLIT_MARKER, file: 'split-ui.inline.html' },
  // LAST, and every future component goes after this one: the loop below re-tests the ALREADY
  // INLINED html for each remaining marker, so a component whose own source happens to contain a
  // later component's marker would pull it in. Appending keeps that impossible by construction.
  { marker: PA_SETTINGS_MARKER, file: 'settings-ui.inline.html' },
  // PAPhoto must stay AFTER chat-ui: chat-ui now CARRIES this marker (its ＋ attach delegates
  // to PAPhoto), and the loop re-tests the already-inlined html for each REMAINING marker.
  // Registered before chat-ui the marker would never be reached, and the ＋ button would
  // report a missing component on every page. Last also means every app that mounts PAChat
  // gets PAPhoto with no per-app edit.
  { marker: PA_PHOTO_MARKER, file: 'photo-ui.inline.html' },
  // PAPrint must stay AFTER note-ui, for the same reason PAPhoto stays after chat-ui: note-ui
  // CARRIES this marker (its print button delegates to PAPrint), and the loop re-tests the
  // already-inlined html for each REMAINING marker. Registered before note-ui the marker would
  // never be reached and the button would report a missing component on every page. It also
  // means every app that mounts PANote gets print with no per-app edit.
  { marker: PA_PRINT_MARKER, file: 'print-ui.inline.html' },
  // PAScan must stay after note-ui: note-ui carries the PA_SCAN_UI marker, so the loop
  // re-tests the already-inlined html and finds it. Every app mounting PANote gets PAScan.
  { marker: PA_SCAN_MARKER,  file: 'scan-ui.inline.html'  },
  // PAScanDetect, the slide auto-framer: scan-ui CARRIES this marker above its own script, so
  // the detector exists by the time the editor opens; appended right after scan-ui per the rule above.
  { marker: '<!--PA_SCAN_DETECT-->', file: 'scan-detect.inline.html' },
  // PAPencilLog: after note-ui, which carries its marker (same rule as PAPrint / PAScan).
  { marker: '<!--PA_PENCIL_LOG_UI-->', file: 'pencil-log.inline.html' },
  // PANoteReveal, the search-hit reveal (page + highlight): after note-ui, which carries its marker.
  { marker: '<!--PA_NOTE_REVEAL_UI-->', file: 'note-reveal.inline.html' },
  // PAStationery, then its designs: stationery-ui CARRIES the designs marker, so it goes first.
  { marker: PA_STATIONERY_MARKER, file: 'stationery-ui.inline.html' },
  { marker: PA_STATIONERY_DESIGNS_MARKER, file: 'stationery-designs.inline.html' },
  // Its studio core (AI design, pictures) and its UI (picker + studio buttons): both carried by
  // stationery-ui too, after the designs — the studio's script must run before the picker mounts.
  { marker: '<!--PA_STATIONERY_STUDIO-->', file: 'stationery-studio.inline.html' },
  { marker: '<!--PA_STATIONERY_PICKER-->', file: 'stationery-picker.inline.html' },
  // Its sanitizer, split out of stationery-ui (R4). stationery-ui carries this marker ABOVE its own
  // script, so the sanitizer runs first wherever it is listed; appended last per the rule above.
  { marker: '<!--PA_STATIONERY_SANITIZE-->', file: 'stationery-sanitize.inline.html' },
  // PATwoTap, the two-tap destructive button. No app carries this marker: sendAppHtml places it on
  // EVERY app page, ahead of the first script, so each app can use it at top level with no edit.
  { marker: PA_TWO_TAP_MARKER, file: 'two-tap.inline.html' },
  // PAStore, the guarded first read of an app's data file: on every app page too, right after PATwoTap.
  { marker: PA_STORE_MARKER, file: 'store.inline.html' },
  // The sanitizer's render-cost budget, split out of it (R4). stationery-sanitize carries this marker
  // ABOVE its own script, so the budget runs first; appended last per the rule above.
  { marker: '<!--PA_STATIONERY_COST-->', file: 'stationery-cost.inline.html' },
  // The budget's geometry readers, split out of it (R4). stationery-cost carries this marker ABOVE its own
  // script, so the readers run first; appended last per the rule above.
  { marker: '<!--PA_STATIONERY_GEOMETRY-->', file: 'stationery-geometry.inline.html' },
  // simplify()'s steps, split out of the budget (R4). stationery-sanitize carries this marker ABOVE its own script, after the
  // budget's, so the steps run after the budget they read; appended last per the rule above.
  { marker: '<!--PA_STATIONERY_SIMPLIFY-->', file: 'stationery-simplify.inline.html' },
  // PALeave, the last save made while the shell still serves a leaving page (ADR 0018): on every
  // app page too, right after PAStore.
  { marker: PA_LEAVE_MARKER, file: 'leave.inline.html' },
  // PA, the one request function to the broker (PA.req): on every app page too, after PALeave, so no
  // app writes its own id table and 'message' listener again (the Matrix Conf blank page, 2026-10-28).
  { marker: PA_BROKER_MARKER, file: 'broker.inline.html' },
  // PABusy, the shell's "any unsaved work?" query before a self-update (ADR 0026): on every app page
  // too, after PA, so PANote and PAChat register their one watcher each.
  { marker: PA_BUSY_MARKER, file: 'busy.inline.html' },
  // PANoteText, the Transcript panel + the `note-text` client (docs/plans/note-features.md A): note-ui
  // carries its marker, so every PANote host gets it; appended last per the rule above.
  { marker: '<!--PA_NOTE_TEXT_UI-->', file: 'note-text.inline.html' },
  // PADrawerTags, the drawer's tag chips and strip (note-features.md B): chat-ui carries its marker.
  { marker: '<!--PA_DRAWER_TAGS_UI-->', file: 'drawer-tags.inline.html' },
  // PADrawerSummary, the drawer's period summaries (note-features.md E): chat-ui carries its marker, after the tags'.
  { marker: '<!--PA_DRAWER_SUMMARY_UI-->', file: 'drawer-summary.inline.html' },
  // PAVerseMarks, typed marks on verse text (docs/plans/annotation-anchoring.md §3 d): the Bible carries its marker.
  { marker: '<!--PA_VERSE_MARKS_UI-->', file: 'verse-marks.inline.html' },
  // PASummaryRefs, the summaries' important lines + note links (note-features.md F, ADR 0025): drawer-summary
  // CARRIES its marker above its own script, so it is on every page that summarises; appended last per the rule above.
  { marker: '<!--PA_SUMMARY_REFS_UI-->', file: 'summary-refs.inline.html' },
  // PASummaryTitle: the period ids and human titles of summaries; drawer-summary carries its marker.
  { marker: '<!--PA_SUMMARY_TITLE_UI-->', file: 'summary-title.inline.html' },
  // PADrawerGroups, the drawer's Bookmarked / Summaries / month groups and jump strip (note-features.md H): chat-ui carries its marker; appended last per the rule above.
  { marker: '<!--PA_DRAWER_GROUPS_UI-->', file: 'drawer-groups.inline.html' },
  // PASummaryImages, the pages a summary sends as pictures (note-features.md I, ADR 0027); drawer-summary carries its marker.
  { marker: '<!--PA_SUMMARY_IMAGES_UI-->', file: 'summary-images.inline.html' },
  // PASummaryFollowup, the automatic research after a saved summary (note-features.md I, ADR 0027); drawer-summary carries its marker.
  { marker: '<!--PA_SUMMARY_FOLLOWUP_UI-->', file: 'summary-followup.inline.html' },
  // PAInkAnchor, Pencil ink anchored to the verse text (annotation-anchoring.md §3 b): the Bible carries its marker,
  // after PA_VERSE_MARKS_UI; it draws with PANote.ink, so note-ui must already be inlined (it is: registered above).
  { marker: '<!--PA_INK_ANCHOR_UI-->', file: 'ink-anchor.inline.html' },
  // PAInkPen, the verse ink's pen sheet (pen / highlighter / eraser, size, colour): the Bible carries its marker after
  // PA_INK_ANCHOR_UI; it reads PANote.palette and drives a PAInkAnchor control, so both are inlined above. Appended last.
  { marker: '<!--PA_INK_PEN_UI-->', file: 'ink-pen.inline.html' },
  // PAAppPrefs, the ONE per-page read/write chain for this app's prefs (the drawer's keys, the pen's): chat-ui carries
  // its marker, so every PAChat page (the Bible included) has it before any drawer or pen sheet attaches. Appended last.
  { marker: '<!--PA_APP_PREFS_UI-->', file: 'app-prefs.inline.html' },
  // PASettingsRows, the tick-box rows atop the ⚙ dialog (openAi): settings-ui carries its marker. Appended last.
  { marker: '<!--PA_SETTINGS_ROWS-->', file: 'settings-rows.inline.html' },
  // PATips, first-use tips (ADR 0030): chat-ui carries its marker AFTER PA_APP_PREFS_UI (it writes tipsSeen through PAAppPrefs). Appended last.
  { marker: '<!--PA_TIPS_UI-->', file: 'tips.inline.html' },
  // PAPaneChrome, the pane header's Float / Close and the float window (ADR 0031): split-ui carries its marker after its script. Appended last.
  { marker: '<!--PA_PANE_CHROME_UI-->', file: 'pane-chrome.inline.html' },
  // PAAppBar, the app's own bar (← Home, A-/A+, auto-hide; ADR 0032): the Bible and Journal pages carry its marker. Appended last.
  { marker: '<!--PA_APP_BAR_UI-->', file: 'app-bar.inline.html' },
  // The top-centre handle's size (web/bar-handle.css), shared with the shell's #barpeek (R3): app-bar carries its marker. Appended last.
  { marker: '/* PA_BAR_HANDLE_CSS */', file: 'bar-handle.css' },
  // PAReadingHistory, the last chapter read and the recent-chapters list (reading.json): the Bible carries its marker. Appended last.
  { marker: '<!--PA_READING_HISTORY_UI-->', file: 'reading-history.inline.html' },
];
// Injected into EVERY served app page, unconditionally. The shell broadcasts the user's A-/A+
// scale to each app (sendAppPrefs -> pa:'prefs'), but only chat-ui.inline.html ever applied it,
// so an app that does not mount PAChat never received the setting and A-/A+ appeared to change
// nothing but the shell's own header. Apps cannot share a script FILE (sandbox CSP script-src
// has no 'self'), so the ONE copy lives here and reaches every app, including ones written
// later. An app opts in from its CSS with var(--fs,1).
// TWO mechanisms, because apps are written two ways:
//   --fs : CSS that sizes in rem/var (Productivity Hub: 27 rem rules, 0 px).
//   zoom : CSS that sizes in absolute px — 257 such declarations across 13 apps. Scaling only
//          their font-size would enlarge text inside padding that stayed fixed, which reads
//          worse than not scaling at all; zoom scales text AND layout together.
// zoom is SKIPPED for an app that mounts PANote: its canvas coordinates come from a MEASURED
// element width, so re-measuring under zoom re-lays the page out instead of magnifying it —
// that path already carries an ink-offset scar, so it keeps --fs and its own page sizing.
const PA_PREFS_SNIPPET = (zoomOk) => '<script>(function(){try{addEventListener("message",function(e){'
  + 'var m=e&&e.data; if(!(m&&m.pa==="prefs"&&typeof m.fontScale==="number"))return;'
  + 'var r=document.documentElement;'
  // EXCLUSIVE, never both: an app carrying html{font-size:calc(17px*var(--fs,1))} AND zoom
  // would scale twice — 1.5 becomes 2.25.
  + (zoomOk ? ' r.style.zoom=m.fontScale;' : ' r.style.setProperty("--fs",m.fontScale);')
  + '});}catch(_){/* opened outside the shell: no prefs arrive; the app renders at its own size */}})();<\/script>';
// Built app pages are CACHED. The output is a pure function of the app file and the component
// files, and those only change when something on disk does — but every request was paying to
// rebuild it: a readFileSync per component, ~500KB of string splicing, a SHA-1 over all of it for
// the ETag and a ~10ms gzip. Including the requests that end in a 304 and send no body at all.
//
// The key is every input's mtime AND size. mtime alone misses a write inside the same millisecond
// (which a script editing several components does), and size alone misses an edit that happens to
// preserve the length — the same hole that made the save-skip guard drop cropped photos.
const APP_CACHE = new Map();
function appStamp(file) {
  let k;
  try { const st = fs.statSync(file); k = file + ':' + st.mtimeMs + ':' + st.size; }
  catch { return null; }                                  // unreadable: fall through to the live path
  for (const c of PA_COMPONENTS) {
    try { const st = fs.statSync(path.join(ROOT, 'web', c.file)); k += '|' + c.file + ':' + st.mtimeMs + ':' + st.size; }
    catch { return null; }
  }
  return k;
}
function sendAppHtml(res, file, type, extra) {
  const stamp = appStamp(file);
  const hit = stamp && APP_CACHE.get(file);
  if (hit && hit.stamp === stamp) return sendHtml(res, hit.html, extra, hit);
  fs.readFile(file, 'utf8', (err, html) => {
    if (err) { const code = err.code === 'ENOENT' || err.code === 'EISDIR' ? 404 : 500; return send(res, code, 'text/plain', code === 404 ? 'not found' : 'error'); }
      const hasNote = html.includes(PA_NOTE_MARKER);   // decided BEFORE inlining replaces the marker
    // Before the first script, or at the end of <head>: whichever comes first. A page with neither
    // has no script element, so it gets none of PATwoTap, PAStore, PALeave and PA (ADR 0018 known gaps).
    html = html.replace(/<\/head>|<script\b/i, (m) => PA_TWO_TAP_MARKER + PA_STORE_MARKER + PA_LEAVE_MARKER + PA_BROKER_MARKER + PA_BUSY_MARKER + m);
    for (const c of PA_COMPONENTS) {
      if (!html.includes(c.marker)) continue;
      let snippet = '';
      try { snippet = fs.readFileSync(path.join(ROOT, 'web', c.file), 'utf8'); }
      catch (e) { return send(res, 500, 'text/plain', 'component unavailable'); } // fail loud, don't ship a broken marker (R5)
      html = html.split(c.marker).join(snippet);
    }
    html = html.split(BUILD_MARKER).join(buildId());   // the Pencil recorder's log header names this build
    // The same CSP inside the page, for the shell's srcdoc route (lib/offline.mjs; no header reaches a srcdoc document).
    html = withCspMeta(html, extra && extra['content-security-policy']);
    // Before </body> so the listener exists by the time the shell posts prefs on iframe load.
    const snip = PA_PREFS_SNIPPET(!hasNote);
    html = html.includes('</body>') ? html.replace('</body>', snip + '</body>') : html + snip;
    // App pages are the heaviest thing this server hands out (Bible is 347KB with PANote inlined),
    // and they change only when the app or a component file does — exactly what an ETag is for.
    // Cached AFTER the build, so a page that failed to build is never remembered as one that did.
    const entry = stamp ? { stamp, html, etag: etagOf(html), gz: zlib.gzipSync(Buffer.from(html), { level: GZIP_LEVEL }) } : null;
    if (entry) APP_CACHE.set(file, entry);
    sendHtml(res, html, extra, entry);
  });
}

// readBody / BODY_LIMITS / bodyErrorResponse live in lib/webutil.mjs (imported
// above): the drain-vs-destroy tradeoff, its overall deadline and the
// failure → HTTP-answer mapping are documented and unit-tested there against a
// stub socket. Route code NEVER string-matches a body error: the one catch-all
// at the bottom of the request handler turns it into 413/400/408 + JSON with a
// stable `code` (R3 — the old readIngestBody wrapper was a second copy of that
// mapping for two routes only, and every other route fell through to a bare
// `400 text/plain "error"` the client could not parse).

// ── App faces（应用面孔）— live information on a home tile ────────────────────────────────
// The shelf is rendered by the SHELL. An app is a sandboxed iframe at an opaque origin and is
// NOT running while the shelf is on screen, so a face can never be scraped out of one: it has
// to be something the app DECLARED and WROTE, that the shell then reads. Two halves, each with
// exactly one writer, so neither can drift from the other (R3):
//   · meta.json  "face": { "label": "open" }   — the caption, and the switch: no declaration,
//     no face, whatever happens to be on disk.
//   · data/<slug>/face.json  { "value": "3", "ts": … } — the live value, written through the
//     ordinary auto-namespaced `save-data` broker kind. No new API, no new permission, and a
//     server-side job can write the same file later without the shell changing at all.
//
// CHEAP OR NOTHING. This runs once per app on EVERY home view, so it is one stat plus one read
// of a file that is refused above FACE_MAX_BYTES rather than parsed. Never a model call, never
// a network fetch — a face that costs anything real does not get to exist.
//
// OWN APPS ONLY. listFamilyApps and listShared deliberately do not call this: a face is derived
// from one person's data, and rendering another member's face on your shelf would publish their
// numbers to you. Sharing an app shares the code, never the readings.
const FACE_MAX_BYTES = 1024;
const FACE_TEXT_MAX = 24;   // a tile is ~150px wide; anything longer is a paragraph, not a face
function readFace(u, slug, meta) {
  const decl = meta && meta.face;
  if (!decl || typeof decl !== 'object' || Array.isArray(decl)) return null;   // absent, or `false` = deliberately none
  const label = typeof decl.label === 'string' ? decl.label.trim() : '';
  if (!label) return null;
  const file = path.join(wsDir(u), APP_DATA_DIR, slug, 'face.json');
  let st, raw;
  // SILENT on purpose (R5): "this app has no face yet" is the normal state of almost every app,
  // not a fault, and the visible consequence — the plain tile the shelf has always rendered — is
  // itself the report. A damaged or oversized file lands in the same place deliberately: the
  // home screen is the one surface that must never carry error noise about an optional extra.
  try {
    st = fs.statSync(file);
    if (!st.isFile() || st.size > FACE_MAX_BYTES) return null;
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = (raw.value === null || raw.value === undefined) ? '' : String(raw.value).trim();
  if (!value) return null;
  // The app may state when it computed the value; otherwise the file's own mtime is the truth.
  // Either way the shell ALWAYS gets an age, so a face physically cannot look live when it is not.
  const ts = Number.isFinite(raw.ts) ? raw.ts : st.mtimeMs;
  return { label: label.slice(0, FACE_TEXT_MAX), value: value.slice(0, FACE_TEXT_MAX), ts };
}

// The own apps whose links the shell opens (broker kind 'open-url', web/index.html): the Journal
// and the Bible notes. An app carries no network, and a link it opens is a way out, so every other
// app stays sealed; mounting PANote is not enough. KNOWN LIMIT: the gate reads the app's NAME, so an
// app written under one of these names opens links too (docs/TODO.md). The owner chose this
// (2026-10-27). config.json `open_url_apps` replaces the list, read per request.
const OPEN_URL_APPS_DEFAULT = ['notes', 'bible'];
const openUrlApps = () => new Set(Array.isArray(cfg.open_url_apps) ? cfg.open_url_apps : OPEN_URL_APPS_DEFAULT);
// Note OCR（手写识别）: config `note_ocr_cmd` stands in for the built Vision tool (tests inject a fake;
// read per use, no restart), and every page failure is audited ONCE under the one event name.
// TODO(R4 seam): these two belong with the notes routes in lib/notes-routes.mjs.
const noteOcrCmd = () => String(cfg.note_ocr_cmd || '');
const noteOcrAudit = (user) => (e) => audit(NOTE_OCR_FAILED, { who: user.id, ...(e.detail || {}), code: e.code || OCR_FAILED, error: String(e.message || e).slice(0, 200) });

function listApps(u) {
  const dir = appsDir(u);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && slugOk(d.name) && fs.existsSync(path.join(dir, d.name, 'index.html')))
    .map((d) => {
      let meta = {};
      try { const m = JSON.parse(fs.readFileSync(path.join(dir, d.name, 'meta.json'), 'utf8')); if (m && typeof m === 'object') meta = m; } catch { /* optional */ }
      let hasUpdate = false;
      const fk = forkSource(meta);
      if (fk && fk.src) {
        const { ff, srcDir } = fk;
        let srcMeta = {}; try { srcMeta = JSON.parse(fs.readFileSync(path.join(srcDir, 'meta.json'), 'utf8')) || {}; } catch { /* no source meta: not shared, no update to offer */ }
        if (srcMeta.shared) {
          // Version-based detection: owner explicitly publishes via bump.
          // Hash fallback for forks that predate versioning.
          if (srcMeta.version && ff.version) hasUpdate = srcMeta.version !== ff.version;
          else if (ff.hash) { const cur = appHash(srcDir); if (cur && cur !== ff.hash) hasUpdate = true; }
        }
      }
      return { name: d.name, title: String(meta.title || d.name), desc: String(meta.desc || ''), shared: !!meta.shared, version: meta.version || null, forkedFrom: meta.forkedFrom || null, hasUpdate, face: readFace(u, d.name, meta), ownBar: !!meta.ownBar };
    });
}

// Replaces the live cfg only once the new one has loaded in full, so a failed load leaves the last
// good config in force. keepAccounts (the config.json watcher, docs/adr/0011): the accounts stay as
// they are in memory, because upsertUser/removeUser change memory first and write the file after an
// await; a reload landing in between would put back the list from before the write, and that stale
// list is what the next account write saves. Accounts are hand-edited + restart (lib/adminconfig.mjs).
// It also loads READ-ONLY (lib/config.mjs): a reload nobody asked for never writes config.json or
// provisions a workspace, so a users[] edit caught mid-save is never persisted. The admin reload
// (POST /api/admin/reload-config) is unchanged: a full load, accounts included.
// TODO(R4): web.mjs is far over budget — reloadConfig and the watcher wiring at the lifecycle block
// are the config-lifecycle seam to move into lib/config-watch.mjs once cfg is passed in, not closed over.
const ACCOUNT_KEYS = ['users', 'userByToken', 'userById'];
async function reloadConfig({ keepAccounts = false } = {}) {
  const fresh = await loadConfig(ROOT, { readOnly: keepAccounts });
  const { sessions } = cfg;
  if (keepAccounts) for (const k of ACCOUNT_KEYS) delete fresh[k];
  Object.assign(cfg, fresh);
  if (!('demo' in fresh)) delete cfg.demo;   // Object.assign keeps a removed key: demo and its limits must go with it
  cfg.sessions = sessions;
}

function listFamilyApps() {
  const result = [];
  for (const u of cfg.users) {
    if (u.status && u.status !== 'active') continue;
    const dir = appsDir(u);
    if (!fs.existsSync(dir)) continue;
    fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && slugOk(d.name) && fs.existsSync(path.join(dir, d.name, 'index.html')))
      .forEach((d) => {
        let meta = {};
        try { const m = JSON.parse(fs.readFileSync(path.join(dir, d.name, 'meta.json'), 'utf8')); if (m && typeof m === 'object') meta = m; } catch {}
        if (!meta.shared) return;
        const prof = loadProfile(u.workspace) || {};
        result.push({ uid: u.id, slug: d.name, title: String(meta.title || d.name), desc: String(meta.desc || ''), author: prof.name || u.name });
      });
  }
  return result;
}


// Sandboxed apps get no token and no network (CSP). All their data/AI requests
// come to the shell via postMessage; the shell calls these with the master token.
// ── ONE place decides what a user's agent may touch (R3) ────────────────────────────────────
// Every agent lane goes through this. The owner keeps the unrestricted lane; everyone else runs
// without the bypass, with explicit denies and a pinned mode (lib/agent-origin.mjs laneArgs) — first
// verified against the real CLI on 2026-09-11 (see lib/config.mjs member_args for the measurements, and
// test/agent-confinement.test.mjs for the guard).
//
// Before this, a signed-in family member's chat ran with skip-permissions and cwd as a mere
// starting directory, one level below config.json (web_token, API keys, password hashes),
// web.mjs and lib/. Any member could ask their chat to read the config or edit the server, and it
// ran as the owner's Unix user. The product claimed a trust boundary it did not have.
// Web-search bounds. A cap the caller cannot raise, because every search costs money and an
// app is user-authored code.
const WEBSEARCH_MAX = 10;
const WEBSEARCH_DEFAULT_MAX = 5;
const WEBSEARCH_Q_MAX = 400;

// The app contract, read ONCE from superelf.md at boot — the single source, not a copy. It throws
// if that file loses a clause, so a truncated contract stops the node instead of quietly
// generating apps that no longer meet it.
const APP_CONTRACT = appContract(ROOT);
// The model review's lane origin: the owner's composer, never an app (lib/agent-origin.mjs fails closed without it).
const REVIEW_ORIGIN = Object.freeze({ fromApp: false });

// TODO(R4): web.mjs is far over budget — split the agent-lane resolution (agentArgs, fastBaseArgs,
// laneRole, runAgent, the oneShot lane (cancelOnClose, its one_shot_model pick in chat()),
// PA_CHAT_LANE, startAssess) into its own lib module, in a no-behaviour-change session.
// streamOllama goes with it: it is lane code too.
// TODO(R4): and chat() is far over its function budget — split its conversation resolution (load,
// surface binding, create) from the lane dispatch, in the same kind of session.
// `origin` is { fromApp: boolean } — lib/agent-origin.mjs decides (agentConfined): an app's
// request is confined even for the owner, and an origin that is not stated is confined too.
// `origin.app` is the app's slug: it tags its conversations (convoTag). Its agent writes nothing (ADR 0019).
function agentArgs(user, base, origin) {
  return laneArgs(user, base, cfg.member_args, origin);
}
// The member_args laneArgs appends to this turn: on a confined turn only. A default's --settings
// (fast_args, one_shot_args) yields to theirs, or the CLI — which honours only the FIRST --settings —
// would ignore the operator's member settings in favour of ours (lib/one-shot.mjs, the rule).
const memberArgsOf = (user, origin) => (agentConfined(user, origin) ? cfg.member_args : []);
// The fast lane's base (the job resolver, /api/ask): cfg.fast_args, read live — for agentArgs.
const fastBaseArgs = (user, origin) => yieldSettings(cfg.fast_args, memberArgsOf(user, origin));
// The capability note follows the LANE, not the account: the owner's app request is confined, so
// it must be told so, or it narrates a permission prompt nobody can grant.
const laneRole = (user, origin) => (agentConfined(user, origin) ? 'confined' : 'owner');

async function runAgent(message, extraArgs, cwd, timeoutMs, systemPrompt) {
  const r = await runClaude({ claudeCmd: cfg.claude_cmd, extraArgs, cwd, prompt: message, timeoutMs, systemPrompt });
  if (!r.ok && isAuthFailure(r.text)) claudeAuth.noteFailure(r.text);   // the background asks see the expiry too (docs/adr/0024)
  return r;
}

// ── oneShot: ONE answer for a component, not a conversation · 组件的一次性回答 (docs/adr/0008) ──
// PAChat.complete (web/chat-ui.inline.html) always sends `oneShot: true`; the composer never does.
// MEASURED 2026-10-12 with the real CLI (the Journal's "Design with AI", `claude -p --model sonnet`):
// with the user's adaptive thinking on, Sonnet drafted the whole SVG inside its thinking, hit the
// 32,000-token output cap with no text, retried, and never answered — 4 of 4 runs failed after
// >10 min, even at --effort low. With thinking off a complete SVG came back in ~110-150 s. So a
// oneShot turn is answered by cfg.one_shot_model (default Claude, whatever the app's chooser says),
// adds cfg.one_shot_args (default thinking off; an operator's --settings in claude_args or
// member_args wins: lib/one-shot.mjs, which also records that the CLI honours only the FIRST),
// drops the app contract and sends only its message, never resuming (chat(), ADR 0008 item 9):
// --effort stays the user's. lib/one-shot.mjs holds the rules; both values are read per turn,
// never copied here (docs/adr/0011).
// What a cancelled oneShot turn answers and stores, instead of the killed child's raw stream-json.
const CHAT_CANCELLED = Object.freeze({ ok: false, text: 'Cancelled · 已取消' });   // == PAC_CANCELLED in web/chat-ui.inline.html (test/chat-cancel.test.mjs)
// A oneShot caller that goes away (the studio's Cancel or timeout aborts the shell relay's fetch,
// which closes this socket) can no longer use the answer, so the run stops: the claude child is
// killed, and a turn still queued never spawns one (chat() checks `signal`). Before this, the
// studio gave up after 5 min and the server ran on — retries piled up three claude processes
// holding every enqueue slot. A CONVERSATION turn is never stopped here: the composer's
// pollForResult relies on the server finishing a turn whose stream dropped.
function cancelOnClose(res) {
  const ac = new AbortController();
  let child = null;
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  ac.signal.addEventListener('abort', () => { if (child) killChild(child); }, { once: true });
  // Forgotten once it exits, so a late cancel never signals a pid the OS may have reused.
  const onChild = (c) => { child = c; c.once('close', () => { if (child === c) child = null; }); };
  return { signal: ac.signal, onChild };
}

// Stream an Ollama chat completion, re-emitting tokens via onDelta. Text-only and
// stateless (we pass recent history each call) — the composer's fast lane.
// Ollama's hosted API (https://ollama.com) wants a key; a local daemon does not. From the
// environment only (the demo's .env), so the key is never in config.json or a backup.
const ollamaAuth = () => (process.env.OLLAMA_API_KEY ? { authorization: `Bearer ${process.env.OLLAMA_API_KEY}` } : {});
async function streamOllama({ url, model, messages, onDelta, signal, requireDone = false }) {
  const r = await fetch(url + '/api/chat', { method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...ollamaAuth() },
    body: JSON.stringify({ model, messages, stream: true }) });
  if (!r.ok || !r.body) {
    // The body carries the reason ("… was retired at 2026-09-25"); the bare status hid it. No body
    // readable: the status alone is still the error.
    const e = ollamaHttpError(r.status, await r.text().catch(() => ''));
    if (e.gone) modelHealth.noteGone(model, e);
    throw e;
  }
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '', acc = '', finished = false;
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl; while ((nl = buf.indexOf('\n')) >= 0) {
      const s = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!s) continue;
      let j; try { j = JSON.parse(s); } catch { continue; }
      if (j.error) throw new Error(j.error);
      const t = j.message && j.message.content; if (t) { acc += t; onDelta(t); }
      if (j.done === true) finished = true;
    }
  }
  // requireDone (the demo lane): a stream cut before Ollama's final `done: true` record is a
  // broken reply, not a short one.
  if (requireDone && !finished) throw new Error('the reply was cut off · 回复中断');
  return acc;
}

// Resolve the overridable system prompts for one chat turn, for EVERY lane, each piece capped at
// OVERRIDABLE_PROMPT_MAX. Precedence for the guard and the per-app directive: profile override →
// config default → (per-app only) the opts.system the app itself sent. A blank/absent override
// falls through, so we never send an empty system message. `app` is the app slug (opts.app);
// null for the main chat. Profile load failure → {} → pure defaults.
// `o.agent`: the AGENT lane (Claude CLI, tools) gets the profile's own global words only — never the FAST-lane
// guard (config system_prompts.global / ollama_system, else fastLaneGuard), which says "You have NO tools".
// MEASURED 2026-11-11 (real CLI, sonnet, the confined app lane): with that guard a summary turn with an attached
// page image answered "I can't open the attached image because I have no tools" without calling Read; without
// it the same turn Read the file and described it (owner screenshot, note-features.md I).
function resolveSystemPrompts(user, app, optsSystem, o = {}) {
  const prof = loadProfile(wsDir(user)) || {};
  const over = (prof.systemPrompts && typeof prof.systemPrompts === 'object') ? prof.systemPrompts : {};
  const sp = cfg.system_prompts || {};
  const pick = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, OVERRIDABLE_PROMPT_MAX) : null);   // ONE cap, every lane
  // Precedence UNCHANGED (profile override → operator config → built-in). Only the BUILT-IN is
  // now surface-aware: `app` set = a mini-app chat, which HAS a model chooser above its
  // composer; `app` absent = the shell's main chat, which has none, so it must not be told to
  // "switch the model selector". ONE prompt with one parameterized clause lives in
  // lib/config.mjs (R3) — this is only the surface decision.
  const global = pick(over.global) || (o.agent === true ? null : (pick(sp.global) || fastLaneGuard(app ? 'app' : 'shell')));
  const appOver = app && over.apps ? pick(over.apps[app]) : null;
  const appDefault = app && sp.apps ? pick(sp.apps[app]) : null;
  const appSent = pick(optsSystem);
  return { global, app: appOver || appDefault || appSent || null };
}

// The uploaded attachments that are really on disk — ONE resolver for every lane (R3). It was
// spelled out three times (ollama base64 read, codex -i, and nowhere at all for Claude), each
// with its own `path.join(wsDir(user), a.path)`; a client-supplied `path` reaching path.join
// unchecked is a traversal, so this goes through the repo's own safeJoin gate instead.
function attachmentFiles(user, attachments) {
  const base = wsDir(user);
  const asked = (Array.isArray(attachments) ? attachments : []).filter((a) => a && typeof a.path === 'string');
  const found = asked
    .map((a) => ({ rel: a.path, abs: safeJoin(base, a.path) }))
    .filter((f) => { try { return f.abs && fs.existsSync(f.abs); } catch { return false; /* unreadable = not attached: counted in `lost` and said (R14) */ } });
  found.lost = asked.length - found.length;   // attachments named but not on disk: attachmentPrompt says so, never a picture the model did not get (R14)
  return found;
}
// The line that makes an attachment VISIBLE to the Claude agent lane. runClaude has no image
// channel at all — the CLI takes one prompt on stdin and sees a picture only by opening it with
// its own Read tool — so the files are NAMED, workspace-relative (the CLI's cwd is wsDir). Empty
// string when nothing is attached, so an ordinary turn's prompt stays byte-identical to before.
// Without this, "attach a screenshot with no model chosen" reaches the agent with the image
// never mentioned and it answers about a picture it cannot see (R14: that is a failure, not a pass).
const ATTACHMENT_LOST = (n) => `\n\n${n} attached file${n > 1 ? 's were' : ' was'} not found and ${n > 1 ? 'are' : 'is'} NOT part of this turn — do not describe ${n > 1 ? 'them' : 'it'}; say ${n > 1 ? 'they' : 'it'} could not be read.`;
function attachmentPrompt(files) {
  const lost = files.lost > 0 ? ATTACHMENT_LOST(files.lost) : '';
  if (!files.length) return lost;
  const many = files.length > 1;
  return `\n\nAttached file${many ? 's' : ''} in this workspace — read ${many ? 'them' : 'it'} first, then answer:\n`
    + files.map((f) => `- ${f.rel}`).join('\n') + lost;
}

/* ══ PA_CHAT_LANE_BEGIN ── which lane answers this turn ═══════════════════════════════════════
   Extracted verbatim by test/chat-image-lane.test.mjs — keep it one self-contained block. */
// The chat UI only uploads images (accept="image/*"), so ANY attachment needs a lane that can
// SEE one. Never decide from the filename extension (HEIC / stripped names slip through).
//
// THE BUG THIS SHAPE EXISTS FOR: the guard used to be `!chosen || chosen.provider === 'ollama'`.
// The shell's main chat sends NO `model` field at all (web/index.html submitSend), so `!chosen`
// was TRUE for every main-chat turn — attaching a screenshot there silently swapped the Claude
// AGENT lane (full tools) for cfg.vision_default, a fast Ollama lane with NO tools, which then
// answered the honesty guard's "I can't do that in fast mode, switch the model selector" about a
// selector the shell does not have. A user asking for a code fix from a screenshot got refused.
//
// So: reroute ONLY an EXPLICITLY chosen text-only (Ollama) lane. No chosen lane means the default
// AGENT lane, and both agent lanes read images — Claude through its Read tool (see
// attachmentPrompt), Codex through `-i`. Demoting to a no-tools lane is never the answer.
//
// CONFINED TURNS NEVER REACH CODEX (2026-10-11). The Codex lane runs `--sandbox read-only`, which
// stops writes but NOT reads: measured with `codex sandbox -c sandbox_mode="read-only" -- cat
// ../secret.txt` from a throwaway workspace, it printed the parent's file (codex-cli 0.151.0), and
// no codex flag narrows reads to the workspace. So a confined turn (an app's, or a member's) that
// picked GPT could read config.json — tokens, keys, password hashes — and hand it back to the app.
// It goes to the default AGENT lane instead (Claude, confined by agentArgs), and says so.
//
// A LANE THAT IS NO LONGER SERVED (2026-10-12). An id dropped from chat_models resolved to null —
// the Claude agent lane, silently — and an Ollama model retired upstream failed every turn with
// "Ollama HTTP 410". Both now fall back to the DEFAULT, the first entry still served (lib/config.mjs:
// "First entry is the DEFAULT"), and say so. `gone` is { modelString: reason } from
// lib/model-health.mjs; /api/models filters the chooser with the SAME laneServed (R3).
function laneServed(lane, gone) { return !(lane && lane.provider === 'ollama' && gone && gone[lane.model]); }
const IMAGE_ATTACHED = 'Image attached · 已附图片 — ';
function servedLane(models, model, gone) {
  const asked = models.find((mm) => mm.id === model) || null;
  if (!model || (asked && laneServed(asked, gone))) return { chosen: asked, was: null };
  const fb = models.find((mm) => laneServed(mm, gone)) || null;   // nothing served at all → null → the agent lane
  return { chosen: fb, was: asked ? `${asked.label} is ${gone[asked.model]}` : `"${String(model).slice(0, 40)}" is no longer offered` };
}
function pickChatLane({ chatModels, model, hasImage, visionDefault, confined, gone }) {
  const models = chatModels || [];
  const { chosen, was } = servedLane(models, model, gone || {});
  const r = routeLane({ models, chosen, hasImage, visionDefault, confined, gone: gone || {} });
  if (!was) return r;
  // Name the lane that REALLY answers. A reroute after the fallback (an image, a confined turn)
  // moved it again and its own status already says where; naming the fallback too would be false.
  if (r.status) return { lane: r.lane, status: `${was}; ${r.status}` };
  const now = r.lane ? r.lane.label : 'Claude';
  return { lane: r.lane, status: `${was} — using ${now} · 该模型已不可用，改用 ${now}` };
}
// The Codex rule is applied to the lane that would REALLY answer, after every reroute. It used to
// look at `chosen` only, and the image reroute then returned vision_default unchecked: a confined
// turn on a fast lane with a picture reached Codex whenever vision_default named it (R13 review,
// 2026-10-12). lib/config.mjs now refuses such a vision_default at load; this stays the rule for
// any reroute added later. A non-null status with a Codex lane comes only from the image reroute.
function routeLane({ confined, ...turn }) {
  const r = rerouteImage(turn);
  if (confined === false || !r.lane || r.lane.provider !== 'codex') return r;
  const why = `${r.lane.label} can read files outside this workspace, so this request uses Claude · 此请求改用 Claude（GPT 可读取工作区外的文件）`;
  return { lane: null, status: r.status ? `${IMAGE_ATTACHED}${why}` : why };
}
function rerouteImage({ models, chosen, hasImage, visionDefault, gone }) {
  if (!hasImage || !chosen || chosen.provider !== 'ollama') return { lane: chosen, status: null };
  const vd = models.find((mm) => mm.id === visionDefault); // the default itself lives in lib/config.mjs (R3)
  if (!vd || vd.id === chosen.id) return { lane: chosen, status: null };   // already the vision lane, or none configured
  // The vision lane is gone: the chosen text-only lane would answer about a picture it never saw
  // (R14). The agent lane reads the file itself (attachmentPrompt), so it takes the turn, and says so.
  if (!laneServed(vd, gone)) return { lane: null, status: `${IMAGE_ATTACHED}${vd.label} is ${gone[vd.model]}, so Claude reads it · 看图模型不可用，改用 Claude` };
  return { lane: vd, status: `${IMAGE_ATTACHED}using ${vd.label}` };
}
/* ══ PA_CHAT_LANE_END ══ */

// One turn at a time per conversation (lib/convo-lock.mjs); different conversations stay parallel.
// TODO(R4 seam): chat() and this wrapper leave web.mjs together with the lane dispatch named below.
const convoLocks = createConvoLocks();
const CHAT_HEAD = { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' };
async function chat(req, res, user, body) {
  const b = body || {};
  if (typeof b.message !== 'string' || !b.message.trim()) return chatTurn(req, res, user, b, () => null);   // the 400 needs no lock
  const convoId = typeof b.convoId === 'string' ? b.convoId : '';
  // Installed BEFORE the lock: a oneShot caller that leaves while queued fires 'close' before the
  // lock frees, and a listener added after it would never hear it (the queued turn then ran anyway).
  const cancel = b.oneShot === true ? cancelOnClose(res) : null;
  return withConvoTurn(convoLocks, { userId: user.id, convoId, onQueued: () => {
    res.writeHead(200, CHAT_HEAD); res.flushHeaders?.();
    res.write(JSON.stringify({ type: 'status', text: QUEUED_TURN_TEXT }) + '\n');
  } }, (hold) => chatTurn(req, res, user, b, hold, cancel));
}

async function chatTurn(req, res, user, body, hold, cancel = null) {
  const { message, convoId, attachments, app, label, model, system, assess } = body;
  const oneShot = body.oneShot === true;   // the literal true only (docs/adr/0008)
  if (typeof message !== 'string' || !message.trim()) return send(res, 400, 'application/json', '{"error":"empty message"}');
  // A oneShot caller that left while this turn was queued: nothing is saved, nothing spawns.
  if (cancel && cancel.signal.aborted) { audit('chat-cancelled', { who: user.id, convo: convoId || '', queued: true }); if (!res.writableEnded) res.end(); return; }
  // Decided ONCE per turn, from the shell relay's header OR the app slug (lib/agent-origin.mjs),
  // and handed to every lane below — the job resolver, Claude, Codex and the Verify panel.
  const origin = { fromApp: appOriginated(req.headers, { app }), app: typeof app === 'string' ? app : '' };
  const tag = convoTag(origin);
  // Read-before-write, three-state (empty-overwrite class, 2026-09-02 round 2):
  // "the chat file is damaged" used to look exactly like "there is no such
  // chat", so this turn silently started a NEW conversation under a NEW id. The
  // app then stored that new id as its verse→thread pointer, and the real
  // history became unreachable — a live-looking chat with the past deleted.
  // Refuse instead: nothing is written, the file stays on disk for repair, and
  // the client gets 500 file_unreadable (bilingual) before any header is sent.
  const prior = convoId ? loadConvoState(user, convoId) : { state: FILE_ABSENT };
  if (prior.state === FILE_UNREADABLE) {
    const e = new Error(`this conversation could not be read — nothing was changed · 无法读取该对话，未做任何修改 (${prior.error})`);
    e.code = FILE_UNREADABLE_CODE;
    if (res.headersSent) { res.end(JSON.stringify({ type: 'error', text: e.message }) + '\n'); return; }   // queued: the stream is already open
    throw e;
  }
  let convo = prior.state === FILE_OK ? prior.value : null;
  // A conversation belongs to the surface that started it (lib/agent-origin.mjs, bypass A): an
  // app that names one of the composer's conversations — or another app's — gets a fresh one of
  // its own, and the conversation it named is not touched. Not a refusal: a renamed app's stale
  // binding must not brick its chat, and `replaced` below already tells the client to rebind.
  if (convo && !convoReachable(convo, origin)) {
    audit('convo-foreign-turn', { who: user.id, convo: convo.id, owner: convo.app || 'composer', from: tag || 'composer' });
    convo = null;
  }
  // A convoId that resolves to NOTHING is a stale binding — almost always a conversation the user
  // deleted, whose scope still points at it. Starting a fresh one is right (refusing would brick
  // that scope for ever), but doing it SILENTLY is what let the client keep the dead id and repeat
  // the substitution on every turn. Say so, so the client can rebind.
  const replaced = !!(convoId && !convo);
  // app chats are tagged so listConvos can keep them OUT of the main chat drawer;
  // they are still persisted and reloadable by the app via /api/convos/:id.
  if (!convo) { convo = { id: newId(), title: (tag ? appTitle(message) : message.trim().slice(0, 48)), sessionId: null, messages: [], updated: Date.now(), app: tag, label: label || undefined }; }
  if (convo.id !== convoId) hold(convo.id);   // a new conversation: a follow-up naming it queues behind this turn
  convo.messages.push({ role: 'me', text: message, attachments: Array.isArray(attachments) ? attachments.slice(0, 10) : undefined });
  convo.updated = Date.now();
  saveConvo(user, convo); // appears in history now, not after the reply
  // The turn's own clock. "took Xs" used to be painted by the client at settle time and never
  // stored, so reopening a conversation lost it. Stamped here, before any lane runs, so every
  // lane is measured the same way and the number survives a reload on every device.
  const startedAt = Date.now();
  if (!res.headersSent) { res.writeHead(200, CHAT_HEAD); res.flushHeaders?.(); }   // a queued turn opened it already
  const alive = () => !res.writableEnded && !res.destroyed;
  const line = (o) => { if (alive()) res.write(JSON.stringify(o) + '\n'); };
  line({ type: 'convo', id: convo.id, title: convo.title, ...(replaced ? { replaced: true, requested: String(convoId).slice(0, 64) } : {}) });
  const beat = setInterval(() => line({ type: 'ping' }), 20000); // keep iOS Safari from aborting on idle
  // ── Chat → job ─────────────────────────────────────────────────────────────────────────
  // "every morning tell me the pollen" is an instruction to set something up, not a question
  // to answer once. Detection is DETERMINISTIC (lib/jobs/intent.mjs) and deliberately strict:
  // hijacking an ordinary question with a job card is far worse than missing one, which the
  // user simply rephrases. Main chat only — a job appearing out of an app's chat would be a
  // surprise, and apps have their own surfaces.
  // Nothing is created here: the draft is OFFERED, and the person presses Create. That is the
  // same paused-by-default rule the editor and the resolver already follow.
  // `origin.fromApp`, not `app`: an app request whose slug is forged empty still carries the
  // relay's header, and must not reach this resolver in the owner's unrestricted lane.
  if (!origin.fromApp && looksLikeJob(message).job) {
    try {
      const prof = loadProfile(wsDir(user)) || {};
      const out = await resolvePrompt(message, {
        ask: (q) => enqueue(() => runAgent(q, agentArgs(user, fastBaseArgs(user, origin), origin), wsDir(user), RESOLVE_MS)).then((r) => r.text),
        tools: toolManifests(), runnable: runnableTools(),
        profile: { postcode: prof.postcode || '', name: prof.name || '' },
      });
      audit('job-chat-draft', { who: user.id, ok: !!out.ok, tool: out.job ? out.job.plan.tool : null });
      if (out.ok || (out.ask && out.ask.length)) {
        clearInterval(beat);
        line({ type: 'job-draft', ...out });
        convo.messages.push({ role: 'md', text: out.ok
          ? `I can set that up as a job · 可以设置为定时任务\n\n**${out.job.title}** — ${humanSchedule(out.job.schedule)}`
          : `I can set that up, but I need: ${out.ask.map((a) => a.input).join(', ')} · 还需要补充信息` });
        convo.updated = Date.now();
        saveConvo(user, convo);
        line({ type: 'done', ok: true, text: '' });
        return res.end();
      }
      // Could not resolve it — fall through and answer the message normally rather than
      // reporting a failure the person did not ask for.
    } catch (e) { audit('job-chat-draft-error', { who: user.id, error: String(e && e.message || e) }); }
  }
  res.on('close', () => clearInterval(beat));
  const files = attachmentFiles(user, attachments);   // ONE resolver, safeJoin-gated (R3)
  const imgs = files.map((f) => f.abs);   // the Codex -i list (the chooser's lane and the sign-in fallback), from the same resolver
  const hasImage = files.length > 0;
  if (files.lost > 0) line({ type: 'status', text: `${files.lost} attachment(s) not found — not sent · ${files.lost} 个附件未找到，未发送` });   // every lane: said, never assumed seen (R14)
  // PA_CHAT_LANE (above) owns the decision; the status line appears ONLY when a reroute really
  // happened, never as decoration on a turn that was already going where it was going.
  // A oneShot turn asks PA_CHAT_LANE about cfg.one_shot_model instead (live; '' = the request's).
  let { lane: chosen, status: laneStatus } = pickChatLane({
    chatModels: cfg.chat_models, model: oneShot ? oneShotModel(cfg, model) : model, hasImage, visionDefault: cfg.vision_default,
    confined: agentConfined(user, origin), gone: modelHealth.gone() });
  if (laneStatus) line({ type: 'status', text: laneStatus });
  let fellBack = false;   // lib/chat-outcome.mjs: ONE retry on the agent lane for an app turn a fast lane left blank
  try {
    let r;
    const appsBefore = snapshotApps(appsDir(user));   // lib/app-postcheck.mjs: scan only what this turn writes
    // TODO(R4 seam): the retry loop and the lane dispatch inside it leave chat() together (see the seam named below).
    for (;;) {
    if (chosen && chosen.provider === 'ollama') {
      // Fast lane: text-only Ollama model. Stateless, so send recent history for context.
      // Global honesty guard + the app's own directive (e.g. the Bible app's "reply in Chinese
      // with English keywords") — as SYSTEM messages so fast-lane models actually follow the
      // language/behavior instruction instead of a buried user-turn line. Each resolves
      // profile override → config default → the app-sent opts.system fallback (see below).
      const prompts = resolveSystemPrompts(user, app, system);
      // The language rule rides OUTSIDE the override chain, like agentCapabilities on the agent
      // lane: prompts.global is replaceable by a profile override, and being answered in your own
      // language must not be something a customised assistant can lose. It matters most here —
      // most fast lanes are Chinese-trained models.
      const sys = [prompts.global, prompts.app, REPLY_LANGUAGE_RULE]   // each piece capped by resolveSystemPrompts
        .filter(Boolean).map((c) => ({ role: 'system', content: c }));
      const history = [...sys, ...convo.messages.slice(-20).filter((m) => !m.failed)   // a stored lane failure is not an answer to learn from
        .map((m) => ({ role: m.role === 'md' ? 'assistant' : 'user', content: String(m.text || '') }))
        .filter((m) => m.content)];
      // Vision: attach uploaded images (base64) to the last user turn so vision-capable Ollama
      // models (e.g. glm-5.3-flash) actually SEE them — text-only would be a vacuous answer.
      if (hasImage) {
        const b64 = files
          .map((f) => { try { return fs.readFileSync(f.abs).toString('base64'); } catch { return null; } })
          .filter(Boolean);
        if (b64.length) {
          history[history.length - 1].images = b64;   // the last turn is always the just-pushed user message (message validated non-blank at entry)
        }
      }
      const text = await streamOllama({ url: cfg.ollama_url, model: chosen.model, messages: history,
        onDelta: (t) => line({ type: 'delta', text: t }) });
      r = { ok: true, text };
    } else if (chosen && chosen.provider === 'research') {
      // Research lane（联网研究）: Tavily finds → Firecrawl reads → the configured fast
      // lane reasons over ONLY the fetched excerpts (lib/research.mjs; deps injected
      // like assess lanes, R3). Privacy contract: ONLY the question text goes to search
      // and ONLY result URLs to the scraper — never history, prompts, cfg, attachments.
      const lane = (cfg.chat_models || []).find((mm) => mm.id === cfg.research.llm) || {};
      r = await runResearch(message, {
        research: cfg.research, keys: { tavily: cfg.tavily_key, firecrawl: cfg.firecrawl_key },
        lanes: { streamOllama }, ollamaUrl: cfg.ollama_url, model: lane.model,
        onStatus: (t) => line({ type: 'status', text: t }),
        onDelta: (t) => line({ type: 'delta', text: t }) });
    } else if (chosen && chosen.provider === 'codex') {
      // GPT via Codex (on the ChatGPT subscription). An agent → non-streaming: a status while it
      // works, then its final message. It reads images (-i). ONE lane function, shared with the
      // Claude lane's sign-in fallback below (lib/lane-codex.mjs, R3).
      r = await runCodexLane({ convo, prompt: message, images: imgs, cwd: wsDir(user), model: chosen.model,
        timeoutMs: cfg.task_timeout_minutes * 60000, runCodex, enqueue, onStatus: (t) => line({ type: 'status', text: t }) });
    } else {
      // Agent lane: Claude CLI (tools + resume). A chosen Claude tier just adds --model.
      // This is also where a main-chat turn WITH an image lands now, so the attachment has to
      // reach it — runClaude has no image channel, so attachmentPrompt names the files and the
      // agent opens them with Read (cwd is the workspace those paths are relative to).
      const tierArgs = (chosen && chosen.model) ? [...cfg.claude_args, '--model', chosen.model] : cfg.claude_args;
      // Before agentArgs, so a confined lane carries it too (it is not a permission flag). Read from the
      // LIVE cfg on every turn, so a config.json edit applies to the next one (docs/adr/0011).
      const baseArgs = oneShot ? oneShotBaseArgs(tierArgs, cfg.one_shot_args, memberArgsOf(user, origin)) : tierArgs;
      const extraArgs = agentArgs(user, baseArgs, origin);   // owner's own chat: unrestricted. an app's turn or a member's: no skip-permissions.
      const cancelled = () => !!cancel && cancel.signal.aborted;   // chat() installs it for oneShot only: a conversation turn is never stopped
        // The SAME resolved skill the fast lanes get (profile override → config → built-in).
        // It was resolved only inside the ollama branch, so an app's directive applied on one
        // lane and vanished on another — the same question answered two ways.
        const agentPrompts = resolveSystemPrompts(user, app, system, { agent: true });   // no fast-lane "NO tools" guard on the tool lane
      // SCAR (2026-09-11): when the Claude session is dead ("No conversation found") or was
      // never saved, the fallback ran Claude fresh with only the current `message` — no history.
      // For a follow-up question ("What signs refers to?") Claude had zero context about which
      // verse was being studied, producing wildly off-topic clarification requests.
      // Fix: build a history block from convo.messages and inject it into the prompt whenever
      // Claude cannot resume. The prior messages already include the contextPrefix from the first
      // turn (which names the passage), so Claude recovers the full conversation context.
      const priorMsgs = convo.messages.slice(0, -1); // all messages BEFORE the current one
      const buildHistoryPrompt = (msgs) => {
        const block = msgs.filter((m) => !m.failed).slice(-10).map((m) =>
          (m.role === 'md' ? 'Assistant' : 'User') + ': ' + (m.text || '')).join('\n\n---\n\n');
        return '[Resuming conversation — prior context:]\n\n' + block +
          '\n\n[Current message:]\nUser: ' + message + attachmentPrompt(files);
      };
      // A conversation turn always includes recent history — same as the Ollama lane's
      // convo.messages.slice(-20). When resumeId is alive the block is redundant (and costly when
      // turns are large); when the session is dead or never saved it is the only context there is.
      // A oneShot turn is ONE self-contained answer (docs/adr/0008 item 9): no --resume, no block,
      // exactly its message. MEASURED 2026-10-13: the studio's tweaks share one convo, so each
      // resumed a session holding every earlier SVG AND replayed them here, 25k → 313k tokens in six
      // turns, past the 200k the CLI serves without the 1M mode a subscription bills as credits.
      const resumeId = oneShot ? null : convo.sessionId;
      const histPrompt = (priorMsgs.length && !oneShot) ? buildHistoryPrompt(priorMsgs) : message + attachmentPrompt(files);
      const opts = { claudeCmd: cfg.claude_cmd, extraArgs, cwd: wsDir(user), prompt: message + attachmentPrompt(files),
          // agentCapabilities LAST and outside the override chain: a profile systemPrompts.global
          // override replaces the guard above, and a capability list it could delete is not one
          // any app author could rely on. A oneShot turn builds no app, so it skips the ~3.7k-char
          // app contract; the language rule and the confined note still ride.
          systemPrompt: [agentPrompts.global, agentPrompts.app, agentCapabilities(laneRole(user, origin), oneShot ? null : APP_CONTRACT)].filter(Boolean).join('\n\n'),
        resumeId, timeoutMs: cfg.task_timeout_minutes * 60000, onChild: cancel ? cancel.onChild : undefined,
        onDelta: (t) => line({ type: 'delta', text: t }), onTool: (n, b) => line({ type: 'status', text: `${n}${b ? ` — ${b}` : ''}` }) };
      r = await enqueue(async () => {
        if (cancelled()) return CHAT_CANCELLED;   // still queued when its caller left: never spawn
        let x = await runClaude({ ...opts, prompt: histPrompt });
        // Only a conversation turn resumes, and it is never cancelled, so no retry follows a cancel.
        if (!x.ok && opts.resumeId && /No conversation found/i.test(x.text || '')) x = await runClaude({ ...opts, resumeId: null, prompt: histPrompt });
        return x;
      });
      // A killed child "answers" with its raw stream-json so far — never store that as a reply.
      if (cancelled()) { r = CHAT_CANCELLED; audit('chat-cancelled', { who: user.id, convo: convo.id, from: tag || 'composer' }); }
      // The node's Claude sign-in has expired (lib/claude-auth.mjs, docs/adr/0024): record it for the
      // watchdog, then an owner's composer turn is answered by the Codex lane with the SAME prompt
      // (the reply says so); a oneShot turn gets the sign-in line (a component expects one Claude
      // answer, not a different agent's), and so does a confined turn — an app's or a member's —
      // because CONFINED TURNS NEVER REACH CODEX (PA_CHAT_LANE; the Codex lane cannot be confined).
      // TODO(R4 seam): lane dispatch leaves chat() with the split named above.
      else if (!r.ok && isAuthFailure(r.text)) {
        claudeAuth.noteFailure(r.text);
        r = (oneShot || agentConfined(user, origin)) ? { ok: false, text: CLAUDE_SIGNIN_EXPIRED } : await codexFallback({ chatModels: cfg.chat_models, claudeError: r.text,
          convo, prompt: histPrompt, images: imgs, cwd: wsDir(user), timeoutMs: cfg.task_timeout_minutes * 60000,
          runCodex, enqueue, onStatus: (t) => line({ type: 'status', text: t }) });
      }
      // A oneShot run's session holds one answer, so it never becomes the conversation's: the next
      // conversation turn resumes the session it had (or none) and its history block carries these turns.
      if (r.sessionId && !oneShot) convo.sessionId = r.sessionId;
    }
    if (!isBlankAnswer(r) || !shouldFallBackToAgent({ lane: chosen, fromApp: origin.fromApp, alreadyFellBack: fellBack })) break;
    console.log(chatTurnLogLine({ app: tag, lane: chosen, ok: false, textLen: 0, ms: Date.now() - startedAt, code: 'empty' }));
    line({ type: 'status', text: fallbackStatusText(chosen) });
    chosen = null; fellBack = true;   // null = the Claude agent lane (PA_CHAT_LANE); confined exactly as any app turn there
    }
    const turnMs = Date.now() - startedAt;
    // A blank answer is the named lane's FAILURE, stored and shown as one — never { text:'' }, which
    // the app painted as "No response" with nothing saying which lane failed (lib/chat-outcome.mjs).
    const blank = isBlankAnswer(r);
    if (blank) r = { ...r, ok: false, text: laneFailureText(chosen, r && r.timedOut ? 'it timed out · 超时' : null, turnMs) };
    console.log(chatTurnLogLine({ app: tag, lane: chosen, ok: r.ok !== false && !blank, textLen: blank ? 0 : r.text.length, ms: turnMs,
      code: blank ? 'empty' : (r.ok === false ? (r.timedOut ? 'timeout' : 'failed') : null), fellBack }));
    if (blank) line({ type: 'error', text: r.text });   // PAChat shows an 'error' line as ⚠ + its text, not as the model's answer
    // TODO(R4 seam): post-turn checks leave chat() with the lane dispatch. A warning is appended, never a rewrite.
    const appWarn = blank ? '' : appBuildWarnings(appsDir(user), appsBefore);
    if (appWarn) { r = { ...r, text: `${r.text}\n\n${appWarn}` }; line({ type: 'status', text: appWarn }); }
    // by: the lane that ACTUALLY answered (a confined turn's GPT pick runs on Claude), shown under the answer.
    const by = chosen ? chosen.label : 'Claude';
    const mdMsg = { role: 'md', text: r.text || '', ms: turnMs, by, ...(blank ? { failed: true } : {}) };
    convo.messages.push(mdMsg);
    // Over the cap the oldest turns are ARCHIVED beside the conversation, never
    // erased (lib/convo-archive.mjs). What this replaces — `convo.messages =
    // convo.messages.slice(-200)` — wrote the shortened array straight to disk
    // and said nothing: user-typed text deleted behind a normal-looking reply.
    // The archive write happens FIRST, so a failure throws with the full array
    // still in hand and the catch below reports it (R5).
    const archived = archiveOverflow(convosDir(user), convoFile(user, convo.id), convo);
    convo.updated = Date.now();
    saveConvo(user, convo);
    if (archived) {
      audit('convo-archive', { who: user.id, convo: convo.id, count: archived.count, file: archived.file });
      line({ type: 'status', text: `This chat passed ${CONVO_MAX_MESSAGES} messages — the ${archived.count} oldest were archived to ${archived.file}, not deleted · 本对话超过 ${CONVO_MAX_MESSAGES} 条，最早的 ${archived.count} 条已归档，未删除` });
    }
    // Multi-LLM assessment ("Verify · 校验"): detached — the stream ends now, results
    // attach to this turn (mdMsg.assess) and the app polls the existing convo GET.
    if (assess) line({ type: 'assess', ...startAssess(user, convo, mdMsg, message, chosen ? chosen.id : 'claude', app, system, origin) });
    line({ type: 'done', ok: r.ok, text: blank ? '' : (r.text || ''), by });
  } catch (e) {
    console.log(chatTurnLogLine({ app: tag, lane: chosen, ok: false, textLen: 0, ms: Date.now() - startedAt, code: e.code || e.status || e.name, fellBack }));
    line({ type: 'error', text: e.message });
  } finally {
    clearInterval(beat);
    if (alive()) res.end();
  }
}


// Launch the detached Multi-LLM assessment for the turn just answered (fire-and-forget —
// all orchestration lives in lib/assess.mjs, R4). Stamps the turn with a stable `aid`
// (a cap eviction can shift indices) and returns the {type:'assess'} line payload.
function startAssess(user, convo, mdMsg, message, fastModelId, app, system, origin) {
  mdMsg.aid = newId();
  saveConvo(user, convo);
  // Under the conversation's lock (lib/convo-lock.mjs): this runs long after the turn released it,
  // and an unlocked read-modify-write could save over a newer turn (or a turn over this verdict).
  const persist = (a) => withConvoTurn(convoLocks, { userId: user.id, convoId: convo.id, onQueued: () => {} }, async () => {
    const c = loadConvo(user, convo.id);
    const t = c && c.messages.find((m) => m.aid === mdMsg.aid);
    if (!t) return; // convo/turn deleted or trimmed away meanwhile — nowhere to attach; the client's poll deadline surfaces the absence (R5)
    t.assess = a; c.updated = Date.now(); saveConvo(user, c);
  });
  runAssessment({ cfg, question: message, cwd: wsDir(user),
    convoMessages: convo.messages.slice(0, -1).slice(-20), // the slice the fast lane saw — WITHOUT its answer (R14: the fast reply must not leak into the panel)
    prompts: resolveSystemPrompts(user, app, system), fastModelId,
    // The panel is an agent lane too: its Claude calls resolve through agentArgs, and a confined
    // turn's panel never runs Codex (see PA_CHAT_LANE) — lib/assess.mjs refuses both otherwise.
    lanes: { streamOllama, runClaude, runCodex, enqueue,
      agentArgs: (base) => agentArgs(user, base, origin), codexAllowed: !agentConfined(user, origin) }, persist })
    .catch((e) => console.error('[assess] orchestrator crashed:', e)); // runAssessment persists its own errors as state:'error'; this only catches a synchronous setup throw
  return { state: 'started', aid: mdMsg.aid, models: pickPanel(cfg, fastModelId).panel.map((m) => m.id), timeoutMinutes: cfg.assess_timeout_minutes };
}

// Demo mode (lib/demo.mjs): the visitor store and quota counters exist on every node, used only
// while cfg.demo is on — read per request, so turning it on in config.json needs no restart.
// TODO(R4 seam): with the other route tables once web.mjs is split.
const demoUsers = makeDemoUsers(ROOT);
const demoGate = makeSigninGate({ cfg, users: demoUsers });   // AI sign-in bindings; userFor reads them, so built before it is called
if (demoOn(cfg) && cfg.users.length) throw new Error('demo mode: config.json must have no users ("users": []); a demo node never runs accounts, their jobs or reminders');
const demoRoutes = makeDemoRoutes({ cfg, root: ROOT, send, readBody, BODY_LIMITS, users: demoUsers, gate: demoGate,
  store: makeQuotaStore(path.join(ROOT, DEMO_QUOTA_FILE)), meter: makeDiskMeter(), provisionWorkspace, audit,
  userFor, loadConvoState, saveConvo, newId, streamOllama,
  resolveSystemPrompts, chatHead: CHAT_HEAD, appContract: APP_CONTRACT });
const server = http.createServer(async (req, res) => {
  // send() and sendHtml() are called from ~120 places that have no `req` in scope; carrying the two
  // headers they need on `res` avoids changing every one of those signatures.
  res._paAccept = req.headers['accept-encoding'] || '';
  res._paNoneMatch = req.method === 'GET' ? (req.headers['if-none-match'] || '') : '';
  let url;
  try { url = new URL(req.url, 'http://x'); }
  catch { return send(res, 400, 'text/plain', 'bad request'); }   // a malformed target must never reach the async handler's unhandled path
  const p = url.pathname;
  // The home-node fallback (lib/local-origin.mjs): the shell on the public name calling this node by its local name.
  // TODO(R4 seam): with the shell routes in lib/version-routes.mjs.
  const cors = corsHeaders(req, cfg);
  if (cors) { for (const [k, v] of Object.entries(cors)) res.setHeader(k, v); if (req.method === 'OPTIONS') return send(res, 204, 'text/plain', null); }
  try {
    if (demoOn(cfg) && await demoRoutes(req, res, p)) return;   // demo mode: allow-list first, fail closed (lib/demo.mjs)
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      const html = readShell(ROOT)
        .replace('<!--APP_VERSION-->', appVersion())
        .replace('<!--APP_NOTES-->', embedInTemplateLiteral(appNotesJson(ROOT, undefined, buildId.head())));
      return sendHtml(res, demoOn(cfg) ? injectDemoBoot(html, cfg) : html);
    }
    // The service worker (offline-first, lib/offline.mjs): unauthenticated like the shell, scope /, revalidated like HTML.
    // TODO(R4 seam): this and /api/offline-config below belong with the shell routes in lib/version-routes.mjs.
    if (req.method === 'GET' && p === SW_PATH) return sendFile(res, path.join(ROOT, 'web', 'sw.js'), { type: 'application/javascript', extra: { 'cache-control': 'no-cache' } });
    // TODO(R4 seam): /api/build, appVersion and plusN are the version routes — move them to lib/version-routes.mjs.
    // What code the node runs now (ADR 0026): the shell's PAUpdate compares it with the footer it loaded
    // with. Unauthenticated like the shell page itself, which already carries both strings; nothing else.
    if (req.method === 'GET' && p === '/api/build') return send(res, 200, 'application/json', JSON.stringify({ build: buildId(), version: appVersion() }));
    if (req.method === 'GET' && p === '/manifest.webmanifest') {
      return send(res, 200, 'application/manifest+json', JSON.stringify({
        name: 'superelf', short_name: '管家', start_url: '/', scope: '/',
        display: 'standalone', background_color: '#111514', theme_color: '#111514',
      }));
    }

    // --- First-run setup: create the master (owner) account, OS-install style ---
    if (req.method === 'GET' && p === '/api/setup-status') return send(res, 200, 'application/json', JSON.stringify({ needsSetup: ownerNeedsSetup(cfg.users) }));
    if (req.method === 'POST' && p === '/api/setup') {
      if (!ownerNeedsSetup(cfg.users) || setupBusy) return send(res, 403, 'application/json', '{"error":"already set up · 已初始化"}'); // closes forever once an owner has a password
      const b = await readBody(req, BODY_LIMITS.auth);
      // Everything from here to setupBusy = true is synchronous, so two racing requests cannot both
      // pass: the second sees needsSetup false or setupBusy true (atomic setup, no two owners).
      if (!ownerNeedsSetup(cfg.users) || setupBusy) return send(res, 403, 'application/json', '{"error":"already set up · 已初始化"}');
      const gkeys = [`setup:${clientKey(req)}`];   // per client only: a shared bucket would let anyone lock setup for everyone
      const wait = loginGuard.retryAfter(gkeys);
      if (wait) return send(res, 429, 'application/json', JSON.stringify({ error: lockedMessage(wait) }), { 'retry-after': String(wait) });
      if (!setupCodeOk(ROOT, b.setupCode)) {
        loginGuard.fail(gkeys); audit('setup', { ok: false });
        return send(res, 403, 'application/json', JSON.stringify({ error: 'Wrong or missing setup code — it is in the server log and in the file setup-code · 初始化码错误或缺失，见服务器日志或 setup-code 文件' }));
      }
      const username = String(b.username || '').toLowerCase();
      // Same rules the CLI applies — lib/owner.mjs, one definition (R3).
      const v = validateOwner(cfg.users, username, b.password);
      if (!v.ok) return send(res, /taken/.test(v.error) ? 409 : 400, 'application/json', JSON.stringify({ error: v.error }));
      setupBusy = true;
      let owner;
      try {
        owner = applyOwnerSetup({ users: cfg.users, root: ROOT, username,
          name: b.name, password: b.password, provision: provisionWorkspace });
        await upsertUser(owner);
        cfg.sessions.destroyUser(owner.id);   // a session from the token bootstrap must not outlive setup
        consumeSetupCode(ROOT);
      } finally { setupBusy = false; }   // on a throw the request fails loudly (500) and setup stays open for a retry
      loginGuard.success(gkeys);
      audit('setup', { who: username });
      const token = cfg.sessions.create(owner.id, Date.now());
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, token, uid: owner.id, name: owner.name, role: 'owner' }));
    }
    // --- Public auth (no session required) ---
    if (req.method === 'POST' && p === '/api/login') {
      const b = await readBody(req, BODY_LIMITS.auth);
      const gkeys = [`ip:${clientKey(req)}`, `acct:${String(b.username || (b.token ? '#token' : '')).toLowerCase().slice(0, 40)}`];
      const wait = loginGuard.retryAfter(gkeys);   // check → verify → record has no await between (lib/login-guard.mjs)
      if (wait) return send(res, 429, 'application/json', JSON.stringify({ error: lockedMessage(wait) }), { 'retry-after': String(wait) });
      let u = findLogin(b.username);
      // Always run one scrypt so timing does not reveal whether the user exists.
      const okPw = verifyPassword(b.password, (u && u.passHash) || DUMMY_HASH);
      let ok = !!(u && u.status === 'active' && u.passHash && okPw);
      const byPin = ok;   // only a PIN success clears the counters: a token for another account must not reset this name's
      // Bootstrap: sign in with a config API token, then set a PIN in Settings — ONLY for an account
      // that has no PIN yet. Once it has one, its token is an API key (Bearer, e.g. the health and
      // meal Shortcuts) and never makes a browser session.
      if (!ok && b.token) {
        for (const cand of cfg.users) if (cand.status === 'active' && !cand.passHash && tokenOk(b.token, cand.token)) { u = cand; ok = true; break; }
      }
      audit('login', { who: String(b.username || '').slice(0, 40), ok: !!ok });
      if (!ok) { loginGuard.fail(gkeys); await sleep(400); return send(res, 401, 'application/json', '{"error":"Wrong username or password · 用户名或密码错误"}'); }
      if (byPin) loginGuard.success(gkeys.slice(1));   // the account only: one member's own good login must not reset the client's count
      const token = cfg.sessions.create(u.id, Date.now());
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, token, uid: u.id, name: u.name, role: u.role }));
    }
    if (req.method === 'POST' && p === '/api/register') {
      // Closed until the owner exists: users.mjs promotes the first account to owner, and a
      // pending name could squat the owner's. Every attempt counts against the client (scrypt + a write).
      if (ownerNeedsSetup(cfg.users)) return send(res, 403, 'application/json', '{"error":"node not set up yet · 节点尚未初始化"}');
      const rkeys = [`reg:${clientKey(req)}`];
      const rwait = loginGuard.retryAfter(rkeys);
      if (rwait) return send(res, 429, 'application/json', JSON.stringify({ error: lockedMessage(rwait) }), { 'retry-after': String(rwait) });
      loginGuard.fail(rkeys);
      const b = await readBody(req, BODY_LIMITS.auth);
      const id = String(b.username || '').toLowerCase();
      if (!idOkSlug(id) || RESERVED_IDS.has(id)) return send(res, 400, 'application/json', '{"error":"username: lowercase letters/numbers, no spaces"}');
      if (passwordError(b.password)) return send(res, 400, 'application/json', JSON.stringify({ error: passwordError(b.password) }));
      if (cfg.userById.has(id)) return send(res, 409, 'application/json', '{"error":"username taken"}');
      const status = cfg.require_approval ? 'pending' : 'active';
      const rec = { id, name: String(b.name || id).slice(0, 60), role: 'member', birthYear: Number(b.birthYear) || null,
        token: crypto.randomBytes(24).toString('base64url'), rel: `workspace-${id}`, workspace: path.join(ROOT, `workspace-${id}`),
        passHash: hashPassword(b.password), status };
      if (status === 'active') provisionWorkspace(rec);
      await upsertUser(rec);
      audit('register', { who: id, name: rec.name, status });
      if (status === 'pending') return send(res, 200, 'application/json', '{"ok":true,"pending":true}');
      const token = cfg.sessions.create(id, Date.now());
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, token, uid: id, name: rec.name, role: 'member' }));
    }
    if (req.method === 'POST' && p === '/api/logout') {
      cfg.sessions.destroy(bearerOf(req));
      return send(res, 200, 'application/json', '{"ok":true}');
    }

        // Sandboxed app hosting: /app/<userid>/<slug>/...  No token in the URL; the
    // user id is a public namespace, not a secret. Strict CSP + sandbox give the
    // app an opaque origin with NO network — it cannot read data or a token; it
    // only renders what its own shell brokers to it via postMessage.
    if (req.method === 'GET' && p.startsWith('/app/')) {
      const parts = p.slice('/app/'.length).split('/');
      const uid = parts.shift();
      const owner = demoOn(cfg) ? demoUsers.get(uid) : cfg.userById.get(uid);   // demo: visitors' apps only, never an account's
      const base = uid === 'shared' ? (demoOn(cfg) ? null : SHARED) : (owner && appsDir(owner));
      if (!base || !slugOk(parts[0] || '')) return send(res, 400, 'text/plain', 'bad app');
      const slug = parts.shift();
      if (!p.endsWith('/') && parts.length === 0) { res.writeHead(301, { location: `/app/${uid}/${slug}/` }); return res.end(); }
      const f = safeJoin(path.join(base, slug), parts.join('/') || 'index.html');
      if (!f) return send(res, 400, 'text/plain', 'bad path');
      // Serve only presentation assets. Data files (json/md/txt/csv…) are never
      // public — apps read data through the authenticated broker, not their dir.
      const ok = ['', '.html', '.css', '.js', '.mjs', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2'];
      if (!ok.includes(path.extname(f).toLowerCase())) return send(res, 404, 'text/plain', 'not found');
      const csp = APP_CSP;
      const ext = path.extname(f);
      const type = ext === '.html' || ext === '' ? 'text/html; charset=utf-8' : dataContentType(ext);
      const extra = { 'content-security-policy': csp + "; frame-ancestors 'self'", 'cache-control': 'no-cache' };
      // HTML: inline the shared PAChat component wherever <!--PA_CHAT_UI--> appears.
      // The sandbox CSP forbids <script src> (no 'self'), so one canonical file
      // injected at serve time is the only way to single-source the app chat UI.
      if (type.startsWith('text/html')) return sendAppHtml(res, f, type, extra);
      return sendFile(res, f, { type, extra });
    }

    const user = userFor(req);
    if (!user) return send(res, 401, 'application/json', '{"error":"bad token"}');

    // ── Web search for apps · 应用联网搜索 ────────────────────────────────────────────────
    // THE SERVER performs the search; the app and the agent never do. A non-owner's agent runs
    // with the permission bypass stripped (agentArgs), so Bash is unapprovable in a headless
    // lane and anything outside its own workspace is denied — measured, see lib/config.mjs. The
    // old advice to shell out to `node ../tools/websearch.mjs` was therefore unfollowable for a
    // member, and the model's only move was to narrate a permission request nobody could grant.
    // Brokering it here keeps the sandbox exactly as tight and makes the capability real.
    //
    // The Tavily key never leaves this process: not into an app, not into a prompt, not into a
    // workspace file a member could edit. That is the whole reason this is a route and not a
    // script handed to the agent — tools/ sits outside every workspace on purpose.
    if (req.method === 'GET' && p === '/api/websearch') {
      const q = String(url.searchParams.get('q') || '').trim();
      if (!q) return send(res, 400, 'application/json', JSON.stringify({ ok: false, code: 'bad-request', error: 'empty query · 查询为空' }));
      if (q.length > WEBSEARCH_Q_MAX) return send(res, 400, 'application/json', JSON.stringify({ ok: false, code: 'bad-request', error: `query too long · 查询过长 (max ${WEBSEARCH_Q_MAX})` }));
      const askedFor = Number.parseInt(url.searchParams.get('max') || '', 10);
      const max = Math.min(WEBSEARCH_MAX, Math.max(1, Number.isFinite(askedFor) ? askedFor : WEBSEARCH_DEFAULT_MAX));
      try {
        const out = JSON.parse(await webSearch({ query: q, max, json: true, cfg }));
        // The query itself is never audited — it is the user's own business. Shape only, so a
        // quota question or an abuse question stays answerable without keeping what they asked.
        audit('websearch', { who: user.id, chars: q.length, max, hits: out.results.length });
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, results: out.results }));
      } catch (e) {
        // webSearch throws on a missing key, an HTTP error, a timeout AND on zero results — an
        // empty list must never reach an app looking like a successful search (R14).
        const why = String((e && e.message) || e);
        audit('websearch-failed', { who: user.id, chars: q.length, error: why });
        return send(res, 502, 'application/json', JSON.stringify({ ok: false, code: 'search-failed', error: why }));
      }
    }
    if (req.method === 'GET' && p === '/api/bible-search') {
      try { return send(res, 200, 'application/json', JSON.stringify(searchBible(BIBLE_DATA, url.searchParams.get('q')))); }
      catch (e) { return send(res, 400, 'application/json', JSON.stringify({ error: e.message })); }
    }
    if (req.method === 'GET' && p === '/api/bible') {
      try { return send(res, 200, 'application/json', JSON.stringify(getChapter(BIBLE_DATA, url.searchParams.get('book'), url.searchParams.get('chapter')))); }
      catch (e) { return send(res, 400, 'application/json', JSON.stringify({ error: e.message })); }
    }
    if (req.method === 'GET' && p === OFFLINE_CONFIG_PATH) return send(res, 200, 'application/json', JSON.stringify({ ...cfg.offline, local_origin: cfg.local_origin, bible: bibleIndex(BIBLE_DATA) }));   // read at use time: a config reload changes the cap with no restart
    // A demo visitor's record name is a placeholder ("Member · 会员"): the header shows only a name they set themselves.
    // TODO(R4): web.mjs is over budget; split the small GET routes (ping, bible, family-apps) into lib/.
    if (req.method === 'GET' && p === '/api/ping') return send(res, 200, 'application/json', JSON.stringify({ ok: true, uid: user.id, name: user.demo ? ownName(user) : user.name, role: user.role }));
    if (req.method === 'GET' && p === '/api/family-apps') return send(res, 200, 'application/json', JSON.stringify(listFamilyApps()));
    if (req.method === 'PATCH' && p.endsWith('/share') && p.startsWith('/api/apps/')) {
      const slug = p.slice('/api/apps/'.length, -'/share'.length);
      if (!slugOk(slug)) return send(res, 400, 'application/json', '{"error":"bad name"}');
      const dir = ownAppDir(user, slug);
      if (!dir) return send(res, 400, 'application/json', LINKED_APP);
      const metaFile = path.join(dir, 'meta.json');
      if (!fs.existsSync(metaFile)) return send(res, 404, 'application/json', '{"error":"not found"}');
      const { shared } = await readBody(req, BODY_LIMITS.control);
      // READ-BEFORE-WRITE (empty-overwrite class): the swallowed parse this
      // replaces turned an unreadable meta.json into {}, so flipping the share
      // toggle rewrote the file as {"shared":true} — title, desc and forkedFrom
      // gone, answered ok:true. Now it refuses (500 file_unreadable) instead.
      const meta = readJsonForUpdate(metaFile, {}, { expect: (v) => !!v && typeof v === 'object' && !Array.isArray(v) });
      meta.shared = !!shared;
      if (shared && !meta.forkedFrom && !meta.version) { meta.version = '1.0.0'; meta.gitRef = gitHead(); }
      writeFileAtomic(metaFile, JSON.stringify(meta, null, 2));
      return send(res, 200, 'application/json', '{"ok":true}');
    }
    if (req.method === 'GET' && p === '/api/apps') {
      const links = openUrlApps();   // own apps only: a shelf or family app never opens links
      const own = listApps(user).map((a) => ({ ...a, uid: user.id, links: links.has(a.name) }));
      const ownNames = new Set(own.map((a) => a.name));
      const promoted = demoOn(cfg) ? [] : listShared(SHARED).map((a) => ({ ...a, uid: 'shared' }));   // demo: workspace.example apps only
      const promotedNames = new Set(promoted.map((a) => a.name));
      const family = listFamilyApps()
        .filter((a) => a.uid !== user.id && !ownNames.has(a.slug) && !promotedNames.has(a.slug))
        .map((a) => ({ name: a.slug, title: a.title, desc: a.desc, uid: a.uid, fromFamily: true }));
      return send(res, 200, 'application/json', JSON.stringify([...own, ...promoted, ...family]));
    }
    if (req.method === 'POST' && p === '/api/apps/fork') {
      const b = await readBody(req, BODY_LIMITS.control);
      if (b.fromUid) { // peer fork: copy a family member's shared app
        const src = cfg.userById.get(String(b.fromUid));
        if (!src || src.status !== 'active' || typeof b.slug !== 'string' || !slugOk(b.slug)) return send(res, 400, 'application/json', '{"error":"bad params"}');
        const srcDir = path.join(appsDir(src), b.slug);
        if (!noLinkOnTheWay(src.workspace, srcDir)) return send(res, 400, 'application/json', LINKED_APP);
        let sm = {}; try { sm = JSON.parse(fs.readFileSync(path.join(srcDir, 'meta.json'), 'utf8')) || {}; } catch {}
        if (!fs.existsSync(path.join(srcDir, 'index.html')) || !sm.shared) return send(res, 403, 'application/json', '{"error":"app is not shared"}');
        const dst = ownAppDir(user, b.slug);
        if (!dst) return send(res, 400, 'application/json', LINKED_APP);
        if (fs.existsSync(dst)) return send(res, 409, 'application/json', '{"error":"you already have a copy"}');
        fs.mkdirSync(appsDir(user), { recursive: true });
        try { copyNoLinks(srcDir, dst); }   // as a shelf fork does: a link in someone's app is not copied
        catch (e) { if (e.code !== LINKED_SOURCE) throw e; return send(res, 400, 'application/json', JSON.stringify({ error: e.message })); }
        const prof = loadProfile(src.workspace) || {};
        writeFileAtomic(path.join(dst, 'meta.json'), JSON.stringify({ ...sm, shared: false, forkedFrom: { uid: src.id, author: prof.name || src.name, slug: b.slug, version: sm.version || null, hash: appHash(srcDir), gitRef: gitHead() } }, null, 2));
        audit('fork', { who: user.id, from: src.id, slug: b.slug });
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, name: b.slug }));
      }
      if (!noLinkOnTheWay(user.workspace, appsDir(user))) return send(res, 400, 'application/json', LINKED_APP);
      try { // curated fork: copy from the owner-blessed shelf
        const name = fork(SHARED, String(b.slug || ''), appsDir(user));
        audit('fork', { who: user.id, from: 'shared', slug: b.slug });
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, name }));
      } catch (e) { if (e.code !== FORK_REFUSED && e.code !== LINKED_SOURCE) throw e; return send(res, 400, 'application/json', JSON.stringify({ error: e.message })); }
    }
    if (req.method === 'POST' && p.startsWith('/api/apps/') && p.endsWith('/update')) {
      const slug = p.slice('/api/apps/'.length, -'/update'.length);
      if (!slugOk(slug)) return send(res, 400, 'application/json', '{"error":"bad slug"}');
      const dstDir = ownAppDir(user, slug);
      if (!dstDir) return send(res, 400, 'application/json', LINKED_APP);
      let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(dstDir, 'meta.json'), 'utf8')) || {}; } catch {}
      const fk = forkSource(meta);
      if (!fk) return send(res, 400, 'application/json', '{"error":"not a forked app"}');
      const { ff, src, srcDir } = fk;
      if (!src) return send(res, 404, 'application/json', '{"error":"source user not found"}');
      if (!noLinkOnTheWay(src.workspace, srcDir)) return send(res, 400, 'application/json', LINKED_APP);   // a source reached through a link
      let srcMeta = {}; try { srcMeta = JSON.parse(fs.readFileSync(path.join(srcDir, 'meta.json'), 'utf8')) || {}; } catch {}
      if (!srcMeta.shared) return send(res, 403, 'application/json', '{"error":"app is no longer shared"}');
      // Copy all app files except meta.json (preserves the user's own data-settings).
      fs.readdirSync(srcDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name !== 'meta.json')
        .forEach((e) => writeFileAtomic(path.join(dstDir, e.name), fs.readFileSync(path.join(srcDir, e.name))));   // replaces a link, never follows it
      writeFileAtomic(path.join(dstDir, 'meta.json'), JSON.stringify({
        ...meta,
        title: String(srcMeta.title || ff.slug),
        desc: String(srcMeta.desc || ''),
        forkedFrom: { ...ff, version: srcMeta.version || ff.version || null, hash: appHash(srcDir), gitRef: gitHead() },
      }, null, 2));
      audit('app-update', { who: user.id, slug, from: ff.uid });
      return send(res, 200, 'application/json', '{"ok":true}');
    }
    if (req.method === 'GET' && p.startsWith('/api/apps/') && p.endsWith('/changelog')) {
      const slug = p.slice('/api/apps/'.length, -'/changelog'.length);
      if (!slugOk(slug)) return send(res, 400, 'application/json', '{"error":"bad slug"}');
      const dstDir = path.join(appsDir(user), slug);
      let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(dstDir, 'meta.json'), 'utf8')) || {}; } catch {}
      const fk = forkSource(meta);
      const empty = { features: [], fixes: [] };
      if (!fk || !fk.src) return send(res, 200, 'application/json', JSON.stringify(empty));
      const { ff, srcDir: srcDir2 } = fk;
      if (!ff.gitRef || !GIT_REF_RE.test(ff.gitRef)) return send(res, 200, 'application/json', JSON.stringify(empty));
      let srcMeta2 = {}; try { srcMeta2 = JSON.parse(fs.readFileSync(path.join(srcDir2, 'meta.json'), 'utf8')) || {}; } catch {}
      const toRef = (srcMeta2.gitRef && GIT_REF_RE.test(srcMeta2.gitRef)) ? srcMeta2.gitRef : 'HEAD';
      const relPath = path.relative(ROOT, path.join(srcDir2, 'index.html'));
      try {
        // argv, not a shell string: cmd.exe does not treat POSIX quotes as quoting, and `%s`
        // inside a cmd command line is percent-expansion syntax. execFileSync needs no quoting.
        const out = execFileSync('git', ['log', '--format=%s', `${ff.gitRef}..${toRef}`, '--', relPath],
          { cwd: ROOT, encoding: 'utf8', ...GIT_QUIET });
        const subjects = out.trim().split('\n').filter(Boolean);
        return send(res, 200, 'application/json', JSON.stringify(classifySubjects(subjects)));
      } catch { return send(res, 200, 'application/json', JSON.stringify(empty)); }
    }
    if (req.method === 'POST' && p.startsWith('/api/apps/') && p.endsWith('/bump')) {
      const slug = p.slice('/api/apps/'.length, -'/bump'.length);
      if (!slugOk(slug)) return send(res, 400, 'application/json', '{"error":"bad slug"}');
      const dir = ownAppDir(user, slug);
      if (!dir) return send(res, 400, 'application/json', LINKED_APP);
      const metaFile = path.join(dir, 'meta.json');
      let meta = {}; try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) || {}; } catch {}
      if (!meta.shared) return send(res, 403, 'application/json', '{"error":"app is not shared — share it first"}');
      if (meta.forkedFrom) return send(res, 403, 'application/json', '{"error":"only the original owner can publish updates"}');
      meta.version = bumpPatch(meta.version);
      meta.gitRef = gitHead();
      writeFileAtomic(metaFile, JSON.stringify(meta, null, 2));
      audit('app-bump', { who: user.id, slug, version: meta.version });
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, version: meta.version }));
    }
    if (req.method === 'DELETE' && p.startsWith('/api/apps/')) {
      const slug = p.slice('/api/apps/'.length);
      if (!slugOk(slug)) return send(res, 400, 'application/json', '{"error":"bad name"}');
      const dir = ownAppDir(user, slug);
      if (!dir) return send(res, 400, 'application/json', LINKED_APP);
      fs.rmSync(dir, { recursive: true, force: true });
      return send(res, 200, 'application/json', '{"ok":true}');
    }
    if (req.method === 'GET' && p.startsWith('/api/data/')) {
      const f = safeJoin(wsDir(user), p.slice('/api/data/'.length));
      if (!f) return send(res, 400, 'text/plain', 'bad path');
      return sendFile(res, f); // inert content types + nosniff via dataContentType
    }
    if (req.method === 'POST' && p === '/api/upload') {
      // Body: readBody like every other route (R3). The hand-rolled reader this
      // replaces had its own 20MB cap and called req.destroy() on overflow, so
      // the client got ECONNRESET and never saw a status — the drain-vs-destroy
      // tradeoff lib/webutil.mjs settled in favour of draining, plus the read
      // deadline it also lacked.
      const { name, data } = await readBody(req, BODY_LIMITS.upload);
      if (typeof name !== 'string' || typeof data !== 'string') return send(res, 400, 'application/json', '{"error":"missing fields","code":"missing_fields"}');
      // STRICT decode (R3, lib/webutil.mjs): Node's lenient decoder stored a
      // 48-byte file as 6 bytes and answered ok:true. A corrupt attachment must
      // fail loudly here, not be discovered when someone opens it.
      const buf = decodeBase64Strict(data);
      if (!buf || !buf.length) return send(res, 400, 'application/json', '{"error":"invalid base64 data · 无效的 base64 数据","code":"bad_base64"}');
      const safe = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
      const dir = path.join(wsDir(user), UPLOADS_DIR);
      const ts = Date.now();
      const dest = path.join(dir, `${ts}_${safe}`);
      writeFileAtomic(dest, buf); // tmp+rename: a killed process never leaves a half-written attachment
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, path: `${UPLOADS_DIR}/${ts}_${safe}`, name: safe, bytes: buf.length }));
    }
    if (req.method === 'GET' && p === '/api/convos') return send(res, 200, 'application/json', JSON.stringify(listConvos(user)));
    if (req.method === 'GET' && p === '/api/notes') {
      const dir = path.join(wsDir(user), APP_DATA_DIR, 'bible', 'notes');   // per-app data bundle
      if (!fs.existsSync(dir)) return send(res, 200, 'application/json', '[]');
      const BOOK_NAMES = ['Genesis','Exodus','Leviticus','Numbers','Deuteronomy','Joshua','Judges','Ruth','1 Samuel','2 Samuel','1 Kings','2 Kings','1 Chronicles','2 Chronicles','Ezra','Nehemiah','Esther','Job','Psalms','Proverbs','Ecclesiastes','Song of Solomon','Isaiah','Jeremiah','Lamentations','Ezekiel','Daniel','Hosea','Joel','Amos','Obadiah','Jonah','Micah','Nahum','Habakkuk','Zephaniah','Haggai','Zechariah','Malachi','Matthew','Mark','Luke','John','Acts','Romans','1 Corinthians','2 Corinthians','Galatians','Ephesians','Philippians','Colossians','1 Thessalonians','2 Thessalonians','1 Timothy','2 Timothy','Titus','Philemon','Hebrews','James','1 Peter','2 Peter','1 John','2 John','3 John','Jude','Revelation'];
      const notes = [];
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const m = f.match(/^(\d+)-(\d+)\.json$/);
        if (!m) continue;
        const bookIdx = parseInt(m[1]) - 1;
        const chapter = parseInt(m[2]);
        let data; try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
        const textNotes = Object.entries(data.notes || {}).filter(([,v]) => v && v.trim());
        const drawKeys = Object.keys(data.draws || {});
        // Verse marks (web/verse-marks.inline.html): a verse with only marks has no notebook, but it
        // is annotated and the ☰ list must show it; `marks` per row is the count the app's chip reads.
        // TODO(R4 seam): this route's row builder belongs in lib/notes-list.mjs with firstLineTitle.
        const markKeys = Object.keys(data.marks || {}).filter((k) => Array.isArray(data.marks[k]) && data.marks[k].length);
        if (!textNotes.length && !drawKeys.length && !markKeys.length) continue;
        // Build per-scope entries so each verse range gets its own title
        const allKeys = [...new Set([...textNotes.map(([k]) => k), ...drawKeys, ...markKeys])];
        const stat = fs.statSync(path.join(dir, f));
        const book = BOOK_NAMES[bookIdx] || `Book ${bookIdx + 1}`;
        const parseKey = k => k.startsWith('v') ? k.slice(1).split('.').map(Number) : [];
        const now = new Date();
        const verseRange = nums => nums.length === 0 ? '' : nums.length === 1 ? `:${nums[0]}` : `:${nums[0]}–${nums[nums.length-1]}`;
        for (const k of allKeys) {
          const nums = parseKey(k);
          // A free-form note's key IS its creation time (free-<epoch>), so surface it: without
          // this every such note listed as the bare chapter (or the literal placeholder the app
          // used to store) and several on one chapter were indistinguishable in the drawer.
          // An unnamed free-form note is NOT a verse reference: "John 3 · 11:24" sat in the list
          // looking like one, next to real rows like "John 3:1". It reads as what it is.
          const stamp = freeStamp(k, now);
          const autoTitle = stamp ? `${NEW_NOTE_LABEL}${stamp}` : `${book} ${chapter}${verseRange(nums)}`;
          const stored = (data.titles || {})[k];
          // LEGACY_NEW_NOTE is treated as UNSET so notes created before this change retitle
          // themselves on read — no data migration, and an explicit rename still wins.
          // explicit rename → the note's own first line (free-form only) → the derived title
          // Derived for EVERY key, free-form or verse. Asked for directly: "the note's title should
          // be the same in the drawer" — a note named by its first line in the pad and by its verse
          // reference in the list is one note with two names. The reference remains the fallback
          // when a note has no text (handwriting only), and an explicit rename still wins over both.
          const derived = firstLineTitle(data, k);
          const title = (stored && stored !== LEGACY_NEW_NOTE) ? stored : (derived || autoTitle);
          // A mark-only verse previews its marked quote (a whole-verse mark has none).
          const markList = Array.isArray((data.marks || {})[k]) ? data.marks[k] : [];
          const quote = (markList.find((m) => m && typeof m.quote === 'string' && m.quote) || {}).quote || '';
          const preview = (((data.notes || {})[k] || '').trim() || quote).slice(0, 80);
          const hasDraws = !!((data.draws || {})[k]);
          const hasText = !!(((data.notes || {})[k] || '').trim());   // the app's delete keeps marks unless the row is mark-only
          const marks = markList.length;
          // Per-NOTE time. Every note in a chapter lives in ONE file, so stat.mtimeMs made them
          // all report the same instant ("now") and a new note could never sort to the top.
          // Prefer the notebook's own updated, else the creation time encoded in a free-* key.
          const own = Number(((data.draws || {})[k] || {}).updated) || 0;
          const born = (/^free-(\d{10,})$/.exec(k) || [])[1];
          const updated = own || (born ? Number(born) : 0) || stat.mtimeMs;
          // Per-note creation time for the drawer's created sort and the period presets (plan E); a
          // text-only verse note has none, so 0 = unknown and the row falls back to `updated`.
          const created = Number(((data.draws || {})[k] || {}).created) || (born ? Number(born) : 0) || 0;
          // Bookmark（书签）: an explicit flag the app keeps beside `titles` (plan D); the note is untouched.
          const pin = !!((data.pins || {})[k]);
          notes.push({ bookIdx, chapter, book, title, verseKey: k, preview, hasDraws, hasText, marks, updated, created, pin });
        }
      }
      notes.sort((a, b) => b.updated - a.updated);
      return send(res, 200, 'application/json', JSON.stringify(notes));
    }
    // Note search（笔记搜索）: typed text, handwriting, photos and #tags across ONE app's notebooks,
    // from a local index (lib/note-search.mjs; ADR 0023). Lazy: the first search indexes whatever is
    // already on disk, and starts the OCR queue (lib/note-ocr-queue.mjs) if pages await transcription.
    // TODO(R4 seam): /api/notes and this route are the notes routes — move both to lib/notes-routes.mjs.
    if (req.method === 'GET' && p === '/api/note-search') {
      const app = String(url.searchParams.get('app') || '');
      const q = String(url.searchParams.get('q') || '').trim();
      if (!slugOk(app)) return send(res, 400, 'application/json', '{"ok":false,"error":"bad app","code":"bad_app"}');
      if (!q) return send(res, 200, 'application/json', '{"ok":true,"hits":[],"truncated":false}');
      try {
        const { hits, truncated, terms, errors, reset, index } = searchIndexed(wsDir(user), app, q);
        for (const err of errors) audit(NOTE_INDEX_FAILED, { who: user.id, path: `${APP_DATA_DIR}/${app}/${err.path}`, error: String(err.error).slice(0, 200) });
        if (reset) audit(NOTE_INDEX_FAILED, { who: user.id, app, code: 'index_reset', error: reset.slice(0, 200) });   // an index that would not search was rebuilt once
        const state = noteOcrState(wsDir(user), app, index, { cmd: noteOcrCmd(), onError: noteOcrAudit(user) });   // {pending, ocr, reason?}
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, hits, truncated: !!truncated, terms: terms || [], ...state }));   // terms + hits[].boxes: phase 3 highlight
      } catch (e) {
        audit('note-search-failed', { who: user.id, app, code: e.code || 'search_failed', error: String(e.message || e).slice(0, 200) });   // loud, with a code (R5)
        return send(res, 500, 'application/json', JSON.stringify({ ok: false, error: 'search failed · 搜索失败', code: 'search_failed' }));
      }
    }
    // Note text（笔记文本）: the index records of ONE app's documents — transcript, labels, #tags — one
    // per page (lib/note-text.mjs; docs/plans/note-features.md A/B). Same lazy scan and OCR kick as
    // the search; nothing is written to a note. TODO(R4 seam): the notes routes → lib/notes-routes.mjs (above).
    if (req.method === 'GET' && p === '/api/note-text') {
      const app = String(url.searchParams.get('app') || '');
      if (!slugOk(app)) return send(res, 400, 'application/json', '{"ok":false,"error":"bad app","code":"bad_app"}');
      const paths = url.searchParams.getAll('path').map(String).filter(Boolean);
      const scope = url.searchParams.has('scope') ? String(url.searchParams.get('scope')) : null;
      try {
        const { index, errors } = ensureIndexed(wsDir(user), app);
        for (const err of errors) audit(NOTE_INDEX_FAILED, { who: user.id, path: `${APP_DATA_DIR}/${app}/${err.path}`, error: String(err.error).slice(0, 200) });
        const state = noteOcrState(wsDir(user), app, index, { cmd: noteOcrCmd(), onError: noteOcrAudit(user) });   // {pending, ocr, reason?}
        const { pages, truncated } = noteTextRecords(index, { paths, scope, fields: parseFields(url.searchParams.get('fields')) });
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, pages, truncated, ...state }));
      } catch (e) {
        audit('note-text-failed', { who: user.id, app, code: e.code || 'text_failed', error: String(e.message || e).slice(0, 200) });   // loud, with a code (R5)
        return send(res, 500, 'application/json', JSON.stringify({ ok: false, error: 'note text unavailable · 笔记文本不可用', code: 'text_failed' }));
      }
    }
    // Note page image（笔记页图片）: ONE page's ink as a PNG under uploads/pages/, for a summary turn that sends
    // the page as a picture (lib/note-page-image.mjs; note-features.md I, ADR 0027). The same app + path
    // scoping as note-text; the file is named workspace-relative, as a chat attachment carries it.
    // TODO(R4 seam): the notes routes → lib/notes-routes.mjs (above).
    if (req.method === 'GET' && p === '/api/note-page-image') {
      const app = String(url.searchParams.get('app') || '');
      if (!slugOk(app)) return send(res, 400, 'application/json', '{"ok":false,"error":"bad app","code":"bad_app"}');
      const r = pageImageFile(wsDir(user), app, { rel: String(url.searchParams.get('path') || ''), scope: String(url.searchParams.get('scope') || ''), page: Math.max(0, Number(url.searchParams.get('page')) || 0) });
      if (!r.ok) audit('note-page-image-failed', { who: user.id, app, code: r.code, error: String(r.error).slice(0, 200) });   // loud, with a code (R5)
      return send(res, r.ok ? 200 : r.code === IMG_BAD_PATH ? 400 : r.code === IMG_NOT_FOUND ? 404 : 422, 'application/json', JSON.stringify(r));
    }
    // Summary follow-up（总结跟进）: the Open to-dos of a summary's text → one brief block (lib/summary-followup.mjs,
    // ADR 0027). Only the to-do lines reach the research lane; the lanes come from cfg at use time.
    if (req.method === 'POST' && p === '/api/summary-followup') {
      const b = await readBody(req, BODY_LIMITS.chat);
      if (!b || typeof b.text !== 'string' || !b.text.trim()) return send(res, 400, 'application/json', '{"ok":false,"error":"missing text","code":"missing_fields"}');
      // The writer lanes (lib/research-writer.mjs): Claude with no tools in the user's confined app-lane argv, Codex read-only.
      // TODO(R4 seam): with the notes routes → lib/notes-routes.mjs.
      const fuOrigin = { fromApp: true }, fuMs = writerLaneMs(cfg.summary_followup_item_timeout_ms);   // a share of the item deadline, so a hung lane leaves time to fall back
      const agents = { claude: (q) => enqueue(() => runAgent(q, agentArgs(user, writerClaudeBase(cfg, memberArgsOf(user, fuOrigin)), fuOrigin), wsDir(user), fuMs)),
        codex: (q, model) => enqueue(() => runCodex({ prompt: q, cwd: wsDir(user), model: model || undefined, timeoutMs: fuMs })) };
      const fuDeps = followupDeps({ cfg, runResearch, streamOllama, agents });
      const r = await buildFollowup(b.text, fuDeps);
      if (r.partial) audit('summary-followup-partial', { who: user.id, items: r.items.filter((i) => !i.ok).length });   // a named failure in the block, logged too (R5)
      return send(res, 200, 'application/json', JSON.stringify(r));
    }
    // Per-app conversation list (id, cleaned title, last-reply preview, optional context label).
    // Powers the in-panel chat list every app shows via PAChat. app chats are found by their tag.
    if (req.method === 'GET' && p === '/api/app-convos') {
      const app = url.searchParams.get('app') || '';
      const dir = convosDir(user); const out = [];
      if (app && fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.json')) continue;
          let c; try { c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
          if (c.app !== app) continue;
          let prev = '';
          for (let i = (c.messages || []).length - 1; i >= 0; i--) { if (c.messages[i].role === 'md') { prev = String(c.messages[i].text || '').replace(/[#*`>_~\n]+/g, ' ').trim().slice(0, 90); break; } }
          out.push({ id: c.id, title: c.title || 'Chat', updated: c.updated || 0, label: c.label || null, preview: prev });
        }
      }
      out.sort((a, b) => b.updated - a.updated);
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, convos: out }));
    }
    if (req.method === 'GET' && p.startsWith('/api/convos/')) {
      const c = loadConvo(user, p.slice('/api/convos/'.length));
      return c ? send(res, 200, 'application/json', JSON.stringify(c)) : send(res, 404, 'application/json', '{"error":"not found"}');
    }
    if (req.method === 'DELETE' && p.startsWith('/api/convos/')) {
      const f = convoFile(user, p.slice('/api/convos/'.length));
      // A demo visitor's delete is real: a tombstone would keep counting against their disk cap.
      if (f && fs.existsSync(f) && demoOn(cfg)) fs.rmSync(f);
      else if (f && fs.existsSync(f)) { // tombstone, don't obliterate — recoverable
        const trash = path.join(convosDir(user), '.trash');
        fs.mkdirSync(trash, { recursive: true });
        fs.renameSync(f, path.join(trash, `${Date.now()}-${path.basename(f)}`));
      }
      return send(res, 200, 'application/json', '{"ok":true}');
    }
    if (req.method === 'PATCH' && p.startsWith('/api/convos/')) {
      const id = p.slice('/api/convos/'.length);
      const c = loadConvo(user, id);
      if (!c) return send(res, 404, 'application/json', '{"error":"not found"}');
      const { title } = await readBody(req, BODY_LIMITS.control);
      if (typeof title === 'string' && title.trim()) { c.title = title.trim().slice(0, 80); saveConvo(user, c); }
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, title: c.title }));
    }
    // Models offered in the composer's chooser (id + label only; server maps id → provider/model).
    // A lane gone from Ollama (lib/model-health.mjs) is not offered — the scheduled model-check
    // and any gone answer a turn meets keep this list current without a config edit or a restart.
    if (req.method === 'GET' && p === '/api/models') { const gone = modelHealth.gone(); return send(res, 200, 'application/json', JSON.stringify((cfg.chat_models || []).filter((m) => laneServed(m, gone)).map((m) => ({ id: m.id, label: m.label, group: m.group || '', provider: m.provider || '', vision: m.provider === 'claude' || m.provider === 'codex' || m.id === cfg.vision_default })))); }   // vision: the summary sheet says whether page images will be seen (note-features.md I)

    // Health metrics — the iPhone Shortcut POSTs a day's data here; apps read them
    // back. v1 (flat day row) and v2 (schema:"health.v2" samples) share the endpoint
    // (lib/health.mjs dispatches); v2 gets the design's larger payload cap and honest
    // status codes: 400 = nothing usable stored, 413 = oversized, nothing stored.
    if (req.method === 'POST' && p === '/api/health/ingest') {
      const b = (await readBody(req, MAX_BODY_BYTES)) || {}; // oversize → 413 JSON from the catch-all; `|| {}` keeps a literal `null` body harmless
      const r = ingestHealth(user, b);
      // 200 ONLY when nothing was dropped (the invariant lives in lib/health.mjs,
      // stated once): a partial store answers 207 with stored/dropped counted, so
      // no caller can read a lost backfill tail as a clean success (R14). Both
      // kinds of removal are audited — retention used to destroy stored personal
      // data with no audit entry at all.
      if (r.dropped) audit('health-ingest-dropped', { who: user.id, stored: r.stored, dropped: r.dropped, why: (r.rejected || []).map((x) => x.reason).slice(0, 5) });
      if (r.pruned) audit('health-prune', { who: user.id, ...r.pruned });
      return send(res, r.ok ? 200 : (r.status || 400), 'application/json', JSON.stringify(r)); // the meals-ingest mapping, verbatim (R3)
    }
    if (req.method === 'GET' && p === '/api/health') return send(res, 200, 'application/json', JSON.stringify(recentHealth(user, url.searchParams.get('days') || 7)));
    if (req.method === 'GET' && p === '/api/health/monthly') return send(res, 200, 'application/json', JSON.stringify(monthlyRollups(user)));
    // Health setup · 健康接入 — hands this member's OWN ingest URL + Bearer token to
    // their phone (shown on the profile page and copied from there; Tailscale carries the
    // upload). The token is the same credential this authenticated session already
    // represents — same privilege, never someone else's. Viewing is audited.
    // URL base: cfg.public_base_url WINS when set (Node settings / config.json) —
    // deriving from the request Host meant a profile opened via localhost handed out
    // an ingest URL the phone cannot reach; empty keeps the Host derivation.
    if (req.method === 'GET' && p === '/api/health/setup') {
      const base = cfg.public_base_url
        || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host || `localhost:${PORT}`}`;
      const ingestUrl = `${base}/api/health/ingest`;
      audit('health-setup', { who: user.id });
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, url: ingestUrl, token: user.token }));
    }

    // Meal photo logging（拍照记录饮食, PLAN.md capability #3): the share-sheet
    // Shortcut "Analyze meal · 分析饮食" POSTs ONE photo (base64 JSON — the
    // /api/upload mechanics) with this member's own Bearer token; the
    // /api/health/setup URL+token pair serves this endpoint too (swap the
    // path), so no new setup UI exists. PRIVACY — CONSENT-BY-ACTION（主动分享
    // 即同意）: the photo goes to cfg.vision_default (an Ollama *-cloud lane by
    // default) for ONE extraction call at ingest; the deliberate share IS the
    // consent — nothing is auto-collected, and the weekly 饮食 section is pure
    // aggregation of stored records (no LLM at brief time). Vision failure is
    // stored as { analyzed:false, reason } — coverage stays honest (R14).
    // Recipe + notice: docs/design/meal-photo-shortcut.md.
    if (req.method === 'POST' && p === '/api/meals/ingest') {
      const b = (await readBody(req, MEAL_MAX_BODY_BYTES)) || {}; // oversize → 413 JSON from the catch-all; `|| {}` keeps a literal `null` body harmless
      // enqueue: the vision call rides the SAME MAX_CONCURRENT gate as every
      // other model call; lib/meals.mjs adds the per-user in-flight guard.
      const r = await ingestMealPhoto(user, b, { vision: mealVision, enqueue });
      if (r.pruned) audit('meal-prune', { who: user.id, ...r.pruned }); // retention pass deleted old months + photos
      if (r.ok) audit('meal-ingest', { who: user.id, analyzed: !!(r.record && r.record.analyzed) });
      else if (r.status === 429) audit('meal-ingest-refused', { who: user.id, error: r.error }); // cap/busy refusals are visible, never silent
      // r.status is the HTTP answer, r.code the stable string (R3): an oversized photo is a
      // 413 + CODE_TOO_LARGE + limit here exactly as it is on every other route, so the
      // Shortcut (and any future UI) can tell it from "not an image" without reading prose.
      return send(res, r.ok ? 200 : (r.status || 400), 'application/json', JSON.stringify(r));
    }
    // The READ half（读取）of the meal log — the same bare-array shape /api/health answers,
    // so the shell's broker keys it the same way (kind 'meals' ⇄ kind 'health'). It existed
    // only as a WRITE until an app wanted to show what had been logged: an ingest whose
    // result can never be read back is a write-only pipeline, and the app's recent list
    // rendered nothing forever with no failure anywhere to see. Records travel AS STORED —
    // { analyzed:false, reason } included — because the UI's honesty depends on it (R14).
    if (req.method === 'GET' && p === '/api/meals') return send(res, 200, 'application/json', JSON.stringify(recentMeals(user, url.searchParams.get('days'))));

      // Rotate THIS user's API token（重新生成令牌）. Until now a leaked one could not be
      // revoked at all: the token is long-lived, is shown in the health-setup panel,
      // and is a full bearer credential for the account.
      //
      // No restart needed. upsertUser already rewrites the live cfg.userByToken map — that is
      // how registering a member works — so the new token authenticates on the next request
      // and the old one stops on the same tick.
      //
      // Irreversible and NOT quiet: every device holding the old token, a health Shortcut
      // above all, starts failing immediately with the same "bad token" 401 an
      // unauthenticated request gets. The client warns before asking.
      if (req.method === 'POST' && p === '/api/profile/token/rotate') {
        const fresh = crypto.randomBytes(24).toString('base64url');
        const old = user.token;
        await upsertUser({ ...user, token: fresh });
        // The VALUE is never audited — the audit log is owner-readable and this is a
        // credential (the same rule config secrets follow). Only that a rotation happened.
        audit('token-rotate', { who: user.id });
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, token: fresh, revoked: old !== fresh }));
      }

    // The node's own AgentMail inbox address（管家邮箱）— owner-only, shown
    // read-only in the profile: the address briefings and reminders are emailed FROM.
    // (Nothing reads this inbox — mail reading was removed 2026-10-11, docs/adr/0004.)
    // ensureInbox is create-or-get: the FIRST open may create the node's ONE
    // persistent inbox; afterwards the persisted state answers without a network
    // call. { ok:false, error } (the /api/health/setup shape) is the HONEST
    // outcome — the client renders the error, never a fake address (R14).
    if (req.method === 'GET' && p === '/api/agentmail/address') {
      if (user.role !== 'owner') return send(res, 403, 'application/json', '{"error":"owner only"}');
      if (!MAIL) return send(res, 200, 'application/json', JSON.stringify({ ok: false, error: 'Email channel not configured (agentmail_key) · 未配置邮件通道' }));
      try {
        const inbox = await MAIL.ensureInbox();
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, address: inbox.email }));
      } catch (e) {
        audit('agentmail-inbox-error', { who: user.id, error: String(e && e.message || e) }); // R5: surfaced to the owner both here and in the audit log
        return send(res, 200, 'application/json', JSON.stringify({ ok: false, error: `Inbox unavailable · 无法获取管家邮箱 — ${String(e && e.message || e)}` }));
      }
    }

    // ── Autonomy: briefings (read-only digests) + approval queue (side effects) ──
    if (req.method === 'GET' && p === '/api/briefings') {
      const prof = loadProfile(wsDir(user)) || {};
      const days = (typeof prof.briefingRetainDays === 'number' && prof.briefingRetainDays > 0) ? prof.briefingRetainDays : 30;
      return send(res, 200, 'application/json', JSON.stringify(listBriefings(user, days)));
    }
    if (req.method === 'GET' && p.startsWith('/api/briefings/')) {
      const b = getBriefing(user, p.slice('/api/briefings/'.length));
      return b ? send(res, 200, 'application/json', JSON.stringify(b)) : send(res, 404, 'application/json', '{"error":"not found"}');
    }
    if (req.method === 'GET' && p === '/api/actions') {
      // Sweeps are WRITES — they join the per-user queue (single-writer rule),
      // so a read-time sweep can never clobber a concurrent decision.
      const pending = await withUserLock(user.id, () => {
        const t = Date.now();
        expireStaleActions(user, t);           // stale proposals expire on read — never linger as approvable
        sweepStrandedApprovals(user, t, audit); // crashed executors close as failed, not invisible limbo
        return pendingActions(user);
      });
      return send(res, 200, 'application/json', JSON.stringify(pending));
    }
    if (req.method === 'POST' && /^\/api\/actions\/[\w.-]+\/(approve|deny)$/.test(p)) {
      const [, id, verb] = p.match(/^\/api\/actions\/([\w.-]+)\/(approve|deny)$/);
      // ONE serialized decision core (lib/decide.mjs): expiry + limbo sweep,
      // then the verb — all inside the per-user lock.
      const out = await decideAction(user, id, verb, { audit });
      if (!out) return send(res, 200, 'application/json', '{"error":"not found"}');
      return send(res, 200, 'application/json', JSON.stringify({ ...out.decided, wasPending: out.wasPending }));
    }
    // Reminders（提醒）: list + revoke — the off switch for an approved
    // create-reminder. Removal is a state write → the same per-user queue.
    if (req.method === 'GET' && p === '/api/reminders') {
      try { return send(res, 200, 'application/json', JSON.stringify(loadReminders(user))); }
      catch (e) { // R5: corrupt store surfaces as an error, never as "no reminders"
        audit('reminder-state-error', { who: user.id, error: String(e && e.message || e) });
        return send(res, 500, 'application/json', '{"error":"reminders unreadable · 提醒数据读取失败"}');
      }
    }
    if (req.method === 'DELETE' && /^\/api\/reminders\/[\w.-]+$/.test(p)) {
      const id = p.slice('/api/reminders/'.length);
      // Manual deletion leaves the SAME evidence an approved retire-reminder
      // does (lib/actions.mjs): the record anchors the adherence verdict to
      // the real removal date and puts the ORIGINAL producer flag into the
      // retirement cooldown — the next brief must not re-propose what the
      // family just deleted (R13 finding).
      const removed = await withUserLock(user.id, () => {
        const rem = removeReminder(user, id);
        if (rem) recordReminderRetirement(user, rem);
        return rem;
      });
      if (removed) audit('reminder-removed', { who: user.id, reminder: id });
      return removed ? send(res, 200, 'application/json', '{"ok":true}')
        : send(res, 404, 'application/json', '{"error":"not found"}');
    }
    // Jobs view（任务视图）— every user sees their OWN registered jobs and
    // reminders with honest status: lastOutcome derives from the audit log's
    // most recent relevant entry (bounded tail scan, lib/jobstatus.mjs) —
    // never inferred from a run mark, so it can't show ok when a run failed.
    if (req.method === 'GET' && p === '/api/jobs') {
      let marks = {}, reminders = [];
      try { marks = readJobRuns(user); }
      catch (e) { audit('job-state-error', { who: user.id, error: String(e && e.message || e) }); } // corrupt marks: rows still render (lastRun unknown), failure audit-visible (R5)
      try { reminders = loadReminders(user); }
      catch (e) { audit('reminder-state-error', { who: user.id, error: String(e && e.message || e) }); } // same rule for a corrupt reminders store
      return send(res, 200, 'application/json',
        JSON.stringify(jobsView({ jobs: jobsForUser(user), reminders, marks, audit: readAuditTail(cfg.auditFile), who: user.id })));
    }
    // The tool catalogue the job editor offers. Manifests only — no secrets, and `runnable`
    // is what the UI must offer, since a tool with no runner would create a job that can
    // never do anything (the silent-failure mode the engine guards hardest against).
    // The editable records themselves. /api/jobs returns a VIEW (status, next due) and does
    // not carry plan/args, so the editor needs the underlying files. Built-ins are excluded:
    // they are code and the write routes refuse them, so offering them here would be a lie.
    // `bad` is returned too — a job the user wrote that does not parse must be VISIBLE, not
    // silently absent from a list that otherwise looks complete.
    if (req.method === 'GET' && p === '/api/jobs/files') {
      const { jobs, bad } = loadJobFiles(wsDir(user));
      return send(res, 200, 'application/json', JSON.stringify({ jobs, bad }));
    }
    if (req.method === 'GET' && p === '/api/jobs/tools') {
      return send(res, 200, 'application/json', JSON.stringify({ tools: toolManifests(), runnable: runnableTools() }));
    }
    // Describe it in a sentence; the model picks the tool and fills its arguments. Resolving
    // does NOT create anything — it answers a draft the editor shows for review, because a job
    // that starts messaging you before you have seen it is exactly what the paused-by-default
    // rule exists to prevent.
    if (req.method === 'POST' && p === '/api/jobs/resolve') {
      const body = await readBody(req, BODY_LIMITS.chat);
      const prof = loadProfile(wsDir(user)) || {};
      const origin = { fromApp: appOriginated(req.headers, body) };
      const out = await resolvePrompt(String((body && body.prompt) || ''), {
        // The fast lane, not the agent: this is one small structured answer, not a task.
        ask: (q) => enqueue(() => runAgent(q, agentArgs(user, fastBaseArgs(user, origin), origin), wsDir(user), RESOLVE_MS)).then((r) => r.text),
        tools: toolManifests(), runnable: runnableTools(),
        profile: { postcode: prof.postcode || '', name: prof.name || '' },
      });
      audit('job-resolve', { who: user.id, ok: !!out.ok, tool: out.job ? out.job.plan.tool : null, ask: out.ask ? out.ask.length : 0 });
      return send(res, out.ok ? 200 : 400, 'application/json', JSON.stringify(out));
    }
    // ── Create / edit / delete a job. Built-ins are CODE and are never writable here. ──
    if (req.method === 'POST' && p === '/api/jobs') {
      const body = await readBody(req, BODY_LIMITS.chat);
      const id = String((body && body.id) || '').trim();
      if (JOBS[id]) return send(res, 409, 'application/json', JSON.stringify({ error: `"${id}" is a built-in job · 内置任务不可覆盖` }));
      const v = validateJob(body, jobCheckOpts());
      if (!v.ok) return send(res, 400, 'application/json', JSON.stringify({ error: v.error }));
      // A NEW job is created PAUSED unless the caller says otherwise: it is armed after the
      // person has seen what it will do, which is also what makes chat-to-job safe later.
      const job = saveJob(wsDir(user), { ...body, enabled: body.enabled === true,
        pausedReason: body.enabled === true ? '' : (body.pausedReason || 'New — review, then enable · 新建，确认后启用'),
        author: body.author === 'chat' ? 'chat' : 'user' });
      audit('job-created', { who: user.id, job: job.id, enabled: job.enabled });
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, job }));
    }
    if ((req.method === 'PATCH' || req.method === 'DELETE') && /^\/api\/jobs\/[\w-]+$/.test(p)) {
      const id = p.slice('/api/jobs/'.length);
      if (JOBS[id]) {
        // A built-in is code: its title, prompt and schedule are not the user's to patch, and
        // there is no file to delete. Its ON/OFF switch is the one thing that IS theirs, so that
        // single field is accepted here and stored as a per-user override.
        if (req.method === 'DELETE') return send(res, 403, 'application/json', JSON.stringify({ error: `"${id}" is a built-in job · 内置任务不可删除 — turn it off instead · 请改为关闭` }));
        const patch = await readBody(req, BODY_LIMITS.chat);
        const keys = Object.keys(patch || {});
        if (keys.length !== 1 || keys[0] !== 'enabled' || typeof patch.enabled !== 'boolean')
          return send(res, 403, 'application/json', JSON.stringify({ error: `"${id}" is a built-in job · 内置任务只能开关 — only "enabled" can be changed` }));
        setJobEnabled(wsDir(user), id, patch.enabled);
        audit('job-updated', { who: user.id, job: id, fields: 'enabled' });
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, job: { name: id, enabled: patch.enabled } }));
      }
      const existing = loadJobFiles(wsDir(user)).jobs[id];
      if (!existing) return send(res, 404, 'application/json', '{"error":"unknown job"}');
      if (req.method === 'DELETE') {
        deleteJob(wsDir(user), id);
        audit('job-deleted', { who: user.id, job: id });
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      const patch = await readBody(req, BODY_LIMITS.chat);
      const { name, source, ...base } = existing;
      const merged = { ...base, ...patch, id };                       // the id is never patchable
      const v = validateJob(merged, { id, ...jobCheckOpts() });
      if (!v.ok) return send(res, 400, 'application/json', JSON.stringify({ error: v.error }));
      const job = saveJob(wsDir(user), merged);
      audit('job-updated', { who: user.id, job: id, fields: Object.keys(patch || {}).join(',') });
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, job }));
    }
    if (req.method === 'POST' && /^\/api\/jobs\/[\w-]+\/run$/.test(p)) {
      const job = jobsForUser(user)[p.match(/^\/api\/jobs\/([\w-]+)\/run$/)[1]];   // Run now must reach a file job too
      if (!job) return send(res, 404, 'application/json', '{"error":"unknown job"}');
      // manual:true = a person asked right now (e.g. an empty health store then gets
      // an explicit "no data yet" briefing instead of scheduled silence — R14).
      const now = new Date();
      let alreadyRanToday = false;
      try { alreadyRanToday = readJobRuns(user)[job.name] === localDateStr(now); }
      catch { /* corrupt marks file: the tick audits it; a manual run still proceeds — a person asked */ }
      let out;
      try { out = await runJobSerialized(user, job, { manual: true }); }
      catch (e) {
        // Audited like a tick failure (same job-failed shape) so the Jobs
        // view's lastOutcome stays honest for manual runs too (R5/R14).
        audit('job-failed', { who: user.id, job: job.name, manual: true, error: String(e && e.message || e) });
        return send(res, 500, 'application/json', JSON.stringify({ ok: false, error: String(e && e.message || e) }));
      }
      // Email delivery of the SAVED briefing — fire-and-forget so a slow send never
      // delays this response; failures only audit (R5).
      // A manual run is a person asking RIGHT NOW. It is returned below AND emailed,
      // whatever `deliver` says: pressing Run now is deliberate, so a message is wanted,
      // not spam.
      if (out.briefing) {
        pushBriefing(user, out.briefing);
      }
      // A manual run writes the SAME once-per-day mark the tick consults, so the
      // scheduler will not run this job AGAIN today (duplicate-briefing scar).
      try { recordJobRun(user, job.name, now); }
      catch (e) { audit('job-state-error', { who: user.id, job: job.name, error: String(e && e.message || e) }); }
      // Same job-run audit shape the tick writes (lib/jobruns.mjs tickUser) —
      // the Jobs view derives lastOutcome for manual and scheduled runs alike.
      audit('job-run', { who: user.id, job: job.name, briefing: out.briefing ? out.briefing.id : null, skipped: !!out.skipped, manual: true });
      if (out.skipped) return send(res, 200, 'application/json', JSON.stringify({ ok: true, skipped: true, alreadyRanToday }));
      // The body comes back so the caller can SHOW it. Capped: this is a status reply, not a
      // document channel — the whole briefing is always readable in the feed.
      const body = String(out.briefing.body || '').slice(0, RUN_BODY_MAX);
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, briefing: out.briefing.id,
        proposed: out.proposed.length, alreadyRanToday, body, truncated: (out.briefing.body || '').length > RUN_BODY_MAX }));
    }

    // Own profile — any user edits their own name/about/prefs (not role/age).
    if (p === '/api/profile') {
      // GET is lenient (show something); PUT is READ-BEFORE-WRITE and refuses a
      // profile it could not read — `loadProfile() || {defaults}` on the write
      // path is exactly how an unreadable profile.json became a blank one
      // (empty-overwrite class). The throw lands in the catch-all → 500
      // file_unreadable, and nothing is written.
      const defaults = { name: user.name, role: user.role, birthYear: user.birthYear || null, about: '', prefs: '' };
      const prof = req.method === 'PUT' ? loadProfileForUpdate(wsDir(user), defaults) : (loadProfile(wsDir(user)) || defaults);
      if (req.method === 'GET') return send(res, 200, 'application/json', JSON.stringify({ ...prof, id: user.id, role: user.role, age: ageFromYear(prof.birthYear, thisYear()), appOrder: Array.isArray(prof.appOrder) ? prof.appOrder : [],
        // The user's own prompt overrides (may be empty), plus the config defaults so the
        // Advanced-settings UI can prefill the effective value and offer reset-to-default.
        systemPrompts: (prof.systemPrompts && typeof prof.systemPrompts === 'object') ? prof.systemPrompts : {},
        // The override box shows ONE "default" text, so one surface has to stand for both —
        // GUARD_DEFAULT_SURFACE picks it in lib/config.mjs (R3), never a second copy here.
        systemPromptDefaults: { global: cfg.system_prompts.global || fastLaneGuard(GUARD_DEFAULT_SURFACE), apps: cfg.system_prompts.apps || {} },
        // Per-app model lane（每个应用的模型）: {slug: modelId}. Which chat model this member
        // last chose for each app. On the ACCOUNT, not the device, so a lane picked on the Mac is
        // the lane the iPhone opens with — it used to live in the shell's localStorage and had to
        // be re-picked on every device.
        appModels: (prof.appModels && typeof prof.appModels === 'object' && !Array.isArray(prof.appModels)) ? prof.appModels : {},
        // Per-app preference blobs（每个应用的偏好）: {slug: {…whatever that app defines…}}. Shown
        // and edited in the app's own ⚙ panel. Normalised to {} for the same reason appModels is.
        appPrefs: (prof.appPrefs && typeof prof.appPrefs === 'object' && !Array.isArray(prof.appPrefs)) ? prof.appPrefs : {},
        // Per-user health-threshold overrides + the config defaults (for prefill/reset).
        healthThresholds: (prof.healthThresholds && typeof prof.healthThresholds === 'object') ? prof.healthThresholds : {},
        healthThresholdDefaults: cfg.health_thresholds,
        // Briefing delivery email（简报邮箱）— empty string = email channel off for this member.
        briefingEmail: typeof prof.briefingEmail === 'string' ? prof.briefingEmail : '',
        // How many days of briefings to show (default 30). Edited in profile.json or via PUT.
        briefingRetainDays: typeof prof.briefingRetainDays === 'number' ? prof.briefingRetainDays : 30,
        postcode: typeof prof.postcode === 'string' ? prof.postcode : '',
        autoUpdateApps: !!prof.autoUpdateApps }));
      if (req.method === 'PUT') {
        const b = await readBody(req, BODY_LIMITS.profile);
        if (typeof b.name === 'string' && b.name.trim()) prof.name = b.name.trim().slice(0, 60);
        if (typeof b.about === 'string') prof.about = b.about.slice(0, 1000);
        if (typeof b.prefs === 'string') prof.prefs = b.prefs.slice(0, 1000);
        // My-Apps display order (client ▲/▼). Per-device UI pref stored on the account so
        // it syncs across the user's devices. Validate: array of slug strings, capped at 200.
        if (Array.isArray(b.appOrder)) prof.appOrder = b.appOrder.filter((s) => typeof s === 'string').slice(0, 200);
        // AI system-prompt overrides (Advanced settings), server-stored so they sync across
        // devices. Full-object replace when present: only NON-BLANK strings are kept, each
        // capped at OVERRIDABLE_PROMPT_MAX; a blank/absent field drops that override → default is used.
        // The client sends the complete form each save, so replacing is correct here.
        if (b.systemPrompts && typeof b.systemPrompts === 'object') {
          const cap = (s) => (typeof s === 'string' && s.trim() ? s.slice(0, OVERRIDABLE_PROMPT_MAX) : null);
          const sp = {};
          const g = cap(b.systemPrompts.global); if (g) sp.global = g;
          if (b.systemPrompts.apps && typeof b.systemPrompts.apps === 'object') {
            const apps = {};
            for (const [k, v] of Object.entries(b.systemPrompts.apps)) { const t = slugOk(k) ? cap(v) : null; if (t) apps[k] = t; }
            if (Object.keys(apps).length) sp.apps = apps;
          }
          prof.systemPrompts = sp;
        }
        // Per-app model lane（每个应用的模型）. Full-object replace, mirroring systemPrompts:
        // the shell holds the whole map and sends it.
        //
        // Every rejection here is LOUD. A quietly-dropped entry reads to the user as "it did not
        // remember" and they re-pick for ever without being told why (R5/R14) — and a silent
        // truncation would do the same to whichever apps fell off the end. The shell checks the
        // id too, but a client is not a trust boundary and its model list can be stale.
        // The known-id set is derived from cfg.chat_models. /api/models publishes that list minus
        // the lanes gone from Ollama (lib/model-health.mjs), so every id the shell offers is
        // storable here; a gone lane may still be stored, and is offered again if it comes back (R3).
        // An entry the profile ALREADY holds is kept even when its id has since left chat_models
        // (a lane renamed or removed from config). The shell always sends the WHOLE map, so
        // refusing it locked every app out of remembering anything, for good (R13, 2026-10-12).
        // The chat path falls back from such an id with a status line (PA_CHAT_LANE). Only an id
        // being newly stored must be in chat_models (a configured lane, even one gone from Ollama).
        if (b.appModels !== undefined) {
          if (!b.appModels || typeof b.appModels !== 'object' || Array.isArray(b.appModels)) {
            return send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid model preferences · 模型偏好格式无效' }));
          }
          const entries = Object.entries(b.appModels);
          if (entries.length > APP_MODELS_MAX) {
            return send(res, 400, 'application/json', JSON.stringify({ error: `Too many apps · 应用过多 (max ${APP_MODELS_MAX})` }));
          }
          const known = new Set((cfg.chat_models || []).map((m) => m.id));
          const stored = (prof.appModels && typeof prof.appModels === 'object' && !Array.isArray(prof.appModels)) ? prof.appModels : {};
          const am = {};
          for (const [slug, id] of entries) {
            if (!slugOk(slug)) return send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid app name · 应用名无效: ' + slug }));
            if (typeof id !== 'string' || (!known.has(id) && stored[slug] !== id)) return send(res, 400, 'application/json', JSON.stringify({ error: 'Unknown model · 未知模型: ' + id }));
            am[slug] = id;
          }
          prof.appModels = am;
        }
        // Per-app preference blobs（每个应用的偏好）— what an app's own ⚙ panel edits. The SHAPE
        // inside each blob is the app's business, so nothing here inspects it; what this owns is
        // that the map is a map, every key is a real app slug, every value is a JSON object, and
        // the whole thing stays small. profile.json is read whole on every request.
        // Refused, never truncated or partially applied — same reason as appModels (R5/R14).
        if (b.appPrefs !== undefined) {
          if (!b.appPrefs || typeof b.appPrefs !== 'object' || Array.isArray(b.appPrefs)) {
            return send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid app preferences · 应用偏好格式无效' }));
          }
          for (const [slug, v] of Object.entries(b.appPrefs)) {
            if (!slugOk(slug)) return send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid app name · 应用名无效: ' + slug }));
            if (!v || typeof v !== 'object' || Array.isArray(v)) {
              return send(res, 400, 'application/json', JSON.stringify({ error: 'Preferences must be a JSON object · 偏好必须是 JSON 对象: ' + slug }));
            }
          }
          const bytes = Buffer.byteLength(JSON.stringify(b.appPrefs), 'utf8');
          if (bytes > APP_PREFS_MAX_BYTES) {
            return send(res, 400, 'application/json', JSON.stringify({ error: `Preferences too large · 偏好过大 (${bytes} > ${APP_PREFS_MAX_BYTES} bytes)` }));
          }
          prof.appPrefs = b.appPrefs;
        }
        // Per-user health-threshold overrides (the documented feature was dead —
        // this whitelist never accepted the field). Known keys + finite numbers
        // only (lib/users.mjs); full-object replace, mirroring systemPrompts.
        if (b.healthThresholds !== undefined) {
          const ht = sanitizeHealthThresholds(b.healthThresholds, cfg.health_thresholds);
          if (ht) prof.healthThresholds = ht;
        }
        if (typeof b.briefingRetainDays !== 'undefined') {
          const v = Number(b.briefingRetainDays);
          if (!Number.isInteger(v) || v < 1 || v > 3650)
            return send(res, 400, 'application/json', JSON.stringify({ error: 'briefingRetainDays must be an integer 1–3650 · 必须为1-3650的整数' }));
          prof.briefingRetainDays = v;
        }
        // Briefing delivery email（简报邮箱）: blank clears (email delivery off);
        // non-blank must LOOK like an email (lib/users.mjs emailOk — one
        // definition, R3) or the whole save is refused loudly — never a silent
        // drop that leaves the member believing delivery is on (R5/R14).
        if (typeof b.briefingEmail === 'string') {
          const v = b.briefingEmail.trim();
          if (!v) delete prof.briefingEmail;
          else if (emailOk(v)) prof.briefingEmail = v;
          else return send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid email address · 邮箱格式无效' }));
        }
        // Postcode（邮编）— what a location-shaped tool needs so the resolver never has to ASK
        // for it. Before this, "alert me if pollen is high" came back asking for a ZIP every
        // single time, because nothing on the profile could answer it. Same whitelist pattern:
        // blank clears, junk is refused loudly, never a silent drop (R5/R14).
        if (typeof b.postcode === 'string') {
          const v = b.postcode.trim();
          if (!v) delete prof.postcode;
          else if (/^[A-Za-z0-9][A-Za-z0-9 -]{2,11}$/.test(v)) prof.postcode = v.toUpperCase();
          else return send(res, 400, 'application/json', JSON.stringify({ error: 'Invalid postcode · 邮编格式无效' }));
        }
        if (typeof b.autoUpdateApps === 'boolean') prof.autoUpdateApps = b.autoUpdateApps;
        if (!user.demo && typeof b.password === 'string' && b.password) {   // a demo visitor has no account to set a PIN on (lib/demo.mjs)
           if (apiKeyBlocked(req, user)) return send(res, 403, 'application/json', API_KEY_REFUSED);
           if (passwordError(b.password)) return send(res, 400, 'application/json', JSON.stringify({ error: passwordError(b.password) }));   // refused loudly, never silently dropped (R5)
           user.passHash = hashPassword(b.password); await upsertUser(user); cfg.sessions.destroyUserExcept(user.id, bearerOf(req)); audit('set-pin', { who: user.id }); }
        saveProfile(wsDir(user), prof);
        return send(res, 200, 'application/json', JSON.stringify({ ok: true }));
      }
    }
    // Family management — owner only.
    if (p.startsWith('/api/admin/')) {
      if (user.role !== 'owner') return send(res, 403, 'application/json', '{"error":"owner only"}');
      if (apiKeyBlocked(req, user)) return send(res, 403, 'application/json', API_KEY_REFUSED);
      // Shared-app curation (owner only).
      if (req.method === 'GET' && p === '/api/admin/share/candidates') {
        return send(res, 200, 'application/json', JSON.stringify(cfg.users.map((u) => {
          const dir = appsDir(u);
          const apps = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => slugOk(n) && fs.existsSync(path.join(dir, n, 'index.html'))) : [];
          return { user: u.id, name: u.name, apps };
        }).filter((x) => x.apps.length)));
      }
      if (req.method === 'GET' && p === '/api/admin/shared') return send(res, 200, 'application/json', JSON.stringify(listShared(SHARED)));
      if (req.method === 'POST' && p === '/api/admin/share') {
        const { from, slug } = await readBody(req, BODY_LIMITS.control);
        const src = cfg.userById.get(String(from || ''));
        if (!src || typeof slug !== 'string' || !slugOk(slug)) return send(res, 400, 'application/json', '{\"error\":\"bad user or slug\"}');
        if (!noLinkOnTheWay(src.workspace, path.join(appsDir(src), slug))) return send(res, 400, 'application/json', LINKED_APP);
        try { const pm = promote(SHARED, slug, path.join(appsDir(src), slug), src.id, { gitRef: gitHead() });
          audit('share', { who: src.id, slug, by: user.id });
          commitShelf(slug, `shelf: promote ${slug} v${pm.version} — by ${src.id}`); return send(res, 200, 'application/json', '{\"ok\":true}'); }
        catch (e) { return send(res, 400, 'application/json', JSON.stringify({ error: e.message })); }
      }
      {
        const m = /^\/api\/admin\/shared\/([a-z0-9-]+)\/(rollback|unshare)$/.exec(p);
        if (req.method === 'POST' && m) {
          try {
            if (m[2] === 'rollback') { const v = rollback(SHARED, m[1]); audit('rollback', { slug: m[1], to: v, by: user.id });
              commitShelf(m[1], `shelf: roll back ${m[1]} to ${v}`); }
            else { unshare(SHARED, m[1]); audit('unshare', { slug: m[1], by: user.id });
              commitShelf(m[1], `shelf: remove ${m[1]}`); }
            return send(res, 200, 'application/json', '{\"ok\":true}');
          } catch (e) { return send(res, 400, 'application/json', JSON.stringify({ error: e.message })); }
        }
      }
      if (req.method === 'GET' && p === '/api/admin/users') return send(res, 200, 'application/json', JSON.stringify(cfg.users.map(publicUser)));
      if (req.method === 'GET' && p === '/api/admin/audit') return send(res, 200, 'application/json', JSON.stringify(readAudit(cfg.auditFile, 100)));
      // Node settings（节点设置）— the WHITELISTED config surface, never the raw
      // file (lib/adminconfig.mjs: write-only secrets, per-field validation).
      // config.json is read FRESH so the view reflects hand edits too.
      if (req.method === 'GET' && p === '/api/admin/config') {
        const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
        return send(res, 200, 'application/json', JSON.stringify(adminConfigView(raw, cfg)));
      }
      if (req.method === 'PUT' && p === '/api/admin/config') {
        const b = await readBody(req, BODY_LIMITS.config);
        try {
          const out = applyConfigWrite(ROOT, String(b.key || ''), b.value, cfg);
          audit('config-set', { who: user.id, key: out.key, status: out.status }); // KEY NAME ONLY — a value (secret or not) never reaches the audit log
          return send(res, 200, 'application/json', JSON.stringify({ ok: true, ...out }));
        } catch (e) { return send(res, 400, 'application/json', JSON.stringify({ error: String(e && e.message || e) })); }
      }
      // Apply & restart（应用并重启）for boot-time fields: reply first, exit
      // after the response flushes — the service manager (launchd KeepAlive,
      // systemd Restart=always, run.ps1 on Windows) respawns web.mjs, which
      // re-reads config.json at load. Audited before exiting.
      if (req.method === 'POST' && p === '/api/admin/restart') {
        audit('restart', { by: user.id });
        send(res, 200, 'application/json', '{"ok":true}');
        setTimeout(() => process.exit(0), 600).unref();
        return;
      }
      if (req.method === 'POST' && p === '/api/admin/reload-config') {
        try { await reloadConfig(); } catch (e) { return send(res, 500, 'application/json', JSON.stringify({ ok: false, error: String(e.message || e) })); }
        audit('reload-config', { by: user.id });
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && p.startsWith('/api/admin/users/') && p.endsWith('/approve')) {
        const id = p.slice('/api/admin/users/'.length, -'/approve'.length);
        const t = cfg.userById.get(id);
        if (!t) return send(res, 404, 'application/json', '{"error":"not found"}');
        t.status = 'active'; provisionWorkspace(t); await upsertUser(t);
        audit('approve', { who: id, by: user.id });
        return send(res, 200, 'application/json', '{"ok":true}');
      }
      if (req.method === 'POST' && p === '/api/admin/users') {
        const b = await readBody(req, BODY_LIMITS.control);
        const id = String(b.id || '').toLowerCase();
        if (!slugOk(id)) return send(res, 400, 'application/json', '{"error":"id must be a lowercase slug"}');
        if (cfg.userById.has(id)) return send(res, 409, 'application/json', '{"error":"id already exists"}');
        if (b.password && passwordError(b.password)) return send(res, 400, 'application/json', JSON.stringify({ error: passwordError(b.password) }));
        const rec = { id, name: String(b.name || id).slice(0, 60), role: b.role === 'owner' ? 'owner' : 'member',
          birthYear: Number(b.birthYear) || null, token: crypto.randomBytes(24).toString('base64url'),
          rel: `workspace-${id}`, workspace: path.join(ROOT, `workspace-${id}`),
          passHash: b.password ? hashPassword(b.password) : null, status: 'active' };
        provisionWorkspace(rec);
        await upsertUser(rec);
        audit('create', { who: id, name: rec.name, by: user.id });
        return send(res, 200, 'application/json', JSON.stringify({ ok: true, id, hasPin: !!rec.passHash }));
      }
      if (p.startsWith('/api/admin/users/')) {
        const id = p.slice('/api/admin/users/'.length);
        const target = cfg.userById.get(id);
        if (!target) return send(res, 404, 'application/json', '{"error":"not found"}');
        if (req.method === 'PUT') {
          const b = await readBody(req, BODY_LIMITS.control);
          const prof = loadProfileForUpdate(target.workspace, { name: target.name }); // read-before-write: never rebuild a member's profile from a failed read
          if (typeof b.name === 'string' && b.name.trim()) { prof.name = b.name.trim().slice(0, 60); target.name = prof.name; }
          if (b.birthYear !== undefined) { prof.birthYear = Number(b.birthYear) || null; target.birthYear = prof.birthYear; }
          if (b.role) {
            const owners = cfg.users.filter((u) => u.role === 'owner').length;
            const wouldRemoveLastOwner = target.role === 'owner' && b.role !== 'owner' && owners === 1;
            if (id === user.id && b.role !== 'owner') return send(res, 400, 'application/json', '{"error":"cannot change your own role"}');
            if (wouldRemoveLastOwner) return send(res, 400, 'application/json', '{"error":"cannot demote the last owner"}');
            target.role = b.role === 'owner' ? 'owner' : 'member';
          }
          prof.role = target.role;
          saveProfile(target.workspace, prof);
          await upsertUser(target);
          return send(res, 200, 'application/json', '{"ok":true}');
        }
        if (req.method === 'DELETE') {
          if (id === user.id) return send(res, 400, 'application/json', '{"error":"cannot delete yourself"}');
          if (target.role === 'owner' && cfg.users.filter((u) => u.role === 'owner').length === 1) return send(res, 400, 'application/json', '{"error":"cannot delete the last owner"}');
          cfg.sessions.destroyUser(id);
          // Tombstone their workspace so a future same-username account starts clean. This is a
          // PRIVACY boundary, not tidiness: provisioning reuses any directory that already
          // exists, so a tombstone that silently did not happen hands one person's conversations,
          // notes and uploads to the next person given that username.
          //
          // On Windows renaming a directory fails outright while anything inside it is open — and
          // this server, or a claude child whose cwd is in there, is often exactly that. The old
          // `catch { /* leave in place if rename fails */ }` turned that into a silent data leak.
          // Retry first; if it still fails, the delete proceeds (the operator asked for it) but
          // the failure is audited and RETURNED, never swallowed (R5).
          let tombstoned = true, tombErr = null;
          try {
            if (fs.existsSync(target.workspace)) renameWithRetry(target.workspace, `${target.workspace}.deleted-${Date.now()}`);
          } catch (e) { tombstoned = false; tombErr = e.code || String(e.message || e); }
          await removeUser(id);
          audit('delete', { who: id, by: user.id, tombstoned, tombErr });
          return send(res, 200, 'application/json', JSON.stringify(tombstoned ? { ok: true } : {
            ok: true, warning: `Account removed, but their workspace could not be set aside (${tombErr}). `
              + `Rename or delete ${path.basename(target.rel || target.workspace)} yourself before reusing this username, `
              + `or the next account with it will inherit their private data.`,
          }));
        }
      }
    }
    // App data（应用数据）— the handwriting notebooks live here. Storage
    // integrity (atomic write, payload validation, rolling .bak) and the path
    // rule (appDataFile) are lib/appdata.mjs; this route is honest answers. EVERY
    // reply is JSON with `ok` and, on failure, a stable `code` the app broker
    // relays verbatim to the mini-app — the whole point of the 2026-09-02
    // data-loss scar was that a failure could not be seen.
    const appDataPath = (rel) => appDataFile(wsDir(user), rel);   // the path rule: lib/appdata.mjs
    if (req.method === 'POST' && p === '/api/save-data') {
      const b = (await readBody(req, BODY_LIMITS.appData)) || {};
      const rel = String(b.path || '');
      const f = appDataPath(rel);
      if (!f) return send(res, 400, 'application/json', '{"ok":false,"error":"bad path","code":"bad_path"}');
      let r;
      try { r = saveAppData(f, b.data); }
      catch (e) {
        if (e.code === 'bad_data') return send(res, 400, 'application/json', JSON.stringify({ ok: false, error: e.message, code: 'bad_data' }));
        // A write that failed must be LOUD: audited here and answered 500 with
        // a code, never an ok:true the client would record as saved (R5).
        audit('save-data-failed', { who: user.id, path: rel, error: String(e.message || e).slice(0, 200) });
        return send(res, 500, 'application/json', JSON.stringify({ ok: false, error: 'save failed · 保存失败', code: 'write_failed' }));
      }
      // Size telemetry, not enforcement (R14): a file crossing a quarter of the
      // cap, or collapsing to less than half its previous size, is REPORTED so
      // the next cliff is visible long before it is hit. Throttled per file —
      // a 700ms autosave would otherwise write an audit line every 700ms.
      if (r.warn) auditSize('save-data-large', `${user.id}:${rel}`, { who: user.id, path: rel, bytes: r.bytes, limit: r.limit });
      if (r.shrank) auditSize('save-data-shrank', `${user.id}:${rel}`, { who: user.id, path: rel, bytes: r.bytes, prevBytes: r.prevBytes });
      // Note search（笔记搜索）keeps its index warm: debounced per file (lib/note-search.mjs), audited on failure, never awaited.
      if (rel.endsWith('.json') && !demoOn(cfg)) scheduleReindex(wsDir(user), rel, { onError: (e) => audit(NOTE_INDEX_FAILED, { who: user.id, path: rel, code: e.code || INDEX_FAILED, error: String(e.message || e).slice(0, 200) }),
        after: (slug) => startOcrWorker(wsDir(user), slug, { cmd: noteOcrCmd(), onError: noteOcrAudit(user) }) });   // then transcribe what the save changed
      return send(res, 200, 'application/json', JSON.stringify(r));
    }
    // Recover the previous version of an app-data file（恢复上一版本）: puts
    // <path>.json.bak back over <path>.json atomically and leaves the backup in
    // place. Reading a backup without restoring needs no route — GET
    // /api/data/<path>.json.bak already serves it (inert content type).
    if (req.method === 'POST' && p === '/api/restore-data') {
      const b = (await readBody(req, BODY_LIMITS.control)) || {};
      const rel = String(b.path || '');
      const f = appDataPath(rel);
      if (!f) return send(res, 400, 'application/json', '{"ok":false,"error":"bad path","code":"bad_path"}');
      const r = restoreAppData(f);
      audit('restore-data', { who: user.id, path: rel, ok: r.ok, code: r.code || '' });
      return send(res, r.ok ? 200 : ({ no_backup: 404, bad_path: 400 }[r.code] || 500), 'application/json', JSON.stringify(r));
    }
    // AWAITED, not returned. `try { return promise }` does not catch that
    // promise's rejection — so a chat() that fails BEFORE it writes headers (a
    // damaged conversation file, see below) used to become an unhandled
    // rejection and the request simply HUNG: no status, no body, no timeout.
    // The same invisible-failure shape as the defect it was added to report.
    if (req.method === 'POST' && p === '/api/chat') { await chat(req, res, user, await readBody(req, BODY_LIMITS.chat)); return; }
    // /api/ask is APP-ONLY: its one caller is the shell broker's 'ask' kind. So it is confined
    // whoever is signed in, marker or not — the relay's header is still sent, and checked by
    // test/app-agent-confinement.test.mjs, but this route does not depend on it.
    if (req.method === 'POST' && p === '/api/ask') {
      const { message } = await readBody(req, BODY_LIMITS.chat);
      // No slug: an ask has no conversation to tag, and an app's agent writes nothing (ADR 0019).
      const origin = { fromApp: true };
      if (typeof message !== 'string' || !message.trim()) return send(res, 400, 'application/json', '{"error":"empty message"}');
      res.writeHead(200, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' });
      res.flushHeaders?.();
      const beat = setInterval(() => { if (!res.writableEnded) res.write(' '); }, 20000); // whitespace heartbeat; JSON.parse ignores leading spaces
      try {
        const r = await enqueue(() => runAgent(message, agentArgs(user, fastBaseArgs(user, origin), origin), wsDir(user), 5 * 60000, agentCapabilities(laneRole(user, origin), APP_CONTRACT)));
        clearInterval(beat);
        res.end(JSON.stringify({ ok: r.ok, text: r.text }));
      } catch (e) { clearInterval(beat); if (!res.writableEnded) res.end(JSON.stringify({ ok: false, text: e.message })); }
      return;
    }
    send(res, 404, 'text/plain', 'not found');
  } catch (e) {
    console.error('[web]', e.message);
    // ONE mapping for every unhandled request failure (lib/webutil.mjs): 413 +
    // {"code":"payload_too_large","limit":N} for an oversize body, 400
    // bad_json, 408 body_incomplete, 500 server_error — always JSON. The old
    // `400 text/plain "error"` broke the app broker's r.json(), so an app could
    // never learn that its notebook was simply too large (DATA-LOSS SCAR).
    if (!res.headersSent) { const r = bodyErrorResponse(e); send(res, r.status, 'application/json', r.body); }
    else if (!res.writableEnded) res.end();
  }
});

// ── Minimal schedule trigger (docs/JOB_ENGINE_PLAN.md "schedules first"; the
// fuller trigger runtime — webhooks, on-change — stays deferred). Once a minute,
// fire any JOBS entry carrying a `schedule` that is due for each active user.
// The reliability core lives in lib/jobruns.mjs (unit-tested): marks are written
// AFTER a successful run with bounded same-day retries, a corrupt job-runs.json
// skips the cycle loudly instead of resetting every mark, no per-user file is
// read while nothing is due by time, and users tick concurrently.
let tickRunning = false; // reentrancy guard: a >60s job must not overlap the next tick
setInterval(async () => {
  if (demoOn(cfg)) return;   // a demo node runs no accounts' jobs or reminders, even if turned on live
  if (tickRunning) return;
  tickRunning = true;
  try {
    try {
      await jobsTick({ users: cfg.users, jobs: jobsForUser, audit,
        runJobFor: async (u, job) => {
          // Settle the approval loop (pre-approved execute + annotate) BEFORE the
          // email, so the message reports 预批准执行 outcomes. Sweep + store run
          // in the per-user queue (runJobSerialized); the LLM pass stays outside it.
          const out = await runJobSerialized(u, job, { manual: false });
          // Email delivery AFTER the save; pushBriefing never rejects, so a
          // failed send can never mark the job failed or re-fire it (see lib/notify.mjs).
          if (out && out.briefing) await pushBriefing(u, out.briefing);
          return out;
        } });
    } catch (e) { audit('job-tick-error', { error: String(e && e.message || e) }); }
    // Reminders run AFTER jobs in the SAME serialized tick — never concurrently.
    // Both write job-runs.json; the parallel writers with stale snapshots were
    // the duplicate-briefing/duplicate-reminder lost-update scar.
    try { await remindersTick({ users: cfg.users, audit, deliver: deliverReminder }); }
    catch (e) { audit('reminder-tick-error', { error: String(e && e.message || e) }); }
  } finally { tickRunning = false; }
}, 60_000).unref();

// Startup recovery: close any approval stranded by a crash mid-execution
// (status 'approved' past the limbo window → 'failed', audited). Corrupt
// per-user stores are surfaced, never allowed to kill the boot (R5).
for (const u of cfg.users.filter((x) => x.status === 'active')) {
  withUserLock(u.id, () => sweepStrandedApprovals(u, Date.now(), audit))
    .catch((e) => audit('action-sweep-error', { who: u.id, error: String(e && e.message || e) }));
}

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => { console.error('[uncaughtException]', e); process.exit(1); });

// ── Lifecycle（生命周期）— a service manager (launchd, systemd, run.ps1) owns this
// process in production (see start.sh/stop.sh for the ownership model). Two
// scars addressed here, both regression-tested in test/web-lifecycle.test.mjs:
//  1. EADDRINUSE at listen: under KeepAlive an instant crash means an instant
//     respawn into the SAME still-draining port — a crash loop. Retry the
//     listen on a short fixed backoff instead; only after LISTEN_RETRIES
//     failures is the error real (another owner holds the port) and rethrown
//     with context so uncaughtException exits loudly.
//  2. Abrupt exit on stop: SIGTERM (launchctl bootout/kill) now closes the
//     listener, lets in-flight responses finish, and a forced-exit timer
//     bounds the wait so a stuck stream can never hang the stop.
const LISTEN_RETRIES = 10;
const LISTEN_RETRY_MS = 500;
const SHUTDOWN_FORCE_EXIT_MS = 5000;
let listenAttempts = 0;
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE' && listenAttempts < LISTEN_RETRIES) {
    listenAttempts += 1;
    console.error(`[web] port ${PORT} in use — retrying listen ${listenAttempts}/${LISTEN_RETRIES} in ${LISTEN_RETRY_MS}ms`);
    setTimeout(() => server.listen(PORT, BIND_HOST), LISTEN_RETRY_MS);
    return;
  }
  throw new Error(`[web] server error${e && e.code ? ` (${e.code})` : ''} — ${e && e.message || e}`); // → uncaughtException → exit(1) → launchd respawns
});
// Live config (docs/adr/0011): the config.json loadConfig(ROOT) reads is watched, and an edit is
// reloaded into the live cfg, read-only (reloadConfig) — so a tunable read where it is used
// (cfg.one_shot_args, cfg.one_shot_model, …) changes with no restart. What web.mjs captures at
// boot (lib/adminconfig.mjs boot:true fields, PORT, MAIL, MAX_CONCURRENT) still needs one. A bad
// edit (half-written or invalid JSON, a value the validator refuses) is audited and logged, and the
// server keeps running on the last good config (R5): stopping a node that is serving over a typo
// in a file it already loaded would turn an edit someone can fix in seconds into an outage. The
// audit gets the reason with any quoted text cut, since a JSON.parse error quotes the file around
// the fault, and that may be a secret.
const unwatchConfig = watchConfig(configPath(ROOT), () => reloadConfig({ keepAccounts: true }), {
  onError: (e) => {
    const error = String((e && e.message) || e);
    audit('config-reload-failed', { error: error.replace(/"[\s\S]*"/g, '"…"').slice(0, 300) });
    console.error(`[web] config.json reload failed, still running on the last good config: ${error}`);
  },
});
let shuttingDown = false;
// SIGINT and SIGBREAK as well as SIGTERM, because Windows delivers no SIGTERM at all: Node
// emits it only when another Node process calls process.kill, and stop.ps1 uses taskkill /F,
// which cannot be caught by anything. SIGINT (Ctrl+C) and SIGBREAK (Ctrl+Break) ARE delivered
// there, so an interactive stop drains properly; a taskkill still does not, and the only reason
// that is survivable is that every write in the app is tmp+rename atomic — a kill mid-write
// leaves the old file or the new one, never half of either. Do not weaken that invariant.
const shutdown = (sig) => {
  if (shuttingDown) return;
  shuttingDown = true;
  unwatchConfig();
  console.error(`[web] ${sig} — closing listener, draining in-flight requests (max ${SHUTDOWN_FORCE_EXIT_MS}ms)`);
  server.close(() => process.exit(0));
  server.closeIdleConnections?.(); // keep-alive sockets with no request must not hold the close
  setTimeout(() => { console.error('[web] shutdown deadline reached — forcing exit'); process.exit(1); }, SHUTDOWN_FORCE_EXIT_MS).unref();
};
for (const sig of ['SIGTERM', 'SIGINT', 'SIGBREAK']) {
  // SIGBREAK does not exist off Windows; registering it there throws.
  try { process.on(sig, () => shutdown(sig)); } catch { /* not a signal on this platform */ }
}
// 'listening', not a listen() callback: a first bind that fails EADDRINUSE drops that callback, and
// the retry above would then serve without ever minting the setup code.
server.once('listening', () => {
  listenAttempts = 0;
  console.log(`[web] http://localhost:${PORT}  (bound to ${BIND_HOST}; set bind_host in config.json to change)`);
  // First run: setup needs the one-time code (lib/setup-code.mjs). Never on a demo node (no owner).
  if (!demoOn(cfg) && ownerNeedsSetup(cfg.users)) console.log(`[web] first-run setup code · 初始化码: ${ensureSetupCode(ROOT)}  (also in ./setup-code)`);
  else consumeSetupCode(ROOT);   // set up already (e.g. by setup.mjs): no code may linger
});
server.listen(PORT, BIND_HOST);

