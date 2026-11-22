// The marketing page (docs/site/index.html) is static and public: pin that it stays
// self-contained, emoji-free, bilingual, and that the demo button is never a dead link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ZH_BLOCK = /<span class="zh" lang="zh-Hans">[^<]*\p{Script=Han}[^<]*<\/span>\s*$/u; // the full translation ends the element
const CELL_CORE = '[^<·]*[A-Za-z][^<·]* · <span lang="zh-Hans">[^<·]*\\p{Script=Han}[^<·]*<\\/span>';
// A whole cell is EXACTLY "English · <span lang=zh-Hans>中文</span>", optionally all in one <b>.
const CELL_BLOCK = new RegExp(`^\\s*(?:${CELL_CORE}|<b>${CELL_CORE}<\\/b>)\\s*$`, 'u');
const ZH_TAIL = /<span\b[^>]*lang="zh-Hans"[^>]*>[^<]*\p{Script=Han}[^<]*<\/span>\s*$/u; // ends with its translation
const mustMatch = (t, re) => { const m = t.match(re); assert.ok(m, `no match for ${re}`); return m[1]; };

const raw = readFileSync(new URL('../docs/site/index.html', import.meta.url), 'utf8');
// Comments never render, so every check reads the page with them stripped, once, here. That is
// only safe for well-formed comments: "<!-->" and "<!--->" close at once in a browser and show
// what follows, so the stripper and the browser would disagree.
test('comments are well-formed, so stripping them matches the browser', () => {
  for (const m of raw.matchAll(/<!--([\s\S]*?)-->/g)) {
    assert.match(m[1], /^ [^]*[^-]$/, `comment starts with a space and does not end in "-": ${m[0].slice(0, 40)}`);
    assert.doesNotMatch(m[1], /--|<!--/, `no "--" inside a comment: ${m[0].slice(0, 40)}`);
  }
  assert.doesNotMatch(raw, /--!>/);
  // A comment stands alone on its own line, so it can never sit inside a tag or a text run.
  const alone = (raw.match(/^[ \t]*<!-- [^\n]*-->[ \t]*$/gm) || []).length;
  assert.equal(alone, (raw.match(/<!--/g) || []).length, 'every comment is alone on its own line');
});
const html = raw.replace(/<!--[\s\S]*?-->/g, '');

// Allowlist, not denylist: any tag outside this set (object, embed, video, ...) fails.
const ALLOWED_TAGS = new Set(['html', 'head', 'meta', 'title', 'style', 'body', 'main', 'header',
  'section', 'footer', 'h1', 'h2', 'p', 'span', 'div', 'a', 'b', 'ul', 'li', 'table', 'tr', 'th', 'td', 'code']);
test('landing page loads nothing external', () => {
  const names = [...html.matchAll(/<\/?([a-z][\w-]*)/gi)].map((m) => m[1].toLowerCase());
  for (const n of names) assert.ok(ALLOWED_TAGS.has(n), n);
  assert.doesNotMatch(html, /\sping\s*=/i, 'no click-tracking ping');
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) assert.doesNotMatch(m[0], /http-equiv/i, m[0]);
  assert.doesNotMatch(html, /@import|url\(|image-set\(|https?:\/\/[^"'\s]*\.(png|jpe?g|webp|gif|svg|css|js|woff2?)\b/i);
});

// One structural rule instead of per-tag counts: every non-void element on the page is closed,
// so the scanners below never skip an element whose end tag was forgotten.
test('every element is explicitly closed', () => {
  const text = html.replace(/<style>[\s\S]*?<\/style>/i, '');
  for (const t of ALLOWED_TAGS) {
    if (t === 'meta') continue;
    const open = (text.match(new RegExp(`<${t}\\b`, 'gi')) || []).length;
    assert.equal((text.match(new RegExp(`</${t}>`, 'gi')) || []).length, open, `every <${t}> is closed`);
  }
});

// Backstop, not a denylist of hiding tricks: ONE <style> block, no inline style, and only these
// CSS properties. A new property (opacity, transform, clip, ...) fails until it is reviewed here.
const ALLOWED_CSS = new Set(['--accent', '--bg', '--fg', '--line', '--muted', 'background', 'border',
  'border-bottom', 'border-collapse', 'border-radius', 'border-style', 'border-top', 'box-sizing', 'color',
  'display', 'flex-wrap', 'font', 'font-size', 'font-weight', 'gap', 'letter-spacing', 'line-height',
  'list-style', 'margin', 'margin-top', 'max-width', 'padding', 'padding-top', 'text-align',
  'text-decoration', 'vertical-align', 'width', 'overflow-wrap']);
// WCAG relative luminance and contrast ratio.
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };

test('every theme palette keeps text readable (WCAG AA 4.5:1 on the background)', () => {
  const css = mustMatch(html, /<style>([\s\S]*?)<\/style>/i);
  const palettes = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) =>
    Object.fromEntries([...m[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})/gi)].map((x) => [x[1], x[2]])));
  assert.ok(palettes.length >= 2, 'light and dark palettes');
  for (const pal of palettes) {
    for (const k of ['--fg', '--muted', '--accent']) {
      assert.ok(contrast(pal[k], pal['--bg']) >= 4.5, `${k} ${pal[k]} on ${pal['--bg']}: ${contrast(pal[k], pal['--bg']).toFixed(2)}`);
    }
  }
});

// Final backstop: a cascade can always combine rules that each pass alone, so the stylesheet is
// PINNED. Any CSS edit fails here until a human checks contrast in light and dark (and on the live
// demo button), then updates this hash. The rule checks below explain what that review looks for.
const CSS_SHA256 = '2a250ff74699958a9d320faef7c8cf269d2dcb7a9328ee6a69cd37973ece2067';
// Everything before <body> (doctype, html lang, title, metas, the stylesheet) is pinned the same way.
const HEAD_SHA256 = 'ba465f202ccd30a7607b24600505cdf0d5ea364af3d39c426084af6b7c204d3e';
test('head matches the reviewed version', () => {
  assert.match(html, /^<!doctype html>\s*<html lang="en">/i);
  // Hash the RAW head (comments included): inside <title> or <style> a comment is literal text.
  assert.doesNotMatch(raw.split('<body>')[0], /<!--/, 'no comments in the head');
  assert.equal(createHash('sha256').update(raw.split('<body>')[0]).digest('hex'), HEAD_SHA256,
    'head changed: review title, metas and CSS, then update HEAD_SHA256 (and CSS_SHA256 if CSS moved)');
});

// The body's SKELETON (every tag with its attributes, in order, text removed) is pinned too.
// Copy edits leave it alone and are checked by the text rules below; any structural edit (a moved
// row, a new element, the demo going live) fails here until reviewed and re-pinned.
const BODY_SKELETON_SHA256 = 'a6817309fbf7caee6900313cd90035f998712a4945ab4a009e8b0eb2b766fc23';
test('body structure matches the reviewed version', () => {
  const skeleton = (html.split('<body>')[1].match(/<[^>]+>/g) || []).join('\n');
  assert.equal(createHash('sha256').update(skeleton).digest('hex'), BODY_SKELETON_SHA256,
    'body structure changed: review layout, links and bilingual shape, then update BODY_SKELETON_SHA256');
});

// Every factual claim on this page was checked against the code (README, web.mjs, lib/, ADRs).
// The visible copy is pinned so a later edit cannot quietly reintroduce a false claim: change the
// words, re-verify each claim you touched, then update this hash.
const COPY_SHA256 = '8e361615e8bbad6a6937c2caabbf1bd45ed772f26b37816ce649512ea3af674b';
test('visible copy matches the claims-verified version', () => {
  const copy = html.split('<body>')[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.equal(createHash('sha256').update(copy).digest('hex'), COPY_SHA256,
    'copy changed: re-verify the claims you edited against the code, then update COPY_SHA256');
});

test('stylesheet matches the reviewed version', () => {
  const css = mustMatch(html, /<style>([\s\S]*?)<\/style>/i);
  assert.equal(createHash('sha256').update(css).digest('hex'), CSS_SHA256,
    'CSS changed: review contrast and visibility, then update CSS_SHA256');
});

// Text colour comes only from the checked palette: foreground tokens on the page background,
// or the background token on an accent-filled button (same 4.5:1 pair, reversed).
test('text colours only use readable palette pairs', () => {
  const css = mustMatch(html, /<style>([\s\S]*?)<\/style>/i);
  let n = 0;
  for (const r of css.matchAll(/([^{};]+)\{([^{}]*)\}/g)) {
    const body = r[2];
    const col = body.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)?.[1].trim();
    const bg = body.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i)?.[1].trim();
    const sel = r[1].trim();
    assert.ok(!/(^|;)\s*--/.test(body) || sel === ':root', `palette tokens are set only on :root: ${sel}`);
    assert.ok(!sel.replace(/^:root$/, '').includes(':'), `no pseudo-class or pseudo-element except a bare :root (fail closed; review first): ${sel}`);
    if (/\.primary\b/.test(sel) && col) assert.equal(col, 'var(--bg)', `${sel}: an accent-filled button keeps bg text in every state`);
    if (col) {
      n++;
      if (bg && bg !== 'var(--bg)') assert.ok(col === 'var(--bg)' && bg === 'var(--accent)', `${r[1].trim()}: color ${col} on ${bg}`);
      else assert.ok(['var(--fg)', 'var(--muted)', 'var(--accent)'].includes(col), `${r[1].trim()}: color ${col}`);
    } else if (bg) assert.equal(bg, 'var(--bg)', `${r[1].trim()}: background ${bg} needs its own text colour`);
  }
  assert.ok(n >= 3);
});

// Backstop for attributes too: only these exist on the page. Anything else (tabindex, inert,
// hidden, ping, style, on*...) fails until reviewed, however it is spaced or quoted.
const ALLOWED_ATTRS = new Set(['lang', 'charset', 'name', 'content', 'class', 'id', 'href']);
// Whole class VALUES, not single names: "btn primary soon" is a new combination and fails.
const ALLOWED_CLASSES = new Set(['zh', 'lead', 'cta', 'points', 'btn soon', 'btn primary']);
test('only reviewed attributes appear', () => {
  const body = html.replace(/<style>[\s\S]*?<\/style>/i, '');
  for (const m of body.matchAll(/<[a-z][\w-]*\b[^>]*>/gi)) {
    for (const k of Object.keys(attrs(m[0]))) assert.ok(ALLOWED_ATTRS.has(k), `attribute not reviewed: ${k} in ${m[0]}`);
    const lang = attrs(m[0]).lang;
    if (lang !== undefined && !/^<html\b/i.test(m[0])) assert.ok(lang === 'zh-Hans' && /^<span\b/i.test(m[0]), `lang only as zh-Hans on a span (English is inherited from <html>): ${m[0]}`);
    if ('href' in attrs(m[0])) assert.match(m[0], /^<a\b/i, `href only on <a>: ${m[0]}`);
    const btnTag = m[0].match(/^<(\w+)/)[1].toLowerCase();
    if (/\bbtn\b/.test(attrs(m[0]).class || '')) {
      assert.equal(attrs(m[0]).class, btnTag === 'a' ? 'btn primary' : 'btn soon', `a link button is "btn primary", a not-yet label is a span "btn soon": ${m[0]}`);
    }
    const c = attrs(m[0]).class;
    if (c !== undefined) assert.ok(ALLOWED_CLASSES.has(c), `class value not reviewed: "${c}" (whole value, so no unreviewed combinations)`);
  }
});

// Fail closed for text: once every checked element (p, li, table cells, h2, footer, buttons) is
// removed, the only visible text left in <body> is the brand name in <h1>. New text anywhere
// else fails until it sits in a checked, bilingual element.
// A button is exactly: opening tag, English text, ONE bare <span lang="zh-Hans"> (no class: the
// muted .zh colour is unreadable on an accent fill), closing tag. Nothing else.
const BTN_RE = /<(a|span)\b[^>]*class=["'][^"']*\bbtn\b[^"']*["'][^>]*>[^<]*<span lang="zh-Hans">[^<]*<\/span>\s*<\/\1>/gi;
test('every button has the one checked shape', () => {
  // Count with the quote- and space-aware attribute parser, not a raw-text regex.
  const opens = [...html.matchAll(/<[a-z][\w-]*\b[^>]*>/gi)].filter((m) => /\bbtn\b/.test(attrs(m[0]).class || '')).length;
  assert.ok(opens >= 2);
  assert.equal((html.match(BTN_RE) || []).length, opens, 'every .btn is text + one zh span');
});

// Every Chinese character in the BODY sits in a lang="zh-Hans" span (title and meta text cannot
// carry markup; they are in the pinned head), so screen readers switch
// voice for it. One page-wide rule instead of one per element type.
test('all Chinese body text is marked lang="zh-Hans"', () => {
  const body = mustMatch(html, /<body>([\s\S]*)<\/body>/i)
    .replace(/<span\b[^>]*\slang="zh-Hans"[^>]*>[^<]*<\/span>/g, '');
  assert.doesNotMatch(visible(body), /\p{Script=Han}/u, 'unmarked Chinese text');
});

// A translation is always the LAST thing in its element: every zh-Hans span is followed only by
// whitespace and a closing tag, so no English can trail it anywhere (links, cells, items).
test('every Chinese span ends its element', () => {
  const body = mustMatch(html, /<body>([\s\S]*)<\/body>/i);
  const spans = [...body.matchAll(/<span\b[^>]*\slang="zh-Hans"[^>]*>[^<]*<\/span>((?:\s*<\/[a-z0-9]+>)*)([^<]*)/gi)];
  assert.ok(spans.length >= 20);
  // After a translation come only closing tags, then no visible text before the next element.
  for (const m of spans) {
    assert.ok(m[1].length > 0, `a translation is followed by a closing tag: ${m[0]}`);
    assert.equal(m[2].trim(), '', `text after a translation: ${m[0]}`);
  }
});

// Status words match the control: a live link never says "not yet"; a not-yet label always does.
const NOT_YET_LABELS = new Set(['Live demo: coming soon · 在线演示：即将上线', 'Install: private beta · 安装：内测中']);
const NOT_YET = /coming\s+soon|private\s+beta|即将|内测/i;
test('every button\'s words match whether it is live', () => {
  const labels = [...html.matchAll(BTN_RE)].map((m) => visible(m[0]).replace(/\s+/g, ' ').trim());
  assert.equal(new Set(labels).size, labels.length, `each button says something different: ${labels.join(' | ')}`);
  assert.ok(labels.some((l) => /^Live demo/.test(l)) && labels.some((l) => /^Install/.test(l)), 'a demo and an install control');
  for (const m of html.matchAll(BTN_RE)) {
    const label = visible(m[0]);
    if (m[1].toLowerCase() === 'a') assert.doesNotMatch(label, NOT_YET, `live link says not-yet: ${label}`);
    else {
      assert.match(label, NOT_YET, `not-yet label must say so in English and Chinese: ${label}`);
      // A not-yet label does nothing when tapped, so its words are pinned: no "tap", "click", "get".
      assert.ok(NOT_YET_LABELS.has(label.replace(/\s+/g, ' ').trim()), `not-yet label not reviewed: ${label}`);
    }
    if (m[1].toLowerCase() === 'span') {
      const [en, zh] = m[0].split(/<span lang="zh-Hans">/);
      assert.match(visible(en), /coming\s+soon|private\s+beta/i, `English status outside the zh span: ${label}`);
      assert.match(visible(zh || ''), /即将|内测/, `Chinese status inside the zh span: ${label}`);
      assert.doesNotMatch(visible(zh || ''), /[A-Za-z]{3}/, `no English inside the zh span: ${label}`);
    }
  }
});

// Inside a Chinese span, Latin words are only the reviewed names Chinese copy keeps as-is.
const NAMES_IN_ZH = new Set(['AI', 'Apple', 'BSB', 'Claude', 'Code', 'Codex', 'GPT', 'HTTPS', 'Linux', 'Mac',
  'Node', 'Pencil', 'Tailscale', 'WebSocket', 'Windows', 'XHR', 'fetch', 'iPad', 'macOS', 'npm', 'superelf', 'tailnet']);
test('Chinese spans hold no English beyond reviewed names', () => {
  for (const m of html.matchAll(/<span\b[^>]*\slang="zh-Hans"[^>]*>([^<]*)<\/span>/g)) {
    // NFKC folds full-width Latin (Ｗｈｙ) to ASCII first, so an IME cannot slip English past.
    for (const w of m[1].normalize('NFKC').match(/[A-Za-z][A-Za-z0-9.+-]*/g) || []) assert.ok(NAMES_IN_ZH.has(w), `English "${w}" inside Chinese: ${m[1]}`);
  }
});

test('no visible text outside checked bilingual elements', () => {
  let body = mustMatch(html, /<body>([\s\S]*)<\/body>/i);
  assert.equal((body.match(/<h1\b/gi) || []).length, 1, 'exactly one h1 on the whole page');
  assert.ok(body.includes('<h1>superelf</h1>'), 'the h1 is the brand');
  assert.equal(html.split(/<\/body>/i)[1].replace(/<\/html>/i, '').trim(), '', 'nothing after </body>');
  assert.equal(visible(html.split(/<body>/i)[0].replace(/<(title|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')).trim(), '', 'no stray text before <body>');
  body = body.replace(/<(p|li|th|td|h2|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(BTN_RE, '');
  body = body.replace(/<h1>superelf<\/h1>/, '');
  assert.equal(visible(body).replace(/\s+/g, ' ').trim(), '', 'the brand h1 is the only text outside checked elements');
});

// Long unbroken words (a URL, a long name) would push a phone layout sideways. The page breaks
// them instead: overflow-wrap:anywhere on body, inherited everywhere. Measured with 40-letter
// table headers at 320px in a real browser (landing-page-e2e.test.mjs checks the shipped copy).
test('long words wrap instead of overflowing', () => {
  assert.match(mustMatch(html, /<style>([\s\S]*?)<\/style>/i), /\bbody\s*\{[^}]*overflow-wrap:anywhere/);
});

test('mobile viewport is declared', () => {
  assert.match(html, /<meta\s+name="viewport"\s+content="width=device-width, initial-scale=1">/);
});

test('nothing on the page is hidden', () => {
  assert.doesNotMatch(html, /\sstyle\s*=/i, 'no inline style');
  assert.equal((html.match(/<style\b/gi) || []).length, 1, 'exactly one <style> block');
  assert.doesNotMatch(html, /\s(hidden|inert|disabled)\b|aria-hidden|aria-disabled|tabindex=["']?-/i);
  const css = mustMatch(html, /<style>([\s\S]*?)<\/style>/i).replace(/\/\*[\s\S]*?\*\//g, '');
  // Drop every selector-plus-brace and every closing brace: what is left is ALL declarations,
  // at any nesting depth, so a nested rule cannot shelter one.
  const decls = css.replace(/[^{};]*\{/g, ';').replace(/\}/g, ';').split(';').map((d) => d.trim()).filter(Boolean);
  assert.ok(decls.length > 20);
  for (const decl of decls) {
    const [prop, ...rest] = decl.split(':');
    const p = prop.trim().toLowerCase();
    const v = rest.join(':').trim();
    assert.ok(ALLOWED_CSS.has(p), `CSS property not reviewed: ${p}`);
    if (p.startsWith('--')) assert.match(v, /^#[0-9a-f]{6}$/i, `theme colour is a solid hex: ${decl}`);
    assert.doesNotMatch(decl, /display\s*:\s*none|font-size\s*:\s*0\b|transparent/i, decl);
  }
});


// Backstop for characters: printable ASCII, newline, Han, and a reviewed set of punctuation.
// Emoji, modifiers, bidi controls, zero-width marks and look-alikes all fail by default.
const OK_CHAR = /[\n\x20-\x7e\u4e00-\u9fff·—、。（），：；“”]/u;
test('only reviewed characters appear', () => {
  for (const ch of raw) assert.ok(OK_CHAR.test(ch), `character not reviewed: U+${ch.codePointAt(0).toString(16).toUpperCase()}`);
});

test('landing page has no emojis', () => {
  // No character references at all: they can hide emoji or blank out text from every regex here.
  assert.doesNotMatch(html, /&(#\d+|#x[0-9a-f]+|[a-z]+\d*);?/i, 'write characters literally');
  assert.doesNotMatch(html, /[\p{Extended_Pictographic}\p{Regional_Indicator}⃣️]/u);
});

// Both languages are VISIBLE: English text before the zh-Hans part, Chinese inside it (or after
// a middle dot in a table cell). Tags are stripped first, so markup never counts as words.
const visible = (h) => h.replace(/<[^>]+>/g, '');
function assertBilingual(h, { span = true } = {}) {
  const parts = span ? h.split(/<span\b[^>]*\slang="zh-Hans"[^>]*>/) : h.split(/\s·\s/);
  if (span) assert.equal(parts.length, 2, `exactly one translation span: ${h}`);
  assert.ok(parts.length >= 2, `has a Chinese part: ${h}`);
  assert.match(visible(parts[0]), /[A-Za-z]{3}/, `has English: ${h}`);
  const zh = span ? (h.match(/<span\b[^>]*\slang="zh-Hans"[^>]*>([^<]*)<\/span>/) || [])[1] || '' : parts.slice(1).join(' ');
  assert.match(visible(zh), /\p{Script=Han}/u, `has Chinese inside its zh-Hans span: ${h}`);
}

test('every list item and table cell carries a Chinese translation', () => {
  const text = html;
  const items = [...text.matchAll(/<(li|th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => [m[1].toLowerCase(), m[2]]);
  assert.ok(items.length >= 10);
  for (const t of ['li', 'th', 'td']) {
    const open = (text.match(new RegExp(`<${t}\\b`, 'gi')) || []).length;
    assert.equal((text.match(new RegExp(`</${t}>`, 'gi')) || []).length, open, `every <${t}> is closed`);
  }
  for (const [tag, it] of items) {
    assert.doesNotMatch(it, /<(ul|ol|li|p|table|tr|th|td|h\d|div|section)\b/i, `no block nested in <${tag}>: keep items flat`);
    assertBilingual(it);
    if (tag === 'li') assert.match(it, ZH_BLOCK, `li ends with its full translation: ${it}`);
    else assert.match(it, CELL_BLOCK, `cell ends with " · " and its translation: ${it}`);
  }
});

test('every paragraph and button carries a Chinese translation', () => {
  const text = html;
  const ps = [...text.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
  assert.ok(ps.length >= 2);
  for (const p of ps) { assertBilingual(p); assert.match(p, ZH_BLOCK, `p ends with its full translation: ${p}`); }
  assert.equal((text.match(/<p\b/gi) || []).length, ps.length, 'every <p> is closed');
  // Rule: each .btn element is written on ONE line, so its whole label is that line. A formatter
  // that splits one fails here loudly (fail closed) instead of being misread.
  const btns = [...text.matchAll(/<(?:a|span)\b[^>]*class=["'][^"']*\bbtn\b[^"']*["'][^>]*>([^\n]*)/gi)];
  for (const b of btns) {
    const opens = (b[0].match(/<(a|span)\b/gi) || []).length;
    const closes = (b[0].match(/<\/(a|span)>/gi) || []).length;
    assert.equal(closes, opens, `button opens and closes on one line: ${b[0]}`);
    const label = b[0].split(/<span\b[^>]*lang="zh-Hans"/)[0].replace(/<[^>]+>/g, ''); // English comes first
    assert.match(label, /[A-Za-z]{3}/, `button has English: ${b[0]}`);
  }
  assert.equal(btns.length, (text.match(/class=["'][^"']*\bbtn\b/gi) || []).length);
  assert.ok(btns.length >= 2);
  for (const b of btns) assert.match(b[1], /\slang="zh-Hans"[^>]*>[^<]*\p{Script=Han}/u, b[1]);
});

test('title, search description and footer carry both languages', () => {
  const title = mustMatch(html, /<title>([\s\S]*?)<\/title>/i);
  const desc = mustMatch(html, /<meta\s+name="description"\s+content="([^"]*)"/i);
  const feet = [...html.matchAll(/<footer\b[^>]*>([\s\S]*?)<\/footer>/gi)].map((m) => visible(m[1]));
  assert.ok(feet.length >= 1);
  for (const m of html.matchAll(/<footer\b[^>]*>([\s\S]*?)<\/footer>/gi)) {
    assertBilingual(m[1]);
    assert.match(m[1], ZH_TAIL, `footer ends with its translation: ${m[1]}`);
  }
  for (const t of [title, desc, ...feet]) {
    assert.match(t, /[A-Za-z]{3}/, t);
    assert.match(t, /\p{Script=Han}/u, t);
  }
});

test('every table row has as many cells as the header', () => {
  for (const t of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const rows = [...t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => (r[1].match(/<t[hd]\b/gi) || []).length);
    for (const r of t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      assert.equal(r[1].replace(/<(t[hd])\b[^>]*>[\s\S]*?<\/\1>/gi, '').trim(), '', `a row holds only cells: ${r[1]}`);
    }
    assert.ok(rows.length >= 2);
    // Nothing but whitespace between rows: a stray cell would become an implicit row.
    assert.equal(t[1].replace(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi, '').trim(), '', 'only <tr> rows directly inside the table');
    for (const n of rows) assert.equal(n, rows[0], `row cells ${rows.join(',')}`);
    const kinds = [...t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<(t[hd])\b/gi)].map((c) => c[1].toLowerCase()));
    assert.ok(kinds[0].every((k) => k === 'th'), 'first row is all th');
    for (const row of kinds.slice(1)) assert.ok(row.every((k) => k === 'td'), 'later rows are all td');
    // The product's own row is last, so it reads as the conclusion of the comparison.
    assert.match([...t[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].at(-1)[1], /<td><b>superelf\b/);
  }
});

test('every section heading carries a Chinese span', () => {
  const text = html;
  const heads = [...text.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => m[1]);
  assert.ok(heads.length >= 3);
  for (const h of heads) {
    assertBilingual(h);
    assert.match(h, ZH_TAIL, `h2 ends with its translation: ${h}`);
    assert.match(h, /<span\b[^>]*\slang="zh-Hans"[^>]*>[^<]*\p{Script=Han}/u, h);
    assert.match(h.split(/<span\b[^>]*lang="zh-Hans"/)[0].replace(/<[^>]+>/g, ''), /[A-Za-z]{3}/, `heading has English: ${h}`);
  }
});

// Parse a tag's attributes in order, so text inside one attribute is never read as another.
function attrs(tag) {
  const out = {};
  const body = tag.replace(/^<\w+/, '').replace(/\/?>$/, '');
  for (const m of body.matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return out;
}
const httpsHref = (a) => {
  try { if (!/^https:\/\/[^/]/.test(a.href)) return false; const u = new URL(a.href); return u.protocol === 'https:' && /^[\w-]+(\.[\w-]+)+$/.test(u.hostname)
      && !/(^|\.)(example\.(com|net|org)|localhost|test|invalid|local)$/i.test(u.hostname)
      // no bare IP: a preview address left in by mistake. *.ts.net stays allowed: a public
      // Tailscale Funnel URL is a ts.net name too, and the demo may use one.
      && !/^[\d.]+$/.test(u.hostname); } catch { return false; }
};

// Fail closed: the tag scanner below splits on '>', so no attribute value may hold '<' or '>'.
const angleInAttr = (h) => /=\s*("[^"]*[<>][^"]*"|'[^']*[<>][^']*'|[<>])/.test(h);
test('no attribute value holds an angle bracket', () => {
  assert.equal(angleInAttr(html), false);
  assert.equal(angleInAttr(`<a title='> <a id="demo" href="https://x.y">' href="#">`), true);
  assert.equal(angleInAttr(`<div title=<span id="demo" class="soon"></div>`), true);
});

test('demo is a real https link or a plain coming-soon label, never a dead anchor', () => {
  const text = html;
  const tags = [...text.matchAll(/<(a|span)\b[^>]*>/gi)].map((m) => ({ name: m[1].toLowerCase(), a: attrs(m[0]) }));
  const demos = tags.filter((t) => t.a.id === 'demo');
  assert.equal((text.match(/\sid=["']?demo\b/gi) || []).length, 1, 'exactly one element with id demo');
  const demo = demos[0];
  assert.ok(demo, 'demo control present');
  if (demo.name === 'a') {
    assert.ok(httpsHref(demo.a), JSON.stringify(demo.a));
    assert.doesNotMatch(demo.a.class || '', /\bsoon\b/, 'live link drops the soon style');
    const live = mustMatch(text, /id=["']demo["'][^>]*>([\s\S]*?)<\/a>/i).replace(/<[^>]+>/g, '');
    assert.match(live, /\p{Script=Han}/u, 'live label has Chinese');
    assert.match(live, /[A-Za-z]{3}/, 'live label has English');
    assert.doesNotMatch(live, /coming\s+soon|即将上线/i, 'live link must not say coming soon');
  }
  else {
    assert.match(demo.a.class || '', /\bsoon\b/);
    const label = mustMatch(text, /id=["']demo["'][^>]*>([\s\S]*?)<\/span>\s*<\/span>/i).replace(/<[^>]+>/g, '').trim();
    assert.match(label || '', /coming soon/i);
    assert.match(label || '', /即将上线/);
  }
  for (const t of tags.filter((x) => x.name === 'a')) assert.ok(httpsHref(t.a), JSON.stringify(t.a));
  const anchors = [...text.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)];
  assert.equal(anchors.length, (text.match(/<a\b/gi) || []).length, 'every <a> is closed');
  for (const m of anchors) assertBilingual(m[1]);
});

test('attribute parser is not fooled by href text inside another attribute', () => {
  const a = attrs(`<a id="demo" title=' href="https://example.com"' href="#">`);
  assert.equal(a.href, '#');
  assert.equal(httpsHref(a), false);
  assert.equal(httpsHref({ href: 'https://...' }), false, 'launch placeholder is not a link');
  assert.equal(httpsHref({ href: 'https://example.com/demo' }), false, 'example domain is not a link');
  assert.equal(httpsHref({ href: 'https://127.0.0.1:8443' }), false, 'bare IP is not a link');
  assert.equal(httpsHref({ href: 'https:/demo.superelf.ai' }), false, 'one-slash typo is not a link');
  assert.equal(httpsHref({ href: 'https://demo.superelf.ai' }), true);
  assert.equal(attrs(`<a id="demo" href="#" href="https://example.com">`).href, '#', 'first duplicate wins, as in browsers');
});
