// Note print in a REAL browser (R6): the real web.mjs on a throwaway root, the real shell and BOTH
// shipped apps that mount the shared PANote — the Journal (workspace/apps/notes, fullscreen pad) and
// the Bible app (workspace/apps/bible, the pad docked in the PASplit rail on an iPad) — each with a
// SYNTHETIC two-page note (no real content). One print path serves both (owner 2026-11-27). The
// same note is opened from a 12.9in and an 11in iPad viewport and printed on Letter and A4.
// Owner 2026-11-25: print must look like a real journal page — full sheet, centred, aligned, only a
// page number — and must not depend on which iPad wrote the page.
// Checks: one sheet per note page (PDF page count), the printed page is centred on the sheet with
// equal side margins, the same strokes land at the same place from both devices (red corner marks
// within 1% of the page width), and the A4 render is taller than the Letter one (fills the sheet).
// Without Playwright and its browser the file FAILS, unless PA_E2E_SKIP=1 (see test/helpers-note-link.mjs).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers-app.mjs';
import { skip, chromium } from './helpers-note-link.mjs';
import { freePort, mkWebRoot, startWeb, waitReady, stopWeb, OWNER_TOKEN } from './helpers-web.mjs';

const DEVICES = { '12.9': { width: 1024, height: 1366 }, '11': { width: 834, height: 1194 } };
const PAPERS = { Letter: { locale: 'en-US', wPx: 816 }, A4: { locale: 'en-GB', wPx: 794 } };
// Ink reaches 1.33 page widths: past the Letter sheet (1.294), so the whole note is fitted once.
const INK_DEPTH = 1.33;

let port, web, browser, root;
function syntheticNote() {
  const strokes = [], gap = Math.round(816 / 26) / 816;
  for (let y = gap * 3; y < INK_DEPTH; y += gap) {
    const p = []; for (let x = 0.08; x < 0.92; x += 0.02) p.push([+x.toFixed(4), +(y + 0.004 * Math.sin(x * 60)).toFixed(4), 0.5]);
    strokes.push({ c: '#1a1a1a', w: 0.0025, p });
  }
  for (const [x, y] of [[0.05, 0.05], [0.95, 0.05], [0.05, INK_DEPTH], [0.95, INK_DEPTH]]) {
    strokes.push({ c: '#d00000', w: 0.008, p: [[x - 0.01, y, 0.5], [x + 0.01, y, 0.5]] });
  }
  const t = Date.now();
  return { v: 2, id: 'syn1', created: t, updated: t, template: 'college', bgColor: '#fdfdfb',
    pages: [{ id: 'p1', created: t, updated: t, strokes, pageHtml: '<div>Synthetic line</div>', images: [] },
      { id: 'p2', created: t, updated: t, strokes: strokes.slice(0, 5), pageHtml: '', images: [] }] };
}

before(async () => {
  if (skip) return;
  port = await freePort(); root = mkWebRoot({ port });
  const ad = path.join(root, 'workspace', 'apps', 'notes'); fs.mkdirSync(ad, { recursive: true });
  for (const f of ['index.html', 'meta.json']) fs.copyFileSync(path.join(ROOT, 'workspace', 'apps', 'notes', f), path.join(ad, f));
  const dd = path.join(root, 'workspace', 'data', 'notes'); fs.mkdirSync(dd, { recursive: true });
  const t = Date.now();
  fs.writeFileSync(path.join(dd, 'journal.json'), JSON.stringify({ v: 1, entries: [{ id: 'syn1', created: t, updated: t, title: 'Synthetic' }] }));
  fs.writeFileSync(path.join(dd, 'entry-syn1.json'), JSON.stringify(syntheticNote()));
  fs.symlinkSync(path.join(ROOT, 'bible-data'), path.join(root, 'bible-data'));
  const bd = path.join(root, 'workspace', 'apps', 'bible'); fs.mkdirSync(bd, { recursive: true });
  for (const f of ['index.html', 'meta.json']) fs.copyFileSync(path.join(ROOT, 'workspace', 'apps', 'bible', f), path.join(bd, f));
  const bn = path.join(root, 'workspace', 'data', 'bible', 'notes'); fs.mkdirSync(bn, { recursive: true });
  // John 3 (the app's first chapter), the chapter-wide note: the same synthetic notebook.
  fs.writeFileSync(path.join(bn, '43-3.json'), JSON.stringify({ notes: {}, draws: { general: syntheticNote() }, chat: {}, titles: {}, pins: {} }));
  web = startWeb(root); await waitReady(port);
  browser = await chromium.launch();
});
after(async () => {
  if (browser) await browser.close();
  if (web) await stopWeb(web);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

// How each app opens the note: Journal opens it on boot; Bible opens the chapter note in its rail.
const APPS = {
  journal: { slug: 'notes', open: async () => {} },
  bible: { slug: 'bible', open: async (fr) => {
    await fr.waitForFunction(() => typeof openDrawFull === 'function' && typeof drawPad !== 'undefined' && drawPad, null, { timeout: 30000 });
    await fr.waitForFunction(() => document.querySelector('.v, #verses *'), null, { timeout: 30000 });
    await fr.evaluate(() => openDrawFull());
    // An iPad is wide: the pad is docked in the rail (PANote.panel), not the Journal's fullscreen.
    assert.ok(await fr.evaluate(() => !!rail && !!document.querySelector('.pan-hprint')), 'bible: note open in the rail');
  } },
};
const SHOTS = process.env.PA_PRINT_SHOTS || '';

async function printFrom(app, device, paper) {
  const ctx = await browser.newContext({ viewport: DEVICES[device], deviceScaleFactor: 1, locale: PAPERS[paper].locale });
  await ctx.addInitScript((tk) => { try { localStorage.setItem('pa_session', tk); } catch { /* blocked storage: sign-in fails loudly below */ } }, OWNER_TOKEN);
  const page = await ctx.newPage(); await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(() => typeof openApp === 'function' && document.querySelector('#dot.ok'));
  await page.evaluate((s) => { window.print = () => {}; openApp(UID, s, s); }, APPS[app].slug);
  let fr = null; for (let i = 0; i < 200 && !fr; i++) { fr = page.frames().find((f) => f.url().includes('/app/owner/' + APPS[app].slug + '/')) || null; if (!fr) await page.waitForTimeout(50); }
  assert.ok(fr, `${app} opened`);
  await APPS[app].open(fr);
  await fr.waitForFunction(() => window.PAPrint && document.querySelector('.pan-hprint'), null, { timeout: 30000 });
  await page.waitForTimeout(1000);
  await fr.evaluate(() => document.querySelector('.pan-hprint').click());
  await page.waitForFunction(() => document.documentElement.classList.contains('pa-printing') &&
    [...document.querySelectorAll('#printRoot img')].every((i) => i.complete && i.naturalWidth), null, { timeout: 30000 });
  // Red corner marks in the printed image, as fractions of the image width.
  const marks = await page.evaluate(() => [...document.querySelectorAll('#printRoot img')].map((im) => {
    const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
    const g = c.getContext('2d'); g.drawImage(im, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y += 2) for (let x = 0; x < c.width; x += 2) {
      const o = (y * c.width + x) * 4; if (d[o] > 180 && d[o + 1] < 60 && d[o + 2] < 60) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    return { w: c.width, h: c.height, bbox: x1 < 0 ? null : [x0 / c.width, y0 / c.width, x1 / c.width, y1 / c.width] };
  }));
  await page.emulateMedia({ media: 'print' });
  const pdf = await page.pdf({ format: paper });
  await page.setViewportSize({ width: PAPERS[paper].wPx, height: 1100 });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${app}-${paper}-${device}.png`), fullPage: true });
  const layout = await page.evaluate(() => [...document.querySelectorAll('#printRoot .pr-sheet')].map((s) => {
    const a = s.getBoundingClientRect(), b = s.querySelector('img').getBoundingClientRect();
    return { left: b.left - a.left, right: a.right - b.right, top: b.top - a.top, bottom: a.bottom - b.bottom };
  }));
  await ctx.close();
  const sheets = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  return { marks, sheets, layout };
}

for (const app of Object.keys(APPS)) test(`${app} prints one centred, device-independent sheet per page on Letter and A4`, { skip, timeout: 240000 }, async () => {
  const out = {};
  for (const paper of Object.keys(PAPERS)) for (const dev of Object.keys(DEVICES)) out[paper + dev] = await printFrom(app, dev, paper);
  for (const [key, r] of Object.entries(out)) {
    assert.equal(r.sheets, 2, `${key}: a two-page note prints two sheets`);
    assert.equal(r.marks.length, 2, `${key}: two page images`);
    for (const l of r.layout) {
      assert.ok(Math.abs(l.left - l.right) <= 2, `${key}: equal side margins (${l.left} vs ${l.right})`);
      assert.ok(Math.abs(l.top - l.bottom) <= 2, `${key}: equal top and bottom inside the sheet (${l.top} vs ${l.bottom})`);
    }
  }
  for (const paper of Object.keys(PAPERS)) {
    const a = out[paper + '12.9'].marks[0].bbox, b = out[paper + '11'].marks[0].bbox;
    assert.ok(a && b, 'corner marks printed');
    a.forEach((v, i) => assert.ok(Math.abs(v - b[i]) < 0.01, `${paper}: same place from both iPads (${v} vs ${b[i]})`));
    assert.ok(a[3] < out[paper + '11'].marks[0].h / out[paper + '11'].marks[0].w, `${paper}: the deepest ink lands inside the sheet`);
  }
  const L = out['Letter12.9'].marks[0], A = out['A412.9'].marks[0];
  assert.ok(A.h / A.w > L.h / L.w + 0.1, 'A4 renders a taller page, filling its sheet');
  assert.ok(Math.abs(L.h / L.w - 1056 / 816) < 0.005, 'Letter renders the pad sheet');
});
