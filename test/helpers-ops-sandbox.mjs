// A throwaway machine for the REAL ops scripts · 运维脚本沙盒
//
// install.sh / start.sh / stop.sh / run.sh are copied into a temp checkout and run with a PATH that
// holds ONLY recording fakes for everything that could touch a real service or process (uname,
// systemctl, loginctl, sudo, launchctl, plutil, systemd-analyze, pgrep, pkill, sleep, claude) plus
// symlinks to harmless text tools. Nothing from /bin or /usr/bin is on PATH as a directory, so a
// real launchctl, systemctl or pkill can never be reached by accident — the live node on this
// machine is out of reach by construction, not by care.
//
// Harness fidelity: each fake reproduces what the scripts DEPEND on — exit codes of
// `systemctl is-enabled/is-active` (0 / 1 / 3 like the real one), `--quiet`, `show -p MainPID|NRestarts
// --value` (MainPID 0 when nothing runs), a missing user bus failing every call, `loginctl
// show-user --value` printing yes/no, enable-linger refused without privilege, pgrep/pkill matching
// ERE against command lines (0 = matched, 1 = none). Every call is appended to calls.log so each
// test can prove its fake was actually reached (R14).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rmTemp } from './helpers-tmp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = ['install.sh', 'start.sh', 'stop.sh', 'run.sh', 'ops/service.sh',
  'ops/superelf-web.service.template', 'ops/com.superelf.web.plist.template', 'package.json',
  'config.example.json'];
const TOOLS = ['bash', 'sh', 'sed', 'grep', 'basename', 'dirname', 'mkdir', 'cp', 'cat', 'id',
  'rm', 'tr', 'date', 'env', 'head', 'tail', 'touch', 'mv'];

const LOG = 'echo "$(basename "$0") $*" >> "$FAKE_LOG"';
const FAKES = {
  uname: `${LOG}\necho "$FAKE_UNAME"`,
  sleep: 'exit 0',
  claude: 'echo "fake claude"',
  systemctl: `${LOG}
S="$FAKE_STATE"
[ "$1" = --user ] || { echo "fake systemctl: system scope refused: $*" >&2; exit 1; }
shift
[ -f "$S/userbus" ] || { echo "Failed to connect to bus: No medium found" >&2; exit 1; }
quiet=0; now=0; args=()
for a in "$@"; do case "$a" in --quiet|-q) quiet=1 ;; --now) now=1 ;; *) args+=("$a") ;; esac; done
cmd="\${args[0]}"; u="\${args[1]%.service}"
uf="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$u.service"
out() { [ $quiet = 1 ] || echo "$1"; }
# "gen" counts real process launches: start/enable --now on an ACTIVE unit launch nothing (the real
# systemctl's no-op), restart always launches a fresh one. A re-run that should load new code is
# judged by gen, not by which verb it happened to use.
launch() { echo active > "$S/active"; echo $(( $(cat "$S/gen" 2>/dev/null || echo 0) + 1 )) > "$S/gen"; }
running() { [ "$(cat "$S/active" 2>/dev/null)" = active ]; }
case "$cmd" in
  show-environment) echo "HOME=$HOME" ;;
  daemon-reload) : ;;
  enable) [ -f "$uf" ] || { echo "Failed to enable unit: Unit file $u.service does not exist." >&2; exit 1; }
    touch "$S/enabled"; echo "Created symlink default.target.wants/$u.service"
    if [ $now = 1 ] && ! running; then launch; fi ;;
  start) [ -f "$uf" ] || { echo "Failed to start $u.service: Unit $u.service not found." >&2; exit 5; }
    running || launch ;;
  restart) [ -f "$uf" ] || { echo "Failed to restart $u.service: Unit $u.service not found." >&2; exit 5; }
    launch ;;
  stop) [ -f "$uf" ] || { echo "Failed to stop $u.service: Unit $u.service not loaded." >&2; exit 5; }
    echo inactive > "$S/active" ;;
  is-enabled)
    if [ -f "$S/enabled" ]; then out enabled; exit 0
    elif [ -f "$uf" ]; then out disabled; exit 1
    else echo "Failed to get unit file state for $u.service: No such file or directory" >&2; exit 1; fi ;;
  # crashloop: Restart=always respawned the process since the last look (new MainPID, NRestarts+1).
  is-active) [ -f "$S/crashloop" ] && running && { launch; echo $(( $(cat "$S/nrestarts" 2>/dev/null || echo 0) + 1 )) > "$S/nrestarts"; }
    st="$(cat "$S/active" 2>/dev/null || echo inactive)"; out "$st"; [ "$st" = active ] || exit 3 ;;
  # show -p MainPID|NRestarts --value: MainPID is 0 when nothing runs, as in the real one.
  show) p=""; for ((i = 1; i < \${#args[@]}; i++)); do [ "\${args[i-1]}" = -p ] && p="\${args[i]}"; done
    case "$p" in
      MainPID) running && echo $(( 4000 + $(cat "$S/gen" 2>/dev/null || echo 0) )) || echo 0 ;;
      NRestarts) cat "$S/nrestarts" 2>/dev/null || echo 0 ;;
      *) echo "fake systemctl: unsupported property $p" >&2; exit 1 ;;
    esac ;;
  *) echo "fake systemctl: unsupported $cmd" >&2; exit 1 ;;
esac`,
  loginctl: `${LOG}
S="$FAKE_STATE"
case "$1" in
  show-user) [ -f "$S/linger" ] && v=yes || v=no
    case " $* " in *" --value "*) echo "$v" ;; *) echo "Linger=$v" ;; esac ;;
  enable-linger)
    if [ -f "$S/linger_denied" ] && [ -z "$FAKE_AS_ROOT" ]; then echo "Could not enable linger: Access denied" >&2; exit 1; fi
    touch "$S/linger" ;;
  *) exit 1 ;;
esac`,
  sudo: `${LOG}
[ -f "$FAKE_STATE/sudo_denied" ] && { echo "sudo: a password is required" >&2; exit 1; }
FAKE_AS_ROOT=1 exec "$@"`,
  launchctl: `${LOG}
S="$FAKE_STATE"
case "$1" in
  print) [ -f "$S/loaded" ] || { echo "Could not find service" >&2; exit 113; } ;;
  bootstrap) touch "$S/loaded" ;;
  bootout) rm -f "$S/loaded" ;;
  kickstart) : ;;
esac`,
  plutil: `${LOG}
f="\${@: -1}"; grep -q '</plist>' "$f" || { echo "$f: invalid" >&2; exit 1; }; echo "$f: OK"`,
  'systemd-analyze': `${LOG}
[ -f "$FAKE_STATE/analyze_fails" ] && { echo "unit is invalid" >&2; exit 1; }; exit 0`,
  // A command this OS does NOT have, but recorded: on the Mac, systemctl/loginctl are absent, and an
  // absent command never reaches calls.log — so "no systemctl on a Mac" could not fail. This one
  // answers like the shell does for a missing command (127) AND leaves a line behind.
  absent: `${LOG}
echo "$(basename "$0"): command not found" >&2; exit 127`,
  pgrep: `${LOG}
[ -f "$FAKE_PS" ] && grep -Eq -- "\${@: -1}" "$FAKE_PS"`,
  pkill: `${LOG}
p="\${@: -1}"
[ -f "$FAKE_PS" ] && grep -Eq -- "$p" "$FAKE_PS" || exit 1
grep -Ev -- "$p" "$FAKE_PS" > "$FAKE_PS.n"; mv "$FAKE_PS.n" "$FAKE_PS"`,
};

const which = (t) => execFileSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim();
const write = (f, body, mode = 0o755) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body, { mode }); };

// The two halves of a sandbox PATH, exported so another sandbox (test/deploy.test.mjs, which needs
// a real git checkout rather than copied scripts) reuses the SAME fakes instead of a second copy
// that could drift from them (R3).
export const linkTools = (bin, tools = TOOLS) => { for (const t of tools) fs.symlinkSync(which(t), path.join(bin, t)); };
export const installFakes = (bin, names) => { for (const f of names) write(path.join(bin, f), `#!/bin/bash\n${FAKES[f]}\n`); };

// Every sandbox is removed when the test process exits; tests read them only while running.
const CREATED = [];
process.on('exit', () => { for (const d of CREATED) rmTemp(d); });

// opts: name (checkout dir name), uname, fakes (names to install; omitted fakes are ABSENT from
// PATH), absent (names installed as the recording "absent" fake above), state (flags: userbus, linger, linger_denied, sudo_denied, enabled, loaded, analyze_fails),
// active (systemd ActiveState), ps (command lines the fake pgrep/pkill see).
export function sandbox({ name = 'superelf', uname = 'Linux', fakes, absent = [], state = [], active, ps = [] } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-ops-'));
  CREATED.push(base);
  const repo = path.join(base, name), bin = path.join(base, 'bin'), st = path.join(base, 'state');
  for (const f of SCRIPTS) write(path.join(repo, f), fs.readFileSync(path.join(ROOT, f)));
  write(path.join(repo, 'setup.mjs'), "console.log('setup stub');\n", 0o644);
  write(path.join(repo, 'web.mjs'), '', 0o644);
  fs.mkdirSync(bin); fs.mkdirSync(st); fs.mkdirSync(path.join(base, 'home'));
  linkTools(bin);
  // node: the real one, except that `node web.mjs` under FAKE_NODE_STOP records itself and ends
  // the run.sh loop that called it (run.sh never returns on its own).
  write(path.join(bin, 'node'), `#!/bin/bash\nif [ -n "$FAKE_NODE_STOP" ] && [ "$1" = web.mjs ]; then ${LOG}; kill -TERM $PPID; exit 0; fi\nexec "${process.execPath}" "$@"\n`);
  const want = fakes || Object.keys(FAKES).filter((k) => k !== 'absent');
  installFakes(bin, want);
  for (const f of absent) write(path.join(bin, f), `#!/bin/bash\n${FAKES.absent}\n`);
  for (const s of state) fs.writeFileSync(path.join(st, s), '');
  if (active) fs.writeFileSync(path.join(st, 'active'), active);
  fs.writeFileSync(path.join(base, 'ps.txt'), ps.map((l) => l + '\n').join(''));
  const env = { PATH: bin, HOME: path.join(base, 'home'), USER: 'famuser', FAKE_UNAME: uname,
    FAKE_STATE: st, FAKE_LOG: path.join(base, 'calls.log'), FAKE_PS: path.join(base, 'ps.txt') };
  const run = (script, args = [], extra = {}) => {
    const r = spawnSync(path.join(bin, 'bash'), [path.join(repo, script), ...args],
      { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000, input: '' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), stdout: r.stdout || '' };
  };
  const calls = () => (fs.existsSync(env.FAKE_LOG) ? fs.readFileSync(env.FAKE_LOG, 'utf8') : '');
  const ps2 = () => fs.readFileSync(env.FAKE_PS, 'utf8');
  const unitFile = path.join(env.HOME, '.config/systemd/user/superelf-web.service');
  const plist = path.join(env.HOME, 'Library/LaunchAgents/com.superelf.web.plist');
  return { base, repo, bin, st, env, run, calls, ps: ps2, unitFile, plist };
}

// The fakes a Linux box with a working systemd user manager has (no launchctl, no plutil).
export const LINUX_FAKES = ['uname', 'sleep', 'claude', 'systemctl', 'loginctl', 'sudo', 'pgrep', 'pkill'];
export const MAC_FAKES = ['uname', 'sleep', 'claude', 'launchctl', 'plutil', 'pgrep', 'pkill'];
// What a Mac does not have, installed as recorders so a call to one is SEEN (pass as `absent`).
export const MAC_ABSENT = ['systemctl', 'loginctl'];
