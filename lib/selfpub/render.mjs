// iPhone 截图 · The core change's render check (docs/adr/0044 §4, owner decision 2026-11-25 (2)). After the
// agent's turn the SERVER renders the shell's Home at iPhone width (390×844) twice — origin/main (before)
// and the checkout (after) — so the reply can say what was looked at, never what was merely hoped.
//
// What runs where:
//   - The page is assembled by THIS node's own lib/shellhtml.mjs (trusted code) from the checkout's web/
//     files; no agent-written server code runs. The page's own JS runs inside headless Chromium only.
//   - Every request is answered from memory by lib/selfpub/preview-page.mjs (shared with the Try it preview):
//     '/' = the assembled shell, /web/* = checkout files, /api/* = a fixed fake owner. Anything else is
//     aborted. The browser also gets a dead proxy and a resolver that maps every name to nothing, so no request (fetch, WebSocket, image) can leave the box.
//   - The browser: playwright-core + Chromium headless shell, installed in the PRIVATE image only
//     (ops/demo/Dockerfile RENDER_BROWSER). Its module path comes from SELFPUB_PLAYWRIGHT (image) or
//     PA_PLAYWRIGHT (a dev Mac). No browser → null, and lib/selfpub/verify.mjs says so (not ready).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FAKE_API, PREVIEW_MARKERS, previewAnswer } from './preview-page.mjs';
import { git } from './checkout.mjs';

export const PHONE = { width: 390, height: 844 };
export const RENDER_ORIGIN = 'http://render.invalid';
export const SETTLE_MS = 1500;
export const RENDER_TIMEOUT_MS = 30000;
// The whole check (launch + two shots): a page that hangs after loading (a busy loop stalls evaluate and
// screenshot) would otherwise hold the core-change lock for good. Past this, the browser is closed (nightly review 2026-11-26).
export const RENDER_DEADLINE_MS = 4 * RENDER_TIMEOUT_MS;
const LAUNCH_ARGS = ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND', '--disable-dev-shm-usage',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--no-first-run'];
export { FAKE_API, PREVIEW_MARKERS };   // the fake owner and markers live with the shared page answer (lib/selfpub/preview-page.mjs)
// One fixed moment for both shots: the greeting and the date line never differ by when they ran.
export const PREVIEW_NOW = new Date('2026-01-05T09:00:00');

// The module path of playwright-core (or playwright) on this node, or '' when there is none.
export function playwrightPath(env = process.env) {
  for (const p of [env.SELFPUB_PLAYWRIGHT, env.PA_PLAYWRIGHT]) if (p && fs.existsSync(p)) return p;
  return '';
}

async function answer(route, root) {
  const u = new URL(route.request().url());
  if (u.origin !== RENDER_ORIGIN) return route.abort();
  const r = previewAnswer(root, u.pathname);   // the same answer the owner's Try it preview gets (R3)
  return route.fulfill({ status: r.status, contentType: r.type, body: r.body });
}

async function shoot(browser, root, out) {
  const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  try {
    if (ctx.clock) await ctx.clock.setFixedTime(PREVIEW_NOW);   // older Playwright has no clock: the greeting may then differ by the hour
    await ctx.addInitScript(() => { try { localStorage.setItem('pa_session', 'render'); } catch { /* blocked storage: the sign-in sheet shows, and the shot says so */ } });
    await ctx.route('**/*', (r) => answer(r, root));
    await ctx.routeWebSocket(/.*/, (ws) => ws.close());   // WebSockets are not routed by route(): closed, never connected (GPT review)
    const errors = [];
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 200)));
    await page.goto(`${RENDER_ORIGIN}/`, { timeout: RENDER_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
    // Wider than the phone: the page scrolls sideways, or (overflow hidden) a shown element that starts on screen
    // runs past its right edge and is cut. An element parked fully off screen (a closed drawer) does not count.
    // Measured against the PHONE's width: a mobile browser zooms a too-wide page out, so innerWidth itself can grow.
    const m = await page.evaluate((w) => {
      const cut = [...document.querySelectorAll('body *')].filter((e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && r.left >= 0 && r.left < w && r.right > w + 1; });
      const box = document.querySelector('#box'), r = box && box.getBoundingClientRect();
      return { scrollWidth: Math.max(document.documentElement.scrollWidth, ...cut.map((e) => Math.ceil(e.getBoundingClientRect().right))), width: w, composer: !!(r && r.width > 0 && r.height > 0),
        hello: (document.querySelector('#hHello') || {}).textContent || '', tiles: document.querySelectorAll('#hStart [data-es], #eApps [data-es]').length };   // the seeded Home really drew
    }, PHONE.width);
    await page.screenshot({ path: out, animations: 'disabled', caret: 'hide' });   // no blink or transition can make two equal pages differ
    return { ...m, errors };
  } finally { await ctx.close(); }
}

export const NOT_VISIBLE = '改动在截图里看不出 · Change not visible in screenshots — 请发布前看改动内容 · check the diff before publishing';
// Same pixels: one Chromium encodes equal pages to equal PNG bytes; any drawn difference changes them.
const samePixels = (a, b) => fs.readFileSync(a).equals(fs.readFileSync(b));

// origin/main's web/ as files in a temp folder (git archive: no checkout switch, the change stays put).
function baseTree(dir) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selfpub-base-'));
  for (const f of git(dir, ['ls-tree', '-r', '-z', '--name-only', 'origin/main', '--', 'web/']).split('\0').filter(Boolean)) {
    const abs = path.join(tmp, f); fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, git(dir, ['show', `origin/main:${f}`]));
  }
  return tmp;
}

// makeRenderer({ shotsDir }) → render(dir, pages, id) → { ok, shots: [before, after], note, measured }, or null (no browser).
export function makeRenderer({ shotsDir, env = process.env, load = (p) => import(pathToFileURL(p).href), deadlineMs = RENDER_DEADLINE_MS } = {}) {
  const mod = playwrightPath(env);
  if (!mod) return null;
  return async function render(dir, pages, id = 'x') {
    let timer, browser = null, over = false;
    const late = new Promise((_, reject) => { timer = setTimeout(() => {   // armed before the launch: a hung launch counts too (GPT review)
      over = true;
      reject(new Error(`截图检查超时 · The render check timed out after ${Math.round(deadlineMs / 1000)} s`));
      if (browser) browser.close().catch(() => { /* already closing: the run below rejects either way */ });
    }, deadlineMs); });
    const run = async () => {
      const pw = await load(mod);
      browser = await pw.chromium.launch({ args: LAUNCH_ARGS, timeout: RENDER_TIMEOUT_MS });
      if (over) { await browser.close().catch(() => { /* closing a browser launched after the deadline */ }); throw new Error('render check timed out'); }
      return both(browser, dir, pages, id);
    };
    try { return await Promise.race([late, run()]); }
    finally { clearTimeout(timer); }
  };
  async function both(browser, dir, pages, id) {
    const base = baseTree(dir);
    try {
      fs.mkdirSync(shotsDir, { recursive: true, mode: 0o700 });
      const before = path.join(shotsDir, `${id}-0.png`), after = path.join(shotsDir, `${id}-1.png`);
      const b0 = await shoot(browser, base, before);
      const m = await shoot(browser, dir, after);
      m.errors = m.errors.filter((e) => !b0.errors.includes(e));   // the fake owner's empty data trips some code on main too: only NEW errors count
      const wide = m.scrollWidth > m.width;
      // A blank or broken Home is not a pass: the page must start without a script error and show the composer (GPT review).
      // Before must draw too: a Before that is an error page makes any After "differ", a vacuous proof (R14, GPT review).
      const broken = !b0.composer ? '改前的主页没有画出来，截图不能对比 · The Before page (origin/main) did not draw, so the shots prove nothing'
        : m.errors.length ? `新的页面脚本错误 · New page script error: ${m.errors[0]}` : !m.composer ? '主页没有显示输入框 · Home did not show the composer' : '';
      // Pixel-identical before and after: the shots prove nothing about the change, so the card says so and does not
      // show them as proof (owner 2026-11-26). Not a failure: a change can be right and not drawn on Home.
      const same = !broken && !wide && samePixels(before, after);
      return { ok: !wide && !broken, same, shots: [before, after], measured: m, pages,
        note: broken || (same ? NOT_VISIBLE : '') || (wide ? `iPhone 宽度下页面横向溢出（${m.scrollWidth}px > ${m.width}px） · The page scrolls sideways at iPhone width (${m.scrollWidth}px > ${m.width}px)` : '') };
    } finally { await browser.close().catch(() => { /* closed by the deadline */ }); fs.rmSync(base, { recursive: true, force: true }); }
  }
}
