// R14 — a harness failure must say WHY, or the next flake is undiagnosable.
//
// SCAR (Linux CI, 2026-10-11): three tests failed with "web on :38176 not ready within 10000ms" and
// nothing else. The spawned web.mjs had written the reason to its own web.log, which went away with
// its temp root. The cause turned out to be EADDRINUSE on every listen retry (see helpers-web.mjs),
// but nothing in the CI log could have said so.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';

const BUDGET_MS = 10000;

test('a server that dies at boot is reported at once, with its exit status and its own log', async () => {
  const port = await freePort();
  const root = mkWebRoot({ port });
  // web.mjs reads its app contract out of superelf.md at boot and refuses to start without it:
  // a real, deterministic boot failure, not a mock of one.
  fs.rmSync(path.join(root, 'superelf.md'));
  const inst = startWeb(root);
  try {
    const t0 = Date.now();
    await assert.rejects(waitReady(port, { timeoutMs: BUDGET_MS }), (e) => {
      assert.match(e.message, new RegExp(`web on :${port} exited before it was ready \\(code 1`), 'names the exit');
      assert.match(e.message, /ENOENT[^\n]*superelf\.md/, "carries the child's own error, from its web.log");
      return true;
    });
    assert.ok(Date.now() - t0 < BUDGET_MS / 2, 'a dead child fails at once, not after the whole budget');
  } finally {
    await stopWeb(inst);
    rmTemp(root);
  }
});

test('CONTROL: the same root WITH its contract boots, so the failure above is the missing file', async () => {
  const port = await freePort();
  const root = mkWebRoot({ port });
  const inst = startWeb(root);
  try {
    await waitReady(port, { timeoutMs: BUDGET_MS });
    assert.equal(inst.child.exitCode, null, 'the server is up and still running');
  } finally {
    await stopWeb(inst);
    rmTemp(root);
  }
});
