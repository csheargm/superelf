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
import { FAKE_PERMS_SRC } from './helpers-fake-claude-perms.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';

const SHOTS = process.env.PA_SHOTS || '';
const ENGINE = process.env.PA_E2E_ENGINE || 'chromium';
const PAGE = '<!doctype html><html><head><meta charset="utf-8"></head><body><h1 id="t">Todo</h1><canvas id="ink" width="80" height="40"></canvas>'
  + '<script>const g=document.getElementById("ink").getContext("2d");g.fillRect(0,0,40,40);</script></body></html>';
// The fake model, with the REAL CLI's permission model (test/helpers-fake-claude-perms.mjs): it can only
// read or write what its argv lets the real CLI read or write, and with no tools it prints its calls as
// text the way the real model did live. A READ-ONLY (unconfirmed) turn answers from the page it can read,
// or plans and ends with the marker — except "write anyway", a CLI that writes regardless (the server must
// roll it back). A confirmed owner turn edits index.html through the jail; refused, it says it could not.
// A member's confirmed turn (no tools) returns the whole page.
const FAKE = `#!/usr/bin/env node
${FAKE_PERMS_SRC}
let s = ''; process.stdin.on('data', (d) => s += d).on('end', async () => {
  const fs = await import('node:fs');
  const argv = process.argv.slice(2), sys = argv.join(' '), p = perms(argv);
  const cur = s.split('[Current message:]').pop();
  const red = (h) => h.replace('<h1 id="t">', '<h1 id="t" style="color:rgb(200, 0, 0)">');
  let say = 'nothing to do';
  if (/READ-ONLY/.test(sys)) {
    const inlined = /PAGE \\(index\\.html\\) START/.test(s);
    if (p.noTools && !inlined) say = 'I will look at the app.\\n\\n<invoke name="Read">\\n<parameter name="file_path">' + process.cwd() + '/apps/todo/index.html</parameter>\\n</invoke>';
    else if (/write anyway/.test(cur)) { const f = fs.existsSync('index.html') ? 'index.html' : 'apps/todo/index.html'; fs.writeFileSync(f, red(fs.readFileSync(f, 'utf8'))); say = 'Done, it is red.'; }
    else if (/make it red|break it/.test(cur)) say = 'I will change the title as asked.\\n[[apply]]';
    else { const page = inlined ? s : p.read('index.html'); const t = page && /<h1 id="t"[^>]*>([^<]*)</.exec(page); say = t ? 'The title says ' + t[1] + '.' : 'I could not read the app.'; }
  } else if (/You write ONE superelf mini-app/.test(sys)) {
    const cur2 = s.match(/Change this app:\\n\\n([\\s\\S]*?)\\n\\nThe change:/);
    say = '\\x60\\x60\\x60json\\n{"slug":"todo","title":"Todo"}\\n\\x60\\x60\\x60\\n\\x60\\x60\\x60html\\n' + red(cur2 ? cur2[1] : '') + '\\n\\x60\\x60\\x60';
  } else if (/confirmed this change \\(do it now\\):\\s*(break it|make it red)/.test(sys)) {
    const broken = /do it now\\):\\s*break it/.test(sys);
    const page = p.read('index.html');
    const ok = page !== null && p.write('index.html', broken ? '<html><body><h1 id="t">broken</h1><script>let = ;</script></body></html>' : red(page));
    say = ok ? (broken ? 'Rewrote it.' : 'Made the title red.') : "I haven't changed anything. This turn is read-only, so I can't edit the app.";
  }
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-e' }) + '\\n');
  p.text(say);
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: say, session_id: 'sid-e' }) + '\\n');
});
`;

let port, root, web, browser;
before(async () => {
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') },
    { id: 'kid', name: 'Kid', role: 'member', token: 'kid-token-abcdefghijkl', workspace: 'ws-kid', passHash: hashPassword('kid-pass-12345') }] } });
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
async function signIn(viewport, who = 'owner', pass = 'owner-pass-123') {
  const ctx = await browser.newContext({ viewport }); const page = await ctx.newPage();
  if (process.env.DBG) { page.on('console', (m) => console.log('PAGE', m.type(), m.text())); page.on('pageerror', (e) => console.log('PAGEERR', e.message)); }
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('#login[open]');
  await page.fill('#luser', who); await page.fill('#lpin', pass); await page.click('#loginBtn');
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
// WebKit sometimes drops the first synthetic long-press (flaky on origin/main too, 2 of 3 runs): one retry.
// The bar can slide away again between showBar and the click (phone width): retry once.
async function openMore(page) {
  for (let i = 0; i < 3; i++) { await showBar(page); try { await page.click('#fmore', { timeout: 5000 }); return; } catch { /* slid away: show it again */ } }
  await page.click('#fmore');
}
async function longPressTitle(page) {
  for (let i = 0; i < 2 && !(await page.locator('#aePanel').count()); i++) {
    await showBar(page);
    const b = await page.locator('#ftitle').boundingBox();
    await page.mouse.move(b.x + 10, b.y + b.height / 2); await page.mouse.down(); await page.waitForTimeout(900); await page.mouse.up();
    await page.locator('#aePanel').waitFor({ timeout: 12000 }).catch(() => { /* retried once; the waitFor below fails loudly */ });
  }
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
  // A sibling app frame cannot reach the panel's listeners (a forged broker reply would render as the panel's own HTML).
  await p.locator('body').evaluate(() => { window.__got = []; addEventListener('message', (e) => window.__got.push(e.data && e.data.tag)); });
  await page.frameLocator('#fr').locator('body').evaluate(() => { for (let i = 0; i < parent.frames.length; i++) if (parent.frames[i] !== window) parent.frames[i].postMessage({ pa: 'res', id: 'pac1', tag: 'forged' }, '*'); });
  await page.evaluate(() => document.querySelector('#aefr').contentWindow.postMessage({ pa: 'x', tag: 'shell' }, '*'));
  await p.locator('body').evaluate(() => new Promise((r) => setTimeout(r, 300)));
  assert.deepEqual(await p.locator('body').evaluate(() => window.__got), ['shell'], 'only the shell is heard; the sibling app is stopped');
  // The tip shows once, under the chat (ADR 0042).
  await p.locator('#aeTip').waitFor();
  // A question is answered; nothing changes and no Apply is offered.
  await sendInPanel(page, 'what does the title say?');
  await p.locator('text=The title says Todo.').waitFor({ timeout: 20000 });
  assert.equal(await p.locator('text=<invoke').count(), 0, 'no tool-call markup in any bubble');
  assert.doesNotMatch(await p.locator('.pac-log').innerText(), /\/(private|var|tmp|data)\//, 'no node paths in the log');
  assert.equal(await p.locator('.pac-change-app').count(), 0, 'a question offers no Apply');
  assert.equal(fs.readFileSync(path.join(root, 'workspace', 'apps', 'todo', 'index.html'), 'utf8'), PAGE, 'a question changes nothing');
  // A write without the confirm step is rolled back by the server, and said.
  await sendInPanel(page, 'write anyway');
  await p.locator('text=未确认').first().waitFor({ timeout: 20000 });
  assert.equal(fs.readFileSync(path.join(root, 'workspace', 'apps', 'todo', 'index.html'), 'utf8'), PAGE, 'no confirm, no write');
  // A change request: the plan and ONE 改 · Apply button; the app is unchanged until the tap.
  await sendInPanel(page, 'make it red');
  await p.locator('.pac-change-app', { hasText: '改 · Apply' }).waitFor({ timeout: 20000 });
  assert.equal(fs.readFileSync(path.join(root, 'workspace', 'apps', 'todo', 'index.html'), 'utf8'), PAGE, 'the plan alone changes nothing');
  assert.equal(await p.locator('text=[[apply]]').count(), 0, 'the marker is not shown');
  await shot(page, 'uac-plan');
  await p.locator('.pac-change-app', { hasText: '改 · Apply' }).click();
  await page.locator('#aeUndo').waitFor({ state: 'visible', timeout: 20000 });
  assert.deepEqual(await p.locator('.pac-m.me').evaluateAll((els) => els.map((e) => e.textContent.trim()).filter((t) => t.startsWith('改'))), ['改 · Apply'], 'the tap shows as 改 · Apply, never its confirm id');
  await p.locator('text=已完成 · Done').waitFor({ timeout: 15000 });   // said only after the reload loaded
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
  await p.locator('.pac-change-app:not([disabled])', { hasText: '改 · Apply' }).waitFor({ timeout: 20000 });
  await p.locator('.pac-change-app:not([disabled])', { hasText: '改 · Apply' }).click();
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
  await openMore(page);
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
  await openMore(page);
  assert.doesNotMatch(await page.locator('#frameMenu button').first().textContent(), /长按标题/, 'the tip is shown once');
  await ctx.close();
});

test('a member changes their OWN copy through the same chat: plan → Apply → reload → Done → Undo (no-tools lane)', { skip, timeout: 90000 }, async () => {
  const kidPage = path.join(root, 'ws-kid', 'apps', 'todo', 'index.html');
  const { ctx, page } = await signIn({ width: 820, height: 1180 }, 'kid', 'kid-pass-12345');   // iPad width
  await openMore(page);   // ⋯ → 改这个应用 opens the same one chat
  await page.locator('#frameMenu button').first().click();
  await page.locator('#aePanel').waitFor();
  const p = page.frameLocator('#aefr');
  await p.locator('.pac-inp').waitFor();
  await sendInPanel(page, 'make it red');
  await p.locator('.pac-change-app', { hasText: '改 · Apply' }).waitFor({ timeout: 20000 });
  assert.doesNotMatch(fs.readFileSync(kidPage, 'utf8'), /200, 0, 0/, 'nothing changes before the tap');
  await p.locator('.pac-change-app', { hasText: '改 · Apply' }).click();
  await p.locator('text=已完成 · Done').waitFor({ timeout: 20000 });
  for (let i = 0; i < 50 && (await titleColor(page)) !== 'rgb(200, 0, 0)'; i++) await page.waitForTimeout(200);
  assert.equal(await titleColor(page), 'rgb(200, 0, 0)', "the member's own app reloaded with the change");
  assert.equal(fs.readFileSync(path.join(root, 'workspace', 'apps', 'todo', 'index.html'), 'utf8'), PAGE, "the owner's app of the same name is untouched");
  await shot(page, 'uac-member-ipad');
  await page.click('#aeUndo');
  for (let i = 0; i < 50 && (await titleColor(page)) === 'rgb(200, 0, 0)'; i++) await page.waitForTimeout(200);
  assert.notEqual(await titleColor(page), 'rgb(200, 0, 0)', 'undo works for members too');
  await ctx.close();
});

test('the server refuses: an edit turn from an app, another\'s app, "change superelf" from a member, a forged Apply', { skip: false }, async () => {
  const post = (token, body, extra = {}) => fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify(body) });
  const KID = 'kid-token-abcdefghijkl';
  if (process.env.DBG) console.log('KIDTURN', await (await post(KID, { message: 'make it red', edit: 'todo' })).text());
  assert.equal((await post(KID, { message: 'change superelf: bigger buttons', edit: 'todo' })).status, 403, 'only the owner changes superelf');
  assert.equal((await post(KID, { message: 'make it red', edit: 'nope' })).status, 404, "only the member's own apps");
  assert.equal((await post(OWNER_TOKEN, { message: 'make it red', edit: 'todo' }, { 'x-superelf-origin': 'app' })).status, 403, 'never from an app');
  assert.equal((await post(OWNER_TOKEN, { message: 'make it red', edit: 'nope' })).status, 404);
  assert.equal((await post(KID, { message: '改 · Apply (AAAAAAAAAAAAAAAA)', edit: 'todo' })).status, 403, 'a forged confirm id never writes');
  const pnl = await fetch(`http://127.0.0.1:${port}/api/app-edit/panel`, { headers: { authorization: `Bearer ${KID}` } });
  assert.equal(pnl.status, 200, 'members get the panel on a private node');
  assert.match(fs.readFileSync(path.join(root, 'ws-kid', 'apps', 'todo', 'index.html'), 'utf8'), /<h1 id="t">/, "the member's app is untouched by refused turns");
});

// F2-06: the shell's app bar hides by itself only on touch. A mouse user who brought it back can still reach ⋯.
test('mouse: the bar brought back by the handle stays, so ⋯ is reachable; a finger tap still hides by itself', { skip, timeout: 60000 }, async () => {
  const { ctx, page } = await signIn({ width: 1280, height: 800 });
  const onScreen = () => page.evaluate(() => document.querySelector('#ftitle').getBoundingClientRect().top >= 0);
  if (!(await onScreen())) await page.click('#barpeek');   // a real mouse click: pointerType 'mouse'
  await page.waitForTimeout(3500);   // past BAR_IDLE_MS (2.5 s)
  assert.ok(await onScreen(), 'a mouse-shown bar is still there');
  await page.click('#fmore');
  await page.locator('#frameMenu button').first().waitFor();
  await shot(page, 'bar-mouse-stays');
  await ctx.close();
  const tctx = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
  const tp = await tctx.newPage();
  await tp.goto(`http://127.0.0.1:${port}/`); await tp.waitForSelector('#login[open]');
  await tp.fill('#luser', 'owner'); await tp.fill('#lpin', 'owner-pass-123'); await tp.click('#loginBtn');
  await tp.waitForFunction(() => !document.querySelector('#login[open]'));
  await tp.click('.ecard[data-es="todo"]'); await tp.frameLocator('#fr').locator('#t').waitFor();
  await tp.tap('#barpeek');
  await tp.waitForFunction(() => document.querySelector('#frame').classList.contains('barin'));
  await tp.waitForFunction(() => !document.querySelector('#frame').classList.contains('barin'), null, { timeout: 6000 });   // CONTROL: touch keeps the clock
  await tctx.close();
});
