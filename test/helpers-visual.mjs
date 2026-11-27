// 浮层不出界 · Overlays fit the screen — a shared visual check for real-browser suites (R6).
// fitProblems(page) lists, for every VISIBLE first-use tip, pop-up menu, popover, sheet or open dialog:
//   - a box not fully inside the viewport (clientWidth: a desktop scrollbar is not room);
//   - text cut short: an element inside it whose scrollWidth exceeds its clientWidth while it hides the
//     overflow, or that sets text-overflow: ellipsis and overflows;
//   - a stray bar: a thin (< 12px), tall (> 60px) visible element hanging right under a tip.
// An empty list is the pass. assertFits(page, label) fails with the whole list. Owner 2026-11-27: the home
// language tip ran off the right edge on a 2000px desktop.
import assert from 'node:assert/strict';

export const OVERLAY_SEL = '.pat-tip,[role=menu],.cmenu-pop,.popover,.sheet,[role=dialog],dialog[open]';

export function fitProblems(page, sel = OVERLAY_SEL) {
  return page.evaluate((sel) => {
    const out = [], W = document.documentElement.clientWidth, H = window.innerHeight;
    const vis = (e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0; };
    const name = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.className && typeof e.className === 'string' ? '.' + e.className.trim().split(/\s+/).join('.') : '');
    for (const o of document.querySelectorAll(sel)) {
      if (!vis(o)) continue;
      const r = o.getBoundingClientRect();
      if (r.left < -0.5 || r.top < -0.5 || r.right > W + 0.5 || r.bottom > H + 0.5)
        out.push(`${name(o)} outside the ${W}x${H} viewport: ${Math.round(r.left)},${Math.round(r.top)} → ${Math.round(r.right)},${Math.round(r.bottom)}`);
      for (const e of [o, ...o.querySelectorAll('*')]) {
        if (!vis(e) || !e.textContent.trim()) continue;
        const cs = getComputedStyle(e), over = e.scrollWidth > e.clientWidth + 1 && e.clientWidth > 0;
        if (over && (cs.textOverflow === 'ellipsis' || /hidden|clip/.test(cs.overflowX)))
          out.push(`${name(e)} text cut: scrollWidth ${e.scrollWidth} > clientWidth ${e.clientWidth} ("${e.textContent.trim().slice(0, 60)}")`);
      }
      if (o.classList.contains('pat-tip')) {
        for (const x of [r.left + 10, (r.left + r.right) / 2, r.right - 10]) {
          for (const e of document.elementsFromPoint(Math.min(W - 1, Math.max(0, x)), Math.min(H - 1, r.bottom + 4))) {
            const b = e.getBoundingClientRect();
            if (e !== document.documentElement && e !== document.body && b.width < 12 && b.height > 60 && b.top >= r.bottom - 2)
              out.push(`stray bar under the tip: ${name(e)} ${Math.round(b.width)}x${Math.round(b.height)}`);
          }
        }
      }
    }
    return [...new Set(out)];
  }, sel);
}

export async function assertFits(page, label, sel) {
  assert.deepEqual(await fitProblems(page, sel), [], `${label}: overlays fit the screen`);
}
