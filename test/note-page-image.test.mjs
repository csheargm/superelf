// lib/note-page-image.mjs + GET /api/note-page-image (ADR 0027, docs/plans/note-features.md I): a page's
// ink rendered to a real PNG on the node. The renderer is run on synthetic strokes (signature, size,
// dark pixels under the stroke, white elsewhere, highlighter skipped, geometry = tools/panote-ocr
// renderInk), then the route over the REAL web.mjs (helpers-web harness, throwaway root): auth, the app
// + path scoping, a fixture notebook with strokes → PNG bytes readable back through /api/data, the
// ink-hash cache, the Bible's draws[scope], and every refusal with its code. The cap constant is pinned.
// R11 — searched: "renderInk", "encodeGreyPng", "uploads/pages", "PAGE_IMAGES_MAX" — no earlier node render.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { freePort, mkWebRoot, startWeb, stopWeb, waitReady, api, OWNER_TOKEN } from './helpers-web.mjs';
import { nb, put as putIn } from './helpers-note.mjs';
import { renderInkPng, encodeGreyPng, pngSize, pageImageFile, loadPage, PAGE_IMAGES_MAX, PAGE_IMAGE_WIDTH, PAGE_IMAGE_DIR, MAX_PAGE_HEIGHT_RATIO,
  IMG_BAD_PATH, IMG_NOT_FOUND, IMG_NO_INK } from '../lib/note-page-image.mjs';
import { OCR_WIDTH_PX } from '../lib/note-ocr.mjs';

// Decode our own greyscale PNG back to pixels (filter 0 rows), to look at what was drawn.
function decode(png) {
  const { width, height } = pngSize(png);
  let at = 8; const idat = [];
  while (at < png.length) { const len = png.readUInt32BE(at), type = png.toString('ascii', at + 4, at + 8); if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + len)); at += 12 + len; }
  const raw = zlib.inflateSync(Buffer.concat(idat)); const px = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) { assert.equal(raw[y * (width + 1)], 0, 'filter 0'); px.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width); }
  return { width, height, px, at: (x, y) => px[y * width + x] };
}
const line = (x0, y0, x1, y1, extra = {}) => ({ c: '#141414', w: 0.004, p: [[x0, y0, 0.5], [x1, y1, 0.5]], ...extra });

test('the renderer: a real PNG of the OCR bitmap\'s geometry — width, page height from the lowest point, ink black under the stroke and white beside it', () => {
  const r = renderInkPng([line(0.1, 0.2, 0.5, 0.2)], { width: 400 });
  assert.equal(r.ok, true); assert.equal(r.strokes, 1);
  assert.deepEqual(pngSize(r.png), { width: 400, height: 120 }, 'H = max(0.3 W, min(W*maxY + 0.05 W, 6 W)) = 0.3 W when the ink is high on the page');
  const d = decode(r.png);
  assert.equal(d.at(120, 80), 0, 'on the stroke (x 0.3 W, y 0.2 W): black');
  assert.equal(d.at(120, 40), 255, 'well above it: white');
  assert.equal(d.at(10, 80), 255, 'left of its start: white (round cap reaches ~1 px, not 30)');
  const tall = renderInkPng([line(0.1, 2.0, 0.2, 2.0)], { width: 400 });
  assert.deepEqual(pngSize(tall.png), { width: 400, height: 820 }, 'a point at y 2.0 W: H = 2.05 W');
  const runaway = renderInkPng([line(0.1, 50, 0.2, 50)], { width: 400 });
  assert.equal(pngSize(runaway.png).height, 400 * MAX_PAGE_HEIGHT_RATIO, 'cut at 6x the width like the Swift tool: never a huge bitmap');
  assert.equal(PAGE_IMAGE_WIDTH, OCR_WIDTH_PX, 'the default width is the OCR bitmap\'s (R3)');
});

test('CONTROL: highlighter strokes and empty strokes are not ink; a single point is a dot; the cap is six pages', () => {
  assert.equal(renderInkPng([line(0, 0, 1, 0, { t: 'highlighter' })]).code, IMG_NO_INK, 'a highlighter-only page has no ink to show');
  assert.equal(renderInkPng([{ c: '#000', w: 0.01, p: [] }, { p: [[NaN, 1]] }]).code, IMG_NO_INK);
  assert.equal(renderInkPng(null).code, IMG_NO_INK);
  const dot = renderInkPng([{ w: 0.02, p: [[0.5, 0.1, 0.5]] }], { width: 200 });
  assert.equal(dot.ok, true); const d = decode(dot.png);
  assert.equal(d.at(100, 20), 0, 'the dot'); assert.equal(d.at(100, 30), 255, 'r = 2 px: 10 px away is white');
  assert.equal(PAGE_IMAGES_MAX, 6);
  assert.equal(encodeGreyPng(new Uint8Array([255, 0, 0, 255]), 2, 2).length > 50, true);
});

let port, root, web, WS;
const put = (slug, rel, obj) => putIn(WS, slug, rel, obj);
const get = async (qs, token = OWNER_TOKEN) => { const r = await api(port, `/api/note-page-image${qs}`, { headers: { authorization: `Bearer ${token}` } }); return { status: r.status, body: await r.json() }; };
const q = (o) => '?' + new URLSearchParams(o).toString();

before(async () => {
  port = await freePort(); root = mkWebRoot({ port }); WS = path.join(root, 'workspace');
  const inked = nb('<div>Roof</div>'); inked.pages[0].strokes = [line(0.1, 0.3, 0.6, 0.3), line(0.2, 0.5, 0.2, 0.9, { t: 'highlighter' })];
  inked.pages.push({ id: 'p2', created: 1, updated: 2, strokes: [], pageHtml: '<div>typed only</div>', images: [] });
  put('notes', 'entry-ink.json', inked);
  put('bible', 'notes/43-3.json', { draws: { v16: nb('<div>神爱世人</div>'), general: nb('<div>chapter note</div>') } });
  fs.mkdirSync(path.join(WS, 'data', 'notes', 'sub'), { recursive: true });
  web = startWeb(root); await waitReady(port);
});
after(async () => { if (web) await stopWeb(web); });

test('the route: a page with strokes → a PNG under uploads/pages/, named workspace-relative as a chat attachment carries it; the bytes come back through /api/data; a second ask reuses the file', async () => {
  const r = await get(q({ app: 'notes', path: 'entry-ink.json', page: 0 }));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true); assert.equal(r.body.cached, false);
  assert.match(r.body.path, new RegExp(`^${PAGE_IMAGE_DIR}/notes_[0-9a-f]{16}_p0\\.png$`), 'app + ink hash + page');
  assert.equal(r.body.width, PAGE_IMAGE_WIDTH); assert.equal(r.body.height, Math.round(PAGE_IMAGE_WIDTH * 0.95), 'the highlighter at y 0.9 sets the page height (every stroke counts, as in the Swift tool) though it is not drawn');
  const abs = path.join(WS, r.body.path);
  assert.equal(fs.existsSync(abs), true, 'written into the workspace, where the agent lane Reads it');
  const bytes = fs.readFileSync(abs);
  assert.equal(bytes.length, r.body.bytes); assert.deepEqual(pngSize(bytes), { width: r.body.width, height: r.body.height });
  const d = decode(bytes); assert.equal(d.at(Math.round(0.3 * d.width), Math.round(0.3 * d.width)), 0, 'the pen stroke is drawn'); assert.equal(d.at(Math.round(0.2 * d.width), Math.round(0.7 * d.width)) > 200, true, 'the highlighter is not');
  const served = await api(port, '/api/data/' + r.body.path, { headers: { authorization: `Bearer ${OWNER_TOKEN}` } });
  assert.equal(served.status, 200); assert.equal(Buffer.from(await served.arrayBuffer()).equals(bytes), true, 'the same bytes over /api/data (what attach-url re-displays)');
  const again = await get(q({ app: 'notes', path: 'entry-ink.json', page: 0 }));
  assert.equal(again.body.cached, true); assert.equal(again.body.path, r.body.path);
  const b = await get(q({ app: 'bible', path: 'notes/43-3.json', scope: 'v16', page: 0 }));
  assert.equal(b.status, 200, JSON.stringify(b.body)); assert.match(b.body.path, /^uploads\/pages\/bible_[0-9a-f]{16}_p0\.png$/, 'a Bible notebook under draws[scope]');
});

test('refusals, each with its code: no token, a bad app, a path outside the app or not a notebook, a missing page, a page without ink', async () => {
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/note-page-image` + q({ app: 'notes', path: 'entry-ink.json', page: 0 }))).status, 401, 'no bearer');
  assert.equal((await get(q({ app: 'Bad App', path: 'entry-ink.json' }))).body.code, 'bad_app');
  for (const p of ['../../config.json', '../bible/notes/43-3.json', '/etc/hosts', 'entry-ink.txt', '']) {
    const r = await get(q({ app: 'notes', path: p, page: 0 }));
    assert.equal(r.status, 400, p); assert.equal(r.body.code, IMG_BAD_PATH, p);
  }
  const miss = await get(q({ app: 'notes', path: 'nope.json', page: 0 })); assert.equal(miss.status, 404); assert.equal(miss.body.code, IMG_NOT_FOUND);
  const other = await get(q({ app: 'notes', path: 'notes/43-3.json', scope: 'v16', page: 0 })); assert.equal(other.status, 404, 'apps do not see each other');
  const page = await get(q({ app: 'notes', path: 'entry-ink.json', page: 9 })); assert.equal(page.status, 404); assert.equal(page.body.code, IMG_NOT_FOUND);
  const noInk = await get(q({ app: 'notes', path: 'entry-ink.json', page: 1 })); assert.equal(noInk.status, 422); assert.equal(noInk.body.code, IMG_NO_INK, 'a typed-only page is text already');
  const scope = await get(q({ app: 'bible', path: 'notes/43-3.json', scope: 'v99', page: 0 })); assert.equal(scope.body.code, IMG_NOT_FOUND, 'an unknown notebook of the file');
  const none = await get(q({ app: 'notes', path: 'entry-ink.json', page: 0 }), 'wrong-token-00000000000000000000'); assert.equal(none.status, 401);
});

test('lib: loadPage / pageImageFile judge the path before any read (safeJoin + readDataFile), and a link on the way is refused', () => {
  assert.equal(loadPage(WS, 'notes', { rel: '../bible/notes/43-3.json' }).code, IMG_BAD_PATH);
  assert.equal(loadPage(WS, 'notes', { rel: 'sub/../entry-ink.json' }).ok, true, 'a normalised path inside the app is fine');
  assert.equal(pageImageFile(WS, 'notes', { rel: 'entry-ink.json', page: 0 }).cached, true, 'the route\'s file is reused by the lib directly');
  const linkWs = fs.mkdtempSync(path.join(root, 'ws-link-'));
  fs.mkdirSync(path.join(linkWs, 'data'), { recursive: true }); fs.symlinkSync(path.join(WS, 'data', 'notes'), path.join(linkWs, 'data', 'notes'));
  const r = pageImageFile(linkWs, 'notes', { rel: 'entry-ink.json', page: 0 });
  assert.equal(r.ok, false); assert.equal(r.code, IMG_BAD_PATH, 'data/notes reached through a link: refused like the indexer refuses it');
});
