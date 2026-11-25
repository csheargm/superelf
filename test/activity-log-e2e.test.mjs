// Settings → Activity log · 活动记录 (F5-10, R6, real browser).
// 2026-11-24 (owner decision): only security events, failures and app changes; app changes carry the
// request, Undo and See the difference. CONTROL (R14): routine rows are seeded and must not show.
// Overnight 2026-11-23: it was a native alert() of raw event names ("job-failed"), account ids and
// UTC times cut to "11-23T04:12". Now: a dialog, plain bilingual labels, the person's name, and the
// device's local time with the full date. CONTROL (R14): no native dialog opens at all.
// Without Playwright the browser test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { readShell } from '../lib/shellhtml.mjs';
import { snapshotApp, EDIT_WHY } from '../lib/app-versions.mjs';
import { recordRequest } from '../lib/app-history.mjs';
import { VERSIONS_DIR } from '../lib/app-edit.mjs';

const AT = '2026-11-23T04:12:00.000Z';
let port, root, web, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [{ id: 'owner', username: 'mom', name: 'Mom', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

test('the shell carries the activity log and no longer alert()s it', () => {
  const shell = readShell(path.join(import.meta.dirname, '..'));
  assert.ok(shell.includes('async function showActivityLog('));
  assert.ok(!/auditBtn[^\n]*alert\(/.test(shell));
});

async function signIn() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles', locale: 'en-US' });
  const page = await ctx.newPage();
  page.on('dialog', (d) => { d.dismiss(); assert.fail(`a native dialog opened: ${d.message()}`); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'mom'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
  return { ctx, page };
}
const auditPath = () => path.join(root, fs.readdirSync(root, { recursive: true }).map(String).find((f) => /audit.*\.(jsonl|log)$/.test(f)));
const shot = async (page, name) => { if (process.env.PA_SHOTS) await page.locator('#activityLog').screenshot({ path: path.join(process.env.PA_SHOTS, name + '.png') }); };
const openLog = async (page) => { if (!(await page.evaluate(() => document.querySelector('#cfg').open))) { await page.click('#hmore'); await page.click('#settings'); } await page.waitForSelector('#cfg[open] #auditBtn:visible'); await page.click('#auditBtn'); await page.waitForSelector('#activityLog[open] .act-body'); };

test('Activity log: only what matters, plain sentences, local time; app change → diff and Undo', { skip, timeout: 90000 }, async () => {
  const { ctx, page } = await signIn();
  // Only a successful sign-in so far: routine → the empty state.
  await openLog(page);
  await shot(page, 'empty');
  assert.match(await page.locator('#activityLog .act-empty').textContent(), /只记安全事件、失败和应用改动 · Nothing needs you/);
  await page.click('#activityClose');
  // An app with one saved change (the request stored), as the Change-this-app turn leaves it.
  const ws = path.join(root, 'workspace'), app = path.join(ws, 'apps', 'notes'), vroot = path.join(ws, VERSIONS_DIR);
  fs.mkdirSync(app, { recursive: true }); fs.writeFileSync(path.join(app, 'index.html'), '<p>old title</p>\n');
  const v = snapshotApp(app, vroot, 'notes', EDIT_WHY);
  recordRequest(vroot, 'notes', v, { request: 'rename the title', who: 'owner' });
  fs.writeFileSync(path.join(app, 'index.html'), '<p>new title</p>\n');
  const now = new Date().toISOString();
  fs.appendFileSync(auditPath(), [{ at: AT, ev: 'job-failed', who: 'owner', job: 'briefing' }, { at: AT, ev: 'login', who: 'stranger', ok: false },
    { at: now, ev: 'builtin-apps-update', dir: '/x/workspace-kid/apps' }, { at: now, ev: 'job-run', who: 'owner', job: 'briefing' },
    { at: now, ev: 'node-health-failed', ok: false }, { at: now, ev: 'app-edit', who: 'owner', app: 'notes', changed: true, applied: true, version: v }]
    .map((r) => JSON.stringify(r)).join('\n') + '\n');
  await openLog(page); await page.waitForSelector('#activityLog .act-row');
  await page.waitForSelector('#activityLog .pat-tip[data-tip="tip:activity-app-changes"]', { timeout: 5000 });   // the ONE tip mechanism, inside the dialog
  const text = await page.locator('#activityLog').textContent();
  assert.match(text, /Mom 修改了应用「notes」 · Mom changed the app "notes"/);
  assert.match(text, /“rename the title”/);
  assert.match(text, /任务「briefing」失败 · The job "briefing" failed/);
  assert.match(text, /登录失败：stranger · Failed sign-in: stranger/);
  assert.match(text, /新：应用改动可以在这里撤销或查看改动/, 'first-use tip beside the new buttons');
  assert.doesNotMatch(text, /Builtin apps update|Job ran|任务运行|登录 · Sign-in/, 'routine rows are gone');
  await shot(page, 'log');
  const rows = await page.locator('#activityLog .act-row').allInnerTexts();
  assert.match(rows[0], /节点健康检查发现问题/, 'critical failure pinned first');
  assert.match(rows[0], /去处理 · Fix it/);
  // Engines join date and time differently: assert the parsed parts. 08:12 PM Los Angeles; UTC would be 04:12 AM Nov 23.
  const times = [...text.matchAll(/Nov (\d+), (\d{4})(?:,| at) (\d{2}):(\d{2}) (AM|PM)/g)].map((m) => m.slice(1).join(' '));
  assert.ok(times.includes('22 2026 08 12 PM'), `the seeded rows in local (Los Angeles) time, not UTC: ${times}`);
  await page.click('#activityLog .act-diff');
  await page.waitForSelector('#activityLog pre.act-diff');
  const diff = await page.locator('#activityLog pre.act-diff').textContent();
  assert.match(diff, /- <p>old title<\/p>/); assert.match(diff, /\+ <p>new title<\/p>/);
  await shot(page, 'diff');
  await page.click('#activityBack'); await page.waitForSelector('#activityLog .act-undo');
  await page.click('#activityLog .act-undo');
  await page.waitForSelector('#activityLog .act-note');
  assert.match(await page.locator('#activityLog .act-note').textContent(), /已撤销/);
  assert.equal(fs.readFileSync(path.join(app, 'index.html'), 'utf8'), '<p>old title</p>\n', 'the app is back');
  assert.equal(await page.locator('#activityLog .act-undo').count(), 0, 'nothing left to undo on that row');
  // The tip shows once only.
  await page.click('#activityClose'); await page.click('#auditBtn'); await page.waitForSelector('#activityLog .act-row');
  await page.waitForTimeout(300); assert.equal(await page.locator('.pat-tip').count(), 0);
  // Fix it → the Needs attention drawer.
  await page.click('#activityLog .act-fix');
  await page.waitForSelector('#drawer.open');
  assert.equal(await page.evaluate(() => document.querySelector('#activityLog').open), false);
  await ctx.close();
});

test('signed out: the activity view is refused', async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/admin/activity`);
  assert.ok(r.status === 401 || r.status === 403, String(r.status));
});
