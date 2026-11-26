// The 2026-11-26 nightly review's project records (superelf findings as confirmed that night; the second
// repo renamed). Drives test/nightly-review-email.test.mjs and the phone-width render check.
const c = (file, line, severity, claim) => ({ file, line, severity, claim, evidence: '', reason: 'seen in the code' });
export const CONFIRMED_1126 = [
  c('lib/app-share.mjs', 143, 'medium', 'An interrupted re-share can leave an existing link advertised as active even though visitors cannot join it.'),
  c('lib/nightly-review/job.mjs', 81, 'medium', "Two configured repositories can share a checkout and contaminate each other's review history."),
  c('lib/demo-profile-name.mjs', 38, 'medium', 'An optional account-name write can abort demo sign-in.'),
  c('lib/selfpub/run.mjs', 84, 'medium', 'A repeated Publish request can overwrite the deployment status of a successfully released change.'),
  c('lib/selfpub/render.mjs', 81, 'medium', 'A page that hangs after loading can leave the core-change lock held indefinitely.'),
  c('test/home-ver.test.mjs', 44, 'low', 'The footer unit test fails in calendar years other than 2026.'),
  c('test/ink-font-reflow-e2e.test.mjs', 21, 'low', 'The suite fails to load in a shallow checkout missing the historical commit even when browser tests are explicitly skipped.'),
  c('test/nightly-review-e2e.test.mjs', 83, 'low', 'The member authorization test passes when the nightly review endpoint fails for reasons unrelated to authorization.'),
  c('lib/selfpub/run.mjs', 103, 'medium', 'Retrying a self-publish after red CI fails because the first attempt left the remote branch in place.'),
  c('lib/selfpub/run.mjs', 119, 'medium', 'A self-published change can stay in the deployment-wait state indefinitely if the node skips its exact release and deploys a later release that contains it.'),
  c('web/shell-cam.js', 42, 'low', 'A camera failure notice stays visible indefinitely if the user leaves the draft alone.'),
  c('test/title-home-e2e.test.mjs', 31, 'low', 'The iPad clearance test fails during context creation when the suite runs with Firefox.'),
];
export const projects1126 = () => [
  { name: 'superelf', status: 'reviewed', base: '1b24905'.padEnd(40, '0'), tip: '0686770'.padEnd(40, '0'), commits: new Array(140).fill('x'), cut: [], note: '',
    confirmed: CONFIRMED_1126.map((f) => ({ ...f })),
    rejected: [{ file: 'lib/nightly-review/wire.mjs', line: 22, claim: 'Findings from another repository can be handed to the superelf checkout.', reason: 'operator opt-in' }],
    unverified: [{ file: 'web/selfpub.js', line: 54, severity: 'low', claim: 'Screenshot previews retain their image blobs.', reason: 'not verified: over max_verify (20)' }],
    fix: 'not started: 未改动 superelf · superelf was not changed: 已有一个 superelf 改动在进行 · Another superelf change is already in progress', fixState: 'not-started' },
  { name: 'Other Repo', status: 'failed', base: '', tip: '', commits: [], why: 'git clone 失败 · git clone failed: fatal: Remote branch main not found in upstream origin' },
];
