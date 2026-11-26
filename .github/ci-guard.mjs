// The CI guard against a vacuous green run · 防止"空跑也通过"
//
//   node .github/ci-guard.mjs <file with the output of `npm test`>
//
// `node --test` exits 0 when it finds NO test files, and a glob or path bug on one OS can make it
// find a handful. Either way the job would be green with almost nothing tested (R14). This reads the
// suite's own TAP output and fails unless at least MIN_TESTS (env) tests PASSED, none failed or were
// cancelled, none is todo, and EVERY skip is EXPECTED: its reason starts with a tag from
// test/helpers-skip.mjs that is allowed on this OS. A skip is not a pass. A new Playwright test
// skips on CI as "[no-browser] ..." with no edit here; an untagged skip, or a tag CI must never hit
// (lost git history, no gpg on Linux), goes red. The skip lines found must add up to the summary's
// "# skipped", so a line this parser misses is a failure too. No summary is no evidence: a failure.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SKIP_TAGS } from '../test/helpers-skip.mjs';

const KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
// "ok 12 - name # SKIP reason", at any subtest depth. node escapes "#" in names as "\#", so the
// first " # SKIP" not preceded by a backslash ends the name.
const SKIP_LINE = /^\s*ok \d+ - (?:[^#\\\n]|\\.)*?\s# SKIP(?:[ \t]+([^\r\n]*?))?\s*$/gm;
const TAG = /^\[([a-z-]+)\]/;

// skipReasons(text) → the reason of every skipped test ('' when it gave none).
export function skipReasons(text) {
  return [...String(text).matchAll(SKIP_LINE)].map((m) => m[1] || '');
}

// unexpectedSkips(reasons, platform) → the reasons NOT allowed on that platform.
export function unexpectedSkips(reasons, platform, tags = SKIP_TAGS) {
  return reasons.filter((r) => {
    const tag = (TAG.exec(r) || [])[1];
    return !tag || !Object.hasOwn(tags, tag) || !tags[tag].includes(platform);
  });
}

// judge(text, min, platform) → { ok, summary, reason }. The LAST value of each summary key wins: the
// summary is the tail of the output, and a test's own output could print a look-alike line earlier.
// forbidTags('no-browser') → SKIP_TAGS minus those tags: a browser job must never skip for a missing
// browser, or it would be green having tested nothing it exists to test (R14).
export function forbidTags(list, tags = SKIP_TAGS) {
  const drop = new Set(String(list || '').split(',').map((t) => t.trim()).filter(Boolean));
  return Object.fromEntries(Object.entries(tags).filter(([t]) => !drop.has(t)));
}
export function judge(text, min, platform = process.platform, tags = SKIP_TAGS) {
  const summary = {};
  for (const k of KEYS) {
    const all = [...String(text).matchAll(new RegExp(`^# ${k} (\\d+)\\s*$`, 'gm'))];
    if (all.length) summary[k] = Number(all[all.length - 1][1]);
  }
  if (!Number.isInteger(min) || min < 1) return { ok: false, summary, reason: `MIN_TESTS must be a positive integer, got ${min}` };
  if (KEYS.some((k) => summary[k] === undefined)) return { ok: false, summary, reason: `no full summary (# ${KEYS.join(' / # ')}) in the output: the suite did not report` };
  const problems = [];   // every problem, not just the first: one red run names them all
  if (summary.pass < min) problems.push(`only ${summary.pass} of ${summary.tests} tests passed, fewer than the floor of ${min}`);
  if (summary.fail !== 0 || summary.cancelled > 0) problems.push(`${summary.fail} failed, ${summary.cancelled} cancelled`);
  if (summary.todo > 0) problems.push(`${summary.todo} todo tests: a todo is not a pass`);
  const reasons = skipReasons(text);
  if (reasons.length !== summary.skipped) problems.push(`found ${reasons.length} skip lines but the summary says ${summary.skipped} skipped: cannot check every reason`);
  const bad = unexpectedSkips(reasons, platform, tags);
  if (bad.length) {
    const shown = [...new Set(bad)].slice(0, 10).map((r) => `  "${r || '(no reason)'}"`).join('\n');
    problems.push(`${bad.length} unexpected skips on ${platform} (no tag, or a tag not allowed here; see test/helpers-skip.mjs):\n${shown}`);
  }
  if (problems.length) return { ok: false, summary, reason: problems.join('; ') };
  return { ok: true, summary, reason: `${summary.pass} passed >= ${min}, ${reasons.length} skips all expected on ${platform}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let text = '';
  try { text = fs.readFileSync(process.argv[2], 'utf8'); }
  catch (e) { console.error(`ci-guard: cannot read the test output (${e.message})`); process.exit(1); }
  const num = (v) => (v === undefined || v === '' ? NaN : Number(v));   // unset is NOT 0
  const r = judge(text, num(process.env.MIN_TESTS), process.platform, forbidTags(process.env.CI_FORBID_SKIP));
  for (const k of KEYS) console.log(`# ${k} ${r.summary[k] ?? '(missing)'}`);
  console.log(`${r.ok ? 'OK' : 'FAIL'}: ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
