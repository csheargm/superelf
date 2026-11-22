// Fail-closed gate for the real-browser e2e suites (R14) · 端到端测试的失败关闭门
// Pure, so test/helpers-e2e-gate.test.mjs can pin it without a browser.
export const SETUP = 'set PA_PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs (browser: `npx playwright install chromium`, '
  + 'or PLAYWRIGHT_BROWSERS_PATH to a cache holding the build it expects); or PA_E2E_SKIP=1 to skip on purpose';
// Why the real browser cannot run, or '' when it can. A trial launch, the same call the suites make,
// so it checks the exact binary they need (the headless shell, not executablePath()'s full Chromium).
export async function missingReason(pw) {
  if (!pw) return `no Playwright: ${SETUP}`;
  try { await (await pw.launch()).close(); return ''; }
  catch (e) { return `Playwright's browser will not launch (${String(e.message).split('\n')[0]}): ${SETUP}`; }
}
// Fail closed unless the owner opted out; the opt-out turns the reason into a visible skip.
export function resolveSkip(reason, env = process.env) {
  if (!reason) return false;
  if (env.PA_E2E_SKIP === '1') return reason;
  throw new Error(`e2e cannot run: ${reason}`);
}
