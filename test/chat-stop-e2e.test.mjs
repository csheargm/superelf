// The composer's Stop · 停止 in a real browser (F4-3, R6). The owner sends a slow question: the send
// button turns into ■ "停止 · Stop"; typing turns it back into Send; tapping Stop ends the turn and the
// log shows "已取消 · Cancelled", then the button is Send again. A FAKE `claude` stands in for the
// agent. Without Playwright the browser test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';

const SHOTS = process.env.PA_SHOTS || '';
const FAKE = `#!/usr/bin/env node
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-1' }) + '\\n');
  setTimeout(() => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: 'SLOW ANSWER', session_id: 'sid-1' }) + '\\n'), 20000);
});
`;

let port, root, web, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, users: [{ id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = writeFakeCli(bin, 'claude', FAKE);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

test('while a turn runs the send button is Stop; Stop ends it with 已取消 · Cancelled', { skip, timeout: 60000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
  const btn = () => page.evaluate(() => { const b = document.querySelector('#send'); return { stop: b.classList.contains('stop'), icon: !!b.querySelector('svg'), title: b.title }; });
  assert.deepEqual(await btn(), { stop: false, icon: true, title: '发送 · Send' });   // icons are inline SVG (web/icons.js), not ↑ / ■
  await page.fill('#box', 'a slow question'); await page.press('#box', 'Enter');
  await page.waitForFunction(() => document.querySelector('#send').title === '停止 · Stop');
  assert.deepEqual(await btn(), { stop: true, icon: true, title: '停止 · Stop' });
  await page.fill('#box', 'typing a follow-up');
  assert.equal((await btn()).title, '发送 · Send', 'with text in the composer the button sends (queues)');
  await page.fill('#box', '');
  assert.equal((await btn()).title, '停止 · Stop');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'chat-stop.png') });
  const t0 = Date.now();
  await page.click('#send');
  await page.waitForFunction(() => document.querySelector('#log').textContent.includes('已取消 · Cancelled'), null, { timeout: 8000 });
  assert.ok(Date.now() - t0 < 8000);
  await page.waitForFunction(() => document.querySelector('#send').title === '发送 · Send');
  assert.ok(!(await page.locator('#log').textContent()).includes('SLOW ANSWER'));
  await ctx.close();
});
