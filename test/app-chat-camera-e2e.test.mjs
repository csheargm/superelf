// 应用对话一键截图 · One-tap screenshot in the app chat, in a real browser (R6). The owner opens the app chat
// beside an app: a camera button sits beside ＋ with its one-time tip; a tap attaches a fresh, time-labelled
// picture (at most 3 of ours per message); a picture taken before the app reloaded (Undo) is retaken when the
// message is sent, never sent stale; an app that cannot be drawn says so plainly and points at ＋.
// A FAKE `claude` (the real CLI's permission model) lists the files a message carries. Chromium, and WebKit
// with PA_E2E_ENGINE=webkit. Without Playwright it FAILS unless PA_E2E_SKIP=1. PA_SHOTS=<dir> saves pictures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { FAKE_PERMS_SRC } from './helpers-fake-claude-perms.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';

const SHOTS = process.env.PA_SHOTS || '';
const ENGINE = process.env.PA_E2E_ENGINE || 'chromium';
const PAGE = '<!doctype html><html><head><meta charset="utf-8"></head><body><!-- a comment -- with a double hyphen --><h1 id="t">Todo</h1></body></html>';
const BLANK = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';   // nothing to draw: PASnap fails closed
const FAKE = `#!/usr/bin/env node
${FAKE_PERMS_SRC}
let s = ''; process.stdin.on('data', (d) => s += d).on('end', async () => {
  const argv = process.argv.slice(2), sys = argv.join(' '), p = perms(argv);
  const cur = s.split('[Current message:]').pop();
  let say = 'nothing to do';
  if (/what is attached/.test(cur)) say = 'ATT[' + [...cur.matchAll(/saved to workspace\\/(\\S+?)\\. Use/g)].map((m) => m[1]).join(',') + ']';
  else if (/READ-ONLY/.test(sys) && /make it red/.test(cur)) say = 'I will make it red — the title only.\\n[[apply]]';
  else if (/do it now\\):\\s*I will make it red/.test(sys)) { const page = p.read('index.html'); say = page !== null && p.write('index.html', page.replace('<h1 id="t">', '<h1 id="t" style="color:rgb(200, 0, 0)">')) ? 'Made the title red.' : 'could not'; }
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-c' }) + '\\n');
  p.text(say);
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: say, session_id: 'sid-c' }) + '\\n');
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
  for (const [slug, html] of [['todo', PAGE], ['blank', BLANK]]) {
    const app = path.join(root, 'workspace', 'apps', slug); fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'index.html'), html);
    fs.writeFileSync(path.join(app, 'meta.json'), JSON.stringify({ title: slug }));
  }
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}-${ENGINE}.png`) }); };
async function signIn() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } }); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
  return { ctx, page };
}
// The panel, opened the way the ⋯ item opens it (the long-press and the menu are covered by app-edit-e2e).
async function openChat(page, slug) {
  await page.evaluate((s) => openApp(UID, s, s), slug);
  await page.waitForFunction(() => frameSlug() && document.querySelector('#fr').contentDocument === null);
  await page.waitForTimeout(800);
  await page.evaluate(() => PAAppEdit.editAppFromBar());
  await page.locator('#aePanel').waitFor({ timeout: 15000 });
  const p = page.frameLocator('#aefr'); await p.locator('.pac-inp').waitFor();
  return p;
}
const names = (p) => p.locator('.pac-chip img').count();
async function ask(p, text) { await p.locator('.pac-inp').fill(text); await p.locator('.pac-go').click(); }

test('camera beside ＋: tip once, a fresh labelled shot per tap (max 3), a stale shot retaken on send after Undo', { skip, timeout: 120000 }, async () => {
  const { ctx, page } = await signIn();
  const p = await openChat(page, 'todo');
  const cam = p.locator('#aeCam');
  await cam.waitFor();
  assert.equal(await cam.getAttribute('aria-label'), '截取当前画面 · Capture the app as it looks now');
  const plusBox = await p.locator('.pac-plus').boundingBox(), camBox = await cam.boundingBox();
  assert.ok(Math.abs(camBox.y - plusBox.y) < 4 && camBox.x > plusBox.x && camBox.x - plusBox.x < 60, 'the camera sits right beside ＋');
  await p.locator('#aeCamTip').waitFor();
  await p.locator('.pac-chip img').first().waitFor({ timeout: 10000 });   // the auto-shot (Chromium and WebKit draw this page)
  assert.match(await p.locator('.pac-chip .pac-ctime').first().innerText(), /^\d\d:\d\d:\d\d$/, 'every shot shows when it was taken');
  await shot(page, 'cam-open');
  for (let i = 2; i <= 4; i++) { await cam.click(); await p.locator('.pac-chip img').nth(Math.min(i, 3) - 1).waitFor(); await page.waitForTimeout(300); }
  assert.equal(await names(p), 3, 'at most 3 screenshots in one message');
  await shot(page, 'cam-three');
  // The change, then Undo: the app reloads twice; a shot taken in between is stale by the send.
  await ask(p, 'make it red');
  await p.locator('.pac-change-app', { hasText: '改 · Apply' }).waitFor({ timeout: 20000 });
  await p.locator('.pac-change-app', { hasText: '改 · Apply' }).click();
  await p.locator('text=已完成 · Done').waitFor({ timeout: 20000 });
  await cam.click(); await p.locator('.pac-chip img').first().waitFor();
  await page.click('#aeUndo');
  await p.locator('text=已撤销').first().waitFor({ timeout: 20000 });
  await page.frameLocator('#fr').locator('#t').waitFor();
  await ask(p, 'what is attached');
  await p.locator('text=应用已变，已重新截图 · The app changed, so the screenshot was retaken').waitFor({ timeout: 15000 });
  const reply = await p.locator('.pac-m.ai', { hasText: 'ATT[' }).last().innerText({ timeout: 20000 });
  const sent = /ATT\[([^\]]*)\]/.exec(reply)[1].split(',').filter(Boolean);
  assert.equal(sent.length, 1, `one retaken screenshot went with the message: ${reply}`);
  const ups = fs.readdirSync(path.join(root, 'workspace', path.dirname(sent[0])));
  assert.ok(ups.length >= 6, 'every tap and the retake uploaded a new file');
  await shot(page, 'cam-retaken');
  kept = { ctx, page };   // the same device for the next test: the tip is remembered per device
});
let kept = null;

test('an app that cannot be drawn: the camera says so plainly and points at ＋; the tip shows only once', { skip, timeout: 60000 }, async () => {
  const { ctx, page } = kept || await signIn();
  await page.evaluate(() => PAAppEdit.close());
  const p = await openChat(page, 'blank');
  await p.locator('#noShot').waitFor({ timeout: 10000 });
  assert.equal(await p.locator('#aeCamTip').count(), 0, 'the camera tip was shown once already on this device (the first test)');
  await p.locator('#aeCam').click();
  await p.locator('text=这个应用的画面截不下来，请用 ＋ 添加照片或截屏').waitFor({ timeout: 10000 });
  assert.equal(await names(p), 0, 'nothing attached on a failure');
  await shot(page, 'cam-fail');
  await ctx.close();
});
