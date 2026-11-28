// 试用 · Try it, the owner's flow (docs/adr/0049, R6): a throwaway node, a throwaway "public repo" with the
// real web/, a FAKE `claude` that keeps the real CLI's permission model and writes a change that ADDS a shell
// part (web/skin.js + its line in web/shell-parts.json + its marker), and the REAL render check.
//   1. the owner taps 发布 · Publish → the sheet shows 试用 · Try it with its first-use tip;
//   2. Try it → full-screen preview, banner + ✕; the change's new part is drawn; the owner can move around in
//      it (Settings opens); the frame is sandbox="allow-scripts" with no allow-same-origin; the page cannot
//      read the owner's storage, reach the real /api with the owner's credentials, or navigate away;
//   3. a member gets no button and no token.
// Visual check at 390/820/1280/1920: screenshots (PA_SHOTS=<dir>) + in-viewport / no-truncation DOM check.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';
import { writeFakeCli } from './helpers-platform.mjs';
import { FAKE_PERMS_SRC } from './helpers-fake-claude-perms.mjs';
import { selfpubFixture } from './helpers-selfpub.mjs';
import { assertFits } from './helpers-visual.mjs';
import { rmTemp } from './helpers-tmp.mjs';
import { hashPassword } from '../lib/auth.mjs';

const SHOTS = process.env.PA_SHOTS || '';
const TIP_GAP_MAX = 24;   // px: "beside" (PATips' GAP_PX is 8; a little slack for rounding)
const SKIN = "addEventListener('DOMContentLoaded',()=>{ const d=document.createElement('div'); d.id='skinMark'; d.textContent='SKIN-PART-DRAWN'; d.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:5;padding:6px;background:#c2185b;color:#fff;text-align:center;font:600 13px system-ui'; document.body.appendChild(d); });\n";
// Writes go through perms().write, so a write the real CLI would deny fails here too.
const FAKE = `#!/usr/bin/env node
${FAKE_PERMS_SRC}
const SKIN = ${JSON.stringify(SKIN)};
let s = ''; process.stdin.on('data', (d) => s += d).on('end', () => {
  const path = process.getBuiltinModule('node:path');
  const argv = process.argv.slice(2), sys = argv.join(' '), p = perms(argv), tools = [];
  const put = (f, fn) => { tools.push({ type: 'tool_use', name: 'Edit', input: { file_path: path.join(process.cwd(), f) } }); const cur = p.read(f); return p.write(f, fn(cur === null ? '' : cur)); };
  let say = 'ok';
  if (/git checkout of superelf/.test(sys) && /skin part/.test(s)) {
    const ok = put('web/skin.js', () => SKIN)
      && put('web/shell-parts.json', (c) => JSON.stringify([...JSON.parse(c), { marker: '/* PA_SKIN_JS */', file: 'skin.js', why: 'skin' }], null, 1))
      && put('web/index.html', (c) => c.replace('/* PA_SELFPUB_JS */', '/* PA_SKIN_JS */\\n/* PA_SELFPUB_JS */'));
    say = ok ? 'Changes: web/skin.js new skin bar; web/shell-parts.json lists it; web/index.html its marker.' : 'could not write';
  }
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-t' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [...tools, { type: 'text', text: say }] } }) + '\\n');
  p.text(say);
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: say, session_id: 'sid-t' }) + '\\n');
});
`;

let port, root, web, fx, browser, ctx, page, changeId = '';
const outside = [];   // any request the preview made to a host other than this node
async function signIn(pg, user, pass) {
  await pg.goto(`http://127.0.0.1:${port}/`); await pg.waitForSelector('#login[open]');
  await pg.fill('#luser', user); await pg.fill('#lpin', pass); await pg.click('#loginBtn');
  await pg.waitForFunction(() => !document.querySelector('#login[open]'));
}
before(async () => {
  fx = selfpubFixture({ web: true });
  port = await freePort();
  root = mkWebRoot({ port, extraConfig: { task_timeout_minutes: 1, selfpub_root: path.join(fx.d, 'src'), selfpub_clone_url: fx.bare,
    github_publish_token: 'fake-token-never-used', github_api_url: 'http://127.0.0.1:9', publish_remote_url: fx.bare,
    users: [{ id: 'owner', name: 'Owner', role: 'owner', token: OWNER_TOKEN, workspace: 'workspace', passHash: hashPassword('owner-pass-123') },
      { id: 'kid', name: 'Kid', role: 'member', token: 'test-member-token-0123456789abcdef', workspace: 'workspace-kid', passHash: hashPassword('kid-pass-12345') }] } });
  fs.mkdirSync(path.join(root, 'workspace-kid'));
  const cfgPath = path.join(root, 'config.json'), cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const bin = path.join(root, 'fakebin'); fs.mkdirSync(bin);
  cfg.claude_cmd = writeFakeCli(bin, 'claude', FAKE); fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(root, 'privacy-terms.txt'), 'Zorblax\n');
  fs.writeFileSync(path.join(root, 'workspace', 'identity-denylist.txt'), 'Quux Town\n');
  web = startWeb(root); await waitReady(port);
  if (skip) return;
  browser = await chromium.launch();
  ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (r) => { outside.push(r.request().url()); return r.abort(); });
  page = await ctx.newPage();
  await signIn(page, 'owner', 'owner-pass-123');
});
after(async () => { if (browser) await browser.close(); if (web) await stopWeb(web); if (root) rmTemp(root); if (fx) rmTemp(fx.d); });

const inner = () => page.frames().find((f) => /\/selfpub-try\/[a-f0-9]{48}\/page\//.test(f.url()));
async function openTry() {
  await page.click('#pubSheet #spTry');
  await page.locator('#spTryView').waitFor();
  for (let i = 0; i < 100 && !inner(); i++) await page.waitForTimeout(100);
  const f = inner(); assert.ok(f, 'the preview page loaded in the inner frame');
  await f.waitForSelector('#box', { timeout: 30000 });
  return f;
}

// 1. The request, its card, and the sheet with Try it and its tip.
async function sheetWithTry() {
  await page.fill('#box', 'change superelf: add a skin part'); await page.click('#send');
  await page.waitForFunction(() => document.querySelector('.sp-row') && !document.querySelector('#log .pa-think'), null, { timeout: 180000 });
  assert.match(await page.locator('#log .msg').last().textContent(), /可以发布/);
  changeId = await page.locator('.sp-row').getAttribute('data-id');
  await page.click('.sp-row .sp-go');
  await page.locator('#pubSheet #spTry').waitFor({ timeout: 30000 });
  assert.equal((await page.locator('#spTry').textContent()).trim(), '试用', 'PALang: 中文 here (the e2e locale), 试用 · Try it in the source');
  // The shots arrive after the sheet opens and move its layout: the tip must still be BESIDE the button after
  // that, and fully shown (.on: it fades in), not merely present (R13 review: it sat on the chat text).
  await page.waitForFunction(() => document.querySelectorAll('#spShots figure img').length === 2 && [...document.querySelectorAll('#spShots img')].every((i) => i.complete), null, { timeout: 30000 });
  await page.waitForFunction(() => { const t = document.querySelector('.pat-tip.on'); return t && /试用这个改动/.test(t.textContent) && getComputedStyle(t).opacity === '1'; }, null, { timeout: 10000 });
  await page.waitForTimeout(300);   // a re-place is one frame behind a layout change
  const near = await page.evaluate(() => { const t = document.querySelector('.pat-tip').getBoundingClientRect(), b = document.getElementById('spTry').getBoundingClientRect();
    const gap = t.top >= b.bottom ? t.top - b.bottom : b.top >= t.bottom ? b.top - t.bottom : -1;
    return { gap, across: t.left < b.right && b.left < t.right, tip: [t.top, t.bottom], btn: [b.top, b.bottom] }; });
  assert.ok(near.gap >= 0 && near.gap <= TIP_GAP_MAX && near.across, `the tip touches its button, above or below, not over it (${JSON.stringify(near)})`);
  await assertFits(page, 'sheet + Try it tip @390');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'try-sheet-390.png') });
}
// GPT review: a slow Try answer that comes back after the sheet moved on (re-opened, another change) opens nothing.
async function staleAnswer() {
  // Held in the page's own fetch: WebKit's service worker answers the shell's requests, which Playwright's route() never sees.
  await page.evaluate(() => { const f0 = window.fetch; window.__f0 = f0; window.__held = 0; window.__hold = new Promise((r) => { window.__release = r; });
    window.fetch = async (u, o) => { if (/\/api\/selfpub\/[a-z0-9]+\/try$/.test(String(u))) { window.__held++; await window.__hold; } return f0(u, o); }; });
  await page.click('#pubSheet #spTry');
  await page.evaluate((id) => { document.getElementById('spTry').dataset.tapped = '1'; PASelfPub.open(id); }, changeId);   // the sheet is drawn again: the tapped button is gone
  await page.waitForFunction(() => { const b = document.querySelector('#pubSheet #spTry'); return b && !b.dataset.tapped && document.querySelectorAll('#spShots figure').length === 2; }, null, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__held), 1, 'the Try answer really was held (else this proves nothing, R14)');
  await page.evaluate(() => { window.fetch = window.__f0; window.__release(); }); await page.waitForTimeout(1000);
  assert.equal(await page.locator('#spTryView').count(), 0, 'the late answer opened nothing over the new sheet');
  assert.equal(await page.locator('#spTryErr').count(), 0, 'and said nothing there');
}
// 2. Inside the preview: banner, sandbox, the new part, and moving around (Settings opens on the sample data).
async function lookInside(f) {
  const banner = await page.locator('#spTryBanner').textContent();
  assert.match(banner, /预览/); assert.match(banner, /示例数据，服务器改动不显示/); assert.match(banner, /不要在这里输入密码/, 'the page could draw a fake sign-in (R13)');
  assert.equal(await page.locator('#spTryFrame').getAttribute('sandbox'), 'allow-scripts', 'no allow-same-origin');
  assert.equal(await page.locator('.pat-tip').count(), 0, 'no shell tip over the preview (the page behind is inert)');
  assert.equal(await page.evaluate(() => document.getElementById('pubSheet').closest('[inert]') !== null), true);
  assert.equal(await f.locator('#skinMark').textContent(), 'SKIN-PART-DRAWN', 'the change\'s NEW shell part is drawn (copy\'s parts list)');
  assert.equal(await page.locator('#skinMark').count(), 0, 'and not on the owner\'s real page');

  // Moving around inside the preview: Settings opens on the sample data.
  await f.evaluate(() => document.getElementById('settings').click());
  await f.waitForSelector('#cfg[open]', { timeout: 10000 });
  assert.equal(await f.locator('#pName').inputValue(), 'Owner', 'the fake owner, not the real one');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'try-settings-390.png') });
  await f.evaluate(() => document.getElementById('cfg').close());
}
async function probeWall(f) {
  // The wall, probed from inside the agent's page.
  const probe = await f.evaluate(async (port) => {
    const out = {}, csp = [];
    document.addEventListener('securitypolicyviolation', (e) => csp.push(`${e.effectiveDirective} ${e.blockedURI}`));
    out.origin = self.origin;   // the document's origin (location.origin is the URL's)
    out.session = localStorage.getItem('pa_session');
    try { out.parentStore = String(parent.parent.localStorage.getItem('pa_session')); } catch { out.parentStore = 'blocked'; }
    try { out.cookie = document.cookie; } catch { out.cookie = 'blocked'; }
    out.fake = await fetch('/api/ping').then((r) => r.json()).then((j) => j.uid, () => 'failed');
    out.real = await fetch(`http://127.0.0.1:${port}/api/ping`, { credentials: 'include' }).then((r) => 'reached ' + r.status, () => 'blocked');
    out.realPath = await fetch(`${location.pathname.replace(/\/page\/.*$/, '')}/../../api/profile`).then(() => 'reached', () => 'blocked');
    out.ws = await new Promise((res) => { try { const w = new WebSocket(`ws://127.0.0.1:${port}/`); w.onopen = () => res('open'); w.onerror = () => res('blocked'); } catch { res('blocked'); } });
    out.popup = (() => { try { return window.open('https://example.org/') ? 'opened' : 'blocked'; } catch { return 'blocked'; } })();
    await new Promise((r) => setTimeout(r, 200));   // violation events are queued
    out.csp = csp;
    return out;
  }, port);
  assert.equal(probe.origin, 'null', 'an opaque origin');
  assert.equal(probe.session, 'preview', 'its own in-memory storage, never the owner\'s token');
  assert.equal(probe.parentStore, 'blocked'); assert.equal(probe.fake, 'owner', 'the fake API answers');
  assert.equal(probe.real, 'blocked', 'the real /api with credentials is refused');
  assert.ok(probe.csp.includes(`connect-src http://127.0.0.1:${port}/api/ping`), `refused by the CSP itself, not only by CORS (${probe.csp.join(' | ')})`);
  assert.equal(probe.realPath, 'blocked'); assert.equal(probe.ws, 'blocked'); assert.equal(probe.popup, 'blocked');
  assert.ok(probe.cookie === '' || probe.cookie === 'blocked', `no cookies (${probe.cookie})`);
}
async function visualCheck() {
  // Visual check, preview open, at every width.
  for (const [w, h] of [[390, 844], [820, 1180], [1280, 800], [1920, 1080]]) {
    await page.setViewportSize({ width: w, height: h }); await page.waitForTimeout(300);
    await assertFits(page, `Try it preview @${w}`, '#spTryView,#spTryBar,.pat-tip');
    const bar = await page.evaluate(() => { const b = document.getElementById('spTryBar').getBoundingClientRect(), x = document.getElementById('spTryClose').getBoundingClientRect(), fr = document.getElementById('spTryFrame').getBoundingClientRect();
      return { barTop: b.top, xRight: x.right, xW: x.width, xH: x.height, frH: fr.height, vw: innerWidth, vh: innerHeight }; });
    assert.ok(bar.barTop >= 0 && bar.xRight <= bar.vw && bar.xW >= 44 && bar.xH >= 44, `✕ on screen, 44px (${JSON.stringify(bar)})`);
    assert.ok(bar.frH > bar.vh * 0.8, 'the preview fills the screen');
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `try-preview-${w}.png`) });
  }
  await page.setViewportSize({ width: 390, height: 844 });
}
async function navigateAway(f) {
  // Last (it ends the page): the agent's page navigating its own frame to another host is refused.
  // Control first: the recorder does see a request to another host (else an empty list proves nothing, R14).
  // From a page no service worker controls (WebKit's worker fetches past route(); the sandboxed preview has none either).
  const ctl = await ctx.newPage(); await ctl.evaluate(() => fetch('http://example.invalid/control').catch(() => { /* aborted by the test's route: expected */ })); await ctl.close();
  assert.deepEqual(outside, ['http://example.invalid/control']); outside.length = 0;
  // Chromium logs "Framing … violates … frame-src"; WebKit "Refused to load … frame-src".
  const refused = []; const onLog = (m) => { const t = m.text(); if (/example\.invalid/.test(t) && /frame-src/.test(t)) refused.push(t); }; page.on('console', onLog);
  await f.evaluate(() => { location.href = 'http://example.invalid/leak?x=1'; }).catch(() => { /* the frame went away mid-call */ });
  await page.waitForTimeout(1500); page.off('console', onLog);
  assert.deepEqual(outside, [], 'no request left for another host');
  assert.ok(refused.length > 0, 'the wrapper\'s frame-src refused it (the navigation was really tried)');
  assert.ok(!page.frames().some((x) => /example\.invalid/.test(x.url())), 'the frame never reached the other host');
}

test('owner: Publish sheet → 试用 · Try it (tip beside it) → full-screen preview of the change, walled off', { skip, timeout: 300000 }, async () => {
  await sheetWithTry();
  await staleAnswer();
  const f = await openTry();
  await lookInside(f);
  await probeWall(f);
  await visualCheck();
  await navigateAway(f);
});

test('member: no Try it button and no preview token', { skip, timeout: 120000 }, async () => {
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 } }), m = await mctx.newPage();
  try {
    await signIn(m, 'kid', 'kid-pass-12345');
    assert.equal(await m.evaluate(() => PASelfPubTry.button()), '', 'no button for a member');
    const st = await m.evaluate(async (id) => (await api(`/api/selfpub/${id}/try`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, changeId || 'abcd1');
    assert.equal(st, 403);
    assert.equal(await m.locator('#spTry').count(), 0);
  } finally { await mctx.close(); }
});
