// Every intentional skip says WHY, with a tag · 每个有意的跳过都带标签
//
// ONE place (R3) for the reason tags a skip may carry, and for where each tag is EXPECTED. The CI
// guard (.github/ci-guard.mjs) reads the tag off every "# SKIP" line of the TAP output and fails on
// a skip whose tag is missing, unknown, or not expected on that OS. So a new Playwright test skips
// on CI without anyone editing a ceiling, while a test that silently stops running (a lost git
// history, a missing gpg on Linux, an untagged t.skip) still turns the run red (R14).
//
// A skip reason is "[tag] human words". Build it only with skipBecause / skipIf.

// tag → the platforms (process.platform) where CI may skip it. An empty list: never on CI.
export const SKIP_TAGS = Object.freeze({
  'no-browser': ['linux', 'win32', 'darwin'],      // no Playwright on CI (PA_E2E_SKIP=1), test/helpers-e2e-gate.mjs
  'other-engine': ['linux', 'darwin'],             // PA_E2E_ONLY: each CI browser job runs one engine (helpers-e2e-gate)
  'posix-only': ['win32'],                         // bash, POSIX modes/signals/symlinks, the .sh ops scripts
  'no-pwsh': ['linux', 'darwin'],                  // the .ps1 scripts need PowerShell
  'no-flock': ['darwin', 'win32'],                 // util-linux flock(1)
  'case-sensitive-fs': ['linux'],                  // Windows name resolution cannot be simulated
  'darwin-only': ['linux', 'win32'],               // Apple Vision, CIDetector
  'env-moot': ['linux', 'win32', 'darwin'],        // a probe found nothing to prove HERE (measured, not assumed)
  'ci-runner': ['linux', 'win32', 'darwin'],       // a local-only check: CI's login is a generic runner account
  'no-git-history': [],                            // CI checks out full history: must run there
  'no-gpg': [],                                    // ubuntu has gpg and bash: the backup tests must run there
  'root-user': [],                                 // CI does not run as root
});

export function skipBecause(tag, why) {
  if (!Object.hasOwn(SKIP_TAGS, tag)) throw new Error(`unknown skip tag "${tag}" (test/helpers-skip.mjs)`);
  return `[${tag}] ${why}`;
}

// The value for a test's { skip } option or a t.skip() argument: false when cond is falsy.
export const skipIf = (cond, tag, why) => (cond ? skipBecause(tag, why) : false);
