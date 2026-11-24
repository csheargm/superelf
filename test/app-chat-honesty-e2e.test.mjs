// 应用对话不再假装已修改 · in a real browser (R6). The owner opens an app, taps Ask AI, asks for a feature;
// a FAKE Ollama (the app chat's default fast lane) answers "Done — added …" and writes nothing. The reply
// carries the note and a 改这个应用 · Change this app button; the button opens the panel prefilled
// with the request. Without Playwright it FAILS unless PA_E2E_SKIP=1. PA_SHOTS=<dir> saves pictures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import http from 'node:http';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';
import { ensureAskAi } from '../lib/demo-askai.mjs';
import { NO_CHANGE_NOTE } from '../lib/app-chat-honesty.mjs';

const SHOTS = process.env.PA_SHOTS || '';
const ASK = 'can you allow user to select day, week, month and year view?';
const PAGE = ensureAskAi('<!doctype html><html><head><meta charset="utf-8"></head><body><h1 id="t">Calendar Planner</h1></body></html>', 'Calendar Planner');
// The app chat's default lane is a fast (Ollama) one: a stub that claims a change it never made.
function startOllamaStub() {
  const srv = http.createServer((req, res) => { req.on('data', () => {}).on('end', () => {
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.end(JSON.stringify({ message: { role: 'assistant', content: 'Done — the Calendar Planner now has a Day / Week / Month / Year view switcher.' }, done: true }) + '\n');
  }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

let port, root, web, browser, ollama;
before(async () => {
  ollama = await startOllamaStub();
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, ollama_url: `http://127.0.0.1:${ollama.address().port}`, users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  const app = path.join(root, 'workspace', 'apps', 'planner'); fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), PAGE);
  fs.writeFileSync(path.join(app, 'meta.json'), JSON.stringify({ title: 'Calendar Planner' }));
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); if (ollama) ollama.close(); });

test('app chat says "Done" for a change it cannot make → note + Change this app → panel opens prefilled', { skip, timeout: 90000 }, async () => {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } }); const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
  await page.click('.ecard[data-es="planner"]');
  const app = page.frameLocator('#fr');
  await app.locator('#t').waitFor();
  await app.locator('#pa-askai').click();
  await app.locator('.pac-fs.on .pac-inp').fill(ASK);
  await app.locator('.pac-fs.on .pac-go').click();
  const btn = app.locator('.pac-change-app');
  await btn.waitFor({ timeout: 20000 });
  const reply = await app.locator('.pac-m.ai').last().textContent();
  assert.ok(reply.includes(NO_CHANGE_NOTE.slice(1, -1)), reply);
  assert.equal(fs.readFileSync(path.join(root, 'workspace', 'apps', 'planner', 'index.html'), 'utf8'), PAGE, 'nothing was changed, and nothing claims it was');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'app-chat-note-button.png') });
  await btn.click();
  await page.locator('#aePanel').waitFor({ timeout: 20000 });
  const inp = page.frameLocator('#aefr').locator('.pac-inp');
  await inp.waitFor();
  for (let i = 0; i < 50 && (await inp.inputValue()) !== ASK; i++) await page.waitForTimeout(200);
  assert.equal(await inp.inputValue(), ASK, 'the panel opens with the request ready to send');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'panel-prefilled.png') });
  await ctx.close();
});
