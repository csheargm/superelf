// Verse-mark colours paint — in a REAL browser (owner report 2026-11-13: "the colours don't work, it can
// only underline"). `mark.pvm{background:…}` (0,1,1) outranked `.pvm-hl-*` (0,1,0), so every highlight
// computed transparent while the underline (text-decoration) still showed. Class-string tests could not
// see it; this reads getComputedStyle on the component's own <style>, light and dark, alone and with the
// underline. CONTROL (R14): a bare mark.pvm stays transparent, so a non-transparent result is the colour.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';

const STYLE = fs.readFileSync(path.join(ROOT, 'web', 'verse-marks.inline.html'), 'utf8').match(/<style id="pvm-style">[\s\S]*?<\/style>/)[0];
const COLOURS = ['yellow', 'green', 'pink'];
const BODY = `${STYLE}<p><mark id="bare" class="pvm">x</mark>${COLOURS.map((c) => `<mark id="${c}" class="pvm pvm-hl-${c}">x</mark><mark id="${c}-ul" class="pvm pvm-hl-${c} pvm-ul">x</mark>`).join('')}</p>`;
const TRANSPARENT = 'rgba(0, 0, 0, 0)';

test('every highlight colour fills the background in light and dark, also with the underline', { skip, timeout: 60000 }, async () => {
  const browser = await chromium.launch();
  try {
    for (const colorScheme of ['light', 'dark']) {
      const page = await browser.newPage({ colorScheme });
      await page.setContent(BODY);
      const got = await page.evaluate((ids) => Object.fromEntries(ids.map((id) => { const s = getComputedStyle(document.getElementById(id));
        return [id, { bg: s.backgroundColor, ul: s.textDecorationLine }]; })), ['bare', ...COLOURS.flatMap((c) => [c, `${c}-ul`])]);
      assert.equal(got.bare.bg, TRANSPARENT, `${colorScheme}: CONTROL — an unmarked-colour span paints nothing`);
      const seen = new Set();
      for (const c of COLOURS) {
        assert.notEqual(got[c].bg, TRANSPARENT, `${colorScheme}: ${c} paints a background`);
        assert.equal(got[`${c}-ul`].bg, got[c].bg, `${colorScheme}: ${c} keeps its colour under an underline`);
        assert.equal(got[`${c}-ul`].ul, 'underline', `${colorScheme}: and the underline still shows`);
        seen.add(got[c].bg);
      }
      assert.equal(seen.size, COLOURS.length, `${colorScheme}: the three colours differ`);
      await page.close();
    }
  } finally { await browser.close(); }
});
