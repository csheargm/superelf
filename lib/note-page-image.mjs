// Note page images（笔记页图片）— a page's INK rendered to a PNG on the node, for a summary turn that
// sends pages as pictures beside the transcript (docs/plans/note-features.md I, ADR 0027). The local
// OCR misreads handwriting (a short acronym comes back as other letters), so the model gets the picture too and is told to trust it.
//
// The renderer mirrors tools/panote-ocr renderInk (the bitmap Vision reads): the SAME width, page
// height, stroke width and skipped highlighter — in JavaScript, so a Windows node renders too and a
// test holds real PNG bytes without Swift. Typed text is NOT drawn (no font rasteriser on the node;
// the transcript already carries it verbatim). Every function resolves an OUTCOME {ok:true,...} or
// {ok:false,error,code} — never a throw (R5: the route names the code).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { OCR_WIDTH_PX } from './note-ocr.mjs';
import { findNotebooks, inkHash } from './note-index.mjs';
import { readDataFile, DATA_OK } from './note-search.mjs';
import { UPLOADS_DIR } from './appdata.mjs';
import { safeJoin, writeFileAtomic } from './webutil.mjs';

export const PAGE_IMAGES_MAX = 6;                  // pages one summary turn attaches, newest first (the confirm line says the cap)
export const PAGE_IMAGE_WIDTH = OCR_WIDTH_PX;      // the OCR bitmap's width: what Vision read, the model sees (R3)
export const PAGE_IMAGE_DIR = `${UPLOADS_DIR}/pages`;   // workspace-relative: the agent lane Reads it, attach-url re-displays it
export const MAX_PAGE_HEIGHT_RATIO = 6;            // = tools/panote-ocr MAX_PAGE_HEIGHT_RATIO: a runaway stroke never allocates a huge bitmap
const MIN_STROKE_PX = 1.5, DEFAULT_STROKE_W = 0.003, PAGE_PAD = 0.05, MIN_HEIGHT_RATIO = 0.3;
export const IMG_BAD_PATH = 'bad_path', IMG_NOT_FOUND = 'not_found', IMG_NO_INK = 'no_ink', IMG_RENDER_FAILED = 'render_failed';
const fail = (code, error) => ({ ok: false, code, error: String(error && error.message || error) });

// ── PNG encoding (8-bit greyscale, filter 0 on every row) ──
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
export function encodeGreyPng(pixels, width, height) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width + 1)] = 0; raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const pngSize = (buf) => (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIGNATURE) ? { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) } : null);

// ── Rasteriser: black capsules (a segment with round caps) on white, like CGContext's round-capped polyline ──
function capsule(px, W, H, x0, y0, x1, y1, r) {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r)), maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + r));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r)), maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + r));
  const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy, r2 = r * r;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const cx = x + 0.5, cy = y + 0.5;
    let t = len2 ? ((cx - x0) * dx + (cy - y0) * dy) / len2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = cx - (x0 + t * dx), ey = cy - (y0 + t * dy);
    if (ex * ex + ey * ey <= r2) px[y * W + x] = 0;
  }
}
const pts = (s) => (Array.isArray(s.p) ? s.p : []).filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));
// strokes = [{c,w,t,p:[[x,y,pressure],…]}], coordinates normalised by the page WIDTH (y too), as the
// pad stores them and tools/panote-ocr reads them. Returns {ok, png, width, height, strokes} or a failure.
export function renderInkPng(strokes, { width = PAGE_IMAGE_WIDTH } = {}) {
  const all = (Array.isArray(strokes) ? strokes : []).filter((s) => s && typeof s === 'object' && pts(s).length);
  const ink = all.filter((s) => s.t !== 'highlighter');
  if (!ink.length) return fail(IMG_NO_INK, 'no ink on this page');
  const W = Math.max(100, Math.min(4000, Math.round(width)));
  let maxY = 0; for (const s of all) for (const p of pts(s)) maxY = Math.max(maxY, p[1]);   // the page's lowest point, a highlighter's too (the Swift tool measures every stroke)
  const H = Math.round(Math.max(W * MIN_HEIGHT_RATIO, Math.min(W * maxY + W * PAGE_PAD, W * MAX_PAGE_HEIGHT_RATIO)));
  try {
    const px = new Uint8Array(W * H).fill(255);
    for (const s of ink) {
      const r = Math.max(MIN_STROKE_PX, (Number(s.w) || DEFAULT_STROKE_W) * W) / 2, P = pts(s).map((p) => [p[0] * W, p[1] * W]);
      if (P.length === 1) { capsule(px, W, H, P[0][0], P[0][1], P[0][0], P[0][1], r); continue; }
      for (let i = 1; i < P.length; i++) capsule(px, W, H, P[i - 1][0], P[i - 1][1], P[i][0], P[i][1], r);
    }
    return { ok: true, png: encodeGreyPng(px, W, H), width: W, height: H, strokes: ink.length };
  } catch (e) { return fail(IMG_RENDER_FAILED, e); }
}

// The page of ONE notebook of an app data file: `rel` is app-relative as the index names it
// (`entry-a.json`, `notes/43-3.json`), `scope` the Bible's draws key ('' = the root notebook), `page`
// its index. Judged like the indexer reads it (readDataFile: under data/<slug>, no link, size cap)
// and, before that, through safeJoin so a traversal never reaches the file system.
export function loadPage(ws, slug, { rel, scope = '', page = 0 }) {
  const root = path.join(ws, 'data', slug);
  if (!safeJoin(root, rel) || !/\.json$/.test(rel)) return fail(IMG_BAD_PATH, 'bad path');
  let r;
  try { r = readDataFile(ws, slug, rel); } catch (e) { return fail(IMG_BAD_PATH, e); }
  if (r.state !== DATA_OK) return fail(IMG_NOT_FOUND, r.error || 'no such note');
  const nb = findNotebooks(r.value).find((n) => n.scope === scope);
  const p = nb && Array.isArray(nb.nb.pages) ? nb.nb.pages[page] : null;
  if (!p || typeof p !== 'object') return fail(IMG_NOT_FOUND, 'no such page');
  return { ok: true, page: p };
}

// Render a page and keep the PNG under <ws>/uploads/pages/, named by the ink's content hash so an
// unchanged page is rendered once; the answer names the file workspace-relative (what a chat
// attachment carries, web.mjs attachmentFiles) and its size.
export function pageImageFile(ws, slug, { rel, scope = '', page = 0, width } = {}) {
  const got = loadPage(ws, slug, { rel, scope, page });
  if (!got.ok) return got;
  const hash = inkHash(got.page);
  if (!hash) return fail(IMG_NO_INK, 'no ink on this page');
  const name = `${slug}_${hash}_p${page}.png`, relOut = `${PAGE_IMAGE_DIR}/${name}`, abs = path.join(ws, PAGE_IMAGE_DIR, name);
  try {
    if (fs.existsSync(abs)) { const b = fs.readFileSync(abs), s = pngSize(b); if (s) return { ok: true, path: relOut, bytes: b.length, ...s, cached: true }; }
  } catch { /* a kept file that cannot be read is simply rendered again and replaced below; the write's own failure is the one reported */ }
  const r = renderInkPng(got.page.strokes, { width });
  if (!r.ok) return r;
  try { fs.mkdirSync(path.dirname(abs), { recursive: true }); writeFileAtomic(abs, r.png); } catch (e) { return fail(IMG_RENDER_FAILED, e); }
  return { ok: true, path: relOut, bytes: r.png.length, width: r.width, height: r.height, cached: false };
}
