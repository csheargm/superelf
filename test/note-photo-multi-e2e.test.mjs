// The Journal, served by the real shell: 🖼 → Photo Library opens a MULTIPLE picker, three files
// become three staggered images on the saved page, and Take Photo stays a single picker.
// Needs Playwright (PA_PLAYWRIGHT); skipped without it, like test/note-link-e2e.test.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { skip, setup, teardown, newContext, openJournal, port } from './helpers-note-link.mjs';
import { execSync } from 'node:child_process';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAD0lEQVR4nGP4z8DwHwAFAAH/8X2cUwAAAABJRU5ErkJggg==', 'base64');
// The throwaway root: the server's working directory (helpers-note-link keeps it private).
const serverRoot = () => { const pid = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -Fp | head -1`).toString().trim().slice(1);
  return execSync(`lsof -a -p ${pid} -d cwd -Fn | tail -1`).toString().trim().slice(1); };
const savedImages = (root) => { const out = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, e.name);
  if (e.isDirectory()) walk(q); else if (e.name.endsWith('.json')) { try { const j = JSON.parse(fs.readFileSync(q, 'utf8')); if (Array.isArray(j.pages)) for (const pg of j.pages) if ((pg.images || []).length) out.push(pg.images); } catch { /* half-written: next poll */ } } } };
  walk(path.join(root, 'workspace', 'data')); return out; };

before(async () => { await setup({ slugs: ['notes'] }); });
after(teardown);

test('Photo Library picks several; they are saved staggered; Take Photo picks one', { skip }, async () => {
  const root = serverRoot();
  const ctx = await newContext(); const page = await ctx.newPage();
  const frame = await openJournal(page);
  await frame.locator('.pan-hphoto, .pan-photo').first().click();
  const [lib] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), frame.locator('[data-photo="library"]').click()]);
  assert.equal(lib.isMultiple(), true, 'the library picker takes several');
  await lib.setFiles([1, 2, 3].map((i) => ({ name: `p${i}.png`, mimeType: 'image/png', buffer: PNG })));
  let saved = [];
  for (let i = 0; i < 40 && !saved.some((im) => im.length >= 3); i++) { await page.waitForTimeout(500); saved = savedImages(root); }
  const imgs = saved.find((im) => im.length >= 3);
  assert.ok(imgs, 'three images reached the saved page');
  const spots = new Set(imgs.map((im) => `${im.x},${im.y}`));
  assert.equal(spots.size, 3, `three distinct spots: ${[...spots].join(' ')}`);
  for (const im of imgs) assert.ok(im.x + im.w <= 1 && im.y + im.h <= 1, 'each inside the page');
  await frame.locator('.pan-hphoto, .pan-photo').first().click();
  const [cam] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), frame.locator('[data-photo="camera"]').click()]);
  assert.equal(cam.isMultiple(), false, 'CONTROL: the camera picker stays single');
  await ctx.close();
});
