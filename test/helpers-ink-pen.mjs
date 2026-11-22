// Shared boot for the pen-sheet host tests (ink-pen-host, ink-undo-host): the REAL Bible host with PAInkAnchor
// over the fake-DOM verse list and PAInkPen over a fake app-settings store. Moved out of ink-pen-host.test.mjs unchanged.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ENG_INK, ENG_PALETTE, fakeEl, startHarness, runApp, until, scriptOf } from './helpers-app.mjs';
import { COMPONENT, makeDom, VERSES, penStroke } from './helpers-ink-dom.mjs';
import { APP_PREFS_SRC } from './helpers-stationery.mjs';

export const PEN_SRC = fs.readFileSync(path.join(ROOT, 'web', 'ink-pen.inline.html'), 'utf8');
export const APPS = ['bible (template)', 'bible (live)'];
export const RED = ENG_PALETTE.COLORS[13];                     // '#c1121f', a swatch of the pad's own grid
export const CHAPTER = 'notes/43-3.json';

export function settingsStore(seed = {}) {
  const st = { prefs: JSON.parse(JSON.stringify(seed.prefs || {})), override: seed.override || '', refuse: false, writes: 0 };
  st.answer = (m) => {
    if (m.kind === 'app-settings') return { ok: true, prefs: JSON.parse(JSON.stringify(st.prefs)), systemPrompt: { effective: st.override, override: st.override, source: st.override ? 'profile' : 'none' } };
    if (m.kind === 'set-app-settings') {
      if (st.refuse) return { ok: false, error: 'disk full' };
      if (!m.prefs || typeof m.prefs !== 'object' || Array.isArray(m.prefs)) return { ok: false, error: 'preferences must be a JSON object' };
      st.writes++; st.prefs = JSON.parse(JSON.stringify(m.prefs));
      st.override = typeof m.systemPrompt === 'string' && m.systemPrompt.trim() ? m.systemPrompt.trim() : '';
      return { ok: true };
    }
    return { ok: false, code: 'bad-request', error: 'unknown' };
  };
  return st;
}
// The component, evaluated against its own window (so a test can play the shell's prefs push) and the
// harness's fake elements; its broker answers from `store`. Timers are recorded, never run.
export function loadPen(store, src = PEN_SRC) {
  const listeners = {}, timers = [];
  const win = { innerWidth: 1024, innerHeight: 768, PANote: { palette: ENG_PALETTE, SAVE_TIMEOUT_MS: 20000 }, addEventListener: (t, f) => { (listeners[t] ||= []).push(f); } };
  const doc = { createElement: (t) => fakeEl(t), body: fakeEl('body') };
  const parent = { postMessage: (m) => { if (m && m.pa === 'req') Promise.resolve(store.answer(m)).then((r) => (listeners.message || []).forEach((f) => f({ data: { pa: 'res', id: m.id, ...r } }))); } };
  // eslint-disable-next-line no-new-func
  // The served Bible has PAAppPrefs (chat-ui carries its marker) on the same window: the pen's one prefs chain.
  // eslint-disable-next-line no-new-func
  new Function('window', 'parent', 'setTimeout', 'clearTimeout', APP_PREFS_SRC)(win, parent, (f) => timers.push(f), () => {});
  new Function('window', 'document', 'setTimeout', 'clearTimeout', 'parent', scriptOf(src))(win, doc, (f) => timers.push(f), () => {}, parent);
  return { PAInkPen: win.PAInkPen, fire: (t, e) => (listeners[t] || []).forEach((f) => f(e)) };
}
export async function boot(app, h, { store = settingsStore(), anchorSrc, penSrc, log, ink: inkIn, mutate } = {}) {
  const dom = makeDom({ width: 400, src: anchorSrc });
  const ink = inkIn || (log ? { ...ENG_INK, drawStroke: (ctx, pts, c, w, t, a) => { log.push(t); return ENG_INK.drawStroke(ctx, pts, c, w, t, a); } } : undefined);
  const PAInkAnchor = { ...dom.PAInkAnchor, attach: (o) => dom.PAInkAnchor.attach({ ...o, container: dom.container, ...(ink ? { ink } : {}) }) };
  const pen = loadPen(store, penSrc);
  const A = runApp(app, h.relay, ['INK', 'INK_PEN', 'renderVerses'], { clampTimers: true, mutate, globals: { PAInkAnchor, PAInkPen: pen.PAInkPen } });
  await until(() => A.els.get('verses').innerHTML.includes('Could not load'), 'boot (the harness serves no corpus)');
  const v16 = dom.addVerse(...VERSES[0]); dom.addVerse(...VERSES[1]);
  A.renderVerses(VERSES.map(([n, en, zh]) => ({ n, en, zh })));
  await A.INK_PEN.whenIdle();
  return { dom, A, v16, store, pen };
}
export const pick = (A, patch) => {   // a tap in the sheet, by the control the user would tap
  const ui = A.INK_PEN.ui;
  if (patch.t) ui.toolBtns[['pen', 'highlighter', 'erase'].indexOf(patch.t)].onclick();
  if (patch.size) ui.sizeBtns.find((s) => s.id === patch.size).b.onclick();
  if (patch.c) ui.grid.onclick({ target: { getAttribute: (k) => (k === 'data-color' ? patch.c : null) } });
  return A.INK_PEN.whenIdle();
};
export const touch = (dom, type) => dom.fire('pointerdown:capture', dom.ev('pointerdown', { pointerType: type, pointerId: 3, clientX: 30, clientY: 40 }));
export const ANCHOR_NO_GATE = (s) => s.replace("if(e.pointerType==='pen'&&onPen) onPen();", 'if(onPen) onPen();');
