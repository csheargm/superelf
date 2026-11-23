// Wiring for the Jobs view（任务）+ Node settings（节点设置）— v2.9.0.
// Inline shell script is not importable (the email-ui.test.mjs guard style):
// the derivation/validation cores are unit-tested in jobstatus.test.mjs /
// adminconfig.test.mjs; HERE the committed sources are asserted — auth gates,
// route placement, key-only auditing, and the shell UI contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readShell } from '../lib/shellhtml.mjs';   // the shell AS SERVED — settings parts inlined

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8'); // throws if moved — never a vacuous pass (R14)
const web = read('web.mjs');
const html = readShell(ROOT);

// ── web.mjs: routes ──────────────────────────────────────────────────────────
test('web.mjs: GET /api/jobs is authed and per-user — inside the userFor-gated section, fed the USER\'s own marks/reminders', () => {
  const gate = web.indexOf('const user = userFor(req)');
  const jobs = web.indexOf("p === '/api/jobs'");
  assert.ok(gate > 0 && jobs > gate, 'route sits after the 401 token gate');
  const ep = web.slice(jobs, jobs + 900);
  assert.match(ep, /readJobRuns\(user\)/, "marks from the requesting user's workspace only");
  assert.match(ep, /loadReminders\(user\)/, "reminders from the requesting user's workspace only");
  assert.match(ep, /readAuditTail\(cfg\.auditFile\)/, 'bounded audit tail — never an unbounded log read');
  assert.match(ep, /who: user\.id/, 'audit outcomes filtered to this user (isolation)');
  assert.match(ep, /job-state-error/, 'corrupt marks audited, rows still render (R5)');
  assert.match(ep, /reminder-state-error/, 'corrupt reminders audited too');
});

test('web.mjs: manual run audits job-run/job-failed in the tick\'s shape so lastOutcome stays honest for manual runs', () => {
  // Slice to the END of the route block, not a fixed number of characters: a 2600-char window
  // broke the moment a comment was added above the audit call it checks, reporting a
  // regression where there was none.
  const epStart = web.indexOf('/api\\/jobs\\/[\\w-]+\\/run');
  const ep = web.slice(epStart, web.indexOf("\n    if (req.method ===", epStart + 100));
  assert.match(ep, /audit\('job-failed', \{ who: user\.id, job: job\.name, manual: true/, 'a thrown manual run is audited as failed, not lost in a generic 500');
  assert.match(ep, /audit\('job-run', \{ who: user\.id, job: job\.name, briefing: out\.briefing \? out\.briefing\.id : null, skipped: !!out\.skipped, manual: true \}\)/);
});

test('web.mjs: /api/admin/config + /api/admin/restart live INSIDE the owner-gated admin block', () => {
  const blockStart = web.indexOf("p.startsWith('/api/admin/')");
  const ownerGate = web.indexOf('{"error":"owner only"}', blockStart);
  const cfgRoute = web.indexOf("p === '/api/admin/config'");
  const restart = web.indexOf("p === '/api/admin/restart'");
  const stillInBlock = web.indexOf("p.endsWith('/approve')"); // a known member of the same block, later in it
  assert.ok(blockStart > 0 && ownerGate > blockStart, 'admin block owner-gates first');
  assert.ok(cfgRoute > ownerGate && cfgRoute < stillInBlock, 'config route after the 403 gate, inside the block');
  assert.ok(restart > ownerGate && restart < stillInBlock, 'restart route after the 403 gate, inside the block');
});

test('web.mjs: config GET serves the whitelisted VIEW of a fresh read — never the raw file; PUT audits the KEY NAME ONLY', () => {
  const ep = web.slice(web.indexOf("p === '/api/admin/config'"));
  assert.match(ep.slice(0, 400), /adminConfigView\(raw, cfg\)/, 'view built by the whitelist core (lib/adminconfig.mjs)');
  assert.match(ep.slice(0, 1200), /applyConfigWrite\(ROOT, String\(b\.key \|\| ''\), b\.value, cfg\)/);
  const auditCall = ep.match(/audit\('config-set', \{[^}]*\}\)/);
  assert.ok(auditCall, 'writes are audited');
  assert.ok(!/\bvalue\b/.test(auditCall[0]), 'the config-set audit entry must never carry a value (secret or not)');
  assert.match(auditCall[0], /key: out\.key/);
});

test('web.mjs: restart replies ok, audits, then exits so the keep-alive supervisor (launchd) respawns', () => {
  const ep = web.slice(web.indexOf("p === '/api/admin/restart'"), web.indexOf("p === '/api/admin/restart'") + 500);
  assert.match(ep, /audit\('restart', \{ by: user\.id \}\)/);
  assert.match(ep, /send\(res, 200/, 'the ok reply goes out first');
  assert.match(ep, /setTimeout\(\(\) => process\.exit\(0\), \d+\)\.unref\(\)/, 'exit is deferred past the response flush');
});

test('web.mjs: JOBS titles double as bilingual labels (R3 — no parallel labels map)', () => {
  assert.match(web, /bilingual `title` doubles as its label/, 'the R3 decision is recorded at the JOBS map');
  assert.doesNotMatch(web, /title: '每日一报 · Daily Brief'/, 'the daily brief was removed 2026-10-11');
  assert.match(web, /title: '健康简报 · Weekly Health Brief'/);
});

// ── web/index.html: shell UI ─────────────────────────────────────────────────
test('shell: Jobs · 任务 collapsible for every user; rows honest, Run now confirmed, reminder Remove reuses the existing path', () => {
  assert.match(html, /<details id="jobsWrap"/);
  assert.match(html, /任务 · Jobs/);
  assert.match(html, /无法加载任务/, 'R5: a failed load is shown, never an empty-looking list');
  assert.match(html, /outcomeLabel/, 'outcome painted from the SERVER\'s audit-derived field');
  assert.match(html, /失败/, 'failed outcome shown bilingually');
  assert.match(html, /askConfirm\(`立即运行该任务？ · Run "\$\{rb\.dataset\.jlabel\}" now\?`,'立即运行 · Run now'\)/, 'Run now goes through the shared confirm');
  // The ENDPOINT is the contract; which expression supplies the name is not. This first pinned
  // `encodeURIComponent(rb.dataset.runjob)` inline and broke when the run-now fix hoisted that
  // into a `jobName` const — same endpoint, same source, a false regression.
  assert.match(html, /'\/api\/jobs\/'\+encodeURIComponent\(\w+\)\+'\/run'/, 'the EXISTING run endpoint, not a new one');
  assert.match(html, /rb\.dataset\.runjob/, 'and the job it runs still comes from the row that was pressed');
  assert.match(html, /今日无简报/, 'skipped result surfaced inline');
  assert.match(html, /SHELL_CONFIRM_LABELS\['remove-reminder'\]/, 'remove reuses the shared labels (R3)');
  assert.match(html, /'\/api\/reminders\/'\+encodeURIComponent\(rr\.dataset\.remrem\),\{method:'DELETE'\}/, 'the EXISTING remove endpoint');
});

test('shell: ONE confirm surface — shellConfirm delegates to askConfirm; new sections use it too', () => {
  assert.match(html, /function askConfirm\(text,okLabel\)/);
  assert.match(html, /return askConfirm\(`应用请求\$\{zh\}，确认？ · App requests: \$\{en\}/, 'shellConfirm is now a thin wording wrapper (R3)');
  assert.equal((html.match(/d\.showModal\(\)/g) || []).length >= 1, true);
  assert.match(html, /askConfirm\('清除该密钥，确认？ · Clear this secret\?','清除 · Clear'\)/);
  assert.match(html, /askConfirm\('立即重启节点？[^']* · Restart the node now\?/, 'restart confirmed in shell chrome');
});

test('shell: Node settings · 节点设置 is owner-only, secrets are write-only in the DOM, restart polls until the node answers', () => {
  assert.match(html, /<details id="nodeCfgWrap" style="display:none/, 'hidden until the profile load proves owner');
  assert.match(html, /\$\('#nodeCfgWrap'\)\.style\.display=ME\.role==='owner'\?'block':'none'/);
  assert.match(html, /节点设置 · Node settings/);
  assert.match(html, /type="password" placeholder="粘贴以替换 · paste to replace" autocomplete="new-password"/, 'secret inputs start blank and never prefill');
  assert.match(html, /已设置 · SET/); assert.match(html, /未设置 · empty/);
  assert.match(html, /重启后生效 · after restart/, 'boot-time fields marked');
  assert.match(html, /应用并重启 · Apply &amp; restart/);
  assert.match(html, /loadNodeCfg\(\); \/\/ re-render from the server's view/, 'a typed secret never lingers in the DOM after save');
  assert.match(html, /fetch\('\/',\{cache:'no-store'\}\)/, 'restart poll hits / uncached');
  assert.match(html, /已重启 · restarted/);
  assert.match(html, /未恢复，请检查节点/, 'poll deadline is honest, not an infinite spinner');
  assert.match(html, /无法加载配置/, 'R5 failure state for the config list');
});

test('shell: v2.9.0 new-feature dots — registry keys + marks for both sections', () => {
  assert.match(html, /'jobs-section':'v2\.9\.0'/);
  assert.match(html, /'node-settings':'v2\.9\.0'/);
  assert.match(html, /markNewSel\('#jobsWrap>summary','jobs-section'\)/);
  assert.match(html, /markNewSel\('#nodeCfgWrap>summary','node-settings'\)/);
});
