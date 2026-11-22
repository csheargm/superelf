// One-shot asks · 一次性请求 (docs/adr/0008-one-shot-ai-requests.md): the config values that shape
// a request for ONE answer, and the --settings rule they share. Each is a config.json key with its
// default here, validated at load (lib/config.mjs validateConfig) and read from the LIVE cfg where
// it is used (docs/adr/0011), so an edit applies to the next request with no restart.
//   one_shot_args   what a oneShot turn (PAChat.complete) adds to the Claude lane's argv
//   one_shot_model  the chat_models id that answers a oneShot turn, whatever the caller's chooser says
//   NO_THINKING_ARGS  the default of one_shot_args AND of fast_args (the background asks: /api/ask
//                   and the job resolver). An explicit fast_args in config.json REPLACES that default,
//                   so it must carry this --settings pair itself to get thinking off.
//   digestArgs      what tools/fetch-daily-digest.mjs takes from fast_args: the model and this pair,
//                   nothing else (its prompt carries untrusted web text).
//
// MEASURED 2026-10-12. Design with AI (Sonnet): thinking on, 4 of 4 runs never answered in >10 min;
// thinking off, 110-190 s. A fast-lane ask (Haiku): thinking on 8.4 s / 625 output tokens, off
// 6.0 s / 251.
//
// THE --settings RULE. MEASURED 2026-10-12 (Claude Code 2.1.161, two sessions, each order repeated):
// the claude CLI honours the FIRST --settings on its argv and ignores every later one entirely, even
// keys the first does not name. `--settings {"alwaysThinkingEnabled":false} --settings {"theme":"dark"}`
// runs with thinking off; the reverse order runs with it on. Two never merge.
// A default's --settings (one_shot_args, fast_args) yields to an operator's (yieldSettings):
//   claude_args sits AHEAD of one_shot_args, so on a oneShot turn it would win by position anyway.
//   member_args sits BEHIND one_shot_args and fast_args on a confined turn (every app's, every
//   member's), so there the default would win by position and the operator's member settings —
//   possibly hardening — would be ignored without a word.
// Either way the default's --settings is DROPPED, so argv carries exactly one --settings, the
// operator's, and which one applies never rests on the CLI's ordering (first assumed to be the
// last; measured otherwise). The loader says so (settingsClashWarnings).
import { SKIP_PERMISSIONS } from './agent-origin.mjs';

export const NO_THINKING_ARGS = Object.freeze(['--settings', JSON.stringify({ alwaysThinkingEnabled: false })]);
export const ONE_SHOT_MODEL_DEFAULT = 'claude';
// The fast lane's default: Haiku, thinking off. config.example.json ships the same (pinned by test).
export const FAST_ARGS_DEFAULT = Object.freeze(['--model', 'haiku', SKIP_PERMISSIONS, ...NO_THINKING_ARGS]);

const isSettings = (a) => a === '--settings' || String(a).startsWith('--settings=');
export const hasSettings = (args) => Array.isArray(args) && args.some(isSettings);

// `args` minus every --settings and its value: "--settings x" (a pair) and "--settings=x".
export function withoutSettings(args) {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--settings') { if (i + 1 < args.length && !String(args[i + 1]).startsWith('-')) i += 1; continue; }
    if (!isSettings(args[i])) out.push(args[i]);
  }
  return out;
}

// A default's args (one_shot_args, fast_args) minus their --settings when any of `operatorArgs` —
// the lane's claude_args, the member_args a confined turn appends — carries one. Its other flags ride.
export const yieldSettings = (defaults, ...operatorArgs) =>
  (operatorArgs.some(hasSettings) ? withoutSettings(defaults) : defaults);

// A oneShot turn's base argv: the lane's args, then one_shot_args (yielding to the lane's and to
// `memberArgs` — pass the member_args only when the turn is confined, i.e. when laneArgs appends them).
export const oneShotBaseArgs = (laneArgs, oneShotArgs, memberArgs = []) =>
  [...laneArgs, ...yieldSettings(oneShotArgs, laneArgs, memberArgs)];

// `args` minus every exact NO_THINKING_ARGS pair — the shipped default only, never an operator's own
// --settings. For lib/runner.mjs's Windows shell fallback, where cmd.exe cannot carry that JSON.
export function withoutNoThinking(args) {
  const [flag, value] = NO_THINKING_ARGS;
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === flag && args[i + 1] === value) { i += 1; continue; }
    out.push(args[i]);
  }
  return out;
}

// No tool at all for the daily digest: it turns text into JSON, and its prompt carries untrusted web
// text. In the CLI's default mode the machine's own allow rules apply (~/.claude/settings.json allows
// `Bash(curl *)` here), and Read inside the cwd (the owner's workspace) needs no approval. MEASURED
// 2026-10-12 against the real CLI (Claude Code 2.1.161) in a throwaway directory, digest argv, a
// canary file, a loopback listener for curl, a fake MCP server that logs every call:
//   no deny                          curl POSTed the canary to the listener              → RAN
//   --disallowedTools Bash           (CONFINED_DENY_ARGS) Read returned the canary; WebFetch,
//                                    Write, Cron*, RemoteTrigger, MCP still offered     → NOT ENOUGH
//   --tools=                         no built-in tool; but MCP tools (the user's, and a
//                                    .mcp.json in the cwd) are offered once tool search
//                                    is off (ENABLE_TOOL_SEARCH=false)                  → NOT ENOUGH
//   --tools= --strict-mcp-config     init tools [], mcp_servers [], no tool call, no file
//                                    written, no listener hit, the .mcp.json server never started
// `--tools=`, not the documented `--tools ""` (also measured: no built-in tool): Node joins argv
// unquoted under lib/runner.mjs's Windows shell fallback, so the empty word vanishes there, and then
// --tools takes --strict-mcp-config as its value (measured: no built-in, but the MCP servers load).
// NOT covered: the CLI itself inlines a file named as `@path` in the prompt, with no tool (measured).
export const NO_TOOLS_ARGS = Object.freeze(['--tools=', '--strict-mcp-config']);

// The daily digest's argv from fast_args (tools/fetch-daily-digest.mjs, docs/adr/0008 item 4). Its
// prompt carries UNTRUSTED web-search text, so this is an ALLOW-list, not fast_args minus a deny-list:
//   every --model whose value is one word that is not a flag, in order (a fast_args with none, or one
//   that names its model only inside its --settings JSON, leaves the digest on the CLI's default); and
//   NO_THINKING_ARGS when the --settings the CLI applies (the FIRST) is inline JSON that turns
//   thinking off. Always this canonical pair, never the operator's JSON, which can also carry
//   permissions, hooks and env; a settings FILE is not read, so thinking stays the CLI's default.
// Nothing else rides. A deny-list (lib/agent-origin.mjs's permission flags plus SKIP_PERMISSIONS)
// would still pass --allow-dangerously-skip-permissions, --add-dir, --mcp-config and that JSON.
// Why one word that is not a flag: `--model --dangerously-skip-permissions` must carry neither, and a
// space could split into a second flag under lib/runner.mjs's Windows shell fallback.
// Throws on a fast_args that is not an array of strings; the digest then uses its own fallback.
const ARG_VALUE = /^[^-\s]\S*$/;
export function digestArgs(fastArgs) {
  if (!Array.isArray(fastArgs) || !fastArgs.every((a) => typeof a === 'string')) throw new TypeError('fast_args is not an array of strings');
  const models = [];
  let applied;   // the first --settings value: the only one the CLI reads
  for (let i = 0; i < fastArgs.length; i += 1) {
    const m = /^(--model|--settings)(?:=([\s\S]*))?$/.exec(fastArgs[i]);
    if (!m) continue;
    let v = m[2];
    if (v === undefined && i + 1 < fastArgs.length && !fastArgs[i + 1].startsWith('-')) v = fastArgs[++i];
    if (m[1] === '--settings') applied ??= v ?? '';
    else if (ARG_VALUE.test(v ?? '')) models.push('--model', v);
  }
  return [...models, ...(thinkingOffJson(applied) ? NO_THINKING_ARGS : [])];
}
function thinkingOffJson(v) {
  try { const o = JSON.parse(v); return !!o && typeof o === 'object' && o.alwaysThinkingEnabled === false; }
  catch { return false; }   // a settings file path, or no --settings: not inline, so not carried
}

// The model a oneShot turn is answered by: one_shot_model when it names a chat_models id, else
// the request's own ('' asks for that; an unknown id was warned about at load).
export function oneShotModel(cfg, requestModel) {
  const id = cfg.one_shot_model;
  const known = typeof id === 'string' && id !== '' && (cfg.chat_models || []).some((m) => m.id === id);
  return known ? id : requestModel;
}

// ── Load-time checks (lib/config.mjs validateConfig); each warning names its key ─────────────────
export function oneShotArgsSetting(cfg) {
  const v = cfg.one_shot_args;
  const ok = Array.isArray(v) && v.every((a) => typeof a === 'string');
  if (v !== undefined && !ok) console.warn(`[config] one_shot_args must be an array of strings — using the default ${JSON.stringify(NO_THINKING_ARGS)}`);
  return ok ? v : [...NO_THINKING_ARGS];
}

// Needs cfg.chat_models COMPLETE first (the Research lane included, appended only with a Tavily key).
export function oneShotModelSetting(cfg) {
  const v = cfg.one_shot_model;
  if (v === undefined) return knownOrWarn(cfg, ONE_SHOT_MODEL_DEFAULT);
  if (typeof v !== 'string') {
    console.warn(`[config] one_shot_model must be a chat_models id or "" — using the default "${ONE_SHOT_MODEL_DEFAULT}"`);
    return knownOrWarn(cfg, ONE_SHOT_MODEL_DEFAULT);
  }
  return v === '' ? v : knownOrWarn(cfg, v);
}
function knownOrWarn(cfg, id) {
  const ids = (cfg.chat_models || []).map((m) => m.id);
  if (!ids.includes(id)) console.warn(`[config] one_shot_model "${id}" is not a chat_models id (${ids.join(', ')}), so oneShot requests use the model they ask for. Set it to one of those ids, or "" to say so on purpose.`);
  return id;
}

// One line per real outcome, in the order the CLI reads the argv (lib/runner.mjs, then
// lib/agent-origin.mjs laneArgs): -p …, (confined turns) the denies, the pinned
// mode, then claude_args | fast_args, one_shot_args (oneShot turns), member_args (confined). Each line
// names only the turns whose FIRST --settings it describes, so no two lines contradict:
//   oneShot turns, claude_args has one   → claude_args' (one_shot_args' dropped)
//   confined turns, member_args has one  → member_args', but only where claude_args carries none:
//                                          every confined turn, or, when it does, only the
//                                          confined fast-lane asks (their argv has no claude_args)
//   both operators have one              → claude_args' on confined chat, oneShot and Verify turns
export function settingsClashWarnings(cfg) {
  const fix = 'To keep thinking off on those turns, add "alwaysThinkingEnabled": false to your own settings file (it then applies to every turn that uses it).';
  const claudeOp = hasSettings(cfg.claude_args), memberOp = hasSettings(cfg.member_args);
  const out = [];
  if (hasSettings(cfg.one_shot_args) && claudeOp) {
    out.push(`[config] claude_args passes --settings, so oneShot turns drop one_shot_args' --settings: the operator's settings win, and oneShot turns run with the thinking setting in claude_args' settings. ${fix}`);
  }
  // A oneShot turn that carries claude_args' is the line above's outcome, never member_args'.
  const defaults = [!claudeOp && hasSettings(cfg.one_shot_args) && 'one_shot_args', hasSettings(cfg.fast_args) && 'fast_args'].filter(Boolean);
  if (memberOp && defaults.length) {
    const [turns, those] = claudeOp
      ? ['every confined fast-lane ask (/api/ask, the job resolver; every app\'s, every member\'s)', 'those asks']
      : ['every confined turn (every app\'s turn, every member\'s)', 'those turns'];
    out.push(`[config] member_args passes --settings, so ${turns} drops the --settings of ${defaults.join(' and ')}: the operator's settings win, and ${those} run with the thinking setting in member_args' settings. ${fix}`);
  }
  if (memberOp && claudeOp) {
    out.push('[config] claude_args and member_args both pass --settings. The claude CLI honours only the FIRST --settings and claude_args comes first, so on a confined chat, oneShot or Verify turn member_args\' settings are IGNORED and claude_args\' apply (a confined fast-lane ask, which carries no claude_args, applies member_args\'). Settings files never merge: keep --settings in only one of the two, or put what confined turns need into claude_args\' settings file.');
  }
  return out;
}
