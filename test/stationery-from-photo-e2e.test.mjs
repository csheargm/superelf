// Make stationery from a photo · 用笔记里的图片做信纸 — the Journal, served by the REAL web.mjs on a throwaway
// root (helpers-note-link: never the live node), the real shell, the shipped shared-apps/notes.
// Flow: add a photo to a note → its ⋯ menu → 做成信纸 · Make stationery → the picture panel opens with it →
// 作为背景 · Use as background → the page uses it AND templates/pictures.json lists it → a NEW note's
// stationery list shows it → ✕ twice deletes it from the list. Refusal: a refused list write says so.
// Engines: PA_E2E_ENGINE=chromium → desktop; PA_E2E_ENGINE=webkit → iPhone + iPad (touch, mobile).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { skip, setup, teardown, newContext, openJournal, flashText, port } from './helpers-note-link.mjs';
import { waitFor } from './helpers-web.mjs';

const ENGINE = process.env.PA_E2E_ENGINE || 'chromium';
const DEVICES = ENGINE === 'webkit'
  ? [{ name: 'iPhone', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
     { name: 'iPad', viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true }]
  : [{ name: 'desktop', viewport: { width: 1100, height: 850 } }];
const MAKE = '做成信纸 · Make stationery';
const SAVED = '已保存，其他笔记也能用 · Saved: other notes can use it too';
const NOT_LISTED = '未保存到列表 · Not added to the list';
const serverRoot = () => { const pid = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -Fp | head -1`).toString().trim().slice(1);
  return execSync(`lsof -a -p ${pid} -d cwd -Fn | tail -1`).toString().trim().slice(1); };
const picsFile = (root) => path.join(root, 'workspace', 'data', 'notes', 'templates', 'pictures.json');
const readPics = (root) => { try { return JSON.parse(fs.readFileSync(picsFile(root), 'utf8')).items; } catch { return null; /* not written yet */ } };
// The photo just added: the LAST image in the most recently written note file.
const latestImage = (root) => { let best = null; const walk = (d) => { if (!fs.existsSync(d)) return;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, e.name);
    if (e.isDirectory()) walk(q); else if (e.name.endsWith('.json')) { try { const j = JSON.parse(fs.readFileSync(q, 'utf8')), t = fs.statSync(q).mtimeMs;
      for (const pg of j.pages || []) for (const im of pg.images || []) if (!best || t >= best.t) best = { im, t }; } catch { /* half-written: next poll */ } } } };
  walk(path.join(root, 'workspace', 'data')); return best && best.im; };

async function photoPng(page) {   // a real 400x520 photo-like PNG, drawn by the browser itself
  const b64 = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = 400; c.height = 520; const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 400, 520); g.addColorStop(0, '#f6d1c1'); g.addColorStop(1, '#9cc3e6'); x.fillStyle = g; x.fillRect(0, 0, 400, 520);
    return c.toDataURL('image/png').split(',')[1]; });
  return Buffer.from(b64, 'base64');
}
// On a phone the header's ⋯ opens a short menu (Page settings · Photo · Print) in place of the hidden buttons.
async function viaHeader(frame, ovf, direct) {
  if (await frame.locator(direct).first().isVisible()) return frame.locator(direct).first().click();
  await frame.locator('.pan-hmore, .pan-paperbtn').first().click();
  if (await frame.evaluate(() => !!document.querySelector('.pan-ovf.on'))) await frame.locator(`.pan-ovf [data-ovf="${ovf}"]`).click();
}
async function addPhoto(page, frame) {
  await viaHeader(frame, 'photo', '.pan-hphoto, .pan-photo');
  const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), frame.locator('[data-photo="library"]').click()])
    .catch(async (e) => { if (process.env.E2E_DEBUG) await page.screenshot({ path: process.env.E2E_DEBUG }); throw e; });
  await fc.setFiles([{ name: 'photo.png', mimeType: 'image/png', buffer: await photoPng(page) }]);
  await frame.getByText('原图 · Skip', { exact: true }).click({ timeout: 15000 });   // one photo opens the scanner: keep it as is
}
async function openImageMenu(page, frame, root, before) {
  let im = null; await waitFor(() => (im = latestImage(root)) && JSON.stringify(im) !== before, 'the photo is saved on the page', { timeoutMs: 15000 })
    .catch(async (e) => { if (process.env.E2E_DEBUG) await page.screenshot({ path: process.env.E2E_DEBUG }); throw e; });
  const fr = await page.locator('#fr').boundingBox();
  const r = await frame.evaluate(() => { const b = document.querySelector('.pan-ink').getBoundingClientRect(); return { l: b.left, t: b.top, w: b.width }; });
  await page.mouse.click(fr.x + r.l + (im.x + im.w / 2) * r.w, fr.y + r.t + (im.y + im.h / 2) * r.w, { button: 'right' });
  await frame.waitForFunction(() => document.querySelector('.pan-imgpop.on'));
}
// A page open shows at most ONE tip (ADR 0030). Open the Journal until no OTHER unseen tip is waiting (each one is
// dismissed = seen), so this feature's tip is the one the image menu shows.
async function openWithoutOtherTips(page) {
  for (let i = 0; i < 10; i++) {
    const frame = await openJournal(page);
    await page.waitForTimeout(800);
    const cur = await frame.evaluate(() => window.PATips && PATips.current());
    if (!cur || cur === 'note-photo-stationery') return frame;
    await frame.evaluate(() => { PATips.dismiss(); return PATips.whenIdle(); });
    await page.waitForTimeout(300);
  }
  throw new Error('other first-use tips kept showing');
}
const panelMsg = (frame) => frame.evaluate(() => [...document.querySelectorAll('.pst-pic .pst-msg')].map((e) => e.textContent).join(' | '));

before(async () => { await setup({ slugs: ['notes'], from: path.join('workspace', 'apps', 'notes') }); });   // the Journal with 信纸 (stationery opted in)
after(teardown);

for (const dev of DEVICES) {
  test(`${ENGINE} ${dev.name}: a photo in a note becomes stationery, is listed in another note, and deletes`, { skip }, async () => {
    const root = serverRoot(); const listed = readPics(root) || [];   // never removed by hand: the store keeps a previous version and would (rightly) refuse
    const { name, ...opts } = dev; void name;
    const ctx = await newContext(opts); const page = await ctx.newPage();
    const frame = await openWithoutOtherTips(page);
    const was = JSON.stringify(latestImage(root));
    await addPhoto(page, frame);
    await openImageMenu(page, frame, root, was);
    // First-use tip (ADR 0030) beside the new item: on screen now, or already seen on this account by an earlier run.
    await frame.waitForFunction(() => window.PATips && (PATips.current() === 'note-photo-stationery' || (PATips.seen() || []).includes('note-photo-stationery')), null, { timeout: 10000 });
    const showing = await frame.evaluate(() => PATips.current() === 'note-photo-stationery');
    if (dev === DEVICES[0]) assert.ok(showing, 'a fresh account sees the tip the first time');   // (R14: not vacuous)
    if (showing) assert.match(await frame.locator('.pat-tip').textContent(), /做成信纸|Make this picture a page stationery/);
    const item = frame.locator('.pan-imgpop [data-img="tpl"]');
    assert.equal((await item.textContent()).trim(), MAKE);
    await item.click();
    await frame.waitForFunction(() => document.querySelector('.pan-paperpop.on .pst-pic.on canvas.pst-prev.on'), null, { timeout: 15000 });
    await frame.locator('.pst-pic.on button', { hasText: '作为背景 · Use as background' }).click();
    await frame.waitForFunction((t) => [...document.querySelectorAll('.pst-pic .pst-msg')].some((e) => e.textContent === t), SAVED, { timeout: 20000 });
    const items = readPics(root).filter((x) => !listed.some((y) => y.id === x.id));
    assert.equal(items.length, 1, 'templates/pictures.json lists the new picture'); assert.match(items[0].id, /^[A-Za-z0-9_./-]+$/);
    // Another note: its stationery list carries the picture.
    await frame.evaluate(() => newEntry()); await page.waitForTimeout(500);
    await viaHeader(frame, 'paper', '.pan-no-direct-button');   // ⋯ is Page settings (desktop/iPad) or opens the phone menu
    const cell = frame.locator(`.pst-th[data-src="picture"][data-id="${items[0].id}"]`);
    await cell.waitFor({ state: 'attached', timeout: 10000 });
    // ✕ is two-tap (PATwoTap): first arms, second deletes.
    const del = frame.locator('.pst-cell', { has: cell }).locator('.pst-del');
    // The list lives in Page settings; on a phone ⋯ opens the menu instead, so the popover is shown here directly.
    await cell.evaluate((b) => { const p = b.closest('.pan-pop'); if (p) p.classList.add('on'); b.scrollIntoView({ block: 'center' }); });
    // GPT review: the thumbnail's centre is the thumbnail, not the (touch-sized) ✕ — a tap meant to choose never arms delete.
    const hit = await cell.evaluate((b) => { const r = b.getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && b.contains(e); });
    assert.ok(hit, `${dev.name}: the thumbnail centre hits the thumbnail`);
    await del.evaluate((b) => b.click()); await del.evaluate((b) => b.click());
    await cell.waitFor({ state: 'detached', timeout: 10000 });
    assert.deepEqual(readPics(root), listed, 'deleted from the list on disk');
    await ctx.close();
  });
}

test(`${ENGINE}: a refused list write says the picture was not added to the list`, { skip }, async () => {
  const root = serverRoot();
  const { name, ...opts } = DEVICES[0]; void name;
  const ctx = await newContext(opts); const page = await ctx.newPage();
  // The server refuses the list write (a read-only templates folder, as a full or locked disk would): the read
  // still works, so this is the WRITE refusal, not the "list not read" one. Engine-independent (no request routing).
  const dir = path.dirname(picsFile(root)); fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(picsFile(root))) fs.writeFileSync(picsFile(root), JSON.stringify({ v: 1, items: [] }));
  const before = fs.readFileSync(picsFile(root), 'utf8'); fs.chmodSync(dir, 0o555);
  try {
    const frame = await openWithoutOtherTips(page);
    const was = JSON.stringify(latestImage(root));
    await addPhoto(page, frame);
    await openImageMenu(page, frame, root, was);
    await frame.locator('.pan-imgpop [data-img="tpl"]').click();
    await frame.waitForFunction(() => document.querySelector('.pst-pic.on canvas.pst-prev.on'), null, { timeout: 15000 });
    await frame.locator('.pst-pic.on button', { hasText: '作为背景 · Use as background' }).click();
    await frame.waitForFunction((t) => [...document.querySelectorAll('.pst-pic .pst-msg.err')].some((e) => e.textContent.startsWith(t)), NOT_LISTED, { timeout: 20000 })
      .catch(async (e) => { throw new Error(`${e.message}; panel says: ${await panelMsg(frame)}; flash: ${await flashText(frame)}`); });
    assert.equal(fs.readFileSync(picsFile(root), 'utf8'), before, 'the list on disk is unchanged');
  } finally { fs.chmodSync(dir, 0o755); await ctx.close(); }
});
