// The timing helpers the app suites wait with, kept apart from the app fixture in helpers-app.mjs (R4):
// a suite that tests one lib/ module imports them from here without loading that fixture.
// helpers-app.mjs re-exports all three, so the app suites import them from there as before.
import assert from 'node:assert/strict';

export const settle = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
// Boot now makes real HTTP round-trips (index → .bak → probe), so "a few microtasks" is not a
// wait. Poll for the CONDITION and fail loudly on timeout rather than asserting on a half-booted
// app — a race that resolves the wrong way would otherwise read as a passing test.
export async function until(cond, what, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cond()) return true; await new Promise((r) => setTimeout(r, 5)); }
  assert.fail(`timed out waiting for: ${what}`);
}
// A promise the test settles by hand, to hold a reply or a read back until it chooses:
// `const d = deferred(); … await d.promise … d.resolve(value)`. The one copy for every suite (R3).
export const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
