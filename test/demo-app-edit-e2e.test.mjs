// 访客在应用对话里改应用 · A demo guest changes their own app from its chat, in a real browser (R6).
// Owner report 2026-11-25 (try.superelf.app, Calendar Planner): "allow day, week, month and year view?" →
// "yes" got a fake "Done", no button, then "ask the main chat"; the chat's own "Chat" header sat under the
// shell bar. Real web.mjs in demo mode + a FAKE Ollama; desktop Chromium, and an iPhone viewport (run the
// file with PA_E2E_ENGINE=webkit for Safari's engine). Without Playwright it FAILS unless PA_E2E_SKIP=1.
// PA_SHOTS=<dir> saves pictures.
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
const MODELS = [{ id: 'smart', label: 'Smart · 智能', provider: 'ollama', model: 'fake-smart' }];
const DEMO = { enabled: true, auth: { required: false }, ai_calls_per_user_per_day: 50, ai_calls_per_ip_per_day: 500, new_users_per_ip_per_day: 50, user_disk_mb: 20, total_disk_gb: 5 };
const SLUG = 'calendar-planner';
const BODY = '<h1 style="margin:48px 0 0">Calendar Planner</h1><div id="cal">May</div>';
const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${BODY}</body></html>`;
const SWITCHER = '<nav id="views"><button>Day</button><button>Week</button><button>Month</button><button>Year</button></nav>';

function startOllamaStub() {
  return new Promise((r) => { const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }).on('end', () => {
      const msgs = JSON.parse(b).messages, apply = msgs.some((m) => m.role === 'user' && String(m.content).startsWith('Change this app:'));
      const text = apply ? `I added a Day / Week / Month / Year switcher.\n\n\`\`\`html\n${PAGE.replace('<div id="cal">', SWITCHER + '<div id="cal">')}\n\`\`\`\n\n\`\`\`json\n{"title":"Calendar Planner"}\n\`\`\``
        : `I will add a Day / Week / Month / Year switcher above the calendar.\n${PLAN_MARKER}`;
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
  web = startWeb(root); await waitReady(port); browser = await chromium.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (ollama) ollama.close(); if (root) rmTemp(root); });

const shot = async (page, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name) }); } };
async function openCalendar(page) {
  await page.goto(`http://127.0.0.1:${port}/`);
  await waitFor(() => page.evaluate(() => typeof openApp === 'function' && typeof UID === 'string' && !!UID).catch(() => false /* mid-navigation */), 'the guest session');
  await page.evaluate((s) => openApp(UID, s, 'Calendar Planner'), SLUG);
  const fr = page.frameLocator('#fr');
  await fr.locator('#cal').waitFor();
  return fr;
}
async function openChat(page, fr) {
  await page.evaluate(() => barShow());   // the bar overlays the app's top (as when the pointer is up there)
  await fr.locator('#pa-askai').click();
  await fr.locator('.pac-fs.on .pac-inp').waitFor();
}
async function say(fr, text) {
  await fr.locator('.pac-fs.on .pac-inp').fill(text);
  await fr.locator('.pac-fs.on .pac-go').click();
}
// The chat's own top row is not under the shell's bar: the point at its centre hits the app frame, not .bar.
async function topRowClear(page) {
  const box = await page.frameLocator('#fr').locator('.pac-fs.on .pac-top').boundingBox();
  const hit = await page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return el && (el.id || el.className || el.tagName); }, [box.x + box.width / 2, box.y + box.height / 2]);
  return { hit, box };
}

for (const [name, viewport] of [['desktop', { width: 1280, height: 800 }], ['iphone', { width: 390, height: 844 }]]) {
  test(`${name}: ask → 改 · Apply → typed yes → the app really has the switcher; the chat header is not under the bar`, { skip, timeout: 90000 }, async () => {
    const page = await browser.newPage({ viewport });
    try {
      const fr = await openCalendar(page);
      await openChat(page, fr);
      await waitFor(async () => !(await page.evaluate(() => document.getElementById('frame').classList.contains('barin'))), 'the bar to leave the chat');
      const top = await topRowClear(page);
      assert.equal(top.hit, 'fr', `the chat's top row is uncovered (hit ${top.hit})`);
      await say(fr, 'can you allow user to select day, week, month and year view?');
      const apply = fr.locator('.pac-fs.on button.pac-confirm');
      await apply.waitFor();
      await shot(page, `${name}-1-plan.png`);
      assert.match(await fr.locator('.pac-fs.on').innerText(), /I will add a Day \/ Week \/ Month \/ Year switcher/);
      assert.doesNotMatch(await fr.locator('.pac-fs.on').innerText(), /main chat|Done —/);
      await say(fr, 'yes');
      await fr.locator('.pac-fs.on').getByText(/撤销|undo/i).first().waitFor({ timeout: 30000 });
      await shot(page, `${name}-2-applied.png`);
      // the shell reloads the app; the new page has the switcher on screen
      const views = page.frameLocator('#fr').locator('#views button');
      await views.first().waitFor({ timeout: 20000 });
      assert.deepEqual(await views.allInnerTexts(), ['Day', 'Week', 'Month', 'Year']);
      const vb = await page.frameLocator('#fr').locator('#views').boundingBox();
      assert.ok(vb && vb.width > 0 && vb.height > 0 && vb.y < viewport.height, 'the switcher is visible');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no sideways scroll');
      await shot(page, `${name}-3-reloaded.png`);
    } finally { await page.close(); }
  });
}
