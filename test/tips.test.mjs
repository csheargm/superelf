// PATips — first-use tips (web/tips.inline.html, ADR 0030). Owner 2026-11-12: "it would be nice to have a guide
// to let user know how to use the new feature the first time". Driven over the REAL component and the REAL
// PAAppPrefs chain, answered by the REAL shell app-settings block (loadShellAppSettings), so "seen" is checked
// all the way to what lands in ME.appPrefs — and that the prompt override survives the write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, scriptOf } from './helpers-app.mjs';
import { loadShellAppSettings } from './helpers-shell-broker.mjs';
import { fakeEl, frames, roStub, obsStub } from './helpers-tips.mjs';

const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const TIPS_SRC = scriptOf(read('web/tips.inline.html'));
const PREFS_SRC = scriptOf(read('web/app-prefs.inline.html'));
const ROWS_SRC = scriptOf(read('web/settings-rows.inline.html'));
const SLUG = 'notes', PROMPT = 'my override';
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };

// One app page (an iframe) for an account `me`: PAAppPrefs + PATips, the shell answering each request on a microtask.
function page(me, { width = 375, height = 812, refuseRead = false, tipsSrc = TIPS_SRC, raf = null, ro = null, mo = null, io = null, tipW = 220 } = {}) {
  const shell = loadShellAppSettings({ me });
  const on = [], writes = [];
  const deliver = (m) => {
    let r = { ok: true };
    if (m.kind === 'app-settings') r = refuseRead ? { ok: false, error: 'offline' } : { ok: true, ...shell.appSettingsOf(SLUG) };
    if (m.kind === 'set-app-settings') { writes.push(m); r = null; }
    return Promise.resolve(r || shell.saveAppSettings(SLUG, m.prefs, m.systemPrompt)).then((x) => on.slice().forEach((f) => f({ data: { pa: 'res', id: m.id, ...x } })));
  };
  const parent = { postMessage: (m) => { if (m && m.pa === 'req') queueMicrotask(() => deliver(m)); } };
  const dh = {}, wh = {};
  const win = { innerWidth: width, innerHeight: height, addEventListener: (t, f) => { if (t === 'message') on.push(f); else (wh[t] = wh[t] || []).push(f); } };
  if (raf) win.requestAnimationFrame = raf;                // a stubbed frame queue, never a real timer
  if (ro) win.ResizeObserver = ro;                         // a stubbed observer the test fires by hand
  if (mo) win.MutationObserver = mo; if (io) win.IntersectionObserver = io;
  const body = fakeEl('body');
  const doc = { body, documentElement: fakeEl('html'), createElement: (t) => fakeEl(t, undefined, tipW), addEventListener: (t, f, cap) => { if (cap) (dh[t] = dh[t] || []).push(f); }, querySelector: () => null };
  const run = (src) => new Function('window', 'document', 'parent', 'setTimeout', 'clearTimeout', src)(win, doc, parent, () => 0, () => {});   // eslint-disable-line no-new-func
  run(PREFS_SRC); run(tipsSrc);
  return { win, doc, body, writes, run, T: win.PATips, fireDoc: (t) => (dh[t] || []).forEach((f) => f({})), fireWin: (t) => (wh[t] || []).forEach((f) => f({})), tip: () => [...doc.documentElement.children, ...body.children].find((c) => c.classList.contains('pat-tip')),
    push: () => on.slice().forEach((f) => f({ data: { pa: 'prefs' } })) };
}
const meWith = (prefs = {}) => ({ appPrefs: { [SLUG]: prefs }, systemPrompts: { apps: { [SLUG]: PROMPT } }, systemPromptDefaults: { apps: {} } });
const anchorAt = (top, left = 20) => fakeEl('button', { top, left, width: 40, height: 30 });
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

test('served: chat-ui carries the tips marker after the app-prefs one; web.mjs registers tips before only PAPaneChrome', () => {
  assert.ok(read('web/chat-ui.inline.html').trimEnd().endsWith('<!--PA_APP_PREFS_UI-->\n<!--PA_TIPS_UI-->'));
  const web = read('web.mjs'), list = web.slice(web.indexOf('const PA_COMPONENTS = ['), web.indexOf('\n];', web.indexOf('const PA_COMPONENTS = [')));
  const files = [...list.matchAll(/file: '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(files.slice(-6), ['tips.inline.html', 'pane-chrome.inline.html', 'app-bar.inline.html', 'bar-handle.css', 'reading-history.inline.html', 'ink-frame.inline.html']);
});

test('first visit shows ONE tip beside the anchor, inside the viewport; dismiss stores the id and keeps the override', async () => {
  const me = meWith({ noteSort: 'created' });
  const p = page(me);
  const a = anchorAt(100);
  p.T.register({ id: 'x-one', anchor: a, text: '一 · One' });
  await flush();
  const t = p.tip();
  assert.ok(t, 'the tip shows on the first visit');
  assert.match(t.children[0].textContent, /一 · One/);
  const r = t.getBoundingClientRect();
  assert.ok(!overlaps(r, a.getBoundingClientRect()), 'never covers its anchor');
  assert.ok(r.left >= 8 && r.right <= 375 - 8 && r.top >= 8 && r.bottom <= 812 - 8, 'inside the phone viewport');
  t.fire('click'); await p.T.whenIdle(); await flush();
  assert.equal(p.tip(), undefined, 'one tap dismisses it');
  assert.deepEqual(me.appPrefs[SLUG], { noteSort: 'created', tipsSeen: ['x-one'] }, 'merged into the app prefs, nothing clobbered');
  assert.equal(me.systemPrompts.apps[SLUG], PROMPT, 'the prompt override survives (PAAppPrefs re-sends it)');

  const p2 = page(me); p2.T.register({ id: 'x-one', anchor: anchorAt(100), text: '一 · One' }); await flush();
  assert.equal(p2.tip(), undefined, 'second visit: no tip');
});

test('anchor at the bottom of an iPad screen: the tip goes above it, clamped to the right edge', async () => {
  const p = page(meWith(), { width: 1024, height: 768 });
  const a = fakeEl('button', { top: 730, left: 1000, width: 20, height: 30 });
  p.T.register({ id: 'x-low', anchor: a, text: '低 · Low' }); await flush();
  const r = p.tip().getBoundingClientRect();
  assert.ok(r.bottom <= 730 && r.right <= 1024 - 8 && !overlaps(r, a.getBoundingClientRect()));
});

test('one at a time: the rest wait for the next open, in registration order', async () => {
  const me = meWith();
  const p = page(me);
  p.T.register({ id: 'q1', anchor: anchorAt(100), text: '一 · First' });
  p.T.register({ id: 'q2', anchor: anchorAt(300), text: '二 · Second' });
  await flush();
  assert.equal([...p.doc.documentElement.children, ...p.body.children].filter((c) => c.classList.contains('pat-tip')).length, 1);
  assert.equal(p.T.current(), 'q1');
  p.tip().fire('click'); await p.T.whenIdle(); p.T.check(); await flush();
  assert.equal(p.tip(), undefined, 'not a second one on the same open');
  const p2 = page(me);
  p2.T.register({ id: 'q1', anchor: anchorAt(100), text: '一 · First' });
  p2.T.register({ id: 'q2', anchor: anchorAt(300), text: '二 · Second' });
  await flush();
  assert.equal(p2.T.current(), 'q2', 'the next open shows the next tip');
});

test('a hidden anchor waits; check() after it appears shows the tip', async () => {
  const p = page(meWith());
  const a = fakeEl('button', { top: 0, left: 0, width: 0, height: 0 });
  p.T.register({ id: 'h', anchor: () => a, text: '隐藏 · Hidden' }); await flush();
  assert.equal(p.tip(), undefined);
  a.rect = { top: 50, left: 10, width: 40, height: 30 }; p.T.check(); await flush();
  assert.equal(p.T.current(), 'h');
});

test('prefs cannot be read: no tip and no write (fail quiet, no repeated nagging)', async () => {
  const p = page(meWith(), { refuseRead: true });
  p.T.register({ id: 'r', anchor: anchorAt(100), text: '读 · R' }); await flush();
  assert.equal(p.tip(), undefined);
  assert.equal(p.writes.length, 0);
});

test('Show tips again: the Settings link drops tipsSeen from the box; after Save the tips show again', async () => {
  const me = meWith({ noteSort: 'created', tipsSeen: ['x-one'] });
  const p = page(me);
  p.run(ROWS_SRC);
  const bd = fakeEl('div'), jTa = fakeEl('textarea'); jTa.value = JSON.stringify(me.appPrefs[SLUG]);
  const rows = p.win.PASettingsRows.mount(bd, jTa);
  assert.ok(rows, 'the section mounts where PATips is on the page');
  const link = bd.children[0].children.find((c) => c.textContent === '重新显示提示 · Show tips again');
  assert.ok(link, 'the bilingual link is in the dialog');
  link.fire('click');
  assert.deepEqual(JSON.parse(jTa.value), { noteSort: 'created' });
  delete me.appPrefs[SLUG].tipsSeen;                       // what Save sends (the box), as the shell stores it
  const p2 = page(me); p2.T.register({ id: 'x-one', anchor: anchorAt(100), text: '一 · One' }); await flush();
  assert.equal(p2.T.current(), 'x-one');
});

test('PATips.reset() clears tipsSeen on the account, other keys and the override kept', async () => {
  const me = meWith({ noteSort: 'created', tipsSeen: ['a', 'b'] });
  const p = page(me); await p.T.reset(); await flush();
  assert.deepEqual(me.appPrefs[SLUG], { noteSort: 'created', tipsSeen: [] });
  assert.equal(me.systemPrompts.apps[SLUG], PROMPT);
});

test('mutation control (R14): a dismissal that writes nothing shows the tip again on the next visit', async () => {
  const src = TIPS_SRC.replace('chain=prefs().patch({[PREF]:all}); return chain;', 'return chain;');
  assert.notEqual(src, TIPS_SRC, 'the mutation matched');
  const me = meWith();
  const p = page(me, { tipsSrc: src }); p.T.register({ id: 'm', anchor: anchorAt(100), text: '米 · M' }); await flush();
  p.tip().fire('click'); await flush();
  const p2 = page(me, { tipsSrc: src }); p2.T.register({ id: 'm', anchor: anchorAt(100), text: '米 · M' }); await flush();
  assert.equal(p2.T.current(), 'm', 'so the real test above is sensitive to the write');
});

// The eight features shipped 2026-11-11/12, each registering its tip in its OWN code with bilingual text.
const FEATURES = [
  ['web/drawer-summary.inline.html', "journal-summarize'", 'TIP_SUMMARIZE'],
  ['web/drawer-tags.inline.html', 'drawer-tags', 'TIP'],
  ['web/drawer-summary.inline.html', 'summary-runs-kept', 'TIP_RUNS'],
  ['web/ink-anchor.inline.html', 'bible-pencil-verses', 'TIP'],
  ['web/ink-pen.inline.html', 'bible-pen', 'TIP'],
  ['web/settings-rows.inline.html', "settings-'+r.key", 'tip'],
  ['web/note-ui.inline.html', 'note-open-mode', 'TIP_OPEN_MODE'],
  ['web/drawer-groups.inline.html', 'drawer-bookmark', 'TIP'],
];
test('each of the 8 recent features registers its tip in its own file, 中文 then English', () => {
  for (const [file, id, name] of FEATURES) {
    const src = read(file);
    assert.ok(src.includes(`PATips.register({id:'${id}`), `${file} registers ${id}`);
    const m = new RegExp(`(?:const |\\b)${name}[=:]'([^']+)'`).exec(src);
    assert.ok(m, `${file} defines ${name} once`);
    const cut = m[1].indexOf(' · '), zh = m[1].slice(0, cut), en = m[1].slice(cut + 3);
    assert.match(zh, /[一-鿿]/u, `${id}: 中文 first`);
    assert.match(en, /^[\x20-\x7e⋯★·“”]+$/u, `${id}: then English`);
  }
  assert.ok(read('web/ink-pen.inline.html').includes("'笔工具：笔、荧光笔、橡皮擦、粗细和颜色 · Pen tools: pen, highlighter, eraser, size and colour'"));
});

// A shown tip follows its anchor (scroll / click / resize), and drops UNSEEN when the anchor is gone.
const FOLLOW_OFF = TIPS_SRC.replace("document.addEventListener('scroll',onScroll,true);", '').replace("document.addEventListener('click',()=>{ follow(); later(check); },true);", "document.addEventListener('click',()=>later(check),true);");
async function shownPage(id, a, opts = {}) {
  const raf = frames(); const p = page(meWith(), { raf, ...opts });
  p.T.register({ id, anchor: () => a, text: '跟 · F' });
  for (let i = 0; i < 4; i++) { await flush(); raf.run(); }   // check, two settle frames, the fade-in
  assert.equal(p.T.current(), id, 'precondition: the tip is shown'); return { p, raf };
}
test('anchor detached (its panel closed): a click drops the tip UNSEEN; check() shows it again when it returns', async () => {
  assert.notEqual(FOLLOW_OFF, TIPS_SRC, 'the R14 mutation matched');
  for (const src of [TIPS_SRC, FOLLOW_OFF]) {
    const a = anchorAt(100); const { p, raf } = await shownPage('d', a, { tipsSrc: src });
    a.isConnected = false; p.fireDoc('click'); raf.run();
    const ok = p.T.current() === null && p.tip() === undefined && !p.T.seen().includes('d');
    if (src === FOLLOW_OFF) { assert.ok(!ok, 'R14: without the fix the tip keeps floating'); continue; }
    assert.ok(ok, 'tip removed, id NOT seen');
    a.isConnected = true; p.T.check(); raf.run(); raf.run(); await flush();
    assert.equal(p.T.current(), 'd', 'shows again when the anchor returns');
  }
});
test('anchor scrolled out of the viewport: tip removed, not seen; one rAF per burst of scrolls', async () => {
  for (const src of [TIPS_SRC, FOLLOW_OFF]) {
    const a = anchorAt(100); const { p, raf } = await shownPage('s', a, { tipsSrc: src });
    a.rect = { top: -200, left: 20, width: 40, height: 30 };
    p.fireDoc('scroll'); p.fireDoc('scroll'); p.fireDoc('scroll');
    if (src === TIPS_SRC) assert.equal(raf.q.length, 1, 'throttled to one pending frame');
    raf.run();
    const ok = p.T.current() === null && p.tip() === undefined && !p.T.seen().includes('s');
    assert.equal(ok, src === TIPS_SRC, src === TIPS_SRC ? 'removed unseen' : 'R14: without the fix it stays');
  }
});
test('anchor scrolled but still visible: the tip is re-placed next to it', async () => {
  for (const src of [TIPS_SRC, FOLLOW_OFF]) {
    const a = anchorAt(100); const { p, raf } = await shownPage('v', a, { tipsSrc: src });
    a.rect = { top: 400, left: 20, width: 40, height: 30 }; p.fireDoc('scroll'); raf.run();
    const top = parseFloat(p.tip().style.top);
    assert.equal(top === 400 + 30 + 6, src === TIPS_SRC, src === TIPS_SRC ? 'below the moved anchor' : 'R14: without the fix it stays put');
  }
});
test('the Bible pencil tip anchors on the first .verse, not the ink canvas or orphan bucket', () => {
  const src = read('web/ink-anchor.inline.html');
  assert.ok(src.includes("PATips.register({id:'bible-pencil-verses',anchor:()=>container.querySelector('.verse'),"));
  assert.ok(!src.includes('container.firstElementChild'), 'R14: the old anchor (first child, may be the canvas) is gone');
});

// Browser bug 2026-11-12 (Chrome 1160px, Journal): the note-open-mode tip was placed while the drawer slid,
// off the right edge and squeezed tall and narrow. Each test below fails with its part of the fix reverted.
const NO_RO = TIPS_SRC.replace('cur={t,el,tip,ro:observe(el)}', 'cur={t,el,tip,ro:null}');
test('anchor moved by a layout change (no resize event): the observer re-places the tip under it, in the viewport', async () => {
  assert.notEqual(NO_RO, TIPS_SRC, 'the R14 mutation matched');
  for (const src of [TIPS_SRC, NO_RO]) {
    const RO = roStub(), a = fakeEl('button', { top: 100, left: -500, width: 520, height: 30 });
    const { p, raf } = await shownPage('lay', a, { tipsSrc: src, ro: RO, width: 1160, height: 800 });
    a.rect = { top: 200, left: 700, width: 80, height: 30 };   // the drawer finished sliding
    RO.fire(); RO.fire(); raf.run();
    const r = p.tip().getBoundingClientRect();
    const ok = r.top === 236 && r.left === 700 && r.right <= 1160 - 8;
    assert.equal(ok, src === TIPS_SRC, src === TIPS_SRC ? 'under the anchor, inside the viewport' : 'R14: without the observer it stays put');
    if (src === TIPS_SRC) { p.tip().fire('click'); assert.ok(RO.all.every((o) => !o.els.length), 'observer disconnected on dismiss'); }
  }
});
test('transitionend from an ancestor re-places the tip', async () => {
  const a = anchorAt(100); const { p, raf } = await shownPage('te', a);
  a.rect = { top: 300, left: 20, width: 40, height: 30 }; p.fireDoc('transitionend'); raf.run();
  assert.equal(parseFloat(p.tip().style.top), 336);
});
const NO_MAXW = TIPS_SRC.replace("tip.style.width=w+'px'; tip.style.maxWidth=w+'px'; ", '');
test('a long tip never exceeds the viewport width and stays inside it', async () => {
  assert.notEqual(NO_MAXW, TIPS_SRC, 'the R14 mutation matched');
  for (const src of [TIPS_SRC, NO_MAXW]) {
    const p = page(meWith(), { width: 300, tipW: 600, tipsSrc: src });
    p.T.register({ id: 'w', anchor: anchorAt(100, 250), text: '宽 · W' }); await flush();
    const r = p.tip().getBoundingClientRect();
    assert.equal(r.left >= 8 && r.right <= 300 - 8, src === TIPS_SRC, src === TIPS_SRC ? 'inside' : 'R14: without the cap it overflows');
  }
});
const ONE_FRAME = TIPS_SRC.replace('later(()=>later(()=>{ waiting=false;', 'later((()=>{ waiting=false;');
test('the first show waits two animation frames after register', async () => {
  assert.notEqual(ONE_FRAME, TIPS_SRC, 'the R14 mutation matched');
  for (const src of [TIPS_SRC, ONE_FRAME]) {
    const raf = frames(); const p = page(meWith(), { raf, tipsSrc: src });
    p.T.register({ id: 'f2', anchor: anchorAt(100), text: '帧 · F' }); await flush();
    raf.run(); raf.run();                                   // check(), then one frame
    assert.equal(p.tip() === undefined, src === TIPS_SRC, src === TIPS_SRC ? 'not yet after one frame' : 'R14: one frame shows early');
    raf.run(); assert.equal(p.T.current(), 'f2', 'shown after the second frame');
  }
});
// Browser bug 2026-11-12: docked note list → the tip sat 320px right of the Draw/Text tabs. R14 per part below.
const NO_DX = TIPS_SRC.replace("Math.round(left-dx)", 'Math.round(left)'), NO_W = TIPS_SRC.replace("tip.style.width=w+'px'; ", '');
const ON_BODY = TIPS_SRC.replace('(document.documentElement||document.body).appendChild(tip)', 'document.body.appendChild(tip)');
test('containing block offset 320px: style.left = 605-320, visual left = anchor; tip on <html>, width 320', async () => {
  for (const src of [NO_DX, ON_BODY, NO_W]) assert.notEqual(src, TIPS_SRC, 'the R14 mutation matched');
  for (const src of [TIPS_SRC, NO_DX]) for (const cb of [{ left: 320, top: 0 }, null]) {
    const p = page(meWith(), { width: 1160, height: 647, tipsSrc: src }); p.doc.documentElement.cb = cb;
    p.T.register({ id: 'cb', anchor: anchorAt(60, 605), text: 'C' }); await flush(); const t = p.tip(), r = t.getBoundingClientRect();
    assert.equal(parseFloat(t.style.left), cb && src === TIPS_SRC ? 285 : 605, 'style.left relative to the containing block');
    assert.equal(r.left === 605, !cb || src === TIPS_SRC, 'visual left = anchor (R14: NO_DX shifts it right)'); assert.equal(r.width, 320);
  }
  for (const src of [TIPS_SRC, ON_BODY, NO_W]) {
    const p = page(meWith(), { width: 1160, tipsSrc: src, tipW: 90 }); p.body.cb = { left: 320, top: 0 };
    p.T.register({ id: 'nb', anchor: anchorAt(60, 605), text: 'N' }); await flush(); const t = p.tip(), good = t.parentNode === p.doc.documentElement && t.getBoundingClientRect().width === Math.min(320, 1160 - 16);
    assert.equal(good, src === TIPS_SRC, src === TIPS_SRC ? 'on <html>, explicit width' : 'R14: mutation must fail');
  }
});
// Browser bug 2026-11-12: a tip registered before its anchor rendered waited for an unrelated click.
const NO_WATCH = TIPS_SRC.replace('if(!next()){ watch(); return; }', 'if(!next()) return;');
test('anchor rendered after register: the observers re-check, the tip shows with no click; observers disconnected', async () => {
  assert.notEqual(NO_WATCH, TIPS_SRC, 'the R14 mutation matched');
  for (const src of [TIPS_SRC, NO_WATCH]) {
    const raf = frames(), MO = obsStub(), IO = obsStub(), p = page(meWith(), { raf, mo: MO, io: IO, tipsSrc: src });
    p.T.register({ id: 'late', anchor: '.tag-strip', text: '晚 · L' });
    for (let i = 0; i < 3; i++) { await flush(); raf.run(); }
    assert.equal(p.tip(), undefined, 'no anchor yet: no tip');
    const a = anchorAt(100); p.body.appendChild(a); p.doc.querySelector = (q) => (q === '.tag-strip' ? a : null);
    MO.fire(); MO.fire(); for (let i = 0; i < 4; i++) { await flush(); raf.run(); }
    if (src === NO_WATCH) { assert.equal(p.T.current(), null, 'R14: without the observers it waits for a click'); continue; }
    assert.equal(p.T.current(), 'late', 'shown with no click');
    assert.ok(MO.all.length === 1 && [...MO.all, ...IO.all].every((o) => !o.els.length), 'one body observer, all disconnected after show');
  }
});

// priority (owner 2026-11-13): "Home and text size live here now" waited behind older unseen tips, one per
// open, so a returning user hunted for Home. A priority tip goes first; the default order is unchanged.
test('priority: a priority tip shows ahead of older unseen tips, even one already on screen; default order unchanged', async () => {
  const p = page(meWith());
  p.T.register({ id: 'old-a', anchor: anchorAt(100), text: '甲 · A' });
  p.T.register({ id: 'old-b', anchor: anchorAt(200), text: '乙 · B' });
  await flush();
  assert.equal(p.T.current(), 'old-a', 'control: without priority, registration order');
  p.T.register({ id: 'home', anchor: anchorAt(300), text: '主页 · Home', priority: true });
  await flush();
  assert.equal(p.T.current(), 'home', 'the priority tip replaces the ordinary one this open');
  assert.deepEqual(p.T.seen(), [], 'the replaced tip was NOT marked seen: it shows on a later open');
  assert.deepEqual(p.T.registered().map((r) => r.id), ['home', 'old-a', 'old-b'], 'queued first');
  const q = page(meWith());
  q.T.register({ id: 'home', anchor: anchorAt(300), text: '主页 · Home', priority: true });
  q.T.register({ id: 'old-a', anchor: anchorAt(100), text: '甲 · A' });
  await flush();
  assert.equal(q.T.current(), 'home', 'registered first or last, it shows first');
});

test('priority: the app bar registers its Home tip with priority', () => {
  assert.ok(read('web/app-bar.inline.html').includes("PATips.register({id:'app-own-bar',anchor:()=>home,text:TIP,priority:true})"));
});

// R3 review 2026-11-13: a priority tip registering AFTER an ordinary tip was shown and dismissed this open
// used to free the slot, so two tips showed in one open. It now waits for the next open.
test('priority: after a tip was dismissed this open, a late priority tip waits for the next open (one per open)', async () => {
  const p = page(meWith());
  p.T.register({ id: 'old-a', anchor: anchorAt(100), text: '甲 · A' });
  await flush();
  assert.equal(p.T.current(), 'old-a');
  p.tip().fire('click'); await p.T.whenIdle(); await flush();
  p.T.register({ id: 'home', anchor: anchorAt(300), text: '主页 · Home', priority: true });
  await flush();
  assert.equal(p.tip(), undefined, 'no second tip this open');
  const q = page(meWith({ tipsSeen: ['old-a'] }));
  q.T.register({ id: 'home', anchor: anchorAt(300), text: '主页 · Home', priority: true });
  await flush();
  assert.equal(q.T.current(), 'home', 'it shows on the next open');
});
