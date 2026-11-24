// Settings → Activity log · 活动记录 (F5-10, R6, real browser).
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
  assert.ok(shell.includes('async function showActivityLog()'));
  assert.ok(!/auditBtn[^\n]*alert\(/.test(shell));
});

test('Activity log opens a dialog: 中文 · English labels, names, local date and time', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/Los_Angeles', locale: 'en-US' });
  const page = await ctx.newPage();
  page.on('dialog', (d) => { d.dismiss(); assert.fail(`a native dialog opened: ${d.message()}`); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'mom'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
  const auditFile = fs.readdirSync(root, { recursive: true }).map(String).find((f) => /audit.*\.(jsonl|log)$/.test(f));
  assert.ok(auditFile, 'the node keeps an audit file');
  fs.appendFileSync(path.join(root, auditFile), JSON.stringify({ at: AT, ev: 'job-failed', who: 'owner' }) + '\n' + JSON.stringify({ at: AT, ev: 'briefing-email-failed' }) + '\n');
  await page.click('#settings'); await page.waitForSelector('#cfg[open] #auditBtn:visible'); await page.click('#auditBtn');
  await page.waitForSelector('#activityLog[open] .act-row');
  const text = await page.locator('#activityLog').textContent();
  assert.match(text, /活动记录 · Activity log/);
  assert.match(text, /任务失败 · Job failed · Mom/);
  assert.match(text, /失败 · Briefing email failed/);
  assert.match(text, /登录 · Sign-in/);
  // Engines join date and time differently (Chromium "Nov 22, 2026, 08:12 PM", WebKit "… 2026 at
  // 08:12 PM"): assert the parsed parts, not the joiner. 08:12 PM is Los Angeles; UTC would be 04:12 AM Nov 23.
  const when = text.match(/Nov (\d+), (\d{4})(?:,| at) (\d{2}):(\d{2}) (AM|PM)/);
  assert.ok(when, `a local date and time in the log: ${text}`);
  assert.deepEqual(when.slice(1), ['22', '2026', '08', '12', 'PM'], 'local (Los Angeles) date and time, not UTC');
  assert.doesNotMatch(text, /job-failed|owner\b/);
  await page.click('#activityClose');
  // Critical rows pinned on top and marked; routine runs fold into "label ×N" (docs/adr/0041).
  const now = new Date().toISOString();
  fs.appendFileSync(path.join(root, auditFile), [1, 2, 3].map(() => JSON.stringify({ at: now, ev: 'builtin-apps-update' })).join('\n') + '\n'
    + JSON.stringify({ at: now, ev: 'node-health-failed', ok: false, why: '/ 91% full' }) + '\n' + JSON.stringify({ at: now, ev: 'builtin-apps-update' }) + '\n');
  await page.click('#auditBtn'); await page.waitForSelector('#activityLog[open] .act-crit');
  const rows = await page.locator('#activityLog .act-row').allInnerTexts();
  assert.match(rows[0], /节点健康检查发现问题 · Node health check found a problem/, 'pinned first');
  assert.match(rows[1], /Builtin apps update ×4/, 'routine run folded, the pinned row does not split it');
  await page.click('#activityClose');
  assert.equal(await page.evaluate(() => document.querySelector('#activityLog').open), false);
  await ctx.close();
});
