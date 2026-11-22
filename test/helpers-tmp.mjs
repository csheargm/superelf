// The one way a test removes a temp dir it made (R3): every suite's cleanup goes through here.
//
// SCAR (CI Windows, 2026-11-11): save-data-routes failed with EBUSY on rmdir of its pa-web-* root.
// Windows refuses to remove a directory while any handle inside it is open, and a handle the
// parent closed a moment ago can still be held briefly by the OS (antivirus, search indexer, the
// just-killed child's stdio). Node's own retry covers that window; the caller still has to close or
// stop whatever it holds BEFORE calling this, or every retry fails the same way.
import fs from 'node:fs';

// 2026-11-13: 5 x 100 ms (Node backs off linearly, ~1.5 s in all) still hit EBUSY on CI Windows in
// save-data-routes at 8cc11f4. 10 x 200 ms waits up to ~11 s, and only when the OS really holds a handle.
export const RM_RETRIES = { maxRetries: 10, retryDelay: 200 };

// `fsImpl` is a seam for the pin test (it stubs rmSync); production callers pass nothing.
export function rmTemp(dir, fsImpl = fs) {
  if (!dir) return;   // a test that never made its dir (failed in setup) has nothing to remove
  fsImpl.rmSync(dir, { recursive: true, force: true, ...RM_RETRIES });
}
