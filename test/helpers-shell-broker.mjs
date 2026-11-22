// The shell's broker (web/index.html), RUN — shared by test/chat-cancel.test.mjs (against a stand-in
// node:http server), test/stationery-design-e2e.test.mjs (against the real web.mjs) and the app-level
// relay in test/helpers-app.mjs (makeRelay). R3: one loader, not two.
// RELAY-CORE (the DOM-free failure mapping) is sliced HERE and nowhere else: loadRelayCore runs it
// alone for the suites that test the mapping, and loadShellBroker runs the same slice in the broker.
//
// FIDELITY (R14): the shell's api(), frameSlug(), NO_APP_TEXT, the app-frame block, RELAY-CORE (with
// the app-origin helper) and the whole broker block are EXTRACTED from the shell as served and run as
// one script. Only what lives outside those slices is supplied: the app frames (`$('#fr')`), fetch
// (pointed at `base`), the session token `T` and loadConvos (the drawer refresh, a no-op here).
import assert from 'node:assert/strict';
import { readShell } from '../lib/shellhtml.mjs';
import { ROOT } from './helpers-stationery.mjs';

export const SHELL = readShell(ROOT);
const cut = (a, b) => { const i = SHELL.indexOf(a), j = SHELL.indexOf(b, i);
  assert.ok(i > 0 && j > i, `the shell still has ${a} … ${b}`); return SHELL.slice(i, j); };
// RELAY-CORE carries the app-origin helper (appAgentInit) and relayBodyBytes as well.
export const RELAY_CORE = cut('/* RELAY-CORE-START', '/* RELAY-CORE-END */');
// web/app-frame.js as inlined: which page a message came from, and the hold of a leaving app (ADR 0018).
export const APP_FRAME = cut('/* ══ APP_FRAME_BEGIN', '/* ══ APP_FRAME_END ══ */');
// web/offline-client.js as inlined, up to the shell's own PAOffline: makeOffline, offDb and the constants.
// The broker's data/save-data hooks and the needs-the-node refusal run through it (offline-first §2/§5).
const OFFLINE_BLOCK = cut('/* ══ PA_OFFLINE_BEGIN', 'PA_OFFLINE_END ══ */');
export const OFFLINE_CORE = OFFLINE_BLOCK.slice(0, OFFLINE_BLOCK.indexOf('const PAOffline=makeOffline('));
assert.ok(OFFLINE_CORE.includes('function makeOffline('), 'the offline core is findable');
// web/offline-merge.js (rule A, pure) and web/offline-sync.js as inlined. The sync's shipped wiring
// (PASync: relayCall over /api/data and /api/save-data, /api/build as the reachability signal) runs
// here as served; only its event sources (document, setInterval, UPDATE_POLL_MS) are stubs.
const whole = (a, b) => cut(a, b) + b;   // cut() stops before the end marker: closed again so the comment does not swallow what follows
export const MERGE_BLOCK = whole('/* ══ PA_MERGE_BEGIN', 'PA_MERGE_END ══ */');
export const SYNC_BLOCK = whole('/* ══ PA_SYNC_BEGIN', 'PA_SYNC_END ══ */');
export const SYNC_CORE = SYNC_BLOCK.slice(0, SYNC_BLOCK.indexOf('const PASync=makeSync('));
assert.ok(SYNC_CORE.includes('function makeSync('), 'the sync core is findable');
// web/offline-origin.js as inlined: the home-node fallback PASync asks (offline-first §6). Its shipped
// wiring (fetch on the public name, then the remembered local one; API_BASE; the footer's build) runs here.
export const ORIGIN_BLOCK = whole('/* ══ PA_ORIGIN_BEGIN', 'PA_ORIGIN_END ══ */');
export const ORIGIN_CORE = ORIGIN_BLOCK.slice(0, ORIGIN_BLOCK.indexOf('const PAOrigin=makeOrigin('));
assert.ok(ORIGIN_CORE.includes('function makeOrigin('), 'the origin core is findable');

// What the core-only suites read back. A name the block stops defining fails here, by name.
const RELAY_CORE_NAMES = ['relayCall', 'relayHttpFail', 'relayNetFail', 'relayBadPath', 'relayText', 'relayFail',
  'relayJson', 'relaySize', 'relayBodyBytes', 'relayB64Bytes', 'relayWhatForFile', 'relayGzipBody', 'RELAY_NOUNS',
  'RELAY_LIMITS', 'RELAY_NOT_FOUND', 'RELAY_TOO_LARGE_MSG', 'RELAY_TOO_LARGE_FILE', 'RELAY_TOO_LARGE_PHOTO',
  'RELAY_GZIP', 'RELAY_GZIP_MIN_BYTES'];

// RELAY-CORE alone, run with the caller's api(). `shadow` replaces a global the block reads, for a
// device that lacks it (save-gzip: no CompressionStream, or one that throws).
export function loadRelayCore(api, shadow = {}) {
  assert.equal(typeof api, 'function', 'RELAY-CORE calls api(); the caller supplies it');
  const keys = Object.keys(shadow);
  const ret = RELAY_CORE_NAMES.map((n) => `${n}:typeof ${n}==='undefined'?undefined:${n}`).join(',');
  // eslint-disable-next-line no-new-func
  const core = new Function('api', ...keys, `${RELAY_CORE}\nreturn {${ret}};`)(api, ...keys.map((k) => shadow[k]));
  for (const n of RELAY_CORE_NAMES) assert.notEqual(core[n], undefined, `RELAY-CORE still defines ${n}`);
  return core;
}

// `out` is everything the broker posted to any app frame; `route` lets a PAChat instance
// (helpers-stationery loadComplete) receive the replies to the requests it posted.
// The app-frame block (web/app-frame.js: which page a message came from, and the hold of a leaving
// one) runs with the broker, on frames that model what the shell's code touches on an iframe. Each
// frame has its own window, so a reply can be told apart by the page that got it (`got`), and a
// removed frame's window takes nothing, as a removed iframe's does. `timers` ({setTimeout, clearTimeout},
// helpers-sandbox-app fakeClock) replaces both for every block here, so a test can step the hold's clock.
// `offline` ({idb, onLine, uid, line, remember, recall, footer}) builds the broker's PAOffline: with no idb (the
// default) it is pass-through, as in a browser without IndexedDB, so every suite sees the network's answer.
// `recall` also answers PAOrigin's wiring (the remembered local_origin) and `footer` is the #ver-lbl text
// it reads the build from; `base` may be '' with an absolute URL in `recall` for the two-origin flow.
export function loadShellBroker(base, { token = 'test-token', app = 'journal', timers = null, offline = {} } = {}) {
  const API = /^let API_BASE='';[^\n]*\nconst api=\(p,opt=\{\}\)=>fetch\(API_BASE\+p,[^\n]*$/m.exec(SHELL);
  assert.ok(API, "the shell's api() with its API_BASE is findable");
  const BUILD_OF = /^const swBuildOf=[^\n]*$/m.exec(SHELL);   // the footer's build id (web/sw-client.js), read by PAOrigin's wiring
  assert.ok(BUILD_OF, "the shell's swBuildOf is findable");
  const FRAME_SLUG = /^const frameRef=\(\)=>[^\n]*\nconst frameSlug=\(\)=>[^\n]*$/m.exec(SHELL);   // the broker names its app by it (frameRef: src, or data-app on the srcdoc route)
  assert.ok(FRAME_SLUG, "the shell's frameSlug() is findable");
  const NO_APP = /^const NO_APP_TEXT=[^\n]*$/m.exec(SHELL);           // the broker's refusal with no slug
  assert.ok(NO_APP, "the shell's NO_APP_TEXT is findable");
  assert.ok(RELAY_CORE.includes('function appAgentInit('), 'the app-origin helper sits inside RELAY-CORE');
  const src = [API[0], FRAME_SLUG[0], NO_APP[0], BUILD_OF[0], APP_FRAME, RELAY_CORE, OFFLINE_CORE,
    'const PAOffline=makeOffline({ db:offlineDeps.idb?offDb(offlineDeps.idb):null, uid:()=>offlineDeps.uid||"u1", now:()=>Date.now(),',
    '  onLine:()=>(offlineDeps.onLine==null?true:offlineDeps.onLine), line:()=>offlineDeps.line||null, fetchJson:async()=>{ throw new Error("no config in the broker harness"); },',
    '  remember:offlineDeps.remember||(()=>{}), recall:offlineDeps.recall||(()=>null), onNet:null });',
    'const PASW={ recall:offlineDeps.recall||(()=>null) };',   // what PAOrigin's wiring borrows from web/sw-client.js
    cut('/* ── Broker (for sandboxed apps) ── */', '/* ── Chat log helpers ── */'),
    MERGE_BLOCK, ORIGIN_BLOCK, SYNC_BLOCK,
    'return { appFrameLeave, held: appFramesHeld, offline: PAOffline, sync: PASync, origin: PAOrigin, base:()=>API_BASE };'].join('\n');
  const out = [], routes = new Map(), listeners = [], frames = [];
  const frameEl = (url) => {
    const el = { id: 'fr', src: url, style: {}, onload: null, onfocus: null, removed: false, got: [] };
    const win = { postMessage: (msg) => { if (el.removed) return; el.got.push(msg); out.push(msg); const r = routes.get(msg.id); if (r) r(msg); } };
    el.contentWindow = win;
    el.cloneNode = () => frameEl(el.src);
    el.removeAttribute = (n) => { if (n === 'id') el.id = ''; else delete el[n]; };
    el.getAttribute = (n) => (n in el ? el[n] : null);   // data-app on the srcdoc route (frameRef); src stays a property here
    el.before = (n) => { n.srcAtInsert = n.src; frames.splice(frames.indexOf(el), 0, n); };   // an iframe starts loading its src when inserted
    el.remove = () => { el.removed = true; el.contentWindow = null; frames.splice(frames.indexOf(el), 1); };
    el.win = win;   // the page's window, kept after removal: what its last messages carry as e.source in WebKit
    return el;
  };
  frames.push(frameEl(`${base}/app/u1/${app}/`));
  const live = () => frames.find((f) => f.id === 'fr');
  const triggers = { online: [], visible: [], poll: [], click: [] };   // what the sync wired itself to (PASync onTrigger)
  const window = { addEventListener: (t, fn) => { if (t === 'message') listeners.push(fn); if (t === 'online') triggers.online.push(fn); } };
  const document = { visibilityState: 'visible', addEventListener: (t, fn) => { if (t === 'visibilitychange') triggers.visible.push(fn); if (t === 'click') triggers.click.push(fn); } };
  const setInterval = (fn, ms) => { triggers.poll.push({ fn, ms }); return 0; };
  const setT = timers ? timers.setTimeout : setTimeout, clearT = timers ? timers.clearTimeout : clearTimeout;
  // eslint-disable-next-line no-new-func
  const shell = new Function('window', 'document', 'setInterval', 'UPDATE_POLL_MS', 'UID', '$', 'fetch', 'T', 'loadConvos', 'setTimeout', 'clearTimeout', 'offlineDeps', src)(window,
    document, setInterval, 15 * 60 * 1000, offline.uid || 'u1',
    (sel) => { if (sel === '#ver-lbl') return { textContent: offline.footer || '' }; assert.equal(sel, '#fr'); return live(); },
    (p, opt) => fetch(/^https?:\/\//.test(p) ? p : base + p, opt), token, () => {}, setT, clearT, offline);   // an absolute URL: the home name (API_BASE)
  assert.ok(listeners.length >= 1, 'the broker registered its message listener');
  // A message as the shell's window receives it, to every listener (a browser delivers it to all).
  const deliver = (source, data) => Promise.all(listeners.map((fn) => fn({ source, data })));
  const post = (m, from = live()) => deliver(from ? from.win : null, { pa: 'req', ...m });
  return { out, post, deliver, frames, live, leave: shell.appFrameLeave, held: shell.held, offline: shell.offline, sync: shell.sync, origin: shell.origin, base: shell.base, triggers,
    route: (m, reply) => { routes.set(m.id, reply); return post(m); },
    reply: (id) => out.find((x) => x.id === id && !x.ev && !x.done),
    done: (id) => out.find((x) => x.id === id && x.done),
    said: (id) => out.filter((x) => x.id === id).map((x) => JSON.stringify(x)).join('\n') };
}
// A held/left page's shell constants, read from the app-frame block (a rename fails loudly), and the
// reply a page got for one request id. Shared by the leave tests (R3).
export const appFrameConstant = (name) => {
  const m = new RegExp(`const ${name}=(\\d+);`).exec(APP_FRAME);
  assert.ok(m, `${name} is a named constant`);
  return Number(m[1]);
};
export const repliedTo = (el, id) => el.got.find((x) => x.pa === 'res' && x.id === id);

// The shell's per-app settings block (appSettingsOf / saveAppSettings / appPromptOf), RUN against a given
// ME and a recording api(): shared by test/app-settings.test.mjs and test/app-prefs.test.mjs (R3: one slice).
// `mutate` rewrites the slice first (mutation controls); it must change something.
export function loadShellAppSettings({ me = {}, respond = async () => ({ ok: true, json: async () => ({ ok: true }) }), mutate } = {}) {
  const from = SHELL.indexOf('const NO_APP_TEXT=');   // the refusal saveAppSettings answers with no slug
  const to = SHELL.indexOf('function sendAppPrefs(');
  assert.ok(from > 0 && to > from, 'the app-settings block is one contiguous block');
  let src = SHELL.slice(from, to);
  if (mutate) { const before = src; src = mutate(src); assert.notEqual(src, before, 'the mutation matched nothing — it would prove nothing'); }
  const calls = [];
  const api = (url, opts) => { calls.push({ url, opts, body: opts && opts.body ? JSON.parse(opts.body) : null }); return respond(url, opts); };
  // eslint-disable-next-line no-new-func
  const fn = new Function('ME', 'api', `${src}; return {appSettingsOf, saveAppSettings, appPromptOf};`);
  return { ...fn(me, api), me, calls };
}
