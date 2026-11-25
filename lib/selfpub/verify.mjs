// 发布前先检查 · Verify before reply (docs/adr/0043 §4). Run by the SERVER after the agent's turn,
// never by the agent (its lane has no Bash). The affected tests run in the checkout with a scrubbed
// env (no token, no ANTHROPIC_/CLAUDE_ keys), a temp HOME and a timeout. Zero tests run, or empty
// output, is a FAILURE, never a pass (R14). The iPhone render is pluggable: a node with no headless
// browser says so plainly and is not "ready" (owner decision D3/D6 in the plan).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { scrubbedEnv } from './checkout.mjs';

export const TEST_TIMEOUT_MS = 5 * 60 * 1000;
export const ALWAYS_TESTS = ['test/public-privacy.test.mjs'];
const MAX_TEST_FILES = 60;

const stem = (rel) => path.basename(rel).replace(/\.(m?js|html|css)$/, '');

// Changed paths → the test files to run (only ones that exist in the checkout).
export function testsFor(dir, changed) {
  const testDir = path.join(dir, 'test');
  const all = fs.existsSync(testDir) ? fs.readdirSync(testDir).filter((f) => f.endsWith('.test.mjs')) : [];
  const out = new Set(ALWAYS_TESTS.filter((t) => fs.existsSync(path.join(dir, t))));
  for (const rel of changed) {
    if (/^test\/.+\.test\.mjs$/.test(rel) && fs.existsSync(path.join(dir, rel))) out.add(rel);
    const s = stem(rel);
    for (const t of all) {
      if (t.startsWith(s + '.') || t.startsWith(s + '-')) { out.add(`test/${t}`); continue; }
      const src = fs.readFileSync(path.join(testDir, t), 'utf8');
      if (src.includes(`/${rel}'`) || src.includes(`/${rel}"`)) out.add(`test/${t}`);
    }
  }
  return [...out].sort().slice(0, MAX_TEST_FILES);
}

// node --test's summary lines → numbers. Missing lines = nothing ran (R14).
export function parseTap(out) {
  const n = (k) => { const m = new RegExp(`^# ${k} (\\d+)$`, 'm').exec(out); return m ? Number(m[1]) : null; };
  const pass = n('pass'), fail = n('fail'), tests = n('tests'), skipped = n('skipped') ?? 0;
  const failed = [...out.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]).slice(0, 10);
  return { pass: pass ?? 0, fail: fail ?? 0, tests: tests ?? 0, skipped, failed, ran: tests !== null && tests > 0 && pass !== null && fail !== null };   // a truncated summary is not a run
}

// NODE_TEST_CONTEXT (set when the node itself runs under a test runner) would make the child report to
// a parent runner instead of printing TAP: never inherited.
const testEnv = (home) => { const e = scrubbedEnv({ HOME: home, PA_E2E_SKIP: '1', NODE_ENV: 'test' }); delete e.NODE_TEST_CONTEXT; return e; };

// Only trusted tests over data-only changes reach here (owner decision 2026-11-25: the node never runs
// code the agent wrote; code changes are tested by GitHub CI, lib/selfpub/lane.mjs).
export function runTests(dir, files, { timeoutMs = TEST_TIMEOUT_MS, exec = execFile } = {}) {
  if (!files.length) return Promise.resolve({ ok: false, pass: 0, fail: 0, tests: 0, failed: [], note: '没有可运行的测试 · No tests to run' });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'selfpub-home-'));
  return new Promise((resolve) => {
    const argv = [process.execPath, '--test', '--test-reporter=tap', ...files];
    const [cmd, ...args] = argv;
    exec(cmd, args, { cwd: dir, timeout: timeoutMs, maxBuffer: 32 << 20,
      env: testEnv(home) }, (err, stdout = '', stderr = '') => {
      fs.rmSync(home, { recursive: true, force: true });
      const r = parseTap(String(stdout) + String(stderr));
      const timedOut = !!(err && err.killed);
      // A pass needs a clean exit AND at least one passing test: all-skipped or a non-zero exit is a failure (R14).
      resolve({ ...r, ok: r.ran && r.fail === 0 && r.pass > 0 && !err, note: timedOut ? '测试超时 · Tests timed out' : '' });
    });
  });
}

// render(dir, changedPages) → { ok, shots: [png paths] } — given by the host when it has a browser.
// onlyTests: the set of trusted test files (a new or changed test is never run on the node).
// ciOnly: a note — the change has code, so its tests run in GitHub CI only and Publish merges only on green.
export async function verifyChange(dir, changed, { render = null, timeoutMs, exec, ciOnly = '', onlyTests = null } = {}) {
  const files = ciOnly ? [] : testsFor(dir, changed).filter((f) => !onlyTests || onlyTests.has(f));
  const tests = ciOnly ? { ok: false, ci: true, pass: 0, fail: 0, tests: 0, failed: [], note: ciOnly }
    : await runTests(dir, files, { timeoutMs, exec });
  const pages = changed.filter((p) => /^web\/.+\.(html|css|js)$/.test(p));
  let shot = { ok: !pages.length, shots: [], note: pages.length ? '' : '没有页面改动 · No page changed' };
  if (pages.length) {
    if (!render) shot = { ok: false, shots: [], note: '本节点没有无头浏览器，无法截 iPhone 图 · No headless browser on this node: no iPhone render' };
    else {
      try { shot = await render(dir, pages); if (!shot || !shot.shots || !shot.shots.length) shot = { ok: false, shots: [], note: '截图为空 · Empty render' }; }
      catch (e) { shot = { ok: false, shots: [], note: `截图失败 · Render failed: ${String(e.message).slice(0, 200)}` }; }
    }
  }
  return { ready: (tests.ok || !!tests.ci) && shot.ok, tests: { ...tests, files }, render: shot };
}

// The reply's first lines: a server template, never model prose — so it can never say "done".
export function verifyHeadline(v, nFiles) {
  const t = v.tests;
  const head = v.ready ? '可以发布 · Ready to publish' : '未通过检查 · Checks failed — 还不能发布 · not ready to publish';
  const sk = t.skipped ? `（${t.skipped} 个跳过）` : '', skE = t.skipped ? ` (${t.skipped} skipped)` : '';
  const testPart = t.ci ? 'CI 会测试 · CI will test this' : `测试 ${t.pass}/${t.tests} 通过${sk} · tests ${t.pass}/${t.tests} pass${skE}`;
  const lines = [`${head} — 改了 ${nFiles} 个文件 · ${nFiles} file(s) changed; ${testPart}`];
  if (t.note) lines.push(t.note);
  if (t.failed.length) lines.push(`失败 · Failed: ${t.failed.join('; ')}`);
  if (v.render.note) lines.push(v.render.note);
  else if (v.render.shots.length) lines.push('已在 iPhone 宽度（390）截图，见发布预览 · Rendered at iPhone width (390): see the publish preview');
  lines.push(v.ready ? '发布后：CI 通过才合并；GPT 审查随每晚运行 · After Publish: merges only on green CI; GPT review rides the nightly run'
    : 'GPT 审查随每晚运行 · GPT review rides the nightly run');
  return lines.join('\n');
}
