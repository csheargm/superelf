// Release Notes sheet shows the bumped version as current · 版本记录显示当前版本 (ADR 0038; R6, real browser).
// Scar: the sheet said "v5.0.0 · current" for six weeks of merges. The footer and the sheet must name
// the version tools/bump-version.mjs wrote, newest first, with no "+N" once the release covers main.
// Without Playwright the browser test FAILS unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { ROOT } from './helpers-panote-routing.mjs';

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
let port, root, web, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [{ id: 'owner', name: 'Mara', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  fs.copyFileSync(path.join(ROOT, 'version-notes.json'), path.join(root, 'version-notes.json'));
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

test('footer and Release Notes name the bumped version as current, newest first', { skip, timeout: 60000 }, async () => {
  assert.notEqual(VERSION, '5.0.0', 'CONTROL: the catch-up bump moved the version');
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
  const footer = await page.evaluate(() => document.querySelector('#ver-lbl').textContent);
  assert.ok(footer.includes(`v${VERSION}`), `footer shows v${VERSION}: ${footer}`);
  await page.evaluate(() => document.querySelector('#ver-lbl').dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.waitForSelector('#_ver_sheet');
  const first = await page.evaluate(() => document.querySelector('#_ver_sheet [style*="font-weight:700"]').textContent);
  assert.ok(first.startsWith(`v${VERSION}`) && first.includes('当前'), `newest entry is current: ${first}`);
  await ctx.close();
});
