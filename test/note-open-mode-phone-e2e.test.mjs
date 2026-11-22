// iPhone: a note opens in the mode it STARTS with, and a typed page wraps at the screen
// · 手机：笔记按开头内容选择模式，打字页面按屏幕宽度换行
//
// Owner 2026-11-13 (iPhone, Journal): an AI summary — typed headings and bullets — showed neither
// the Draw nor the T tab selected, taps did not type, and its lines ran off the right edge.
// Causes: (1) a page with ANY ink opened on the pen with the draw row CLOSED (neither tab lit), so a
// stray dot under a summary made it a "drawing"; (2) the fixed 816px page never shrinks below
// MIN_PAGE_W=700, so on a 390px phone the text wrapped 300+px off screen.
// Real web.mjs on a throwaway root, the shipped Journal, an iPhone viewport with touch.
// Needs Playwright (PA_PLAYWRIGHT); skipped without it, like test/note-link-e2e.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { skip, setup, teardown, newContext, openJournal, port } from './helpers-note-link.mjs';

const serverRoot = () => { const pid = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -Fp | head -1`).toString().trim().slice(1);
  return execSync(`lsof -a -p ${pid} -d cwd -Fn | tail -1`).toString().trim().slice(1); };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
const DOT = { p: [[0.1, 0.9, 0.5], [0.12, 0.91, 0.5]], c: '#1c1e1d', w: 0.004, t: 'pen' };        // low on the page
const TOP_INK = { p: [[0.1, 0.004, 0.5], [0.4, 0.008, 0.5]], c: '#1c1e1d', w: 0.004, t: 'pen' };     // above any text
const SUMMARY = '<h2>AI summary · AI 总结 — This week · 本周 Nov 9–15, 2026</h2><ul><li>FDE stands for forward deployed engineer, a role that sits with customers and ships integrations in their environment every week</li></ul>';
const SPECK = { p: [[0.3, 0.089, 0.5]], c: '#1c1e1d', w: 0.004, t: 'pen' };   // one point: the owner's real summary carried exactly this
const NOTES = { speck: [SUMMARY, [SPECK]], sumdot: [SUMMARY, [DOT]], summary: [SUMMARY, []], inkfirst: ['<div>typed under the ink</div>', [TOP_INK]], ink: ['', [TOP_INK]] };

function seed(root) {
  const d = path.join(root, 'workspace', 'data', 'notes'); fs.mkdirSync(d, { recursive: true });
  const t = Date.now(); const entries = [];
  Object.entries(NOTES).forEach(([id, [html, strokes]], i) => {
    fs.writeFileSync(path.join(d, `entry-${id}.json`), JSON.stringify({ v: 2, id, created: t, updated: t, template: 'plain',
      pages: [{ id: 'p' + id, created: t, updated: t, strokes, pageHtml: html, images: [] }] }));
    entries.push({ id, title: id, created: t - i, updated: t - i, preview: '' });
  });
  fs.writeFileSync(path.join(d, 'journal.json'), JSON.stringify({ v: 1, entries }));
}
const lit = (frame) => frame.evaluate(() => ({ text: !!document.querySelector('.pan-mtext.on'), draw: !!document.querySelector('.pan-mdraw.on') }));
const open = async (page, frame, id) => { await frame.evaluate((i) => openEntry(i), id); await page.waitForTimeout(400); };

before(async () => { await setup({ slugs: ['notes'] }); if (!skip) seed(serverRoot()); });
after(teardown);

test('iPhone: each note opens in the mode it starts with, and one tab is always lit', { skip }, async () => {
  const ctx = await newContext(PHONE); const page = await ctx.newPage();
  const frame = await openJournal(page, { touch: true });
  for (const [id, want] of [['ink', 'draw'], ['sumdot', 'text'], ['inkfirst', 'draw'], ['summary', 'text'], ['ink', 'draw'], ['sumdot', 'text']]) {
    await open(page, frame, id);
    const l = await lit(frame);
    assert.ok(l.text || l.draw, `${id}: a mode tab is selected (was: neither)`);
    assert.equal(l.text ? 'text' : 'draw', want, `${id} opens in ${want}`);
    if (want === 'text') assert.ok(await frame.evaluate(() => !!document.querySelector('.pan-editing')), `${id}: the page is editable text`);
  }
  await ctx.close();
});

test('iPhone: a typed page wraps inside the screen; a page with ink keeps the fixed page', { skip }, async () => {
  const ctx = await newContext(PHONE); const page = await ctx.newPage();
  const frame = await openJournal(page, { touch: true });
  const right = () => frame.evaluate(() => { const tl = document.querySelector('.pan-textlayer'), st = document.querySelector('.pan-stage');
    const it = document.createTreeWalker(tl, NodeFilter.SHOW_TEXT); let max = 0;
    for (let n; (n = it.nextNode());) { const r = document.createRange(); r.selectNodeContents(n); for (const b of r.getClientRects()) max = Math.max(max, b.right); }
    return { max, stage: st.getBoundingClientRect().right }; });
  await open(page, frame, 'summary');
  const s = await right();
  assert.ok(s.max <= s.stage + 1, `summary text ends at ${s.max}, inside the ${s.stage}px stage`);
  await open(page, frame, 'speck');   // a one-point tap-dot is not handwriting: the page still wraps (sumdot's 16px dash is ink)
  const d = await right();
  assert.ok(d.max <= d.stage + 1, `speck: text ends at ${d.max}, inside the ${d.stage}px stage (a stray dot must not block the wrap)`);
  await open(page, frame, 'inkfirst');
  const w = await frame.evaluate(() => document.querySelector('.pan-textlayer').style.right);
  assert.equal(w, '', 'CONTROL: a page with ink keeps the fixed 816px text width (no reflow under ink)');
  await ctx.close();
});
