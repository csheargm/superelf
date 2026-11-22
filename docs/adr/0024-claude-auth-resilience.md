# ADR 0024 — Claude sign-in resilience: a token file, a watchdog, a Codex fallback（Claude 登录韧性）

Status: accepted · 2026-11-10

## Context

- The Mac node runs Claude Code headless (`claude -p`, lib/runner.mjs) on the owner's Keychain
  sign-in. On 2026-11-10 that sign-in expired: every Claude turn, every job resolver call and every
  one-shot component answered "Failed to authenticate. API Error: 401 OAuth access token has been
  revoked." until someone sat at the Mac and ran `claude auth login`. Nothing on the node knew, and
  the family saw a wall of identical failures.
- Measured the same day: the CLI reports it as a RESULT line, `{type:'result', is_error:true,
  api_error_status:401, result:'Failed to authenticate. API Error: 401 …'}`, exit 1 — so
  lib/runner.mjs hands it back as `{ ok:false, text }` like any other failure, and no caller told it
  apart from a timeout.
- `claude setup-token` mints a long-lived token the CLI reads from `CLAUDE_CODE_OAUTH_TOKEN`. The
  node already has a Codex lane (`provider: 'codex'`, lib/codex.mjs) on the ChatGPT subscription.
- Precedents: the model-health state file and the daily `model-check` job with its once-only
  briefing (lib/model-health.mjs, ADR 0007); tunables read from the live config (ADR 0011).

## Decision

1. **Token file（长期令牌）— lib/claude-token.mjs.** `cfg.claude_token_file` (default
   `<node root>/claude-token`, gitignored) is read at EVERY Claude spawn through
   `claudeChildEnv()`. A non-empty first line becomes `CLAUDE_CODE_OAUTH_TOKEN` in the child's env;
   an absent or blank file changes nothing (the Keychain login as before). The value never reaches
   a log; only "present/absent" is logged, once per change. A mode other than 600 is warned about
   once and the file is still used — refusing it would recreate the outage.
2. **Watchdog（看门狗）— lib/claude-auth.mjs.** `isAuthFailure(text)` matches the CLI's own lines.
   `claude-auth.json` (node root, gitignored) holds `{ failedAt, lastError, reported, okAt }`. A chat
   turn that meets the failure records it (`reported:false`); the daily `model-check` job runs one
   cheap probe (`Reply OK`, haiku, `--tools= --strict-mcp-config`, 60 s) and briefs the owner ONCE
   per episode with the fix command, through the job's existing briefing (saved → lib/notify
   email). `noteOk` closes the episode and the job says "works again" once. A probe that fails for
   another reason is no verdict (audited, state untouched). The probe runs before the Ollama
   probes, so an Ollama outage cannot hide the sign-in report.
3. **Codex fallback（备用通道）— lib/lane-codex.mjs.** The Codex chat lane is ONE function
   (`runCodexLane`, session resume + fresh retry + status line), used by the chooser's Codex lane
   and by `codexFallback`. In the Claude agent lane, a conversation turn whose result is an auth
   failure runs the SAME prompt through the configured Codex lane and the reply starts with
   `CODEX_FALLBACK_PREFIX`. No Codex lane → the sign-in line; Codex failing too → both errors. A
   oneShot turn is NOT redirected (a component expects one Claude answer, not another agent's): it
   gets the sign-in line, and the failure is still recorded. The fallback result carries no session
   id, so Codex's session can never be stored as the conversation's Claude session.
4. **One line per condition (R3).** `CLAUDE_SIGNIN_EXPIRED` and `CODEX_FALLBACK_PREFIX` live in
   lib/claude-auth.mjs and are the only spelling in replies, briefings and tests.

## Privacy note

On a fallback, that turn's prompt — the message, the history block the Claude lane would have
sent, and any attached image paths — goes to OpenAI (Codex) instead of Anthropic. Nothing else
changes: conversation summaries, the transcript index and every other lane are untouched, and the
reply says who answered. A confined turn — an app's or a member's — is never redirected (CONFINED
TURNS NEVER REACH CODEX, PA_CHAT_LANE): it gets the sign-in line, so an app can never route text to
OpenAI through an expired sign-in. A household that must not send text to OpenAI removes the Codex lane from
`chat_models`; the turn then fails with the sign-in line instead.

## Consequences

- Owner commands: `claude setup-token`, paste the token into `claude-token` with a hidden read
  prompt (never on a command line), `chmod 600 claude-token`. No restart (ADR 0011).
- Tests: unit tests for the three modules (test/claude-token, claude-auth, lane-codex) and an
  end-to-end file (test/claude-auth-fallback.test.mjs) driving the real chat and Run-now routes
  with a fake `claude` that prints the real 401 line and a fake `codex`.
- web.mjs grew by the fallback branch and the job wiring; the lane dispatch is still the R4 seam
  named in web.mjs (TODO(R4 seam)).
