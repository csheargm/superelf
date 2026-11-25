// Phone-friendly chat windows and notes（手机友好：聊天窗口与笔记）e2e — phase 2 of the phone audit, in WebKit at iPhone
// 390x844 and iPad 820x1180 (touch, DPR 3), measured with test/helpers-phone-check.mjs on every chat and notes surface:
//   the Journal (notes) page, its ⋯ menu, page settings, ink popover, ☰ notes list, Ask AI (full screen on a phone —
//   audit #1, never refused — and the side rail on an iPad), the shell's main chat, and the app chat panel (改这个应用).
// Each: no sideways page scroll, no input under 16px, no button under 44px, nothing covering a control; plus the
// finding's own measure (title room #4, popovers below the header #6 #7, chips over the last message #9, chip text
// #11, list text #16, wide content in its box #24, a spent 改 · Apply chip, the panel placeholder F10).
// Run: PA_PLAYWRIGHT=/path/to/playwright/index.mjs node --test test/phone-chat-notes-e2e.test.mjs
// Known limits: emulated WebKit, not a real iPhone; no on-screen keyboard here, so "composer above the keyboard"
// is not proven by this file; AI is off (port 9), so replies are injected bubbles, not model output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { missingReason, resolveSkip } from './helpers-e2e-gate.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { ROOT } from './helpers-app.mjs';
import { checkSurface, checkChatText, chatTextFailures } from './helpers-phone-check.mjs';

const pw = await (async () => { try { return process.env.PA_PLAYWRIGHT ? await import(pathToFileURL(process.env.PA_PLAYWRIGHT).href) : await import('playwright'); } catch { return null; } })();
const skip = resolveSkip(await missingReason(pw && pw.webkit));
const DEVICES = { iPhone: { width: 390, height: 844 }, iPad: { width: 820, height: 1180 } };
const SETTLE_MS = 900;
const TITLE_MIN_PX = 60;     // the note title keeps room for a few characters, not "N…" (audit #4)
const CHIP_TEXT_PX = 14, META_PX = 13, PREVIEW_PX = 14;
const LONG = '<p>' + 'Long answer text '.repeat(40) + '</p><pre><code>const reallyLongVariableName = someFunction(argumentNumberOne, argumentNumberTwo, argumentNumberThree);</code></pre><table><tr>'
  + '<th>Column header</th>'.repeat(6) + '</tr><tr>' + '<td>cell value 123</td>'.repeat(6) + '</tr></table>';
// What a real reply carries under it: the meta line and the action icons (same classes as mkab / the shell's .mab).
const PAC_ACTS = '<small class="pa-took">DeepSeek · 中文 · took 1.2s</small><div><button type="button" class="pac-ab">⧉</button><button type="button" class="pac-ab">🔊</button><button type="button" class="pac-ab">↻</button></div>';
const MSG_ACTS = '<small class="pa-took">DeepSeek · took 1.2s</small><div class="msg-actions"><button type="button" class="mab">⧉</button><button type="button" class="mab">🔊</button></div>';
// On a phone the chat reads at phone size; on an iPad / desktop the sizes stay as they were (CONTROL: under 16px).
// mode: 'phone' = phone sizes; 'control' = a wide touch page keeps its old sizes (bubbles under 16px).
async function judgeText(t, where, logSel, cls, acts, mode, bad) {
  await t.evaluate(([l, c, h]) => { const log = document.querySelector(l), d = document.createElement('div'); d.className = c; d.innerHTML = h; log.appendChild(d); log.scrollTop = log.scrollHeight; }, [logSel, cls, '<p>Reply</p>' + acts]);
  const m = await checkChatText(t);
  if (mode === 'phone') bad.push(...chatTextFailures(where, m));
  else if (!m.bubble.length || m.bubble.some((x) => x >= 16)) bad.push(`${where}: wide-page bubble text changed ${m.bubble.join('/')}px (CONTROL)`);
}

let port, root, web, wk;
before(async () => {
  port = await freePort(); root = mkWebRoot({ port });
  fs.cpSync(path.join(ROOT, 'workspace.example/apps'), path.join(root, 'workspace/apps'), { recursive: true });
  web = startWeb(root); await waitReady(port);
  if (!skip) wk = await pw.webkit.launch();
});
after(async () => { if (wk) await wk.close(); if (web) await stopWeb(web); if (root) rmTemp(root); });

async function open(viewport) {
  const ctx = await wk.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  await ctx.addInitScript((t) => { try { localStorage.setItem('pa_session', t); } catch { /* the sandboxed app frame has no storage */ } }, OWNER_TOKEN);
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'), null, { timeout: 20000 });
  await page.waitForTimeout(SETTLE_MS);
  return { ctx, page };
}
// First-use tips are phase 1's subject (and tested there); here they would only stand between the finger and the control.
const noTips = (t) => t.evaluate(() => document.querySelectorAll('.pat-tip').forEach((e) => e.remove()));
function judge(where, m, bad) {
  if (m.hScroll) bad.push(`${where}: page scrolls sideways by ${m.hScroll}px`);
  if (m.smallInputs.length) bad.push(`${where}: inputs under 16px ${m.smallInputs.join(', ')}`);
  if (m.smallTaps.length) bad.push(`${where}: taps under 44px ${m.smallTaps.slice(0, 6).join(', ')}${m.smallTaps.length > 6 ? ` (+${m.smallTaps.length - 6})` : ''}`);
  if (m.covered.length) bad.push(`${where}: covered ${m.covered.slice(0, 4).join(', ')}`);
}
async function notesFrame(page) {
  await page.evaluate(() => openApp('owner', 'notes', 'notes'));
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const fr = await (await page.$('#fr')).contentFrame();
    if (fr && await fr.$('.pan-top .pan-hask').catch(() => null)) { await page.waitForTimeout(SETTLE_MS); await noTips(fr); return fr; }
  }
  throw new Error('the Journal never showed its header');
}
// The bottom of the last chat bubble vs the top of the composer's chips, after scrolling the log to its end (#9).
const lastClearsPills = (t, logSel, msgSel) => t.evaluate(([l, m]) => {
  const log = document.querySelector(l); log.scrollTop = log.scrollHeight;
  const msgs = [...log.querySelectorAll(m)].filter((e) => e.offsetParent), last = msgs[msgs.length - 1];
  const pills = [...document.querySelectorAll('.pac-pills')].find((e) => e.offsetParent);
  return { last: last.getBoundingClientRect().bottom, pills: pills.getBoundingClientRect().top };
}, [logSel, msgSel]);
const chipPx = (t) => t.evaluate(() => [...document.querySelectorAll('.pac-model,.pac-vfy')].filter((e) => e.offsetParent).map((e) => parseFloat(getComputedStyle(e).fontSize)));
// Wide content in an answer stays inside its bubble: the bubble is no wider than the page; the table and the code
// block end inside it (whatever does not fit scrolls in its own box).
const wideInBox = (t, sel) => t.evaluate((s) => { const b = [...document.querySelectorAll(s)].pop(), tb = b.querySelector('table'), pre = b.querySelector('pre');
  return { bubble: b.getBoundingClientRect().right <= innerWidth + 0.5, table: tb.getBoundingClientRect().right <= b.getBoundingClientRect().right + 0.5,
    pre: pre.getBoundingClientRect().right <= b.getBoundingClientRect().right + 0.5 }; }, sel);

for (const [dev, viewport] of Object.entries(DEVICES)) {
  const phone = viewport.width < 600;

  test(`${dev}: the Journal — header, ⋯ menu, popovers and ☰ list pass the phone check`, { skip, timeout: 120000 }, async () => {
    const { ctx, page } = await open(viewport); const bad = [];
    try {
      const fr = await notesFrame(page);
      judge(`${dev} notes`, await checkSurface(fr), bad);
      const head = await fr.evaluate(() => { const t = document.querySelector('.pan-top'), b = [...t.querySelectorAll('button')].filter((x) => x.offsetWidth);
        return { title: document.querySelector('.pan-htitle').getBoundingClientRect().width, rows: new Set(b.map((x) => Math.round(x.getBoundingClientRect().top))).size,
          photo: !!document.querySelector('.pan-hphoto')?.offsetWidth, print: !!document.querySelector('.pan-hprint')?.offsetWidth }; });
      if (head.title < TITLE_MIN_PX) bad.push(`${dev} notes: title only ${Math.round(head.title)}px wide`);
      if (head.rows !== 1) bad.push(`${dev} notes: header controls on ${head.rows} rows`);
      if (phone && (head.photo || head.print)) bad.push(`${dev} notes: Photo / Print still in the phone header`);
      if (!phone && !(head.photo && head.print)) bad.push(`${dev} notes: Photo / Print left the tablet header (CONTROL)`);
      // ⋯ → on a phone a menu (Page settings · Photo · Print), on an iPad Page settings itself.
      await fr.click('.pan-hmore'); await page.waitForTimeout(400);
      if (phone) {
        const rows = await fr.$$eval('.pan-ovf.on [data-ovf]', (bs) => bs.map((b) => b.dataset.ovf));
        assert.deepEqual(rows, ['paper', 'photo', 'print'], 'the phone ⋯ menu holds what the header folded away');
        judge(`${dev} notes ⋯ menu`, await checkSurface(fr), bad);
        await fr.click('.pan-ovf [data-ovf=paper]'); await page.waitForTimeout(400);
      }
      for (const [what, sel] of [['page settings', '.pan-paperpop'], ['ink', '.pan-inkpop']]) {
        if (what === 'ink') { await fr.evaluate(() => document.querySelectorAll('.pan-pop.on').forEach((p) => p.classList.remove('on'))); await fr.click('.pan-mdraw'); await page.waitForTimeout(400); await fr.click('.pan-inkbtn'); await page.waitForTimeout(400); }
        const r = await fr.evaluate((s) => { const p = document.querySelector(s); const pr = p.getBoundingClientRect();
          return { on: p.classList.contains('on'), top: pr.top, bottom: pr.bottom, head: document.querySelector('.pan-top').getBoundingClientRect().bottom, H: innerHeight }; }, sel);
        assert.ok(r.on, `${what} opened`);
        if (r.top < r.head) bad.push(`${dev} ${what}: popover top ${Math.round(r.top)} under the header (${Math.round(r.head)}) — audit #6 #7`);
        if (r.bottom > r.H) bad.push(`${dev} ${what}: popover runs off the bottom`);
        judge(`${dev} notes ${what}`, await checkSurface(fr, { skip: '.pan-stage' }), bad);   // the page under an open popover is not what a finger reaches
      }
      await fr.evaluate(() => document.querySelectorAll('.pan-pop.on').forEach((p) => p.classList.remove('on')));
      // ☰ notes list: 44px rows and actions, 13px meta, 14px previews (#16).
      await fr.click('.pan-hist'); await page.waitForTimeout(700);
      judge(`${dev} notes list`, await checkSurface(fr, { skip: '.pan' }), bad);
      const txt = await fr.evaluate(() => { const px = (s) => [...document.querySelectorAll(s)].filter((e) => e.offsetParent).map((e) => parseFloat(getComputedStyle(e).fontSize));
        return { meta: px('.pac-lday,.pac-ltime,.pac-lchip'), prev: px('.pac-lprev') }; });
      if (txt.meta.some((x) => x < META_PX)) bad.push(`${dev} notes list: meta text ${txt.meta.join('/')}px`);
      if (txt.prev.some((x) => x < PREVIEW_PX)) bad.push(`${dev} notes list: previews ${txt.prev.join('/')}px`);
    } finally { await ctx.close(); }
    assert.deepEqual(bad, [], bad.join('\n'));
  });

  test(`${dev}: Ask AI from a note opens (${phone ? 'full screen with ✕' : 'beside the page'}) and its chat passes the phone check`, { skip, timeout: 120000 }, async () => {
    const { ctx, page } = await open(viewport); const bad = [];
    try {
      const fr = await notesFrame(page);
      await fr.click('.pan-hask'); await page.waitForTimeout(1500); await noTips(fr);
      const st = await fr.evaluate(() => ({ notice: [...document.querySelectorAll('.pa-notice')].map((n) => n.textContent).join(''), fs: !!document.querySelector('.pac-fs.on'), panel: !!document.querySelector('.pac-panel') }));
      assert.equal(st.notice, '', 'never refused (audit #1)');
      assert.ok(phone ? st.fs : st.panel, phone ? 'a phone gets the full-screen chat' : 'an iPad keeps the side rail');
      if (phone) {   // full screen: the note's header and the app's controls are under it, not beside it
        const cover = await fr.evaluate(() => { const r = document.querySelector('.pac-fs.on').getBoundingClientRect(); return r.top <= 0 && r.left <= 0 && r.right >= innerWidth && r.bottom >= innerHeight; });
        assert.ok(cover, 'the chat covers the whole page');
      }
      const scope = phone ? '.pac-fs.on' : '.pac-panel';
      await fr.evaluate(([s, html]) => { const log = document.querySelector(s + ' .pac-log'); const d = document.createElement('div'); d.className = 'pac-m ai'; d.innerHTML = html; log.appendChild(d); }, [scope, LONG]);
      await page.waitForTimeout(300);
      judge(`${dev} ask-ai chat`, await checkSurface(fr, { skip: phone ? '.pan' : '' }), bad);
      const c = await lastClearsPills(fr, `${scope} .pac-log`, '.pac-m');
      if (c.last > c.pills + 0.5) bad.push(`${dev} ask-ai: last message (bottom ${Math.round(c.last)}) under the chips (top ${Math.round(c.pills)}) — audit #9`);
      const w = await wideInBox(fr, `${scope} .pac-m.ai`);
      if (!w.bubble || !w.table || !w.pre) bad.push(`${dev} ask-ai: wide content leaves its bubble ${JSON.stringify(w)} — audit #24`);
      if ((await chipPx(fr)).some((x) => x < CHIP_TEXT_PX)) bad.push(`${dev} ask-ai: chip text under ${CHIP_TEXT_PX}px — audit #11`);
      await judgeText(fr, `${dev} ask-ai chat`, `${scope} .pac-log`, 'pac-m ai', PAC_ACTS, phone ? 'phone' : 'control', bad);
      // A spent 改 · Apply: a later typed turn disables it, really and visibly.
      await fr.evaluate((s) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'pac-change-app pac-confirm'; b.textContent = '改 · Apply'; b.style.cssText = 'cursor:pointer'; document.querySelector(s + ' .pac-log').appendChild(b); }, scope);
      // GPT review: a send refused by the size pre-flight is not a turn, so the chip stays live.
      await fr.evaluate((s) => { document.querySelector(s + ' .pac-inp').value = 'x'.repeat(1100 * 1024); }, scope);
      await fr.click(`${scope} .pac-go`); await page.waitForTimeout(300);
      assert.equal(await fr.evaluate((s) => document.querySelector(s + ' .pac-confirm').disabled, scope), false, 'an oversized, refused send leaves Apply live');
      await fr.fill(`${scope} .pac-inp`, 'yes'); await fr.click(`${scope} .pac-go`); await page.waitForTimeout(500);
      const chip = await fr.evaluate((s) => { const b = document.querySelector(s + ' .pac-confirm'); return { disabled: b.disabled, opacity: +getComputedStyle(b).opacity }; }, scope);
      assert.ok(chip.disabled && chip.opacity < 0.6, `a typed "yes" retires the Apply chip: ${JSON.stringify(chip)}`);
      if (phone) {   // ✕ is the way back to the note
        assert.ok(await fr.evaluate(() => document.querySelector('.pan').closest('[inert]') !== null), 'the note under the full-screen chat is inert (GPT review)');
        assert.ok(await fr.evaluate(() => { const n = document.getElementById('pa-notice'); return !n || !n.closest('[inert]'); }), 'the notice banner stays tappable over the chat');
        await fr.click('.pac-fs.on .pac-top .pac-close'); await page.waitForTimeout(400);
        assert.ok(await fr.evaluate(() => !document.querySelector('[inert]') && !document.activeElement.closest('.pac-fs')), 'closing lifts inert and leaves no focus in the hidden chat');   // WebKit does not focus a tapped button, so the restored target is not asserted
        assert.ok(!(await fr.$('.pac-fs.on')), '✕ closes the full-screen chat');
        assert.ok(await fr.evaluate(() => !!document.querySelector('.pan-top').offsetWidth), 'back on the note');
      }
      if (!phone) {   // GPT review: the rail was made wide; narrowed to a phone, Ask AI must go full screen, not into the closed rail
        await page.setViewportSize(DEVICES.iPhone); await page.waitForTimeout(1200); await noTips(fr);
        await fr.click('.pan-hask'); await page.waitForTimeout(1200);
        assert.ok(await fr.$('.pac-fs.on'), 'narrowed after the rail was made: Ask AI opens full screen');
      }
    } finally { await ctx.close(); }
    assert.deepEqual(bad, [], bad.join('\n'));
  });

  test(`${dev}: the shell's main chat and the app chat panel pass the phone check`, { skip, timeout: 120000 }, async () => {
    const { ctx, page } = await open(viewport); const bad = [];
    try {
      await noTips(page);
      const box = page.locator('#homeForm textarea, #homeForm input, #box').first();
      await box.fill('Hi'); await box.press('Enter'); await page.waitForTimeout(1500);
      await page.evaluate((html) => { const d = document.createElement('div'); d.className = 'msg bot'; d.innerHTML = html; document.querySelector('#log').appendChild(d); }, LONG);
      await page.waitForTimeout(300); await noTips(page);
      judge(`${dev} main chat`, await checkSurface(page), bad);
      const c = await lastClearsPills(page, '#log', '.msg');
      if (c.last > c.pills + 0.5) bad.push(`${dev} main chat: last message under the chips — audit #9`);
      const w = await wideInBox(page, '#log .msg.bot');
      if (!w.bubble || !w.table || !w.pre) bad.push(`${dev} main chat: wide content leaves its bubble ${JSON.stringify(w)} — audit #24`);
      if ((await chipPx(page)).some((x) => x < CHIP_TEXT_PX)) bad.push(`${dev} main chat: chip text under ${CHIP_TEXT_PX}px — audit #11`);
      if (phone) await judgeText(page, `${dev} main chat`, '#log', 'msg bot', MSG_ACTS, 'phone', bad);   // the shell body is 17px at every width
      // The app chat panel (改这个应用) over an open app.
      await page.evaluate(() => { goHome(); openApp('owner', 'tasks', 'tasks'); }); await page.waitForTimeout(2500);
      await page.evaluate(() => PAAppEdit.open('tasks', 'tasks')); await page.waitForTimeout(2000);
      const af = await (await page.$('#aefr')).contentFrame(); await noTips(af); await noTips(page);
      judge(`${dev} app chat panel`, await checkSurface(af), bad);
      await judgeText(af, `${dev} app chat panel`, '.pac-log', 'pac-m ai', PAC_ACTS, 'phone', bad);   // a narrow panel on iPad too
      const ph = await af.evaluate(() => { const i = document.querySelector('.pac-inp'); return { fits: i.scrollHeight <= i.clientHeight + 1, ph: i.placeholder }; });
      if (!ph.fits) bad.push(`${dev} app chat panel: the placeholder "${ph.ph}" is cut (F10)`);
    } finally { await ctx.close(); }
    assert.deepEqual(bad, [], bad.join('\n'));
  });
}
