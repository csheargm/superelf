// Fail-closed gate for the real-browser e2e suites (R14) · 端到端测试的失败关闭门
import { skipBecause } from './helpers-skip.mjs';
// Pure, so test/helpers-e2e-gate.test.mjs can pin it without a browser.
export const SETUP = 'set PA_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs (browser: `npx playwright install chromium`, '
  + 'or PLAYWRIGHT_BROWSERS_PATH to a cache holding the build it expects); or PA_E2E_SKIP=1 to skip on purpose';
// Why the real browser cannot run, or '' when it can. A trial launch, the same call the suites make,
// so it checks the exact binary they need (the headless shell, not executablePath()'s full Chromium).
const OTHER = '\u0000other-engine:';   // marks a filter reason (not a missing browser) inside the gate only
// PA_E2E_ONLY=chromium (or webkit) runs one engine's suites only: CI's Linux job runs Chromium,
// its macOS job runs WebKit (iPhone Safari's engine). A suite for another engine skips as
// "[other-engine]" and is never launched, so its browser need not be installed. Unset: no filter.
export function engineFiltered(pw, env = process.env) {
  const only = env.PA_E2E_ONLY;
  const name = pw && typeof pw.name === 'function' ? pw.name() : '';
  return only && name && name !== only ? `${name} suite; this run is PA_E2E_ONLY=${only}` : '';
}
export async function missingReason(pw, env = process.env) {
  const other = engineFiltered(pw, env);
  if (other) return OTHER + other;
  if (!pw) return `no Playwright: ${SETUP}`;
  try { await (await pw.launch()).close(); return ''; }
  catch (e) { return `Playwright's browser will not launch (${String(e.message).split('\n')[0]}): ${SETUP}`; }
}
// Fail closed unless the owner opted out; the opt-out turns the reason into a visible skip.
export function resolveSkip(reason, env = process.env) {
  if (!reason) return false;
  if (reason.startsWith(OTHER)) return skipBecause('other-engine', reason.slice(OTHER.length));
  if (env.PA_E2E_SKIP === '1') return skipBecause('no-browser', reason);
  throw new Error(`e2e cannot run: ${reason}`);
}
