// Where an agent request came from, and therefore which lane it runs in · 请求来源与智能体通道
//
// THE HOLE THIS CLOSES (2026-10-11). An app is a sandboxed iframe that reaches superelf only
// through the shell's postMessage broker (web/index.html). Its 'chat' and 'ask' kinds are relayed
// to /api/chat and /api/ask with the SIGNED-IN user's token. agentArgs (web.mjs) gave the OWNER
// the unrestricted lane (--dangerously-skip-permissions), so any app opened in the owner's session
// — including a member-authored app promoted to the family shelf — could make the owner's agent
// run any command, as the owner's Unix user. Members were already confined; the owner was not.
//
// THE RULE. Every agent request that ORIGINATES IN AN APP runs confined, whoever is signed in.
// Only the owner's own chat (the shell composer, not an app) keeps the unrestricted lane.
//
// WHY THE MARKER IS TRUSTWORTHY. An app cannot make an HTTP request of its own: it is served with
// `sandbox allow-scripts` (no allow-same-origin → an opaque origin) and `connect-src 'none'`, and
// the bearer token lives only in the shell (web.mjs app hosting; web/index.html `api`). So every
// request an app causes is built by the SHELL's relay code, and the relay — not the app — adds
// this header on every agent-reaching kind (web/index.html appAgentInit). The shell composer
// never adds it. `app` (the slug the shell derives from the frame URL) is ALSO accepted as a
// marker, so a request is treated as app-originated if EITHER is present: forging the body's app
// field empty cannot win back the owner's lane while the header is there.
//
// THE RULE HAS TWO MORE HALVES (2026-10-11, review round 1). Confining the app's OWN turn was not
// enough: the app could still reach the owner's unrestricted lane one ordinary chat later.
//   A. By continuing one of the owner's composer conversations (chat() took any convoId). Its
//      text was stored as the owner's own words and replayed to the unrestricted lane as a prior
//      'User:' turn. → A conversation belongs to the surface that started it (convoTag).
//   B. By having its confined agent WRITE a file the unrestricted lane trusts — profile.json
//      (systemPrompts.global), CLAUDE.md, memory/, conversations/ — all inside the workspace,
//      which acceptEdits allowed. → An app's agent writes nothing (laneArgs; ADR 0019).
//
// R3: the header name is ONE literal here; the shell's copy is pinned to it by
// test/app-agent-confinement.test.mjs (the precedent is GZIP_ENCODING in lib/gzipbody.mjs).

export const APP_ORIGIN_HEADER = 'x-superelf-origin';
export const APP_ORIGIN_VALUE = 'app';

// ANY value of the header counts, not only APP_ORIGIN_VALUE: the composer never sends it at all,
// so a malformed value is still not the composer, and failing closed is the safe reading.
export function appOriginated(headers, body) {
  if (headers && headers[APP_ORIGIN_HEADER] !== undefined) return true;
  const app = body && body.app;
  return typeof app === 'string' ? app.trim() !== '' : !!app;
}

// THE one decision (R3) — agentArgs, the capability note, the Codex lane and the Verify panel all
// ask this, so they cannot disagree about who is confined.
// Fails CLOSED: only an explicit { fromApp: false } from the owner earns the unrestricted lane. A
// call site that forgets to say where its request came from is confined, which is visible (the
// owner notices a lost capability) rather than silent (an app quietly keeping full access).
export function agentConfined(user, origin) {
  if (!(user && user.role === 'owner')) return true;
  return !(origin && origin.fromApp === false);
}

// ── A. Which surface a conversation belongs to · 对话归属 ─────────────────────────────────────
// The composer's conversations carry no tag; an app's carry its slug, or APP_UNNAMED_TAG when an
// app-originated request arrived without one (it is still an app's, and must stay out of the
// composer's drawer). Fails closed like agentConfined: only an explicit { fromApp: false } is the
// composer.
export const APP_UNNAMED_TAG = '(app)';
export function convoTag(origin) {
  if (origin && origin.fromApp === false) return undefined;
  const app = origin && typeof origin.app === 'string' ? origin.app.trim() : '';
  return app || APP_UNNAMED_TAG;
}
// A turn may continue a conversation only if it comes from the same surface. Both directions:
// an app may not write into the composer's history, and the composer (unrestricted for the owner)
// may not resume an app's — that history and that CLI session were written by the app.
export function convoReachable(convo, origin) {
  return ((convo && convo.app) || undefined) === convoTag(origin);
}

// ── B. What a confined lane may do, as argv · 受限通道的参数 ───────────────────────────────────
// Measured against the real CLI (Claude Code 2.1.161), 2026-10-11, in a throwaway directory, as the
// Unix user the server runs as. Every row was run, none assumed:
//   acceptEdits                 `echo hi > bash.txt`                       → RAN
//   acceptEdits                 `curl -s -o ../outside.html https://…`     → RAN, wrote OUTSIDE the cwd
//       (~/.claude/settings.json on that machine allows `Bash(curl *)`, and acceptEdits honours
//        it; the 2026-09-11 measurement that found Bash denied predates that rule)
//   acceptEdits                 write profile.json, CLAUDE.md, memory/MEMORY.md, data/other/x.md
//                                                                          → ALL WRITTEN
//   default + --allowedTools 'Edit(./data/tasks/**)' + --disallowedTools Bash (the app lane then):
//       write/edit data/tasks/tasks.md, create data/tasks/new.md and data/tasks/sub/deep.md → DONE
//       profile.json, CLAUDE.md, memory/MEMORY.md, data/other/x.md                        → DENIED
//       data/tasks/../../profile.json and <abs>/data/tasks/../../CLAUDE.md                → DENIED
//       Bash echo, Bash curl, Read ../secret.txt, WebFetch                                → DENIED
// An explicit deny beats an allow rule from ANY settings source, so it is the only "no Bash" that
// does not depend on how the machine happens to be configured. Every confined lane gets it.
// The CLI's own home is denied the same way (2026-10-12, ADR 0012). The CLI ALLOWS every
// lane to Write and Read its auto-memory store, ~/.claude/projects/<git root>/memory/, which the
// owner's own Claude Code sessions in the checkout load. Measured on 2.1.161, throwaway repo:
//   app lane then (default + Edit(./data/x/**) + deny Bash): Write the store → WRITTEN
//   member lane (acceptEdits + deny Bash): Read the store                → READ
//   + deny Edit(~/.claude/**) Read(~/.claude/**):
//       app lane: Write, Read, Grep, Glob of the store, a Write to ~/.CLAUDE/…,
//                 a Read of a tool result the CLI saved under ~/.claude,
//                 a Read through a /tmp/claude-<uid>/… symlink into ~/.claude,
//                 the CLI's own inlining of an @<store file> in the prompt  → DENIED
//       member lane: Write, Read of the store                               → DENIED
//       the app's own data/<slug>/ (its rule then), the member's own workspace → still WRITTEN
//   app lane, the same denies given in a second --disallowedTools flag      → still DENIED
// Under the bypass (2026-10-12, 2.1.161, throwaway cwd; the member lane the old laneArgs built from
// a member_args carrying it: acceptEdits + --dangerously-skip-permissions + these denies):
//   Write, Read under ~/.claude/projects/<throwaway>/  → DENIED ("denied by your permission settings")
//   Bash                                               → not offered to the model at all
//   control: the bypass alone, the same Write          → WRITTEN
// So the denies hold, but the bypass still voids the cwd boundary and `default` mode. It never
// reaches a confined lane (withoutBypass, below).
// It gates the file tools and @-inlining only: not MCP tools, and the CLI still loads ~/.claude/CLAUDE.md
// and skills itself.
export const CONFINED_DENY_ARGS = ['--disallowedTools', 'Bash', 'Edit(~/.claude/**)', 'Read(~/.claude/**)'];
// An app's agent WRITES NOTHING (2026-10-19, ADR 0019). `default` mode denies every edit no rule
// allows, and an app lane is given no allow rule. It had `Edit(./data/<slug>/**)` so that Tasks' agent
// could write tasks.md; since ADR 0014 Tasks saves through save-data and no app asks its agent to write.
// The rule was then only a way in: save-data refuses CLAUDE.md, AGENTS.md and dot directories
// (lib/appdata.mjs appDataFile), and the rule allowed any name. Measured 2026-10-17, 2.1.161, a
// throwaway git root, the lane built here and spawned by lib/runner.mjs runClaude:
//   with Edit(./data/probe/**): Write data/probe/CLAUDE.md, CLAUDE.local.md, AGENTS.md, sub/CLAUDE.md
//                               → WRITTEN; data/probe/.claude/settings.json → DENIED (the CLI's own guard)
//   a later run that only Read data/probe/list.txt obeyed the planted CLAUDE.md → 2 of 2 (0 of 1 without)
// And 2026-10-19, the lane without the rule: the same six Writes, data/probe/notes.md too → DENIED,
// nothing on disk; a Read of uploads/reading.txt (what Diabetes, Longevity and Notes ask for) → READ.
// An operator's own permission flags are dropped from an APP lane (with their values): a
// `--permission-mode acceptEdits` from member_args, or a broad `--allowedTools`, would let it write.
// The values are the non-flag words that follow, so both forms are handled.
const PERMISSION_FLAGS = ['--permission-mode', '--allowedTools', '--allowed-tools'];
function withoutPermissionFlags(args) {
  const out = [];
  let skipping = false;
  for (const a of args) {
    if (PERMISSION_FLAGS.includes(a)) { skipping = true; continue; }
    if (skipping && !String(a).startsWith('-')) continue;
    skipping = false;
    if (PERMISSION_FLAGS.some((f) => String(a).startsWith(f + '='))) continue;
    out.push(a);
  }
  return out;
}
export const SKIP_PERMISSIONS = '--dangerously-skip-permissions';   // also lib/one-shot.mjs (R3)
// THE bypass, in every spelling a confined lane could be handed it, struck from base (claude_args,
// fast_args, one_shot_args) and member_args alike: config.json can put it in any of them (R13
// review 2026-10-12: member_args was not stripped). Measured 2026-10-12, 2.1.161, throwaway cwd:
//   --permission-mode bypassPermissions, alone: Write outside the cwd → WRITTEN (it IS the bypass)
//   control, --permission-mode acceptEdits: the same Write            → DENIED
//   --dangerously-skip-permissions=1 → the CLI refuses to start ("unknown option"); struck anyway
// --allow-dangerously-skip-permissions only makes the bypass available; struck too (fails closed).
const BYPASS_FLAGS = [SKIP_PERMISSIONS, '--allow-dangerously-skip-permissions'];
const BYPASS_MODE = 'bypassPermissions';
// The pair is judged on what SURVIVES: a struck token between `--permission-mode` and the mode must
// not join them into the bypass (R13 round 2: `--permission-mode <struck> bypassPermissions`).
function withoutBypass(args) {
  const out = [];
  for (const raw of args) {
    const a = String(raw);
    if (BYPASS_FLAGS.some((f) => a === f || a.startsWith(f + '='))) continue;
    if (a === `--permission-mode=${BYPASS_MODE}`) continue;
    if (a === BYPASS_MODE && String(out[out.length - 1]) === '--permission-mode') { out.pop(); continue; }
    out.push(raw);
  }
  return out;
}
// WHAT CONFINES A LANE GOES FIRST, and every confined lane pins a mode (R13 round 1, 2026-10-13).
// Measured 2026-10-13, 2.1.161, throwaway cwd (the mode is the init event's permissionMode):
//   --permission-mode default                                  Write inside the cwd → DENIED
//   --permission-mode default --permission-mode acceptEdits    → acceptEdits, WRITTEN (the LAST wins)
//   --permission-mode acceptEdits --permission-mode default    → default, DENIED
//   --settings {"permissions":{"defaultMode":"bypassPermissions"}}, no mode: Write outside → WRITTEN
//   the denies, --permission-mode default, that --settings:    Write outside → default, DENIED
//     … then --permission-mode acceptEdits:                    outside → DENIED, inside → WRITTEN
//   --model --dangerously-skip-permissions → ran with the MODEL named "--dangerously-skip-permissions"
//   --permission-mode auto: Write outside → DENIED;  dontAsk: Write inside or outside → DENIED
//   --managed-settings {"permissions":{"defaultMode":"bypassPermissions"}}: ignored (mode default)
// So: a mode on argv beats --settings' defaultMode, which can be the bypass (measured for --settings; the
// CLI reference documents that --permission-mode overrides defaultMode from settings files; ADR 0002) —
// the pin closes that route for a member_args with no mode left. A flag missing its value takes the next
// token whatever it is, so the denies and the pin come BEFORE the operator's args, where none can
// swallow them, and a member's own mode, later, still wins. auto and dontAsk are not the bypass.
const PINNED_MODE = ['--permission-mode', 'default'];
// THE lane argv for one request. The owner's own chat: `base`, untouched. A member's own chat: the
// denies, the pinned mode, then base and member_args minus the bypass (even if an operator put it
// back in config.json, in either). Anything else (an app's turn, or an origin nobody stated): the
// denies, `default` mode with nothing writable, then that minus every permission flag.
export function laneArgs(user, base, memberArgs, origin) {
  const args = Array.isArray(base) ? base : [];
  if (!agentConfined(user, origin)) return args;
  const operator = withoutBypass([...args, ...(Array.isArray(memberArgs) ? memberArgs : [])]);
  if (origin && origin.fromApp === false) return [...CONFINED_DENY_ARGS, ...PINNED_MODE, ...operator];
  return [...CONFINED_DENY_ARGS, ...PINNED_MODE, ...withoutPermissionFlags(operator)];
}
