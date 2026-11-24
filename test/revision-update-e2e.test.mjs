// A deploy reaches an open page · 部署后打开的页面自动更新 (PAUpdate, ADR 0026; R6, real browser).
// Scar 2026-11-23: on the VM the node folder kept an old REVISION, so the footer read ca28633 on
// new code and the shell never saw a new build — "we used to have auto update". Here a node with
// no .git (as on the VM) runs from REVISION; the page loads with build A, the deploy swaps
// REVISION to B, and the shell must notice and reload itself onto B, footer date included.
// CONTROL: before the swap a check answers 'same' (no reload storm).
// Without Playwright the browser test FAILS unless PA_E2E_SKIP=1. PA_E2E_ENGINE=webkit for Safari.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { HEAD_TTL_MS } from '../lib/buildid.mjs';

const SHA_A = 'a1b2c3d'.padEnd(40, '0'), SHA_B = 'b4e5f60'.padEnd(40, '1');
let port, root, web, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [{ id: 'owner', name: 'Mara', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  fs.writeFileSync(path.join(root, 'REVISION'), `${SHA_A}\n2026-11-22\n`);
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

test('REVISION changes on the node → the open shell detects new code and reloads onto it', { skip, timeout: 90000 }, async () => {
  const ctx = await browser.newContext(); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
  const footer = () => page.evaluate(() => document.querySelector('#ver-lbl').textContent.trim());
  const before = await footer();
  assert.match(before, /· a1b2c3d · (note [0-9a-f]+ · )?11-22$/, `footer names build A and its date: ${before}`);
  assert.equal(await page.evaluate(() => PAUpdate.check()), 'same', 'CONTROL: no new code, no reload');
  fs.writeFileSync(path.join(root, 'REVISION'), `${SHA_B}\n2026-11-23\n`);   // the deploy
  const deadline = Date.now() + HEAD_TTL_MS + 20000;
  let result = 'same';
  while (result === 'same' && Date.now() < deadline) {
    result = await page.evaluate(() => PAUpdate.check()).catch(() => 'reloaded');   // a reload mid-evaluate destroys the context
    if (result === 'same') await page.waitForTimeout(1000);
  }
  assert.equal(result, 'reloaded', 'an idle shell reloads itself on new code');
  await page.waitForFunction(() => /b4e5f60/.test((document.querySelector('#ver-lbl') || {}).textContent || ''), null, { timeout: 15000 });
  assert.match(await footer(), /· b4e5f60 · (note [0-9a-f]+ · )?11-23$/, 'the reloaded page shows build B and its date');
  await ctx.close();
});
