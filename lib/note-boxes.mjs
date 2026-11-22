// Note boxes（命中框）— the geometry that puts an OCR word box back on its page, phase 3 of note
// search (docs/plans/note-search.md, ADR 0023). Pure, no imports: lib/note-index.mjs stores a page's
// geometry (`geo`) with its record, lib/note-match.mjs converts the matched lines through it.
//
// Two box spaces meet here. The tool (tools/panote-ocr/panote-ocr.swift) reports a box normalised
// 0..1 against the bitmap it READ, origin top-left. For ink that bitmap is the page rendered
// OCR_WIDTH_PX wide and H = max(W*INK_MIN_H, min(W*maxY + W*INK_PAD, W*INK_MAX_H)) tall, maxY the
// largest stroke y — the page's own unit is its WIDTH (strokes carry y in page widths too), so a
// page box is x, w as reported and y, h scaled by H/W. For a photo the bitmap is the picture, which
// sits on the page at images[i] {x,y,w,h} in page widths; the queue tags each line with the
// picture it came from (`img`, the index in SORTED path order, the order the queue reads them).

// The ink bitmap's height in page widths — the tool's renderInk, restated once (R3: a test reads the
// Swift source and pins these three to it).
export const INK_MIN_H = 0.3;
export const INK_PAD = 0.05;
export const INK_MAX_H = 6;
export const BOXES_MAX = 60;          // the one cap on boxes per hit (a page is a handful of lines)
const round4 = (n) => Math.round(n * 10000) / 10000;

export function inkRatio(page) {
  let maxY = 0;
  for (const s of Array.isArray(page.strokes) ? page.strokes : []) for (const pt of Array.isArray(s.p) ? s.p : []) if (Array.isArray(pt) && pt.length >= 2 && Number.isFinite(pt[1])) maxY = Math.max(maxY, pt[1]);
  return round4(Math.max(INK_MIN_H, Math.min(maxY + INK_PAD, INK_MAX_H)));
}
// A page's pictures that have a stored path, SORTED by path — the ONE order (R3): the index hashes
// and the queue reads pictures in it, so a line's `img` names a rect here.
export const sortedImages = (page) => (Array.isArray(page.images) ? page.images : []).filter((i) => i && typeof i.path === 'string' && i.path).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const num = (v) => (Number.isFinite(v) ? v : 0);
export const pageGeo = (page) => ({ ink: inkRatio(page), imgs: sortedImages(page).map((i) => [num(i.x), num(i.y), num(i.w), num(i.h)].map(round4)) });

const boxOk = (b) => Array.isArray(b) && b.length === 4 && b.every((n) => Number.isFinite(n));
// One OCR line → its page box [x, y, w, h] in page widths, or null when the record cannot place it
// (no geometry yet — an index from before phase 3 — or a photo line without its picture).
export function pageBox(line, source, geo) {
  if (!line || !boxOk(line.box) || !geo) return null;
  const [x, y, w, h] = line.box;
  if (source === 'ink') return typeof geo.ink === 'number' ? [x, y * geo.ink, w, h * geo.ink].map(round4) : null;
  const im = Array.isArray(geo.imgs) && Number.isInteger(line.img) ? geo.imgs[line.img] : null;
  return boxOk(im) ? [im[0] + x * im[2], im[1] + y * im[3], w * im[2], h * im[3]].map(round4) : null;
}
// The same box reported by both ink passes is one rectangle on the page.
export const dedupeBoxes = (boxes) => { const seen = new Set(); return boxes.filter((b) => { const k = b.join(','); if (seen.has(k)) return false; seen.add(k); return true; }); };
