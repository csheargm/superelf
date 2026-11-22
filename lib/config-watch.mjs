// Live config · 配置热加载 (docs/adr/0011) — the ONE mechanism that turns an edit of config.json
// into a reload of the running server's cfg, so a tunable that is read at the moment it is used
// changes with no restart.
//
// watchConfig(file, reload, { intervalMs, onError }) → unwatch()
//   - Stat POLLING (fs.watchFile), not fs.watch: an editor that saves by writing a temp file and
//     renaming it over the original replaces the inode, and an inode watcher then watches a file
//     that no longer has that name. A stat poll looks the NAME up each time, so it survives that.
//   - persistent:false, and the debounce timer is unref'd: a watcher must never be the reason a
//     process (or a test runner) stays alive.
//   - Reloads only once the file has been STABLE for a full poll. Each change re-arms a timer of
//     CONFIG_WATCH_DEBOUNCE_POLLS (2) intervals, derived from the interval in use, never a second
//     constant: a save that straddles a poll (truncated at one, complete at the next) re-arms it
//     at the next poll, so it costs ONE reload of the finished file and no false failure. A
//     debounce shorter than the interval merges nothing: each poll sees at most one change.
//   - `reload` may be async. If it throws or rejects (a half-written file, invalid JSON, a value
//     the validator refuses), onError(e) is called and the watcher keeps watching. Keeping the
//     LAST GOOD config in force is the caller's half of the contract: `reload` must replace the
//     live config only after the new one has loaded completely (web.mjs reloadConfig does).
//   - Reloads never overlap: a change seen while one runs queues exactly one more. Whatever a
//     reload or onError does, the next change is still reloaded (try/finally).
import fs from 'node:fs';

export const CONFIG_WATCH_INTERVAL_MS = 1000;   // how often the file is stat'ed
export const CONFIG_WATCH_DEBOUNCE_POLLS = 2;   // quiet polls after the last change before reloading
export const debounceFor = (intervalMs) => intervalMs * CONFIG_WATCH_DEBOUNCE_POLLS;

// A read touches only atime, which the poller does not compare; this also ignores a poll that
// reports the same file unchanged.
const sameFile = (a, b) => a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;

export function watchConfig(file, reload, { intervalMs = CONFIG_WATCH_INTERVAL_MS, onError = () => {} } = {}) {
  const debounceMs = debounceFor(intervalMs);
  let timer = null, running = false, again = false, stopped = false;
  const report = (e) => {
    try { onError(e); } catch (failed) {
      // R5 (c): onError IS the watcher's way of reporting, so when it fails (say, audit.log is not
      // writable) stderr is the only channel left. Rethrowing would reject a timer's promise nobody
      // awaits: an unhandled rejection, which stops a process that runs Node's default policy over
      // a failed log line. Both errors are logged in full, and the watcher carries on.
      console.error(`[config-watch] onError threw while reporting a failed reload of ${file}:`, failed, '— the reload failed with:', e);
    }
  };
  const run = async () => {
    timer = null;
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    try { await reload(); } catch (e) { report(e); }   // the last good config stays; the caller says so
    finally {
      running = false;   // or the watcher would stop for good
      if (again && !stopped) { again = false; run(); }
    }
  };
  const onChange = (curr, prev) => {
    if (stopped || sameFile(curr, prev)) return;
    clearTimeout(timer);
    timer = setTimeout(run, debounceMs);
    timer.unref();
  };
  fs.watchFile(file, { persistent: false, interval: intervalMs }, onChange);
  return () => { stopped = true; clearTimeout(timer); fs.unwatchFile(file, onChange); };
}
