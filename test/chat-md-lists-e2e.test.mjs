// Markdown lists in a real chat（真实聊天里的列表）— the browser half of test/chat-md-lists.test.mjs. A PAChat app
// chat (what Bible's Ask AI is) gets one real-shaped answer (helpers-md-sample.mjs, a fake model) and is measured
// in Chromium desktop 1280x900 and WebKit iPhone 390x844 (touch, DPR 3):
//   · consecutive <li> in the same list sit at most 0.5em apart (the bug: one empty line per bullet);
//   · the answer bubble has no empty <p> and no newline-painted gaps;
//   · on desktop the answer takes the log's full width (the bug: an empty strip right of every answer).
// PA_MDLIST_SHOTS=<dir> also saves a screenshot per browser. Known limits: emulated WebKit, not a real iPhone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { missingReason, resolveSkip } from './helpers-e2e-gate.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { ROMANS } from './helpers-md-sample.mjs';

const pw = await (async () => { try { return process.env.PA_PLAYWRIGHT ? await import(pathToFileURL(process.env.PA_PLAYWRIGHT).href) : await import('playwright'); } catch { return null; } })();
const skip = resolveSkip(await missingReason(pw && pw.chromium)) || resolveSkip(await missingReason(pw && pw.webkit));
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{height:100%;margin:0;overflow:hidden}body{display:flex;flex-direction:column}#chat-host{flex:1;min-height:0;display:flex;flex-direction:column}</style></head>
<body><div id="chat-host"></div><!--PA_CHAT_UI-->
<script>PAChat.mount(document.getElementById('chat-host'),{placeholder:'Ask about this passage…',persist:'mdl'});</script></body></html>`;
const MAX_GAP_EM = 0.5, FULL_WIDTH = 0.9;
const RUNS = [
  { name: 'chromium-desktop', browser: 'chromium', ctx: { viewport: { width: 1280, height: 900 } }, wide: true },
  { name: 'webkit-iphone', browser: 'webkit', ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, wide: false },
];

let port, root, web, model; const browsers = {};
before(async () => {
  model = http.createServer((q, s) => { q.on('data', () => {}).on('end', () => { s.writeHead(200, { 'content-type': 'application/x-ndjson' });
    s.end(JSON.stringify({ message: { role: 'assistant', content: ROMANS }, done: true }) + '\n'); }); });
  await new Promise((r) => model.listen(0, '127.0.0.1', r));
  port = await freePort(); root = mkWebRoot({ port, extraConfig: { ollama_url: `http://127.0.0.1:${model.address().port}` } });
  const app = path.join(root, 'workspace/apps/mdl'); fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), PAGE); fs.writeFileSync(path.join(app, 'meta.json'), JSON.stringify({ title: 'MD Lists' }));
  web = startWeb(root); await waitReady(port);
  if (!skip) for (const b of ['chromium', 'webkit']) browsers[b] = await pw[b].launch();
});
after(async () => { for (const b of Object.values(browsers)) await b.close(); if (web) await stopWeb(web); if (root) rmTemp(root); if (model) model.close(); });

function measure() {
  const b = [...document.querySelectorAll('.pac-m.ai')].filter((e) => e.querySelector('li')).pop(), log = document.querySelector('.pac-log');
  const fs = parseFloat(getComputedStyle(b).fontSize), gaps = [];
  for (const list of b.querySelectorAll('ul,ol')) {
    const li = [...list.children].filter((e) => e.tagName === 'LI');
    for (let i = 1; i < li.length; i++) gaps.push((li[i].getBoundingClientRect().top - li[i - 1].getBoundingClientRect().bottom) / fs);
  }
  return { gaps, items: b.querySelectorAll('li').length, emptyP: [...b.querySelectorAll('p')].filter((p) => !p.textContent.trim()).length,
    ws: getComputedStyle(b).whiteSpace, ratio: b.getBoundingClientRect().width / log.clientWidth };
}

for (const r of RUNS) test(`${r.name}: bullets sit tight and the answer fills the log`, { skip, timeout: 90000 }, async () => {
  const ctx = await browsers[r.browser].newContext(r.ctx);
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  try {
    const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'), null, { timeout: 20000 });
    await page.evaluate(() => openApp('owner', 'mdl', 'MD Lists'));
    const app = page.frameLocator('#fr'); await app.locator('.pac-inp').waitFor();
    const fr = page.frame({ url: /\/app\/owner\/mdl\// });
    await app.locator('.pac-inp').fill('罗马书 7:1-6 的婚姻比喻是什么意思？'); await app.locator('.pac-go').click();
    await fr.waitForFunction(() => document.querySelector('.pac-m.ai.pac-md li'), null, { timeout: 20000 });
    await fr.evaluate(() => document.querySelectorAll('.pat-tip').forEach((e) => e.remove()));
    await page.waitForTimeout(400);
    const m = await fr.evaluate(measure), bad = [];
    if (m.items < 10 || m.gaps.length < 6) bad.push(`only ${m.items} items / ${m.gaps.length} gaps measured (R14)`);
    m.gaps.forEach((g, i) => { if (g > MAX_GAP_EM) bad.push(`gap ${i}: ${g.toFixed(2)}em > ${MAX_GAP_EM}em`); });
    if (m.emptyP) bad.push(`${m.emptyP} empty paragraph(s)`);
    if (m.ws !== 'normal') bad.push(`white-space ${m.ws}`);
    // Even painted through pre-wrap (a bubble that lost pac-md), the HTML carries no newline to paint as a blank line.
    const pw2 = await fr.evaluate((f) => { const b = [...document.querySelectorAll('.pac-m.ai.pac-md')].pop(); b.classList.remove('pac-md'); const g = (new Function('return ' + f))()(); b.classList.add('pac-md'); return g.gaps; }, measure.toString());
    pw2.forEach((g, i) => { if (g > MAX_GAP_EM) bad.push(`pre-wrap gap ${i}: ${g.toFixed(2)}em`); });
    if (r.wide && m.ratio < FULL_WIDTH) bad.push(`answer is ${(m.ratio * 100).toFixed(0)}% of the log width`);
    if (process.env.PA_MDLIST_SHOTS) {
      await fr.evaluate(() => { const l = document.querySelector('.pac-log'); const u = document.querySelector('.pac-m.ai.pac-md'); l.scrollTop = u.offsetTop - 8; });
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(process.env.PA_MDLIST_SHOTS, `${r.name}.png`) });
    }
    assert.deepEqual(bad, []);
  } finally { await ctx.close(); }
});
