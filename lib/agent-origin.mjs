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
import path from 'node:path';

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
// An edit panel's turn (lib/app-edit.mjs, ADR 0040) is the owner's own lane but its own surface:
// 'app-edit:<slug>', so neither the composer nor the app's chat can resume it, nor it theirs.
export const EDIT_TAG_PREFIX = 'app-edit:';
export function convoTag(origin) {
  if (origin && origin.fromApp === false) return typeof origin.edit === 'string' && origin.edit ? EDIT_TAG_PREFIX + origin.edit : undefined;
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
// A confined lane loads NO MCP server, whatever config.json says: every --mcp-config (and its
// values) is dropped and --strict-mcp-config is always added, so the host account's Gmail /
// Calendar / Drive connectors never reach a member or an app (F4-1; GPT review 2026-11-22).
const NO_MCP = ['--strict-mcp-config'];
function withoutMcpConfig(args) {
  const out = [];
  let skipping = false;
  for (const raw of args) {
    const a = String(raw);
    if (a === '--mcp-config') { skipping = true; continue; }
    if (skipping && !a.startsWith('-')) continue;
    skipping = false;
    if (a.startsWith('--mcp-config=') || a === '--strict-mcp-config') continue;
    out.push(raw);
  }
  return out;
}
export function laneArgs(user, base, memberArgs, origin) {
  const args = Array.isArray(base) ? base : [];
  if (!agentConfined(user, origin)) return args;
  const operator = [...NO_MCP, ...withoutMcpConfig(withoutBypass([...args, ...(Array.isArray(memberArgs) ? memberArgs : [])]))];
  if (origin && origin.fromApp === false) return [...CONFINED_DENY_ARGS, ...PINNED_MODE, ...operator];
  return [...CONFINED_DENY_ARGS, ...PINNED_MODE, ...withoutPermissionFlags(operator)];
}

// 改应用只限本应用 · The owner's CONFIRMED app-chat change (ADR 0042 addendum): the full agent, jailed to
// apps/<slug>/. No bypass, `default` mode, no Bash, no MCP; the only allow rule is Edit (which covers
// Write) under the app's folder, and instruction files and dot-names are denied even there (ADR 0019:
// a planted CLAUDE.md steers the next agent that reads the folder). `realAppDir` must be absolute
// and real (no symlinks), so the rule names what the CLI resolves. Measured 2026-11-24, CLI 2.1.327,
// a throwaway workspace, these flags: Write apps/demo/notes.txt and Edit apps/demo/index.html →
// WRITTEN; Write <ws>/outside.txt → DENIED ("permission not granted"); apps/demo/CLAUDE.md,
// apps/demo/.hidden, apps/demo/sub/AGENTS.md → DENIED ("denied by your permission settings").
// The server's post-turn check (lib/app-edit-jail.mjs) is the backstop either way.
const INSTRUCTION_DENIES = ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md', 'AGENTS.override.md', 'GEMINI.md']
  .map((n) => `Edit(//**/${n})`);
// Allow rules ADD UP (GPT review): one from ~/.claude or project settings, or an operator --settings, would
// widen the jail. So no settings file loads (`--setting-sources=`) and every --settings is dropped.
// Measured 2026-11-24, CLI 2.1.327: a settings.local.json allowing Edit(//**) → outside Write WRITTEN;
// the same with --setting-sources= → DENIED.
const SETTINGS_FLAGS = ['--settings', '--setting-sources'];
function withoutSettings(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (SETTINGS_FLAGS.includes(a)) { i += 1; continue; }
    if (SETTINGS_FLAGS.some((f) => a.startsWith(f + '='))) continue;
    out.push(args[i]);
  }
  return out;
}
// A permission rule names paths in POSIX form; on Windows the CLI documents C:\\x\\y as /c/x/y (not measured
// here: the server backstop holds either way). '//' + that = an absolute rule.
export const rulePath = (p) => {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(String(p));
  return m ? `/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}` : String(p);
};
// readable: absolute REAL paths the turn may also read (the app's data folder, its saved versions, the
// attached screenshot) — each one Read allow rule; a folder ends in '/'. The turn runs with cwd = the app folder.
const readRules = (readable) => (Array.isArray(readable) ? readable : []).filter((p) => typeof p === 'string' && path.isAbsolute(p))
  .map((p) => (p.endsWith('/') ? `Read(/${rulePath(p)}**)` : `Read(/${rulePath(p)})`));
const TOOLS_FLAG = '--tools';
const withoutTools = (args) => args.filter((a, i) => !(a === TOOLS_FLAG || String(a).startsWith(TOOLS_FLAG + '=') || args[i - 1] === TOOLS_FLAG));
// --add-dir widens what cwd-relative rules and default-mode reads reach: never on an app-chat lane (GPT review r1).
const withoutAddDir = (args) => { const out = []; for (let i = 0; i < args.length; i++) { const a = String(args[i]);
  if (a === '--add-dir') { while (i + 1 < args.length && !String(args[i + 1]).startsWith('-')) i += 1; continue; } if (a.startsWith('--add-dir=')) continue; out.push(args[i]); } return out; };
const jailBase = (args) => withoutAddDir(withoutTools(withoutSettings(withoutPermissionFlags(withoutMcpConfig(withoutBypass(Array.isArray(args) ? args : []))))));
// The confirmed turn's whole tool set (GPT review r1): file tools only, so the jail watch sees every write a tool can make.
export const JAIL_TOOLS = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write']);
export function appJailArgs(base, realAppDir, readable = []) {
  return [...CONFINED_DENY_ARGS, ...INSTRUCTION_DENIES, 'Edit(//**/.*)', 'Edit(//**/.*/**)', ...PINNED_MODE, ...NO_MCP, '--setting-sources=',
    TOOLS_FLAG, JAIL_TOOLS.join(','), '--allowedTools', `Edit(/${rulePath(realAppDir)}/**)`, ...readRules(readable), ...jailBase(base)];
}
// 先看后改 · An UNCONFIRMED owner app-chat turn (a question, or the plan before 改 · Apply): Read, Glob and
// Grep only, cwd = the app's real folder. `default` mode reads inside cwd and refuses anything else no
// rule allows. It used to run with NO tools (--tools=), and the model, still told by the CLI's own prompt
// that it has tools, printed its calls as text: `<invoke name="Read">…` was the whole reply. Measured
// 2026-11-24, CLI 2.1.327, cwd ws/apps/cal, these flags: Read index.html and an allowed ../../data/cal file
// → READ; Read ws/secret.txt (relative and absolute) and Glob ws/** → refused ("permission … not granted").
export const READ_TOOLS = Object.freeze(['Read', 'Glob', 'Grep']);
export function appReadArgs(base, readable = []) {
  const rules = readRules(readable);
  return [...CONFINED_DENY_ARGS, ...PINNED_MODE, ...NO_MCP, '--setting-sources=', TOOLS_FLAG, READ_TOOLS.join(','),
    ...(rules.length ? ['--allowedTools', ...rules] : []), ...jailBase(base)];
}
// 改 superelf 核心 · The owner's core-change lane (docs/adr/0044 §3): the app jail's pieces, cwd = the real
// git checkout of superelf. File tools only (no Bash: the server runs the tests), Edit allowed only
// under the checkout, and never its .git, its .github workflows, dot-names or instruction files.
// lib/selfpub/lane.mjs checks what changed afterwards (git status) and fails the turn on any write outside.
export function coreJailArgs(base, realRepoDir) {
  const r = rulePath(realRepoDir);
  return [...CONFINED_DENY_ARGS, ...INSTRUCTION_DENIES, `Edit(/${r}/.git/**)`, `Edit(/${r}/.github/**)`, 'Edit(//**/.*)', 'Edit(//**/.*/**)',
    ...PINNED_MODE, ...NO_MCP, '--setting-sources=', TOOLS_FLAG, JAIL_TOOLS.join(','), '--allowedTools', `Edit(/${r}/**)`, ...jailBase(base)];
}
// 服务代码只读 · The owner's unrestricted lane never edits superelf's served code or the self-publish
// checkout (owner decision 2026-11-25 (3), docs/adr/0044): every change to superelf goes through the
// core lane + Publish. Deny rules hold in every permission mode. The private image's entrypoint also
// makes these folders read-only on disk (ops/demo/entrypoint.sh), so a shell edit fails too.
export const SERVED_CODE = Object.freeze(['lib', 'web', 'tools', 'ops', 'bible-data', 'workspace.example', 'builtin-apps', 'web.mjs', 'superelf.md', 'package.json', 'version-notes.json']);
export function ownerCodeDenies(nodeRoot, selfpubRoot) {
  const r = rulePath(nodeRoot);
  const rules = SERVED_CODE.flatMap((n) => [`Edit(/${r}/${n})`, `Edit(/${r}/${n}/**)`]);
  return ['--disallowedTools', ...rules, `Edit(/${rulePath(selfpubRoot)}/**)`];
}
