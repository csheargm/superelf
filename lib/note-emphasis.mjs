// Note emphasis（重点识别）— what the owner MARKED as important on a page (docs/plans/note-features.md F):
// a highlighter stroke over words, a pen/marker loop drawn around them (a circle), or PANote's
// T-mode text highlight on typed words. Pure: strokes / pageHtml in, regions and text out; no
// filesystem, no DOM. lib/note-index.mjs stores the regions with a record (`emph`) and derives
// `imp` from them whenever the record's OCR lines change (finishRecord), lib/note-text.mjs serves
// the lines as the `important` field, and the summaries weight them (web/summary-refs.inline.html).
//
// Units: strokes are {c,w,t,p:[[x,y,pressure]...]} normalised by the PAGE WIDTH (y too, the page's
// one unit; lib/note-boxes.mjs), so every box here is [x, y, w, h] in page widths, origin top-left.
import { htmlToText } from './note-index.mjs';
import { pageBox } from './note-boxes.mjs';

export const HIGHLIGHTER = 'highlighter';   // the highlighter pen's stroke type (web/note-ui.inline.html drawStroke; the OCR tool skips it)

// ── A circle（圈）: a pen/marker stroke that closes on itself around something ──
// Each bound is a fraction, so a loop the size of a word and one around a paragraph are judged alike.
// The stroke ENDS where it began: first and last point within this fraction of the box diagonal.
export const CIRCLE_CLOSE_FRAC = 0.10;
// The loop is big enough to go AROUND words: its box is at least this fraction of the page width
// in both w and h. A closed stroke smaller than that is a letter (an `o`, a `0`), not a mark.
export const CIRCLE_MIN_SIDE = 0.03;
// Path length over box diagonal. A closed convex loop touching its box on all four sides is at
// least 2 × diag (a diamond; a true circle is π/√2 ≈ 2.22, a square 2.83) — below that the stroke
// did not go around its box, so it is a tick or a bracket, not a loop. Above CIRCLE_LEN_MAX the pen
// went back and forth inside the box: a scribble or a filled-in blot, not a circle (a loop traced
// twice is ≈ 4.4 and still passes, because people do circle twice).
export const CIRCLE_LEN_MIN = 2.0;
export const CIRCLE_LEN_MAX = 5.0;
export const CIRCLE_MIN_POINTS = 8;          // fewer samples cannot describe a loop (a tap is 1, a tick 2–5)
// An OCR line is highlighted when at least this fraction of its box lies under a highlighter stroke.
export const HIGHLIGHT_COVER = 0.5;

const round4 = (n) => Math.round(n * 10000) / 10000;
const pts = (s) => (Array.isArray(s && s.p) ? s.p : []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
const bboxOf = (p) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of p) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0, y0, x1 - x0, y1 - y0].map(round4);
};
const pathLength = (p) => { let l = 0; for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return l; };

// A stroke's box when it is a highlighter stroke, else null.
export const highlightBox = (s) => { if (!s || s.t !== HIGHLIGHTER) return null; const p = pts(s); return p.length ? bboxOf(p) : null; };

// A stroke's box when it is a circle by the rules above, else null. The highlighter never circles.
export function circleBox(s) {
  if (!s || s.t === HIGHLIGHTER) return null;
  const p = pts(s);
  if (p.length < CIRCLE_MIN_POINTS) return null;
  const box = bboxOf(p);
  if (box[2] < CIRCLE_MIN_SIDE || box[3] < CIRCLE_MIN_SIDE) return null;
  const diag = Math.hypot(box[2], box[3]);
  const [a, z] = [p[0], p[p.length - 1]];
  if (Math.hypot(z[0] - a[0], z[1] - a[1]) > CIRCLE_CLOSE_FRAC * diag) return null;
  const ratio = pathLength(p) / diag;
  return ratio >= CIRCLE_LEN_MIN && ratio <= CIRCLE_LEN_MAX ? box : null;
}

// A page's emphasis regions: {hl:[box…], circ:[box…]}; both empty when the page carries none.
export function emphasisRegions(strokes) {
  const out = { hl: [], circ: [] };
  for (const s of Array.isArray(strokes) ? strokes : []) {
    const h = highlightBox(s); if (h) { out.hl.push(h); continue; }
    const c = circleBox(s); if (c) out.circ.push(c);
  }
  return out;
}
export const hasRegions = (e) => !!e && ((e.hl && e.hl.length > 0) || (e.circ && e.circ.length > 0));

const area = (b) => Math.max(0, b[2]) * Math.max(0, b[3]);
// The area of a line box under highlight: the UNION of the highlighter boxes that cross the line,
// each clipped to the line's x-span, merged, × the line's height — so two strokes drawn over the
// same words count once (a sum would call 30% highlighted twice "60%").
function highlightCover(box, hl) {
  const x0 = box[0], x1 = box[0] + box[2], y0 = box[1], y1 = box[1] + box[3];
  const spans = [];
  for (const h of hl) {
    if (h[1] + h[3] <= y0 || h[1] >= y1) continue;                       // no vertical overlap with the line
    const a = Math.max(x0, h[0]), b = Math.min(x1, h[0] + h[2]); if (b > a) spans.push([a, b]);
  }
  spans.sort((p, q) => p[0] - q[0]);
  let len = 0, cur = null;
  for (const [a, b] of spans) { if (cur && a <= cur[1]) cur[1] = Math.max(cur[1], b); else { if (cur) len += cur[1] - cur[0]; cur = [a, b]; } }
  if (cur) len += cur[1] - cur[0];
  return len * (y1 - y0);
}
const inside = (x, y, b) => x >= b[0] && x <= b[0] + b[2] && y >= b[1] && y <= b[1] + b[3];
// Is a page box emphasised: enough of it under a highlight, or its centre inside a circle.
export function boxEmphasised(box, e) {
  if (!box || !hasRegions(e)) return false;
  const a = area(box);
  if (a > 0 && highlightCover(box, e.hl) / a >= HIGHLIGHT_COVER) return true;
  const cx = box[0] + box[2] / 2, cy = box[1] + box[3] / 2;
  return e.circ.some((c) => inside(cx, cy, c));
}
// The indexes of a record's OCR ink lines (boxes.ink) that are emphasised, through the record's
// geometry (lib/note-boxes.mjs pageBox puts an OCR box on the page).
export function importantInkLines(lines, geo, e) {
  const out = [];
  if (!hasRegions(e)) return out;
  (Array.isArray(lines) ? lines : []).forEach((l, i) => { if (boxEmphasised(pageBox(l, 'ink', geo), e)) out.push(i); });
  return out;
}

// ── Typed text: PANote's T-mode highlight ──
// fmtHighlight (web/note-ui.inline.html) runs execCommand hiliteColor with styleWithCSS, which
// writes <span style="background-color: rgba(r, g, b, 0.4);">words</span>; the sanitizer keeps only
// `background-color` / `background` as colour values (STYLE_OK), and the None chip writes
// `transparent`. So a highlighted run is any element whose inline style sets one of those to a
// colour that is not transparent / none. test/note-emphasis.test.mjs pins this against the source.
const HL_STYLE_RE = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;"']+)/i;
const NO_COLOUR = /^(?:transparent|none|inherit|initial|unset|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\))$/i;
const TAG_RE = /<\/?([a-z][a-z0-9]*)\b([^<>]*)>/gi;   // [^<>]*: linear on malformed markup (see lib/note-index.mjs htmlToText)
const VOID_TAGS = new Set(['br', 'img', 'hr', 'input']);
const isHighlightOpen = (attrs) => { const m = /style\s*=\s*("([^"]*)"|'([^']*)')/i.exec(attrs); if (!m) return false;
  const v = HL_STYLE_RE.exec(m[2] != null ? m[2] : m[3]); return !!v && !NO_COLOUR.test(v[1].trim()); };
// The highlighted text runs of a page's HTML, in document order, each the plain text of ONE
// highlighted element (nested highlights fold into the outer run); whitespace collapsed, empties dropped.
export function typedHighlights(html) {
  const s = String(html || '');
  const out = [];
  let depth = 0, start = -1;   // depth: element nesting inside the open highlight
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(s); m; m = TAG_RE.exec(s)) {
    const closing = m[0][1] === '/', tag = m[1].toLowerCase(), selfClosed = VOID_TAGS.has(tag) || /\/\s*>$/.test(m[0]);
    if (start < 0) { if (!closing && !selfClosed && isHighlightOpen(m[2])) { start = m.index + m[0].length; depth = 1; } continue; }
    if (closing) { depth--; if (depth === 0) { const t = htmlToText(s.slice(start, m.index)).replace(/\s+/g, ' ').trim(); if (t) out.push(t); start = -1; } }
    else if (!selfClosed) depth++;
  }
  return out;
}
