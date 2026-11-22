// web.mjs lifecycle (the EADDRINUSE churn scar): under launchd KeepAlive an
// instant crash on a busy port meant an instant respawn into the same busy
// port — a crash loop. This mirrors the real handover: TWO real web.mjs
// instances race ONE ephemeral port; the loser must retry on its fixed
// backoff (never exit), and once the winner is SIGTERMed — the exact signal
// `launchctl bootout` sends — it must exit 0 gracefully and the loser must
// bind and serve. Throwaway roots + an ephemeral port (test/helpers-web.mjs);
// the whole race is time-bounded by the waits below, never open-ended.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor, LISTEN_LINE } from './helpers-web.mjs';
import { needPosixSignals } from './helpers-platform.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const cleanup = [];
after(async () => {
  for (const inst of cleanup) await stopWeb(inst);
  for (const inst of cleanup) rmTemp(inst.root);
});

test('EADDRINUSE: second instance retries (no crash), binds after SIGTERM stops the first gracefully', { skip: needPosixSignals }, async () => {
  const port = await freePort();
  const rootA = mkWebRoot({ port });
  const rootB = mkWebRoot({ port }); // SAME port — the duel
  const a = { ...startWeb(rootA), root: rootA };
  cleanup.push(a);
  await waitReady(port);

  const b = { ...startWeb(rootB), root: rootB };
  cleanup.push(b);
  // The loser announces its retry loop instead of crashing out.
  await waitFor(() => /retrying listen \d+\/\d+/.test(b.log()), 'instance B to log a listen retry');
  assert.equal(b.child.exitCode, null, 'B is alive and retrying, not crash-looping');

  // launchctl bootout sends SIGTERM: the winner must close and exit 0.
  a.child.kill('SIGTERM');
  const exitA = await a.exited;
  assert.equal(exitA.code, 0, `graceful shutdown exits 0 (got ${JSON.stringify(exitA)})`);
  assert.match(a.log(), /SIGTERM — closing listener/, 'shutdown is announced, not silent');

  // The loser's next retry wins the freed port and serves for real.
  await waitReady(port);
  await waitFor(() => b.log().includes(LISTEN_LINE(port)), 'instance B to log its successful bind');
  assert.equal(b.child.exitCode, null, 'B is the live server now');
});

test('a lone instance stops cleanly on SIGTERM (exit 0, no forced-exit deadline message)', { skip: needPosixSignals }, async () => {
  const port = await freePort();
  const root = mkWebRoot({ port });
  const inst = { ...startWeb(root), root };
  cleanup.push(inst);
  await waitReady(port);
  inst.child.kill('SIGTERM');
  const exit = await inst.exited;
  assert.equal(exit.code, 0);
  assert.ok(!inst.log().includes('forcing exit'), 'clean close — the force-exit backstop never fired');
});
