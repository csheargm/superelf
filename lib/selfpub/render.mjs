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
import { readShell, fillShellMarkers } from '../shellhtml.mjs';
import { git } from './checkout.mjs';

export const PHONE = { width: 390, height: 844 };
export const RENDER_ORIGIN = 'http://render.invalid';
export const SETTLE_MS = 1500;
export const RENDER_TIMEOUT_MS = 30000;
const LAUNCH_ARGS = ['--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * ~NOTFOUND', '--disable-dev-shm-usage',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--no-first-run'];
// The fake owner the shell boots as, seeded like a real owner's Home (apps, a task count, a greeting) so a
// change to Home has something to show on; the same shapes the real routes return, nothing real. An
// object for a list (the old {} for everything) threw in loadApps and left Home bare: no apps, no greeting.
const app = (name, title, extra = {}) => ({ uid: 'owner', name, title, desc: title, ...extra });
export const FAKE_API = Object.freeze({ '/api/ping': { ok: true, uid: 'owner', role: 'owner', name: 'Owner' },
  '/api/profile': { name: 'Owner', appOrder: [] }, '/api/convos': [], '/api/family-apps': [], '/api/jobs': [], '/api/models': [],
  '/api/apps': [app('bible', '圣经 · Bible'), app('notes', '笔记 · Notes'), app('tasks', '待办 · Tasks', { face: { value: '3', label: 'open' } }),
    app('journal', '日记 · Journal'), app('recipes', '菜谱 · Recipes')] });
// The build markers the live server fills (web.mjs, same helper): fixed values, so a change that shows
// the version or the release date draws it, and before / after differ only by the change.
export const PREVIEW_MARKERS = Object.freeze({ version: 'v0.0.0 · preview', vtime: '', vdate: '2026-01-05' });
// One fixed moment for both shots: the greeting and the date line never differ by when they ran.
export const PREVIEW_NOW = new Date('2026-01-05T09:00:00');
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
  if (u.pathname === '/' || u.pathname === '/index.html') return route.fulfill({ contentType: 'text/html', body: fillShellMarkers(readShell(root), PREVIEW_MARKERS) });
  if (u.pathname.startsWith('/api/')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify(FAKE_API[u.pathname] || {}) });
  const f = u.pathname.startsWith('/web/') ? webFile(path.join(root, 'web'), u.pathname) : null;
  if (!f) return route.fulfill({ status: 404, contentType: 'text/plain', body: '' });
  return route.fulfill({ contentType: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) });
}

async function shoot(browser, root, out) {
  const ctx = await browser.newContext({ viewport: PHONE, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  try {
    if (ctx.clock) await ctx.clock.setFixedTime(PREVIEW_NOW);   // older Playwright has no clock: the greeting may then differ by the hour
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
      // Pixel-identical before and after: the shots prove nothing about the change, so the card says so and does not
      // show them as proof (owner 2026-11-26). Not a failure: a change can be right and not drawn on Home.
      const same = !broken && !wide && samePixels(before, after);
      return { ok: !wide && !broken, same, shots: [before, after], measured: m, pages,
        note: broken || (same ? NOT_VISIBLE : '') || (wide ? `iPhone 宽度下页面横向溢出（${m.scrollWidth}px > ${m.width}px） · The page scrolls sideways at iPhone width (${m.scrollWidth}px > ${m.width}px)` : '') };
    } finally { await browser.close(); fs.rmSync(base, { recursive: true, force: true }); }
  };
}
