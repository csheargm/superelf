// Owner 2026-11-22 (iPad, dark theme): the pen cluster's undo / redo buttons were nearly invisible —
// the icon used --ink, which the Bible never defines, so it fell back to #222 on a #1b201f button.
// In a REAL browser, with the shipped pen CSS and the Bible's own theme tokens, in dark AND light:
// icon vs button >= 3:1, button edge vs page >= 3:1, and the disabled (.off) state still >= 3:1.
// CONTROL (R14): the old rule (--ink fallback) fails the dark icon check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';

const PEN = fs.readFileSync(path.join(ROOT, 'web', 'ink-pen.inline.html'), 'utf8');
const PEN_CSS = PEN.match(/<style id="pip-style">[\s\S]*?<\/style>/)[0];
const BIBLE = fs.readFileSync(path.join(ROOT, 'workspace', 'apps', 'bible', 'index.html'), 'utf8');
const ROOT_CSS = BIBLE.match(/:root\{[^}]*\}\n@media\(prefers-color-scheme:dark\)\{:root\{[^}]*\}\}/)[0];
const ICON = '<svg class="pan-i" viewBox="0 0 24 24" style="fill:none;stroke:currentColor;width:19px;height:19px"><path d="M9.5 14.5L5 10l4.5-4.5"/></svg>';
const host = (css) => `<style>${ROOT_CSS} body{background:var(--bg)}</style>${css}
<div class="pip-cl on" style="right:12px"><button class="pip-hb" id="u">${ICON}</button><button class="pip-hb off" id="r">${ICON}</button></div>`;

async function measure(page) {
  return page.evaluate(() => {
    const rgb = (s) => s.match(/[\d.]+/g).slice(0, 4).map(Number);
    const lum = ([r, g, b]) => { const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
    const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
    const page = rgb(getComputedStyle(document.body).backgroundColor);
    const one = (id) => { const b = document.getElementById(id), cs = getComputedStyle(b), svg = b.querySelector('svg');
      // opacity anywhere on the button or the icon composites toward the button fill
      const op = Number(cs.opacity) * Number(getComputedStyle(svg).opacity);
      const fill = rgb(cs.backgroundColor), ic = rgb(getComputedStyle(svg).stroke).slice(0, 3).map((c, i) => c * op + fill[i] * (1 - op));
      const edge = rgb(cs.borderTopColor).slice(0, 3).map((c, i) => c * Number(cs.opacity) + page[i] * (1 - Number(cs.opacity)));
      return { icon: ratio(ic, fill), edge: ratio(edge, page) }; };
    return { on: one('u'), off: one('r') };
  });
}

for (const scheme of ['dark', 'light']) {
  test(`${scheme}: undo/redo icon and edge clear 3:1, enabled and disabled`, { skip, timeout: 60000 }, async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ colorScheme: scheme });
      await page.setContent(host(PEN_CSS));
      const m = await measure(page);
      for (const k of ['on', 'off']) {
        assert.ok(m[k].icon >= 3, `${k} icon vs button ${m[k].icon.toFixed(2)}`);
        assert.ok(m[k].edge >= 3, `${k} edge vs page ${m[k].edge.toFixed(2)}`);
      }
      assert.ok(m.off.icon < m.on.icon, 'disabled still looks dimmed');
    } finally { await browser.close(); }
  });
}

test('CONTROL: the old --ink-only icon colour fails in dark', { skip, timeout: 60000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ colorScheme: 'dark' });
    await page.setContent(host(PEN_CSS.replace(/\n\.pip-hb\{[^}]*\}/, '\n.pip-hb{width:34px;height:34px;color:var(--ink,#222)}')));
    assert.ok((await measure(page)).on.icon < 3);
  } finally { await browser.close(); }
});
