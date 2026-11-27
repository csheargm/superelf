// 回去的路不能丢 · The way back to an app's chat and its Undo is never lost (R6), demo mode, a real browser.
// Self-test 2026-11-25 (try.superelf.app, Calendar Planner): the model's rewrite re-rendered document.body,
// which removed the Ask AI button, so the guest could not reopen the app's chat to undo. Now (1) a page
// that wipes the whole page is refused and rolled back with an honest reply (lib/app-postcheck.mjs
// pageWipeProblems), and (2) the shell's own ⋯ always offers 改这个应用 · Change this app and, while a
// change can be undone, 撤销上次修改 · Undo last change (web/app-edit.js). Real web.mjs + a FAKE Ollama.
// PA_E2E_ENGINE=webkit runs it in Safari's engine. PA_SHOTS=<dir> saves pictures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, waitFor } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { PLAN_MARKER } from '../lib/app-edit-confirm.mjs';
import { ensureAskAi } from '../lib/demo-askai.mjs';
import { withOwnPolicy } from '../lib/demo-app.mjs';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = process.env.PA_SHOTS || '';
const ENGINE = process.env.PA_E2E_ENGINE || 'chromium';
const MODELS = [{ id: 'smart', label: 'Smart · 智能', provider: 'ollama', model: 'fake-smart' }];
const DEMO = { enabled: true, auth: { required: false }, ai_calls_per_user_per_day: 80, ai_calls_per_ip_per_day: 800, new_users_per_ip_per_day: 50, app_builds_per_user_per_day: 20, user_disk_mb: 20, total_disk_gb: 5 };
const SLUG = 'calendar-planner';
const PAGE = '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1 style="margin:48px 0 0">Calendar Planner</h1><div id="cal">May</div></body></html>';
const SWITCHER = '<nav id="views"><button>Day</button><button>Week</button><button>Month</button><button>Year</button></nav>';
// The self-test's fault: the new page draws itself over the whole body, Ask AI included.
const WIPER = PAGE.replace('</body>', '<script>document.body.innerHTML = \'<div id="cal">Year</div>\';</script></body>');

const fence = (html) => `\`\`\`html\n${html}\n\`\`\`\n\n\`\`\`json\n{"title":"Calendar Planner"}\n\`\`\``;
function startOllamaStub() {
  return new Promise((r) => { const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }).on('end', () => {
      const msgs = JSON.parse(b).messages;
      const apply = msgs.find((m) => m.role === 'user' && String(m.content).startsWith('Change this app:'));
      const text = apply ? (/redraw/.test(apply.content) ? `I redrew the page with a Year view.\n\n${fence(WIPER)}` : `I added a Day / Week / Month / Year switcher.\n\n${fence(PAGE.replace('<div id="cal">', SWITCHER + '<div id="cal">'))}`)
        : /redraw/.test(msgs[msgs.length - 1].content) ? `I will redraw the page with a Year view.\n${PLAN_MARKER}` : `I will add a Day / Week / Month / Year switcher above the calendar.\n${PLAN_MARKER}`;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(JSON.stringify({ message: { role: 'assistant', content: text }, done: true }) + '\n');
    }); }); srv.listen(0, '127.0.0.1', () => r(srv)); });
}

let ollama, web, root, port, browser;
before(async () => {
  if (skip) return;
  ollama = await startOllamaStub(); port = await freePort();
  root = mkWebRoot({ port, extraConfig: { ollama_url: `http://127.0.0.1:${ollama.address().port}`, chat_models: MODELS, users: [], demo: DEMO } });
  fs.cpSync(path.join(REPO, 'workspace.example'), path.join(root, 'workspace.example'), { recursive: true });
  const app = path.join(root, 'workspace.example', 'apps', SLUG); fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), withOwnPolicy(ensureAskAi(PAGE, 'Calendar Planner')));
  fs.writeFileSync(path.join(app, 'meta.json'), '{"title":"Calendar Planner","icon":"📅"}');
  // An app written before this check, whose script re-renders the whole body after load.
  const old = path.join(root, 'workspace.example', 'apps', 'wiper'); fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'index.html'), withOwnPolicy(ensureAskAi(WIPER.replace("document.body.innerHTML", "addEventListener('load',()=>{document.body.innerHTML").replace("</div>';", "</div>';});"), 'Wiper')));
  fs.writeFileSync(path.join(old, 'meta.json'), '{"title":"Wiper","icon":"🧹"}');
  web = startWeb(root); await waitReady(port); browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (ollama) ollama.close(); if (root) rmTemp(root); });

const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${ENGINE}-${name}`) }); } };
async function openCalendar(page) {
  await page.goto(`http://127.0.0.1:${port}/`);
  await waitFor(() => page.evaluate(() => typeof openApp === 'function' && typeof UID === 'string' && !!UID && !!ROLE).catch(() => false /* mid-navigation */), 'the guest session');
  await page.evaluate((s) => openApp(UID, s, 'Calendar Planner'), SLUG);
  const fr = page.frameLocator('#fr');
  await fr.locator('#cal').waitFor();
  return fr;
}
const inp = (fr) => fr.locator('.pac-inp').last();
async function say(fr, text) { await inp(fr).fill(text); await fr.locator('.pac-go').last().click(); }
// Ask for a change, then tap the NEW 改 · Apply (an earlier plan's button stays in the log, spent).
async function askAndApply(fr, text) {
  const before = await fr.locator('button.pac-confirm').count();
  await say(fr, text);
  await waitFor(async () => (await fr.locator('button.pac-confirm').count()) > before, 'the plan and its Apply button');
  await fr.locator('button.pac-confirm').nth(before).click();
}
async function menu(page) { await page.evaluate(() => barShow()); await page.locator('#fmore').click(); await page.locator('#frameMenu').waitFor(); }

for (const [name, viewport] of [['desktop', { width: 1280, height: 800 }], ['iphone', { width: 390, height: 844 }]]) {
  test(`${name}: a page that wipes Ask AI is refused + rolled back, honestly; the shell ⋯ always opens the chat and Undo`, { skip, timeout: 120000 }, async () => {
    const page = await browser.newPage({ viewport });
    try {
      let fr = await openCalendar(page);
      // the shell's ⋯ offers the app chat on the demo; nothing to undo yet, so no Undo item
      await menu(page);
      assert.equal(await page.locator('#aeItem').count(), 1, 'Change this app in the shell menu');
      assert.equal(await page.locator('#aeUndoItem').count(), 0, 'no Undo item before any change');
      assert.equal(await page.locator('#pubItem').count(), 0, 'no Publish on the demo');
      await page.locator('#aeItem').click();
      const pf = page.frameLocator('#aefr');
      await inp(pf).waitFor();
      // the bad rewrite, asked from the SHELL's panel: plan → 改 · Apply → refused, rolled back, said
      await askAndApply(pf, 'redraw it as a year view');
      await pf.getByText(/did not return a working page|not applied/).first().waitFor({ timeout: 30000 }).catch(async (e) => { console.log('PANEL', await pf.locator('body').innerText()); throw e; });
      const log = await pf.locator('body').innerText();
      assert.match(log, /removes the Ask AI button/, 'the reply names why');
      assert.doesNotMatch(log, /I redrew the page|Undone|已完成/, 'no claim of a change that was rolled back');
      await shot(page, `${name}-1-refused.png`);
      fr = page.frameLocator('#fr');
      assert.equal(await fr.locator('#cal').innerText(), 'May', 'the app is as it was');
      assert.equal(await fr.locator('#pa-askai').count(), 1, 'Ask AI is still there');
      // a good change, then Undo from the shell's ⋯ (no panel, no app page involved)
      await askAndApply(pf, 'add a day week month year switcher');
      await page.frameLocator('#fr').locator('#views').waitFor({ timeout: 30000 });
      await page.locator('#aeClose').click();
      await menu(page);
      await page.locator('#aeUndoItem').waitFor();
      await shot(page, `${name}-2-menu-undo.png`);
      await page.locator('#aeUndoItem').click();
      await page.locator('#aeSay').getByText(/已撤销/).waitFor({ timeout: 20000 });
      await waitFor(async () => (await page.frameLocator('#fr').locator('#views').count().catch(() => 1)) === 0, 'the app back to before');
      assert.equal(await page.frameLocator('#fr').locator('#cal').innerText(), 'May');
      await shot(page, `${name}-3-undone.png`);
      await menu(page);
      assert.equal(await page.locator('#aeUndoItem').count(), 0, 'nothing left to undo: no Undo item');
    } finally { await page.close(); }
  });
}

test('a page with the current mount that re-renders document.body still keeps its Ask AI button, and it opens the chat', { skip, timeout: 60000 }, async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await openCalendar(page);
    await page.evaluate(() => openApp(UID, 'wiper', 'Wiper'));
    const fr = page.frameLocator('#fr');
    await fr.locator('#cal').getByText('Year').waitFor();
    await fr.locator('#pa-askai').click();
    await fr.locator('.pac-fs.on .pac-inp').waitFor();
    await shot(page, 'wiper-askai-kept.png');
  } finally { await page.close(); }
});
