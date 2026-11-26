// ☰ attention dot + 需要处理 · Needs attention card (web/owner-alerts.js, docs/adr/0041, R6, real browser).
// The REAL web.mjs on a throwaway root; a FAKE host responder (this file) plays the VM's path unit: it
// answers a request file with the result and a fresh health file, then removes it: the contract of
// ops/private/superelf-node-actions.sh. PA_E2E_ENGINE=webkit runs the same file in WebKit.
// Without Playwright the browser tests FAIL unless PA_E2E_SKIP=1.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { NODE_ACTIONS, NODE_HEALTH_FILE, ACTIONS_DIR, resultFile } from '../lib/node-alerts.mjs';

const FULL = { ok: false, at: new Date().toISOString(), actions: [...NODE_ACTIONS], problems: [{ kind: 'disk', box: 'system', pct: 92 }] };
let port, root, web, browser, responder, hostPaused = false;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { users: [
    { id: 'owner', username: 'mom', name: 'Mom', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') },
    { id: 'kid', username: 'kid', name: 'Kid', role: 'member', token: 'test-member-token-0123456789abcdef', workspace: 'workspace-kid', passHash: hashPassword('kid-pass-12345') }] } });
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
  // The fake host: every 200 ms, take any request and answer it; cleanup and recheck leave the disk healthy.
  responder = setInterval(() => {
    const dir = path.join(root, ACTIONS_DIR, 'req');
    if (hostPaused || !fs.existsSync(dir)) return;
    for (const a of fs.readdirSync(dir)) {
      fs.writeFileSync(path.join(root, resultFile(a)), JSON.stringify({ at: new Date().toISOString(), ok: true, msg: 'freed 3 GB' }));
      fs.writeFileSync(path.join(root, NODE_HEALTH_FILE), JSON.stringify({ ok: true, at: new Date().toISOString(), actions: FULL.actions, problems: [] }));
      fs.unlinkSync(path.join(dir, a));   // last, as the host does: result first, then the request goes
    }
  }, 200);
});
after(async () => { clearInterval(responder); if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });
const setHealth = (h) => { fs.writeFileSync(path.join(root, NODE_HEALTH_FILE), JSON.stringify(h)); for (const a of NODE_ACTIONS) fs.rmSync(path.join(root, resultFile(a)), { force: true }); };

async function signIn(opts, user, pass) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...opts });
  const page = await ctx.newPage();
  page.on('dialog', (d) => { d.dismiss(); assert.fail(`a native dialog opened: ${d.message()}`); });
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', user); await page.fill('#lpin', pass); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
  return { ctx, page };
}

test('owner: amber dot on ☰ → card with the problem, its meaning and the tip → Free up space → done, dot gone; tip once', { skip, timeout: 90000 }, async () => {
  setHealth(FULL);
  const { ctx, page } = await signIn({}, 'mom', 'owner-pass-123');
  await page.waitForSelector('#menu .oa-dot', { state: 'attached' });
  assert.notEqual(await page.$eval('#menu .oa-dot', (e) => getComputedStyle(e).animationName), 'none', 'it pulses');
  const camTip = page.locator('.pat-tip[data-tip="tip:main-chat-camera"] .pat-x');   // web/shell-cam.js's priority tip shows first on a fresh account
  if (await camTip.waitFor({ timeout: 5000 }).then(() => true, () => false)) { await camTip.click(); await page.evaluate(() => window.PATips.whenIdle()); }
  await page.click('#hmore'); await page.click('#menu'); await page.waitForSelector('#oaCard');
  const text = await page.locator('#oaCard').innerText();
  assert.match(text, /需要处理 · Needs attention/);
  assert.match(text, /系统盘已用 92% · The system disk is 92% full/);
  assert.match(text, /updates and saving can fail/);
  assert.match(await page.locator('.pat-tip[data-tip="tip:owner-alerts"]').innerText({ timeout: 5000 }), /^新：.* · New:/, 'one-time tip (PATips, beside the card)');
  assert.doesNotMatch(text, /新：/, 'not a line inside the card');
  await page.click('#oaCard [data-oa="cleanup-disk"]');
  await page.waitForFunction(() => /完成 · Done/.test(document.querySelector('#oaCard')?.innerText || ''), null, { timeout: 20000 });
  assert.equal(await page.$('#menu .oa-dot'), null, 'the check passed: no dot');
  assert.doesNotMatch(await page.locator('#oaCard').innerText(), /92%/);
  setHealth(FULL);
  await page.reload(); await page.waitForSelector('#menu .oa-dot', { state: 'attached' });
  await page.click('#hmore'); await page.click('#menu'); await page.waitForSelector('#oaCard');
  await page.waitForTimeout(1000); assert.equal(await page.locator('.pat-tip[data-tip="tip:owner-alerts"]').count(), 0, 'the tip shows once');
  await ctx.close();
});

test('owner: Claude down → Rebuild asks to confirm with the downtime first; Ask 管家 fills the chat, never sends', { skip, timeout: 90000 }, async () => {
  setHealth({ ...FULL, problems: [{ kind: 'claude' }] });
  const { ctx, page } = await signIn({}, 'mom', 'owner-pass-123');
  await page.waitForSelector('#menu .oa-dot', { state: 'attached' }); await page.click('#hmore'); await page.click('#menu'); await page.waitForSelector('#oaCard [data-oa="rebuild-node"]');
  await page.click('#oaCard [data-oa="rebuild-node"]');
  assert.match(await page.locator('#oaCard [data-oa="rebuild-node"]').innerText(), /约 2 分钟.*about 2 minutes offline/);
  assert.equal(fs.existsSync(path.join(root, ACTIONS_DIR, 'req', 'rebuild-node')), false, 'nothing asked before the confirm');
  await page.click('#oaCard [data-ask]');
  assert.match(await page.inputValue('#box'), /Claude will not start.*Please help me fix it/);
  assert.equal(await page.evaluate(() => document.querySelectorAll('#log .msg, #log .user').length), 0, 'not sent');
  await ctx.close();
});

test('owner: Not today hides the dot and the card until tomorrow', { skip, timeout: 60000 }, async () => {
  setHealth(FULL); fs.rmSync(path.join(root, 'node-alerts-snooze.json'), { force: true });
  const { ctx, page } = await signIn({}, 'mom', 'owner-pass-123');
  await page.waitForSelector('#menu .oa-dot', { state: 'attached' }); await page.click('#hmore'); await page.click('#menu'); await page.waitForSelector('#oaCard [data-snooze]');
  await page.click('#oaCard [data-snooze]');
  await page.waitForFunction(() => !document.querySelector('#menu .oa-dot') && !document.querySelector('#oaCard'));
  fs.rmSync(path.join(root, 'node-alerts-snooze.json'), { force: true });
  await ctx.close();
});

test('member: no dot, no card, never asks for alerts', { skip, timeout: 60000 }, async () => {
  setHealth(FULL);
  const asked = [];
  const { ctx, page } = await signIn({}, 'kid', 'kid-pass-12345');
  page.on('request', (r) => { if (r.url().includes('/api/admin/alerts')) asked.push(r.url()); });
  await page.click('#hmore'); await page.click('#menu'); await page.waitForTimeout(800);
  assert.equal(await page.$('#menu .oa-dot'), null);
  assert.equal(await page.$('#oaCard'), null);
  assert.deepEqual(asked, []);
  await ctx.close();
});

test('reduced motion: the dot is steady; phone width 375: the card fits, no sideways scroll', { skip, timeout: 60000 }, async () => {
  setHealth(FULL);
  const { ctx, page } = await signIn({ reducedMotion: 'reduce', viewport: { width: 375, height: 812 } }, 'mom', 'owner-pass-123');
  await page.waitForSelector('#menu .oa-dot', { state: 'attached' });
  assert.equal(await page.$eval('#menu .oa-dot', (e) => getComputedStyle(e).animationName), 'none');
  await page.click('#hmore'); await page.click('#menu'); await page.waitForSelector('#oaCard');
  const box = await page.$eval('#oaCard', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right }; });
  assert.ok(box.l >= 0 && box.r <= 375, JSON.stringify(box));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await ctx.close();
});

test('a full DATA box offers no prune (it frees only the system disk); a reload mid-fix keeps following it; a rebuild confirm resets on reopen', { skip, timeout: 90000 }, async () => {
  setHealth({ ...FULL, problems: [{ kind: 'disk', box: 'private', pct: 91 }, { kind: 'claude' }] });
  const { ctx, page } = await signIn({}, 'mom', 'owner-pass-123');
  await page.waitForSelector('#menu .oa-dot', { state: 'attached' }); await page.click('#hmore'); await page.click('#menu'); await page.waitForSelector('#oaCard');
  assert.equal(await page.$('#oaCard [data-oa="cleanup-disk"]'), null);
  assert.match(await page.locator('#oaCard').innerText(), /what is left is your own data/);
  assert.doesNotMatch(await page.locator('#oaCard').innerText(), /Already cleaned up/);
  await page.click('#oaCard [data-oa="rebuild-node"]');
  await page.evaluate(() => closeDrawer()); await page.click('#hmore'); await page.click('#menu'); await page.waitForSelector('#oaCard [data-oa="rebuild-node"]');
  await page.waitForFunction(() => !/Confirm/.test(document.querySelector('#oaCard [data-oa="rebuild-node"]').innerText));
  hostPaused = true;
  await page.click('#oaCard [data-oa="recheck"]');
  await page.waitForFunction(() => /Working/.test(document.querySelector('#oaCard')?.innerText || ''));
  await page.reload(); await page.click('#hmore'); await page.click('#menu');
  await page.waitForFunction(() => /Working/.test(document.querySelector('#oaCard')?.innerText || ''), null, { timeout: 10000 });
  hostPaused = false;
  await page.waitForFunction(() => /完成 · Done/.test(document.querySelector('#oaCard')?.innerText || ''), null, { timeout: 20000 });
  await ctx.close();
});
