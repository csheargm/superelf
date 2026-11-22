// The marketing page (site/index.html) is static and public. Fail-closed checks: only reviewed
// tags, attributes, classes and links; one pinned inline script (the EN / 中文 toggle) that cannot
// reach the network; exactly one external script, the pinned Cloudflare Web Analytics beacon (visit
// stats for the owner's dashboard only, nothing shown on the page); every English string has a Chinese twin; readable colours; and the whole file
// is pinned, so any edit fails until its claims are re-checked against the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const file = readFileSync(new URL('../site/index.html', import.meta.url), 'utf8');
// The ONLY external script: Cloudflare's own snippet, byte for byte, right before </body>. It is
// cut out before parsing, so every other check (no comments, no src, one inline script) still
// fails closed on any other external script or any change to this one.
const BEACON = `<!-- Cloudflare Web Analytics --><script type='module' src='https://static.cloudflareinsights.com/beacon.min.js' data-cf-beacon='{"token": "14a84d11c8cf4193887b205ee38aaa86"}'></script><!-- End Cloudflare Web Analytics -->`;
const raw = file.replace(`${BEACON}\n</body>`, '</body>');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const VOID = new Set(['meta']);

// A tiny tree builder for this page only: every non-void element must be explicitly closed, and
// any mismatch throws, so the scanners below never see a half-parsed page.
function parse(src) {
  const root = { tag: '#root', attrs: {}, kids: [] }; const stack = [root];
  const re = /<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z-]+(?:="[^"<>]*")?)*)\s*(\/?)>|<!doctype html>|([^<]+)|(<)/gi;
  let m;
  while ((m = re.exec(src))) {
    if (m[6]) throw new Error(`stray "<" at ${m.index}`);
    if (m[5] !== undefined) { stack.at(-1).kids.push({ text: m[5] }); continue; }
    if (!m[2]) continue; // doctype
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const top = stack.pop();
      if (top.tag !== tag) throw new Error(`</${tag}> closes <${top.tag}>`);
      continue;
    }
    const attrs = {};
    for (const a of m[3].matchAll(/([a-z-]+)(?:="([^"]*)")?/gi)) {
      const k = a[1].toLowerCase();
      assert.ok(!(k in attrs), `duplicate attribute ${k} on <${tag}>`);
      attrs[k] = a[2] ?? '';
    }
    const el = { tag, attrs, kids: [] };
    stack.at(-1).kids.push(el);
    if (tag === 'script' || tag === 'style') { // raw text up to the end tag
      const end = src.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
      if (end < 0) throw new Error(`<${tag}> is never closed`);
      el.kids.push({ text: src.slice(re.lastIndex, end) });
      re.lastIndex = end;
    }
    // Self-closing "/>" is allowed only on SVG shapes, which never hold content.
    if (m[4]) assert.ok(['path', 'rect', 'circle'].includes(tag), `<${tag}/> must be closed explicitly`);
    else if (!VOID.has(tag)) stack.push(el);
  }
  assert.equal(stack.length, 1, 'every element is closed');
  return root;
}
const root = parse(raw);
const all = []; (function walk(n) { for (const k of n.kids || []) if (k.tag) { all.push(k); walk(k); } })(root);
const text = (n) => (n.text ?? n.kids.map(text).join(''));
const byTag = (t) => all.filter((e) => e.tag === t);
const body = byTag('body')[0];

test('only reviewed tags, attributes and classes', () => {
  const TAGS = new Set(['html', 'head', 'meta', 'title', 'style', 'script', 'body', 'header', 'nav', 'main',
    'section', 'footer', 'div', 'h1', 'h2', 'h3', 'p', 'span', 'a', 'b', 'button',
    'details', 'summary', 'ul', 'li', 'svg', 'path', 'rect', 'circle']);
  const ATTRS = new Set(['lang', 'charset', 'name', 'content', 'class', 'id', 'href', 'type', 'hidden',
    'viewbox', 'aria-hidden', 'd', 'x', 'y', 'width', 'height', 'rx', 'cx', 'cy', 'r']);
  const CLASSES = new Set(['wrap', 'bar', 'top', 'logo', 'nav', 'toggle', 'hero', 'eyebrow', 'grad', 'sub', 'cta',
    'btn', 'primary', 'band', 'intro', 'grid', 'card', 'foot', 'grow', 'split', 'mark', 'art', 'icon', 'big',
    'choice', 'diagram', 'fill1', 'fill2', 'fill3', 'fill4', 'soft', 'soft2', 'paper', 'ink', 'on', 'lo', 'lb', 'la',
    'edge', 'dash', 'frame', 'join']);
  assert.doesNotMatch(raw, /<!--/, 'no comments: they would hide from the copy checks');
  for (const e of all) {
    assert.ok(TAGS.has(e.tag), `<${e.tag}>`);
    for (const a of Object.keys(e.attrs)) assert.ok(ATTRS.has(a), `${a} on <${e.tag}>`);
    for (const c of (e.attrs.class || '').split(/\s+/).filter(Boolean)) assert.ok(CLASSES.has(c), `class ${c}`);
  }
  // Graphics are decoration only: hidden from screen readers, no text, no links, no outside refs.
  for (const svg of byTag('svg')) {
    assert.equal(svg.attrs['aria-hidden'], 'true', 'every svg is aria-hidden');
    (function only(n) { for (const k of n.kids) { if (!k.tag) { assert.equal(k.text.trim(), '', 'no text in svg'); continue; } assert.ok(['path', 'rect', 'circle'].includes(k.tag), 'svg holds only shapes'); only(k); } })(svg);
  }
  for (const e of all) if (['path', 'rect', 'circle'].includes(e.tag)) assert.equal(e.kids.length, 0, `<${e.tag}> is empty`);
  const ids = all.map((e) => e.attrs.id).filter(Boolean);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
});

test('links go only to the demo, the repo, or an anchor on this page', () => {
  const OK = new Set(['https://try.superelf.app', 'https://try.superelf.app/?join=1', 'https://github.com/csheargm/superelf']);
  const ids = new Set(all.map((e) => e.attrs.id).filter(Boolean));
  const links = byTag('a');
  assert.ok(links.length > 0);
  for (const a of links) {
    const h = a.attrs.href;
    assert.ok(OK.has(h) || (h.startsWith('#') && ids.has(h.slice(1))), `href ${h}`);
  }
  assert.ok(links.some((a) => a.attrs.href === 'https://try.superelf.app'), 'demo is linked');
  assert.ok(links.some((a) => a.attrs.href === 'https://github.com/csheargm/superelf'), 'code is linked');
  assert.ok(links.some((a) => a.attrs.href === 'https://try.superelf.app/?join=1'), 'the waiting list opens on the demo (no cross-origin form here)');
});

test('the analytics beacon appears once, exactly as pinned, just before </body>', () => {
  assert.equal(file.split(BEACON).length, 2, 'beacon present exactly once');
  assert.ok(file.includes(`${BEACON}\n</body>`), 'beacon sits just before </body>');
  assert.equal(raw.length, file.length - BEACON.length - 1, 'only the beacon was cut out');
  assert.doesNotMatch(raw, /cloudflareinsights|data-cf-beacon/i, 'no second beacon');
});

test('one inline script, which only toggles the language', () => {
  const scripts = byTag('script');
  assert.equal(scripts.length, 1);
  assert.deepEqual(scripts[0].attrs, {}, 'no src, no type');
  const js = text(scripts[0]);
  assert.doesNotMatch(js, /fetch|XMLHttpRequest|WebSocket|sendBeacon|eval|Function\(|import|innerHTML|outerHTML|insertAdjacent|document\.write|location|src\b|href|cookie|setTimeout|setInterval/);
  for (const m of js.matchAll(/localStorage\.(\w+)\('([^']*)'/g)) assert.equal(m[2], 'superelf-lang', 'one storage key');
  assert.equal((js.match(/catch \(e\)/g) || []).length, 2);
  for (const m of js.matchAll(/catch \(e\) \{([^}]*)\}/g)) assert.match(m[1], /\/\/ /, 'every catch says why it is silent (R5)');
});

test('stylesheet loads nothing external', () => {
  const css = text(byTag('style')[0]);
  assert.equal(byTag('style').length, 1);
  assert.doesNotMatch(css, /@import|url\(|image-set\(|@font-face/i);
});

// Without JS the page is English (Chinese hidden by CSS); with JS the toggle shows one language.
test('bilingual: every English string has a Chinese twin right after it', () => {
  const HAN = /\p{Script=Han}/u;
  const en = all.filter((e) => e.attrs.lang === 'en' && e.tag !== 'html');
  const zh = all.filter((e) => e.attrs.lang === 'zh-Hans');
  assert.ok(en.length > 40, 'the page is translated element by element');
  assert.equal(en.length, zh.length);
  const sibs = (p) => p.kids.filter((k) => k.tag);
  for (const p of all) {
    const s = sibs(p);
    s.forEach((e, i) => {
      if (e.attrs.lang === 'en') {
        const z = s[i + 1];
        assert.ok(z && z.attrs.lang === 'zh-Hans' && z.tag === e.tag, `twin after "${text(e).slice(0, 30)}"`);
        assert.doesNotMatch(text(e), HAN, `English has no Chinese: ${text(e)}`);
        assert.match(text(z), HAN, `Chinese twin of "${text(e).slice(0, 30)}"`);
      }
      if (e.attrs.lang === 'zh-Hans') assert.equal(s[i - 1]?.attrs.lang, 'en', `zh "${text(e).slice(0, 20)}" follows its English`);
    });
  }
  // Text outside a language pair is fail-closed: only brand words and card numbers.
  const LOOSE = new Set(['super', 'elf', 'GitHub', '中文']);
  (function walk(n, inLang) {
    for (const k of n.kids) {
      if (k.tag) { if (k.tag !== 'script' && k.tag !== 'style') walk(k, inLang || 'lang' in k.attrs); continue; }
      const t = k.text.trim();
      if (t && !inLang) assert.ok(LOOSE.has(t), `untranslated text: "${t}"`);
    }
  })(body, false);
  assert.ok(raw.includes('html:not(.zh) body [lang="zh-Hans"]:not(button), html.zh body [lang="en"]:not(button) { display:none !important; }'), 'the language-hiding rule');
});

test('no emojis or unexpected characters', () => {
  const OK_CHAR = /^[\p{Script=Latin}\p{Script=Han}\p{N}\s.,:;!?'"()\[\]{}<>=/\\_*#&|+%^~`$@-]|[·—–“”’→，。、：；（）！？]$/u;
  for (const ch of raw) assert.ok(OK_CHAR.test(ch), `character U+${ch.codePointAt(0).toString(16)}`);
});

// WCAG relative luminance and contrast ratio.
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
test('light and dark palettes keep text readable (WCAG AA 4.5:1)', () => {
  const css = text(byTag('style')[0]);
  const pals = [...css.matchAll(/:root\s*\{([^}]*)\}/g)].map((m) =>
    Object.fromEntries([...m[1].matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})/gi)].map((x) => [x[1], x[2]])));
  assert.equal(pals.length, 2);
  for (const p of pals) {
    for (const bg of ['--bg', '--card']) {
      for (const fg of ['--fg', '--muted', '--accent', '--accent2']) {
        assert.ok(contrast(p[fg], p[bg]) >= 4.5, `${fg} on ${bg}: ${contrast(p[fg], p[bg]).toFixed(2)}`);
      }
    }
    assert.ok(contrast(p['--on-accent'], p['--accent']) >= 4.5, 'button text on accent');
  }
});

// Every claim was checked against the code (README, web.mjs CSP, lib/offline.mjs, lib/bible.mjs,
// docs/demo-node.md, backup.sh). Change anything, re-verify what you touched, then re-pin.
const FILE_SHA256 = 'ca22c42909b589bf10aec93dd684f8ea4632ad81e632f77ee0e84934914bce26';
test('page matches the claims-verified version', () => {
  assert.equal(sha(file), FILE_SHA256, 'page changed: re-verify claims, links, contrast and the script, then update FILE_SHA256');
});
