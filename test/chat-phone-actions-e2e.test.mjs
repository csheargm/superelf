// Phone chat, real flow（手机聊天真实流程）— owner iPhone 2026-11-25 ("hard to see much improvement"): in an app's own
// PAChat (School-Helper-like: mounted in a flex column under a header), after two REAL turns (fake model), at 440x956
// and 390x844 WebKit touch DPR 3: every copy / speak / ask-again / edit icon under user AND assistant messages renders
// an SVG glyph >= 18px at full opacity with a 44px tap (text glyphs ⎘ ✎ drew as a tiny fallback on iOS), and with the
// log scrolled to its end the last message ends above the composer, the log never runs under it, and ↓ sits above it.
// Known limits: emulated WebKit, not a real iPhone; env(safe-area-inset-bottom) is 0 here.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { missingReason, resolveSkip } from './helpers-e2e-gate.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN, shellAppFrame } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { checkChatText, chatTextFailures, composerClearance, clearanceFailures, PAC_CLEAR_SEL } from './helpers-phone-check.mjs';

const pw = await (async () => { try { return process.env.PA_PLAYWRIGHT ? await import(pathToFileURL(process.env.PA_PLAYWRIGHT).href) : await import('playwright'); } catch { return null; } })();
const skip = resolveSkip(await missingReason(pw && pw.webkit));
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>html,body{height:100%;margin:0;overflow:hidden}body{display:flex;flex-direction:column}header{padding:20px;font-size:28px}#chat-host{flex:1;min-height:0;display:flex;flex-direction:column}</style></head>
<body><header>School Helper</header><div id="chat-host"></div><!--PA_CHAT_UI-->
<script>PAChat.mount(document.getElementById('chat-host'),{placeholder:'Ask anything about your homework…',persist:'school'});</script></body></html>`;
const REPLY = '- **Explaining ideas** step by step\n- **Checking your thinking**\n\n' + 'Anything that tells you otherwise is wrong. '.repeat(25);
const SIZES = [[440, 956], [390, 844]];

let port, root, web, wk, model;
before(async () => {
  model = http.createServer((q, s) => { q.on('data', () => {}).on('end', () => { s.writeHead(200, { 'content-type': 'application/x-ndjson' });
    s.end(JSON.stringify({ message: { role: 'assistant', content: REPLY }, done: true }) + '\n'); }); });
  await new Promise((r) => model.listen(0, '127.0.0.1', r));
  port = await freePort(); root = mkWebRoot({ port, extraConfig: { ollama_url: `http://127.0.0.1:${model.address().port}` } });
  const app = path.join(root, 'workspace/apps/school'); fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'index.html'), PAGE); fs.writeFileSync(path.join(app, 'meta.json'), JSON.stringify({ title: 'School Helper' }));
  web = startWeb(root); await waitReady(port);
  if (!skip) wk = await pw.webkit.launch();
});
after(async () => { if (wk) await wk.close(); if (web) await stopWeb(web); if (root) rmTemp(root); if (model) model.close(); });

for (const [w, h] of SIZES) test(`phone ${w}x${h}: action icons are real SVG glyphs; the composer never covers the last message`, { skip, timeout: 90000 }, async () => {
  const ctx = await wk.newContext({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  try {
    const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'), null, { timeout: 20000 });
    await page.evaluate(() => openApp('owner', 'school', 'School Helper'));
    const app = page.frameLocator('#fr'); await app.locator('.pac-inp').waitFor();
    const fr = await shellAppFrame(page);
    for (const [i, ask] of ['What can you do', 'Can you change the app'].entries()) {
      await app.locator('.pac-inp').fill(ask); await app.locator('.pac-go').tap();
      await fr.waitForFunction((k) => document.querySelectorAll('.pac-m.ai.pac-md').length > k, i, { timeout: 20000 });
    }
    await fr.evaluate(() => document.querySelectorAll('.pat-tip').forEach((e) => e.remove()));
    await page.waitForTimeout(600);
    const m = await checkChatText(fr), bad = chatTextFailures(`${w} app chat`, m);
    for (const k of ['me', 'ai']) if (!m.action.some((a) => a.kind === k)) bad.push(`${w}: no ${k} action icon measured`);   // R14
    bad.push(...clearanceFailures(`${w} app chat`, await fr.evaluate(composerClearance, PAC_CLEAR_SEL)));
    // ↓ shows once scrolled up, and sits above the composer
    await fr.evaluate(() => { const l = document.querySelector('.pac-log'); l.scrollTop = 0; l.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(300);
    const j = await fr.evaluate(() => { const b = document.querySelector('.pac-scroll'); return { show: b.classList.contains('show'), bottom: b.getBoundingClientRect().bottom, row: document.querySelector('.pac-row').getBoundingClientRect().top }; });
    if (!j.show) bad.push(`${w}: ↓ not shown when scrolled up (CONTROL)`);
    else if (j.bottom > j.row + 0.5) bad.push(`${w}: ↓ over the composer`);
    assert.deepEqual(bad, []);
  } finally { await ctx.close(); }
});
