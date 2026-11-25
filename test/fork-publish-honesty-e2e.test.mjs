// Owner report 2026-11-25 (School Helper, iPhone), in a real browser (R6). A copied app's ⋯ menus offer no Publish,
// only a line saying why; a real app's publish sheet sits below the app header; the app's own chat's
// 改这个应用 · Change this app button is there after the reply AND after the chat is reopened, and opens the panel.
// Phone (390x844) and iPad (820x1180). PA_E2E_ENGINE=webkit runs it in Safari's engine.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { ensureAskAi } from '../lib/demo-askai.mjs';
import { CHANGE_APP_LABEL } from '../lib/app-chat-honesty.mjs';

const ASK = 'can you change the app?';
const page0 = (t) => ensureAskAi(`<!doctype html><html><head><meta charset="utf-8"></head><body><h1 id="t">${t}</h1></body></html>`, t);
// The fast lane's model answers as the owner's DeepSeek did: it names the button.
function startOllamaStub() {
  const srv = http.createServer((req, res) => { req.on('data', () => {}).on('end', () => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(JSON.stringify({ message: { role: 'assistant', content: `This chat can't change the app. Tap ${CHANGE_APP_LABEL} below this reply.` }, done: true }) + '\n');
  }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}
let port, root, web, browser, ollama;
before(async () => {
  ollama = await startOllamaStub(); port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, ollama_url: `http://127.0.0.1:${ollama.address().port}`, users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  for (const [slug, meta] of [['school', { title: 'School Helper', forkedFrom: 'school-src' }], ['mine', { title: 'Mine' }]]) {
    const d = path.join(root, 'workspace', 'apps', slug); fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'index.html'), page0(meta.title)); fs.writeFileSync(path.join(d, 'meta.json'), JSON.stringify(meta));
  }
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); if (ollama) ollama.close(); });

async function signIn(vp) {
  const ctx = await browser.newContext({ viewport: vp }); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`); await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
  return { ctx, page };
}
async function openApp(page, slug) { await page.click(`.ecard[data-es="${slug}"]`); await page.frameLocator('#fr').locator('#t').waitFor(); }
async function openMore(page) {
  for (let i = 0; i < 3; i++) {
    if (!(await page.evaluate(() => document.querySelector('#ftitle').getBoundingClientRect().top >= 0))) await page.click('#barpeek');
    try { await page.click('#fmore', { timeout: 5000 }); return; } catch { /* the bar slid away: again */ }
  }
}
for (const [name, vp] of [['phone', { width: 390, height: 844 }], ['iPad', { width: 820, height: 1180 }]]) {
  test(`${name}: a copy offers no Publish; a real app's sheet stays below the app header`, { skip, timeout: 90000 }, async () => {
    const { ctx, page } = await signIn(vp);
    await openApp(page, 'school'); await openMore(page);
    await page.locator('#frameMenu').waitFor();
    assert.equal(await page.locator('#frameMenu #pubItem').count(), 0, 'no Publish on a copy');
    assert.match(await page.locator('#frameMenu #pubFork').textContent(), /^复制来的应用不能发布.*original author/);
    await page.keyboard.press('Escape'); await page.mouse.click(5, vp.height - 5);
    await page.evaluate(() => document.querySelector('#back').click());   // Home (the bar may have slid away)
    await openApp(page, 'mine'); await openMore(page);
    await page.click('#frameMenu #pubItem');
    const sheet = page.locator('#pubSheet'); await sheet.waitFor({ timeout: 15000 });
    const [s, bar] = await page.evaluate(() => [document.querySelector('#pubSheet').getBoundingClientRect().top, document.querySelector('#frame .bar').getBoundingClientRect().bottom]);
    assert.ok(s >= bar + 40, `sheet top ${s} leaves the header (bottom ${bar}) and a chip row visible`);
    if (process.env.PA_SHOTS) await page.screenshot({ path: path.join(process.env.PA_SHOTS, `pub-sheet-${name}.png`) });
    await ctx.close();
  });
  test(`${name}: the app chat's Change this app button is real, also after reopening`, { skip, timeout: 90000 }, async () => {
    const { ctx, page } = await signIn(vp);
    await openApp(page, 'school');
    const app = page.frameLocator('#fr');
    await app.locator('#pa-askai').click();
    await app.locator('.pac-fs.on .pac-inp').fill(ASK); await app.locator('.pac-fs.on .pac-go').click();
    await app.locator('.pac-change-app').waitFor({ timeout: 20000 });
    await page.reload(); await page.waitForFunction(() => !document.querySelector('#login[open]'));
    await openApp(page, 'school');
    await app.locator('#pa-askai').click();
    const btn = app.locator('.pac-change-app');
    await btn.first().waitFor({ timeout: 20000 });
    if (process.env.PA_SHOTS) await page.screenshot({ path: path.join(process.env.PA_SHOTS, `chat-button-reopened-${name}.png`) });
    await btn.first().click();
    await page.locator('#aePanel').waitFor({ timeout: 20000 });
    await ctx.close();
  });
}
