// Shared harness for the agent-lane confinement tests (test/app-agent-*.test.mjs): the real web.mjs
// from this checkout on an ephemeral port, a throwaway root, and FAKE `claude` / `codex` binaries
// that append one JSON line per spawn ({ cli, argv, stdin, cwd, sid }) to PA_FAKE_LOG.
//
// FIDELITY (the fake must keep the real CLI's guards, or it masks the bug it is there to catch):
// the fake claude EMULATES the permission rules MEASURED against the real CLI and recorded in
// lib/agent-origin.mjs — it does not decide them. Two instructions drive it:
//   FAKE-WRITE <workspace-relative path> <text>   the Write tool
//   FAKE-BASH                                     the Bash tool (writes bash.txt in the cwd)
// Write: the bypass (the flag, or `--permission-mode bypassPermissions`: measured the same) →
// anywhere; otherwise only inside the cwd, and then acceptEdits → anywhere there, `default` → only
// under an `--allowedTools 'Edit(./<dir>/**)'` rule (that spelling only). No lane carries one since
// ADR 0019; the fake still honours it, and assertAppLane refuses the flag in any spelling. It models
// no `permissions.allow` from --settings (ADR 0019, not closed). Each spawn records `write`, the
// FAKE-WRITE it was asked for and its verdict ({ path, allowed }), or null. The mode is the LAST on argv; with none, the
// applied --settings' `permissions.defaultMode` (inline JSON only; measured 2026-10-13).
// Bash: runs unless `--disallowedTools` names Bash, bypass or not — the worst case measured, on a
// machine whose settings allow a Bash rule (acceptEdits ran `curl -o ../outside` there).
//   FAKE-REMEMBER <text>                          the auto-memory feature (writes the store)
// Auto-memory (measured 2026-10-12, ADR 0002 amendment 2): the store is keyed by the cwd's GIT ROOT
// (the nearest ancestor holding .git; the cwd itself when there is none), so every workspace of one
// checkout shares it. EVERY lane may write it, app lane included, and every later run LOADS it unless
// its env has CLAUDE_CODE_DISABLE_AUTO_MEMORY=1. The fake spells that name the way the CLI reads it,
// not from lib/runner.mjs, so a typo there fails here. The real CLI also stops the load for
// `--settings {"autoMemoryEnabled":false}`; the fake ignores that, which can only over-report a load.
// Two cases it does NOT model, so a test that needs them must extend it first: a `--settings` `env`
// block that sets the variable to 0 (measured: the real CLI then loads), and a git worktree (observed,
// not probed: the real CLI uses the main checkout's store; the fake uses the worktree's). The store
// sits in the test root, never the real ~/.claude; startLaneServer puts a .git in the root, as the
// live install has. Each spawn records the variable's value (`env`) and what it loaded (`memory`,
// null for nothing).
//   FAKE-READ-MEMORY                              the Read tool on the store (recorded as `read`)
// Write (FAKE-REMEMBER) and Read of the store: allowed in every lane, as measured, unless
// `--disallowedTools` carries `Edit(~/.claude/**)` / `Read(~/.claude/**)`. The fake's ~/.claude is
// claude-home in the test root. It honours only that exact spelling, so a mistyped rule fails here.
// It honours these denies and the Bash deny under the bypass too: MEASURED 2026-10-12 (2.1.161), the
// real CLI denied a Write and a Read under ~/.claude and offered no Bash tool (lib/agent-origin.mjs).
// Only the CURRENT message instructs it (the history block replays old turns), as for the real CLI.
// A flag that takes a value takes the NEXT token as it, even one that starts with `-` (measured
// 2026-10-13: `--model --dangerously-skip-permissions` ran with that model), so the fake reads no flag
// out of a token taken as a value: a dangling operator flag swallows what follows, as for the CLI.
// --settings: the fake records `settings`, the ONE value the real CLI applies — the FIRST
// --settings ("--settings x" or "--settings=x"); every later one is ignored entirely. MEASURED
// 2026-10-12, Claude Code 2.1.161 (lib/one-shot.mjs). null when argv carries none.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';

export const SKIP = '--dangerously-skip-permissions';
export const MEMBER_TOKEN = 'test-member-token-0123456789abcd';
export const MEMORY_OFF_VAR = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY';
// Where the fake keeps the auto-memory store for a run in `cwd`, beside the spawn log. Self-contained:
// it is also pasted into the fake's source, where `fs` and `path` are in scope.
export const fakeMemoryDir = (log, cwd) => {
  let key = cwd;
  for (let d = cwd; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) { key = d; break; }
    if (path.dirname(d) === d) break;
  }
  return path.join(path.dirname(log), 'claude-home', 'projects', key.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
};

const FAKE_CLAUDE = `#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const argv=process.argv.slice(2), cwd=process.cwd(), sid=crypto.randomUUID();
  const VALUED=['--model','--settings','--permission-mode','--append-system-prompt','--output-format','--effort'];   // required values only: --resume [value] is optional
  const taken=new Set();argv.forEach((a,i)=>{if(!taken.has(i)&&VALUED.includes(a))taken.add(i+1);});
  const isFlag=(a,i,f)=>!taken.has(i)&&a===f;
  const si=argv.findIndex((a,i)=>!taken.has(i)&&(a==='--settings'||a.startsWith('--settings=')));
  const settings=si<0?null:argv[si]==='--settings'?(argv[si+1]??null):argv[si].slice('--settings='.length);
  const memDir=(${fakeMemoryDir.toString()})(process.env.PA_FAKE_LOG,cwd);
  const env={${MEMORY_OFF_VAR}:process.env.${MEMORY_OFF_VAR}??null};
  let memory=null;
  const readStore=()=>{try{return fs.readdirSync(memDir).map((f)=>fs.readFileSync(path.join(memDir,f),'utf8')).join('\\n')||null;}catch(e){if(e.code!=='ENOENT')throw e;return null;/* no store yet */}};
  if(env.${MEMORY_OFF_VAR}!=='1') memory=readStore();
  const vals=(f)=>{const o=[];argv.forEach((a,i)=>{if(!isFlag(a,i,f))return;for(let j=i+1;j<argv.length&&!argv[j].startsWith('-');j++)o.push(argv[j]);});return o;};
  const homeDenied=(tool)=>vals('--disallowedTools').includes(tool+'(~/.claude/**)');
  const cur=s.includes('[Current message:]')?s.slice(s.lastIndexOf('[Current message:]')):s;
  const read=cur.includes('FAKE-READ-MEMORY')&&!homeDenied('Read')?readStore():null;
  const PM='--permission-mode', modes=[];
  argv.forEach((a,i)=>{if(isFlag(a,i,PM)&&argv[i+1])modes.push(argv[i+1]);else if(!taken.has(i)&&a.startsWith(PM+'='))modes.push(a.slice(PM.length+1));});
  const sMode=(()=>{try{return JSON.parse(settings).permissions.defaultMode;}catch{return undefined;/* no inline settings, or none with a mode */}})();
  const mode=modes.pop()||sMode||'default', skip=argv.some((a,i)=>isFlag(a,i,'${SKIP}'))||mode==='bypassPermissions';
  const mayEdit=(abs)=>{
    if(skip) return true;
    if(!abs.startsWith(cwd+path.sep)) return false;
    if(mode==='acceptEdits') return true;
    return vals('--allowedTools').some((r)=>{const m=/^Edit\\(\\.\\/(.+)\\/\\*\\*\\)$/.exec(r);return m&&abs.startsWith(path.resolve(cwd,m[1])+path.sep);});
  };
  const w=/FAKE-WRITE (\\S+) (\\S+)/.exec(cur);
  const write=w?{path:w[1],allowed:mayEdit(path.resolve(cwd,w[1]))}:null;
  fs.appendFileSync(process.env.PA_FAKE_LOG,JSON.stringify({cli:'claude',argv,stdin:s,cwd,sid,settings,env,memory,read,write})+'\\n');
  if(write&&write.allowed){const abs=path.resolve(cwd,w[1]);fs.mkdirSync(path.dirname(abs),{recursive:true});fs.writeFileSync(abs,w[2]);}
  if(cur.includes('FAKE-BASH')&&!vals('--disallowedTools').includes('Bash')) fs.writeFileSync(path.join(cwd,'bash.txt'),'ran');
  const r=/FAKE-REMEMBER (\\S+)/.exec(cur);
  if(r&&!homeDenied('Edit')){fs.mkdirSync(memDir,{recursive:true});fs.appendFileSync(path.join(memDir,'MEMORY.md'),r[1]+'\\n');}
  process.stdout.write(JSON.stringify({type:'result',subtype:'success',result:'ANSWERED',session_id:sid})+'\\n');
});
`;
const FAKE_CODEX = `#!/usr/bin/env node
import fs from 'node:fs';let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
  const a=process.argv.slice(2);fs.appendFileSync(__LOG__,JSON.stringify({cli:'codex',argv:a,stdin:s})+'\\n');
  const o=a[a.indexOf('-o')+1];fs.writeFileSync(o,'CODEX-ANSWER');
  process.stdout.write('session id: 11111111-2222-3333-4444-555555555555\\n');
});
`;

// The owner and one member — exported so a file that needs one more account extends THIS list (R3).
export const LANE_USERS = Object.freeze([
  { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace' },
  { id: 'kid', name: 'Kid', role: 'member', token: MEMBER_TOKEN, workspace: 'workspace-kid', agent: true },   // opted in to agent tools (F4-2), so the confined agent lane is what runs
]);
// The four lanes that matter (ollama points nowhere: no test may depend
// on it), and a panel of two agent-capable lanes.
const LANE_CONFIG = {
  task_timeout_minutes: 1, assess_timeout_minutes: 1,
  ollama_url: 'http://127.0.0.1:9',
  chat_models: [
    { id: 'deepseek', label: 'DeepSeek', group: 'Fast', provider: 'ollama', model: 'x' },
    { id: 'claude', label: 'Claude', group: 'Agent', provider: 'claude', model: null },
    { id: 'opus', label: 'Opus', group: 'Agent', provider: 'claude', model: 'opus-test' },
    { id: 'gpt', label: 'GPT (Codex)', group: 'Agent', provider: 'codex', model: null },
  ],
  vision_default: 'deepseek',
  assess_models: ['opus', 'gpt'],
  users: LANE_USERS,
};

// Starts the server with the fakes. web.mjs spawns `codex` by NAME, so the fake goes first on the
// server's PATH; node --test runs each file in its own process, so no other file sees the env.
// `extraConfig` overlays LANE_CONFIG (test/config-live-reload.test.mjs boots with one_shot_args).
export async function startLaneServer({ extraConfig = {} } = {}) {
  const port = await freePort();
  const root = mkWebRoot({ port, extraConfig: { ...LANE_CONFIG, ...extraConfig } });
  const bin = path.join(root, 'fakebin');
  fs.mkdirSync(bin);
  // The live install is a git checkout, which makes every workspace share ONE memory store.
  fs.mkdirSync(path.join(root, '.git'));
  // Launchable the way the real CLI is on THIS OS: on Windows an npm .cmd shim, so the server runs
  // the fakes through wincmd's real shim resolution (see writeFakeCli).
  const claudeCmd = writeFakeCli(bin, 'claude', FAKE_CLAUDE);
  // The log path is baked in: codex runs with an allow-listed env (lib/codex.mjs codexEnv), so PA_FAKE_LOG never reaches it.
  writeFakeCli(bin, 'codex', FAKE_CODEX.replace('__LOG__', JSON.stringify(path.join(root, 'spawns.jsonl'))));
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = claudeCmd;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const log = path.join(root, 'spawns.jsonl');
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  process.env.PA_FAKE_LOG = log;
  const web = startWeb(root);
  await waitReady(port);
  let seq = 0;
  return {
    port, root, web, claudeCmd, log,
    stop: () => stopWeb(web),
    // A unique token per test message: each test reads back ONLY the spawns that carried it.
    tag: (name) => `T-${name}-${++seq}-${Date.now()}`,
    spawns: (t) => {
      let txt = ''; try { txt = fs.readFileSync(log, 'utf8'); } catch { /* no spawn yet — an empty list, asserted on by callers */ }
      return txt.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((s) => s.stdin.includes(t));
    },
    async chat(body, { token = OWNER_TOKEN, headers = {} } = {}) {
      const r = await api(port, '/api/chat', { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${token}`, ...headers } });
      assert.equal(r.status, 200);
      return (await r.text()).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    async ask(body, { token = OWNER_TOKEN, headers = {} } = {}) {
      const r = await api(port, '/api/ask', { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${token}`, ...headers } });
      assert.equal(r.status, 200);
      return JSON.parse(await r.text());
    },
  };
}

// The Verify panel is detached: poll the stored turn until it leaves 'pending' (bounded). `token` is
// the account whose conversation it is.
export async function assessDone(port, convoId, aid, token = OWNER_TOKEN) {
  const until = Date.now() + 15000;
  for (;;) {
    const c = await (await api(port, '/api/convos/' + convoId, { headers: { authorization: `Bearer ${token}` } })).json();
    const m = c.messages.find((x) => x.aid === aid);
    if (m && m.assess && m.assess.state !== 'pending') return m.assess;
    if (Date.now() > until) throw new Error('assessment did not finish');
    await new Promise((r) => setTimeout(r, 100));
  }
}

// The value(s) a flag carries in a recorded argv.
export function flagValues(argv, flag) {
  const out = [];
  argv.forEach((a, i) => { if (a === flag) for (let j = i + 1; j < argv.length && !argv[j].startsWith('-'); j++) out.push(argv[j]); });
  return out;
}

// Every argv spelling of the bypass, one token at a time: the flag (and its `=` form), the opt-in (and
// its `=` form), the mode as a bare value and in the `=` form. 2.1.161's --help lists the mode choices,
// exact (acceptEdits, auto, bypassPermissions, default, dontAsk, plan), so there is no other spelling;
// the CLI reference adds `manual` from v2.1.200, an alias for default, not a bypass.
export const isBypassArg = (a) => String(a).startsWith(SKIP) || String(a).startsWith('--allow-dangerously-skip-permissions')
  || a === 'bypassPermissions' || a === '--permission-mode=bypassPermissions';

// What every confined lane denies (lib/agent-origin.mjs CONFINED_DENY_ARGS), spelled out here so a
// change there has to change this too.
export const CONFINED_DENIES = ['Bash', 'Edit(~/.claude/**)', 'Read(~/.claude/**)'];

// Every Claude spawn in `list` is an APP lane: present (control), no bypass, Bash and the CLI's home
// denied, `default` mode, and no allow rule, so nothing writable (ADR 0019). The fake does not model a
// `permissions.allow` inside --settings, so an edit allow there is refused here, on the applied one.
const settingsAllow = (s) => {
  try { return JSON.parse(s.settings).permissions.allow || []; } catch { return []; /* no inline settings, or none with an allow list */ }
};
export function assertAppLane(list, what) {
  const cl = list.filter((s) => s.cli === 'claude');
  assert.ok(cl.length >= 1, `${what}: CONTROL — the fake claude must really have been spawned`);
  for (const s of cl) {
    assert.ok(!s.argv.includes(SKIP), `${what}: unconfined spawn ${JSON.stringify(s.argv)}`);
    assert.deepEqual(flagValues(s.argv, '--disallowedTools'), CONFINED_DENIES, `${what}: Bash and ~/.claude must be denied explicitly`);
    assert.deepEqual(flagValues(s.argv, '--permission-mode'), ['default'], `${what}: exactly one mode, default`);
    assert.ok(!s.argv.some((a) => /^--allowed-?tools/i.test(a)), `${what}: an app lane has no allow rule ${JSON.stringify(s.argv)}`);
    assert.ok(!settingsAllow(s).some((r) => /^(Edit|Write|MultiEdit|NotebookEdit)\b/.test(r)), `${what}: an edit allow in --settings ${s.settings}`);
  }
  return cl;
}
