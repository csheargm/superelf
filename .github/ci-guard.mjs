// The CI guard against a vacuous green run · 防止"空跑也通过"
//
//   node .github/ci-guard.mjs <file with the output of `npm test`>
//
// `node --test` exits 0 when it finds NO test files, and a glob or path bug on one OS can make it
// find a handful. Either way the job would be green with almost nothing tested (R14). This reads the
// suite's own TAP summary and fails unless at least MIN_TESTS (env) tests PASSED, none failed, and
// no more than MAX_SKIPPED (env, per OS) were skipped or todo. A skip is not a pass: the platform
// skips hang on runtime probes (test/helpers-platform.mjs), and a probe or runner-image regression
// that turned real tests into skips must go red, not stay green. A missing summary is a failure too:
// no evidence is not a pass.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const KEYS = ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

// judge(text, min, maxSkipped) → { ok, summary, reason }. The LAST value of each key wins: the
// summary is the tail of the output, and a test's own output could print a line that looks like one
// earlier on.
export function judge(text, min, maxSkipped) {
  const summary = {};
  for (const k of KEYS) {
    const all = [...String(text).matchAll(new RegExp(`^# ${k} (\\d+)\\s*$`, 'gm'))];
    if (all.length) summary[k] = Number(all[all.length - 1][1]);
  }
  if (!Number.isInteger(min) || min < 1) return { ok: false, summary, reason: `MIN_TESTS must be a positive integer, got ${min}` };
  if (!Number.isInteger(maxSkipped) || maxSkipped < 0) return { ok: false, summary, reason: `MAX_SKIPPED must be a non-negative integer, got ${maxSkipped}` };
  if (KEYS.some((k) => summary[k] === undefined)) return { ok: false, summary, reason: `no full summary (# ${KEYS.join(' / # ')}) in the output: the suite did not report` };
  if (summary.pass < min) return { ok: false, summary, reason: `only ${summary.pass} of ${summary.tests} tests passed, fewer than the floor of ${min}` };
  if (summary.fail !== 0 || summary.cancelled > 0) return { ok: false, summary, reason: `${summary.fail} failed, ${summary.cancelled} cancelled` };
  const skipped = summary.skipped + summary.todo;
  if (skipped > maxSkipped) return { ok: false, summary, reason: `${skipped} tests skipped or todo, more than this OS's ceiling of ${maxSkipped}` };
  return { ok: true, summary, reason: `${summary.pass} passed >= ${min}, ${skipped} skipped <= ${maxSkipped}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let text = '';
  try { text = fs.readFileSync(process.argv[2], 'utf8'); }
  catch (e) { console.error(`ci-guard: cannot read the test output (${e.message})`); process.exit(1); }
  const num = (v) => (v === undefined || v === '' ? NaN : Number(v));   // unset is NOT 0
  const r = judge(text, num(process.env.MIN_TESTS), num(process.env.MAX_SKIPPED));
  for (const k of KEYS) console.log(`# ${k} ${r.summary[k] ?? '(missing)'}`);
  console.log(`${r.ok ? 'OK' : 'FAIL'}: ${r.reason}`);
  process.exit(r.ok ? 0 : 1);
}
