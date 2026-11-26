// 主对话截图 · The main chat's camera, in a real browser (R6). The owner taps 📷 beside ＋ in the home composer:
// its one-time tip shows, a time-labelled thumbnail appears (× removes it, at most 3 of ours), and the message
// carries the picture as an attachment. A FAKE `claude` lists the files the message carries.
// Desktop Chromium + an iPhone 390x844 page, in PA_E2E_ENGINE's engine (webkit = Safari).
// Without Playwright it FAILS unless PA_E2E_SKIP=1. PA_SHOTS=<dir> saves pictures.
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
const ENGINE = process.env.PA_E2E_ENGINE || 'chromium';
const FAKE = `#!/usr/bin/env node
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const cur = s.split('[Current message:]').pop();
  const say = 'ATT[' + [...cur.matchAll(/saved to workspace\\/(\\S+?)\\. Use/g)].map((m) => m[1]).join(',') + ']';
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-m' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: say }] } }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: say, session_id: 'sid-m' }) + '\\n');
});
`;

let port, root, web, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = writeFakeCli(bin, 'claude', FAKE);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

const SIZES = [['desktop', { viewport: { width: 1280, height: 800 } }],
  ['iPhone', { viewport: { width: 390, height: 844 }, isMobile: ENGINE !== 'firefox', hasTouch: true }]];

for (const [name, opts] of SIZES) {
  test(`main chat camera (${name}): tip, thumbnail with time, × removes, max 3, the message carries the picture`, { skip, timeout: 90000 }, async () => {
    const ctx = await browser.newContext(opts); const page = await ctx.newPage();
    const errs = []; page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector('#login[open]');
    await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
    await page.waitForFunction(() => !document.querySelector('#login[open]'));
    const cam = page.locator('#cam');
    await cam.waitFor();
    await page.waitForFunction(() => document.querySelector('#homeForm #cam') && document.querySelector('#cam svg'));   // the composer row sits in the home ask box
    assert.equal(await cam.getAttribute('aria-label'), '截取当前画面 · Capture the screen as it looks now');
    const plus = await page.locator('#plus').boundingBox(), c = await cam.boundingBox(), send = await page.locator('#send').boundingBox(), box = await page.locator('#box').boundingBox();
    assert.ok(c.width >= 44 && c.height >= 44, `44px tap target: ${c.width}x${c.height}`);
    assert.ok(Math.abs(c.y - plus.y) < 6 && c.x > plus.x && c.x < box.x, `the camera sits between ＋ and the input: ${JSON.stringify({ plus, c, box })}`);
    assert.ok(send.x + send.width <= opts.viewport.width, 'send stays on screen');
    const hint = await page.evaluate(() => { const ph = document.querySelector('#hPh'), s = [...ph.children].find((e) => getComputedStyle(e).display !== 'none'), c = document.querySelector('#cam').getBoundingClientRect();
      const zh = s.firstChild, rg = document.createRange(); rg.selectNodeContents(zh); const z = rg.getBoundingClientRect(), p = ph.getBoundingClientRect();
      return { left: p.left, camRight: c.right, zhW: z.width, room: p.width }; });
    assert.ok(hint.left >= hint.camRight, `the home hint starts after the camera: ${JSON.stringify(hint)}`);
    assert.ok(hint.zhW <= hint.room + 0.5, `the 中文 hint line fits whole: ${JSON.stringify(hint)}`);
    const tip = page.locator('.pat-tip', { hasText: '点 📷 截取当前画面' });
    if (name === 'desktop') await tip.waitFor({ timeout: 10000 });   // first open on this account: the tip beside the button
    else { await page.waitForTimeout(1500); assert.equal(await tip.count(), 0, 'the tip shows once per account (the desktop run used it up)'); }
    await shot(page, `tip-${name}`);
    for (let i = 1; i <= 4; i++) { await cam.click(); await page.locator('.chip.shot').nth(Math.min(i, 3) - 1).waitFor({ timeout: 10000 }); await page.waitForTimeout(150); }
    assert.equal(await page.locator('.chip.shot').count(), 3, 'at most 3 screenshots in one message');
    assert.match(await page.locator('.chip.shot .ctime').first().innerText(), /^\d\d:\d\d:\d\d$/, 'each shot shows when it was taken');
    assert.match(await page.locator('.chip.shot img').first().getAttribute('src'), /^data:image\/png;base64,/);
    await page.locator('.chip.shot button').first().click();
    assert.equal(await page.locator('.chip.shot').count(), 2, '× removes one');
    await shot(page, `chips-${name}`);
    await page.fill('#box', 'what do you see?');
    await page.click('#send');
    const reply = await page.locator('#log', { hasText: 'ATT[' }).innerText({ timeout: 30000 });
    const sent = /ATT\[([^\]]*)\]/.exec(reply)[1].split(',').filter(Boolean);
    assert.equal(sent.length, 2, `both screenshots went with the message: ${reply}`);
    for (const f of sent) {
      assert.match(f, /screen-home-.*\.png$/);
      const buf = fs.readFileSync(path.join(root, 'workspace', f));
      assert.equal(buf.subarray(1, 4).toString(), 'PNG', 'the uploaded file is the PNG that was drawn');
    }
    assert.equal(await page.locator('.chip.shot').count(), 0, 'the draft is cleared after sending');
    assert.deepEqual(errs, []);
    await shot(page, `sent-${name}`);
    await ctx.close();
  });
}
const shot = async (page, n) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `shellcam-${n}-${ENGINE}.png`) }); };
