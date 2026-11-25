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
  const ctl = [...document.querySelectorAll('button,[role=button],summary,input[type=button],input[type=submit]')].filter(vis).filter((e) => !skipped(e));
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
