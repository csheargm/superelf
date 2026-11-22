// Pins the Windows temp-dir cleanup contract (see helpers-tmp.mjs header): removal is recursive,
// forced, and asks Node to retry a busy directory instead of failing the whole file on one EBUSY.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmTemp, RM_RETRIES } from './helpers-tmp.mjs';

test('rmTemp passes Node the retry options that absorb a first EBUSY', () => {
  const calls = [];
  let first = true;
  const stub = { rmSync(p, opts) {
    calls.push({ p, opts });
    // Node retries INSIDE rmSync when maxRetries is set; the stub models the real contract: with
    // retries it swallows the first EBUSY, without them it would surface it.
    if (first && !(opts.maxRetries > 0)) { first = false; const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; }
  } };
  rmTemp('/tmp/pa-web-fake', stub);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].opts, { recursive: true, force: true, ...RM_RETRIES });
  assert.ok(RM_RETRIES.maxRetries >= 10 && RM_RETRIES.retryDelay >= 200, 'retries cover a Windows handle-release window');
});

test('rmTemp removes a real temp dir and tolerates a missing one', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-tmp-'));
  fs.writeFileSync(path.join(d, 'f'), 'x');
  rmTemp(d);
  assert.equal(fs.existsSync(d), false);
  rmTemp(d);          // force: true — a second removal is not an error
  rmTemp(undefined);  // a dir never made
});
