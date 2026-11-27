// PASW (web/sw-client.js) — the shell's side of the offline bundle, docs/plans/offline-first.md.
// makeSwClient runs against fakes in the pattern of test/shell-update.test.mjs (a fake worker
// registration, a stepped clock, a frame stub); then the wiring is pinned in the composed shell:
// the shell part, openApp's one call, frameRef under frameSlug/frameUid/frameApp/frameWin, the
// clone that drops a srcdoc page, the boot hand-off, the offline sign-in and app list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SHELL, ROOT, between, stripComments } from './helpers-app.mjs';
import { SHELL_PARTS } from '../lib/shellhtml.mjs';
import { offlineSettings, cspMetaTag, withCspMeta, bibleIndex, OFFLINE_DEFAULTS } from '../lib/offline.mjs';
import { fakeClock } from './helpers-sandbox-app.mjs';

const BLOCK = between(SHELL, '/* ══ PA_SW_CLIENT_BEGIN', 'PA_SW_CLIENT_END ══ */');
assert.ok(BLOCK, 'the PA_SW_CLIENT block is in the composed shell');
const CORE = BLOCK.slice(0, BLOCK.indexOf('const PASW=makeSwClient('));
// eslint-disable-next-line no-new-func
const { makeSwClient, swBuildOf, SW_PROBE_MS, swForgetAppPages, swSignedOut } = new Function(`${CORE}\nreturn { makeSwClient, swBuildOf, SW_PROBE_MS, swForgetAppPages, swSignedOut };`)();
const FOOTER = '管家 · v5.0.0+3 · abc1234 · note deadbeef';

function frameStub() {
  const attrs = {}, el = { src: '', srcdoc: undefined, attrs,
    getAttribute: (n) => (n in attrs ? attrs[n] : null), setAttribute: (n, v) => { attrs[n] = String(v); },
    removeAttribute: (n) => { delete attrs[n]; if (n === 'src') el.src = ''; } };
  return el;
}
// A fake navigator.serviceWorker: register → a registration with an active worker that logs
// what it is posted and answers through the page's message listener, as the browser would.
function harness({ sw = 'yes', waiting = false, controlled = true, config = null, pages = {}, chapterBytes = 10, storage = new Map(), metered = false, now = 0 } = {}) {
  const clock = fakeClock(), log = { posted: [], probes: [], fetched: [] }, fr = frameStub();
  let pageListener = null, msgListeners = [], answer = (m) => m;
  const worker = { postMessage: (m) => { log.posted.push(m); const a = answer(m); if (a) Promise.resolve().then(() => pageListener && pageListener({ data: a })); } };
  const reg = { active: worker, waiting: waiting ? { postMessage: (m) => log.posted.push({ to: 'waiting', ...m }) } : null };
  const fakeSw = sw === 'yes' ? { register: async (u, o) => { log.registered = [u, o]; return reg; }, ready: Promise.resolve(reg), controller: controlled ? {} : null,
    addEventListener: (t, fn) => { if (t === 'message') pageListener = fn; if (t === 'controllerchange') log.onControl = fn; } } : null;
  const d = { sw: fakeSw, loaded: () => FOOTER, frame: () => fr, loadDoc: (f, html) => { f.srcdoc = html; }, loadSrc: (f, url) => { f.src = url; },   // the shell swaps in a fresh frame (web/app-frame.js appFrameLoadDoc): pinned in app-back-e2e
    fetchText: async (u) => { log.fetched.push(u); if (!(u in pages)) throw new Error('HTTP 404'); return pages[u]; },
    fetchJson: async (u) => { log.fetched.push(u); if (!config) throw new Error('HTTP 503'); return config; },
    fetchBytes: async (u) => { log.fetched.push(u); if (chapterBytes instanceof Error) throw chapterBytes; return chapterBytes; },
    probeFrame: (u) => { const p = { url: u, removed: 0, remove: () => { p.removed++; } }; log.probes.push(p); return p; },
    onMessage: (fn) => { msgListeners.push(fn); return () => { msgListeners = msgListeners.filter((f) => f !== fn); }; },
    storage: storage ? { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, v) } : null,
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    metered: () => (typeof metered === 'function' ? metered() : metered), idle: async () => { log.idled = (log.idled || 0) + 1; }, now: () => now };
  const c = makeSwClient(d);
  return { c, d, fr, log, clock, storage, setAnswer: (fn) => { answer = fn; }, probeArrives: () => msgListeners.forEach((f) => f({ pa: 'pa-sw-probe' })) };
}
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
// start() resolves only after the probe: the probe page arrives while it waits.
const started = async (h) => { const p = h.c.start(); await settle(); h.probeArrives(); await p; };

test('the build id comes out of the footer line, whatever the build id carries (git sha, the PANote blob)', () => {
  assert.equal(swBuildOf(FOOTER), 'abc1234 · note deadbeef');
  assert.equal(swBuildOf('管家 · v5.0.0 · abc1234'), 'abc1234');
  assert.equal(swBuildOf('管家 · v5.0.0'), '', 'no build id: nothing to name a cache by');
  assert.equal(swBuildOf(''), '');
});

test('no worker support: the page works as before — src route, nothing registered, prefetch skipped', async () => {
  const h = harness({ sw: 'no' });
  assert.equal(await h.c.start(), 'unsupported');
  assert.equal(h.c.frameLoad('u1', 'bible'), '/app/u1/bible/');
  assert.equal(h.fr.src, '/app/u1/bible/'); assert.equal(h.fr.getAttribute('data-app'), null);
  assert.equal(await h.c.prefetch('u1'), 'skipped');
});

test('start: registers /sw.js at scope /, hands the footer build to the active worker, lets a waiting worker through, then probes', async () => {
  const h = harness({ waiting: true });
  h.setAnswer((m) => (m.kind === 'pa-bundle' ? { kind: 'pa-bundle', ok: true, build: m.build } : null));
  const p = h.c.start();
  await settle();
  assert.deepEqual(h.log.registered, ['/sw.js', { scope: '/' }]);
  assert.deepEqual(h.log.posted, [{ to: 'waiting', kind: 'pa-skip' }, { kind: 'pa-bundle', build: 'abc1234 · note deadbeef' }]);
  assert.equal(h.log.probes.length, 1, 'controlled: the probe frame is up'); assert.equal(h.log.probes[0].url, '/pa-sw-probe');
  h.probeArrives();
  assert.equal(await p, 'ready');
  assert.equal(h.c.route(), 'src', 'the worker served the sandboxed iframe: the frame keeps its src');
  assert.equal(h.log.probes[0].removed, 1);
  assert.equal(h.c.status().bundle, 'ok');
});

test('probe silence by SW_PROBE_MS → the srcdoc route; a bundle failure is kept in status (R5), not swallowed', async () => {
  const h = harness();
  h.setAnswer((m) => (m.kind === 'pa-bundle' ? { kind: 'pa-bundle', ok: false, build: m.build, error: 'Load failed' } : null));
  const p = h.c.start(); await settle();
  h.clock.advance(SW_PROBE_MS - 1); assert.equal(h.c.status().probe, '', 'still waiting');
  h.clock.advance(1);
  assert.equal(await p, 'ready');
  assert.equal(h.c.route(), 'srcdoc');
  assert.deepEqual([h.c.status().bundle, h.c.status().error], ['failed', 'Load failed']);
  assert.equal(SW_PROBE_MS, 3000);
});

test('a worker that never answers the hand-off: start still finishes (SW_REPLY_MS), the probe runs, nothing is assumed', async () => {
  const h = harness();
  h.setAnswer(() => null);
  const p = h.c.start(); await settle();
  assert.equal(h.log.probes.length, 0, 'still waiting for the bundle answer');
  h.clock.advance(3000); await settle();
  assert.equal(h.log.probes.length, 1); h.probeArrives();
  assert.equal(await p, 'ready');
  assert.equal(h.c.status().bundle, '', 'no answer: not ok, not failed — unknown');
});

test('not yet controlled (first ever load): the probe waits for controllerchange', async () => {
  const h = harness({ controlled: false });
  h.setAnswer((m) => (m.kind === 'pa-bundle' ? { kind: 'pa-bundle', ok: true } : null));
  await h.c.start();
  assert.equal(h.log.probes.length, 0);
  h.log.onControl(); await settle();
  assert.equal(h.log.probes.length, 1);
});

test('srcdoc route: data-app names the page at once, src goes, the HTML follows; a frame reused meanwhile is left alone; a failure shows its reason', async () => {
  const h = harness({ pages: { '/app/u1/bible/': '<!doctype html><title>bible</title>', '/app/u1/notes/': '<!doctype html><title>notes</title>' } });
  h.setAnswer((m) => (m.kind === 'pa-bundle' ? { kind: 'pa-bundle', ok: true } : null));
  const p = h.c.start(); await settle(); h.clock.advance(SW_PROBE_MS); await p;
  h.fr.src = '/app/u1/old/';
  h.c.frameLoad('u1', 'bible');
  assert.equal(h.fr.getAttribute('data-app'), '/app/u1/bible/'); assert.equal(h.fr.src, '', 'src removed: the frame must not navigate too');
  assert.equal(h.fr.srcdoc, undefined, 'the page is still in flight');
  h.c.frameLoad('u1', 'notes');   // the user opened another app before the first page arrived
  await settle();
  assert.equal(h.fr.srcdoc, '<!doctype html><title>notes</title>', 'only the page of the app the frame now names');
  assert.deepEqual(h.log.fetched, ['/app/u1/bible/', '/app/u1/notes/']);
  h.c.frameLoad('u1', 'missing'); await settle();
  assert.match(h.fr.srcdoc, /^<!doctype html><meta charset="utf-8"><p>无法打开 · Could not open — HTTP 404<\/p>$/);
  h.c.frameLoad('u1', 'bible'); await settle();   // back to the src-less frame on a good page
  assert.equal(h.fr.srcdoc, '<!doctype html><title>bible</title>');
});

test('src route after a srcdoc page: srcdoc and data-app are removed before src is set', async () => {
  const h = harness();
  h.setAnswer((m) => (m.kind === 'pa-bundle' ? { kind: 'pa-bundle', ok: true } : null));
  const p = h.c.start(); await settle(); h.probeArrives(); await p;
  h.fr.setAttribute('srcdoc', 'x'); h.fr.setAttribute('data-app', '/app/u1/x/');
  h.c.frameLoad('u1', 'bible');
  assert.deepEqual(h.fr.attrs, {}); assert.equal(h.fr.src, '/app/u1/bible/');
});

test('prefetch: config read at the call, the app pages, then every chapter of the corpus; the worker is told the total; a second boot asks and stops', async () => {
  const config = { apps: ['notes', 'bible'], bible_cap_bytes: 1000, bible_prefetch: true, bible: [2, 0, 1] };
  const h = harness({ config, pages: { '/app/u1/notes/': 'n', '/app/u1/bible/': 'b' }, chapterBytes: 100 });
  let done = false;
  h.setAnswer((m) => (m.kind === 'pa-bible-status' ? { kind: 'pa-bible-status', done } : m.kind === 'pa-bible-done' ? ((done = true), null) : { kind: 'pa-bundle', ok: true }));
  await started(h);
  assert.equal(await h.c.prefetch('u1'), 'done');
  assert.deepEqual(h.log.fetched, ['/api/offline-config', '/app/u1/notes/', '/app/u1/bible/', '/api/bible?book=1&chapter=1', '/api/bible?book=1&chapter=2', '/api/bible?book=3&chapter=1']);
  assert.deepEqual(h.log.posted.at(-1), { kind: 'pa-bible-done', bytes: 300 });
  h.log.fetched.length = 0;
  assert.equal(await h.c.prefetch('u1'), 'done');
  assert.deepEqual(h.log.fetched, ['/api/offline-config', '/app/u1/notes/', '/app/u1/bible/'], 'the corpus is complete for this build: no chapter is asked again');
  assert.equal(await h.c.prefetch(''), 'skipped', 'no user: nothing to prefetch');
});

test('prefetch stops short honestly (R14): over the byte cap → "capped", a failed chapter → "failed", no corpus → "no-corpus", no config → "no-config"; never "done"', async () => {
  const capped = harness({ config: { apps: [], bible_cap_bytes: 150, bible: [3] }, chapterBytes: 100 });
  capped.setAnswer((m) => (m.kind === 'pa-bible-status' ? { kind: 'pa-bible-status', done: false } : { kind: 'pa-bundle', ok: true }));
  await started(capped);
  assert.equal(await capped.c.prefetch('u1'), 'capped');
  assert.equal(capped.log.fetched.filter((u) => u.startsWith('/api/bible?')).length, 2, 'the second chapter crossed the cap; the third was never asked');
  assert.ok(!capped.log.posted.some((m) => m.kind === 'pa-bible-done'), 'the worker is NOT told done');
  assert.match(capped.c.status().error, /圣经预取已达字节上限 · Bible prefetch stopped at the byte cap/);
  const failed = harness({ config: { apps: [], bible_cap_bytes: 1e9, bible: [3] }, chapterBytes: new Error('HTTP 500') });
  failed.setAnswer((m) => (m.kind === 'pa-bible-status' ? { kind: 'pa-bible-status', done: false } : { kind: 'pa-bundle', ok: true }));
  await started(failed);
  assert.equal(await failed.c.prefetch('u1'), 'failed'); assert.equal(failed.c.status().error, 'HTTP 500');
  const empty = harness({ config: { apps: [], bible_cap_bytes: 1e9, bible: new Array(66).fill(0) } });
  empty.setAnswer((m) => (m.kind === 'pa-bible-status' ? { kind: 'pa-bible-status', done: false } : { kind: 'pa-bundle', ok: true }));
  await started(empty);
  assert.equal(await empty.c.prefetch('u1'), 'no-corpus');
  const off = harness({ config: { apps: [], bible_prefetch: false, bible: [3] } });
  off.setAnswer(() => ({ kind: 'pa-bundle', ok: true }));
  await started(off);
  assert.equal(await off.c.prefetch('u1'), 'off');
  const none = harness({ config: null });
  none.setAnswer(() => ({ kind: 'pa-bundle', ok: true }));
  await started(none);
  assert.equal(await none.c.prefetch('u1'), 'no-config');
});

test('remember/recall: JSON in localStorage; no storage or a broken entry reads as nothing', () => {
  const h = harness();
  h.c.remember('pa_uid', 'u1'); h.c.remember('pa_apps', [{ name: 'bible' }]);
  assert.equal(h.c.recall('pa_uid'), 'u1'); assert.deepEqual(h.c.recall('pa_apps'), [{ name: 'bible' }]);
  h.storage.set('pa_apps', '{broken');
  assert.equal(h.c.recall('pa_apps'), null);
  const none = harness({ storage: null });
  none.c.remember('pa_uid', 'u1'); assert.equal(none.c.recall('pa_uid'), null);
});

test('the wiring in the composed shell: the part, openApp\'s one call, frameRef under every frame read, the clone, the boot, the offline sign-in and app list', () => {
  const i = SHELL_PARTS.findIndex(([m]) => m === '/* PA_SW_CLIENT_JS */');
  assert.deepEqual(SHELL_PARTS[i], ['/* PA_SW_CLIENT_JS */', 'sw-client.js']);
  assert.ok(i > SHELL_PARTS.findIndex(([m]) => m === '/* PA_UPDATE_JS */'), 'after update.js (both read the footer line)');
  const raw = stripComments(fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8'));
  assert.ok(raw.indexOf('/* PA_UPDATE_JS */') < raw.indexOf('/* PA_SW_CLIENT_JS */') && raw.indexOf('/* PA_SW_CLIENT_JS */') < raw.indexOf('PASW.start();'), 'defined after PAUpdate, before boot calls it');
  assert.match(raw, /function openApp\(uid,slug,title\)\{.*PASW\.frameLoad\(uid,slug\);/, 'openApp loads the frame through PASW');
  assert.equal((raw.match(/\$\('#fr'\)\.src=/g) || []).length, 0, 'no other assignment to the frame\'s src in the shell');
  assert.match(raw, /const frameRef=\(\)=>\{ const fr=\$\('#fr'\); return fr\.getAttribute\('data-app'\)\|\|fr\.src\|\|''; \};/);
  assert.match(raw, /const frameSlug=\(\)=>\(frameRef\(\)\.match\(/); assert.match(raw, /const frameUid=\(\)=>decodeURIComponent\(\(frameRef\(\)\.match\(/);
  const update = stripComments(fs.readFileSync(path.join(ROOT, 'web', 'update.js'), 'utf8'));
  assert.match(update, /const frameApp=\(\)=>\{ const m=frameRef\(\)\.match\(/, 'the app to reopen after an update, on either route');
  assert.match(update, /frameWin:\(\)=>\{ const u=frameRef\(\); return u&&u!=='about:blank'\?\$\('#fr'\)\.contentWindow:null; \}/, 'a srcdoc app is asked before a reload, like a src one');
  const frame = stripComments(fs.readFileSync(path.join(ROOT, 'web', 'app-frame.js'), 'utf8'));
  assert.match(frame, /nu\.removeAttribute\('src'\);\s*nu\.removeAttribute\('srcdoc'\); nu\.removeAttribute\('data-app'\);/, 'the fresh frame never carries the leaving app\'s page, and never navigates');
  assert.match(frame, /function appFrameLoadDoc\(el,html\)\{\s*const nu=el\.cloneNode\(false\);\s*nu\.srcdoc=html;[\s\S]*?el\.replaceWith\(nu\);/, 'a srcdoc page goes in a frame BEFORE it is inserted: no Back entry (WebKit)');
  assert.match(BLOCK, /loadDoc:\(fr,html\)=>appFrameLoadDoc\(fr,html\)/, 'the shell wires it');
  assert.match(frame, /function appFrameLoadSrc\(el,url\)\{\s*const nu=el\.cloneNode\(false\);\s*nu\.src=url;[\s\S]*?el\.replaceWith\(nu\);/, 'a src page goes in a frame BEFORE it is inserted too: a restored #fr adds no Back entry');
  assert.match(BLOCK, /loadSrc:\(fr,url\)=>appFrameLoadSrc\(fr,url\)/, 'the shell wires it');
  assert.match(raw, /PASW\.prefetch\(UID\);/, 'after the loaders settled');
  assert.ok(raw.indexOf('reopenAfterUpdate();') < raw.indexOf('PASW.prefetch(UID);'));
  assert.match(raw, /async function ping\(signal\)\{ if\(!T\) return false; const t0=T; let r; try\{ r=await api\('\/api\/ping',signal\?\{signal\}:\{\}\); \}catch\{ if\(T===t0&&!signal\) PAOffline\.noteNet\(false\); return 'offline'; \}/, 'a thrown fetch is "offline", never a refused token');
  assert.match(raw, /PASW\.remember\(SW_UID_KEY,j\.uid\)/);
  assert.match(raw, /if\(T\)\{ const p=await ping\(\); if\(p===true\|\|\(p==='offline'&&\(UID=PASW\.recall\(SW_UID_KEY\)\)\)\)\{/, 'offline with a remembered sign-in: no login dialog; a 401 online still signs in again');
  assert.match(raw, /if\(Array\.isArray\(apps\)\) PASW\.remember\(SW_APPS_KEY,apps\); \}catch\{ apps=PASW\.recall\(SW_APPS_KEY\)\|\|\[\];/, 'the app list from the last online load');
  assert.match(BLOCK, /probeFrame:\(u\)=>\{ const f=document\.createElement\('iframe'\); f\.setAttribute\('sandbox','allow-scripts'\);/, 'the probe frame is sandboxed like the app frame');
  assert.match(BLOCK, /fetchText:async\(u\)=>\{ const r=await fetch\(u,\{credentials:'same-origin'\}\);/, 'the Path=/app/ cookie travels: an unshared app page needs its author (ADR 0037)');
  assert.match(BLOCK, /return \(await r\.arrayBuffer\(\)\)\.byteLength; \}/, 'the cap counts bytes, not characters');
});

test('lib/offline: the tunables validate and default; the meta CSP drops what a meta tag cannot carry; the corpus index reads the disk', () => {
  assert.deepEqual(offlineSettings(undefined), { apps: ['notes', 'bible'], bible_cap_bytes: 20 * 1024 * 1024, bible_prefetch: true, warm_files: 40 });
  assert.deepEqual(offlineSettings({ apps: ['x'], bible_cap_bytes: '7', bible_prefetch: false, warm_files: 3 }), { apps: ['x'], bible_cap_bytes: 7, bible_prefetch: false, warm_files: 3 });
  assert.throws(() => offlineSettings({ warm_files: 0 }), /warm_files/);
  assert.throws(() => offlineSettings({ apps: 'notes' }), /offline\.apps/);
  assert.throws(() => offlineSettings({ apps: ['../x'] }), /offline\.apps/);
  assert.throws(() => offlineSettings({ bible_cap_bytes: 0 }), /bible_cap_bytes/);
  assert.ok(Object.isFrozen(OFFLINE_DEFAULTS));
  assert.equal(cspMetaTag("sandbox allow-scripts; default-src 'none'; connect-src 'none'; frame-ancestors 'self'"), `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'">`);
  assert.equal(cspMetaTag(''), ''); assert.equal(withCspMeta('<p>x</p>', ''), '<p>x</p>');
  assert.equal(withCspMeta('<html><head><title>t</title></head>', "img-src data:"), '<html><head><meta http-equiv="Content-Security-Policy" content="img-src data:"><title>t</title></head>');
  const T = '<meta http-equiv="Content-Security-Policy" content="img-src data:">';
  assert.equal(withCspMeta('<!doctype html><html><body><p>x</p></body></html>', "img-src data:"), `<!doctype html><html>${T}<body><p>x</p></body></html>`, '<html> but no <head>: right after <html>');
  assert.equal(withCspMeta('<!doctype html><body><p>x</p></body>', "img-src data:"), `<!doctype html>${T}<body><p>x</p></body>`, 'doctype only: right after it, never ahead (quirks mode)');
  assert.equal(withCspMeta('<!-- <head> --><html><head><title>t</title>', "img-src data:"), `<!-- <head> --><html><head>${T}<title>t</title>`, 'a <head> inside a comment is not the anchor (gpt-review)');
  assert.equal(withCspMeta('<html><head data-x=">"><title>t</title>', "img-src data:"), `<html><head data-x=">">${T}<title>t</title>`, 'a > inside a quoted attribute does not end the tag');
  assert.ok(withCspMeta('<script>fetch(1)</script><html><head>', "img-src data:").startsWith(T), 'a script ahead of <head>: the policy goes first');
  assert.equal(withCspMeta('<!DOCTYPE html>\n<HTML lang="en"><HEAD></HEAD></HTML>', "img-src data:"), `<!DOCTYPE html>\n<HTML lang="en"><HEAD>${T}</HEAD></HTML>`, 'case and attributes: still inside <head>');
  assert.equal(withCspMeta('<p>x</p>', "img-src data:"), `${T}<p>x</p>`, 'nothing to anchor on: first in the document');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-bible-'));
  fs.mkdirSync(path.join(dir, 'bsb', 'GEN'), { recursive: true }); fs.mkdirSync(path.join(dir, 'bsb', 'REV'), { recursive: true });
  for (const f of ['1.json', '2.json', 'x.txt']) fs.writeFileSync(path.join(dir, 'bsb', 'GEN', f), '{}');
  fs.writeFileSync(path.join(dir, 'bsb', 'REV', '1.json'), '{}');
  const idx = bibleIndex(dir);
  assert.equal(idx.length, 66); assert.equal(idx[0], 2); assert.equal(idx[65], 1); assert.equal(idx[1], 0);
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(bibleIndex(path.join(dir, 'gone')), new Array(66).fill(0));
  const real = path.join(ROOT, 'bible-data');
  if (fs.existsSync(real)) assert.equal(bibleIndex(real).reduce((a, b) => a + b, 0), 1189, 'the whole corpus: 1,189 chapters');
});

test('sign-out drops every stored app page from the pa-* caches and keeps the shell (ADR 0037)', async () => {
  const mk = (urls) => { const m = new Map(urls.map((u) => [u, 1])); return { keys: async () => [...m.keys()].map((url) => ({ url })), delete: async (r) => m.delete(r.url), m }; };
  const store = { 'pa-abc': mk(['https://x/', 'https://x/app/alice/diary/', 'https://x/app/bob/p/']), other: mk(['https://x/app/keep/']) };
  const n = await swForgetAppPages({ keys: async () => Object.keys(store), open: async (k) => store[k] });
  assert.equal(n, 2);
  assert.deepEqual([...store['pa-abc'].m.keys()], ['https://x/'], 'the shell page stays');
  assert.equal(store.other.m.size, 1, 'a cache that is not ours is untouched');
  assert.equal(await swForgetAppPages(null), 0, 'no Cache API: nothing to do');
});

test('signed-out: both the cache forget and the cookie sign-out run; either failure reaches the caller', async () => {
  const posted = [];
  await swSignedOut(null, async (u) => { posted.push(u); });
  assert.deepEqual(posted, ['/app/-/signout']);
  await assert.rejects(swSignedOut(null, async () => { throw new Error('offline'); }), /offline/);
  let posted2 = 0;
  await assert.rejects(swSignedOut({ keys: async () => { throw new Error('no cache'); } }, async () => { posted2++; }), /no cache/);
  assert.equal(posted2, 1, 'the cookie sign-out still ran');
});
test('the shell enters the signed-out state through swSignedOut: at sign-out and at a boot with no live session', () => {
  assert.match(SHELL, /async function logout\(\)\{[^\n]*swSignedOut\(window\.caches/);
  assert.match(SHELL, /async function ensureToken\(\)\{[^]*?await swSignedOut\(window\.caches[^]*?setup-status/);
});

// F3-15 (owner 2026-11-23): first the book being read + today's reading; the rest only idle and off a metered link.
test('F3-15: the remembered book and today\'s reading go first; the rest follows after idle, never twice', async () => {
  const config = { apps: [], bible_cap_bytes: 1e9, bible: [2, 3, 1] };   // 6 chapters; day 4 → book 2 ch 3
  const storage = new Map([['pa_bible_book', '3']]);
  const h = harness({ config, storage, now: 4 * 86400000 });
  h.setAnswer((m) => (m.kind === 'pa-bible-status' ? { kind: 'pa-bible-status', done: false } : { kind: 'pa-bundle', ok: true }));
  await started(h);
  assert.equal(await h.c.prefetch('u1'), 'done');
  const ch = h.log.fetched.filter((u) => u.startsWith('/api/bible?')).map((u) => u.replace(/.*book=(\d+)&chapter=(\d+)/, '$1:$2'));
  assert.deepEqual(ch.slice(0, 2), ['3:1', '2:3'], 'book 3 (remembered), then the daily chapter');
  assert.deepEqual(ch.slice(2), ['1:1', '1:2', '2:1', '2:2'], 'then the rest, none fetched twice');
  assert.equal(h.log.idled, 1, 'the bulk pass waited for idle');
});
test('F3-15: on a metered link the prefetch stops after the first set — "partial", never "done" (R14)', async () => {
  const h = harness({ config: { apps: [], bible_cap_bytes: 1e9, bible: [2, 3, 1] }, metered: true });
  h.setAnswer((m) => (m.kind === 'pa-bible-status' ? { kind: 'pa-bible-status', done: false } : { kind: 'pa-bundle', ok: true }));
  await started(h);
  assert.equal(await h.c.prefetch('u1'), 'partial');
  const ch = h.log.fetched.filter((u) => u.startsWith('/api/bible?'));
  assert.deepEqual(ch, ['/api/bible?book=1&chapter=1'], 'no remembered book (John is absent from this corpus): only the daily chapter');
  assert.ok(!h.log.posted.some((m) => m.kind === 'pa-bible-done'), 'the worker is NOT told done');
});
test('F3-15: the shell\'s daily chapter is the Bible app\'s dailyRead rule; the broker remembers the book read', () => {
  for (const f of ['workspace/apps/bible/index.html', 'workspace.example/apps/bible/index.html']) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(src, /let idx=Math\.floor\(Date\.now\(\)\/86400000\)%totalChapters[;,]/, `${f}: the rule the shell mirrors`);
  }
  const shell = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  assert.match(shell, /m\.kind==='bible'\)\{\n\s+if\(typeof PASW!=='undefined'&&PASW\.noteBook\) PASW\.noteBook\(m\.book\);/);
  const h = harness(); h.c.noteBook(5); h.c.noteBook('x'); h.c.noteBook(0);
  assert.equal(h.c.recall('pa_bible_book'), 5, 'only a real book number is remembered');
});
