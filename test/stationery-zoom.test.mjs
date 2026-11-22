// The 信纸 studio's draft, enlarged · 点按放大 (web/stationery-picker.inline.html, loaded from the SHIPPED file)
//
// OWNER REQUEST (2026-10-12): "can I click the generated template to see more detail — right now it's too
// small". The AI draft preview is a 120x155 canvas. Tapping it now opens the CURRENT draft, rasterized
// afresh at screen width through PAStationery's own thumb path, in chat-ui's ONE lightbox (PAChat.lightbox —
// the chat's own function, exposed, not copied). Bundled/My template thumbnails keep their job: a tap
// chooses the page background. The 🖼 panel's canvas shows the person's own photo, never a draft, so it is
// not zoomable; a "Recreate with AI" draft lands in the same draft box and zooms like any other.
//
// Fidelity (R14): the picker runs on the minimal DOM (FakeEl) of test/helpers-stationery.mjs; chat-ui is
// the WHOLE shipped script run on a recording DOM (loadChatUi); note-ui's popover outside-tap handler is
// the shipped one, extracted and installed (helpers-flip-settle installPopOutside); the paper colour is
// note-ui's own paperColor, extracted and run. Canvas encoding is faked: toDataURL names the size, the
// top-left pixel (replayed by Canvas 2D's opaque-paint rules) and the source drawn, so a URL is traceable to
// a draft, a width and a ground. What is NOT proved here: real pixels. Those were probed in Chromium: the
// lightbox closing on tap while note-ui swallows the pointerdown (a capture-phase preventDefault +
// stopPropagation does not stop click), and a background-less draft's corner after the paper composite.
// Every studio is ended in t.after (mountStudio's end): a failing assert mid-run must not leave the run's
// real ticker alive, or node --test never exits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PICKER_HTML, loadStationery, withDesigns, loadStudio, loadPicker, mountStudio, loadChatUi, FakeEl, svg } from './helpers-stationery.mjs';
import { installPopOutside } from './helpers-flip-settle.mjs';
import { ENGINE } from './helpers-panote-routing.mjs';
import { settle } from './helpers-timing.mjs';

const PINK = svg('<rect width="816" height="1056" fill="#fffaf2"/><circle cx="60" cy="60" r="30" fill="#f2b8c6"/>');
const BLUE = svg('<rect width="816" height="1056" fill="#fffaf2"/><circle cx="60" cy="60" r="30" fill="#1e90ff"/>');
const ZOOM_HINT = 'Tap to enlarge · 点按放大';
const PAGE_W = 816, PAGE_H = 1056;
// A data URL from the fake encoder -> {w, h, color of the draft drawn into it}.
const traced = (url) => { const m = /^data:image\/png;w=(\d+);h=(\d+);corner=[^;]+;of=(.*)$/.exec(url); assert.ok(m, `an encoded raster: ${url.slice(0, 60)}`);
  const color = /fill="(#1e90ff|#f2b8c6)"/.exec(decodeURIComponent(m[3])); return { w: +m[1], h: +m[2], color: color && color[1] }; };
// A studio ended when the test ends, pass or fail; `win` sets the page's window, `opts` the host's mount options.
const studio = (t, mutate, win, opts) => { const s = mountStudio(mutate, undefined, undefined, win, opts); t.after(s.end); return s; };
// The studio with a spy lightbox on the page; `win` sets the screen.
const withSpy = (t, win = {}, mutate, opts) => { const shown = [];
  return { ...studio(t, mutate, { PAChat: { lightbox: (u) => shown.push(u) }, ...win }, opts), shown }; };
const design = async (s, text = PINK) => { s.btn('✨').click(); s.btn('Design ·').click(); s.pending.at(-1).res({ ok: true, text, convoId: 'c1' }); await settle(); };
const tweak = (s) => { s.host.querySelectorAll('input').find((i) => String(i.placeholder).startsWith('What to change')).value = 'bluer'; s.btn('Tweak ·').click(); };

test('tap the draft preview: ONE lightbox, the CURRENT draft, rasterized at screen width — not the 120 px preview', async (t) => {
  for (const [innerWidth, devicePixelRatio, w] of [[390, 3, 1170], [1440, 2, 2 * PAGE_W]]) {   // a phone; a wide screen hits the 2-page cap
    const s = withSpy(t, { innerWidth, devicePixelRatio });
    await design(s);
    assert.equal(s.drawn(), true, 'precondition: the draft is shown');
    assert.ok(s.prev.classList.contains('pst-zoom'), 'zoom-in cursor');
    assert.deepEqual([s.prev.title, s.prev.attrs['aria-label'], s.prev.attrs.role], [ZOOM_HINT, ZOOM_HINT, 'button'], 'the bilingual hint');
    s.prev.click(); await settle();
    assert.equal(s.shown.length, 1, 'one tap, one lightbox');
    assert.deepEqual(traced(s.shown[0]), { w, h: Math.round(w * PAGE_H / PAGE_W), color: '#f2b8c6' }, `${innerWidth}px @${devicePixelRatio}x`);
    tweak(s); s.pending.at(-1).res({ ok: true, text: BLUE, convoId: 'c1' }); await settle();
    s.prev.click(); await settle();
    assert.equal(traced(s.shown[1]).color, '#1e90ff', 'after a tweak, the tweaked draft — not the first one');
    assert.equal(s.pending.length, 2, 'the taps asked the AI nothing');
  }
});
test('no draft, no lightbox: before any design, while the first design is in flight, and after a reset', async (t) => {
  const s = withSpy(t, { innerWidth: 390 });
  s.prev.click(); await settle();
  s.btn('✨').click(); s.btn('Design ·').click();
  s.prev.click(); await settle();
  assert.equal(s.pending[0].o.signal.aborted, false, 'the run was not disturbed'); assert.equal(s.btn('Design ·').disabled, true);
  s.pending[0].res({ ok: true, text: PINK, convoId: 'c1' }); await settle();
  s.btn('🖼').click();   // the other panel: a draft belongs to the panel that made it, so this resets it
  s.prev.click(); await settle();
  assert.equal(s.shown.length, 0);
});
test('mid-run: a tap during a tweak shows the CURRENT draft and leaves the run, busy and Cancel exactly as they were', async (t) => {
  const s = withSpy(t, { innerWidth: 390 });
  await design(s); tweak(s);
  const before = [s.say(), s.btn('Design ·').disabled, s.btn('Cancel ·').style.display, s.pending.length];
  s.prev.click(); await settle();
  assert.equal(traced(s.shown[0]).color, '#f2b8c6', 'the draft on screen, while the tweak works');
  assert.deepEqual([s.say(), s.btn('Design ·').disabled, s.btn('Cancel ·').style.display, s.pending.length], before);
  assert.equal(s.pending[1].o.signal.aborted, false, 'the tweak is still live');
  s.pending[1].res({ ok: true, text: BLUE, convoId: 'c1' }); await settle();
  assert.equal(s.btn('Design ·').disabled, false, 'and it finished normally');
  s.prev.click(); await settle();
  assert.equal(traced(s.shown[1]).color, '#1e90ff');
});
test('CONTROL: a template thumbnail tap chooses the background and never zooms', async () => {
  const S = withDesigns(loadStationery()), shown = [], chosen = [];
  const { picker } = loadPicker(S, loadStudio(S), { win: { PAChat: { lightbox: (u) => shown.push(u) }, innerWidth: 390 } });
  const host = new FakeEl('div'), list = new FakeEl('div'); host.append(list);
  picker.mount(list, { current: () => null, choose: (r) => chosen.push(r), studio: { ai: async () => ({}), store: {}, upload: async () => ({}) } });
  const th = host.querySelectorAll('.pst-th');
  assert.ok(th.length > 0, 'precondition: the bundled designs are listed');
  th[0].click(); await settle();
  assert.deepEqual(chosen, [{ id: th[0].dataset.id, source: th[0].dataset.src }], 'it chose the page background');
  assert.equal(shown.length, 0, 'and opened no lightbox');
  for (const b of th) assert.ok(!b.title.includes(ZOOM_HINT) && !b.children[0].classList.contains('pst-zoom'), 'no zoom hint on a thumbnail');
});
test('no PAChat on the page: the preview is not zoomable and a tap is harmless', async (t) => {
  const s = studio(t, undefined, { innerWidth: 390 });
  await design(s);
  assert.equal(s.prev.classList.contains('pst-zoom'), false); assert.notEqual(s.prev.title, ZOOM_HINT);
  assert.doesNotThrow(() => s.prev.click());
  await settle();
});
test('MUTATION: zooming the preview raster (120 px) instead of a screen-width one gives 360 px on a 3x phone', async (t) => {
  const s = withSpy(t, { innerWidth: 390, devicePixelRatio: 3 }, (src) => src.replace("S.thumb({id:'draft',svg},zoomW())", "S.thumb({id:'draft',svg},PREV_W*dpr())"));
  await design(s); s.prev.click(); await settle();
  assert.equal(traced(s.shown[0]).w, 360, 'the width assertion above can see a blown-up thumbnail');
});

// ── Keyboard: the preview is a role=button, so Enter and Space open it like a tap ───────────
const KEYDOWN = " cv.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); zoom(); } });";
const press = (el, key) => { let prevented = 0; for (const fn of el.on.keydown || []) fn({ key, preventDefault: () => { prevented++; } }); return prevented; };
test('keyboard: Enter and Space each open the lightbox once; Space does not scroll the page; Tab still moves on', async (t) => {
  const s = withSpy(t, { innerWidth: 390 });
  await design(s);
  assert.equal(s.prev.tabIndex, 0, 'the preview is reachable with Tab');
  assert.equal(press(s.prev, 'Enter'), 1, 'Enter is handled'); await settle();
  assert.equal(s.shown.length, 1, 'Enter opened it once');
  assert.equal(press(s.prev, ' '), 1, 'Space: preventDefault — the page under the studio does not scroll'); await settle();
  assert.equal(s.shown.length, 2, 'Space opened it once');
  assert.equal(press(s.prev, 'Tab'), 0, 'Tab is not swallowed: focus moves on'); await settle();
  assert.equal(s.shown.length, 2, 'and opens nothing');
});
test('MUTATION: without the keydown listener, Enter and Space open nothing', async (t) => {
  const s = withSpy(t, { innerWidth: 390 });
  const m = withSpy(t, { innerWidth: 390 }, (src) => src.replace(KEYDOWN, ''));
  for (const x of [s, m]) { await design(x); press(x.prev, 'Enter'); press(x.prev, ' '); await settle(); }
  assert.deepEqual([s.shown.length, m.shown.length], [2, 0], 'the keyboard test above can see a deleted listener');
});

// ── The enlarged draft sits on the PAGE's paper, not on the lightbox's black ────────────────
// PANote's own paperColor — the colour drawPaper fills the page with — extracted from note-ui and run as the
// host's paper() hook (R3: the colour is read from its one source, never restated here).
const PAPER_FN = /\n    (function paperColor\(\)\{[^\n]*?\})/.exec(ENGINE)[1];
const PAPER_WHITE = /const PAPER_BGS=\[\['White','(#[0-9a-f]{6})'\]/.exec(ENGINE)[1], PAPER_BLUE = /\['Blue','(#[0-9a-f]{6})'\]/.exec(ENGINE)[1];
// eslint-disable-next-line no-new-func
const notePaper = (bgColor) => new Function('NB', 'PAPER_WHITE', `${PAPER_FN}\nreturn paperColor;`)({ bgColor }, PAPER_WHITE);
const CLEAR = svg('<circle cx="60" cy="60" r="30" fill="#f2b8c6"/>');   // decorations only: no full-page background
const ground = (url) => /;corner=([^;]+);/.exec(url)[1];   // the enlarged picture's top-left pixel; 'none' = transparent
const zoomOn = async (t, draft, opts, mutate) => { const s = withSpy(t, { innerWidth: 390 }, mutate, opts);
  await design(s, draft); s.prev.click(); await settle(); assert.equal(s.shown.length, 1); return ground(s.shown[0]); };
test('PANote hands the picker the colour it paints the page with', () => {
  assert.match(ENGINE, /STN\.picker\(q\('\.pst-list'\),\{[^\n]*,paper:paperColor,studio:opts\.stationery\}\);/, 'the mount passes paperColor');
  assert.match(ENGINE, /ctx\.fillStyle=bg\|\|paperColor\(\);/, 'and drawPaper fills the page with paperColor');
  assert.deepEqual([notePaper(undefined)(), notePaper(PAPER_BLUE)()], [PAPER_WHITE, PAPER_BLUE], 'the default, else the notebook’s own');
});
test('a draft with no background enlarges on the page’s paper (default or tinted), opaque — not light marks on black', async (t) => {
  for (const bg of [undefined, PAPER_BLUE]) assert.equal(await zoomOn(t, CLEAR, { paper: notePaper(bg) }), bg || PAPER_WHITE);
});
test('CONTROL: an opaque draft is unchanged — its own background, not the paper', async (t) => {
  assert.equal(await zoomOn(t, PINK, { paper: notePaper(PAPER_BLUE) }), '#fffaf2');
});
test('MUTATION: no paper composite leaves the corner transparent; source-over paints the paper OVER the draft', async (t) => {
  assert.equal(await zoomOn(t, CLEAR, { paper: notePaper() }, (src) => src.replace(' onPaper(c,paper);', '')), 'none', 'the bug: transparent on black');
  assert.equal(await zoomOn(t, PINK, { paper: notePaper() }, (src) => src.replace("x.globalCompositeOperation='destination-over'; ", '')), PAPER_WHITE,
    'the CONTROL above can see a paper that hides the design');
});

// ── One lightbox: PAChat.lightbox IS the chat's own (the same function and element) ──────────
test('PAChat.lightbox is the chat’s own lightbox: one .pac-lb for both, tap or Esc closes it', () => {
  const c = loadChatUi(), lbs = () => c.body.children.filter((e) => e.className === 'pac-lb');
  c.tapChatImage('data:A');
  assert.equal(lbs().length, 1); assert.equal(lbs()[0].firstChild.src, 'data:A');
  c.PAChat.lightbox('data:B');
  assert.equal(lbs().length, 1, 'the API opened the SAME element the chat’s image tap opened');
  assert.equal(lbs()[0].firstChild.src, 'data:B'); assert.ok(lbs()[0].classList.contains('on'));
  for (const fn of lbs()[0].on.click) fn(); assert.equal(lbs()[0].classList.contains('on'), false, 'a tap closes it');
  c.PAChat.lightbox('data:C'); c.key('Escape'); assert.equal(lbs()[0].classList.contains('on'), false, 'Esc closes it');
  assert.doesNotMatch(PICKER_HTML, /pac-lb|createElement\('img'\)/, 'the picker carries no lightbox of its own');
});
test('MUTATION: a second lightbox behind PAChat.lightbox is caught — two .pac-lb elements', () => {
  const c = loadChatUi({ mutate: (s) => s.replace('\n    lightbox,   //', "\n    lightbox:(src)=>{ const d=document.createElement('div'); d.className='pac-lb'; d.appendChild(document.createElement('img')); d.firstChild.src=src; document.body.appendChild(d); },   //") });
  c.tapChatImage('data:A'); c.PAChat.lightbox('data:B');
  assert.equal(c.body.children.filter((e) => e.className === 'pac-lb').length, 2);
});

// ── The Journal flow: the studio sits in PANote's paper popover; the lightbox opens over it ─────
// Probe (Chromium): note-ui's capture-phase outside-tap handler swallowed the pointerdown of the tap that
// closes the lightbox, but click still fired — so ONE tap closed the lightbox AND the popover under it.
const journal = (t, mutate) => {
  const chat = loadChatUi(), s = studio(t, undefined, { PAChat: chat.PAChat, innerWidth: 390, devicePixelRatio: 3 });
  const pop = new FakeEl('div'); pop.className = 'pan-pop on'; pop.append(s.host);
  const inside = (root, e) => e === root || root.children.some((k) => inside(k, e));
  pop.contains = (e) => inside(pop, e);
  const docOn = [], doc = { addEventListener: (t, fn) => docOn.push(fn) };
  installPopOutside({ host: { querySelectorAll: () => (pop.classList.contains('on') ? [pop] : []) }, doc }, mutate);
  const lb = () => chat.body.children.find((e) => e.className === 'pac-lb');
  // A tap on the lightbox's picture: pointerdown (capture, note-ui), then click, unless swallowed.
  const tapLightbox = () => { const img = lb().firstChild, chain = [img, lb()]; let prevented = false;
    img.closest = (sel) => chain.find((e) => sel.split(',').some((x) => e.className.split(' ').includes(x.trim().slice(1)))) || null;
    for (const fn of docOn) fn({ target: img, preventDefault: () => { prevented = true; }, stopPropagation() {} });
    for (const fn of lb().on.click) fn(); return prevented; };
  return { s, pop, lb, tapLightbox };
};
test('Journal flow: tap the draft -> the real chat-ui lightbox shows it sharp; tapping it closed keeps the paper popover open', async (t) => {
  const { s, pop, lb, tapLightbox } = journal(t);
  await design(s); s.prev.click(); await settle();
  assert.ok(lb() && lb().classList.contains('on'), 'chat-ui’s lightbox is open');
  assert.deepEqual(traced(lb().firstChild.src), { w: 1170, h: 1514, color: '#f2b8c6' });
  assert.equal(tapLightbox(), false, 'note-ui let the tap through');
  assert.equal(lb().classList.contains('on'), false, 'the lightbox closed');
  assert.ok(pop.classList.contains('on'), 'and the studio’s popover is still open, draft and all');
  assert.equal(s.drawn(), true);
});
test('MUTATION: without .pac-lb in note-ui’s exclusions, one tap closes the lightbox AND the popover', async (t) => {
  const { s, pop, lb, tapLightbox } = journal(t, (src) => src.replace(',.pan-photo,.pac-lb\')', ',.pan-photo\')'));
  await design(s); s.prev.click(); await settle();
  assert.equal(tapLightbox(), true, 'the pointerdown was swallowed …');
  assert.equal(lb().classList.contains('on'), false, '… the click still closed the lightbox …');
  assert.equal(pop.classList.contains('on'), false, '… and the popover went with it');
});
