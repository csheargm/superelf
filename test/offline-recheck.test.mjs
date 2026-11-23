// Owner 2026-11-21: the phone had network back but the shell stayed "离线 · Offline" on the home grid —
// offline was set by one failed request and only a later success could clear it. The shell now asks again.
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const SRC = fs.readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const a = SRC.indexOf('const OFF_RECHECK_MS='), b = SRC.indexOf("window.addEventListener('online',recheckWhileOffline);") + 55;
const code = SRC.slice(a, b);
// pingResult: 'ok' (node answers: online), 'fail' (thrown fetch: stays offline), 'hang' (never answers until aborted)
function run({ offline = true, visible = true, pingResult = 'ok' } = {}) {
  const log = [], timers = [], events = {}, deadlines = [], st = { offline };
  const ctx = {
    T: 'tok', PAOffline: { offline: () => st.offline }, PASync: { drain: () => log.push('drain') },
    ping: (signal) => { log.push('ping');
      if (pingResult === 'ok') { st.offline = false; return Promise.resolve(true); }
      if (pingResult === 'fail') return Promise.resolve('offline');
      return new Promise((res) => signal.addEventListener('abort', () => { log.push('aborted'); res('offline'); })); },
    document: { visibilityState: visible ? 'visible' : 'hidden', addEventListener: (e, f) => { events[e] = f; } },
    window: { addEventListener: (e, f) => { events['w:' + e] = f; } },
    setInterval: (f, ms) => timers.push([f, ms]), setTimeout: (f, ms) => { deadlines.push([f, ms]); return deadlines.length; }, clearTimeout: () => {},
    AbortController,
  };
  vm.runInNewContext(code, ctx);
  return { log, beat: timers[0], events, ctx, deadlines, st };
}
test('while offline and visible, the beat pings and coming back online drains the queue', async () => {
  const r = run(); assert.equal(r.beat[1], 10000);
  await r.beat[0](); assert.deepEqual(r.log, ['ping', 'drain']);
});
test('a failed ping does not drain; online or hidden does not ping at all', async () => {
  let r = run({ pingResult: 'fail' }); await r.beat[0](); assert.deepEqual(r.log, ['ping']);
  r = run({ offline: false }); await r.beat[0](); assert.deepEqual(r.log, []);
  r = run({ visible: false }); await r.beat[0](); assert.deepEqual(r.log, []);
});
test('returning to the app and the online event both re-check', async () => {
  let r = run(); await r.events.visibilitychange(); assert.deepEqual(r.log, ['ping', 'drain']);
  r = run(); await r.events['w:online'](); assert.deepEqual(r.log, ['ping', 'drain']);
});
test('GPT: one re-check at a time — a second trigger while one runs does nothing', async () => {
  const r = run({ pingResult: 'hang' }); const p = r.beat[0](); await r.beat[0]();
  assert.deepEqual(r.log, ['ping']); r.deadlines[0][0](); await p;
});
test('GPT: a ping that never answers is ABORTED at the deadline, and the next beat pings again', async () => {
  const r = run({ pingResult: 'hang' }); const p = r.beat[0](); assert.equal(r.deadlines[0][1], 8000);
  r.deadlines[0][0](); await p; const q = r.beat[0](); r.deadlines[1][0](); await q;
  assert.deepEqual(r.log, ['ping', 'aborted', 'ping', 'aborted']);
});
test('GPT: a session change during the re-check skips the drain', async () => {
  const r = run(); r.ctx.ping = () => { r.ctx.T = 'new'; r.st.offline = false; return Promise.resolve(true); };
  await r.beat[0](); assert.deepEqual(r.log, []);
});
test('GPT: ping drops answers from a replaced session and an aborted ping never marks offline', () => {
  assert.match(SRC, /async function ping\(signal\)\{ if\(!T\) return false; const t0=T; let r; try\{ r=await api\('\/api\/ping',signal\?\{signal\}:\{\}\); \}catch\{ if\(T===t0&&!signal\) PAOffline\.noteNet\(false\);/);
  assert.match(SRC, /const j=await r\.json\(\); if\(T!==t0\) return false; accountRemoved=[^\n]*? if\(j\.ok\)\{ UID=j\.uid;/);
});
test('GPT rounds 5-6: a re-check counts only the node JSON (a proxy error or HTML page stays offline; a 401 bad-token is the node)', () => {
  assert.match(SRC, /if\(T!==t0\) return false;[^\n]*\n  if\(signal\)\{ let j0; try\{ j0=await r\.clone\(\)\.json\(\); \}catch\{ return false; \}[^\n]*\n  PAOffline\.noteNet\(true\);/);
});
