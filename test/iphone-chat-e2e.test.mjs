// iPhone chat after two replies · iPhone 上两轮对话后 (owner 2026-11-24, installed PWA, Red Flags 危险信号):
// "the app is frozen, no button responds", text sizes jump, the composer sits on the answer.
// In WebKit with iPhone emulation (390x844, touch, DPR 3, standalone): an app mounting
// PAChat.fullscreen with a long bilingual intro; a fake model answers a short and a long Chinese
// markdown list. Then: every visible control is the element hit at its centre — in the app AND in
// the shell above the iframe (the home ⋯ tip used to paint over the app's ＋ ✕) — and a real tap
// reaches it; bubbles of one kind share one computed size; the composer clears the last bubble.
// Autosizing itself is iOS-only: test/text-size-adjust.test.mjs pins that rule. Known limits: run it
// with PA_E2E_ENGINE=webkit for Safari's engine (the harness default is Chromium); the PWA case
// patches navigator.standalone/matchMedia only, CSS display-mode media queries still see a tab.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { skip, chromium as engine } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';

const SHOTS = process.env.PA_SHOTS || '';
const IPHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
const GREET = '我是症状分诊助手。描述你的症状，我会告诉你哪些是危险信号、何时必须立刻就医。\nDescribe a symptom and I will tell you which signs are red flags and when to see a doctor right away.';
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<!--PA_CHAT_UI-->
<script>PAChat.fullscreen({title:'Red Flags 危险信号',placeholder:'Describe a symptom… 描述症状…',greeting:${JSON.stringify(GREET)},persist:'redflags'}).open('triage');</script></body></html>`;
const SHORT = '**胀气**通常不危险。\n\n- 少吃产气食物\n- 饭后散步\n- 伴**剧烈腹痛**、发热，立即就医';
const LONG = '## 贲门癌的危险信号\n\n' + Array.from({ length: 12 }, (_, i) => `${i + 1}. **信号${i + 1}**：进行性吞咽困难、体重下降、呕血或黑便，持续两周以上必须做胃镜。Progressive dysphagia — see a doctor.`).join('\n');
const TURNS = [['胀气', SHORT, '少吃产气食物'], ['喷门癌', LONG, '信号12']];
const SETTLE_MS = 1200, TURN_WAIT_MS = 20000;
const CONTROLS = '.pac-fs.on :is(.pac-toList,.pac-newC,.pac-close,.pac-plus,.pac-inp,.pac-go,.pac-model)';

let port, root, web, browser, model, n = 0;
before(async () => {
  model = http.createServer((q, s) => { q.on('data', () => {}).on('end', () => {
    s.writeHead(200, { 'content-type': 'application/x-ndjson' });
    s.end(JSON.stringify({ message: { role: 'assistant', content: TURNS[n++ % 2][1] }, done: true }) + '\n'); }); });
  await new Promise((r) => model.listen(0, '127.0.0.1', r));
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, ollama_url: `http://127.0.0.1:${model.address().port}`, users: [
    { id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') }] } });
  for (const slug of ['redflags', 'redflags-pwa']) {   // one app per case: no chat history to replay into the other
    const app = path.join(root, 'workspace', 'apps', slug); fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'index.html'), PAGE);
    fs.writeFileSync(path.join(app, 'meta.json'), JSON.stringify({ title: 'Red Flags 危险信号' })); }
  web = startWeb(root); await waitReady(port);
  if (!skip) browser = await engine.launch();
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); if (model) model.close(); });

const standalone = () => { Object.defineProperty(navigator, 'standalone', { get: () => true }); const m = window.matchMedia;
  window.matchMedia = (q) => (/display-mode:\s*standalone/.test(q) ? { matches: true, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} } : m.call(window, q)); };

for (const pwa of [false, true]) test(`iPhone${pwa ? ' home-screen PWA' : ''}: after two replies every control answers a tap, sizes agree, composer clears the answer`, { skip, timeout: 120000 }, async () => {
  await fetch(`http://127.0.0.1:${port}/api/profile`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${OWNER_TOKEN}` }, body: JSON.stringify({ tipsSeen: [] }) });   // the other run's dismissal is on the account now
  const ctx = await browser.newContext(IPHONE); if (pwa) await ctx.addInitScript(standalone);
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${port}/`); await page.waitForSelector('#login[open]');
    await page.fill('#luser', 'owner'); await page.fill('#lpin', 'owner-pass-123'); await page.click('#loginBtn');
    await page.waitForFunction(() => !document.querySelector('#login[open]'));
    assert.ok(await page.waitForSelector('.pat-tip[data-tip="tip:home-more"]', { timeout: 5000 }).then(() => true, () => false), 'CONTROL: the home tip shows on the home');
    const slug = pwa ? 'redflags-pwa' : 'redflags';
    await page.tap(`.ecard[data-es="${slug}"]`);
    const app = page.frameLocator('#fr'); await app.locator('.pac-fs.on .pac-inp').waitFor();
    const fr = page.frame({ url: new RegExp(`/app/owner/${slug}/`) });
    n = 0;   // each case starts at the short reply (the fake model answers in ONE chunk, so .pac-md means finished)
    for (const [ask, , mark] of TURNS) {
      const k = await app.locator('.pac-fs.on .pac-m.me').count();
      await app.locator('.pac-fs.on .pac-inp').tap(); await app.locator('.pac-fs.on .pac-inp').fill(ask);
      await app.locator('.pac-fs.on .pac-go').tap();
      await fr.waitForFunction(([c, w]) => { const me = document.querySelectorAll('.pac-fs.on .pac-m.me'), ai = document.querySelectorAll('.pac-fs.on .pac-m.ai.pac-md');
        const q = me.length > c && me[me.length - 1];   // the first finished answer AFTER this question
        const after = q && [...ai].find((a) => q.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING);
        return !!after && after.textContent.includes(w); }, [k, mark], { timeout: TURN_WAIT_MS });
    }
    await page.waitForTimeout(SETTLE_MS);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `iphone${pwa ? '-pwa' : ''}-after-two-replies.png`) });
    const box = await page.locator('#fr').boundingBox();
    const ctls = await fr.evaluate((sel) => [...document.querySelectorAll(sel)].map((b) => { const r = b.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2, e = document.elementFromPoint(x, y);
      return { c: b.className, x, y, own: !!e && (e === b || b.contains(e)) }; }), CONTROLS);
    assert.equal(ctls.length, 7, 'all seven controls are on screen');
    for (const c of ctls) {
      assert.ok(c.own, `${c.c}: covered inside the app`);
      const top = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && e.id; }, [box.x + c.x, box.y + c.y]);
      assert.equal(top, 'fr', `${c.c}: the shell takes its tap`);
    }
    // Nothing of the shell PAINTS over them either: an inert layer passes the tap through yet hides the control.
    const over = await page.evaluate(([b, cs]) => { const fr = document.getElementById('frame'), out = [];
      for (const e of document.body.querySelectorAll('*')) { if (fr.contains(e) || e.contains(fr)) continue;
        const s = getComputedStyle(e); if (!/fixed|absolute/.test(s.position) || s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) continue;
        const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
        for (const c of cs) { const x = b.x + c.x, y = b.y + c.y; if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) out.push((e.id || e.className) + ' over ' + c.c); } }
      return out; }, [box, ctls]);
    assert.deepEqual(over, [], 'no shell layer paints over an app control');
    assert.equal(await page.evaluate(() => { const t = document.querySelector('.pat-tip[data-tip="tip:home-more"]'); return !!t && getComputedStyle(t).display !== 'none'; }), false, 'the home tip is not shown over an open app');
    // A real tap reaches the model pill, then ☰ (it opens the list over the rest, so it goes last);
    // send / ＋ / the input would start other flows, and their hit test above covers them.
    await fr.evaluate(() => { window.__taps = []; document.addEventListener('click', (e) => window.__taps.push(e.target.className), true); });
    for (const c of ['pac-model', 'pac-toList'].map((k) => ctls.find((x) => x.c.includes(k)))) {
      await page.touchscreen.tap(box.x + c.x, box.y + c.y); await page.waitForTimeout(300);
      assert.ok((await fr.evaluate(() => window.__taps.splice(0))).some((t) => String(t).includes(c.c.split(' ').pop())), `${c.c}: the tap arrived`);
      await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    }
    await fr.waitForSelector('.pac-list.on', { timeout: TURN_WAIT_MS });   // the ☰ tap opened the list (it refreshes first)
    const m = await fr.evaluate(() => { const ms = [...document.querySelectorAll('.pac-fs.on .pac-m.ai,.pac-fs.on .pac-m.me')];
      const row = document.querySelector('.pac-fs.on .pac-inp').closest('.pac-row') || document.querySelector('.pac-fs.on .pac-inp').parentElement;
      const log = document.querySelector('.pac-fs.on .pac-log'); log.scrollTop = log.scrollHeight;
      return { sizes: [...new Set(ms.map((x) => x.className.split(' ')[1] + ':' + getComputedStyle(x).fontSize))],
        last: ms[ms.length - 1].getBoundingClientRect().bottom, comp: row.getBoundingClientRect().top }; });
    assert.deepEqual(m.sizes.sort(), ['ai:14px', 'me:14px'], 'one size per bubble kind');
    await page.waitForTimeout(300);
    const last = await fr.evaluate(() => { const ms = document.querySelectorAll('.pac-fs.on .pac-m'); return ms[ms.length - 1].getBoundingClientRect().bottom; });
    assert.ok(last <= m.comp, `the composer (top ${m.comp}) covers the last bubble (bottom ${last})`);
    assert.deepEqual(errors, [], 'no page errors');
  } finally { await ctx.close(); }
});
