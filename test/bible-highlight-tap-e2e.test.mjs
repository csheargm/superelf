// Bible Highlight, in a REAL browser (R6): a word selection, a real mouse tap on the top-bar
// Highlight button, then a real tap on a swatch must SAVE a ranged mark — the button sits far from
// the text now, so the selection must survive both taps. Also: at 375px the top bar wraps and no
// button is clipped (body is overflow:hidden, so a clip would be silent). Uses the shipped component
// and the shipped #nav markup + CSS. CONTROL (R14): with no selection the sheet never opens.
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';

const VMARKS = fs.readFileSync(path.join(ROOT, 'web', 'verse-marks.inline.html'), 'utf8');
const APPS = ['workspace/apps/bible/index.html', 'workspace.example/apps/bible/index.html'];
const TEXT = 'For God so loved the world';
const HOST = `${VMARKS}<button id="top-mark" disabled>Highlight</button>
<div id="verses"><div class="verse" data-n="16"><div class="ven">${TEXT}</div></div></div>
<script>
let saved=null; const VM=PAVerseMarks.attach({container:document.getElementById('verses'),
  store:{get:()=>saved,set:async v=>{ saved=v; return {ok:true}; }},textOf:()=>${JSON.stringify(TEXT)}});
const markVerses=()=>{ const r=VM.selection(); return r?[r.n]:[]; };
const btn=document.getElementById('top-mark');
document.addEventListener('selectionchange',()=>{ btn.disabled=!markVerses().length; });
PAVerseMarks.armControl(btn).onclick=()=>VM.openSheet(markVerses());
window.saved=()=>saved;
</script>`;

test('a word selection + real taps on Highlight and a swatch saves a ranged highlight', { skip, timeout: 60000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(HOST);
    assert.equal(await page.isDisabled('#top-mark'), true, 'CONTROL: no selection, button disabled');
    await page.evaluate(() => { const t = document.querySelector('.ven').firstChild, r = document.createRange();
      r.setStart(t, 4); r.setEnd(t, 7); getSelection().removeAllRanges(); getSelection().addRange(r); });
    await page.waitForFunction(() => !document.getElementById('top-mark').disabled);
    await page.click('#top-mark');                       // real mouse: pointerdown, mouseup, click
    await page.click('.pvm-sw-green');
    await page.waitForFunction(() => window.saved());
    const s = await page.evaluate(() => window.saved());
    assert.deepEqual(s.v16, [{ kind: 'hl', color: 'green', lang: 'en', quote: 'God', start: 4, end: 7 }]);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('mark.pvm')).backgroundColor !== 'rgba(0, 0, 0, 0)'), true, 'and it paints');
  } finally { await browser.close(); }
});

for (const rel of APPS) {
  test(`${rel}: at 375px every top-bar control is inside the screen`, { skip, timeout: 60000 }, async () => {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const css = src.match(/<style>[\s\S]*?<\/style>/)[0];
    const nav = src.slice(src.indexOf('<div id="nav">'), src.indexOf('<div id="daily-banner">'));
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
      await page.setContent(`${css}${nav.replace(/<select id="book-sel"><\/select>/, '<select id="book-sel"><option>Genesis</option></select>')}`);
      await page.evaluate(() => { document.getElementById('top-mark').textContent = '高亮 · Highlight'; });
      const out = await page.evaluate(() => [...document.querySelectorAll('#nav button, #nav select')]
        .map((e) => ({ id: e.id, r: e.getBoundingClientRect().right })).filter((x) => x.r > 375));
      assert.deepEqual(out, [], 'nothing past the right edge');
      assert.ok(await page.evaluate(() => document.getElementById('book-sel').getBoundingClientRect().width >= 72), 'the book selector keeps a usable width');
    } finally { await browser.close(); }
  });
}
