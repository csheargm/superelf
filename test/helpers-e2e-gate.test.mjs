// The e2e gate fails closed (R14): missing Playwright or browser throws unless PA_E2E_SKIP=1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missingReason, resolveSkip } from './helpers-e2e-gate.mjs';

test('no Playwright, no opt-out → throws with setup help', async () => {
  const reason = await missingReason(null);
  assert.throws(() => resolveSkip(reason, {}), /e2e cannot run: no Playwright.*PA_PLAYWRIGHT.*PA_E2E_SKIP=1/);
});
test('browser binary missing → throws naming the path', async () => {
  const pw = { launch: async () => { throw new Error("Executable doesn't exist at /x/chromium_headless_shell-1208/y\nmore"); } };
  const reason = await missingReason(pw);
  assert.throws(() => resolveSkip(reason, {}), /will not launch \(Executable doesn't exist at \/x\/chromium_headless_shell-1208\/y\)/);
});
test('PA_E2E_SKIP=1 turns the reason into a visible skip; other values do not', async () => {
  const reason = await missingReason(null);
  assert.match(resolveSkip(reason, { PA_E2E_SKIP: '1' }), /^\[no-browser\] no Playwright/);
  assert.throws(() => resolveSkip(reason, { PA_E2E_SKIP: 'true' }));
});
test('browser present → no skip', async () => {
  let closed = false;
  const pw = { launch: async () => ({ close: async () => { closed = true; } }) };
  assert.equal(await missingReason(pw), '');
  assert.ok(closed, 'trial browser closed');
  assert.equal(resolveSkip('', {}), false);
});
test('PA_E2E_ONLY skips another engine without launching it; same engine and unset run', async () => {
  let launched = 0;
  const wk = { name: () => 'webkit', launch: async () => { launched++; return { close: async () => {} }; } };
  const reason = await missingReason(wk, { PA_E2E_ONLY: 'chromium' });
  assert.equal(launched, 0, 'a filtered engine is never launched (its browser may not be installed)');
  assert.match(resolveSkip(reason, {}), /^\[other-engine\] webkit suite; this run is PA_E2E_ONLY=chromium$/);
  assert.equal(await missingReason(wk, { PA_E2E_ONLY: 'webkit' }), '');
  assert.equal(await missingReason(wk, {}), '');
  assert.equal(launched, 2);
  const none = await missingReason(null, { PA_E2E_ONLY: 'webkit' });
  assert.throws(() => resolveSkip(none, {}), /no Playwright/, 'no Playwright still fails closed');
});
