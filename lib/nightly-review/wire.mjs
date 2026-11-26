// 夜间审查的接线 · The nightly review's wiring to the node (docs/adr/0046): which programs run, how.
// web.mjs hands in its own runners; this file decides the arguments, so the read-only rules live here once.
import { runCodex } from '../codex.mjs';
import { nodeOwnerId } from '../owner.mjs';
import { selfpubRoot } from '../selfpub/routes.mjs';
import { nightlyReviewJobs } from './job.mjs';
import { startSelfpubFix, selfpubFixStatus } from './fix.mjs';

// The verify pass: Claude with the read-only file tools only, no MCP, and NO settings from the reviewed
// repo (--setting-sources= : a repo's .claude/settings.json hooks would otherwise run commands on the node).
// `=` forms: --tools and --disallowedTools take a list and would swallow the next flag.
export const VERIFY_ARGS = Object.freeze(['--setting-sources=', '--strict-mcp-config', '--tools=Read,Grep,Glob',
  '--disallowedTools=Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch', '--permission-mode', 'default', '--no-session-persistence']);

// w: { cfg, audit, enqueue, runClaude, coreTurn(owner, request, convoId) → { ok, text, selfpub }, saveConvo, newId, version, codex? }
export function nightlyJobs(w) {
  const owner = () => w.cfg.users.find((u) => u.id === nodeOwnerId(w.cfg.users)) || null;
  return nightlyReviewJobs({
    cfg: w.cfg, audit: w.audit,
    codex: ({ cmd, prompt, cwd, timeoutMs }) => (w.codex || runCodex)({ codexCmd: cmd, prompt, cwd, timeoutMs }),
    verify: ({ prompt, cwd, timeoutMs }) => w.enqueue(() => w.runClaude({ claudeCmd: w.cfg.claude_cmd, extraArgs: [...VERIFY_ARGS], cwd, prompt, timeoutMs })),
    startFix: (a) => startSelfpubFix(a, { owner: owner(), saveConvo: w.saveConvo, newId: w.newId,
      runTurn: (request, convoId) => w.coreTurn(owner(), request, convoId) }),
    fixStatus: (id) => selfpubFixStatus(selfpubRoot(w.cfg), id, w.version()),
  });
}
