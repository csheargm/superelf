// iPhone 截图 · The core change's render check (docs/adr/0044 §4, owner decision 2026-11-25 (2)). After the
// agent's turn the SERVER renders the shell's Home at iPhone width (390×844) twice — origin/main (before)
// and the checkout (after) — so the reply can say what was looked at, never what was merely hoped.
//
// What runs where:
//   - The page is assembled by THIS node's own lib/shellhtml.mjs (trusted code) from the checkout's web/
//     files; no agent-written server code runs. The page's own JS runs inside headless Chromium only.
//   - Every request is answered from memory: '/' = the assembled shell, /web/* = checkout files, /api/* =
//     a fixed fake owner (FAKE_API). Anything else is aborted. The browser also gets a dead proxy and a
//     resolver that maps every name to nothing, so no request (fetch, WebSocket, image) can leave the box.
//   - The browser: playwright-core + Chromium headless shell, installed in the PRIVATE image only
//     (ops/demo/Dockerfile RENDER_BROWSER). Its module path comes from SELFPUB_PLAYWRIGHT (image) or
//     PA_PLAYWRIGHT (a dev Mac). No browser → null, and lib/selfpub/verify.mjs says so (not ready).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readShell } from '../shellhtml.mjs';
import { git } from './checkout.mjs';

export const PHONE = { width: 390, height: 844 };
export const RENDER_ORIGIN = 'http://render.invalid';
export const SETTLE_MS = 1500;
export const RENDER_TIMEOUT_MS = 30000;
const LAUNCH_ARGS = ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND', '--disable-dev-shm-usage',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--no-first-run'];
// The fake owner the shell boots as: the same fields a real /api/ping returns, nothing real.
export const FAKE_API = Object.freeze({ '/api/ping': { ok: true, uid: 'owner', role: 'owner', name: 'Owner' } });
const TYPES = { '.css': 'text/css', '.js': 'application/javascript', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

// The module path of playwright-core (or playwright) on this node, or '' when there is none.
export function playwrightPath(env = process.env) {
  for (const p of [env.SELFPUB_PLAYWRIGHT, env.PA_PLAYWRIGHT]) if (p && fs.existsSync(p)) return p;
  return '';
}

// A path served from <web dir>, never outside it (a '..' or a symlink out is a 404).
function webFile(webDir, pathname) {
  const rel = decodeURIComponent(pathname.replace(/^\/web\//, ''));
  const abs = path.resolve(webDir, rel);
  if (!abs.startsWith(webDir + path.sep)) return null;
  try { const real = fs.realpathSync(abs); return real.startsWith(fs.realpathSync(webDir) + path.sep) && fs.statSync(real).isFile() ? real : null; }
  catch { return null; /* no such file: the page gets a 404 */ }
}

async function answer(route, root) {
  const u = new URL(route.request().url());
  if (u.origin !== RENDER_ORIGIN) return route.abort();
  if (u.pathname === '/' || u.pathname === '/index.html') return route.fulfill({ contentType: 'text/html', body: readShell(root) });
  if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(FAKE_API[u.pathname] || {}) });
  const f = u.pathname.startsWith('/web/') ? webFile(path.join(root, 'web'), u.pathname) : null;
  if (!f) return route.fulfill({ status: 404, contentType: 'text/plain', body: '' });
  return route.fulfill({ contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
}

async function shoot(browser, root, out) {
  const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  try {
    await ctx.addInitScript(() => { try { localStorage.setItem('pa_session', 'render'); } catch { /* blocked storage: the sign-in sheet shows, and the shot says so */ } });
    await ctx.addInitScript(() => addEventListener('DOMContentLoaded', () => { const st = document.createElement('style'); st.textContent = '.pat-tip{display:none!important}'; document.head.appendChild(st); }));   // first-use tips are not the page
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
      // What the eye sees, without the pixels (a blinking dot or the clock would differ): every shown element's box and look.
      const sig = [...document.querySelectorAll('body *')].map((e) => { const b = e.getBoundingClientRect(); if (!b.width || !b.height) return '';
        const cs = getComputedStyle(e); return [e.tagName, Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height), cs.fontSize, cs.color, cs.backgroundColor, cs.display,
          e.getAttribute('placeholder') || '', e.childElementCount ? '' : (e.textContent || '').slice(0, 200)].join(','); }).join('|');   // words too: a changed placeholder or label is a change (GPT review r2)
      return { scrollWidth: Math.max(document.documentElement.scrollWidth, ...cut.map((e) => Math.ceil(e.getBoundingClientRect().right))), width: w, composer: !!(r && r.width > 0 && r.height > 0), sig };
    }, PHONE.width);
    await page.screenshot({ path: out });
    return { ...m, errors };
  } finally { await ctx.close(); }
}

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
export function makeRenderer({ shotsDir, env = process.env, load = (p) => import(pathToFileURL(p).href) } = {}) {
  const mod = playwrightPath(env);
  if (!mod) return null;
  return async function render(dir, pages, id = 'x') {
    const pw = await load(mod);
    const browser = await pw.chromium.launch({ args: LAUNCH_ARGS, timeout: RENDER_TIMEOUT_MS });
    const base = baseTree(dir);
    try {
      fs.mkdirSync(shotsDir, { recursive: true, mode: 0o700 });
      const before = path.join(shotsDir, `${id}-0.png`), after = path.join(shotsDir, `${id}-1.png`);
      const b0 = await shoot(browser, base, before);
      const m = await shoot(browser, dir, after);
      m.errors = m.errors.filter((e) => !b0.errors.includes(e));   // the fake owner's empty data trips some code on main too: only NEW errors count
      const wide = m.scrollWidth > m.width;
      // A blank or broken Home is not a pass: the page must start without a script error and show the composer (GPT review).
      const broken = m.errors.length ? `新的页面脚本错误 · New page script error: ${m.errors[0]}` : !m.composer ? '主页没有显示输入框 · Home did not show the composer' : '';
      // Same pixels before and after: the change does not show on Home (real-model self-test: a greeting that the
      // fake owner's Home does not draw). Said plainly; not a failure, since a change can be right and invisible here.
      const same = !broken && !wide && m.sig === b0.sig;
      delete m.sig;
      return { ok: !wide && !broken, same, shots: [before, after], measured: m, pages,
        note: broken || (same ? '改前改后截图一样：这个改动在主页（示例数据）上看不出来，请发布前看一下改动内容 · Before and after look the same: the change does not show on Home (sample data); check the diff before publishing' : '') || (wide ? `iPhone 宽度下页面横向溢出（${m.scrollWidth}px > ${m.width}px） · The page scrolls sideways at iPhone width (${m.scrollWidth}px > ${m.width}px)` : '') };
    } finally { await browser.close(); fs.rmSync(base, { recursive: true, force: true }); }
  };
}
