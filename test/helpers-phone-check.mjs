// Phone check（手机检查）— one measurement run in a real page (page.evaluate / frame.evaluate) that says
// whether a surface is usable with a finger: sideways page scroll, input font size (iOS zooms under 16px),
// tap-target size (44px), controls covered by something else (elementFromPoint at each centre), and fixed
// bars that touch the top/bottom edge (where the notch / home indicator sit). Used by test/phone-friendly-e2e.test.mjs
// over the shell and every built-in app. Known limits: a heuristic scan; env(safe-area-inset-*) is 0 in an emulator,
// so edge bars are LISTED for a look, not proven safe. It reports; the caller decides what fails.
export const TAP_MIN_PX = 44;
export const INPUT_MIN_PX = 16;

// Runs in the page. Returns plain data only.
export function phoneCheck(opts) {
  const { tapMin, inputMin, skip } = opts;
  const W = innerWidth, H = innerHeight;
  const vis = (e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && +s.opacity > 0.05 && r.bottom > 0 && r.top < H && r.right > 0 && r.left < W && !e.closest('[inert],[hidden]'); };
  const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/)[0] : '')
    + '[' + (e.getAttribute('aria-label') || e.textContent || e.placeholder || '').trim().slice(0, 16) + ']';
  const skipped = (e) => skip && e.closest(skip);
  const out = { W, H, hScroll: Math.max(0, document.documentElement.scrollWidth - W) };
  const inputs = [...document.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=color]):not([type=hidden]):not([type=file]),textarea,select')]
    .filter(vis).filter((e) => !skipped(e));
  out.inputs = inputs.length;
  out.smallInputs = inputs.filter((e) => parseFloat(getComputedStyle(e).fontSize) < inputMin).map((e) => name(e) + ' ' + getComputedStyle(e).fontSize);
  // A drag strip (role=separator, the split view's resize bars) is a full-length edge, not a tap target: left out.
  // What it must not do is cover a control, and that control's own centre test below catches it.
  const ctl = [...document.querySelectorAll('button:not([role=separator]),[role=button],summary,input[type=button],input[type=submit]')].filter(vis).filter((e) => !skipped(e));
  out.controls = ctl.length;
  out.smallTaps = ctl.map((e) => [e, e.getBoundingClientRect()]).filter(([, b]) => b.width < tapMin - 0.5 || b.height < tapMin - 0.5)
    .map(([e, b]) => name(e) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height));
  out.covered = ctl.filter((e) => { const b = e.getBoundingClientRect(), x = b.left + b.width / 2, y = b.top + b.height / 2;
    if (x < 0 || y < 0 || x >= W || y >= H) return false; const t = document.elementFromPoint(x, y); return t && t !== e && !e.contains(t) && !t.contains(e); })
    .map((e) => { const b = e.getBoundingClientRect(); return name(e) + ' under ' + name(document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)); });
  out.tips = [...document.querySelectorAll('.pat-tip')].map((t) => { const b = t.getBoundingClientRect(); return { id: t.dataset.tip, top: Math.round(b.top), bottom: Math.round(b.bottom) }; });
  out.fixedEdgeBars = [...document.querySelectorAll('body *')].filter((e) => getComputedStyle(e).position === 'fixed' && vis(e))
    .map((e) => [e, e.getBoundingClientRect()]).filter(([, b]) => b.width > W * 0.6 && (b.top <= 1 || b.bottom >= H - 1)).map(([e, b]) => name(e) + (b.top <= 1 ? ' top' : ' bottom'));
  return out;
}

export async function checkSurface(target, { skip = '' } = {}) {
  return target.evaluate(phoneCheck, { tapMin: TAP_MIN_PX, inputMin: INPUT_MIN_PX, skip });
}

// A rect test for tips: the tip must not cover any of the given rects (title bars, header controls).
export const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

// Chat reading size（聊天字号）— on a phone every chat bubble reads at >=16px, the reply meta line at >=13px,
// the header title at >=17px and each message action icon (copy / speak / retry / edit) at >=18px with a 44px tap.
// Owner 2026-11-25: v5.20.0 raised tap areas but left the text at 14px / 11px. Runs in the page; plain data out.
export const CHAT_TEXT_MIN_PX = 16, CHAT_META_MIN_PX = 13, CHAT_TITLE_MIN_PX = 17, ACTION_GLYPH_MIN_PX = 18;
export const CHAT_SEL = { bubble: '.pac-m:not(.status),.msg:not(.status)', meta: '.pa-took', title: '.pac-title', action: '.pac-ab,.mab' };
export function chatText(sel) {
  const vis = (e) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const px = (s) => [...document.querySelectorAll(s)].filter(vis).map((e) => parseFloat(getComputedStyle(e).fontSize));
  return { bubble: px(sel.bubble), meta: px(sel.meta), title: px(sel.title),
    action: [...document.querySelectorAll(sel.action)].filter(vis).map((e) => { const r = e.getBoundingClientRect(), s = getComputedStyle(e);
      // The RENDERED glyph: the icon's SVG box. A text glyph (⎘ ✎) is measured as 0 — iOS has no font for them and
      // drew a tiny faint fallback while font-size said 20px (owner iPhone 2026-11-25), so font-size proves nothing.
      const g = e.querySelector('svg'), gr = g && g.getBoundingClientRect();
      return { glyph: gr ? Math.min(gr.width, gr.height) : 0, w: r.width, h: r.height, opacity: +s.opacity,
        kind: e.closest('.pac-acts.me,.msg.me') ? 'me' : 'ai' }; }) };
}
export async function checkChatText(target) { return target.evaluate(chatText, CHAT_SEL); }
// Judge a chatText result for a phone; returns the failures as text.
export function chatTextFailures(where, m) {
  const bad = [];
  if (!m.bubble.length) bad.push(`${where}: no chat bubble measured`);   // empty is failure, not a pass (R14)
  if (m.bubble.some((x) => x < CHAT_TEXT_MIN_PX)) bad.push(`${where}: bubble text ${m.bubble.join('/')}px`);
  if (m.meta.some((x) => x < CHAT_META_MIN_PX)) bad.push(`${where}: meta line ${m.meta.join('/')}px`);
  if (m.title.some((x) => x < CHAT_TITLE_MIN_PX)) bad.push(`${where}: header title ${m.title.join('/')}px`);
  for (const a of m.action) if (a.glyph < ACTION_GLYPH_MIN_PX || a.w < TAP_MIN_PX - 0.5 || a.h < TAP_MIN_PX - 0.5 || a.opacity < 0.95)
    bad.push(`${where}: ${a.kind} action icon glyph ${a.glyph}px ${Math.round(a.w)}x${Math.round(a.h)} opacity ${a.opacity}`);
  return bad;
}

// Composer clearance（输入框不压住消息）: after scrolling the log to its end, the last message's bottom sits at or above
// the composer's top (chips + pills + pill), and the ↓ jump button, if shown, is above the composer too. Runs in the page.
export function composerClearance(sel) {
  const log = document.querySelector(sel.log); log.scrollTop = log.scrollHeight;
  const items = [...log.children].filter((e) => e.getClientRects().length), last = items[items.length - 1];
  const row = document.querySelector(sel.row).getBoundingClientRect(), j = document.querySelector(sel.jump);
  return { lastBottom: last ? last.getBoundingClientRect().bottom : null, composerTop: row.top,
    logBottom: log.getBoundingClientRect().bottom, jumpBottom: j && j.getClientRects().length ? j.getBoundingClientRect().bottom : null };
}
export const PAC_CLEAR_SEL = { log: '.pac-log', row: '.pac-row', jump: '.pac-scroll' };
export function clearanceFailures(where, c) {
  const bad = [];
  if (c.lastBottom == null) bad.push(`${where}: no message measured`);   // empty is failure (R14)
  else if (c.lastBottom > c.composerTop + 0.5) bad.push(`${where}: last message bottom ${Math.round(c.lastBottom)} under composer top ${Math.round(c.composerTop)}`);
  if (c.logBottom > c.composerTop + 0.5) bad.push(`${where}: the log runs under the composer (${Math.round(c.logBottom)} > ${Math.round(c.composerTop)})`);
  if (c.jumpBottom != null && c.jumpBottom > c.composerTop + 0.5) bad.push(`${where}: ↓ button over the composer`);
  return bad;
}
