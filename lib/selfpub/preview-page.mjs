// 预览页 · The ONE answer for a copy's page, shared by the render check (lib/selfpub/render.mjs, headless
// Chromium) and the owner's 试用 · Try it preview (lib/selfpub/try.mjs, the owner's own browser) — R3.
//   '/'      = the copy's shell, assembled by THIS node's trusted builder (lib/shellhtml.mjs) from the
//              copy's web/ files and parts list (web/shell-parts.json); no agent-written server code runs;
//   /web/*   = a file of the copy's web/, never outside it;
//   /api/*   = a fixed fake owner (FAKE_API), whatever the method. Nothing real is read or written.
// `prefix` is where the page lives ('' for the render check, /selfpub-try/<token> for the preview); with
// a prefix the page also gets PREVIEW_PREAMBLE first, which points the shell's /api calls at the fake.
import fs from 'node:fs';
import path from 'node:path';
import { readShell, fillShellMarkers } from '../shellhtml.mjs';
import { assertPlainCopy } from '../shell-parts.mjs';

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
const TYPES = { '.css': 'text/css', '.js': 'application/javascript', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

// A path served from <web dir>, never outside it (a '..' or a symlink out is a 404).
export function webFile(webDir, rel) {
  let name; try { name = decodeURIComponent(rel); } catch { return null; /* a bad %-escape: the page gets a 404 */ }
  const abs = path.resolve(webDir, name);
  if (!abs.startsWith(webDir + path.sep)) return null;
  try { const real = fs.realpathSync(abs); return real.startsWith(fs.realpathSync(webDir) + path.sep) && fs.statSync(real).isFile() ? real : null; }
  catch { return null; /* no such file: the page gets a 404 */ }
}

// Runs first in the preview page (an opaque origin: the iframe sandbox has no allow-same-origin):
//   - storage that the opaque origin refuses becomes an in-memory store, so the shell boots instead of throwing;
//   - service workers, CacheStorage and IndexedDB are absent (they throw there), as on a browser without them;
//   - WebRTC is removed (CSP does not cover it): best effort, a page could find it again in another realm;
//   - '/api/…' requests go to the fake under the prefix. This is convenience only: the WALL is the CSP
//     (lib/selfpub/try.mjs), which refuses every other connection whatever the page's code does.
export function previewPreamble(prefix) {
  const P = JSON.stringify(prefix).replace(/</g, '\\u003c');
  return `<script>(()=>{const P=${P};
const mem=()=>{const m=new Map();return{getItem:(k)=>m.has(String(k))?m.get(String(k)):null,setItem:(k,v)=>{m.set(String(k),String(v));},removeItem:(k)=>{m.delete(String(k));},clear:()=>m.clear(),key:(i)=>[...m.keys()][i]??null,get length(){return m.size;}};};
for(const n of ['localStorage','sessionStorage']){let ok=false;try{ok=!!window[n];}catch{ok=false;/* opaque origin: refused, replaced below */}if(!ok)Object.defineProperty(window,n,{configurable:true,value:mem()});}
if(self.origin==='null')for(const n of ['caches','indexedDB'])Object.defineProperty(window,n,{configurable:true,value:undefined});
try{delete Navigator.prototype.serviceWorker;}catch{/* not configurable: sw-client sees it and its own guard applies */}
for(const n of ['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCSessionDescription'])try{delete window[n];}catch{/* kept: the CSP still holds fetch; WebRTC is a known limit (docs/adr/0049) */}
localStorage.setItem('pa_session','preview');
const fix=(u)=>typeof u==='string'&&u.startsWith('/api/')?P+u:u;
const f=window.fetch.bind(window);window.fetch=(u,o)=>f(u instanceof URL?fix(u.pathname+u.search):fix(u),o);
})();</script>`;
}

// First-use tips are not the page: a change is judged on what it draws, and the shell's tips (whose 'seen'
// list the fake owner does not have) would cover it. Both the render check and the preview hide them.
export const HIDE_TIPS = '<style>.pat-tip{display:none!important}</style>';

// → { status, type, body } for one request path of the copy at `root`.
export function previewAnswer(root, pathname, { prefix = '' } = {}) {
  const p = prefix && pathname.startsWith(prefix) ? pathname.slice(prefix.length) || '/' : pathname;
  if (p === '/' || p === '/index.html') {
    let html;
    // A copy whose shell cannot be built (a bad parts list, a missing marker) says why on the page itself:
    // the render check then reports no composer, and the owner's preview shows the reason (R5).
    try { assertPlainCopy(root); html = fillShellMarkers(readShell(root), PREVIEW_MARKERS); }
    catch (e) { return { status: 500, type: 'text/plain; charset=utf-8', body: `外壳无法组装 · The shell could not be built: ${e.message}` }; }
    const first = (prefix ? previewPreamble(prefix) : '') + HIDE_TIPS;
    html = /<head(\s[^>]*)?>/i.test(html) ? html.replace(/<head(\s[^>]*)?>/i, (h) => h + first) : first + html;
    return { status: 200, type: 'text/html; charset=utf-8', body: html };
  }
  if (p.startsWith('/api/')) return { status: 200, type: 'application/json', body: JSON.stringify(FAKE_API[p] || {}) };
  let plain = true; try { assertPlainCopy(root); } catch { plain = false; /* a linked web/: no file is served from it (the page itself says why) */ }
  const f = plain && p.startsWith('/web/') ? webFile(path.join(root, 'web'), p.slice('/web/'.length)) : null;
  if (!f) return { status: 404, type: 'text/plain', body: '' };
  return { status: 200, type: TYPES[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) };
}
