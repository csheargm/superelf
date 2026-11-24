// 改这个应用 · Change this app in a real browser (ADR 0040 Phase 1, R6). The owner opens an app,
// long-presses its title: the panel docks beside it (a bottom sheet on a phone) with a picture of
// the app attached (Chromium; WebKit may fail closed and ask for a photo — either is said), asks for
// a change, the app reloads in place showing it, 撤销 · Undo puts it back; a change that breaks the
// app is not applied. A FAKE `claude` edits the app file. Runs in Chromium, and in WebKit with
// PA_E2E_ENGINE=webkit. Without Playwright it FAILS unless PA_E2E_SKIP=1. PA_SHOTS=<dir> saves pictures.
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
const PAGE = '<!doctype html><html><head><meta charset="utf-8"></head><body><h1 id="t">Todo</h1><canvas id="ink" width="80" height="40"></canvas>'
  + '<script>const g=document.getElementById("ink").getContext("2d");g.fillRect(0,0,40,40);</script></body></html>';
// The fake agent: reads the CURRENT message (after any history block) and edits apps/todo/index.html.
const FAKE = `#!/usr/bin/env node
let s = ''; process.stdin.on('data', (d) => s += d).on('end', async () => {
  const fs = await import('node:fs');
  const cur = s.split('[Current message:]').pop();
  const f = 'apps/todo/index.html';
  let say = 'nothing to do';
  if (/make it red/.test(cur)) { fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('<h1 id="t">', '<h1 id="t" style="color:rgb(200, 0, 0)">')); say = 'Made the title red.'; }
  if (/break it/.test(cur)) { fs.writeFileSync(f, '<html><body><h1 id="t">broken</h1><script>let = ;</script></body></html>'); say = 'Rewrote it.'; }
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-e' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: say, session_id: 'sid-e' }) + '\\n');
});
`;

let port, root, web, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') },
    { id: 'kid', name: 'Kid', role: 'member', token: 'kid-token-abcdefghijkl', workspace: 'ws-kid' }] } });
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  const cfgPath = path.join(root, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.claude_cmd = writeFakeCli(bin, 'claude', FAKE);
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const app = path.join(root, 'workspace', 'apps', 'todo'); fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), PAGE);
  fs.writeFileSync(path.join(app, 'meta.json'), JSON.stringify({ title: 'Todo' }));
  fs.mkdirSync(path.join(root, 'ws-kid', 'apps', 'todo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'ws-kid', 'apps', 'todo', 'index.html'), PAGE);
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}-${ENGINE}.png`) }); };
async function signIn(viewport) {
  const ctx = await browser.newContext({ viewport }); const page = await ctx.newPage();
  if (process.env.DBG) { page.on('console', (m) => console.log('PAGE', m.type(), m.text())); page.on('pageerror', (e) => console.log('PAGEERR', e.message)); }
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
  await page.waitForFunction(() => !document.querySelector('#login[open]'));
  await page.click('.ecard[data-es="todo"]');
  await page.frameLocator('#fr').locator('#t').waitFor();
  return { ctx, page };
}
async function showBar(page) {
  const onScreen = () => page.evaluate(() => document.querySelector('#ftitle').getBoundingClientRect().top >= 0);
  if (await onScreen()) return;
  await page.click('#barpeek');   // the shell's bar slides away over an app; its top handle brings it back
  await page.waitForFunction(() => document.querySelector('#ftitle').getBoundingClientRect().top >= 0);
}
async function longPressTitle(page) {
  await showBar(page);
  const b = await page.locator('#ftitle').boundingBox();
  await page.mouse.move(b.x + 10, b.y + b.height / 2); await page.mouse.down(); await page.waitForTimeout(900); await page.mouse.up();
  if (process.env.DBG) console.log('DBG', await page.evaluate(() => ({ role: ROLE, uid: UID, open: frameOpen(), fu: frameUid(), fs: frameSlug(), ref: frameRef(), bar: getComputedStyle(document.querySelector('#frame .bar')).display, ft: document.querySelector('#ftitle').getBoundingClientRect().toJSON() })));
  await page.locator('#aePanel').waitFor();
}
const titleColor = (page) => page.frameLocator('#fr').locator('#t').evaluate((e) => getComputedStyle(e).color);
async function sendInPanel(page, text) {
  const p = page.frameLocator('#aefr');
  await p.locator('.pac-inp').fill(text); await p.locator('.pac-go').click();
}

test('long-press the title → panel docks beside the app with its picture; a change reloads the app; Undo restores it', { skip, timeout: 90000 }, async () => {
  const { ctx, page } = await signIn({ width: 1280, height: 800 });
  await longPressTitle(page);
  assert.equal(await page.locator('#aePanel').getAttribute('class'), 'side');
  const fr = await page.locator('#frame').boundingBox(), pn = await page.locator('#aePanel').boundingBox();
  assert.ok(fr.x + fr.width <= pn.x + 1, `the app shrinks beside the panel: frame ends ${fr.x + fr.width}, panel starts ${pn.x}`);
  const p = page.frameLocator('#aefr');
  await p.locator('.pac-inp').waitFor();
  // Either the picture is attached, or the panel says it could not take one (fail closed) — never neither.
  const chip = p.locator('.pac-chip img'), none = p.locator('#noShot');
  await Promise.race([chip.waitFor({ timeout: 10000 }), none.waitFor({ timeout: 10000 })]);
  const gotShot = await chip.count() > 0;
  if (ENGINE === 'chromium') assert.ok(gotShot, 'Chromium draws the app: the picture is attached');
  if (gotShot) assert.match(await chip.getAttribute('src'), /^data:image\/png;base64,/);
  if (gotShot && SHOTS) fs.writeFileSync(path.join(SHOTS, `cta-snap-${ENGINE}.png`), Buffer.from((await chip.getAttribute('src')).split(',')[1], 'base64'));   // the picture the agent gets
  await shot(page, 'cta-panel-desktop');
  await sendInPanel(page, 'make it red');
  await page.locator('#aeUndo').waitFor({ state: 'visible', timeout: 20000 });
  await page.frameLocator('#fr').locator('#t').waitFor();
  for (let i = 0; i < 50 && (await titleColor(page)) !== 'rgb(200, 0, 0)'; i++) await page.waitForTimeout(200);
  assert.equal(await titleColor(page), 'rgb(200, 0, 0)', 'the app reloaded in place with the change');
  assert.ok(await page.locator('#aePanel').isVisible(), 'the panel stays open beside it');
  await shot(page, 'cta-after-change');
  await page.click('#aeUndo');
  for (let i = 0; i < 50 && (await titleColor(page)) === 'rgb(200, 0, 0)'; i++) await page.waitForTimeout(200);
  assert.notEqual(await titleColor(page), 'rgb(200, 0, 0)', 'undo put the old app back');
  await p.locator('text=已撤销').waitFor();
  // A change that breaks the app is not applied, and the reply says so.
  await sendInPanel(page, 'break it');
  await p.locator('text=未应用').first().waitFor({ timeout: 20000 });
  assert.equal(fs.readFileSync(path.join(root, 'workspace', 'apps', 'todo', 'index.html'), 'utf8'), PAGE, 'the broken page was rolled back');
  await shot(page, 'cta-not-applied');
  // The panel's conversation is its own surface: not in the composer's drawer.
  const convos = await page.evaluate(async () => (await api('/api/convos')).json());
  assert.equal(convos.length, 0, 'edit conversations stay out of the main chat list');
  await page.click('#aeClose');
  assert.equal(await page.locator('#aePanel').count(), 0);
  await ctx.close();
});

test('⋯ on the open app lists 改这个应用 first with a one-time tip; phone gets a bottom sheet', { skip, timeout: 60000 }, async () => {
  const { ctx, page } = await signIn({ width: 390, height: 844 });
  await showBar(page);
  await page.click('#fmore');
  const first = page.locator('#frameMenu button').first();
  assert.match(await first.textContent(), /^改这个应用 · Change this app/);
  assert.match(await first.textContent(), /长按标题可修改此应用/, 'the tip shows the first time');
  await shot(page, 'cta-menu-phone');
  await first.click();
  await page.locator('#aePanel').waitFor();
  assert.equal(await page.locator('#aePanel').getAttribute('class'), 'sheet');
  const fr = await page.locator('#frame').boundingBox(), pn = await page.locator('#aePanel').boundingBox();
  assert.ok(fr.y + fr.height <= pn.y + 1, 'the app sits above the sheet');
  await page.frameLocator('#aefr').locator('.pac-inp').waitFor();
  await shot(page, 'cta-sheet-phone');
  await page.click('#aeClose');
  await showBar(page);
  await page.click('#fmore');
  assert.doesNotMatch(await page.locator('#frameMenu button').first().textContent(), /长按标题/, 'the tip is shown once');
  await ctx.close();
});

test('the server refuses an edit turn from a member, from an app, and for an app that is not theirs', { skip: false }, async () => {
  const post = (token, body, extra = {}) => fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify(body) });
  assert.equal((await post('kid-token-abcdefghijkl', { message: 'make it red', edit: 'todo' })).status, 403, 'members: Phase 2');
  assert.equal((await post(OWNER_TOKEN, { message: 'make it red', edit: 'todo' }, { 'x-superelf-origin': 'app' })).status, 403, 'never from an app');
  assert.equal((await post(OWNER_TOKEN, { message: 'make it red', edit: 'nope' })).status, 404);
  const u = await fetch(`http://127.0.0.1:${port}/api/apps/todo/undo`, { method: 'POST', headers: { authorization: 'Bearer kid-token-abcdefghijkl' } });
  assert.equal(u.status, 403);
  const pnl = await fetch(`http://127.0.0.1:${port}/api/app-edit/panel`, { headers: { authorization: 'Bearer kid-token-abcdefghijkl' } });
  assert.equal(pnl.status, 403);
  assert.match(fs.readFileSync(path.join(root, 'ws-kid', 'apps', 'todo', 'index.html'), 'utf8'), /<h1 id="t">/, "the member's app is untouched");
});
