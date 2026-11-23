// Journal polish, in a REAL browser · 笔记细节（真实浏览器）
//
// The shipped Journal (shared-apps/notes) in the real shell on a throwaway root (test/helpers-note-link.mjs —
// never the live node). One test per overnight finding of the notes batch (F3-xx): each drives the flow the
// tester hit and pins the fixed behaviour. Run: PA_PLAYWRIGHT=/path/to/playwright/index.mjs node --test test/notes-polish-e2e.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { skip, setup, teardown, newContext, openJournal, textMode, onDisk, indexed, port } from './helpers-note-link.mjs';

// One note on disk, typed the way a user types it, so the Journal opens with its list docked (a note exists).
let seeded = false;
async function seed() {
  if (seeded) return; seeded = true;
  const ctx = await newContext(); const page = await ctx.newPage();
  const frame = await openJournal(page);
  await textMode(frame);
  await frame.locator('.pan-textlayer').click();
  await page.keyboard.type('#family #hymnsandpsalms #grace #summary #墨水 #morning'); await page.keyboard.press('Enter'); await page.keyboard.type('Remember the hymn');
  await onDisk((h) => h.includes('Remember the hymn'), 'the note is saved'); await indexed();
  assert.ok(await frame.evaluate(async () => { for (let i = 0; i < 50; i++) { const r = await PANoteText.fetch({ fields: ['tags'] });
    if (r.ok && r.pages.some((p) => (p.tags || []).length)) return true; await new Promise((z) => setTimeout(z, 300)); } return false; }), 'the node indexed its tags');
  await ctx.close();
}
// The Journal as a returning user sees it: the list stays docked (openJournal would put it away).
async function openDocked(page) {
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  await page.evaluate(() => openApp('owner', 'notes', 'Journal'));
  let frame = null;
  for (let i = 0; i < 200 && !frame; i++) { frame = page.frames().find((f) => f.url().includes('/app/owner/notes/')) || null; if (!frame) await page.waitForTimeout(50); }
  assert.ok(frame, 'the Journal frame loaded');
  await frame.waitForFunction(() => window.PANote && document.querySelector('.pan-mtext') && !document.querySelector('.pan-lock.on'));
  await frame.waitForSelector('.pac-lrow');
  await page.waitForTimeout(300);
  return frame;
}

before(() => setup());
after(teardown);

test('F3-11: a drawer row preview keeps a space between lines ("#family Remember the hymn", never "#familyRemember")', { skip, timeout: 60000 }, async () => {
  const ctx = await newContext(); const page = await ctx.newPage();
  const frame = await openJournal(page);
  const got = await frame.evaluate(() => previewOf({ pages: [{ pageHtml: '<div>#family</div><div>Remember the hymn</div><p>a</p><ul><li>b</li><li>c</li></ul>x<br>y' }] }));
  assert.equal(got, '#family Remember the hymn a b c x y');
  assert.equal(await frame.evaluate(() => previewOf({ pages: [{ pageHtml: 'one <b>bold</b>word' }] })), 'one boldword', 'inline tags add no space');
  assert.equal(await frame.evaluate(() => previewOf({ pages: [{ pageHtml: '#morning<div>Remember the hymn</div>' }] })), '#morning Remember the hymn', 'the first line outside a block, as the editor writes it after Enter');
  await ctx.close();
});

test('F3-13: on a phone the kind chip stays on one line and the row time stays on screen', { skip, timeout: 90000 }, async () => {
  await seed();
  const ctx = await newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }); const page = await ctx.newPage();
  const frame = await openDocked(page);
  if (!(await frame.evaluate(() => !!document.querySelector('.pac-drawerhost.on')))) await frame.evaluate(() => document.querySelector('.pac-drawerhost').classList.add('on'));
  // A crowded meta line, as a note with many #tags draws it (the row's tag chips arrive from the index later; drawn here at once).
  await frame.evaluate(() => { const meta = document.querySelector('.pac-lrow .pac-lmeta'); const time = meta.querySelector('.pac-ltime');
    for (const t of ['hymnsandpsalms', 'grace', 'summary', '墨水']) { const b = document.createElement('button'); b.className = 'pac-ltag'; b.textContent = '#' + t; meta.insertBefore(b, time); }
    const more = document.createElement('span'); more.className = 'pac-lchip'; more.textContent = '+1'; meta.insertBefore(more, time); });
  const m = await frame.evaluate(() => { const row = document.querySelector('.pac-lrow'); const chip = row.querySelector('.pac-lchip'); const t = row.querySelector('.pac-ltime');
    const lh = parseFloat(getComputedStyle(chip).lineHeight) || parseFloat(getComputedStyle(chip).fontSize) * 1.4;
    return { chipH: chip.getBoundingClientRect().height, lh, chip: chip.textContent, timeR: t.getBoundingClientRect().right, timeW: t.getBoundingClientRect().width, vw: Math.min(innerWidth, row.getBoundingClientRect().right) }; });
  assert.equal(m.chip, 'Note 笔记');
  assert.ok(m.chipH < m.lh * 1.8, `the chip is one line (${m.chipH}px, line ${m.lh}px)`);
  assert.ok(m.timeW > 0 && m.timeR <= m.vw, `the time is on screen (right ${m.timeR} <= ${m.vw})`);
  await ctx.close();
});

test('F3-08: Page settings shows no developer readout and stays inside the viewport (desktop and iPad portrait)', { skip, timeout: 90000 }, async () => {
  for (const vp of [{ width: 1280, height: 850 }, { width: 820, height: 1180 }]) {
    const ctx = await newContext({ viewport: vp }); const page = await ctx.newPage();
    const frame = await openJournal(page);
    // dispatched, not clicked at a point: with a long title the ⋯ can sit under the shell's bar-peek handle (reported separately)
    await frame.locator('.pan-hmore, .pan-paperbtn').first().dispatchEvent('click');
    await frame.waitForSelector('.pan-paperpop.on');
    const m = await frame.evaluate(() => { const p = document.querySelector('.pan-paperpop.on'); const r = p.getBoundingClientRect();
      return { text: p.textContent, left: r.left, right: r.right, vw: document.documentElement.clientWidth }; });
    assert.doesNotMatch(m.text, /scale k=|Device 设备/, `${vp.width}: no developer readout`);
    assert.ok(m.left >= 0 && m.right <= m.vw, `${vp.width}: the popover is inside the viewport (${m.left}..${m.right} of ${m.vw})`);
    await ctx.close();
  }
});
