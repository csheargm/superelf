// A throwaway node for deploy.sh · 部署脚本沙盒（真实 git，假的 systemd）
//
// The REAL deploy.sh runs against a REAL git history: a temp bare "origin", a "node" clone that is
// the production checkout, and a "dev" clone where new commits are made and pushed. Only the
// things that would touch a real machine are fakes: uname (Linux), systemctl (the ops sandbox's
// own fake, R3), journalctl, curl (the health probe), flock, and install.sh, which is a recording
// stub COMMITTED in the sandbox repo, so it is a tracked file like the real one and a dirty check
// cannot trip on it. Each test also proves its fake or stub was reached (R14).
//
// The stub plays a deploy's outcome: a file BROKEN in the deployed commit names how the restarted
// service is unhealthy, and some modes also play what the RUNNING server does to the checkout
// meanwhile (a shelf commit, an app edit, a git command holding index.lock). A rollback removes
// BROKEN, so it is healthy again, unless the state flag always_broken says the old code is too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { linkTools, installFakes } from './helpers-ops-sandbox.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = 'echo "$(basename "$0") $*" >> "$FAKE_LOG"';
const LOCAL_FAKES = {
  journalctl: `${LOG}\necho "-- fake journal: web.mjs exited --"`,
  // "flap": the port answers every other probe, like a web.mjs that listens and then crashes.
  // "dies_after N": active and 200 for N probes, then the unit fails: web.mjs retrying its listen
  // (10 x 500 ms) while a stray holds the port, then giving up.
  curl: `${LOG}
S="$FAKE_STATE"
if [ -f "$S/flap" ]; then n=$(( $(cat "$S/flap") + 1 )); echo $n > "$S/flap"; [ $((n % 2)) = 1 ] && { printf 200; exit 0; }; printf 000; exit 7; fi
if [ -f "$S/dies_after" ]; then n=$(cat "$S/dies_after"); [ "$n" -gt 0 ] && { echo $((n - 1)) > "$S/dies_after"; printf 200; exit 0; }; echo failed > "$S/active"; printf 000; exit 7; fi
if [ -f "$S/http" ]; then printf %s "$(cat "$S/http")"; exit 0; fi
printf 000; exit 7`,
  // Only the uncontended lock and a held one (state flag lock_held, exit 1 like flock -n). The real
  // flock's fd semantics are exercised against the real tool where it exists (Linux).
  flock: `${LOG}\n[ -f "$FAKE_STATE/lock_held" ] && exit 1; exit 0`,
};
const SHELF_COMMIT = 'mkdir -p shared-apps/s; echo "<p>s</p>" > shared-apps/s/index.html; git add -A -- shared-apps/s; '
  + 'git -c user.name=t -c user.email=t@example.invalid commit -qm "shelf: promote s" -- shared-apps/s';
const INSTALL_STUB = `#!/bin/bash
echo "install.sh $* HEAD=$(git rev-parse HEAD)" >> "$FAKE_LOG"
S="$FAKE_STATE"
mode=ok
[ -f "$S/always_broken" ] && mode="$(cat "$S/always_broken")"
[ -f BROKEN ] && mode="$(cat BROKEN)"
# install.sh dies BEFORE its restart: the OLD process keeps running and answering 200.
[ "$mode" = installfail ] && { echo "install.sh: could not enable superelf-web" >&2; exit 1; }
systemctl --user restart superelf-web
rm -f "$S/flap" "$S/dies_after" "$S/crashloop"
case "$mode" in
  lock) : > .git/index.lock; mode=down ;;                                # a git command of the server's, mid-flight
  shelf) ${SHELF_COMMIT}; mode=down ;;                                   # web.mjs commitShelf
  edit) echo "<p>edited by the new server</p>" > workspace/apps/x/index.html; mode=down ;;
esac
case "$mode" in
  ok) echo 200 > "$S/http" ;;
  http) echo 500 > "$S/http" ;;
  flap) echo 0 > "$S/flap" ;;
  stray) echo failed > "$S/active"; echo 200 > "$S/http" ;;   # a stray web.mjs still holds the port
  retrywindow) echo 5 > "$S/dies_after" ;;
  crashloop) touch "$S/crashloop"; echo 200 > "$S/http" ;;    # a stray answers; ours respawns between probes
  *) echo failed > "$S/active"; rm -f "$S/http" ;;
esac
`;
// Real git with nobody's config: no global hooks, no signing, no identity of whoever runs this.
const GIT_ENV = { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
const ID = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
export const git = (cwd, ...args) => execFileSync('git', [...ID, ...args],
  { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const put = (f, body, mode = 0o644) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, body, { mode }); };
const which = (t) => execFileSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim();

const CREATED = [];
process.on('exit', () => { for (const d of CREATED) rmTemp(d); });

function makeRepos(base) {
  const origin = path.join(base, 'origin.git'), dev = path.join(base, 'dev'), node = path.join(base, 'superelf');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, dev);
  for (const f of ['deploy.sh', 'ops/service.sh']) put(path.join(dev, f), fs.readFileSync(path.join(ROOT, f)), 0o755);
  put(path.join(dev, 'install.sh'), INSTALL_STUB, 0o755);
  put(path.join(dev, 'web.mjs'), 'export const web = 1;\n');
  put(path.join(dev, 'lib/a.mjs'), 'export const a = 1;\n');
  put(path.join(dev, 'workspace/apps/x/index.html'), '<p>app</p>\n');
  put(path.join(dev, '.gitignore'), 'config.json\nnode-only/\n');
  git(dev, 'add', '-A'); git(dev, 'commit', '-qm', 'base'); git(dev, 'push', '-q', 'origin', 'main');
  git(base, 'clone', '-q', origin, node);
  return { dev, node };
}

// world(opts) → a node, a dev clone and the fakes. realFlock: link the machine's own flock instead
// of the fake (callers skip with needFlock where there is none).
export function world({ uname = 'Linux', state = ['userbus'], unit = true, realFlock = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-deploy-'));
  CREATED.push(base);
  const bin = path.join(base, 'bin'), st = path.join(base, 'state'), home = path.join(base, 'home');
  for (const d of [bin, st, home]) fs.mkdirSync(d);
  const { dev, node } = makeRepos(base);
  linkTools(bin, ['bash', 'sh', 'sed', 'grep', 'basename', 'dirname', 'cat', 'id', 'rm', 'git', 'mkdir', 'touch']);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  installFakes(bin, ['uname', 'sleep', 'systemctl']);
  for (const [n, body] of Object.entries(LOCAL_FAKES)) {
    if (n === 'flock' && realFlock) fs.symlinkSync(which('flock'), path.join(bin, 'flock'));
    else put(path.join(bin, n), `#!/bin/bash\n${body}\n`, 0o755);
  }
  if (unit) put(path.join(home, '.config/systemd/user/superelf-web.service'), '[Unit]\n');
  for (const s of state) fs.writeFileSync(path.join(st, s), '');
  fs.writeFileSync(path.join(st, 'active'), 'active'); fs.writeFileSync(path.join(st, 'http'), '200');   // healthy before
  const logf = path.join(base, 'calls.log');
  const env = { PATH: bin, HOME: home, USER: 'famuser', FAKE_UNAME: uname, FAKE_STATE: st, FAKE_LOG: logf, ...GIT_ENV };
  // run(...args) → { code, out }. prefix: a command (argv) the script runs under, e.g. a real flock.
  const runWith = (prefix, args) => {
    const argv = [...prefix, path.join(bin, 'bash'), path.join(node, 'deploy.sh'), ...args];
    const r = spawnSync(argv[0], argv.slice(1), { cwd: node, env, encoding: 'utf8', timeout: 60000, input: '' });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
  };
  const run = (...args) => runWith([], args);
  const calls = () => (fs.existsSync(logf) ? fs.readFileSync(logf, 'utf8') : '');
  const installs = () => calls().split('\n').filter((l) => l.startsWith('install.sh'));   // one line per run
  // ship(files, msg) → commit those files in dev (a null body deletes it), push, return the new sha.
  const ship = (files, msg = 'change') => {
    for (const [f, body] of Object.entries(files)) {
      if (body === null) fs.rmSync(path.join(dev, f)); else put(path.join(dev, f), body);
    }
    git(dev, 'add', '-A'); git(dev, 'commit', '-qm', msg); git(dev, 'push', '-q', 'origin', 'main');
    return git(dev, 'rev-parse', 'HEAD');
  };
  const head = () => git(node, 'rev-parse', 'HEAD'), tracking = () => git(node, 'rev-parse', 'origin/main');
  return { base, bin, node, dev, st, run, runWith, calls, installs, ship, head, tracking };
}
